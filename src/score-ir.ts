export const naturalSemitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;

export interface WrittenPitch {
  step: keyof typeof naturalSemitones;
  alter: number;
  octave: number;
}

export interface NotationMark {
  kind: string;
  attributes: Record<string, string>;
  text: string;
}

interface TimedEvent {
  offsetTicks: number;
  durationTicks: number;
  voice: string;
  staff: number;
  notations: NotationMark[];
}

export interface NoteEvent extends TimedEvent {
  kind: "note";
  pitch: WrittenPitch;
  tieStart: boolean;
  tieStop: boolean;
  grace?: { type?: string; attributes: Record<string, string> };
}

export interface RestEvent extends TimedEvent {
  kind: "rest";
}

export interface MeasureIR {
  number: string;
  startTick: number;
  durationTicks: number;
  repeatStart?: true;
  repeatEnd?: number;
  events: (NoteEvent | RestEvent)[];
}

export interface ScoreIR {
  workNumber?: string;
  title?: string;
  composer?: string;
  partId: string;
  ticksPerQuarter: number;
  tempoChanges: { tick: number; beatsPerMinute: number }[];
  measures: MeasureIR[];
}

export interface Attack {
  tick: number;
  midiPitch: number;
}

export function midiPitch({ step, alter, octave }: WrittenPitch): number {
  return (octave + 1) * 12 + naturalSemitones[step] + alter;
}

/** Projects the score onto distinct sounding pitches and start times for MIDI comparison. */
export function getScoreAttacks(score: ScoreIR): Attack[] {
  const attacks = new Map<string, Attack>();
  for (const measure of score.measures) {
    for (const event of measure.events) {
      if (event.kind === "note" && !event.tieStop && !event.grace) {
        const tick = measure.startTick + event.offsetTicks;
        const pitch = midiPitch(event.pitch);
        attacks.set(`${tick}:${pitch}`, { tick, midiPitch: pitch });
      }
    }
  }
  return Array.from(attacks.values()).sort((a, b) => a.tick - b.tick || a.midiPitch - b.midiPitch);
}
