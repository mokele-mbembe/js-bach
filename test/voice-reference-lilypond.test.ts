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
    { voiceId: "tenor", tick: 2 * q, durationTicks: q, midiPitch: 61, tieStart: false, tieStop: false },
    { voiceId: "tenor", tick: 4 * q, durationTicks: 3 * q, midiPitch: 58, tieStart: true, tieStop: false },
    { voiceId: "tenor", tick: 7 * q, durationTicks: q, midiPitch: 58, tieStart: false, tieStop: true },
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
  assert.deepEqual(reference.notes.map(({ tick, midiPitch, durationTicks, tieStart, tieStop }) =>
    [tick / q, midiPitch, durationTicks / q, tieStart, tieStop]), [
    [0, 63, 1, false, false], [1, 66, 0.5, false, false], [1.5, 65, 0.5, false, false],
    [2, 61, 1, true, false], [3, 61, 2, false, true],
  ]);
});

test("LilyPond reference reader rejects German pitch names before interpreting an ambiguous b", () => {
  const line = String.raw`alto = \relative c' { b4 }`;
  const voices = { alto: "alto" };
  assert.deepEqual(readLilyPondVoices(line, voices).notes.map(({ midiPitch }) => midiPitch), [59]);
  const german = String.raw`\include "deutsch.ly"` + "\n" + line;
  assert.throws(() => readLilyPondVoices(german, voices), /Unsupported LilyPond pitch language or include: deutsch/u);
});

test("LilyPond reference reader preserves both directions of a tie chain", () => {
  const reference = readLilyPondVoices(String.raw`line = \relative c' { c4 ~ c ~ c c }`, { line: "alto" });
  assert.deepEqual(reference.notes.map(({ tieStart, tieStop }) => [tieStart, tieStop]), [
    [true, false], [true, true], [false, true], [false, false],
  ]);
  assert.throws(() => readLilyPondVoices(String.raw`line = \relative c' { c4 ~ r c }`, { line: "alto" }), /tie followed by rest/u);
  assert.throws(() => readLilyPondVoices(String.raw`line = \relative c' { c4 ~ d }`, { line: "alto" }), /tie to a different pitch/u);
});

test("LilyPond reference reader inherits the effective duration of multiplied rests and skips", () => {
  const reference = readLilyPondVoices(String.raw`line = \relative c' { r4*2 c | R1*2 d s8.*2 e f4 g }`, { line: "alto" });
  const q = reference.ticksPerQuarter;
  assert.deepEqual(reference.notes.map(({ tick, durationTicks }) => [tick / q, durationTicks / q]), [
    [2, 2], [12, 8], [21.5, 1.5], [23, 1], [24, 1],
  ]);
});

test("LilyPond reference reader rejects shadowed definitions with flexible declaration spacing", () => {
  const voice = String.raw`line = \relative c' { \voiceOne d4 }`;
  for (const override of [
    "voiceOne =\n{ c4 }",
    '"voiceOne" = { c4 }',
    "other = { r4 } voiceOne = { c4 }",
  ]) {
    assert.throws(() => readLilyPondVoices(`${override}\n${voice}`, { line: "alto" }), /voiceOne/u);
  }
  for (const duplicate of [
    "line =\n{ c4 }",
    '"line" = { c4 }',
    "other = { r4 } line = { c4 }",
  ]) {
    assert.throws(() => readLilyPondVoices(`${duplicate}\n${voice}`, { line: "alto" }), /line: expected one/u);
  }
  assert.throws(() => readLilyPondVoices(String.raw`
    global = { \key c \major \time 4/4 } "global" = { c4 }
    line = \relative c' { \global c4 }
  `, { line: "alto" }), /global/u);
  assert.throws(() => readLilyPondVoices(String.raw`
    "bar" = { c4 } line = \relative c' { \bar "|" c4 }
  `, { line: "alto" }), /redefinition.+bar/u);
});

test("LilyPond reference reader allows safe quoted aliases and ignores assignment text in strings", () => {
  const reference = readLilyPondVoices(String.raw`
    title = "line = { c4 } voiceOne = { c4 }" "layout" = { \voiceOne }
    \score { \new Staff { c'4 } }
    "line" =
      \relative c' \context Staff = "one" \new Voice { \layout d4 }
  `, { line: "alto" });
  assert.deepEqual(reference.notes.map(({ midiPitch }) => midiPitch), [62]);
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

test("LilyPond reference reader rejects inline absolute staff voices", () => {
  assert.throws(() => readLilyPondVoices(String.raw`
    \score { \new Staff { \partial 4 << { c'4 d'1 } \\ { g4 a1 } >> } }
  `, { soprano: "soprano", bass: "bass" }), /soprano: expected one inline LilyPond relative voice block/u);
});

test("LilyPond reference reader rejects a named Voice context inside a relative header", () => {
  const voices = { dux: "alto" };
  const line = String.raw`dux = \relative g' { g8 fis }`;
  assert.deepEqual(readLilyPondVoices(line, voices).notes.map(({ midiPitch }) => midiPitch), [67, 66]);
  const named = String.raw`dux = \relative g' \context Voice = "dux" { g8 fis }`;
  assert.throws(() => readLilyPondVoices(named, voices), /dux: unsupported LilyPond token or duration.*context Voice/u);
});

test("LilyPond reference reader rejects chords instead of emitting a partial voice", () => {
  assert.throws(() => readLilyPondVoices(String.raw`
    bass = \relative c { c4 <g b>4 d }
  `, { bass: "bass" }), /bass: unsupported LilyPond token or duration "<"/u);
});

test("LilyPond reference reader rejects a BWV 865-style tied pedal ending in an octave chord", () => {
  const pedal = String.raw`bass = \relative c { \tieDown a,2 ~ a1 ~ a1 ~ a1 ~`;
  const voices = { bass: "bass" };
  const singleNoteEnding = readLilyPondVoices(`${pedal} a1 }`, voices);
  assert.deepEqual(singleNoteEnding.notes.map(({ tieStart, tieStop }) => [tieStart, tieStop]), [
    [true, false], [true, true], [true, true], [true, true], [false, true],
  ]);
  assert.throws(() => readLilyPondVoices(`${pedal} <a a'>1 }`, voices), /bass: unsupported LilyPond token or duration "<"/u);
});

test("LilyPond reference reader rejects three parallel branches in a selected relative line", () => {
  assert.throws(() => readLilyPondVoices(String.raw`
    upper = \relative c' { c4 << { d4 } \\ { f4 } \\ { a4 } >> }
  `, { upper: "soprano" }), /upper: expected one inline LilyPond relative voice block/u);
});

test("LilyPond reference reader rejects a requested embedded voice after reading a supported line", () => {
  const engraving = String.raw`
    upper = \relative c' { c4 }
    \score { \new Staff << \upper \new Voice = "bass" { g4 } >> }
  `;
  const reference = readLilyPondVoices(engraving, { upper: "soprano" });
  assert.deepEqual(reference.notes.map(({ midiPitch }) => midiPitch), [60]);
  assert.throws(() => readLilyPondVoices(engraving, { upper: "soprano", bass: "bass" }),
    /bass: expected one inline LilyPond relative voice block/u);
});
