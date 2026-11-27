import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";

interface RollFill {
  color: string;
  opacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScheduledOscillator {
  id: number;
  pitch: number;
  bus: number | null;
  start: number;
  stops: number[];
}

declare global {
  interface Window {
    jsBachRollProbe: {
      time: number;
      fills: RollFill[];
      oscillators: ScheduledOscillator[];
      gainChanges: { bus: number; target: number }[];
    };
  }
}

async function startClock(page: Page): Promise<number> {
  await page.locator("#play").click();
  await page.getByText("Playing Fugue", { exact: true }).waitFor();
  await page.evaluate(() => { window.jsBachRollProbe.time++; });
  await page.waitForFunction(() => document.querySelector<HTMLProgressElement>("#progress")!.value > 0);
  return page.evaluate(() => window.jsBachRollProbe.time - document.querySelector<HTMLProgressElement>("#progress")!.value);
}

async function renderAt(page: Page, origin: number, position: number): Promise<void> {
  await page.evaluate((time) => { window.jsBachRollProbe.time = time; }, origin + position);
  await page.waitForFunction((target) =>
    Math.abs(document.querySelector<HTMLProgressElement>("#progress")!.value - target) < 1e-8, position);
  const { actual, expectedX } = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#polyphony canvas")!;
    const progress = document.querySelector<HTMLProgressElement>("#progress")!;
    // The recorded fillRect arguments and the plot insets are in CSS pixels.
    const expectedX = 34 + (canvas.clientWidth - 34 - 8) * progress.value / progress.max;
    return { actual: window.jsBachRollProbe.fills.at(-1), expectedX };
  });
  assert.equal(actual?.color, "#f5f5eb", "The last Canvas fill should be the white playhead");
  assert.ok(Math.abs(actual.x - expectedX) <= 1,
    `Canvas playhead at ${actual.x}px should match the ${position}s transport position at ${expectedX}px`);
}

async function scheduledNote(page: Page, origin: number, pitch: number, onset: number, release: number) {
  const handle = await page.waitForFunction(({ pitch, start, end }) => {
    const matches = window.jsBachRollProbe.oscillators.filter((oscillator) =>
      oscillator.pitch === pitch && Math.abs(oscillator.start - start) < 1e-7 &&
      oscillator.stops.some((stop) => Math.abs(stop - end) < 1e-7),
    );
    return matches.length > 0 ? matches : false;
  }, { pitch, start: origin + onset, end: origin + release });
  const matches = await handle.jsonValue();
  await handle.dispose();
  assert.ok(matches);
  assert.equal(matches.length, 1, `Expected one MIDI ${pitch} oscillator for ${onset}–${release}s`);
  assert.equal(matches[0].stops.length, 1, `Expected one scheduled release for MIDI ${pitch}`);
  assert.notEqual(matches[0].bus, null, `Expected a voice gain bus for MIDI ${pitch}`);
  return matches[0];
}

async function takeGainChanges(page: Page) {
  return page.evaluate(() => window.jsBachRollProbe.gainChanges.splice(0));
}

async function voiceColors(page: Page): Promise<Map<string, string>> {
  const colors = await page.locator("#mute-choices label").evaluateAll((labels: HTMLLabelElement[]) =>
    labels.map((label): [string, string] => [
      label.querySelector("input")!.value,
      label.style.getPropertyValue("--voice-color"),
    ]));
  return new Map(colors);
}

async function stripe(page: Page, color: string, opacity: number): Promise<RollFill> {
  const fills = await page.evaluate((color) =>
    window.jsBachRollProbe.fills.filter((fill) => fill.color === color), color);
  assert.equal(fills.length, 1, `Expected one active stripe for ${color}`);
  assert.equal(fills[0].opacity, opacity);
  return fills[0];
}

async function assertNoHighlights(page: Page, colors: Map<string, string>): Promise<void> {
  const drawn = await page.evaluate(() => window.jsBachRollProbe.fills.map(({ color }) => color));
  for (const color of colors.values()) assert.ok(!drawn.includes(color), `Stopped roll still highlights ${color}`);
}

