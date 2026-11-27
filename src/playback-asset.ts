import type { Performance } from "./performance.js";

export interface Voice {
  readonly id: string;
  readonly name: string;
}

export interface PerformanceEvent {
  readonly midiPitch: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** The musical voice ID, when this movement has verified voice groups. */
  readonly voiceId: string | null;
  /** The score export's voice label at the attack, including for tied notes. */
  readonly scoreVoice: string;
}

export interface PerformanceTimeline {
  readonly durationSeconds: number;
  readonly notes: readonly PerformanceEvent[];
}

type PackedNote = [midiPitch: number, startSeconds: number, endSeconds: number, voiceIndex: number, groupIndex?: number];

interface PackedPerformance {
  durationSeconds: number;
  voices: string[];
  notes: PackedNote[];
}

interface CompressionSize {
  jsonBytes: number;
  brotliBytes: number;
}

export interface PlaybackAsset {
  work: { bwv: string; key: string; composer: string; collection: string };
  source: {
    id: string;
    kind: "prelude" | "fugue";
    title: string;
    key?: string;
    voices?: { name: string; ids: string[] }[];
    scopedScoreVoices?: string[];
    score: {
      edition: string;
      source: string;
      license: string;
      licenseUrl?: string;
      attribution?: string;
      upstream?: string;
      changes: string;
    };
    referenceMidi: { typesetter: string; edition: string; source: string };
  };
  performance: PackedPerformance;
  sizes: {
    eventStream: CompressionSize;
    rhythmEncoding: CompressionSize;
    transposedEncoding: CompressionSize;
  };
  analysis: {
    rhythm: { templateCount: number; measures: [number: string, templateId?: number][] };
    transposed: {
      ticksPerQuarter: number;
      measures: [number: string, startTick: number, durationTicks: number][];
      fragments: [noteCount: number, length: number, occurrences: [voice: string, startTick: number, pitch: number][]][];
    };
  };
}

export function encodePlayback(
  { durationSeconds, notes }: Performance,
  groups?: PlaybackAsset["source"]["voices"],
): PackedPerformance {
  const { voices: musicalVoices, byScoreVoice } = describeVoices(groups);
  const voices = [...new Set(notes.map(({ voice }) => voice))];
  return {
    durationSeconds,
    voices,
    notes: notes.map(({ midiPitch, startSeconds, endSeconds, voice, voiceId }) => {
      const note: PackedNote = [midiPitch, startSeconds, endSeconds, voices.indexOf(voice)];
      if (voiceId !== byScoreVoice.get(voice)) {
        const groupIndex = musicalVoices.findIndex(({ id }) => id === voiceId);
        if (groupIndex < 0) throw new Error(`Unknown musical voice ${voiceId} for score voice ${voice}`);
        note[4] = groupIndex;
      }
      return note;
    }),
  };
}

export function decodePlayback({ source, performance }: Pick<PlaybackAsset, "source" | "performance">): Performance {
  const { voices: musicalVoices, byScoreVoice } = describeVoices(source.voices);
  const { durationSeconds, voices, notes } = performance;
  return {
    durationSeconds,
    notes: notes.map(([midiPitch, startSeconds, endSeconds, voiceIndex, groupIndex]) => {
      const voice = voices[voiceIndex];
      const voiceId = groupIndex === undefined ? byScoreVoice.get(voice) : musicalVoices[groupIndex].id;
      return { midiPitch, startSeconds, endSeconds, voice, ...(voiceId === undefined ? {} : { voiceId }) };
    }),
  };
}

export function describeVoices(groups: NonNullable<PlaybackAsset["source"]["voices"]> = []) {
  const byScoreVoice = new Map<string, string>();
  const voices: readonly Voice[] = Object.freeze(groups.map(({ name, ids }) => {
    const id = name.toLowerCase();
    for (const scoreVoice of ids) byScoreVoice.set(scoreVoice, id);
    return Object.freeze({ id, name });
  }));
  return { voices, byScoreVoice };
}

export function performanceTimeline({ durationSeconds, notes }: Performance): PerformanceTimeline {
  return Object.freeze({
    durationSeconds,
    notes: Object.freeze(notes.map(({ voice, voiceId, ...note }) => Object.freeze({
      ...note, voiceId: voiceId ?? null, scoreVoice: voice,
    }))),
  });
}

export function soloVoice(performance: Performance, voice: string | readonly string[]): Performance {
  const ids = new Set(typeof voice === "string" ? [voice] : voice);
  return rebaseSolo(performance.notes.filter((note) => ids.has(note.voice)));
}

export function soloMusicalVoice(performance: Performance, voiceId: string): Performance {
  return rebaseSolo(performance.notes.filter((note) => note.voiceId === voiceId));
}

function rebaseSolo(notes: Performance["notes"]): Performance {
  const firstEntry = notes[0]?.startSeconds ?? 0;
  let durationSeconds = 0;
  const shiftedNotes = notes.map((note) => {
    const endSeconds = note.endSeconds - firstEntry;
    durationSeconds = Math.max(durationSeconds, endSeconds);
    return { ...note, startSeconds: note.startSeconds - firstEntry, endSeconds };
  });
  return { notes: shiftedNotes, durationSeconds };
}
