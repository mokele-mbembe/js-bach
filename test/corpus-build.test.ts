import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkSource } from "../scripts/corpus.js";
import { expandRhythmTemplates } from "../src/rhythm-templates.js";
import { expandTransposedFragments } from "../src/transposed-fragments.js";

const work = "bwv862";
const prelude = `${work}-prelude`;
const fugue = `${work}-fugue`;
const buildScript = "dist/scripts/build-corpus.js";

// Pause the real CLI at an exact filesystem operation so the tests can order writers deterministically.
const pauseBuild = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync;
const write = fs.writeFileSync;
let paused = false;
function checkpoint() {
  if (paused) return;
  paused = true;
  write("paused", "");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync("resume")) {
    if (Date.now() >= deadline) throw new Error("Build was not resumed");
    Atomics.wait(wait, 0, 0, 10);
  }
}
fs.readFileSync = (file, ...args) => {
  const result = read(file, ...args);
  if (process.env.PAUSE_BUILD === "import" && file.pathname?.endsWith(".mxl")) checkpoint();
  return result;
};
fs.writeFileSync = (file, ...args) => {
  write(file, ...args);
  if (process.env.PAUSE_BUILD === "stage" && file.pathname?.endsWith("/bwv862/sources.json")) checkpoint();
};
syncBuiltinESMExports();
`;

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "js-bach-corpus-test-"));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
    rmSync(root, { force: true, recursive: true });
  });

  for (const path of ["package.json", `corpus/${work}`, "node_modules/@xmldom/xmldom", "node_modules/fflate", "dist/src", "dist/scripts"]) {
    cpSync(new URL(`../../${path}`, import.meta.url), join(root, path), { recursive: true });
  }
  const output = join(root, "dist/corpus");
  const manifestFile = join(root, "corpus", work, "sources.json");
  const manifest: WorkSource = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.movements[0].score.measureRange = [0, 1];
  manifest.movements[1].score.measureRange = [44, 45];
  const saveManifest = (credit: string) => {
    manifest.movements[0].score.attribution = credit;
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestFile, text);
    return text;
  };
  const initial = saveManifest("Fixture credit A");
  const current = () => join(output, "builds", readFileSync(join(output, "current"), "utf8").trim());
  const build = (...args: string[]) => {
    const result = spawnSync(process.execPath, [buildScript, ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout;
  };
  const start = (args: string[], extra: Record<string, string>) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    }
    const closed = once(child, "close");
    return { child, closed, output: () => output };
  };
  const startPausedBuild = async (stage: "import" | "stage") => {
    writeFileSync(join(root, "pause.mjs"), pauseBuild);
    const running = start(["--import", "./pause.mjs", buildScript], { PAUSE_BUILD: stage });
    await until(() => existsSync(join(root, "paused")), running);
    return running;
  };
  const startDemo = async () => {
    const server = start(["dist/scripts/serve-demo.js"], { PORT: "0" });
    let address: string | undefined;
    await until(() => {
      address = server.output().match(/Demo at (http:\/\/127\.0\.0\.1:\d+)\//)?.[1];
      return address !== undefined;
    }, server);
    assert.ok(address);
    return address;
  };
  return { root, initial, current, saveManifest, build, startPausedBuild, startDemo };
}

async function until(check: () => boolean, running: { child: ChildProcess; output: () => string }): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.equal(running.child.exitCode, null, running.output());
    assert.ok(Date.now() < deadline, `Child did not reach checkpoint. ${running.output()}`);
    await delay(10);
  }
}

function assertGeneration(directory: string, manifest: string): void {
  const source: WorkSource = JSON.parse(manifest);
  assert.equal(readFileSync(join(directory, work, "sources.json"), "utf8"), manifest);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "catalog.json"), "utf8")), { works: [{ bwv: source.bwv, key: source.key }] });
  const report = readFileSync(join(directory, "compression.md"), "utf8");
  const { movements } = JSON.parse(readFileSync(join(directory, work, "compression.json"), "utf8"));
  for (const { id, title, score } of source.movements) {
    const read = (suffix: string) => JSON.parse(readFileSync(join(directory, work, `${id}${suffix}.json`), "utf8"));
    const original = read("");
    assert.equal(original.attribution.credit, score.attribution);
    assert.deepEqual(expandRhythmTemplates(read(".rhythm")), original);
    assert.deepEqual(expandTransposedFragments(read(".transposed")), original);
    assert.ok(report.includes(`| BWV ${source.bwv} ${title} | ${movements[id].eventStream.brotliBytes} | ${movements[id].rhythmEncoding.brotliBytes} | ${movements[id].transposedEncoding.brotliBytes} |`));
  }
}

test("warm builds reuse intact encodings and recompute changed or corrupt entries", (t) => {
  const f = setup(t);
  const cached = (log: string) => [...log.matchAll(/^(\S+) — .*\(cached search\)$/gm)].map((match) => match[1]);
  assert.deepEqual(cached(f.build()), []);
  const report = () => readFileSync(join(f.current(), "compression.md"), "utf8");
  const first = report();
  assert.deepEqual(cached(f.build()), [prelude, fugue]);
  assert.equal(report(), first);
  writeFileSync(join(f.current(), work, `${prelude}.transposed.json`), "corrupt");
  assert.deepEqual(cached(f.build()), [fugue]);
  assert.equal(report(), first);
  const edited = f.saveManifest("Fixture credit B");
  assert.deepEqual(cached(f.build()), [fugue]);
  const editedReport = report();
  assert.deepEqual(cached(f.build("--fresh")), []);
  assert.equal(report(), editedReport);
  assertGeneration(f.current(), edited);
});

test("publishing uses the same manifest bytes as the score import", async (t) => {
  const f = setup(t);
  const running = await f.startPausedBuild("import");
  const edited = f.saveManifest("Fixture credit B");
  writeFileSync(join(f.root, "resume"), "");
  assert.deepEqual(await running.closed, [0, null], running.output());
  assertGeneration(f.current(), f.initial);
  f.build();
  assertGeneration(f.current(), edited);
});

test("overlapping builds publish whole generations and the demo stays pinned to its catalog", async (t) => {
  const f = setup(t);
  f.build();
  const initial = f.current();
  const address = await f.startDemo();

  const second = f.saveManifest("Fixture credit B");
  const running = await f.startPausedBuild("stage");
  assert.equal(f.current(), initial);
  assertGeneration(initial, f.initial);

  const third = f.saveManifest("Fixture credit C");
  f.build();
  const other = f.current();
  assert.notEqual(other, initial);
  assertGeneration(other, third);

  writeFileSync(join(f.root, "resume"), "");
  assert.deepEqual(await running.closed, [0, null], running.output());
  assertGeneration(f.current(), second);
  assertGeneration(other, third);

  rmSync(join(f.root, "corpus"), { recursive: true });
  const oldResponse = await fetch(`${address}/corpus/${work}/sources.json`);
  assert.equal(oldResponse.status, 200);
  assert.equal(await oldResponse.text(), f.initial);
  const nextAddress = await f.startDemo();
  const catalog = await fetch(`${nextAddress}/corpus/catalog.json`);
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), { works: [{ bwv: "862", key: "A-flat major" }] });
  const sources = await fetch(`${nextAddress}/corpus/${work}/sources.json`);
  assert.equal(sources.status, 200);
  assert.equal(await sources.text(), second);
  const encoding = await fetch(`${nextAddress}/corpus/${work}/${prelude}.transposed.json`);
  assert.equal(encoding.status, 200);
  assert.deepEqual(await encoding.json(), JSON.parse(readFileSync(join(f.current(), work, `${prelude}.transposed.json`), "utf8")));
});

test("an interrupted staging write leaves the previous generation usable", async (t) => {
  const f = setup(t);
  f.build();
  const initial = f.current();
  const edited = f.saveManifest("Fixture credit B");
  const running = await f.startPausedBuild("stage");
  running.child.kill("SIGKILL");
  const [status] = await running.closed;
  assert.notEqual(status, 0);
  assert.equal(f.current(), initial);
  assertGeneration(initial, f.initial);
  f.build();
  assert.notEqual(f.current(), initial);
  assertGeneration(f.current(), edited);
});
