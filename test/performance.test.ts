import assert from "node:assert/strict";
import { test } from "node:test";
import { writeMidi, type MidiEvent } from "midi-file";
import { movements, readCorpusFile, readMovementScore } from "../scripts/corpus.js";
import { compareSourceAttacks } from "../scripts/source-attacks.js";
import { importMusicXml, importMxl } from "../src/import-mxl.js";
import { soloVoice, toPerformance } from "../src/performance.js";
import { getScoreAttacks, type ScoreIR } from "../src/score-ir.js";
import { expandWrittenRepeats } from "../src/score-repeats.js";

function expectedNanoseconds(score: ScoreIR, tick: number): number {
  let elapsed = 0;
  let previous = 0;
  let bpm = 120;
  for (const change of score.tempoChanges) {
    if (change.tick > tick) break;
    elapsed += (60 * (change.tick - previous)) / (bpm * score.ticksPerQuarter);
    previous = change.tick;
    bpm = change.beatsPerMinute;
  }
  return Math.round((elapsed + (60 * (tick - previous)) / (bpm * score.ticksPerQuarter)) * 1e9);
}

for (const movement of movements) {
  test(`${movement.id} retains all validated attacks in the performance`, () => {
    const score = readMovementScore(movement);
    const performance = toPerformance(score);
    const timeline = performance.notes.map(({ startSeconds, midiPitch }) => ({
      time: Math.round(startSeconds * 1e9), midiPitch,
    })).sort((a, b) => a.time - b.time || a.midiPitch - b.midiPitch);
    const unique = timeline.filter((note, index, events) =>
      index === 0 || note.time !== events[index - 1].time || note.midiPitch !== events[index - 1].midiPitch,
    );
    const performedScore = expandWrittenRepeats(score);
    assert.deepEqual(unique, getScoreAttacks(performedScore).map(({ tick, midiPitch }) => ({ time: expectedNanoseconds(performedScore, tick), midiPitch })));
    assert.ok(performance.notes.every((note) => note.endSeconds > note.startSeconds && note.endSeconds <= performance.durationSeconds));
  });
}

