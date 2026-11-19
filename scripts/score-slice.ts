import type { ScoreIR } from "../src/score-ir.js";
import { writtenRepeats } from "../src/score-repeats.js";

export function sliceScore(score: ScoreIR, [start, end]: [number, number], id: string): ScoreIR {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > score.measures.length) {
    throw new Error(`Invalid measure range for ${id}`);
  }
  for (const repeat of writtenRepeats(score.measures)) {
    if (start < repeat.end && repeat.start < end && (start > repeat.start || end < repeat.end)) {
      throw new Error(`Measure range for ${id} cuts through a repeat`);
    }
  }
  const firstTick = score.measures[start].startTick;
  const last = score.measures[end - 1];
  const endTick = last.startTick + last.durationTicks;
  const tempoChanges = score.tempoChanges.filter(({ tick }) => firstTick <= tick && tick < endTick)
    .map((tempo) => ({ ...tempo, tick: tempo.tick - firstTick }));
  const inheritedTempo = score.tempoChanges.filter(({ tick }) => tick < firstTick).at(-1);
  if (inheritedTempo && tempoChanges[0]?.tick !== 0) tempoChanges.unshift({ ...inheritedTempo, tick: 0 });
  return {
    ...score,
    tempoChanges,
    measures: score.measures.slice(start, end).map((measure) => ({ ...measure, startTick: measure.startTick - firstTick })),
  };
}
