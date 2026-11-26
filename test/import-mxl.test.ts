import assert from "node:assert/strict";
import { test } from "node:test";
import { movements, readCorpusFile, readMovementScore } from "../scripts/corpus.js";
import { importMusicXml, importMxl } from "../src/import-mxl.js";
import { getScoreAttacks, midiPitch, type Attack } from "../src/score-ir.js";
import { attackKey, compareSourceAttacks, describeMidiDifferences } from "../scripts/source-attacks.js";

for (const movement of movements) {
  test(`${movement.id} matches the upstream MIDI attack baseline with documented differences`, () => {
    const score = readMovementScore(movement);
    assert.equal(score.workNumber, `BWV ${movement.bwv}`);
    assert.equal(score.measures.length, movement.expected.measures);
    const { comparisonScore, reference, toMidiTick, attacks, midiGrid, scoreOnly, midiOnly } =
      compareSourceAttacks(score, readCorpusFile(movement.referenceMidi), movement.referenceMidi);
    assert.equal(attacks.length, movement.expected.attacks);
    assert.equal(reference.redundantNoteOffs.length, movement.expected.redundantMidiNoteOffs ?? 0);
    for (const { tick, scoreTick } of midiGrid) {
      assert.ok(Number.isSafeInteger(tick), `Score onset ${scoreTick} is outside the reference tick grid`);
    }
    // Score-only pairs in the manifest use Score IR ticks. MIDI-only pairs use the reference's native ticks.
    const toMidiKey = (attack: Attack) => attackKey({ ...attack, tick: toMidiTick(attack.tick) });
    const remainingScoreOnly = new Map(scoreOnly.map((attack) => [attackKey(attack), attack]));
    const remainingMidiOnly = new Map(midiOnly.map((attack) => [attackKey(attack), attack]));
    for (const { scoreTick, midiTick, midiPitch } of movement.expected.shiftedMidiAttacks ?? []) {
      const written = toMidiKey({ tick: scoreTick, midiPitch });
      const performed = attackKey({ tick: midiTick, midiPitch });
      assert.ok(remainingScoreOnly.delete(written), `Missing written attack for shift ${written} to ${performed}`);
      assert.ok(remainingMidiOnly.delete(performed), `Missing MIDI attack for shift ${written} to ${performed}`);
    }
    const knownScoreOnly = new Set((movement.expected.scoreOnlyAttacks ?? []).map(toMidiKey));
    const unplayed = new Set((movement.expected.unplayedScoreAttacks ?? []).map(toMidiKey));
    assert.equal(remainingScoreOnly.size, unplayed.size + knownScoreOnly.size + (movement.expected.overlappingScoreAttacks ?? 0));
    for (const attack of remainingScoreOnly.values()) {
      const key = attackKey(attack);
      if (unplayed.delete(key)) continue;
      knownScoreOnly.delete(key);
      const { tick, midiPitch } = attack;
      assert.ok(reference.holds.get(midiPitch)?.some(({ start, end }) => start < tick && tick < end),
        `Score-only attack at MIDI tick ${tick}, pitch ${midiPitch} must occur during a held note of the same pitch`);
    }
    assert.equal(knownScoreOnly.size, 0, "Documented score-only attacks must be present");
    assert.equal(unplayed.size, 0, "Documented MIDI omissions must be present in the score");

    const { graceNotes, differences } = describeMidiDifferences(comparisonScore, toMidiTick, [...remainingMidiOnly.values()]);
    assert.equal(graceNotes.length, movement.expected.graceNotes ?? 0);
    const other = differences.filter((difference) => difference.ornaments.length === 0);
    assert.equal(differences.length - other.length, movement.expected.realizedOrnamentAttacks ?? 0);
    assert.deepEqual(other.map(({ attack }) => attack), movement.expected.midiOnlyAttacks ?? []);
    for (const { attack, onBeatGrace, earlyGrace, staggeredChord, tieContinuation } of other) {
      assert.ok(onBeatGrace || earlyGrace || staggeredChord || tieContinuation,
        `MIDI-only attack at tick ${attack.tick}, pitch ${attack.midiPitch} must match a grace note, arpeggiated note or tie continuation`);
    }
  });
}

