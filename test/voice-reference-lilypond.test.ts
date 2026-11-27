import assert from "node:assert/strict";
import { test } from "node:test";
import { readLilyPondVoices } from "../scripts/voice-reference-lilypond.js";

test("LilyPond reference reader preserves written ties and handles Italian pitch and layout syntax", () => {
  const reference = readLilyPondVoices(String.raw`
    \include "italiano.ly"
    staffLow = \change Staff = two
    offStaff = { \staffLow \voiceOne }
    voice = \relative do' \context Staff = "one" \new Voice {
      \voiceThree s4*2 \offStaff dod 4 sib\rest | % pitched rest
      lad2. ~ lad4 |
    }
  `, { voice: "tenor" });
  const q = reference.ticksPerQuarter;
  assert.deepEqual(reference.notes, [
    { voiceId: "tenor", tick: 2 * q, durationTicks: q, midiPitch: 61 },
    { voiceId: "tenor", tick: 4 * q, durationTicks: 3 * q, midiPitch: 58 },
    { voiceId: "tenor", tick: 7 * q, durationTicks: q, midiPitch: 58 },
  ]);
});

test("LilyPond reference reader tracks Dutch accidentals and the meter of the selected voice", () => {
  const reference = readLilyPondVoices(String.raw`
    global = { \key as \minor \time 3/4 }
    line = \relative c' {
      \global es4 ges8 f des4~ | \clef treble des2 r4 \bar "|." |
    }
  `, { line: "alto" });
  const q = reference.ticksPerQuarter;
  assert.deepEqual(reference.notes.map(({ tick, midiPitch, durationTicks }) => [tick / q, midiPitch, durationTicks / q]), [
    [0, 63, 1], [1, 66, 0.5], [1.5, 65, 0.5], [2, 61, 1], [3, 61, 2],
  ]);
});

test("LilyPond reference reader rejects unsupported transformations and non-layout aliases", () => {
  assert.throws(() => readLilyPondVoices(String.raw`line = \relative c' { \transpose c d e4 }`, { line: "alto" }), /transpose/u);
  assert.throws(() => readLilyPondVoices(String.raw`
    voiceOne = { c4 }
    line = \relative c' { \voiceOne d4 }
  `, { line: "alto" }), /voiceOne/u);
  assert.throws(() => readLilyPondVoices(String.raw`
    global = { \time 4/4 c'4 }
    line = \relative c' { \global d4 }
  `, { line: "alto" }), /global/u);
  assert.throws(() => readLilyPondVoices(String.raw`line = \relative c' { c4 | }`, { line: "alto" }), /bar check/u);
});
