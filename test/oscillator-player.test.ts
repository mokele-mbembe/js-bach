import assert from "node:assert/strict";
import test from "node:test";
import { playPerformance, type ScheduledNote } from "../src/oscillator-player.js";

class FakeGain {
  output?: FakeGain;
  readonly targets: [value: number, time: number][] = [];
  readonly gain = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    setTargetAtTime: (value: number, time: number) => this.targets.push([value, time]),
  };

  connect(output: FakeGain): void { this.output = output; }
  disconnect(): void { this.output = undefined; }
}

class FakeOscillator extends EventTarget {
  output?: FakeGain;
  onset?: number;
  readonly stops: number[] = [];
  readonly frequency = { value: 0 };

  connect(output: FakeGain): void { this.output = output; }
  disconnect(): void { this.output = undefined; }
  start(time: number): void { this.onset = time; }
  stop(time: number): void { this.stops.push(time); }
}

function fakeAudio() {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const context = {
    currentTime: 0,
    destination: new FakeGain(),
    createGain() {
      const node = new FakeGain();
      gains.push(node);
      return node;
    },
    createOscillator() {
      const oscillator = new FakeOscillator();
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  return { context, audio: context as unknown as AudioContext, oscillators, gains };
}

test("mutes sustaining and scheduled notes through their shared voice gain", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { context, audio, oscillators } = fakeAudio();
  const voiceIds = ["Alto", "Soprano"];
  const playback = playPerformance(audio, {
    durationSeconds: 1,
    notes: [
      { startSeconds: 0, endSeconds: 0.8, midiPitch: 60, voice: "1", voiceId: "Alto" },
      { startSeconds: 0, endSeconds: 0.8, midiPitch: 60, voice: "1", voiceId: "Soprano" },
      { startSeconds: 0.08, endSeconds: 0.8, midiPitch: 64, voice: "5", voiceId: "Alto" },
      { startSeconds: 0.3, endSeconds: 0.8, midiPitch: 65, voice: "1", voiceId: "Alto" },
    ],
  }, () => assert.fail("The mixer should preserve the original end time"), voiceIds);
  assert.equal(oscillators.length, 3);
  const [sustaining, otherVoice, scheduled] = oscillators;
  const alto = sustaining.output?.output;
  const soprano = otherVoice.output?.output;
  assert.ok(alto && soprano);
  assert.notEqual(alto, soprano);
  assert.equal(alto, scheduled.output?.output);
  assert.equal(alto.output, soprano.output);
  assert.throws(() => playback.setVoiceMuted("Tenor", true), RangeError);

  context.currentTime = 0.1;
  assert.ok(sustaining.onset! < context.currentTime);
  assert.ok(scheduled.onset! > context.currentTime);
  const positionBeforeMute = playback.position();
  playback.setVoiceMuted("Alto", true);
  playback.setVoiceMuted("Alto", true);
  assert.equal(playback.position(), positionBeforeMute);
  assert.deepEqual(alto.targets, [[0, 0.1]]);
  assert.deepEqual(soprano.targets, []);

  context.currentTime = 0.25;
  t.mock.timers.tick(25);
  assert.equal(oscillators.length, 4);
  assert.equal(oscillators[3].output?.output, alto);
  context.currentTime = 0.4;
  playback.setVoiceMuted("Alto", false);
  assert.deepEqual(alto.targets, [[0, 0.1], [1, 0.4]]);
  assert.equal(playback.position(), 0.4 - 0.05);
  assert.deepEqual(oscillators.map(({ onset }) => onset), [0.05, 0.05, 0.13, 0.35]);

  playback.stop();
  for (const oscillator of oscillators) oscillator.dispatchEvent(new Event("ended"));
  assert.equal(alto.output, undefined);
  assert.equal(soprano.output, undefined);
});

test("reports the scheduled audio clock for all buses, including an initially muted voice", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { audio, context, oscillators } = fakeAudio();
  context.currentTime = 10;
  const scheduled: ScheduledNote[] = [];
  const playback = playPerformance(audio, {
    durationSeconds: 1,
    notes: [
      { startSeconds: 0, endSeconds: 0.5, midiPitch: 60, voice: "4", voiceId: "alto" },
      { startSeconds: 0.13, endSeconds: 0.4, midiPitch: 64, voice: "2" },
      { startSeconds: 0.6, endSeconds: 0.8, midiPitch: 67, voice: "1", voiceId: "alto" },
    ],
  }, () => assert.fail("Stopped playback must not naturally end"), ["alto"], {
    muted: ["alto"],
    onNote: (note) => scheduled.push(note),
  });
  assert.equal(scheduled.length, 0);
  context.currentTime = 10.025;
  t.mock.timers.tick(25);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(scheduled[0], {
    midiPitch: 60, startSeconds: 0, endSeconds: 0.5, scoreVoice: "4", voiceId: "alto",
    audioStartTime: 10.05, audioEndTime: 10.55,
  });
  const first = oscillators[0];
  assert.equal(first.onset, scheduled[0].audioStartTime);
  assert.deepEqual(first.stops, [scheduled[0].audioEndTime]);
  const alto = first.output?.output;
  assert.ok(alto);
  assert.equal(alto.gain.value, 0);
  assert.deepEqual(alto.targets, []);

  context.currentTime = 10.21;
  t.mock.timers.tick(25);
  assert.deepEqual(scheduled[1], {
    midiPitch: 64, startSeconds: 0.13, endSeconds: 0.4, scoreVoice: "2", voiceId: null,
    audioStartTime: 10.21, audioEndTime: 10.05 + 0.4,
  });
  assert.equal(oscillators[1].onset, scheduled[1].audioStartTime);
  assert.deepEqual(oscillators[1].stops, [scheduled[1].audioEndTime]);
  playback.setVoiceMuted("alto", false);
  assert.deepEqual(alto.targets, [[1, 10.21]]);
  assert.equal(oscillators[0], first);

  playback.stop();
  context.currentTime = 10.65;
  t.mock.timers.tick(75);
  assert.equal(scheduled.length, 2);
  assert.equal(oscillators.length, 2);
});

