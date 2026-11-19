import type { WrittenPitch } from "./score-ir.js";

export function tieKey(tick: number, { step, alter, octave }: WrittenPitch): string {
  return JSON.stringify([tick, step, alter, octave]);
}

export function tieStartVoice(continuations: ReadonlyMap<string, unknown> | undefined, voice: string): string | undefined {
  // A single matching tie can continue under a different exported voice ID.
  if (continuations?.has(voice)) return voice;
  if (continuations?.size === 1) return continuations.keys().next().value;
}
