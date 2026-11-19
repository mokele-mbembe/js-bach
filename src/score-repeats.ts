import type { MeasureIR, ScoreIR } from "./score-ir.js";

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
