import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { toPerformance } from "../src/performance.js";
import { decodePlayback, type PlaybackAsset } from "../src/playback-asset.js";
import { encodeRhythmTemplates, expandRhythmTemplates } from "../src/rhythm-templates.js";
import { encodeTransposedFragments, expandTransposedFragments, type TransposedScore } from "../src/transposed-fragments.js";
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
    const cache = readFileSync(new URL(`.${id}.transposed.cache`, directory), "utf8");
    const headerEnd = cache.indexOf("\n");
    if (headerEnd < 0) return undefined;
    const [inputHash, outputHash] = cache.slice(0, headerEnd).split(" ");
    if (inputHash !== key) return undefined;
    const json = cache.slice(headerEnd + 1);
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
const catalog = new Map(works.map(({ bwv, key, composer, collection }) => [bwv, { bwv, key, composer, collection }]));
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
  const rhythm = encodeRhythmTemplates(original);
  const rhythmJson = JSON.stringify(rhythm);
  assert.deepEqual(expandRhythmTemplates(JSON.parse(rhythmJson)), eventData, `${id} changed during rhythm expansion`);

  const cacheKey = sha256(encoderFingerprint + eventJson);
  const cached = previous && readCachedTransposition(new URL(`bwv${bwv}/`, previous), id, cacheKey);
  const transposedJson = cached ?? JSON.stringify(encodeTransposedFragments(original, brotliBytes));
  const transposed: TransposedScore = JSON.parse(transposedJson);
  assert.deepEqual(expandTransposedFragments(transposed), eventData, `${id} changed during fragment expansion`);
  const comparison = {
    eventStream: sizes(eventJson),
    rhythmEncoding: sizes(rhythmJson),
    transposedEncoding: sizes(transposedJson),
  };

  const work = catalog.get(bwv);
  assert.ok(work, `Missing catalog entry for BWV ${bwv}`);
  const { durationSeconds, notes } = toPerformance(original);
  const voiceIds = [...new Set(notes.map((note) => note.voice))];
  const { kind, key, voices } = movement;
  const { edition, source, license, licenseUrl, upstream } = input;
  const midi = movement.referenceMidi;
  const fragments = transposed.transposedFragments ?? [];
  const playback: PlaybackAsset = {
    work,
    source: {
      id, kind, title, key, voices,
      score: {
        edition, source, license, licenseUrl, upstream, attribution: input.attribution,
        changes: `Converted from ${edition} MusicXML to js-bach playback data.`,
      },
      referenceMidi: { typesetter: midi.typesetter, edition: midi.edition, source: midi.source },
    },
    performance: {
      durationSeconds,
      voices: voiceIds,
      notes: notes.map(({ midiPitch, startSeconds, endSeconds, voice }) =>
        [midiPitch, startSeconds, endSeconds, voiceIds.indexOf(voice)]),
    },
    sizes: comparison,
    analysis: {
      rhythm: {
        templateCount: rhythm.rhythmTemplates?.length ?? 0,
        measures: rhythm.measures.map((measure) => "templateId" in measure
          ? [measure.number, measure.templateId] : [measure.number]),
      },
      transposed: {
        ticksPerQuarter: transposed.ticksPerQuarter,
        measures: fragments.length === 0 ? [] : transposed.measures.map(({ number, startTick, durationTicks }) =>
          [number, startTick, durationTicks]),
        fragments: fragments.map(([fragmentNotes, occurrences]) => [
          fragmentNotes.length,
          Math.max(...fragmentNotes.map(([offset, duration]) => offset + duration)),
          occurrences.map(([voice, , startTick, , pitch]) => [voice, startTick, pitch]),
        ]),
      },
    },
  };
  const playbackJson = JSON.stringify(playback);
  const decoded: PlaybackAsset = JSON.parse(playbackJson);
  assert.deepEqual(decodePlayback(decoded.performance), { durationSeconds, notes }, `${id} changed during playback packing`);
  console.log(`${id} — ${original.measures.length} measures verified, playback ${Buffer.byteLength(playbackJson, "utf8")} B, Brotli event stream ${comparison.eventStream.brotliBytes} B, rhythm ${comparison.rhythmEncoding.brotliBytes} B, transposition ${comparison.transposedEncoding.brotliBytes} B${cached === undefined ? "" : " (cached search)"}`);
  return { id, bwv, title, playbackJson, transposedJson, cacheKey, sizes: comparison };
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
    for (const { id, playbackJson, transposedJson, cacheKey } of scores.filter((score) => score.bwv === bwv)) {
      writeFileSync(new URL(`${id}.playback.json`, directory), playbackJson);
      writeFileSync(new URL(`.${id}.transposed.cache`, directory), `${cacheKey} ${sha256(transposedJson)}\n${transposedJson}`);
    }
  }
  writeFileSync(new URL("catalog.json", target), `${JSON.stringify({ works: works.map(({ bwv, key }) => ({ bwv, key })) })}\n`);
  writeFileSync(new URL("compression.md", target), comparisonTable);
});
console.log(`Published Brotli report at ${fileURLToPath(new URL("compression.md", published))}`);
