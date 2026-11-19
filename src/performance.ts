import { midiPitch, type ScoreIR, type WrittenPitch } from "./score-ir.js";

export interface PerformanceNote {
  startSeconds: number;
  endSeconds: number;
  midiPitch: number;
  voice: string;
}

export interface Performance {
  notes: PerformanceNote[];
  durationSeconds: number;
}

interface NoteSpan {
  startTick: number;
  endTick: number;
  midiPitch: number;
  voice: string;
}

function tieKey(tick: number, { step, alter, octave }: WrittenPitch): string {
  return JSON.stringify([tick, step, alter, octave]);
}

function joinTies(score: ScoreIR): NoteSpan[] {
  const segments = score.measures.flatMap((measure) => measure.events.flatMap((event) =>
    event.kind === "note" && !event.grace
      ? [{ ...event, measure: measure.number, startTick: measure.startTick + event.offsetTicks }]
      : [],
  )).sort((a, b) => a.startTick - b.startTick);

  const spans: NoteSpan[] = [];
  const pending = new Map<string, Map<string, NoteSpan>>();

  for (const { startTick, durationTicks, pitch, voice, measure, tieStart, tieStop } of segments) {
    const endTick = startTick + durationTicks;
    let span: NoteSpan;
    if (tieStop) {
      const key = tieKey(startTick, pitch);
      const continuations = pending.get(key);
      // A single matching tie can continue under a different exported voice ID.
      const previousVoice = continuations?.has(voice) ? voice : continuations?.size === 1
        ? continuations.keys().next().value : undefined;
      const previous = previousVoice === undefined ? undefined : continuations?.get(previousVoice);
      if (!continuations || previousVoice === undefined || !previous) {
        throw new Error(`Unmatched tie continuation in measure ${measure}, voice ${voice}`);
      }
      continuations.delete(previousVoice);
      if (continuations.size === 0) pending.delete(key);
      previous.endTick = endTick;
      span = previous;
    } else {
      span = { startTick, endTick, midiPitch: midiPitch(pitch), voice };
      spans.push(span);
    }

    if (tieStart) {
      const key = tieKey(endTick, pitch);
      const continuations = pending.get(key) ?? new Map<string, NoteSpan>();
      if (continuations.has(voice)) throw new Error(`Ambiguous tie in measure ${measure}, voice ${voice}`);
      continuations.set(voice, span);
      pending.set(key, continuations);
    }
  }

  for (const continuations of pending.values()) {
    for (const { voice, endTick } of continuations.values()) {
      throw new Error(`Unclosed tie in voice ${voice} at tick ${endTick}`);
    }
  }
  return spans;
}

function scoreClock({ ticksPerQuarter, tempoChanges }: ScoreIR): (tick: number) => number {
  const segments = [{ tick: 0, seconds: 0, secondsPerTick: 60 / (120 * ticksPerQuarter) }];
  for (const { tick, beatsPerMinute } of tempoChanges) {
    const previous = segments[segments.length - 1];
    segments.push({
      tick,
      seconds: previous.seconds + (tick - previous.tick) * previous.secondsPerTick,
      secondsPerTick: 60 / (beatsPerMinute * ticksPerQuarter),
    });
  }

  return (tick) => {
    let index = segments.length - 1;
    while (segments[index].tick > tick) index--;
    const segment = segments[index];
    return segment.seconds + (tick - segment.tick) * segment.secondsPerTick;
  };
}

export function toPerformance(score: ScoreIR): Performance {
  const secondsAt = scoreClock(score);
  const notes = joinTies(score).map(({ startTick, endTick, ...note }) => ({
    ...note,
    startSeconds: secondsAt(startTick),
    endSeconds: secondsAt(endTick),
  }));
  const lastMeasure = score.measures.at(-1);
  const durationSeconds = lastMeasure ? secondsAt(lastMeasure.startTick + lastMeasure.durationTicks) : 0;
  return { notes, durationSeconds };
}

export function soloVoice(performance: Performance, voice: string | readonly string[]): Performance {
  const ids = new Set(typeof voice === "string" ? [voice] : voice);
  const notes = performance.notes.filter((note) => ids.has(note.voice));
  const firstEntry = notes[0]?.startSeconds ?? 0;
  let durationSeconds = 0;
  const shiftedNotes = notes.map((note) => {
    const endSeconds = note.endSeconds - firstEntry;
    durationSeconds = Math.max(durationSeconds, endSeconds);
    return { ...note, startSeconds: note.startSeconds - firstEntry, endSeconds };
  });
  return { notes: shiftedNotes, durationSeconds };
}
