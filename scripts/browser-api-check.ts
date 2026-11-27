import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";

const packageName = "@mokele-mbembe/js-bach";
const fixturePath = "/browser-api-check/";

declare global {
  interface Window { jsBachApiAudio: { contexts: number; pitches: number[]; truncated: number } }
}

function checkConsumerImport(packageRoot: string): string {
  const cwd = dirname(packageRoot);
  const installed = join(cwd, "node_modules", packageName);
  mkdirSync(dirname(installed), { recursive: true });
  symlinkSync(packageRoot, installed, "junction");
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    Object.defineProperty(globalThis, "AudioContext", { get() { throw new Error("Touched Web Audio during import"); } });
    const { play, stop, getVoices, getPerformance } = await import(${JSON.stringify(packageName)});
    assert.equal(typeof play, "function");
    assert.equal(typeof stop, "function");
    const options = { movement: "fugue" };
    const voices = await getVoices("BWV846", options);
    const timeline = await getPerformance("bwv846", options);
    assert.deepEqual(voices.map(({ id }) => id), ["soprano", "alto", "tenor", "bass"]);
    assert.ok(Object.isFrozen(voices) && voices.every(Object.isFrozen));
    assert.ok(Object.isFrozen(timeline) && Object.isFrozen(timeline.notes) && timeline.notes.every(Object.isFrozen));
    assert.deepEqual(new Set(timeline.notes.map(({ voiceId }) => voiceId)), new Set(voices.map(({ id }) => id)));
    assert.equal(timeline.notes.at(-1).endSeconds, timeline.durationSeconds);
    assert.ok(timeline.notes.find(({ voiceId }) => voiceId === "bass").startSeconds > 16);
    const voices847 = await getVoices("bwv847", options);
    const timeline847 = await getPerformance("bwv847", options);
    assert.deepEqual(voices847.map(({ id }) => id), ["soprano", "alto", "bass"]);
    assert.deepEqual(voices847.map(({ id }) => timeline847.notes.filter(({ voiceId }) => voiceId === id).length),
      [266, 252, 236]);
    const bassEntrance = timeline847.notes.find(({ voiceId }) => voiceId === "bass");
    assert.equal(bassEntrance.scoreVoice, "10");
    assert.ok(bassEntrance.startSeconds > 19 && bassEntrance.startSeconds < 20);

    const timeline848 = await getPerformance("bwv848", options);
    assert.deepEqual((await getVoices("bwv848", options)).map(({ id }) => id), ["soprano", "alto", "bass"]);
    assert.deepEqual(timeline848.notes.filter(({ startSeconds, midiPitch }) =>
      midiPitch === 61 && startSeconds >= 127.1875 && startSeconds < 127.65625), [{
      midiPitch: 61, startSeconds: 127.1875, endSeconds: 127.65625, voiceId: "alto", scoreVoice: "2",
    }]);
  `], { cwd, stdio: "inherit" });
  writeFileSync(join(cwd, "consumer.ts"), `
    import { play, stop, getVoices, getPerformance, type PlayOptions, type Playback, type PerformanceTimeline, type Voice } from ${JSON.stringify(packageName)};
    const options: PlayOptions = { movement: "fugue", voice: "Bass" };
    const playback: Promise<Playback> = play("bwv846", options);
    void playback.then(handle => { handle.position(); handle.stop(); });
    void play("bwv846", options).then(handle => handle.setVoiceMuted("alto", true));
    const groups: Promise<readonly Voice[]> = getVoices("bwv846", options);
    const timeline: Promise<PerformanceTimeline> = getPerformance("bwv846", options);
    void timeline.then(({ notes }) => {
      // @ts-expect-error Performance event timing is readonly.
      notes[0].startSeconds = 0;
    });
    stop();
  `);
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
    "--moduleResolution", "Bundler", "consumer.ts"], { cwd, stdio: "inherit" });

  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const entry = manifest.exports?.["."]?.import;
  assert.equal(typeof entry, "string", "Missing package-root ESM export");
  return new URL(entry, `http://localhost${fixturePath}`).pathname;
}

