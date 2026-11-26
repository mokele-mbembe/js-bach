import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page, type Request } from "playwright";

interface PackedPreview {
  name: string;
  version: string;
  filename: string;
  unpackedSize: number;
}

declare global {
  interface Window { jsBachOscillatorStarts: number }
}

const entry = "dist/scripts/serve-demo.js";
const catalog = "/corpus/catalog.json";
const prelude = "/corpus/bwv846/bwv846-prelude.playback.json";
const fugue = "/corpus/bwv846/bwv846-fugue.playback.json";
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

async function checkDemo(address: string) {
  const browser = await chromium.launch({ channel: process.env.JS_BACH_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.addInitScript(() => {
      window.jsBachOscillatorStarts = 0;
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (when) {
        start.call(this, when);
        window.jsBachOscillatorStarts++;
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

    await page.getByText("Fugue", { exact: true }).click();
    for (const voice of ["Soprano", "Alto", "Tenor", "Bass"]) {
      await page.getByText(voice, { exact: true }).click();
      await play(page, `Fugue · ${voice}`);
      await page.locator("#stop").click();
      await page.getByText("Stopped", { exact: true }).waitFor();
    }
    assert.deepEqual(scorePaths(), [catalog, prelude, fugue], "The fugue and voice changes should share one payload");

    await page.getByText("Prelude", { exact: true }).click();
    await page.locator("#works").getByText(/^BWV 869 · /).click();
    await play(page, "Prelude");
    await page.locator("#stop").click();
    await page.locator("#works").getByText(/^BWV 846 · /).click();
    await play(page, "Prelude");
    assert.deepEqual(scorePaths(), [catalog, prelude, fugue, repeatPrelude], "Work changes should fetch only the current movement and cache prior loads");
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
    const { firstPlay, firstScore } = await checkDemo(address);
    const report = [
      "## npm preview and cold first play", "",
      `Measured from the packed ${archive.name}@${archive.version} and a fresh Chromium page playing the BWV 846 prelude.`, "",
      "| npm package | Bytes |", "| --- | ---: |",
      `| Download (.tgz) | ${download} |`,
      `| Unpacked files | ${archive.unpackedSize} |`, "",
      "| First play | Requests | Response body bytes | Response bytes with headers |", "| --- | ---: | ---: | ---: |",
      `| Full page | ${firstPlay.count} | ${firstPlay.body} | ${firstPlay.transfer} |`,
      `| Catalog and movement | ${firstScore.count} | ${firstScore.body} | ${firstScore.transfer} |`, "",
      "Playback check covered lazy work and movement switches, cached return, and all four BWV 846 fugue voices.", "",
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
