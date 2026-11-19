import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { encodeRhythmTemplates, expandRhythmTemplates } from "../src/rhythm-templates.js";
import { encodeTransposedFragments, expandTransposedFragments } from "../src/transposed-fragments.js";
import { movements, readMovementScore, works } from "./corpus.js";

const brotli = {
  quality: 11,
  mode: "text",
};

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

  const transposedJson = JSON.stringify(encodeTransposedFragments(original, brotliBytes));
  assert.deepEqual(expandTransposedFragments(JSON.parse(transposedJson)), eventData, `${id} changed during fragment expansion`);
  const comparison = {
    eventStream: sizes(eventJson),
    rhythmEncoding: sizes(rhythmJson),
    transposedEncoding: sizes(transposedJson),
  };
  console.log(`${id} — ${original.measures.length} measures verified, Brotli event stream ${comparison.eventStream.brotliBytes} B, rhythm ${comparison.rhythmEncoding.brotliBytes} B, transposition ${comparison.transposedEncoding.brotliBytes} B`);
  return { id, bwv, title, original, rhythmJson, transposedJson, sizes: comparison };
});

for (const { bwv, manifestFile } of works) {
  const directory = new URL(`bwv${bwv}/`, target);
  mkdirSync(directory, { recursive: true });
  copyFileSync(manifestFile, new URL("sources.json", directory));
  const workScores = scores.filter((score) => score.bwv === bwv);
  for (const { id, original, rhythmJson, transposedJson } of workScores) {
    writeFileSync(new URL(`${id}.json`, directory), `${JSON.stringify(original, null, 2)}\n`);
    writeFileSync(new URL(`${id}.rhythm.json`, directory), rhythmJson);
    writeFileSync(new URL(`${id}.transposed.json`, directory), transposedJson);
  }
  writeFileSync(new URL("compression.json", directory), `${JSON.stringify({
    brotli,
    movements: Object.fromEntries(workScores.map(({ id, sizes }) => [id, sizes])),
  }, null, 2)}\n`);
}
writeFileSync(new URL("catalog.json", target), `${JSON.stringify({ works: works.map(({ bwv, key }) => ({ bwv, key })) })}\n`);

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
writeFileSync(new URL("compression.md", target), comparisonTable);