export async function checkBrowserApi(browser: Browser, address: string, packageRoot: string): Promise<void> {
  const entry = checkConsumerImport(packageRoot);
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const waitForStatus = (status: string) => page.getByText(status, { exact: true }).waitFor();
  const movements: string[] = [];
  const slowPrelude = "**/bwv847-prelude.playback.json";
  let releaseSlow!: () => void;
  const pending = new Promise<void>((resolve) => { releaseSlow = resolve; });
  try {
    await page.addInitScript(() => {
      window.jsBachApiAudio = { contexts: 0, pitches: [], truncated: 0 };
      const audio = window.jsBachApiAudio;
      const OriginalContext = AudioContext;
      window.AudioContext = class extends OriginalContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          audio.contexts++;
        }
      };
      const start = OscillatorNode.prototype.start;
      const stop = OscillatorNode.prototype.stop;
      const stopTimes = new WeakMap<OscillatorNode, number>();
      OscillatorNode.prototype.start = function (when) {
        start.call(this, when);
        audio.pitches.push(Math.round(69 + 12 * Math.log2(this.frequency.value / 440)));
      };
      OscillatorNode.prototype.stop = function (when = 0) {
        stop.call(this, when);
        const previous = stopTimes.get(this);
        if (previous !== undefined && when < previous) audio.truncated++;
        stopTimes.set(this, when);
      };
    });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith(".playback.json")) movements.push(path.split("/").at(-1)!);
    });
    await page.route(`**${fixturePath}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path !== fixturePath) {
        assert.match(path, /^\/browser-api-check\/dist\/[\w./-]+\.(?:js|json)$/);
        await route.fulfill({ path: join(packageRoot, path.slice(fixturePath.length)),
          contentType: path.endsWith(".json") ? "application/json" : "text/javascript" });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <button id="prelude">Prelude</button><button id="bass">Bass</button><button id="slow">Slow</button>
        <button id="inspect">Inspect fugue</button><button id="stop">Stop</button><output id="status"></output>
        <script type="importmap">${JSON.stringify({ imports: { [packageName]: entry } })}</script>
        <script type="module">
          import { play, stop, getVoices, getPerformance } from ${JSON.stringify(packageName)};
          const element = id => document.getElementById(id);
          const status = element("status");
          function bind(id, start, finish) {
            element(id).onclick = async () => {
              try {
                const playback = await start();
                // Stop just after scheduling so this check does not depend on browser-driver timing.
                finish?.(playback);
                status.textContent = "Started " + id;
              }
              catch (error) { status.textContent = error.name; }
            };
          }
          bind("prelude", () => play("bwv846"), stop);
          bind("bass", () => play("bwv846", { movement: "fugue", voice: "Bass" }), handle => {
            handle.setVoiceMuted("bass", true);
            handle.setVoiceMuted("bass", false);
            handle.stop();
          });
          bind("inspect", async () => {
            const options = { movement: "fugue" };
            const [voices, timeline] = await Promise.all([getVoices("bwv846", options), getPerformance("bwv846", options)]);
            if (voices.length !== 4 || !timeline.notes.some(({ voiceId }) => voiceId === "bass")) throw new Error("Missing voices");
          });
          bind("slow", () => play("bwv847"));
          element("stop").onclick = () => { stop(); status.textContent = "Stopped"; };
          status.textContent = "Ready";
        </script>` });
    });
    await page.goto(new URL(fixturePath, address).href);
    await waitForStatus("Ready");
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.contexts), 0, "Import created an AudioContext");
    assert.deepEqual(movements, [], "Import loaded playback data");

    await page.locator("#prelude").click();
    await waitForStatus("Started prelude");
    assert.ok(await page.evaluate(() => window.jsBachApiAudio.pitches.length > 0), "The prelude should schedule audio");
    assert.deepEqual(movements, ["bwv846-prelude.playback.json"]);
    assert.ok(await page.evaluate(() => window.jsBachApiAudio.truncated > 0), "stop() should stop scheduled oscillators");

    await page.evaluate(() => { window.jsBachApiAudio.pitches = []; window.jsBachApiAudio.truncated = 0; });
    await page.locator("#inspect").click();
    await waitForStatus("Started inspect");
    assert.deepEqual(movements, ["bwv846-prelude.playback.json", "bwv846-fugue.playback.json"]);
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.pitches.length), 0, "Queries should not schedule audio");
    await page.locator("#bass").click();
    await waitForStatus("Started bass");
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.pitches[0]), 48, "BWV 846 fugue bass starts at C3");
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.contexts), 1, "Playback should reuse its AudioContext");
    assert.deepEqual(movements, ["bwv846-prelude.playback.json", "bwv846-fugue.playback.json"]);
    assert.ok(await page.evaluate(() => window.jsBachApiAudio.truncated > 0), "Stopping the handle should stop scheduled oscillators");

    await page.route(slowPrelude, async (route) => { await pending; await route.fallback(); }, { times: 1 });
    const [held] = await Promise.all([page.waitForRequest(slowPrelude), page.locator("#slow").click()]);
    await page.locator("#stop").click();
    await waitForStatus("AbortError");
    const played = await page.evaluate(() => window.jsBachApiAudio.pitches.length);
    releaseSlow();
    await page.evaluate(async (url) => { await import(url, { with: { type: "json" } }); }, held.url());
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.pitches.length), played, "A canceled import started playback");
    assert.deepEqual(movements, ["bwv846-prelude.playback.json", "bwv846-fugue.playback.json", "bwv847-prelude.playback.json"]);
  } finally {
    releaseSlow();
    await page.close();
  }
}
