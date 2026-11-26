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
