import assert from "node:assert/strict";
import { test } from "node:test";
import { movements, readCorpusFile, readMovementScore } from "../scripts/corpus.js";
import { importMxl } from "../src/import-mxl.js";
import { toPerformance } from "../src/performance.js";
import { encodeRhythmTemplates, expandRhythmTemplates } from "../src/rhythm-templates.js";

for (const movement of movements) {
  test(`${movement.id} expands from JSON to the original Score IR field for field`, () => {
    const original = readMovementScore(movement);
    const encoded = encodeRhythmTemplates(original);
    assert.deepEqual(expandRhythmTemplates(encoded), original);

    const expanded = expandRhythmTemplates(JSON.parse(JSON.stringify(encoded)));
    assert.deepEqual(expanded, JSON.parse(JSON.stringify(original)));
    assert.deepEqual(toPerformance(expanded), toPerformance(original));
  });
}

test("the Prelude shares two rhythm templates while keeping the written pitches per measure", () => {
  const prelude = movements.find(({ id }) => id === "bwv846-prelude");
  assert.ok(prelude);
  const original = importMxl(readCorpusFile(prelude.score));
  const encoded = encodeRhythmTemplates(original);
  assert.equal(encoded.rhythmTemplates?.length, 2);
  assert.deepEqual(encoded.measures.map((measure) => "templateId" in measure ? measure.templateId : null), [
    ...Array(32).fill(0), 1, 1, null,
  ]);

  const [first, second] = encoded.measures;
  assert.ok("pitches" in first && "pitches" in second);
  assert.notDeepEqual(first.pitches, second.pitches);
  const pitches = original.measures[1].events.flatMap((event) => event.kind === "note" ? [event.pitch] : []);
  assert.deepEqual(second.pitches, pitches);

  const missingPitch = { ...first, pitches: first.pitches.slice(1) };
  assert.throws(() => expandRhythmTemplates({ ...encoded, measures: [missingPitch] }), /Missing pitch.*measure 1/);
});

test("the Fugue uses the event stream without an empty template dictionary", () => {
  const fugue = movements.find(({ id }) => id === "bwv846-fugue");
  assert.ok(fugue);
  const original = importMxl(readCorpusFile(fugue.score));
  const encoded = encodeRhythmTemplates(original);
  assert.equal(JSON.stringify(encoded), JSON.stringify(original));
});
