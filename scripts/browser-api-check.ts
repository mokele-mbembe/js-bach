import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright";
import type { ScheduledNote } from "../src/oscillator-player.js";
import type { PerformanceEvent } from "../src/playback-asset.js";

const packageName = "@mokele-mbembe/js-bach";
const fixturePath = "/browser-api-check/";
const seekTempoRate = 1.5;
const seekTranspose = 5;

interface OscillatorStart {
  onset: number;
  scheduledAt: number;
  end?: number;
  voiceGain?: number;
  voicePan?: number;
}

declare global {
  interface Window {
    jsBachApiAudio: {
      contexts: number;
      pitches: number[];
      truncated: number;
      starts: OscillatorStart[];
      notes: ScheduledNote[];
      expected?: PerformanceEvent;
      nextStartSeconds?: number;
      seek?: { startSeconds: number; position(): number };
      readPan?(): number;
      callbackFailure?: { position: number; audioTime: number; callbacks: number; oscillators: number };
      callbackPosition?(): number;
      clock(): number;
    };
  }
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
    import { play, stop, getVoices, getPerformance, type MixedPlayback, type PlayOptions, type Playback, type PerformanceTimeline, type ScheduledNote, type Voice } from ${JSON.stringify(packageName)};
    const muted: readonly string[] = ["Bass"];
    const onNote = (note: ScheduledNote) => {
      const voiceId: string | null = note.voiceId;
      const scoreVoice: string = note.scoreVoice;
      const pitch: number = note.midiPitch;
      const unvoiced: ScheduledNote = { ...note, voiceId: null };
      const times: number[] = [note.startSeconds, note.endSeconds, note.audioStartTime, note.audioEndTime];
      // @ts-expect-error Scheduled event timing is readonly.
      note.audioStartTime = 0;
    };
    const pan: Readonly<Record<string, number>> = { Bass: 0.5 };
    const options: PlayOptions = {
      movement: "fugue", voice: "Bass", muted, onNote, pan, startSeconds: 0.125, tempoRate: 1.5, transpose: 5,
    };
    const playback: Promise<MixedPlayback> = play("bwv846", options);
    void playback.then(handle => { handle.position(); handle.stop(); });
    void playback.then(handle => { handle.setVoiceMuted("Bass", true); handle.setVoicePan("bass", -1); });
    const plainPlayback: Promise<Playback> = playback;
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

async function checkRenderedPanLevels(page: Page): Promise<void> {
  const { mono, stereo, left, right, recentered } = await page.evaluate(async () => {
    const url = new URL("./dist/src/oscillator-player.js", location.href).href;
    const { playPerformance } = await import(url) as typeof import("../src/oscillator-player.js");
    const sampleRate = 48_000;
    const performance = { durationSeconds: 0.5, notes: [
      { midiPitch: 69, voice: "1", voiceId: "alto", startSeconds: 0, endSeconds: 0.45 },
    ] };
    async function render(channels: number, route: "direct" | "center" | "fallback" | "left" | "right" | "recenter") {
      const context = new OfflineAudioContext(channels, sampleRate / 4, sampleRate);
      if (route === "fallback") Object.defineProperty(context, "createStereoPanner", { value: undefined });
      const voiceIds = route === "direct" ? [] : ["alto"];
      const pan = route === "right" ? { alto: 1 }
        : route === "left" || route === "fallback" || route === "recenter" ? { alto: -1 } : undefined;
      // The scheduler uses the Web Audio graph and clock shared by both context types.
      const playback = playPerformance(context as unknown as AudioContext, performance, () => {}, voiceIds, { pan });
      try {
        const recenter = route === "recenter" ? context.suspend(0.1).then(async () => {
          playback.setVoicePan("alto", 0);
          await context.resume();
        }) : undefined;
        const [audio] = await Promise.all([context.startRendering(), recenter]);
        return Array.from({ length: channels }, (_, channel) => {
          // Sample the sustained tone after the fade-in and any live pan transition.
          const samples = audio.getChannelData(channel).subarray(sampleRate * 0.19, sampleRate * 0.23);
          return Math.sqrt(samples.reduce((sum, sample) => sum + sample ** 2, 0) / samples.length);
        });
      } finally {
        playback.stop();
      }
    }
    const levels = async (channels: number) => ({
      direct: await render(channels, "direct"),
      center: await render(channels, "center"),
      fallback: await render(channels, "fallback"),
    });
    return {
      mono: await levels(1), stereo: await levels(2),
      left: await render(2, "left"), right: await render(2, "right"), recentered: await render(2, "recenter"),
    };
  });
  for (const [output, { direct, center, fallback }] of [["Mono", mono], ["Stereo", stereo]] as const) {
    direct.forEach((level, channel) => {
      assert.ok(level > 0.01, `${output} direct route must produce audible samples`);
      assert.ok(Math.abs(center[channel] / level - 1) < 0.002, `${output} centered pan must match direct RMS`);
      assert.ok(Math.abs(fallback[channel] / level - 1) < 0.002, `${output} fallback must preserve direct RMS`);
    });
  }
  assert.ok(left[0] > 0.01 && left[1] < 0.000_001, "Hard-left pan must silence the right channel");
  assert.ok(right[1] > 0.01 && right[0] < 0.000_001, "Hard-right pan must silence the left channel");
  const stereoRms = Math.hypot(...stereo.direct);
  for (const endpoint of [left, right]) {
    assert.ok(Math.abs(Math.hypot(...endpoint) / stereoRms - 1) < 0.002, "Hard pan must preserve total stereo RMS");
  }
  recentered.forEach((level, channel) => {
    assert.ok(Math.abs(level / stereo.direct[channel] - 1) < 0.002, "Live recentering must restore direct RMS");
  });
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
      window.jsBachApiAudio = { contexts: 0, pitches: [], truncated: 0, starts: [], notes: [], clock: () => 0 };
      const audio = window.jsBachApiAudio;
      const OriginalContext = AudioContext;
      window.AudioContext = class extends OriginalContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          audio.contexts++;
          audio.clock = () => this.currentTime;
        }
      };
      const outputs = new WeakMap<AudioNode, AudioNode>();
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (this: AudioNode, destination: AudioNode | AudioParam) {
        if (destination instanceof AudioNode) outputs.set(this, destination);
        return Reflect.apply(connect, this, arguments);
      } as typeof connect;
      const start = OscillatorNode.prototype.start;
      const stop = OscillatorNode.prototype.stop;
      const stopTimes = new WeakMap<OscillatorNode, number>();
      const starts = new WeakMap<OscillatorNode, OscillatorStart>();
      OscillatorNode.prototype.start = function (when = 0) {
        start.call(this, when);
        audio.pitches.push(Math.round(69 + 12 * Math.log2(this.frequency.value / 440)));
        const envelope = outputs.get(this);
        const voice = envelope && outputs.get(envelope);
        const panner = voice && outputs.get(voice);
        const voiceGain = voice instanceof GainNode ? voice.gain.value : undefined;
        const voicePan = panner instanceof StereoPannerNode ? panner.pan.value : undefined;
        if (panner instanceof StereoPannerNode) audio.readPan = () => panner.pan.value;
        const started = { onset: when, scheduledAt: this.context.currentTime, voiceGain, voicePan };
        starts.set(this, started);
        audio.starts.push(started);
      };
      OscillatorNode.prototype.stop = function (when = 0) {
        stop.call(this, when);
        const started = starts.get(this);
        if (started) started.end ??= when;
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
        <button id="scheduled">Schedule and stop</button><button id="invalid-mute">Check invalid mute</button>
        <button id="seek">Seek with tempo and transposition</button><button id="invalid-mix">Check invalid playback options</button>
        <button id="rejecting">Reject callback</button>
        <button id="inspect">Inspect fugue</button><button id="stop">Stop</button><output id="status"></output>
        <script type="importmap">${JSON.stringify({ imports: { [packageName]: entry } })}</script>
        <script type="module">
          import { play, stop, getVoices, getPerformance } from ${JSON.stringify(packageName)};
          const element = id => document.getElementById(id);
          const status = element("status");
          const audio = window.jsBachApiAudio;
          async function expectRangeError(action) {
            try { await action(); }
            catch (error) {
              if (error instanceof RangeError) return;
              throw error;
            }
            throw new Error("Expected a RangeError");
          }
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
            handle.setVoiceMuted("Bass", true);
            handle.setVoiceMuted("bass", false);
            handle.stop();
          });
          bind("scheduled", async () => {
            const options = { movement: "fugue", voice: "bass", muted: ["Bass"] };
            const { notes } = await getPerformance("bwv846", options);
            const [first, second] = notes.filter(({ voiceId }) => voiceId === "bass");
            audio.expected = { ...first, startSeconds: 0, endSeconds: first.endSeconds - first.startSeconds };
            audio.nextStartSeconds = second.startSeconds - first.startSeconds;
            await new Promise((resolve, reject) => {
              let handle;
              play("bwv846", { ...options, onNote(note) {
                audio.notes.push(note);
                try {
                  handle.setVoiceMuted("Bass", false);
                  stop();
                  resolve();
                } catch (error) { reject(error); }
              } }).then(playback => { handle = playback; }, reject);
            });
          });
          bind("invalid-mute", async () => {
            const options = { movement: "fugue", voice: "Bass" };
            await expectRangeError(() => play("bwv846", { movement: "fugue", muted: ["Missing"] }));
            await expectRangeError(() => play("bwv846", { ...options, muted: ["Alto"] }));
            const handle = await play("bwv846", options);
            try { await expectRangeError(() => handle.setVoiceMuted("alto", true)); }
            finally { handle.stop(); }
          });
          bind("seek", async () => {
            const options = { movement: "fugue", voice: "Bass" };
            const { notes } = await getPerformance("bwv846", options);
            const first = notes.find(({ voiceId }) => voiceId === "bass");
            audio.expected = first;
            const startSeconds = (first.startSeconds + first.endSeconds) / 2;
            let handle;
            await new Promise((resolve, reject) => {
              play("bwv846", { ...options, startSeconds, tempoRate: ${seekTempoRate}, transpose: ${seekTranspose},
                pan: { Bass: -0.75 }, onNote(note) {
                audio.notes.push(note);
                if (audio.notes.length === 1) {
                  try { handle.setVoicePan("bass", 0.5); resolve(); }
                  catch (error) { reject(error); }
                }
              } }).then(playback => {
                handle = playback;
                audio.seek = { startSeconds, position: handle.position };
              }, reject);
            });
          });
          bind("invalid-mix", async () => {
            const options = { movement: "fugue", voice: "bass" };
            await expectRangeError(() => play("bwv846", { ...options, pan: { Alto: 0 } }));
            await expectRangeError(() => play("bwv846", { ...options, pan: { Bass: Infinity } }));
            await expectRangeError(() => play("bwv846", { ...options, pan: { bass: 2, Bass: 0 } }));
            await expectRangeError(() => play("bwv846", { ...options, startSeconds: -1 }));
            await expectRangeError(() => play("bwv846", { ...options, startSeconds: 1000 }));
            for (const tempoRate of [0, 0.49, 2.01, Infinity, NaN]) {
              await expectRangeError(() => play("bwv846", { ...options, tempoRate }));
            }
            for (const transpose of [-13, 13, 0.5, Infinity, NaN]) {
              await expectRangeError(() => play("bwv846", { ...options, transpose }));
            }
            const handle = await play("bwv846", { ...options, pan: { bass: -1 } });
            try {
              handle.setVoicePan("Bass", 1);
              await expectRangeError(() => handle.setVoicePan("Alto", 0));
              await expectRangeError(() => handle.setVoicePan("bass", 1.1));
              await expectRangeError(() => handle.setVoicePan("bass", NaN));
            } finally { handle.stop(); }
          });
          bind("rejecting", async () => {
            const failure = new Error("Scheduled callback rejected");
            const handle = await play("bwv846", { movement: "fugue", voice: "Bass", async onNote(note) {
              audio.notes.push(note);
              if (audio.notes.length === 1) throw failure;
            } });
            audio.callbackPosition = () => handle.position();
            window.addEventListener("error", event => {
              if (event.error === failure) {
                audio.callbackFailure = { position: handle.position(), audioTime: audio.clock(),
                  callbacks: audio.notes.length, oscillators: audio.starts.length };
              }
            }, { once: true });
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

    await page.evaluate(() => {
      window.jsBachApiAudio.starts = [];
      window.jsBachApiAudio.truncated = 0;
    });
    await page.locator("#scheduled").click();
    await waitForStatus("Started scheduled");
    const scheduled = await page.evaluate(() => {
      const { notes, starts, nextStartSeconds, expected, truncated } = window.jsBachApiAudio;
      return { notes, starts, nextStartSeconds, expected, truncated };
    });
    assert.equal(scheduled.notes.length, 1);
    assert.equal(scheduled.starts.length, 1);
    const [{ audioStartTime, audioEndTime, ...event }] = scheduled.notes;
    const [{ onset, scheduledAt, end, voiceGain }] = scheduled.starts;
    assert.deepEqual(event, scheduled.expected, "The callback should report the rebased solo timeline");
    assert.equal(audioStartTime, onset);
    assert.equal(audioEndTime, end);
    assert.ok(audioStartTime - scheduledAt < 0.15, "onNote should follow the scheduler's lookahead");
    assert.equal(voiceGain, 0, "The voice should already have zero gain when its first oscillator is scheduled");
    assert.equal(scheduled.truncated, 1, "stop() from onNote should truncate the scheduled oscillator");
    assert.ok(scheduled.nextStartSeconds && scheduled.nextStartSeconds > 0);
    await page.waitForFunction((past) => window.jsBachApiAudio.clock() >= past, audioStartTime + scheduled.nextStartSeconds);
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.notes.length), 1, "No callbacks should fire after stop()");
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.starts.length), 1, "No oscillators should start after stop()");

    await page.locator("#invalid-mute").click();
    await waitForStatus("Started invalid-mute");

    await page.evaluate(() => {
      window.jsBachApiAudio.notes = [];
      window.jsBachApiAudio.starts = [];
      window.jsBachApiAudio.pitches = [];
      window.jsBachApiAudio.readPan = undefined;
    });
    await page.locator("#seek").click();
    await waitForStatus("Started seek");
    const seek = await page.evaluate(() => {
      const { notes, starts, pitches, expected, seek } = window.jsBachApiAudio;
      return { note: notes[0], oscillator: starts[0], pitch: pitches[0], expected, start: seek!.startSeconds };
    });
    const { audioStartTime: seekOnset, audioEndTime: seekEnd, ...seekEvent } = seek.note;
    assert.ok(seek.expected);
    assert.deepEqual(seekEvent, { ...seek.expected, midiPitch: seek.expected.midiPitch + seekTranspose },
      "A transformed solo seek must report the sounding pitch on the original movement timeline");
    assert.equal(seekEvent.midiPitch, seek.pitch, "The callback must report the actual oscillator pitch");
    assert.equal(seekOnset, seek.oscillator.onset);
    assert.equal(seekEnd, seek.oscillator.end);
    const seekAnchor = seekEnd - (seekEvent.endSeconds - seek.start) / seekTempoRate;
    assert.ok(Math.abs(seekOnset - Math.max(seekAnchor, seek.oscillator.scheduledAt)) < 0.015,
      "A note spanning the seek point should start on the new audio anchor, or immediately if scheduling is late");
    assert.equal(seek.oscillator.voicePan, -0.75, "The panner must apply the initial value before the oscillator starts");
    await page.waitForFunction(({ anchor, start, rate }) => {
      const { clock, seek, readPan } = window.jsBachApiAudio;
      const elapsed = clock() - anchor;
      return elapsed >= 0.05 && Math.abs(seek!.position() - start - elapsed * rate) < 0.015 &&
        Math.abs((readPan?.() ?? 0) - 0.5) < 0.01;
    }, { anchor: seekAnchor, start: seek.start, rate: seekTempoRate });
    await page.locator("#invalid-mix").click();
    await waitForStatus("Started invalid-mix");

    await page.evaluate(() => {
      window.jsBachApiAudio.notes = [];
      window.jsBachApiAudio.starts = [];
    });
    const [uncaught] = await Promise.all([page.waitForEvent("pageerror"), page.locator("#rejecting").click()]);
    assert.equal(uncaught.message, "Scheduled callback rejected");
    await waitForStatus("Started rejecting");
    const failure = await page.evaluate(() => window.jsBachApiAudio.callbackFailure);
    assert.ok(failure, "The original rejection should surface as a browser error");
    assert.ok(failure.callbacks > 0);
    await page.waitForFunction((past) => window.jsBachApiAudio.clock() >= past,
      failure.audioTime + scheduled.nextStartSeconds);
    assert.deepEqual(await page.evaluate(() => {
      const { notes, starts, callbackPosition } = window.jsBachApiAudio;
      return { callbacks: notes.length, oscillators: starts.length, position: callbackPosition?.() };
    }), { callbacks: failure.callbacks, oscillators: failure.oscillators, position: failure.position },
    "An async callback rejection should stop scheduling and freeze the playback handle");

    await page.route(slowPrelude, async (route) => { await pending; await route.fallback(); }, { times: 1 });
    const [held] = await Promise.all([page.waitForRequest(slowPrelude), page.locator("#slow").click()]);
    await page.locator("#stop").click();
    await waitForStatus("AbortError");
    const played = await page.evaluate(() => window.jsBachApiAudio.pitches.length);
    releaseSlow();
    await page.evaluate(async (url) => { await import(url, { with: { type: "json" } }); }, held.url());
    assert.equal(await page.evaluate(() => window.jsBachApiAudio.pitches.length), played, "A canceled import started playback");
    assert.deepEqual(movements, ["bwv846-prelude.playback.json", "bwv846-fugue.playback.json", "bwv847-prelude.playback.json"]);
    await checkRenderedPanLevels(page);
  } finally {
    releaseSlow();
    await page.close();
  }
}
