import { midiPitch, type NoteEvent, type ScoreIR } from "./score-ir.js";
import { expandWrittenRepeats } from "./score-repeats.js";
import { tieKey, tieStartVoice } from "./score-ties.js";

export { soloVoice } from "./playback-asset.js";

export interface PerformanceNote {
  startSeconds: number;
  endSeconds: number;
  midiPitch: number;
  voice: string;
  voiceId?: string;
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
  voiceId?: string;
}

type ResolveVoice = (measure: string, scoreVoice: string, note: Readonly<NoteEvent>) => string | undefined;

function joinTies(score: ScoreIR, resolveVoice?: ResolveVoice): NoteSpan[] {
  const segments = score.measures.flatMap((measure) => measure.events.flatMap((event) =>
    event.kind === "note" && !event.grace
      ? [{ ...event, measure: measure.number, startTick: measure.startTick + event.offsetTicks }]
      : [],
  )).sort((a, b) => a.startTick - b.startTick);

  const spans: NoteSpan[] = [];
  const pending = new Map<string, Map<string, NoteSpan>>();

  for (const segment of segments) {
    const { startTick, durationTicks, pitch, voice, measure, tieStart, tieStop } = segment;
    const endTick = startTick + durationTicks;
    const voiceId = resolveVoice?.(measure, voice, segment);
    let span: NoteSpan;
    if (tieStop) {
      const key = tieKey(startTick, pitch);
      const continuations = pending.get(key);
      const previousVoice = tieStartVoice(continuations, voice);
      const previous = previousVoice === undefined ? undefined : continuations?.get(previousVoice);
      if (!continuations || previousVoice === undefined || !previous) {
        throw new Error(`Unmatched tie continuation in measure ${measure}, voice ${voice}`);
      }
      if (previous.voiceId !== voiceId) {
        throw new Error(`Tie changes musical voice in measure ${measure}, score voice ${voice}`);
      }
      continuations.delete(previousVoice);
      if (continuations.size === 0) pending.delete(key);
      previous.endTick = endTick;
      span = previous;
    } else {
      span = { startTick, endTick, midiPitch: midiPitch(pitch), voice, ...(voiceId === undefined ? {} : { voiceId }) };
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

export function toPerformance(writtenScore: ScoreIR, resolveVoice?: ResolveVoice): Performance {
  const score = expandWrittenRepeats(writtenScore);
  const secondsAt = scoreClock(score);
  const notes = joinTies(score, resolveVoice).map(({ startTick, endTick, ...note }) => ({
    ...note,
    startSeconds: secondsAt(startTick),
    endSeconds: secondsAt(endTick),
  }));
  const lastMeasure = score.measures.at(-1);
  const durationSeconds = lastMeasure ? secondsAt(lastMeasure.startTick + lastMeasure.durationTicks) : 0;
  return { notes, durationSeconds };
}
