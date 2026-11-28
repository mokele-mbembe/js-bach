import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page, type Request } from "playwright";
import { checkBrowserApi } from "./browser-api-check.js";
import { checkPianoRoll } from "./piano-roll-check.js";
import { checkPreviewRaces } from "./preview-races.js";

interface PackedPreview {
  name: string;
  version: string;
  filename: string;
  unpackedSize: number;
}

declare global {
  interface Window {
    jsBachOscillatorStarts: number;
    jsBachVoiceGainChanges: { bus: number; target: number; initialGain?: number }[];
  }
}

const entry = "dist/scripts/serve-demo.js";
const catalog = "/corpus/catalog.json";
const prelude = "/corpus/bwv846/bwv846-prelude.playback.json";
const fugue = "/corpus/bwv846/bwv846-fugue.playback.json";
const fugue847 = "/corpus/bwv847/bwv847-fugue.playback.json";
const fugue848 = "/corpus/bwv848/bwv848-fugue.playback.json";
const repeatPrelude = "/corpus/bwv869/bwv869-prelude.playback.json";

async function measure(requests: Request[]) {
  const sizes = await Promise.all(requests.map(async (request) => {
    const response = await request.response();
    assert.ok(response?.ok(), `Failed first-play request: ${request.url()}`);
    return request.sizes();
  }));
  const body = sizes.reduce((total, size) => total + size.responseBodySize, 0);
  const headers = sizes.reduce((total, size) => total + size.responseHeadersSize, 0);
  return { count: requests.length, body, transfer: body + headers };
}

async function play(page: Page, title: string): Promise<void> {
  await page.evaluate(() => { window.jsBachOscillatorStarts = 0; });
  await page.locator("#play").click();
  await page.getByText(`Playing ${title}`, { exact: true }).waitFor();
  await page.waitForFunction(() => window.jsBachOscillatorStarts > 0);
}

