import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { encodeRhythmTemplates, expandRhythmTemplates } from "../src/rhythm-templates.js";
import { encodeTransposedFragments, expandTransposedFragments } from "../src/transposed-fragments.js";
import { currentCorpus, publishCorpus } from "./corpus-output.js";
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

const previous = fresh ? undefined : currentCorpus();
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

  const cacheKey = sha256(encoderFingerprint + eventJson);
  const cached = previous && readCachedTransposition(new URL(`bwv${bwv}/`, previous), id, cacheKey);
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

const published = publishCorpus((target) => {
  for (const { bwv, manifest } of works) {
    const directory = new URL(`bwv${bwv}/`, target);
    mkdirSync(directory);
    writeFileSync(new URL("sources.json", directory), manifest);
    const workScores = scores.filter((score) => score.bwv === bwv);
    for (const { id, original, rhythmJson, transposedJson, cacheKey } of workScores) {
      writeFileSync(new URL(`${id}.json`, directory), `${JSON.stringify(original, null, 2)}\n`);
      writeFileSync(new URL(`${id}.rhythm.json`, directory), rhythmJson);
      writeFileSync(new URL(`${id}.transposed.json`, directory), transposedJson);
      writeFileSync(new URL(`.${id}.transposed.cache`, directory), `${cacheKey} ${sha256(transposedJson)}\n`);
    }
    writeFileSync(new URL("compression.json", directory), `${JSON.stringify({
      brotli,
      movements: Object.fromEntries(workScores.map(({ id, sizes }) => [id, sizes])),
    }, null, 2)}\n`);
  }
  writeFileSync(new URL("catalog.json", target), `${JSON.stringify({ works: works.map(({ bwv, key }) => ({ bwv, key })) })}\n`);
  writeFileSync(new URL("compression.md", target), comparisonTable);
});
console.log(`Published Brotli report at ${fileURLToPath(new URL("compression.md", published))}`);
