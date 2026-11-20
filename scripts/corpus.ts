import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { importMxl } from "../src/import-mxl.js";
import type { Attack, ScoreIR } from "../src/score-ir.js";
import { sliceScore } from "./score-slice.js";
import type { MidiReferenceTiming } from "./source-attacks.js";

interface CorpusFile {
  file: string;
  sha256: string;
  edition: string;
  source: string;
  license: string;
  licenseUrl?: string;
  attribution?: string;
}

export interface VoiceGroup {
  name: string;
  ids: string[];
}

interface MovementSource {
  id: string;
  kind: "prelude" | "fugue";
  title: string;
  key?: string;
  voices?: VoiceGroup[];
  score: CorpusFile & { upstream?: string; measureRange?: [start: number, end: number] };
  referenceMidi: CorpusFile & MidiReferenceTiming & { typesetter: string };
  expected: {
    measures: number;
    attacks: number;
    scoreOnlyAttacks?: Attack[];
    unplayedScoreAttacks?: Attack[];
    overlappingScoreAttacks?: number;
    graceNotes?: number;
    midiOnlyAttacks?: Attack[];
    realizedOrnamentAttacks?: number;
    redundantMidiNoteOffs?: number;
  };
}

export interface WorkSource {
  bwv: string;
  key: string;
  composer: string;
  collection: string;
  movements: MovementSource[];
}

const corpusDirectory = new URL("../../corpus/", import.meta.url);
const workNumbers = readdirSync(corpusDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^bwv[1-9]\d*$/.test(entry.name))
  .map((entry) => entry.name.slice(3))
  .sort((a, b) => Number(a) - Number(b));
assert.ok(workNumbers.length > 0, "No BWV directories found in corpus/");

export const works = workNumbers.map((bwv) => {
  const manifestFile = new URL(`bwv${bwv}/sources.json`, corpusDirectory);
  const manifest = readFileSync(manifestFile);
  const work = JSON.parse(manifest.toString("utf8")) as WorkSource;
  assert.equal(work.bwv, bwv, `BWV number in ${manifestFile.pathname} must match its directory`);
  assert.deepEqual(
    work.movements.map(({ kind, id }) => `${kind}:${id}`).sort(),
    [`fugue:bwv${bwv}-fugue`, `prelude:bwv${bwv}-prelude`],
    `BWV ${bwv} must contain its prelude and fugue with their canonical IDs`,
  );
  return { ...work, manifestFile, manifest };
});

export const movements = works.flatMap(({ bwv, composer, manifestFile, movements }) => movements.map((movement) => ({
  ...movement, bwv, composer,
  score: { ...movement.score, url: new URL(movement.score.file, manifestFile) },
  referenceMidi: { ...movement.referenceMidi, url: new URL(movement.referenceMidi.file, manifestFile) },
})));

export function readCorpusFile({ url, sha256 }: CorpusFile & { url: URL }): Buffer {
  const data = readFileSync(url);
  if (createHash("sha256").update(data).digest("hex") !== sha256) {
    throw new Error(`SHA-256 mismatch for ${url.pathname}`);
  }
  return data;
}

export function readMovementScore({ bwv, id, title, composer, score: input }: (typeof movements)[number]): ScoreIR {
  const original = importMxl(readCorpusFile(input));
  // The manifest uses zero-based, half-open measure indices for a combined score.
  const score = input.measureRange ? sliceScore(original, input.measureRange, id) : original;
  return {
    ...score,
    workNumber: score.workNumber ?? `BWV ${bwv}`,
    title: input.measureRange ? title : score.title ?? title,
    composer: score.composer ?? composer,
  };
}
