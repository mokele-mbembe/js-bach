import { midiPitch, type MeasureIR, type NoteEvent, type ScoreIR, type WrittenPitch } from "./score-ir.js";

const steps = ["C", "D", "E", "F", "G", "A", "B"] as const;
const minOnsets = 4;
const maxOnsets = 16;
const shortlistSize = 24;

type FragmentNote = [
  offsetTicks: number, durationTicks: number, scaleSteps: number, semitones: number,
  ties?: number, notations?: NoteEvent["notations"], staffOffset?: number,
];
type Occurrence = [
  voice: string, staff: number, startTick: number, diatonicPitch: number, midiPitch: number, slotDeltas: number[],
];
type Fragment = [notes: FragmentNote[], occurrences: Occurrence[]];

export interface TransposedScore extends Omit<ScoreIR, "measures"> {
  measures: (Omit<MeasureIR, "events"> & { events: (MeasureIR["events"][number] | null)[] })[];
  transposedFragments?: Fragment[];
}

interface IndexedNote {
  note: NoteEvent;
  slot: number;
  tick: number;
  diatonic: number;
  midi: number;
}

interface Candidate {
  notes: FragmentNote[];
  windows: IndexedNote[][];
}

function notesByVoice(score: ScoreIR): Map<string, IndexedNote[]> {
  const voices = new Map<string, IndexedNote[]>();
  let nextSlot = 0;
  for (const measure of score.measures) {
    for (const note of measure.events) {
      const slot = nextSlot++;
      if (note.kind === "rest" || note.grace) continue;
      const voice = voices.get(note.voice) ?? [];
      voice.push({
        note, slot, tick: measure.startTick + note.offsetTicks,
        diatonic: 7 * note.pitch.octave + steps.indexOf(note.pitch.step), midi: midiPitch(note.pitch),
      });
      voices.set(note.voice, voice);
    }
  }
  return voices;
}

function relativeNotes(window: IndexedNote[]): FragmentNote[] {
  const anchor = window[0];
  return window.map(({ note, tick, diatonic, midi }) => {
    const row: FragmentNote = [tick - anchor.tick, note.durationTicks, diatonic - anchor.diatonic, midi - anchor.midi];
    const ties = Number(note.tieStart) | (Number(note.tieStop) << 1);
    const staffOffset = note.staff - anchor.note.staff;
    if (ties || note.notations.length || staffOffset) row.push(ties);
    if (note.notations.length || staffOffset) row.push(note.notations);
    if (staffOffset) row.push(staffOffset);
    return row;
  });
}

function findCandidates(score: ScoreIR): Candidate[] {
  const candidates = new Map<string, Candidate>();
  for (const voice of notesByVoice(score).values()) {
    voice.sort((a, b) => a.tick - b.tick || a.slot - b.slot);
    const onsets: number[] = [];
    voice.forEach((event, index) => {
      if (event.tick !== voice[index - 1]?.tick) onsets.push(index);
    });
    onsets.push(voice.length);

    for (let start = 0; start + minOnsets < onsets.length; start++) {
      const limit = Math.min(start + maxOnsets, onsets.length - 1);
      for (let end = start + minOnsets; end <= limit; end++) {
        const window = voice.slice(onsets[start], onsets[end]);
        const notes = relativeNotes(window);
        const key = JSON.stringify(notes);
        const candidate = candidates.get(key) ?? { notes, windows: [] };
        candidate.windows.push(window);
        candidates.set(key, candidate);
      }
    }
  }
  return Array.from(candidates.values()).filter(({ windows }) =>
    windows.some((window) => window[0].midi !== windows[0][0].midi),
  );
}

function placeFragments(score: ScoreIR, fragments: Fragment[], occupied: Set<number>): TransposedScore {
  let slot = 0;
  return {
    ...score,
    measures: score.measures.map((measure) => ({
      ...measure,
      events: measure.events.map((event) => occupied.has(slot++) ? null : event),
    })),
    transposedFragments: fragments,
  };
}

