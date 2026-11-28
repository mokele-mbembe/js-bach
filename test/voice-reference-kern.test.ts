import assert from "node:assert/strict";
import { test } from "node:test";
import { readKernVoices } from "../scripts/voice-reference-kern.js";

test("**kern reads independent spines, dotted durations, and all written tie segments", () => {
  const score = [
    "!!!OTL: Two-voice fixture",
    "**kern\t**kern",
    "*staff2\t*staff1",
    "!lower line\t!upper line",
    "=1\t=1",
    "[2C\t4g",
    ".\t4a-",
    "=2\t=2",
    "4C_\t4r",
    "4C]\t4.b-;M",
    "8BB#\t.",
    "==\t==",
    "*-\t*-",
    "!! End of fixture",
  ].join("\r\n");
  const { notes, ticksPerQuarter } = readKernVoices(score, { "2": "soprano", "1": "bass" });
  assert.equal(ticksPerQuarter, 256);
  assert.deepEqual(notes, [
    { voiceId: "bass", tick: 0, durationTicks: 512, midiPitch: 48, tieStart: true, tieStop: false },
    { voiceId: "soprano", tick: 0, durationTicks: 256, midiPitch: 67, tieStart: false, tieStop: false },
    { voiceId: "soprano", tick: 256, durationTicks: 256, midiPitch: 68, tieStart: false, tieStop: false },
    { voiceId: "bass", tick: 512, durationTicks: 256, midiPitch: 48, tieStart: true, tieStop: true },
    { voiceId: "bass", tick: 768, durationTicks: 256, midiPitch: 48, tieStart: false, tieStop: true },
    { voiceId: "soprano", tick: 768, durationTicks: 384, midiPitch: 70, tieStart: false, tieStop: false },
    { voiceId: "bass", tick: 1024, durationTicks: 128, midiPitch: 48, tieStart: false, tieStop: false },
  ]);
  assert.deepEqual(readKernVoices(score, { "2": "soprano" }).notes, notes.filter(({ voiceId }) => voiceId === "soprano"));
});

test("**kern rejects topology changes and chords even in unselected spines", () => {
  const header = "**kern\t**kern\n4c\t4G\n";
  const voices = { "1": "soprano" };
  for (const operation of ["*^", "*v", "*x", "*+", "*-"]) {
    assert.throws(() => readKernVoices(`${header}*\t${operation}`, voices), {
      message: `**kern line 3: unsupported spine path ${operation}`,
    });
  }
  assert.throws(() => readKernVoices(`${header}4d\t4A 4AA\n*-\t*-`, voices), /line 3: unsupported chord or whitespace in spine 2/u);
  assert.throws(() => readKernVoices(`${header}*\t*strophe`, voices), /line 3: unsupported interpretation "\*strophe"/u);
});

test("**kern rejects rows that cannot establish exact timing or a complete score", () => {
  const voices = { "1": "soprano", "2": "bass" };
  const score = (rows: string) => `**kern\t**kern\n${rows}\n*-\t*-`;
  assert.throws(() => readKernVoices(score("2c\t4G\n4d\t4A"), voices), /line 3: event overlaps an active note or rest in spine 1/u);
  assert.throws(() => readKernVoices(score("4c\t2G\n.\t4A"), voices), /line 3: null token has no active note or rest/u);
  assert.throws(() => readKernVoices(score("4c\t2G\n=2\t=2"), voices), /line 3: barline interrupts/u);
  assert.throws(() => readKernVoices(score("3c\t3G"), voices), /unsupported duration in spine 1/u);
  assert.throws(() => readKernVoices(score("4c\tGq"), voices), /unsupported note or rest in spine 2/u);
  assert.throws(() => readKernVoices(score("4c\t4G\t4e"), voices), /expected 2 spine columns, found 3/u);
  assert.throws(() => readKernVoices("**kern\t**kern\n4c\t4G", voices), /complete \*\*kern spine header and termination/u);
});

test("**kern rejects broken ties, unsupported spine layouts, and invalid column mappings", () => {
  const voices = { "1": "soprano" };
  assert.throws(() => readKernVoices("**kern\n[4c\n4d]\n*-", voices), /invalid tie continuation/u);
  assert.throws(() => readKernVoices("**kern\n[4c\n4c\n*-", voices), /invalid tie continuation/u);
  assert.throws(() => readKernVoices("**kern\n4c_\n*-", voices), /invalid tie continuation/u);
  assert.throws(() => readKernVoices("**kern\n[4c\n*-", voices), /unfinished note, rest, or tie/u);
  assert.throws(() => readKernVoices("**kern\n[4r\n*-", voices), /invalid accidental or tie on rest/u);
  assert.throws(() => readKernVoices("**kern\t**text\n4c\ttext\n*-\t*-", voices), /expected a header of \*\*kern spines/u);
  assert.throws(() => readKernVoices("**kern\n4c\n*-", { "2": "soprano" }), /outside the \*\*kern header/u);
  assert.throws(() => readKernVoices("**kern\n4c\n*-", { "01": "soprano" }), /1-based column/u);
});