export async function checkPianoRoll(browser: Browser, address: string): Promise<void> {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const panel = page.locator("#polyphony");
  const altoMute = panel.getByText("Mute Alto", { exact: true });
  const stop = () => page.locator("#stop").click();
  const selectFugue = async (bwv: number) => {
    await page.locator("#works").getByText(new RegExp(`^BWV ${bwv} · `)).click();
    await panel.getByRole("heading", { name: `BWV ${bwv} fugue · piano roll` }).waitFor();
  };

  try {
    await page.addInitScript(() => {
      const probe: Window["jsBachRollProbe"] = { time: 0, fills: [], oscillators: [], gainChanges: [] };
      window.jsBachRollProbe = probe;
      const OriginalContext = AudioContext;
      // Advance the demo's actual playback clock without waiting through each movement.
      window.AudioContext = class extends OriginalContext {
        override get currentTime(): number { return probe.time; }
      };

      const outputs = new WeakMap<AudioNode, AudioNode>();
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (this: AudioNode, destination: AudioNode | AudioParam) {
        const result = Reflect.apply(connect, this, arguments);
        if (destination instanceof AudioNode) outputs.set(this, destination);
        return result;
      };
      const buses = new WeakMap<AudioParam, number>();
      let nextBus = 0;
      function busId(gain: AudioParam): number {
        if (!buses.has(gain)) buses.set(gain, nextBus++);
        return buses.get(gain)!;
      }
      const setTarget = AudioParam.prototype.setTargetAtTime;
      AudioParam.prototype.setTargetAtTime = function (target, time, timeConstant) {
        const result = setTarget.call(this, target, time, timeConstant);
        probe.gainChanges.push({ bus: busId(this), target });
        return result;
      };

      const oscillators = new WeakMap<OscillatorNode, ScheduledOscillator>();
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (when = 0) {
        start.call(this, when);
        const envelope = outputs.get(this);
        const voice = envelope && outputs.get(envelope);
        const scheduled = {
          id: probe.oscillators.length,
          pitch: Math.round(69 + 12 * Math.log2(this.frequency.value / 440)),
          bus: voice instanceof GainNode ? busId(voice.gain) : null,
          start: when,
          stops: [],
        };
        oscillators.set(this, scheduled);
        probe.oscillators.push(scheduled);
      };
      const stop = OscillatorNode.prototype.stop;
      OscillatorNode.prototype.stop = function (when = 0) {
        stop.call(this, when);
        oscillators.get(this)?.stops.push(when);
      };

      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function () {
        if (this.canvas.matches("#polyphony canvas")) probe.fills = [];
        Reflect.apply(drawImage, this, arguments);
      };
      const fillRect = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
        if (this.canvas.matches("#polyphony canvas") && typeof this.fillStyle === "string") {
          probe.fills.push({ color: this.fillStyle, opacity: this.globalAlpha, x, y, width, height });
        }
        fillRect.call(this, x, y, width, height);
      };
    });

    await page.goto(address);
    await page.getByText("Fugue", { exact: true }).click();
    await panel.getByRole("heading", { name: "BWV 846 fugue · piano roll" }).waitFor();
    const colors846 = await voiceColors(page);
    const origin846 = await startClock(page);
    // Enter the scheduler's lookahead before the shared C4 attack.
    await renderAt(page, origin846, 12.65);
    const altoC4 = await scheduledNote(page, origin846, 60, 12.727272727, 13.181818182);
    const tenorC4 = await scheduledNote(page, origin846, 60, 12.727272727, 13.409090909);
    assert.notEqual(altoC4.bus, tenorC4.bus, "Same-pitch Alto and Tenor must use separate gain buses");
    await renderAt(page, origin846, 12.8);
    // Alto and Tenor both enter on C4 at 12.727... s, with different release times.
    const alto846 = await stripe(page, colors846.get("alto")!, 1);
    const tenor846 = await stripe(page, colors846.get("tenor")!, 1);
    assert.equal(alto846.x, tenor846.x);
    assert.ok(alto846.y + alto846.height <= tenor846.y || tenor846.y + tenor846.height <= alto846.y,
      "Simultaneous unison voices must retain separate visible bands");
    await altoMute.click();
    assert.deepEqual(await stripe(page, alto846.color, 0.26), { ...alto846, opacity: 0.26 });
    assert.deepEqual(await stripe(page, tenor846.color, 1), tenor846);
    assert.deepEqual(await takeGainChanges(page), [{ bus: altoC4.bus, target: 0 }], "Only the Alto C4 gain should mute");
    await altoMute.click();
    assert.deepEqual(await stripe(page, alto846.color, 1), alto846);
    assert.deepEqual(await takeGainChanges(page), [{ bus: altoC4.bus, target: 1 }], "Only the Alto C4 gain should restore");
    await stop();
    await assertNoHighlights(page, colors846);

    await selectFugue(848);
    const colors848 = await voiceColors(page);
    const origin848 = await startClock(page);
    // The C-sharp 4 span attacks under score voice 2 and continues under 6 at 127.5 s.
    await renderAt(page, origin848, 127.1);
    const tiedCSharp = await scheduledNote(page, origin848, 61, 127.1875, 127.65625);
    await renderAt(page, origin848, 127.3);
    const alto848 = await stripe(page, colors848.get("alto")!, 1);
    await altoMute.click();
    assert.deepEqual(await takeGainChanges(page), [{ bus: tiedCSharp.bus, target: 0 }], "The tied Alto C-sharp gain should mute");
    await renderAt(page, origin848, 127.6);
    assert.deepEqual(await stripe(page, alto848.color, 0.26), { ...alto848, opacity: 0.26 });
    await altoMute.click();
    assert.deepEqual(await stripe(page, alto848.color, 1), alto848);
    assert.deepEqual(await takeGainChanges(page), [{ bus: tiedCSharp.bus, target: 1 }], "The same tied Alto C-sharp gain should restore");
    await renderAt(page, origin848, 127.66);
    assert.notEqual((await stripe(page, alto848.color, 1)).y, alto848.y,
      "The cross-number tie highlight must release before the following Alto note");
    // Observe a new Alto note entering the scheduler after restoration before inspecting the tie.
    await renderAt(page, origin848, 127.75);
    const laterAlto = await scheduledNote(page, origin848, 58, 127.8125, 127.96875);
    assert.equal(laterAlto.bus, tiedCSharp.bus, "Score voice 6 should continue on the original Alto bus");
    const tiedOscillators = await page.evaluate((origin) => window.jsBachRollProbe.oscillators.filter(({ pitch, start }) =>
      pitch === 61 && start >= origin + 127 && start < origin + 128), origin848);
    assert.deepEqual(tiedOscillators, [tiedCSharp], "Restoring Alto must not restart or truncate the original C-sharp 4 oscillator");

    await selectFugue(849);
    const colors849 = await voiceColors(page);
    assert.deepEqual([...colors849.keys()], ["soprano", "alto", "tenor", "baritone", "bass"]);
    assert.equal(new Set(colors849.values()).size, 5);
    assert.ok(![...colors849.values()].includes("#f5f5eb"), "All five voices must differ from the playhead");
    await assertNoHighlights(page, colors849);
    const origin849 = await startClock(page);
    await renderAt(page, origin849, 7);
    const baritone = await stripe(page, colors849.get("baritone")!, 1);
    await panel.getByText("Mute Baritone", { exact: true }).click();
    assert.deepEqual(await stripe(page, baritone.color, 0.26), { ...baritone, opacity: 0.26 });
    await page.getByText("Baritone", { exact: true }).click();
    const previousOscillators = await page.evaluate(() => window.jsBachRollProbe.oscillators.length);
    await page.locator("#play").click();
    await page.getByText("Playing Fugue · Baritone", { exact: true }).waitFor();
    assert.equal(await page.evaluate((index) => window.jsBachRollProbe.oscillators[index]?.pitch, previousOscillators),
      56, "The Baritone solo should start on G-sharp 3");
    await stop();
  } finally {
    await page.close();
  }
}
