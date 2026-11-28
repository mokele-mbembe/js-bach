import assert from "node:assert/strict";
import test from "node:test";
import { playPerformance, type ScheduledNote } from "../src/oscillator-player.js";

class FakeGain {
  output?: FakeGain | FakeStereoPanner;
  readonly targets: [value: number, time: number][] = [];
  readonly gain = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    setTargetAtTime: (value: number, time: number) => this.targets.push([value, time]),
  };

  connect(output: FakeGain | FakeStereoPanner): void { this.output = output; }
  disconnect(): void { this.output = undefined; }
}

class FakeStereoPanner {
  output?: FakeGain;
  readonly targets: [value: number, time: number][] = [];
  readonly pan = {
    value: 0,
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

function fakeAudio({ stereo = false } = {}) {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const panners: FakeStereoPanner[] = [];
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
    ...(stereo && {
      createStereoPanner() {
        const node = new FakeStereoPanner();
        panners.push(node);
        return node;
      },
    }),
  };
  return { context, audio: context as unknown as AudioContext, oscillators, gains, panners };
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
  assert.ok(alto instanceof FakeGain && soprano instanceof FakeGain);
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
  assert.ok(alto instanceof FakeGain);
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

test("keeps scheduling while onNote is pending and stops on a rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const clearInterval = t.mock.method(globalThis, "clearInterval");
  const reports: (() => void)[] = [];
  t.mock.method(globalThis, "queueMicrotask", (report: () => void) => { reports.push(report); });
  const { audio, context, oscillators } = fakeAudio();
  const error = new Error("async callback failed");
  let rejectNote!: (reason: unknown) => void;
  const pending = new Promise<void>((_, reject) => { rejectNote = reject; });
  const pitches: number[] = [];
  playPerformance(audio, {
    durationSeconds: 1,
    notes: [
      { startSeconds: 0, endSeconds: 0.5, midiPitch: 60, voice: "4" },
      { startSeconds: 0.08, endSeconds: 0.5, midiPitch: 64, voice: "2" },
      { startSeconds: 0.6, endSeconds: 0.8, midiPitch: 67, voice: "1" },
    ],
  }, () => assert.fail("Failed playback must not naturally end"), [], {
    async onNote(note) {
      pitches.push(note.midiPitch);
      if (note.midiPitch === 60) await pending;
    },
  });
  context.currentTime = 0.025;
  t.mock.timers.tick(25);
  assert.deepEqual(pitches, [60, 64]);
  assert.equal(oscillators.length, 2);
  assert.equal(clearInterval.mock.callCount(), 0);

  context.currentTime = 0.08;
  rejectNote(error);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clearInterval.mock.callCount(), 1);
  assert.deepEqual(oscillators.map(({ stops }) => stops), [[0.55, 0.08 + 0.012], [0.55, 0.08]]);
  assert.equal(reports.length, 1);
  assert.throws(reports[0], (reported) => reported === error);

  context.currentTime = 0.65;
  t.mock.timers.tick(75);
  assert.deepEqual(pitches, [60, 64]);
  assert.equal(oscillators.length, 2);
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

test("routes each voice through its own panner and moves it while the notes keep playing", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { context, audio, gains, panners, oscillators } = fakeAudio({ stereo: true });
  const playback = playPerformance(audio, {
    durationSeconds: 1,
    notes: [
      { startSeconds: 0, endSeconds: 1, midiPitch: 60, voice: "4", voiceId: "alto" },
      { startSeconds: 0, endSeconds: 1, midiPitch: 64, voice: "2", voiceId: "soprano" },
      { startSeconds: 0, endSeconds: 1, midiPitch: 67, voice: "1" },
    ],
  }, () => assert.fail("Stopped playback must not naturally end"), ["alto", "soprano"], {
    muted: ["alto"],
    pan: { alto: -1 },
  });
  const [master, altoGain, sopranoGain] = gains;
  const [altoPan, sopranoPan] = panners;
  assert.equal(panners.length, 2);
  assert.equal(master.output, context.destination);
  assert.equal(altoGain.output, altoPan);
  assert.equal(sopranoGain.output, sopranoPan);
  assert.equal(altoPan.output, master);
  assert.equal(sopranoPan.output, master);
  assert.equal(altoGain.gain.value, 0);
  assert.equal(altoPan.pan.value, -1);
  assert.equal(sopranoPan.pan.value, 0);
  assert.deepEqual(altoPan.targets, []);
  assert.equal(oscillators[0].output?.output, altoGain);
  assert.equal(oscillators[1].output?.output, sopranoGain);
  assert.equal(oscillators[2].output?.output, master);
  const originalOscillators = [...oscillators];

  context.currentTime = 0.25;
  assert.throws(() => playback.setVoicePan("bass", 0), RangeError);
  for (const invalid of [-1.01, 1.01, NaN, -Infinity, Infinity]) {
    assert.throws(() => playback.setVoicePan("alto", invalid), RangeError);
  }
  assert.deepEqual(altoPan.targets, []);
  playback.setVoicePan("alto", 1);
  assert.deepEqual(altoPan.targets, [[1, 0.25]]);
  assert.deepEqual(sopranoPan.targets, []);
  assert.equal(altoGain.gain.value, 0);
  assert.deepEqual(altoGain.targets, []);
  assert.equal(playback.position(), 0.25 - 0.05);
  assert.equal(oscillators.length, originalOscillators.length);
  oscillators.forEach((oscillator, index) => assert.equal(oscillator, originalOscillators[index]));
  assert.deepEqual(oscillators.map(({ stops }) => stops), [[1.05], [1.05], [1.05]]);

  playback.stop();
  for (const oscillator of oscillators) oscillator.dispatchEvent(new Event("ended"));
  assert.ok(gains.every((gain) => gain.output === undefined));
  assert.ok(panners.every((panner) => panner.output === undefined));
});

test("validates pan and keeps voice gain controls when stereo panning is unavailable", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { context, audio, gains, panners } = fakeAudio();
  const playback = playPerformance(audio, {
    durationSeconds: 1, notes: [],
  }, () => assert.fail("Stopped playback must not naturally end"), ["alto"], { pan: { alto: 1 } });
  const [master, gain] = gains;
  assert.equal(gain.output, master);
  assert.deepEqual(panners, []);
  assert.doesNotThrow(() => playback.setVoicePan("alto", -1));
  assert.throws(() => playback.setVoicePan("alto", NaN), RangeError);
  assert.throws(() => playback.setVoicePan("bass", 0), RangeError);

  context.currentTime = 0.2;
  playback.setVoiceMuted("alto", true);
  assert.deepEqual(gain.targets, [[0, 0.2]]);
  playback.stop();
  assert.equal(gain.output, undefined);
  assert.equal(master.output, undefined);
});