test("the Prelude retains the attacks and durations of the five-note final chord", () => {
  const prelude = movements.find(({ id }) => id === "bwv846-prelude");
  assert.ok(prelude);
  const score = importMxl(readCorpusFile(prelude.score));
  assert.equal(score.ticksPerQuarter, 4);
  assert.deepEqual(score.tempoChanges, [{ tick: 0, beatsPerMinute: 66 }]);

  const finale = score.measures[34];
  assert.equal(finale.number, "35");
  assert.deepEqual(
    finale.events.map((event) => {
      assert.equal(event.kind, "note");
      return [midiPitch(event.pitch), event.offsetTicks, event.durationTicks, event.staff];
    }),
    [[64, 0, 16, 1], [67, 0, 16, 1], [72, 0, 16, 1], [48, 0, 16, 2], [36, 0, 16, 2]],
  );
});

test("the Fugue retains four voices, a cross-bar tie, and the source ornament marks", () => {
  const fugue = movements.find(({ id }) => id === "bwv846-fugue");
  assert.ok(fugue);
  const score = importMxl(readCorpusFile(fugue.score));
  assert.equal(score.ticksPerQuarter, 8);
  assert.deepEqual(score.tempoChanges, [{ tick: 0, beatsPerMinute: 66 }]);
  assert.deepEqual(new Set(score.measures.flatMap(({ events }) => events.map(({ voice }) => voice))), new Set(["1", "2", "5", "6"]));

  const [first, second] = [score.measures[3], score.measures[4]];
  const tail = first.events.find((event) => event.kind === "note" && event.voice === "2" && event.offsetTicks === 28);
  const continuation = second.events.find((event) => event.kind === "note" && event.voice === "2" && event.offsetTicks === 0);
  assert.ok(tail?.kind === "note" && continuation?.kind === "note");
  assert.equal(tail.tieStart, true);
  assert.equal(continuation.tieStop, true);
  assert.equal(first.startTick + tail.offsetTicks + tail.durationTicks, second.startTick);
  assert.equal(continuation.durationTicks, 4);
  assert.deepEqual(tail.pitch, { step: "G", alter: 0, octave: 4 });
  assert.deepEqual(continuation.pitch, tail.pitch);

  const decoratedMeasures = score.measures.filter(({ events }) =>
    events.some(({ notations }) => notations.some(({ kind }) => kind === "inverted-mordent")),
  );
  assert.deepEqual(decoratedMeasures.map(({ number }) => number), ["18", "19"]);
});

test("the score tick grid preserves exact positions when divisions change", () => {
  const score = importMusicXml(`
    <score-partwise version="4.0"><part id="P1">
      <measure number="0" implicit="yes">
        <attributes><divisions>3</divisions></attributes>
        <note><pitch><step>D</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration></note>
      </measure>
      <measure number="1">
        <attributes><divisions>2</divisions></attributes>
        <forward><duration>1</duration></forward>
        <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration></note>
      </measure>
    </part></score-partwise>`);
  assert.equal(score.ticksPerQuarter, 6);
  assert.deepEqual(score.measures.map(({ startTick, durationTicks }) => [startTick, durationTicks]), [[0, 2], [2, 6]]);
  assert.deepEqual(getScoreAttacks(score), [{ tick: 0, midiPitch: 61 }, { tick: 5, midiPitch: 61 }]);
  assert.deepEqual(score.measures.map(({ events }) => events[0].kind === "note" && events[0].pitch), [
    { step: "D", alter: -1, octave: 4 }, { step: "C", alter: 1, octave: 4 },
  ]);
});

test("an unsupported alternate ending is reported with its part and measure", () => {
  assert.throws(() => importMusicXml(`
    <score-partwise version="4.0"><part id="P1"><measure number="7">
      <barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline>
    </measure></part></score-partwise>`), /Part P1, measure 7: Alternate endings are unsupported/);
});
