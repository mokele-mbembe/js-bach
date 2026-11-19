import assert from "node:assert/strict";
import { parseMidi } from "midi-file";
import { getScoreAttacks, midiPitch, type Attack, type ScoreIR } from "../src/score-ir.js";
import { expandWrittenRepeats } from "../src/score-repeats.js";

export function attackKey({ tick, midiPitch }: Attack): string {
  return `${tick}:${midiPitch}`;
}

function readReference(data: Uint8Array, [startTick, endTick]: [number, number] = [0, Infinity]) {
  const midi = parseMidi(data);
  const ticksPerQuarter = midi.header.ticksPerBeat;
  assert.ok(ticksPerQuarter, "Expected a MIDI reference with quarter-note timing");

  const attacks = new Map<string, Attack>();
  const holds = new Map<number, { start: number; end: number }[]>();
  let end = 0;
  for (const track of midi.tracks) {
    let tick = 0;
    const active = new Map<string, number[]>();
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type !== "noteOn" && event.type !== "noteOff") continue;
      const { noteNumber: midiPitch, channel } = event;
      const key = `${channel}:${midiPitch}`;
      if (event.type === "noteOn" && event.velocity > 0) {
        if (startTick <= tick && tick < endTick) {
          const attack = { tick: tick - startTick, midiPitch };
          attacks.set(attackKey(attack), attack);
        }
        const starts = active.get(key) ?? [];
        starts.push(tick);
        active.set(key, starts);
      } else {
        const start = active.get(key)?.shift();
        assert.ok(start !== undefined, `Unmatched MIDI note-off at tick ${tick}, pitch ${midiPitch}`);
        const intervals = holds.get(midiPitch) ?? [];
        intervals.push({ start: start - startTick, end: tick - startTick });
        holds.set(midiPitch, intervals);
      }
    }
    assert.ok([...active.values()].every((starts) => starts.length === 0), "Unclosed note in MIDI reference");
    end = Math.max(end, tick);
  }
  return { attacks, holds, ticksPerQuarter, startTick, end };
}

export function compareSourceAttacks(writtenScore: ScoreIR, midi: Uint8Array, tickRange?: [number, number]) {
  const score = expandWrittenRepeats(writtenScore);
  const reference = readReference(midi, tickRange);
  const toMidiTick = (tick: number) => tick * reference.ticksPerQuarter / score.ticksPerQuarter;
  const attacks = getScoreAttacks(score);
  const midiGrid = attacks.map(({ tick, midiPitch }) => ({ tick: toMidiTick(tick), midiPitch, scoreTick: tick }));
  const scoreKeys = new Set(midiGrid.map(attackKey));
  const scoreOnly = midiGrid.filter((attack) => !reference.attacks.has(attackKey(attack)));
  const midiOnly = [...reference.attacks.values()].filter((attack) => !scoreKeys.has(attackKey(attack)))
    .sort((a, b) => a.tick - b.tick || a.midiPitch - b.midiPitch);
  return { performedScore: score, reference, toMidiTick, attacks, midiGrid, scoreOnly, midiOnly };
}

export function describeMidiDifferences(score: ScoreIR, toMidiTick: (tick: number) => number, midiOnly: Attack[]) {
  const graceNotes: Attack[] = [];
  const continuations = new Set<string>();
  const arpeggiatedNotes: { start: number; end: number; midiPitch: number }[] = [];
  const writtenOrnaments: {
    start: number; end: number; midiPitch: number; voice: string; tieStart: boolean; measure: string; kind: string;
  }[] = [];
  for (const measure of score.measures) {
    for (const note of measure.events) {
      if (note.kind !== "note") continue;
      const attack = { tick: toMidiTick(measure.startTick + note.offsetTicks), midiPitch: midiPitch(note.pitch) };
      if (note.grace) {
        assert.equal(note.durationTicks, 0);
        graceNotes.push(attack);
      }
      if (note.tieStop) continuations.add(attackKey(attack));
      const previous = note.tieStop ? writtenOrnaments.find(({ end, midiPitch, voice, tieStart }) =>
        tieStart && end === attack.tick && midiPitch === attack.midiPitch && voice === note.voice,
      ) : undefined;
      const end = attack.tick + toMidiTick(note.durationTicks);
      if (note.notations.some(({ kind }) => kind === "arpeggiate")) {
        arpeggiatedNotes.push({ start: attack.tick, end, midiPitch: attack.midiPitch });
      }
      const ornament = note.notations.find(({ kind }) => kind === "trill-mark" || kind === "inverted-mordent" || kind === "mordent");
      if (previous) {
        previous.end = end;
        previous.tieStart = note.tieStart;
      } else if (ornament) {
        writtenOrnaments.push({ start: attack.tick, end, midiPitch: attack.midiPitch, voice: note.voice, tieStart: note.tieStart,
          measure: measure.number, kind: ornament.kind });
      }
    }
  }
  const differences = midiOnly.map((attack) => ({
    attack,
    ornaments: writtenOrnaments.filter(({ start, end, midiPitch, kind }) => {
      const interval = kind === "mordent" ? midiPitch - attack.midiPitch : attack.midiPitch - midiPitch;
      return start <= attack.tick && attack.tick < end && interval >= 0 && interval <= 2;
    }).map(({ measure, kind, voice }) => ({ measure, kind, voice })),
    earlyGrace: graceNotes.some((note) => note.midiPitch === attack.midiPitch && attack.tick < note.tick
      && note.tick - attack.tick <= toMidiTick(score.ticksPerQuarter) / 2),
    staggeredChord: arpeggiatedNotes.some(({ start, end, midiPitch }) =>
      midiPitch === attack.midiPitch && start < attack.tick && attack.tick < end,
    ),
    tieContinuation: continuations.has(attackKey(attack)),
  }));
  return { graceNotes, differences };
}