async function checkDemo(address: string, packageRoot: string) {
  const browser = await chromium.launch({ channel: process.env.JS_BACH_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.addInitScript(() => {
      window.jsBachOscillatorStarts = 0;
      window.jsBachVoiceGainChanges = [];
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (when) {
        start.call(this, when);
        window.jsBachOscillatorStarts++;
      };
      const masters = new WeakSet<GainNode>();
      const initialGains = new WeakMap<AudioParam, number>();
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (this: AudioNode, destination: AudioNode | AudioParam) {
        if (this instanceof GainNode) {
          if (destination === this.context.destination) masters.add(this);
          else if (destination instanceof StereoPannerNode || (destination instanceof GainNode && masters.has(destination))) {
            initialGains.set(this.gain, this.gain.value);
          }
        }
        return Reflect.apply(connect, this, arguments);
      } as typeof connect;
      const buses = new WeakMap<AudioParam, number>();
      const setTarget = AudioParam.prototype.setTargetAtTime;
      AudioParam.prototype.setTargetAtTime = function (target, time, timeConstant) {
        const initialGain = initialGains.get(this);
        if (initialGain !== undefined) {
          if (!buses.has(this)) buses.set(this, window.jsBachVoiceGainChanges.length);
          window.jsBachVoiceGainChanges.push({ bus: buses.get(this)!, target, initialGain });
        }
        return setTarget.call(this, target, time, timeConstant);
      };
    });
    const requests: Request[] = [];
    page.on("request", (request) => requests.push(request));
    const scoreRequests = () => requests.filter((request) => new URL(request.url()).pathname.startsWith("/corpus/"));
    const scorePaths = () => scoreRequests().map((request) => new URL(request.url()).pathname);

    await page.goto(address);
    await play(page, "Prelude");
    assert.deepEqual(scorePaths(), [catalog, prelude], "Cold playback should request only the catalog and BWV 846 prelude");
    const [firstPlay, firstScore] = await Promise.all([measure(requests.slice()), measure(scoreRequests())]);
    assert.equal(firstPlay.count, 7, "The cold prelude should play in seven page requests");
    assert.ok(requests.every((request) => !request.url().endsWith("/demo/polyphony.js")),
      "The piano roll should load only when its fugue is selected");

    await page.getByText("Fugue", { exact: true }).click();
    const panel = page.locator("#polyphony");
    await panel.waitFor();
    assert.equal(await panel.getByRole("checkbox").count(), 4);
    assert.equal(await panel.locator("#fugue-entrances li").count(), 4);
    await play(page, "Fugue");
    const timeline = () => page.locator("#progress").evaluate((progress: HTMLProgressElement) => ({
      value: progress.value, max: progress.max,
    }));
    await page.waitForFunction(() => document.querySelector<HTMLProgressElement>("#progress")!.value > 0.5);
    const beforeMute = await timeline();
    await panel.getByText("Mute Alto", { exact: true }).click();
    assert.ok(await panel.getByRole("checkbox", { name: "Mute Alto" }).isChecked());
    const muted = await timeline();
    assert.ok(muted.value >= beforeMute.value);
    await page.waitForFunction((value) => document.querySelector<HTMLProgressElement>("#progress")!.value > value, muted.value);
    await panel.getByText("Mute Alto", { exact: true }).click();
    assert.ok(!await panel.getByRole("checkbox", { name: "Mute Alto" }).isChecked());
    assert.equal(await page.locator("#status").textContent(), "Playing Fugue");
    const afterRestore = await timeline();
    assert.ok(afterRestore.value > muted.value);
    assert.equal(afterRestore.max, beforeMute.max);
    assert.deepEqual(await page.evaluate(() => window.jsBachVoiceGainChanges), [
      { bus: 0, target: 0, initialGain: 1 }, { bus: 0, target: 1, initialGain: 1 },
    ]);
    await page.locator("#stop").click();

    for (const voice of ["Soprano", "Alto", "Tenor", "Bass"]) {
      await page.getByText(voice, { exact: true }).click();
      assert.ok(!await panel.isVisible());
      await play(page, `Fugue · ${voice}`);
      await page.locator("#stop").click();
      await page.getByText("Stopped", { exact: true }).waitFor();
    }
    assert.deepEqual(scorePaths(), [catalog, prelude, fugue], "The fugue and voice changes should share one payload");

    await page.locator("#works").getByText(/^BWV 847 · /).click();
    await panel.getByRole("heading", { name: /BWV 847 fugue/i }).waitFor();
    const bass = panel.getByRole("checkbox", { name: "Mute Bass" });
    await panel.getByText("Mute Bass", { exact: true }).click();
    assert.ok(await bass.isChecked());
    await play(page, "Fugue");
    const preMuted = await timeline();
    assert.ok(preMuted.max > 97 && preMuted.max < 98, "Muting bass should preserve the full BWV 847 timeline");
    await page.waitForFunction((value) => document.querySelector<HTMLProgressElement>("#progress")!.value > value, preMuted.value);
    assert.deepEqual(await page.evaluate(() => window.jsBachVoiceGainChanges.slice(2)), [],
      "A voice muted before play should start without a live gain ramp");
    await panel.getByText("Mute Bass", { exact: true }).click();
    const restoredBass = await page.evaluate(() => window.jsBachVoiceGainChanges.slice(2).map(({ target, initialGain }) => ({ target, initialGain })));
    assert.deepEqual(restoredBass, [{ target: 1, initialGain: 0 }],
      "Restoring the Bass should turn up the bus that started at zero gain");
    await panel.getByText("Mute Bass", { exact: true }).click();
    assert.ok(await bass.isChecked());

    await page.locator("#works").getByText(/^BWV 848 · /).click();
    await panel.getByRole("heading", { name: /BWV 848 fugue/i }).waitFor();
    assert.ok(!await bass.isChecked(), "Mute selections should belong to the current movement");
    assert.ok(await page.locator("#stop").isDisabled(), "Switching works should stop the old playback");
    assert.equal((await timeline()).value, 0);

    await page.locator("#works").getByText(/^BWV 846 · /).click();
    await panel.getByRole("heading", { name: /BWV 846 fugue/i }).waitFor();
    await page.getByText("Prelude", { exact: true }).click();
    await page.locator("#works").getByText(/^BWV 869 · /).click();
    await play(page, "Prelude");
    await page.locator("#stop").click();
    await page.locator("#works").getByText(/^BWV 846 · /).click();
    await play(page, "Prelude");
    assert.deepEqual(scorePaths(), [catalog, prelude, fugue, fugue847, fugue848, repeatPrelude],
      "Work changes should fetch only the current movement and cache prior loads");
    await checkPreviewRaces(browser, address);
    await checkBrowserApi(browser, address, packageRoot);
    await checkPianoRoll(browser, address);
    return { firstPlay, firstScore };
  } finally {
    await browser.close();
  }
}

const metadata = resolve(process.argv[2] ?? "dist/npm/pack.json");
const reports: PackedPreview[] = JSON.parse(readFileSync(metadata, "utf8"));
assert.equal(reports.length, 1, "Inspect exactly one npm archive");
const [archive] = reports;
const project = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
assert.equal(archive.name, "@mokele-mbembe/js-bach");
assert.equal(archive.version, project.version);
const tarball = join(dirname(metadata), archive.filename);
const download = statSync(tarball).size;
// npm's JSON logger may redact the UUID in generated paths. Inspect the archive itself.
const paths = new Set(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trimEnd().split("\n")
  .map((path) => path.replace(/^package\//, "")));
for (const path of ["LICENSE", "README.md", "SCORE-LICENSES.md", entry, "dist/corpus/current"]) {
  assert.ok(paths.has(path), `Missing ${path} from the npm tarball`);
}
const directory = mkdtempSync(join(tmpdir(), "js-bach-preview-report-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", directory]);
  const packageRoot = join(directory, "package");
  const generation = readFileSync(join(packageRoot, "dist/corpus/current"), "utf8").trim();
  const corpusPath = `dist/corpus/builds/${generation}`;
  const catalogPath = `${corpusPath}/catalog.json`;
  const { works } = JSON.parse(readFileSync(join(packageRoot, catalogPath), "utf8")) as { works: { bwv: string }[] };
  const expectedCorpus = [catalogPath, `${corpusPath}/compression.md`, ...works.flatMap(({ bwv }) =>
    ["prelude", "fugue"].map((kind) => `${corpusPath}/bwv${bwv}/bwv${bwv}-${kind}.playback.json`)),
  ];
  const corpusFiles = [...paths].filter((path) => path.startsWith("dist/corpus/builds/"));
  assert.deepEqual(corpusFiles.sort(), expectedCorpus.sort(), "The package should include one playback file per movement");

  const server = spawn(process.execPath, [join(packageRoot, entry)], {
    env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = once(server, "close");
  const output = createInterface({ input: server.stdout });
  try {
    const [line] = await once(output, "line", { signal: AbortSignal.timeout(10_000) });
    const address = /^Demo at (http:\/\/127\.0\.0\.1:\d+\/)$/u.exec(line)?.[1];
    assert.ok(address, `Could not locate preview server: ${line}`);
    const { firstPlay, firstScore } = await checkDemo(address, packageRoot);
    const report = [
      "## npm preview and cold first play", "",
      `Measured from the packed ${archive.name}@${archive.version} in a fresh Chromium page playing the BWV 846 prelude.`,
      "Requests are counted from navigation until Playwright detects the first scheduled oscillator. Browser-internal requests such as the implicit favicon may be omitted. Byte totals cover the complete HTTP responses for the observed requests.", "",
      "The installed CLI negotiates gzip for JavaScript and CSS. Catalog and movement responses are served as JSON without content encoding.", "",
      "| npm package | Bytes |", "| --- | ---: |",
      `| Download (.tgz) | ${download} |`,
      `| Unpacked files | ${archive.unpackedSize} |`, "",
      "| First play | Requests | Response body bytes | Response bytes with headers |", "| --- | ---: | ---: | ---: |",
      `| Playwright-observed page requests | ${firstPlay.count} | ${firstPlay.body} | ${firstPlay.transfer} |`,
      `| Catalog and movement | ${firstScore.count} | ${firstScore.body} | ${firstScore.transfer} |`, "",
      "Playback checks covered the lazy piano rolls for BWV 846–849, unison and tied-note highlights during live mute and restore, click seeking, stereo spread, solos, and rapid switches.",
      "The packaged browser API passed Node import, read-only voice and event queries including the BWV 848 tie across source voice IDs, and TypeScript declaration checks. Chromium verified scheduled note clocks and seeking, initial mute and stereo pan, name and ID voice controls, callback stops and rejections, and cancellation.", "",
    ].join("\n");
    writeFileSync(join(dirname(metadata), "size-report.md"), report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
    console.log(report);
  } finally {
    output.close();
    server.kill();
    await closed;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
