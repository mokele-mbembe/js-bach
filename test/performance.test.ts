import assert from "node:assert/strict";
import { test } from "node:test";
import { writeMidi, type MidiEvent } from "midi-file";
import { getFugueEntrances } from "../demo/fugue-entrances.js";
import { movements, performanceForMovement, readCorpusFile, readMovementScore } from "../scripts/corpus.js";
import { compareSourceAttacks } from "../scripts/source-attacks.js";
import { importMusicXml, importMxl } from "../src/import-mxl.js";
import { soloVoice, toPerformance } from "../src/performance.js";
import { performanceTimeline, soloMusicalVoice } from "../src/playback-asset.js";
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

test("the BWV 848 fugue exposes one C-sharp 4 event when its exported voice ID changes at measure 52", () => {
  const movement = movements.find(({ id }) => id === "bwv848-fugue");
  assert.ok(movement);
  const score = importMxl(readCorpusFile(movement.score));
  const boundary = score.measures[51].startTick;
  const startSeconds = expectedNanoseconds(score, boundary - 2) / 1e9;
  const endSeconds = expectedNanoseconds(score, boundary + 1) / 1e9;
  const [attack, continuation] = score.measures.slice(50, 52).flatMap(({ events }) => events.filter((note) =>
    note.kind === "note" && note.pitch.step === "C" && note.pitch.alter === 1 && note.pitch.octave === 4 &&
    (note.tieStart || note.tieStop),
  ));
  assert.deepEqual([attack.voice, continuation.voice], ["2", "6"]);
  const timeline = performanceTimeline(performanceForMovement(score, movement));
  const spans = timeline.notes.filter((note) =>
    note.midiPitch === 61 && note.startSeconds >= startSeconds && note.startSeconds < endSeconds,
  );
  assert.deepEqual(spans, [{ midiPitch: 61, voiceId: "alto", scoreVoice: "2", startSeconds, endSeconds }]);
  assert.ok(Object.isFrozen(timeline) && Object.isFrozen(timeline.notes) && Object.isFrozen(spans[0]));
  assert.throws(() => performanceForMovement(score, {
    ...movement,
    voiceOverrides: [...movement.voiceOverrides!, { scoreVoice: "6", measures: ["52"], voiceId: "bass" }],
  }), /Tie changes musical voice in measure 52, score voice 6/);
});

const scopedVoiceCases = [
  {
    id: "bwv847-fugue",
    counts: { soprano: 266, alto: 252, bass: 236 },
    attacks: [
      [160, "6", 39, "bass"], // Measure 11
      [178, "6", 56, "alto"], // Measure 12, coincident with the bass attack below
      [178, "5", 53, "bass"],
      [224, "2", 55, "alto"], // Measure 15, still on the lower staff
    ],
    entries: [
      [1, "alto", "subject", 72, 2],
      [3, "soprano", "answer", 79, 34],
      [7, "bass", "subject", 60, 98],
    ],
  },
  {
    id: "bwv848-fugue",
    counts: { soprano: 577, alto: 457, bass: 382 },
    attacks: [
      [96, "6", 49, "bass"], // Measure 7
      [176, "6", 60, "alto"], // Measure 12
      [640, "5", 63, "alto"], // Measure 41
      [672, "5", 58, "alto"], // Measure 43
      [688, "5", 53, "bass"], // Measure 44
    ],
    entries: [
      [1, "soprano", "subject", 68, 6],
      [3, "alto", "answer", 61, 38],
      [5, "bass", "subject", 56, 70],
    ],
  },
] as const;

for (const { id, counts, attacks, entries } of scopedVoiceCases) {
  test(`${id} assigns scoped voice changes without changing the performance timeline`, () => {
    const movement = movements.find((movement) => movement.id === id);
    assert.ok(movement?.voices);
    const score = readMovementScore(movement);
    const performance = performanceForMovement(score, movement);
    const rawPerformance = toPerformance(score);
    assert.equal(performance.durationSeconds, rawPerformance.durationSeconds);
    assert.deepEqual(performance.notes.map(({ voiceId, ...note }) => note), rawPerformance.notes);
    const timeline = performanceTimeline(performance);
    for (const [tick, scoreVoice, midiPitch, voiceId] of attacks) {
      const matching = timeline.notes.filter((note) => note.scoreVoice === scoreVoice && note.midiPitch === midiPitch &&
        Math.round(note.startSeconds * 1e9) === expectedNanoseconds(score, tick));
      assert.deepEqual(matching.map((note) => note.voiceId), [voiceId], `${scoreVoice} at tick ${tick}`);
    }

    assert.equal(timeline.notes.length, counts.soprano + counts.alto + counts.bass);
    for (const [voiceId, count] of Object.entries(counts)) {
      const fullVoice = timeline.notes.filter((note) => note.voiceId === voiceId);
      assert.equal(fullVoice.length, count);
      const firstEntry = fullVoice[0].startSeconds;
      const lastRelease = Math.max(...fullVoice.map(({ endSeconds }) => endSeconds));
      assert.deepEqual(soloMusicalVoice(performance, voiceId), {
        notes: fullVoice.map(({ scoreVoice, midiPitch, startSeconds, endSeconds }) => ({
          voice: scoreVoice,
          voiceId,
          midiPitch,
          startSeconds: startSeconds - firstEntry,
          endSeconds: endSeconds - firstEntry,
        })),
        durationSeconds: lastRelease - firstEntry,
      });
    }

    assert.deepEqual(getFugueEntrances(id, timeline.notes)
      .map(({ measure, voiceId, kind, midiPitch, startSeconds }) =>
        [measure, voiceId, kind, midiPitch, Math.round(startSeconds * 1e9)]),
    entries.map(([measure, voiceId, kind, midiPitch, tick]) =>
      [measure, voiceId, kind, midiPitch, expectedNanoseconds(score, tick)]));
  });
}

test("the BWV 849 fugue assigns five musical voices without changing the performance", () => {
  const movement = movements.find(({ id }) => id === "bwv849-fugue");
  assert.ok(movement);
  const score = readMovementScore(movement);
  const performance = performanceForMovement(score, movement);
  assert.deepEqual({
    ...performance,
    notes: performance.notes.map(({ voiceId, ...note }) => note),
  }, toPerformance(score));

  const auditedVoices = [
    ["soprano", ["3"], 297],
    ["alto", ["2"], 280],
    ["tenor", ["1", "7"], 270],
    ["baritone", ["6"], 236],
    ["bass", ["5"], 238],
  ] as const;
  assert.deepEqual(new Set(performance.notes.map(({ voiceId }) => voiceId)), new Set(auditedVoices.map(([id]) => id)));
  for (const [id, scoreVoices, count] of auditedVoices) {
    const notes = performance.notes.filter(({ voiceId }) => voiceId === id);
    assert.equal(notes.length, count, id);
    assert.deepEqual(new Set(notes.map(({ voice }) => voice)), new Set(scoreVoices), id);
  }

  const [baritoneEntry] = soloMusicalVoice(performance, "baritone").notes;
  assert.equal(baritoneEntry.midiPitch, 56);
  assert.equal(baritoneEntry.startSeconds, 0);
});

test("an orphan tie continuation reports its measure and voice", () => {
  const source = importMusicXml(`
    <score-partwise version="4.0"><part id="P1"><measure number="7">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><tie type="stop"/><voice>2</voice></note>
    </measure></part></score-partwise>`);
  assert.throws(() => toPerformance(source), /Unmatched tie continuation in measure 7, voice 2/);
});
