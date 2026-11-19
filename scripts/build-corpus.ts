import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { encodeRhythmTemplates, expandRhythmTemplates } from "../src/rhythm-templates.js";
import { encodeTransposedFragments, expandTransposedFragments } from "../src/transposed-fragments.js";
import { movements, readMovementScore, works } from "./corpus.js";

const brotli = {
  quality: 11,
  mode: "text",
};

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--fresh"), "Usage: npm run build:corpus -- [--fresh]");
const fresh = args.length > 0;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Include the search, its dependencies and the exact Brotli runner used to rank candidates.
const encoderFiles = [import.meta.url, "../src/transposed-fragments.js", "../src/score-ir.js"];
const encoderFingerprint = sha256(JSON.stringify([
  brotli, process.version, process.versions.brotli, process.platform, process.arch,
  ...encoderFiles.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")),
]));

function readCachedTransposition(directory: URL, id: string, key: string): string | undefined {
  try {
    const [inputHash, outputHash] = readFileSync(new URL(`.${id}.transposed.cache`, directory), "utf8").trim().split(" ");
    if (inputHash !== key) return undefined;
    const json = readFileSync(new URL(`${id}.transposed.json`, directory), "utf8");
    return sha256(json) === outputHash ? json : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function writeOutput(file: URL, data: string | Uint8Array): void {
  const temporary = new URL(`.${randomUUID()}.tmp`, file);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function brotliBytes(json: string): number {
  return brotliCompressSync(Buffer.from(json, "utf8"), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: brotli.quality,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  }).length;
}

function sizes(json: string) {
  return { jsonBytes: Buffer.byteLength(json, "utf8"), brotliBytes: brotliBytes(json) };
}

const target = new URL("../corpus/", import.meta.url);
const scores = movements.map((movement) => {
  const { id, bwv, title, score: input } = movement;
  const score = readMovementScore(movement);
  const attribution = input.attribution && {
    credit: input.attribution,
    edition: input.edition,
    source: input.source,
    license: input.license,
    licenseUrl: input.licenseUrl,
    changes: `Converted from ${input.edition} MusicXML to js-bach score data.`,
  };
  const original = { sourceId: id, ...score, ...(attribution ? { attribution } : {}) };
  const eventJson = JSON.stringify(original);
  const eventData = JSON.parse(eventJson);
  const rhythmJson = JSON.stringify(encodeRhythmTemplates(original));
  assert.deepEqual(expandRhythmTemplates(JSON.parse(rhythmJson)), eventData, `${id} changed during rhythm expansion`);

  const directory = new URL(`bwv${bwv}/`, target);
  const cacheKey = sha256(encoderFingerprint + eventJson);
  const cached = fresh ? undefined : readCachedTransposition(directory, id, cacheKey);
  const transposedJson = cached ?? JSON.stringify(encodeTransposedFragments(original, brotliBytes));
  assert.deepEqual(expandTransposedFragments(JSON.parse(transposedJson)), eventData, `${id} changed during fragment expansion`);
  const comparison = {
    eventStream: sizes(eventJson),
    rhythmEncoding: sizes(rhythmJson),
    transposedEncoding: sizes(transposedJson),
  };
  console.log(`${id} — ${original.measures.length} measures verified, Brotli event stream ${comparison.eventStream.brotliBytes} B, rhythm ${comparison.rhythmEncoding.brotliBytes} B, transposition ${comparison.transposedEncoding.brotliBytes} B${cached === undefined ? "" : " (cached search)"}`);
  return { id, bwv, title, original, rhythmJson, transposedJson, cacheKey, sizes: comparison };
});

for (const { bwv, manifestFile } of works) {
  const directory = new URL(`bwv${bwv}/`, target);
  mkdirSync(directory, { recursive: true });
  writeOutput(new URL("sources.json", directory), readFileSync(manifestFile));
  const workScores = scores.filter((score) => score.bwv === bwv);
  for (const { id, original, rhythmJson, transposedJson, cacheKey } of workScores) {
    writeOutput(new URL(`${id}.json`, directory), `${JSON.stringify(original, null, 2)}\n`);
    writeOutput(new URL(`${id}.rhythm.json`, directory), rhythmJson);
    writeOutput(new URL(`${id}.transposed.json`, directory), transposedJson);
    writeOutput(new URL(`.${id}.transposed.cache`, directory), `${cacheKey} ${sha256(transposedJson)}\n`);
  }
  writeOutput(new URL("compression.json", directory), `${JSON.stringify({
    brotli,
    movements: Object.fromEntries(workScores.map(({ id, sizes }) => [id, sizes])),
  }, null, 2)}\n`);
}
writeOutput(new URL("catalog.json", target), `${JSON.stringify({ works: works.map(({ bwv, key }) => ({ bwv, key })) })}\n`);

const comparisonTable = [
  "# Corpus compression comparison",
  "",
  `Compressed sizes in bytes for compact JSON with Brotli quality ${brotli.quality} in ${brotli.mode} mode. Both encodings expand to the same Score IR in every row.`,
  "",
  "| Movement | Event stream (B) | Rhythm templates (B) | Transposed fragments (B) |",
  "| --- | ---: | ---: | ---: |",
  ...scores.map(({ bwv, title, sizes: { eventStream, rhythmEncoding, transposedEncoding } }) =>
    `| BWV ${bwv} ${title} | ${eventStream.brotliBytes} | ${rhythmEncoding.brotliBytes} | ${transposedEncoding.brotliBytes} |`,
  ),
  "",
].join("\n");
writeOutput(new URL("compression.md", target), comparisonTable);
