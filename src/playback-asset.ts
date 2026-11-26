import type { Performance } from "./performance.js";

interface PackedPerformance {
  durationSeconds: number;
  voices: string[];
  notes: [midiPitch: number, startSeconds: number, endSeconds: number, voiceIndex: number][];
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

export function decodePlayback({ durationSeconds, voices, notes }: PackedPerformance): Performance {
  return {
    durationSeconds,
    notes: notes.map(([midiPitch, startSeconds, endSeconds, voiceIndex]) => ({
      midiPitch, startSeconds, endSeconds, voice: voices[voiceIndex],
    })),
  };
}
