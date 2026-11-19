import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { parse } from "csv-parse";
import { acquireReleaseFile } from "./source-download.js";

const execute = promisify(execFile);
export const pdmxRelease = "https://zenodo.org/records/15571083";
const releaseFiles = `${pdmxRelease}/files/`;
export const pdmxMidiUrl = `${releaseFiles}mid.tar.gz?download=1`;
export const pdmxScoreUrl = `${releaseFiles}mxl.tar.gz?download=1`;
const index = { name: "PDMX.csv", url: `${releaseFiles}PDMX.csv?download=1`, bytes: 225399738, md5: "30392ccf38bb63ce70e7afae70f9c88c" };
const midi = { name: "mid.tar.gz", url: pdmxMidiUrl, bytes: 214395208, md5: "d920a21b2fcd99a56d9c381b39debbb2" };
const score = { name: "mxl.tar.gz", url: pdmxScoreUrl, bytes: 1894335797, md5: "49ffd75ecf5489c0be6d41182eb11ff7" };

export interface PdmxRow {
  metadata: string;
  archiveMember: string;
  scoreArchiveMember: string;
  title: string;
  license: string;
  licenseUrl: string;
  licenseConflict: string;
}

export async function readPdmxRows(path: string, requested: Set<string>) {
  const rows = new Map<string, PdmxRow>();
  await pipeline(createReadStream(path), parse({ columns: true, bom: true }), async (records) => {
    for await (const row of records) {
      const match = /^(?:\.\/)?metadata\/\d+\/(\d+)\.json$/.exec(row.metadata);
      const archiveMember = String(row.mid).replace(/^\.\//, "");
      const scoreArchiveMember = String(row.mxl).replace(/^\.\//, "");
      if (!match) continue;
      for (const key of [match[1], archiveMember, scoreArchiveMember]) {
        if (!requested.has(key)) continue;
        assert.ok(!rows.has(key), `Duplicate entry for ${key} in the PDMX index`);
        rows.set(key, {
          metadata: row.metadata.replace(/^\.\//, ""), archiveMember, scoreArchiveMember, title: row.title,
          license: row.license, licenseUrl: row.license_url, licenseConflict: row.license_conflict,
        });
      }
    }
  });
  return rows;
}

export async function preparePdmx(cache: string, requested: Set<string>) {
  const rows = await readPdmxRows(await acquireReleaseFile(cache, index), requested);
  const archives = new Map<"mxl" | "mid", Promise<string>>();
  function archive(format: "mxl" | "mid") {
    let path = archives.get(format);
    if (!path) {
      path = acquireReleaseFile(cache, format === "mxl" ? score : midi);
      archives.set(format, path);
    }
    return path;
  }
  return { rows, archive };
}

export async function extractPdmxFile(archive: string, member: string): Promise<Buffer> {
  assert.match(member, /^(mid|mxl)\/\d+\/\d+\/[a-zA-Z0-9]+\.\1$/, `No PDMX asset at ${member}`);
  const { stdout } = await execute("tar", ["-xOzf", archive, "--", member], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  assert.ok(stdout.length > 0, `Empty PDMX archive member ${member}`);
  return stdout;
}