/** Greedily adds groups that improve the size of the complete serialized score. */
export function encodeTransposedFragments(score: ScoreIR, compressedSize: (json: string) => number): TransposedScore {
  const candidates = findCandidates(score);
  const text = new TextEncoder();
  const eventSavings = score.measures.flatMap(({ events }) =>
    events.map((event) => text.encode(JSON.stringify(event)).length - 4),
  );
  let result: TransposedScore = score;
  let smallest = compressedSize(JSON.stringify(score));
  let occupied = new Set<number>();
  const fragments: Fragment[] = [];

  for (;;) {
    const choices = candidates.flatMap(({ notes, windows }) => {
      const nextOccupied = new Set(occupied);
      const occurrences: Occurrence[] = [];
      let omittedBytes = 0;
      for (const window of windows) {
        if (window.some(({ slot }) => nextOccupied.has(slot))) continue;
        const anchor = window[0];
        let previousSlot = 0;
        const slotDeltas = window.map(({ slot }) => {
          nextOccupied.add(slot);
          omittedBytes += eventSavings[slot];
          const delta = slot - previousSlot;
          previousSlot = slot;
          return delta;
        });
        occurrences.push([anchor.note.voice, anchor.note.staff, anchor.tick, anchor.diatonic, anchor.midi, slotDeltas]);
      }

      if (!occurrences.some((occurrence) => occurrence[4] !== occurrences[0][4])) return [];
      const fragment: Fragment = [notes, occurrences];
      const savings = omittedBytes - text.encode(JSON.stringify(fragment)).length;
      return [{ fragment, occupied: nextOccupied, savings }];
    }).sort((a, b) => b.savings - a.savings);

    let best: (typeof choices)[number] | undefined;
    for (const choice of choices.slice(0, shortlistSize)) {
      const trial = placeFragments(score, [...fragments, choice.fragment], choice.occupied);
      const bytes = compressedSize(JSON.stringify(trial));
      if (bytes >= smallest) continue;
      best = choice;
      smallest = bytes;
      result = trial;
    }

    if (!best) return result;
    occupied = best.occupied;
    fragments.push(best.fragment);
  }
}

function spellPitch(diatonic: number, midi: number): WrittenPitch {
  const octave = Math.floor(diatonic / steps.length);
  const step = steps[diatonic - octave * steps.length];
  return { step, octave, alter: midi - midiPitch({ step, octave, alter: 0 }) };
}

export function expandTransposedFragments(encoded: TransposedScore): ScoreIR {
  const { measures, transposedFragments = [], ...header } = encoded;
  const events = measures.flatMap((measure) => measure.events);
  const measureStarts = measures.flatMap((measure) => measure.events.map(() => measure.startTick));

  for (const [notes, occurrences] of transposedFragments) {
    for (const [voice, staff, tick, diatonic, midi, slots] of occurrences) {
      if (slots.length !== notes.length) throw new Error("Fragment length does not match its event slots");
      let slot = 0;
      for (const [index, [offset, durationTicks, scaleSteps, semitones, ties = 0, notations = [], staffOffset = 0]] of notes.entries()) {
        slot += slots[index];
        if (events[slot] !== null) throw new Error(`Invalid or reused fragment slot ${slot}`);
        events[slot] = {
          kind: "note", offsetTicks: tick + offset - measureStarts[slot], durationTicks, voice, staff: staff + staffOffset,
          pitch: spellPitch(diatonic + scaleSteps, midi + semitones),
          tieStart: (ties & 1) !== 0, tieStop: (ties & 2) !== 0, notations: structuredClone(notations),
        };
      }
    }
  }

  let nextSlot = 0;
  return {
    ...header,
    measures: measures.map((measure) => ({
      ...measure,
      events: measure.events.map(() => {
        const event = events[nextSlot++];
        if (event === null) throw new Error(`Missing fragment event in measure ${measure.number}`);
        return event;
      }),
    })),
  };
}
