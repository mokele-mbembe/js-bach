import assert from "node:assert/strict";
import { test } from "node:test";
import { createPianoRollPalette } from "../demo/piano-roll.js";

test("the piano roll keeps distinct named and fallback colors separate from the playhead", () => {
  const named = {
    soprano: "#ffc778", alto: "#98e4b8", tenor: "#9acbff", baritone: "#c6b4ff", bass: "#efaed8",
  };
  const voiceIds = [...Object.keys(named), "mezzo", "upper", "lower", "middle", "inner", "outer"];
  const color = createPianoRollPalette(voiceIds);
  assert.deepEqual(Object.fromEntries(Object.keys(named).map((id) => [id, color(id)])), named);
  const colors = new Set(voiceIds.map(color));
  assert.equal(colors.size, voiceIds.length);
  assert.ok(!colors.has("#f5f5eb"));
});
