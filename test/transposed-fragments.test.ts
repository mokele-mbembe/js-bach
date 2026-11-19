import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliCompressSync, constants } from "node:zlib";
import { movements, readCorpusFile } from "../scripts/corpus.js";
import { importMxl } from "../src/import-mxl.js";
import { toPerformance } from "../src/performance.js";
import type { NoteEvent, ScoreIR, WrittenPitch } from "../src/score-ir.js";
import { encodeTransposedFragments, expandTransposedFragments } from "../src/transposed-fragments.js";

test("the Fugue reuses nonoverlapping transposed fragments and expands field for field", () => {
  const fugue = movements.find(({ id }) => id === "bwv846-fugue");
  assert.ok(fugue);
  const original = { sourceId: fugue.id, ...importMxl(readCorpusFile(fugue.score)) };
  const baseline = JSON.stringify(original);
  const brotli = (json: string) => brotliCompressSync(json, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  }).length;
  const encoded = encodeTransposedFragments(original, brotli);
  const json = JSON.stringify(encoded);
  assert.ok(brotli(json) < brotli(baseline));
  assert.equal(JSON.stringify(original), baseline);
  assert.deepEqual(expandTransposedFragments(encoded), original);
  const expanded = expandTransposedFragments(JSON.parse(json));
  assert.deepEqual(expanded, JSON.parse(baseline));
  assert.deepEqual(toPerformance(expanded), toPerformance(original));

  const groups = encoded.transposedFragments;
  assert.ok(groups?.length);
  assert.ok(groups.some(([, occurrences]) => new Set(occurrences.map(([voice]) => voice)).size > 1));
  const claimed = new Set<number>();
  let crossesBarline = false;
  for (const [notes, occurrences] of groups) {
    assert.ok(new Set(occurrences.map((occurrence) => occurrence[4])).size > 1);
    for (const [, , start, , , slots] of occurrences) {
      const measure = original.measures.find(({ startTick, durationTicks }) => start >= startTick && start < startTick + durationTicks);
      assert.ok(measure);
      if (notes.some(([offset]) => start + offset >= measure.startTick + measure.durationTicks)) crossesBarline = true;
      let slot = 0;
      for (const delta of slots) {
        slot += delta;
        assert.equal(claimed.has(slot), false);
        claimed.add(slot);
      }
    }
  }
  assert.ok(crossesBarline);
});

test("matching respects enharmonic spelling and keeps interleaved rests and staff changes", () => {
  const pitches: WrittenPitch[][] = [
    [{ step: "C", octave: 4, alter: 1 }, { step: "D", octave: 4, alter: 0 }, { step: "E", octave: 4, alter: 0 }, { step: "F", octave: 4, alter: 1 }],
    [{ step: "G", octave: 4, alter: 1 }, { step: "A", octave: 4, alter: 0 }, { step: "B", octave: 4, alter: 0 }, { step: "C", octave: 5, alter: 1 }],
    [{ step: "G", octave: 4, alter: 1 }, { step: "A", octave: 4, alter: 0 }, { step: "B", octave: 4, alter: 0 }, { step: "D", octave: 5, alter: -1 }],
  ];
  const score: ScoreIR = {
    partId: "piano", ticksPerQuarter: 1, tempoChanges: [],
    measures: [0, 1].map((measure) => ({
      number: String(measure + 1), startTick: 2 * measure, durationTicks: 2,
      events: [
        { kind: "rest", voice: "rest", staff: 1, offsetTicks: 0, durationTicks: 2, notations: [] },
        ...pitches.flatMap((voicePitches, voice) => voicePitches.slice(2 * measure, 2 * measure + 2).map((pitch, offsetTicks): NoteEvent => ({
          kind: "note", pitch, offsetTicks, voice: String(voice), staff: 1 + voice + measure,
          durationTicks: 1, tieStart: false, tieStop: false, notations: [],
        }))),
      ],
    })),
  };
  const encoded = encodeTransposedFragments(score, (json) => Buffer.byteLength(json));
  assert.deepEqual(encoded.transposedFragments?.map(([, occurrences]) => occurrences.map(([voice]) => voice)), [["0", "1"]]);
  assert.deepEqual(expandTransposedFragments(encoded), score);
  assert.deepEqual(encodeTransposedFragments(score, () => 0), score);
});
