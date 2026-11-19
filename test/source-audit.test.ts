import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseMidi, writeMidi } from "midi-file";
import { auditSources } from "../scripts/audit-sources.js";
import { readPdmxRows } from "../scripts/pdmx-source.js";
import { acquireReleaseFile } from "../scripts/source-download.js";

const execute = promisify(execFile);

async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "js-bach-audit-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function serve(t: TestContext, request: RequestListener) {
  const server = createServer(request);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("a candidate outside the corpus produces a raw difference report and rejects a checksum mismatch", async (t) => {
  const root = await scratch(t);
  for (const path of ["dist/scripts", "dist/src", "package.json"]) {
    await cp(new URL(`../../${path}`, import.meta.url), join(root, path), { recursive: true });
  }
  await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(root, "node_modules"), "junction");
  const score = await readFile(new URL("../../corpus/bwv861/prelude.mxl", import.meta.url));
  const reference = parseMidi(await readFile(new URL("../../corpus/bwv861/prelude.reference.mid", import.meta.url)));
  reference.tracks.push([
    { type: "noteOn", deltaTime: 0, channel: 0, noteNumber: 0, velocity: 64 },
    { type: "noteOff", deltaTime: 0, channel: 0, noteNumber: 0, velocity: 0 },
    { type: "endOfTrack", deltaTime: 0, meta: true },
  ]);
  const midi = Buffer.from(writeMidi(reference));
  const origin = await serve(t, (request, response) => {
    if (request.url === "/score.mxl") response.end(score);
    else if (request.url === "/reference.mid") response.end(midi);
    else response.writeHead(404).end();
  });
  const candidate = {
    bwv: "861", movements: [{ kind: "prelude", score: { download: `${origin}/score.mxl`, sha256: createHash("sha256").update(score).digest("hex"), license: "Public Domain" },
      referenceMidi: { download: `${origin}/reference.mid`, license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" } }],
  };
  const input = join(root, "candidate.json");
  const run = () => execute(process.execPath, ["dist/scripts/audit-sources.js", input], { cwd: root });
  await writeFile(input, JSON.stringify(candidate));
  await run();
  const output = join(root, "dist/source-audit");
  const [directory] = await readdir(output);
  const report = JSON.parse(await readFile(join(output, directory, "attack-diff.json"), "utf8"));
  assert.equal(report.editionAndLicense, "manual review required");
  const [movement] = report.movements;
  assert.deepEqual(movement.scoreOnly, []);
  assert.deepEqual(movement.midiOnly.map(({ midiTick, midiPitch }: { midiTick: number; midiPitch: number }) => [midiTick, midiPitch]), [[0, 0]]);
  assert.equal(movement.referenceMidi.sha256, createHash("sha256").update(midi).digest("hex"));
  const markdown = await readFile(join(output, directory, "attack-diff.md"), "utf8");
  assert.match(markdown, /MusicXML `prelude.mxl`[^\n]*\n  - License declared by the candidate — `Public Domain`/);
  assert.match(markdown, /Reference MIDI `prelude.mid`[^\n]*\n  - License declared by the candidate — \[CC0 1.0\]/);
  candidate.movements[0].score.sha256 = "0".repeat(64);
  await writeFile(input, JSON.stringify(candidate));
  await assert.rejects(run(), /SHA-256 mismatch/);
  assert.deepEqual(await readdir(output), [directory]);
});

test("a candidate cannot overwrite checked evidence using a filename that differs only by case", async (t) => {
  const root = await scratch(t);
  const score = await readFile(new URL("../../corpus/bwv861/prelude.mxl", import.meta.url));
  const midi = await readFile(new URL("../../corpus/bwv861/prelude.reference.mid", import.meta.url));
  const requests: string[] = [];
  const origin = await serve(t, (request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    response.end(path.endsWith(".mxl") ? score : midi);
  });
  const input = join(root, "collision.json");
  await writeFile(input, JSON.stringify({ bwv: "861", movements: [
    { kind: "prelude", score: { file: "Score.mxl", download: `${origin}/prelude.mxl` }, referenceMidi: { download: `${origin}/prelude.mid` } },
    { kind: "fugue", score: { file: "score.mxl", download: `${origin}/fugue.mxl` }, referenceMidi: { download: `${origin}/fugue.mid` } },
  ] }));
  const output = join(root, "output");
  const [result] = await auditSources([input], output);
  assert.equal(result.status, "rejected");
  assert.match(String(result.reason), /same filename \(ignoring case\) score\.mxl/);
  assert.deepEqual(requests, ["/prelude.mxl", "/prelude.mid"]);
  assert.deepEqual(await readdir(output), []);
});

test("a release download checks the range and digest and replaces a corrupt cached copy", async (t) => {
  const cache = await scratch(t);
  const data = Buffer.from("test release");
  let requests = 0;
  const origin = await serve(t, (request, response) => {
    requests++;
    const range = `bytes=0-${data.length - 1}`;
    if (request.headers.range !== range) { response.writeHead(416).end(); return; }
    response.writeHead(206, { "Content-Range": `bytes 0-${data.length - 1}/${data.length}` }).end(data);
  });
  const release = { name: "fixture.csv", url: `${origin}/release`, bytes: data.length, md5: createHash("md5").update(data).digest("hex") };
  const path = await acquireReleaseFile(cache, release);
  assert.deepEqual(await readFile(path), data);
  assert.equal(await acquireReleaseFile(cache, release), path);
  assert.equal(requests, 1);
  await writeFile(path, Buffer.alloc(data.length));
  await acquireReleaseFile(cache, release);
  assert.deepEqual(await readFile(path), data);
  assert.equal(requests, 2);
  await assert.rejects(acquireReleaseFile(cache, { ...release, md5: "0".repeat(32) }), /Release checksum mismatch/);
  assert.deepEqual(await readFile(path), data);
});

test("PDMX MusicXML and MIDI member selectors resolve to the same edition row", async (t) => {
  const index = join(await scratch(t), "PDMX.csv");
  const midiMember = "mid/9/38/QmExample.mid";
  const scoreMember = "mxl/9/38/QmExample.mxl";
  await writeFile(index, [
    "metadata,mid,mxl,title,license,license_url,license_conflict",
    `./metadata/1/540986.json,./${midiMember},./${scoreMember},OpenWTC,cc-zero,https://creativecommons.org/publicdomain/zero/1.0/,False`,
  ].join("\n"));
  const rows = await readPdmxRows(index, new Set(["540986", midiMember, scoreMember]));
  const row = rows.get("540986");
  assert.equal(row?.metadata, "metadata/1/540986.json");
  assert.equal(row?.archiveMember, midiMember);
  assert.equal(row?.scoreArchiveMember, scoreMember);
  assert.deepEqual(rows.get(midiMember), row);
  assert.deepEqual(rows.get(scoreMember), row);
});

test("a PDMX audit reports each asset's license and isolates invalid selectors in the batch", async (t) => {
  const root = await scratch(t);
  const scoreMember = "mxl/0/0/Score.mxl";
  const midiMember = "mid/0/0/Reference.mid";
  await mkdir(join(root, dirname(scoreMember)), { recursive: true });
  await mkdir(join(root, dirname(midiMember)), { recursive: true });
  await cp(new URL("../../corpus/bwv861/prelude.mxl", import.meta.url), join(root, scoreMember));
  await cp(new URL("../../corpus/bwv861/prelude.reference.mid", import.meta.url), join(root, midiMember));
  const archive = join(root, "files.tar.gz");
  await execute("tar", ["-czf", archive, scoreMember, midiMember], { cwd: root });
  const index = join(root, "PDMX.csv");
  await writeFile(index, [
    "metadata,mid,mxl,title,license,license_url,license_conflict",
    `./metadata/0/100.json,./mid/0/0/Other.mid,./${scoreMember},Notation edition,cc-by-sa,https://creativecommons.org/licenses/by-sa/4.0/,True`,
    `./metadata/0/200.json,./${midiMember},./mxl/0/0/Other.mxl,MIDI edition,cc-zero,https://creativecommons.org/publicdomain/zero/1.0/,False`,
  ].join("\n"));
  const paths = ["not-a-number", "999", "200"].map((id) => join(root, `${id}.json`));
  for (const [i, id] of ["not-a-number", "999", "200"].entries()) {
    await writeFile(paths[i], JSON.stringify({ bwv: "861", movements: [{ kind: "prelude",
      score: { pdmxScoreId: "100" }, referenceMidi: { pdmxScoreId: id },
    }] }));
  }
  const formats: string[] = [];
  const output = join(root, "output");
  const [malformed, missing, valid] = await auditSources(paths, output, async (_cache, requested) => {
    assert.deepEqual(requested, new Set(["100", "999", "200"]));
    const rows = await readPdmxRows(index, requested);
    return { rows, archive: async (format) => { formats.push(format); return archive; } };
  });
  assert.equal(malformed.status, "rejected");
  assert.match(String(malformed.reason), /Expected a numeric MuseScore ID/);
  assert.equal(missing.status, "rejected");
  assert.match(String(missing.reason), /999 was not found in PDMX v9/);
  assert.equal(valid.status, "fulfilled");
  assert.deepEqual(formats, ["mxl", "mid"]);
  const { directory, reports: [report] } = valid.value;
  assert.deepEqual([report.scoreOnly, report.midiOnly], [[], []]);
  assert.equal((await readdir(output)).length, 1);
  const markdown = await readFile(join(directory, "attack-diff.md"), "utf8");
  assert.match(markdown, /MusicXML `prelude.mxl`[^\n]*\n  - PDMX lists “Notation edition” at `metadata\/0\/100.json` with license `cc-by-sa` and conflict flag `True`/);
  assert.match(markdown, /Reference MIDI `prelude.mid`[^\n]*\n  - PDMX lists “MIDI edition” at `metadata\/0\/200.json` with license `cc-zero` and conflict flag `False`/);
});
