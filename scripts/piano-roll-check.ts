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

declare global {
  interface Window {
    jsBachRollProbe: { time: number; fills: RollFill[]; pitches: number[] };
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
      const probe: Window["jsBachRollProbe"] = { time: 0, fills: [], pitches: [] };
      window.jsBachRollProbe = probe;
      const OriginalContext = AudioContext;
      // Advance the demo's actual playback clock without waiting through each movement.
      window.AudioContext = class extends OriginalContext {
        override get currentTime(): number { return probe.time; }
      };
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (when) {
        start.call(this, when);
        probe.pitches.push(Math.round(69 + 12 * Math.log2(this.frequency.value / 440)));
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
    await altoMute.click();
    assert.deepEqual(await stripe(page, alto846.color, 1), alto846);
    await stop();
    await assertNoHighlights(page, colors846);

    await selectFugue(848);
    const colors848 = await voiceColors(page);
    const origin848 = await startClock(page);
    // The C-sharp 4 span attacks under score voice 2 and continues under 6 at 127.5 s.
    await renderAt(page, origin848, 127.3);
    const alto848 = await stripe(page, colors848.get("alto")!, 1);
    await altoMute.click();
    await renderAt(page, origin848, 127.6);
    assert.deepEqual(await stripe(page, alto848.color, 0.26), { ...alto848, opacity: 0.26 });
    await altoMute.click();
    assert.deepEqual(await stripe(page, alto848.color, 1), alto848);
    await renderAt(page, origin848, 127.66);
    assert.notEqual((await stripe(page, alto848.color, 1)).y, alto848.y,
      "The cross-number tie highlight must release before the following Alto note");

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
    await page.evaluate(() => { window.jsBachRollProbe.pitches = []; });
    await page.locator("#play").click();
    await page.getByText("Playing Fugue · Baritone", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.jsBachRollProbe.pitches[0]), 56, "The Baritone solo should start on G-sharp 3");
    await stop();
  } finally {
    await page.close();
  }
}