test("both an implied repeat start and a written start replay with their initial tempo", () => {
  const note = (step: string) => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration></note>`;
  const score = importMusicXml(`
    <score-partwise version="4.0"><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions></attributes><sound tempo="60"/>${note("C")}
        <barline location="right"><repeat direction="backward"/></barline></measure>
      <measure number="2"><barline location="left"><repeat direction="forward"/></barline>${note("D")}</measure>
      <measure number="3"><sound tempo="120"/>${note("E")}
        <barline location="right"><repeat direction="backward" times="2"/></barline></measure>
    </part></score-partwise>`);
  assert.deepEqual(score.measures.map(({ repeatStart, repeatEnd }) => [repeatStart, repeatEnd]), [[undefined, 2], [true, undefined], [undefined, 2]]);
  const performance = toPerformance(score);
  assert.deepEqual(performance.notes.map(({ startSeconds, midiPitch }) => [startSeconds, midiPitch]),
    [[0, 60], [1, 60], [2, 62], [3, 64], [3.5, 62], [4.5, 64]]);
  assert.equal(performance.durationSeconds, 5);
});

const repeatTieCases: { name: string; ending: string; spans: [number, number, number][] }[] = [
  { name: "cuts a tie whose destination is skipped and attacks a note whose tie source is skipped", ending: "G",
    spans: [[0, 2, 60], [2, 3, 67], [3, 4, 60], [4, 6, 67]] },
  { name: "sustains a compatible tie across the jump", ending: "C", spans: [[0, 2, 60], [2, 4, 60], [4, 6, 60]] },
];
for (const { name, ending, spans } of repeatTieCases) {
  test(`playback and MIDI attack comparison agree when a repeat ${name}`, () => {
    const note = (step: string, tie: string) =>
      `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><tie type="${tie}"/></note>`;
    const score = importMusicXml(`
      <score-partwise version="4.0"><part id="P1">
        <measure number="1"><attributes><divisions>1</divisions></attributes>${note("C", "start")}</measure>
        <measure number="2"><barline location="left"><repeat direction="forward"/></barline>${note("C", "stop")}</measure>
        <measure number="3">${note(ending, "start")}<barline location="right"><repeat direction="backward"/></barline></measure>
        <measure number="4">${note(ending, "stop")}</measure>
      </part></score-partwise>`);
    const written = structuredClone(score);
    const track: MidiEvent[] = [];
    let tick = 0;
    for (const [start, end, noteNumber] of spans) {
      track.push({ type: "noteOn", deltaTime: start - tick, channel: 0, noteNumber, velocity: 64 },
        { type: "noteOff", deltaTime: end - start, channel: 0, noteNumber, velocity: 0 });
      tick = end;
    }
    track.push({ type: "endOfTrack", deltaTime: 0, meta: true });
    const midi = Uint8Array.from(writeMidi({ header: { format: 0, numTracks: 1, ticksPerBeat: 1 }, tracks: [track] }));
    const { attacks, scoreOnly, midiOnly } = compareSourceAttacks(score, midi);
    assert.deepEqual(attacks, spans.map(([tick, , midiPitch]) => ({ tick, midiPitch })));
    assert.deepEqual([scoreOnly, midiOnly], [[], []]);
    assert.deepEqual(toPerformance(score), {
      notes: spans.map(([start, end, midiPitch]) => ({ voice: "1", midiPitch, startSeconds: start / 2, endSeconds: end / 2 })),
      durationSeconds: 3,
    });
    assert.deepEqual(score, written);
  });
}

test("the Fugue sustains a four-measure bass tie and keeps coincident voices distinct", () => {
  const movement = movements.find(({ id }) => id === "bwv846-fugue");
  assert.ok(movement);
  const score = importMxl(readCorpusFile(movement.score));
  const performance = toPerformance(score);
  const ticksPerSecond = score.ticksPerQuarter * 66 / 60;
  const bar24 = score.measures[23].startTick;
  const pedal = performance.notes.filter((note) =>
    note.voice === "6" && note.midiPitch === 48 && Math.round(note.startSeconds * ticksPerSecond) >= bar24,
  );
  assert.equal(pedal.length, 1);
  assert.equal(Math.round(pedal[0].startSeconds * ticksPerSecond), bar24);
  assert.equal(pedal[0].endSeconds, performance.durationSeconds);

  const unisons = new Map<string, Set<string>>();
  for (const note of performance.notes) {
    const key = `${note.startSeconds}:${note.midiPitch}`;
    const voices = unisons.get(key) ?? new Set<string>();
    voices.add(note.voice);
    unisons.set(key, voices);
  }
  assert.ok(Array.from(unisons.values()).some((voices) => voices.size > 1));

  for (const voice of ["1", "2", "5", "6"]) {
    const solo = soloVoice(performance, voice);
    const original = performance.notes.filter((note) => note.voice === voice);
    assert.equal(solo.notes.length, original.length);
    assert.ok(solo.notes.every((note) => note.voice === voice));
    assert.equal(solo.notes[0].startSeconds, 0);
    assert.equal(solo.durationSeconds, Math.max(...original.map((note) => note.endSeconds)) - original[0].startSeconds);
  }
});

test("a cross-staff continuation stays one note across a tempo change", () => {
  const score = importMusicXml(`
    <score-partwise version="4.0"><part id="P1">
      <measure number="1">
        <attributes><divisions>1</divisions></attributes><sound tempo="120"/>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><tie type="start"/><staff>1</staff></note>
      </measure>
      <measure number="2">
        <sound tempo="60"/>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><tie type="stop"/><staff>2</staff></note>
      </measure>
    </part></score-partwise>`);
  assert.deepEqual(toPerformance(score), {
    notes: [{ voice: "1", midiPitch: 60, startSeconds: 0, endSeconds: 1.5 }],
    durationSeconds: 1.5,
  });
});

test("the BWV 848 fugue sustains C-sharp 4 when its exported voice ID changes at measure 52", () => {
  const movement = movements.find(({ id }) => id === "bwv848-fugue");
  assert.ok(movement);
  const score = importMxl(readCorpusFile(movement.score));
  const boundary = score.measures[51].startTick;
  const startSeconds = expectedNanoseconds(score, boundary - 2) / 1e9;
  const endSeconds = expectedNanoseconds(score, boundary + 1) / 1e9;
  const spans = toPerformance(score).notes.filter((note) =>
    note.midiPitch === 61 && note.startSeconds >= startSeconds && note.startSeconds < endSeconds,
  );
  assert.deepEqual(spans, [{ midiPitch: 61, voice: "2", startSeconds, endSeconds }]);
});

test("the BWV 847 fugue solos three musical voices across the exported voice IDs", () => {
  const movement = movements.find(({ id }) => id === "bwv847-fugue");
  assert.ok(movement?.voices);
  const score = toPerformance(importMxl(readCorpusFile(movement.score)));
  assert.deepEqual(movement.voices.map(({ name }) => name), ["Soprano", "Alto", "Bass"]);
  const allIds = movement.voices.flatMap(({ ids }) => ids);
  assert.equal(allIds.length, new Set(allIds).size);
  assert.deepEqual(new Set(allIds), new Set(score.notes.map(({ voice }) => voice)));

  const { ids } = movement.voices[2];
  const bass = soloVoice(score, ids);
  assert.deepEqual(new Set(bass.notes.map(({ voice }) => voice)), new Set(["5", "6", "7", "8", "9", "10"]));
  assert.equal(bass.notes[0].startSeconds, 0);
  assert.equal(bass.notes[0].midiPitch, 60);
});

test("an orphan tie continuation reports its measure and voice", () => {
  const source = importMusicXml(`
    <score-partwise version="4.0"><part id="P1"><measure number="7">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><tie type="stop"/><voice>2</voice></note>
    </measure></part></score-partwise>`);
  assert.throws(() => toPerformance(source), /Unmatched tie continuation in measure 7, voice 2/);
});
