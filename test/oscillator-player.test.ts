import assert from "node:assert/strict";
import test from "node:test";
import { playPerformance } from "../src/oscillator-player.js";

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
  readonly frequency = { value: 0 };

  connect(output: FakeGain): void { this.output = output; }
  disconnect(): void { this.output = undefined; }
  start(time: number): void { this.onset = time; }
  stop(): void {}
}

test("mutes sustaining and scheduled notes through their shared voice gain", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const oscillators: FakeOscillator[] = [];
  const context = {
    currentTime: 0,
    destination: new FakeGain(),
    createGain: () => new FakeGain(),
    createOscillator() {
      const oscillator = new FakeOscillator();
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  const voiceIds = ["Alto", "Soprano"];
  const playback = playPerformance(context as unknown as AudioContext, {
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
