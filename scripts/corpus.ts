import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { importMxl } from "../src/import-mxl.js";
import type { Attack, ScoreIR } from "../src/score-ir.js";

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
  referenceMidi: CorpusFile & { typesetter: string; tickRange?: [start: number, end: number] };
  expected: {
    measures: number;
    attacks: number;
    scoreOnlyAttacks?: Attack[];
    unplayedScoreAttacks?: Attack[];
    overlappingScoreAttacks?: number;
    graceNotes?: number;
    midiOnlyAttacks?: Attack[];
    realizedOrnamentAttacks?: number;
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
  const score = importMxl(readCorpusFile(input));
  if (!input.measureRange) return score;

  // The manifest uses zero-based, half-open measure indices for a combined score.
  const [start, end] = input.measureRange;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > score.measures.length) {
    throw new Error(`Invalid measure range for ${id}`);
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
    workNumber: score.workNumber ?? `BWV ${bwv}`,
    title,
    composer: score.composer ?? composer,
    tempoChanges,
    measures: score.measures.slice(start, end).map((measure) => ({ ...measure, startTick: measure.startTick - firstTick })),
  };
}
