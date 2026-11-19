import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMidi } from "midi-file";
import { movements, readCorpusFile, readMovementScore } from "../scripts/corpus.js";
import { importMusicXml, importMxl } from "../src/import-mxl.js";
import { getScoreAttacks, midiPitch, type Attack } from "../src/score-ir.js";

function attackKey({ tick, midiPitch }: Attack): string {
  return `${tick}:${midiPitch}`;
}

function readReference(data: Uint8Array, [startTick, endTick] = [0, Infinity]) {
  const midi = parseMidi(data);
  const ticksPerQuarter = midi.header.ticksPerBeat;
  assert.ok(ticksPerQuarter, "Expected a MIDI reference with quarter-note timing");

  const attacks = new Map<string, Attack>();
  const holds = new Map<number, { start: number; end: number }[]>();
  for (const track of midi.tracks) {
    let tick = 0;
    const active = new Map<string, number[]>();
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type !== "noteOn" && event.type !== "noteOff") continue;
      const { noteNumber: midiPitch, channel } = event;
      const key = `${channel}:${midiPitch}`;
      if (event.type === "noteOn" && event.velocity > 0) {
        if (startTick <= tick && tick < endTick) {
          const attack = { tick: tick - startTick, midiPitch };
          attacks.set(attackKey(attack), attack);
        }
        const starts = active.get(key) ?? [];
        starts.push(tick);
        active.set(key, starts);
      } else {
        const start = active.get(key)?.shift();
        assert.ok(start !== undefined, `Unmatched MIDI note-off at tick ${tick}, pitch ${midiPitch}`);
        const intervals = holds.get(midiPitch) ?? [];
        intervals.push({ start: start - startTick, end: tick - startTick });
        holds.set(midiPitch, intervals);
      }
    }
    assert.ok([...active.values()].every((starts) => starts.length === 0), "Unclosed note in MIDI reference");
  }
  return { attacks, holds, ticksPerQuarter };
}

for (const movement of movements) {
  test(`${movement.id} matches the upstream MIDI attack baseline with documented differences`, () => {
    const score = readMovementScore(movement);
    assert.equal(score.workNumber, `BWV ${movement.bwv}`);
    assert.equal(score.measures.length, movement.expected.measures);
    const reference = readReference(readCorpusFile(movement.referenceMidi), movement.referenceMidi.tickRange);
    const toMidiTick = (tick: number) => tick * reference.ticksPerQuarter / score.ticksPerQuarter;
    const attacks = getScoreAttacks(score);
    assert.equal(attacks.length, movement.expected.attacks);
    const midiGrid = attacks.map((attack) => {
      const tick = toMidiTick(attack.tick);
      assert.ok(Number.isSafeInteger(tick), `Score onset ${attack.tick} is outside the reference tick grid`);
      return { ...attack, tick };
    });
    const scoreKeys = new Set(midiGrid.map(attackKey));
    // Score-only pairs in the manifest use Score IR ticks. MIDI-only pairs use the reference's native ticks.
    const toMidiKey = (attack: Attack) => attackKey({ ...attack, tick: toMidiTick(attack.tick) });
    const knownScoreOnly = new Set((movement.expected.scoreOnlyAttacks ?? []).map(toMidiKey));
    const unplayed = new Set((movement.expected.unplayedScoreAttacks ?? []).map(toMidiKey));
    const scoreOnly = midiGrid.filter((attack) => !reference.attacks.has(attackKey(attack)));
    assert.equal(scoreOnly.length, unplayed.size + knownScoreOnly.size + (movement.expected.overlappingScoreAttacks ?? 0));
    for (const attack of scoreOnly) {
      const key = attackKey(attack);
      if (unplayed.delete(key)) continue;
      knownScoreOnly.delete(key);
      const { tick, midiPitch } = attack;
      assert.ok(reference.holds.get(midiPitch)?.some(({ start, end }) => start < tick && tick < end),
        `Score-only attack at MIDI tick ${tick}, pitch ${midiPitch} must occur during a held note of the same pitch`);
    }
    assert.equal(knownScoreOnly.size, 0, "Documented score-only attacks must be present");
    assert.equal(unplayed.size, 0, "Documented MIDI omissions must be present in the score");

    const midiOnly = [...reference.attacks.values()].filter((attack) => !scoreKeys.has(attackKey(attack)))
      .sort((a, b) => a.tick - b.tick || a.midiPitch - b.midiPitch);
    const graceNotes: Attack[] = [];
    const continuations = new Set<string>();
    const arpeggiatedNotes: { start: number; end: number; midiPitch: number }[] = [];
    const writtenOrnaments: { start: number; end: number; midiPitch: number; voice: string; tieStart: boolean }[] = [];
    for (const measure of score.measures) {
      for (const note of measure.events) {
        if (note.kind !== "note") continue;
        const attack = { tick: toMidiTick(measure.startTick + note.offsetTicks), midiPitch: midiPitch(note.pitch) };
        if (note.grace) {
          assert.equal(note.durationTicks, 0);
          graceNotes.push(attack);
        }
        if (note.tieStop) continuations.add(attackKey(attack));
        const previous = note.tieStop ? writtenOrnaments.find(({ end, midiPitch, voice, tieStart }) =>
          tieStart && end === attack.tick && midiPitch === attack.midiPitch && voice === note.voice,
        ) : undefined;
        const end = attack.tick + toMidiTick(note.durationTicks);
        if (note.notations.some(({ kind }) => kind === "arpeggiate")) {
          arpeggiatedNotes.push({ start: attack.tick, end, midiPitch: attack.midiPitch });
        }
        if (previous) {
          previous.end = end;
          previous.tieStart = note.tieStart;
        } else if (note.notations.some(({ kind }) => kind === "trill-mark" || kind === "inverted-mordent")) {
          writtenOrnaments.push({ start: attack.tick, end, midiPitch: attack.midiPitch, voice: note.voice, tieStart: note.tieStart });
        }
      }
    }
    assert.equal(graceNotes.length, movement.expected.graceNotes ?? 0);
    const otherMidiOnly = midiOnly.filter((attack) => !writtenOrnaments.some(({ start, end, midiPitch }) => {
      const interval = attack.midiPitch - midiPitch;
      return start <= attack.tick && attack.tick < end && interval >= 0 && interval <= 2;
    }));
    assert.equal(midiOnly.length - otherMidiOnly.length, movement.expected.realizedOrnamentAttacks ?? 0);
    assert.deepEqual(otherMidiOnly, movement.expected.midiOnlyAttacks ?? []);
    for (const attack of otherMidiOnly) {
      const earlyGrace = graceNotes.some((note) =>
        note.midiPitch === attack.midiPitch && attack.tick < note.tick && note.tick - attack.tick <= reference.ticksPerQuarter / 2,
      );
      const staggeredChord = arpeggiatedNotes.some(({ start, end, midiPitch }) =>
        midiPitch === attack.midiPitch && start < attack.tick && attack.tick < end,
      );
      assert.ok(earlyGrace || staggeredChord || continuations.has(attackKey(attack)),
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

test("an unsupported repeat is reported with its part and measure", () => {
  assert.throws(() => importMusicXml(`
    <score-partwise version="4.0"><part id="P1"><measure number="7">
      <barline location="right"><repeat direction="backward"/></barline>
    </measure></part></score-partwise>`), /Part P1, measure 7: Repeats and endings are unsupported/);
});
