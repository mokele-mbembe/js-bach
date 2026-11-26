import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const fresh = args.length === 1 && args[0] === "--fresh";
const cacheDirectory = args.length === 2 && args[0] === "--cache-dir" && args[1] && !args[1].startsWith("--")
  ? pathToFileURL(resolve(args[1]) + sep) : undefined;
assert.ok(args.length === 0 || fresh || cacheDirectory, "Usage: npm run build:corpus -- [--fresh | --cache-dir <directory>]");

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Include the search, its dependencies and the exact Brotli runner used to rank candidates.
const encoderFiles = [import.meta.url, "../src/transposed-fragments.js", "../src/score-ir.js"];
const encoderFingerprint = sha256(JSON.stringify([
  brotli, process.version, process.versions.brotli, process.platform, process.arch,
  ...encoderFiles.map((file) => readFileSync(new URL(file, import.meta.url), "utf8")),
]));

function verifyTransposition(json: string, original: unknown, id: string): TransposedScore {
  const transposed: TransposedScore = JSON.parse(json);
  assert.deepEqual(expandTransposedFragments(transposed), original, `${id} changed during fragment expansion`);
  return transposed;
}

function readCachedTransposition(file: URL, key: string, original: unknown, id: string) {
  let cache: string;
  try {
    cache = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
  const headerEnd = cache.indexOf("\n");
  if (headerEnd < 0) return undefined;
  const header = /^([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(cache.slice(0, headerEnd));
  if (header?.[1] !== key) return undefined;
  const json = cache.slice(headerEnd + 1);
  if (sha256(json) !== header[2]) return undefined;
  try {
    return { json, transposed: verifyTransposition(json, original, id) };
  } catch {
    // A matching checksum alone does not make a cached codec payload usable.
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

const previous = cacheDirectory ?? (fresh ? undefined : currentCorpus());
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
  const eventData: unknown = JSON.parse(eventJson);
  const rhythm = encodeRhythmTemplates(original);
  const rhythmJson = JSON.stringify(rhythm);
  assert.deepEqual(expandRhythmTemplates(JSON.parse(rhythmJson)), eventData, `${id} changed during rhythm expansion`);

  const cacheKey = sha256(encoderFingerprint + eventJson);
  const cached = previous && readCachedTransposition(new URL(`bwv${bwv}/.${id}.transposed.cache`, previous), cacheKey, eventData, id);
  const transposedJson = cached?.json ?? JSON.stringify(encodeTransposedFragments(original, brotliBytes));
  const transposed = cached?.transposed ?? verifyTransposition(transposedJson, eventData, id);
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
  const cacheRecord = `${cacheKey} ${sha256(transposedJson)}\n${transposedJson}`;
  return { id, bwv, title, playbackJson, cacheRecord, cacheHit: cached !== undefined, sizes: comparison };
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
    for (const { id, playbackJson, cacheRecord } of scores.filter((score) => score.bwv === bwv)) {
      writeFileSync(new URL(`${id}.playback.json`, directory), playbackJson);
      writeFileSync(new URL(`.${id}.transposed.cache`, directory), cacheRecord);
    }
  }
  writeFileSync(new URL("catalog.json", target), `${JSON.stringify({ works: works.map(({ bwv, key }) => ({ bwv, key })) })}\n`);
  writeFileSync(new URL("compression.md", target), comparisonTable);
});

if (cacheDirectory) {
  for (const { id, bwv, cacheRecord, cacheHit } of scores) {
    if (cacheHit) continue;
    const directory = new URL(`bwv${bwv}/`, cacheDirectory);
    const file = new URL(`.${id}.transposed.cache`, directory);
    const pending = new URL(`.${id}-${randomUUID()}.tmp`, directory);
    mkdirSync(directory, { recursive: true });
    try {
      // Share only records from a validated build and never expose partially written bytes.
      writeFileSync(pending, cacheRecord, { flag: "wx" });
      renameSync(pending, file);
    } finally {
      rmSync(pending, { force: true });
    }
  }
}

console.log(`Transposition search cache: ${scores.filter(({ cacheHit }) => cacheHit).length}/${scores.length} hits`);
console.log(`Published Brotli report at ${fileURLToPath(new URL("compression.md", published))}`);
