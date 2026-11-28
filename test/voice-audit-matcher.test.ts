import assert from "node:assert/strict";
import { test } from "node:test";
import { movements, readMovementScore } from "../scripts/corpus.js";
import { auditVoiceAssignments, type ReferenceVoiceNote, type ScoreVoiceNote } from "../scripts/voice-audit-matcher.js";
import { midiPitch } from "../src/score-ir.js";

function score(tick: number, scoreVoice: string, measure = "1", durationTicks = 1): ScoreVoiceNote {
  return { tick, durationTicks, midiPitch: 60, scoreVoice, measure, tieStart: false, tieStop: false };
}

function reference(tick: number, voiceId: string, durationTicks = 1): ReferenceVoiceNote {
  return { tick, durationTicks, midiPitch: 60, voiceId, tieStart: false, tieStop: false };
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

test("retains all unison candidates even when context suggests a unique assignment", () => {
  const audit = auditVoiceAssignments([
    score(0, "1"), score(1, "2"), score(2, "1", "2"), score(2, "2", "2"), score(2, "3", "2"),
  ], [reference(0, "alto"), reference(1, "tenor"), reference(2, "alto"), reference(2, "tenor"), reference(2, "tenor")]);
  assert.equal(audit.scope, "incomplete");
  assert.deepEqual(audit.differences, []);
  assert.equal(audit.assignments.length, 2);
  assert.deepEqual(audit.ambiguities, [{
    tick: 2, durationTicks: 1, midiPitch: 60, reason: "underdetermined",
    scoreNotes: [score(2, "1", "2"), score(2, "2", "2"), score(2, "3", "2")],
    referenceNotes: [reference(2, "alto"), reference(2, "tenor"), reference(2, "tenor")],
  }]);
});

test("BWV 867's seven audited unisons retain both candidates without a voice assignment", () => {
  const movement = movements.find(({ id }) => id === "bwv867-fugue");
  assert.ok(movement);
  const written = readMovementScore(movement);
  assert.equal(written.ticksPerQuarter, 4);

  // Untied unisons from the pinned Rother engraving, in the MusicXML tick grid.
  const unisons = [
    ["16", 4, 4, 54, ["6", "8"], ["tenor", "bass"]],
    ["33", 4, 4, 59, ["5", "6"], ["tenor", "bass"]],
    ["50", 8, 8, 70, ["1", "2"], ["soprano", "alto"]],
    ["51", 0, 8, 63, ["2", "5"], ["alto", "mezzo"]],
    ["68", 8, 8, 58, ["2", "5"], ["alto", "mezzo"]],
    ["69", 0, 8, 53, ["5", "8"], ["mezzo", "tenor"]],
    ["69", 8, 8, 46, ["5", "6"], ["tenor", "bass"]],
  ] as const;
  const groups = unisons.map(([measure, offsetTicks, durationTicks, pitch, scoreVoices, voiceIds]) => {
    const bar = written.measures.find(({ number }) => number === measure);
    assert.ok(bar, `measure ${measure}`);
    const span = { tick: bar.startTick + offsetTicks, durationTicks, midiPitch: pitch };
    const scoreNotes = bar.events.flatMap((event) => event.kind === "note" && !event.grace &&
      event.offsetTicks === offsetTicks && event.durationTicks === durationTicks && midiPitch(event.pitch) === pitch
      ? [{ ...span, measure, scoreVoice: event.voice, tieStart: event.tieStart, tieStop: event.tieStop }]
      : []);
    assert.deepEqual(scoreNotes.map(({ scoreVoice }) => scoreVoice).sort(), scoreVoices, `measure ${measure}, offset ${offsetTicks}`);
    const referenceNotes = voiceIds.map((voiceId) => ({ ...span, voiceId, tieStart: false, tieStop: false }));
    return { ...span, scoreNotes, referenceNotes };
  });
  const audit = auditVoiceAssignments(groups.flatMap(({ scoreNotes }) => scoreNotes), groups.flatMap(({ referenceNotes }) => referenceNotes));
  assert.equal(audit.scope, "incomplete");
  assert.deepEqual(audit.assignments, []);
  assert.deepEqual(audit.differences, []);
  assert.deepEqual(audit.tieDifferences, []);
  assert.deepEqual(audit.ambiguities, groups.map((group) => ({ ...group, reason: "underdetermined" })));
});

test("unison assignments follow ties when nearby direct matches suggest a different voice", () => {
  const audit = auditVoiceAssignments([
    { ...score(0, "1"), tieStart: true }, score(0, "2"),
    { ...score(1, "1"), tieStop: true }, score(1, "2"), score(2, "1"), score(3, "2"),
  ], [
    reference(0, "alto"), { ...reference(0, "tenor"), tieStart: true },
    reference(1, "alto"), { ...reference(1, "tenor"), tieStop: true }, reference(2, "alto"), reference(3, "tenor"),
  ]);
  assert.equal(audit.scope, "within-measure");
  assert.deepEqual(audit.ambiguities, []);
  assert.deepEqual(audit.assignments.map(({ tick, scoreVoice, voiceId, evidence, tieStart, tieStop }) =>
    [tick, scoreVoice, voiceId, evidence, tieStart, tieStop],
  ), [
    [0, "1", "tenor", "tie", true, false], [0, "2", "alto", "tie", false, false],
    [1, "1", "tenor", "tie", false, true], [1, "2", "alto", "tie", false, false],
    [2, "1", "alto", "exact", false, false], [3, "2", "tenor", "exact", false, false],
  ]);
});

test("assigns the tie-supported part of a unison and preserves remaining multiplicity", () => {
  const tied = { ...score(2, "3"), tieStop: true };
  const audit = auditVoiceAssignments([
    score(2, "1"), score(2, "2"), tied, tied,
  ], [reference(2, "alto"), reference(2, "tenor"),
    { ...reference(2, "bass"), tieStop: true }, { ...reference(2, "bass"), tieStop: true }]);
  assert.equal(audit.scope, "incomplete");
  assert.deepEqual(audit.assignments, Array(2).fill({ ...tied, evidence: "tie", voiceId: "bass" }));
  assert.deepEqual(audit.ambiguities.map(({ reason, scoreNotes, referenceNotes }) => [reason, scoreNotes.length, referenceNotes.length]), [
    ["underdetermined", 2, 2],
  ]);
});

test("reports incompatible tie multiplicities separately from exact note spans", () => {
  const scoreNotes = [{ ...score(0, "1"), tieStart: true }, { ...score(0, "2"), tieStart: true }];
  const referenceNotes = [reference(0, "alto"), { ...reference(0, "tenor"), tieStart: true }];
  const audit = auditVoiceAssignments(scoreNotes, referenceNotes);
  const bucket = { tick: 0, durationTicks: 1, midiPitch: 60, scoreNotes, referenceNotes };
  assert.deepEqual(audit.differences, []);
  assert.deepEqual(audit.tieDifferences, [bucket]);
  assert.deepEqual(audit.assignments, []);
  assert.deepEqual(audit.ambiguities, [{ ...bucket, reason: "tie-evidence-conflict" }]);

  const unique = auditVoiceAssignments([scoreNotes[0]], [referenceNotes[0]]);
  assert.equal(unique.scope, "global");
  assert.equal(unique.assignments[0].voiceId, "alto");
  assert.equal(unique.tieDifferences.length, 1);
});

test("distinguishes measure overrides from conflicting assignments within one measure", () => {
  const referenceNotes = [reference(0, "alto"), reference(1, "tenor"), reference(2, "tenor"), reference(3, "bass")];
  const notes = [score(0, "6"), score(1, "6", "2"), score(2, "6", "2"), score(3, "7", "2")];
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
