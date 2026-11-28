import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../scripts/audit-voices.js", import.meta.url));
const fixture = "**kern\t**kern\n=1\t=1\n[4c\t4e\n4c]\t4e\n*-\t*-\n";
const sha256 = createHash("sha256").update(fixture).digest("hex");

async function fixtureAudit(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "js-bach-kern-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "reference.krn");
  await writeFile(file, fixture);
  const config = join(directory, "reference.json");

  async function run(overrides: Record<string, unknown> = {}) {
    await writeFile(config, JSON.stringify({
      format: "kern",
      source: "https://example.test/engraving.krn",
      credit: "Test engraving",
      license: "Test fixture",
      file: "reference.krn",
      sha256,
      spines: { "1": "bass", "2": "soprano" },
      ...overrides,
    }));
    const result = spawnSync(process.execPath, [cli, "bwv846-fugue", "--reference", config], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  }
  return { file, run };
}

test("the voice audit identifies a pinned **kern reference and its columns in both reports", async (t) => {
  const { run } = await fixtureAudit(t);
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  const markdown = result.stdout.trimEnd().split("\n").at(-1);
  assert.ok(markdown, result.stdout);
  assert.equal(basename(markdown), "voice-audit.md");
  const directory = dirname(markdown);
  assert.equal(dirname(directory), resolve(fileURLToPath(new URL("../voice-audit/", import.meta.url))));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = JSON.parse(await readFile(join(directory, "voice-audit.json"), "utf8"));
  assert.equal(report.reference.format, "kern");
  assert.equal(report.reference.inputSha256, sha256);
  assert.equal(report.reference.engravingSha256, sha256);
  assert.deepEqual(report.reference.spines, { "1": "bass", "2": "soprano" });
  assert.equal(report.audit.referenceCount, 4);
  assert.match(await readFile(markdown, "utf8"), /`\*\*kern` columns \(1-based\): `1` → `bass`, `2` → `soprano`/u);
});

test("the voice audit requires **kern SHA-256 pins and rejects changed reference bytes", async (t) => {
  const { file, run } = await fixtureAudit(t);
  const missing = await run({ sha256: undefined });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Expected reference\.sha256/u);

  const missingMember = await run({ archiveMember: "reference.krn" });
  assert.equal(missingMember.status, 1);
  assert.match(missingMember.stderr, /Expected reference\.memberSha256/u);

  await writeFile(file, fixture.replace("4e", "4f"));
  const changed = await run();
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /SHA-256 mismatch/u);
  assert.equal(changed.stdout, "");
});

test("the voice audit rejects non-canonical **kern column keys", async (t) => {
  const { run } = await fixtureAudit(t);
  const result = await run({ spines: { "01": "bass", "2": "soprano" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1-based spine columns/u);
});
