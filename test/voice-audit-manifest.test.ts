import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkManifest } from "../scripts/audit-voices.js";
import { movements, readMovementScore } from "../scripts/corpus.js";
import { sliceScore } from "../scripts/score-slice.js";
import { auditVoiceAssignments, type ScoreVoiceNote } from "../scripts/voice-audit-matcher.js";
import { midiPitch } from "../src/score-ir.js";

test("the BWV 875 fugue audit does not use the prelude engraving", () => {
  const prelude = movements.find(({ id }) => id === "bwv875-prelude");
  assert.ok(prelude?.referenceMidi.engraving);
  const cli = fileURLToPath(new URL("../scripts/audit-voices.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "bwv875-fugue"], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No reference configured for bwv875-fugue\. Supply --reference <config\.json>\./u);
  assert.equal(result.stdout, "");
});

test("the BWV 849 audit detects a wrong note override even when playback still compiles", () => {
  const movement = movements.find(({ id }) => id === "bwv849-fugue");
  assert.ok(movement);
  const score = sliceScore(readMovementScore(movement), [0, 2], movement.id);
  const ticksPerQuarter = 256;
  const scale = ticksPerQuarter / score.ticksPerQuarter;
  const written: ScoreVoiceNote[] = score.measures.flatMap(({ number, startTick, events }) =>
    events.flatMap((event) => event.kind === "note" && !event.grace && event.durationTicks > 0
      ? [{
        measure: number, scoreVoice: event.voice, midiPitch: midiPitch(event.pitch),
        tick: (startTick + event.offsetTicks) * scale, durationTicks: event.durationTicks * scale,
        tieStart: event.tieStart, tieStop: event.tieStop,
      }] : []));
  // The opening three Bass notes from the pinned Mutopia engraving.
  const reference = [
    { tick: 0, midiPitch: 49, durationTicks: 1024 },
    { tick: 1024, midiPitch: 48, durationTicks: 512 },
    { tick: 1536, midiPitch: 52, durationTicks: 512 },
  ].map((note) => ({ ...note, voiceId: "bass", tieStart: false, tieStop: false }));
  const audit = auditVoiceAssignments(written, reference);
  const baseline = checkManifest(movement, score, ticksPerQuarter, reference, audit);
  assert.deepEqual(baseline, {
    checked: 3, conflicts: [], scoreSegments: 3, referenceSegments: 3, segmentCountsMatch: true,
    playback: { status: "passed", performedNotes: 3 },
  });

  const wrong = checkManifest({
    ...movement,
    noteOverrides: [{ measure: "2", offsetTicks: 4, scoreVoice: "5", midiPitch: 52, voiceId: "soprano" }],
  }, score, ticksPerQuarter, reference, audit);
  assert.deepEqual(wrong.conflicts.map(({ measure, scoreVoice, tick, midiPitch, voiceId }) =>
    ({ measure, scoreVoice, tick, midiPitch, voiceId })), [
    { measure: "2", scoreVoice: "5", tick: 1536, midiPitch: 52, voiceId: "bass" },
  ]);
  assert.equal(wrong.segmentCountsMatch, false);
  assert.deepEqual(wrong.playback, baseline.playback);

  const repaired = checkManifest({
    ...movement,
    voiceOverrides: [{ scoreVoice: "5", measures: ["1"], voiceId: "soprano" }],
    noteOverrides: [{ measure: "1", offsetTicks: 0, scoreVoice: "5", midiPitch: 49, voiceId: "bass" }],
  }, score, ticksPerQuarter, reference, audit);
  assert.deepEqual(repaired, baseline);
});