test("can stop from the first onNote callback without scheduling another note", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { audio, context, oscillators } = fakeAudio();
  const pitches: number[] = [];
  const playback = playPerformance(audio, {
    durationSeconds: 1,
    notes: [
      { startSeconds: 0, endSeconds: 0.5, midiPitch: 60, voice: "4" },
      { startSeconds: 0, endSeconds: 0.5, midiPitch: 64, voice: "2" },
    ],
  }, () => assert.fail("Stopped playback must not naturally end"), [], {
    onNote(note) {
      pitches.push(note.midiPitch);
      playback.stop();
    },
  });
  assert.deepEqual(pitches, []);
  context.currentTime = 0.025;
  t.mock.timers.tick(25);
  assert.deepEqual(pitches, [60]);
  assert.equal(oscillators.length, 1);
  assert.deepEqual(oscillators[0].stops, [0.55, 0.025]);
  context.currentTime = 1.1;
  t.mock.timers.tick(75);
  assert.deepEqual(pitches, [60]);
  assert.equal(oscillators.length, 1);
});

test("clears the interval and stops scheduled oscillators if onNote throws", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const clearInterval = t.mock.method(globalThis, "clearInterval");
  const { audio, context, oscillators, gains } = fakeAudio();
  const error = new Error("callback failed");
  playPerformance(audio, {
    durationSeconds: 1,
    notes: [
      { startSeconds: 0, endSeconds: 0.5, midiPitch: 60, voice: "4" },
      { startSeconds: 0, endSeconds: 0.5, midiPitch: 64, voice: "2" },
    ],
  }, () => assert.fail("Failed playback must not naturally end"), [], {
    onNote() { throw error; },
  });
  context.currentTime = 0.025;
  assert.throws(() => t.mock.timers.tick(25), error);
  assert.equal(clearInterval.mock.callCount(), 1);
  assert.equal(oscillators.length, 1);
  assert.deepEqual(oscillators[0].stops, [0.55, 0.025]);
  oscillators[0].dispatchEvent(new Event("ended"));
  assert.ok(gains.every((gain) => gain.output === undefined));
  context.currentTime = 1.1;
  t.mock.timers.tick(75);
  assert.equal(oscillators.length, 1);
});

test("rejects unknown initially muted IDs before creating the audio graph", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const setInterval = t.mock.method(globalThis, "setInterval");
  const { audio, gains, oscillators } = fakeAudio();
  assert.throws(() => playPerformance(audio, { durationSeconds: 0, notes: [] }, () => {}, ["alto"], {
    muted: ["soprano"],
  }), RangeError);
  assert.equal(setInterval.mock.callCount(), 0);
  assert.deepEqual(gains, []);
  assert.deepEqual(oscillators, []);
});
