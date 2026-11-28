import { midiPitch, type WrittenPitch } from "../src/score-ir.js";
import type { ReferenceVoiceNote } from "./voice-audit-matcher.js";

const ticksPerQuarter = 256;
const spinePath = new Set(["*^", "*v", "*x", "*+", "*-"]);
const interpretation = /^\*(?:staff[1-9]\d*|clef[CFG][1-5]|k\[(?:[a-g](?:#+|-+|n))*\]|M[1-9]\d*\/[1-9]\d*|MM[1-9]\d*(?:\.\d+)?|[A-Ga-g](?:#+|-+)?:)?$/u;
const noteToken = /^(\[?)(0{1,2}|[1-9]\d*)(\.*)(r|[A-G]+|[a-g]+)(#+|-+|n)?([LJKk;MmTt\[\]_()]*)$/u;

interface Spine {
  voiceId: string | undefined;
  end: number;
  tiedPitch?: number;
  hasNotes: boolean;
}

function fail(line: number, issue: string): never {
  throw new Error(`**kern line ${line}: ${issue}`);
}

function readToken(token: string, line: number, column: number) {
  const at = `in spine ${column}`;
  if (/\s/u.test(token)) fail(line, `unsupported chord or whitespace ${at}: ${JSON.stringify(token)}`);
  const match = noteToken.exec(token);
  if (!match) fail(line, `unsupported note or rest ${at}: ${JSON.stringify(token)}`);
  const [, prefix, reciprocal, dots, pitch, accidental, suffix] = match;
  const tie = `${prefix}${suffix}`.match(/[\[\]_]/gu) ?? [];
  if (tie.length > 1) fail(line, `invalid tie markers ${at}: ${JSON.stringify(token)}`);
  const tieStart = tie[0] === "[" || tie[0] === "_";
  const tieStop = tie[0] === "]" || tie[0] === "_";

  const wholeNote = 4 * ticksPerQuarter;
  const base = reciprocal === "00" ? 4 * wholeNote : reciprocal === "0" ? 2 * wholeNote : wholeNote;
  const divisor = reciprocal.startsWith("0") ? 1 : Number(reciprocal);
  const dotFactor = 2 ** dots.length;
  const numerator = base * (2 * dotFactor - 1);
  const denominator = divisor * dotFactor;
  const durationTicks = numerator / denominator;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || !Number.isSafeInteger(durationTicks) || durationTicks < 1) {
    fail(line, `unsupported duration ${at}: ${JSON.stringify(token)}`);
  }
  if (pitch === "r") {
    if (accidental || tie.length) fail(line, `invalid accidental or tie on rest ${at}: ${JSON.stringify(token)}`);
    return { durationTicks, pitchNumber: undefined, tieStart, tieStop };
  }
  if (!/^([A-Ga-g])\1*$/u.test(pitch)) fail(line, `invalid pitch ${at}: ${JSON.stringify(token)}`);
  const step = pitch[0].toUpperCase() as WrittenPitch["step"];
  // Single lowercase c denotes C4, single uppercase C denotes C3.
  const octave = pitch === pitch.toLowerCase() ? 3 + pitch.length : 4 - pitch.length;
  const alter = accidental?.startsWith("#") ? accidental.length : accidental?.startsWith("-") ? -accidental.length : 0;
  const pitchNumber = midiPitch({ step, octave, alter });
  if (pitchNumber < 0 || pitchNumber > 127) fail(line, `pitch outside MIDI range ${at}: ${JSON.stringify(token)}`);
  return { durationTicks, pitchNumber, tieStart, tieStop };
}

/** Reads one written score with fixed, monophonic **kern spines on a 256-tick quarter grid. */
export function readKernVoices(source: string, columns: Readonly<Record<string, string>>): {
  ticksPerQuarter: number;
  notes: ReferenceVoiceNote[];
} {
  const selected = Object.entries(columns);
  if (!selected.length || new Set(selected.map(([, id]) => id)).size !== selected.length ||
      selected.some(([column, id]) => !/^[1-9]\d*$/u.test(column) || !Number.isSafeInteger(Number(column)) || !/^[a-z][a-z0-9-]*$/u.test(id))) {
    throw new Error("Select **kern spines by 1-based column with distinct lowercase voice IDs");
  }
  const byColumn = new Map(selected.map(([column, id]) => [Number(column), id]));
  const notes: ReferenceVoiceNote[] = [];
  let spines: Spine[] | undefined;
  let ended = false;
  let tick = 0;

  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (const [index, row] of lines.entries()) {
    if (!row || row.startsWith("!!")) continue;
    const line = index + 1;
    const fields = row.split("\t");
    if (ended) fail(line, "unexpected record after spine termination");
    if (!spines) {
      if (!fields.every((field) => field === "**kern")) fail(line, "expected a header of **kern spines");
      if ([...byColumn.keys()].some((column) => column > fields.length)) fail(line, "selected column is outside the **kern header");
      spines = fields.map((_, column) => ({ voiceId: byColumn.get(column + 1), end: 0, hasNotes: false }));
      continue;
    }
    if (fields.length !== spines.length) fail(line, `expected ${spines.length} spine columns, found ${fields.length}`);
    if (fields.every((field) => field === "*-")) {
      if (spines.some(({ end, tiedPitch }) => end !== tick || tiedPitch !== undefined)) fail(line, "spines terminate with an unfinished note, rest, or tie");
      ended = true;
      continue;
    }
    if (fields.every((field) => field.startsWith("!"))) continue;
    if (fields.some((field) => field.startsWith("*"))) {
      const path = fields.find((field) => spinePath.has(field));
      if (path) fail(line, `unsupported spine path ${path}`);
      const unsupported = fields.find((field) => !interpretation.test(field));
      if (unsupported !== undefined) fail(line, `unsupported interpretation ${JSON.stringify(unsupported)}`);
      continue;
    }
    if (fields.some((field) => field.startsWith("="))) {
      if (!fields.every((field) => /^={1,2}(?:\d+[a-z]?)?[|:]*$/u.test(field))) fail(line, "unsupported barline record");
      if (spines.some(({ end }) => end !== tick)) fail(line, "barline interrupts an unfinished note or rest");
      continue;
    }

    let nextTick = Infinity;
    for (const [column, token] of fields.entries()) {
      const spine = spines[column];
      if (token === ".") {
        if (spine.end <= tick) fail(line, `null token has no active note or rest in spine ${column + 1}`);
      } else {
        if (spine.end !== tick) fail(line, `event overlaps an active note or rest in spine ${column + 1}`);
        const { durationTicks, pitchNumber, tieStart, tieStop } = readToken(token, line, column + 1);
        if (tieStop ? spine.tiedPitch !== pitchNumber : spine.tiedPitch !== undefined) {
          fail(line, `invalid tie continuation in spine ${column + 1}: ${JSON.stringify(token)}`);
        }
        spine.end = tick + durationTicks;
        if (!Number.isSafeInteger(spine.end)) fail(line, "score duration exceeds the integer tick grid");
        spine.tiedPitch = tieStart ? pitchNumber : undefined;
        if (pitchNumber !== undefined && spine.voiceId !== undefined) {
          spine.hasNotes = true;
          notes.push({ voiceId: spine.voiceId, tick, durationTicks, midiPitch: pitchNumber, tieStart, tieStop });
        }
      }
      nextTick = Math.min(nextTick, spine.end);
    }
    tick = nextTick;
  }
  if (!spines || !ended) throw new Error("Expected a complete **kern spine header and termination record");
  for (const [index, { voiceId, hasNotes }] of spines.entries()) {
    if (voiceId !== undefined && !hasNotes) throw new Error(`No timed notes in **kern spine ${index + 1}`);
  }
  return { ticksPerQuarter, notes };
}
