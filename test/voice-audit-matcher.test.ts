import assert from "node:assert/strict";
import { test } from "node:test";
import { auditVoiceAssignments, type ReferenceVoiceNote, type ScoreVoiceNote } from "../scripts/voice-audit-matcher.js";

function score(tick: number, scoreVoice: string, measure = "1", durationTicks = 1): ScoreVoiceNote {
  return { tick, durationTicks, midiPitch: 60, scoreVoice, measure };
}

function reference(tick: number, voiceId: string, durationTicks = 1): ReferenceVoiceNote {
  return { tick, durationTicks, midiPitch: 60, voiceId };
}

test("preserves multiplicity and reports duration differences separately", () => {
  const sameSpan = score(0, "1");
  const audit = auditVoiceAssignments([sameSpan, sameSpan, score(1, "1", "1", 2)], [reference(0, "alto"), reference(1, "alto")]);
  assert.equal(audit.scope, "incomplete");
  assert.deepEqual(audit.assignments, []);
  assert.deepEqual(audit.differences.map(({ tick, durationTicks, scoreNotes, referenceNotes }) =>
    [tick, durationTicks, scoreNotes.length, referenceNotes.length],
  ), [[0, 1, 2, 1], [1, 2, 1, 0], [1, 1, 0, 1]]);
});

test("resolves simultaneous unisons with direct evidence and reference multiplicity", () => {
  const audit = auditVoiceAssignments([
    score(0, "1"), score(1, "2"), score(2, "1", "2"), score(2, "2", "2"), score(2, "3", "2"),
  ], [reference(0, "alto"), reference(1, "tenor"), reference(2, "alto"), reference(2, "tenor"), reference(2, "tenor")]);
  assert.equal(audit.scope, "global");
  assert.deepEqual(audit.assignments.filter(({ tick }) => tick === 2).map(({ scoreVoice, voiceId, evidence }) => [scoreVoice, voiceId, evidence]), [
    ["1", "alto", "context"], ["2", "tenor", "context"], ["3", "tenor", "context"],
  ]);
});

test("keeps unisons unresolved when evidence is missing or exceeds a voice's multiplicity", () => {
  const audit = auditVoiceAssignments([
    score(0, "1"), score(1, "2"), score(2, "3"), score(2, "4"), score(3, "1"), score(3, "2"),
  ], [reference(0, "alto"), reference(1, "alto"), reference(2, "alto"), reference(2, "tenor"), reference(3, "alto"), reference(3, "tenor")]);
  assert.equal(audit.scope, "incomplete");
  assert.equal(audit.assignments.length, 2);
  assert.deepEqual(audit.ambiguities.map(({ reason, scoreNotes, referenceNotes }) => [reason, scoreNotes.length, referenceNotes.length]), [
    ["underdetermined", 2, 2], ["conflicting-evidence", 2, 2],
  ]);
});

test("distinguishes measure overrides from conflicting assignments within one measure", () => {
  const referenceNotes = [reference(0, "alto"), reference(1, "tenor"), reference(2, "tenor"), reference(2, "bass")];
  const notes = [score(0, "6"), score(1, "6", "2"), score(2, "6", "2"), score(2, "7", "2")];
  const audit = auditVoiceAssignments(notes, referenceNotes);
  assert.equal(audit.scope, "measure");
  assert.deepEqual(audit.scoreVoices.find(({ scoreVoice }) => scoreVoice === "6")?.measures, [
    { measure: "1", voices: [{ voiceId: "alto", count: 1 }] },
    { measure: "2", voices: [{ voiceId: "tenor", count: 2 }] },
  ]);
  const sameMeasureNotes = [score(0, "6"), score(1, "6"), score(2, "7")];
  const sameMeasureReference = [reference(0, "alto"), reference(1, "tenor"), reference(2, "bass")];
  assert.equal(auditVoiceAssignments(sameMeasureNotes, sameMeasureReference).scope, "within-measure");
  const partial = auditVoiceAssignments(sameMeasureNotes, sameMeasureReference.slice(0, 2));
  assert.equal(partial.scope, "incomplete");
  assert.equal(partial.scoreVoices[0].measures[0].voices.length, 2);
});
