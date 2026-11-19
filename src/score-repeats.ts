import type { MeasureIR, NoteEvent, ScoreIR } from "./score-ir.js";
import { tieKey, tieStartVoice } from "./score-ties.js";

export function writtenRepeats(measures: readonly MeasureIR[]) {
  const repeats: { start: number; end: number; times: number }[] = [];
  let impliedStart = 0;
  let explicitStart: number | undefined;
  for (const [index, measure] of measures.entries()) {
    if (measure.repeatStart) {
      if (explicitStart !== undefined) throw new Error(`Nested repeat in measure ${measure.number}`);
      explicitStart = index;
    }
    if (measure.repeatEnd !== undefined) {
      repeats.push({ start: explicitStart ?? impliedStart, end: index + 1, times: measure.repeatEnd });
      impliedStart = index + 1;
      explicitStart = undefined;
    }
  }
  if (explicitStart !== undefined) throw new Error(`Unclosed repeat in measure ${measures[explicitStart].number}`);
  return repeats;
}

function followRepeatJump(previous: MeasureIR, next: MeasureIR) {
  // A jump can skip a written tie partner. Preserve every tie outside that boundary.
  const boundary = next.startTick;
  const starts = new Map<string, Map<string, NoteEvent>>();
  for (const note of previous.events) {
    if (note.kind !== "note" || note.grace || !note.tieStart || note.offsetTicks + note.durationTicks !== previous.durationTicks) continue;
    const key = tieKey(boundary, note.pitch);
    const voices = starts.get(key) ?? new Map<string, NoteEvent>();
    if (voices.has(note.voice)) throw new Error(`Ambiguous tie in measure ${previous.number}, voice ${note.voice}`);
    voices.set(note.voice, note);
    starts.set(key, voices);
  }
  next.events = next.events.map((note) => {
    if (note.kind !== "note" || note.grace || !note.tieStop || note.offsetTicks !== 0) return note;
    const voices = starts.get(tieKey(boundary, note.pitch));
    const voice = tieStartVoice(voices, note.voice);
    if (voice === undefined) return { ...note, tieStop: false };
    voices?.delete(voice);
    return note;
  });
  const unmatched = new Set([...starts.values()].flatMap((voices) => [...voices.values()]));
  previous.events = previous.events.map((note) =>
    note.kind === "note" && unmatched.has(note) ? { ...note, tieStart: false } : note,
  );
}

/** Keep the written score intact and produce a separate timeline for playback and MIDI comparison. */
export function expandWrittenRepeats(score: ScoreIR): ScoreIR {
  const repeats = writtenRepeats(score.measures);
  if (repeats.length === 0) return score;

  const measures: MeasureIR[] = [];
  const tempoChanges: ScoreIR["tempoChanges"] = [];
  let tick = 0;
  const append = (start: number, end: number, replay = false) => {
    if (start === end) return;
    const startTick = score.measures[start].startTick;
    if (replay && !score.tempoChanges.some((tempo) => tempo.tick === startTick)) {
      const inherited = score.tempoChanges.filter((tempo) => tempo.tick < startTick).at(-1);
      const beatsPerMinute = inherited?.beatsPerMinute ?? 120;
      if ((tempoChanges.at(-1)?.beatsPerMinute ?? 120) !== beatsPerMinute) {
        tempoChanges.push({ tick, beatsPerMinute });
      }
    }
    const firstPerformedIndex = measures.length;
    for (const { repeatStart, repeatEnd, ...measure } of score.measures.slice(start, end)) {
      const endTick = measure.startTick + measure.durationTicks;
      for (const tempo of score.tempoChanges) {
        if (measure.startTick <= tempo.tick && tempo.tick < endTick) {
          tempoChanges.push({ ...tempo, tick: tick + tempo.tick - measure.startTick });
        }
      }
      measures.push({ ...measure, startTick: tick });
      tick += measure.durationTicks;
    }
    if (replay) followRepeatJump(measures[firstPerformedIndex - 1], measures[firstPerformedIndex]);
  };

  let cursor = 0;
  for (const { start, end, times } of repeats) {
    append(cursor, end);
    for (let pass = 1; pass < times; pass++) append(start, end, true);
    cursor = end;
  }
  append(cursor, score.measures.length);
  return { ...score, measures, tempoChanges };
}