test("rejects invalid initial pan and seek options before creating an audio graph", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const setInterval = t.mock.method(globalThis, "setInterval");
  const { audio, gains, oscillators, panners } = fakeAudio({ stereo: true });
  const performance = { durationSeconds: 2, notes: [] };
  const invalidOptions = [
    { pan: { bass: 0 } },
    ...[-1.01, 1.01, NaN, -Infinity, Infinity].map((alto) => ({ pan: { alto } })),
    ...[-0.01, 2.01, NaN, -Infinity, Infinity].map((startSeconds) => ({ startSeconds })),
  ];
  for (const options of invalidOptions) {
    assert.throws(() => playPerformance(audio, performance, () => {}, ["alto"], options), RangeError);
  }
  assert.equal(setInterval.mock.callCount(), 0);
  assert.deepEqual(gains, []);
  assert.deepEqual(panners, []);
  assert.deepEqual(oscillators, []);
});

test("seeks through a sustained note and preserves the performance and audio clocks", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { audio, context, oscillators } = fakeAudio();
  context.currentTime = 10;
  const scheduled: ScheduledNote[] = [];
  let completions = 0;
  const playback = playPerformance(audio, {
    durationSeconds: 4,
    notes: [
      { startSeconds: 0, endSeconds: 1, midiPitch: 59, voice: "4", voiceId: "alto" },
      { startSeconds: 0, endSeconds: 3, midiPitch: 60, voice: "4", voiceId: "alto" },
      { startSeconds: 1, endSeconds: 2, midiPitch: 62, voice: "2" },
      { startSeconds: 1.5, endSeconds: 2.5, midiPitch: 63, voice: "3" },
      { startSeconds: 2, endSeconds: 3, midiPitch: 64, voice: "2" },
      { startSeconds: 2.25, endSeconds: 2.75, midiPitch: 67, voice: "1", voiceId: "alto" },
    ],
  }, () => { completions++; }, ["alto"], {
    startSeconds: 2,
    muted: ["alto"],
    onNote: (note) => scheduled.push(note),
  });
  assert.equal(playback.position(), 2);
  assert.equal(scheduled.length, 0);

  context.currentTime = 10.025;
  t.mock.timers.tick(25);
  assert.equal(playback.position(), 2);
  assert.deepEqual(scheduled, [
    { midiPitch: 60, startSeconds: 0, endSeconds: 3, voiceId: "alto", scoreVoice: "4",
      audioStartTime: 10.05, audioEndTime: 11.05 },
    { midiPitch: 63, startSeconds: 1.5, endSeconds: 2.5, voiceId: null, scoreVoice: "3",
      audioStartTime: 10.05, audioEndTime: 10.55 },
    { midiPitch: 64, startSeconds: 2, endSeconds: 3, voiceId: null, scoreVoice: "2",
      audioStartTime: 10.05, audioEndTime: 11.05 },
  ]);
  const [sustaining] = oscillators;
  const alto = sustaining.output?.output;
  assert.ok(alto instanceof FakeGain);
  assert.equal(alto.gain.value, 0);

  context.currentTime = 10.2;
  t.mock.timers.tick(25);
  assert.ok(Math.abs(playback.position() - 2.15) < 1e-9);
  assert.deepEqual(scheduled[3], {
    midiPitch: 67, startSeconds: 2.25, endSeconds: 2.75, voiceId: "alto", scoreVoice: "1",
    audioStartTime: 10.3, audioEndTime: 10.8,
  });
  assert.deepEqual(oscillators.map(({ onset }) => onset), scheduled.map((note) => note.audioStartTime));
  assert.deepEqual(oscillators.map(({ stops }) => stops), scheduled.map((note) => [note.audioEndTime]));
  playback.setVoiceMuted("alto", false);
  assert.deepEqual(alto.targets, [[1, 10.2]]);
  assert.equal(oscillators[0], sustaining);
  assert.equal(oscillators[3].output?.output, alto);

  for (const oscillator of oscillators) oscillator.dispatchEvent(new Event("ended"));
  context.currentTime = 12.04;
  t.mock.timers.tick(25);
  assert.equal(completions, 0);
  context.currentTime = 12.06;
  t.mock.timers.tick(50);
  assert.equal(playback.position(), 4);
  assert.equal(completions, 1);
});

test("accepts the exact movement end as a silent seek position", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { audio, context, oscillators } = fakeAudio();
  let completions = 0;
  const playback = playPerformance(audio, {
    durationSeconds: 2,
    notes: [{ startSeconds: 1, endSeconds: 2, midiPitch: 60, voice: "1" }],
  }, () => { completions++; }, [], {
    startSeconds: 2,
    onNote: () => assert.fail("The last note has already ended"),
  });
  assert.equal(playback.position(), 2);
  context.currentTime = 0.1;
  t.mock.timers.tick(100);
  assert.equal(playback.position(), 2);
  assert.equal(completions, 1);
  assert.deepEqual(oscillators, []);
});
