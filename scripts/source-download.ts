import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function downloadSource(url: string, destination: string, options: string[] = []): Promise<void> {
  await execute("curl", [
    "--fail", "--location", "--silent", "--show-error", "--proto", "=http,https", "--proto-redir", "=http,https",
    "--retry", "2", "--retry-all-errors", "--connect-timeout", "15", "--max-time", "120",
    ...options, "--output", destination, "--", url,
  ]);
}

export function verifySourceBytes(data: Uint8Array, expected: string | undefined, label: string): string {
  const actual = createHash("sha256").update(data).digest("hex");
  if (expected !== undefined && actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${label}. Expected ${expected}, got ${actual}`);
  }
  return actual;
}

interface ReleaseFile {
  name: string;
  url: string;
  bytes: number;
  md5: string;
}

async function matchesRelease(path: string, release: ReleaseFile): Promise<boolean> {
  try {
    if ((await stat(path)).size !== release.bytes) return false;
    const hash = createHash("md5");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === release.md5;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

export async function acquireReleaseFile(cache: string, release: ReleaseFile): Promise<string> {
  const target = join(cache, release.name);
  if (await matchesRelease(target, release)) return target;

  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, `${release.name}-`));
  const assembled = join(temporary, release.name);
  try {
    console.log(`Downloading ${release.name} (${Math.ceil(release.bytes / 1_000_000)} MB)`);
    const chunkBytes = 16 * 1024 * 1024;
    const starts = Array.from({ length: Math.ceil(release.bytes / chunkBytes) }, (_, i) => i * chunkBytes);
    const part = (start: number) => join(temporary, String(start));
    for (let i = 0; i < starts.length; i += 8) {
      const downloads = await Promise.allSettled(starts.slice(i, i + 8).map(async (start) => {
        const end = Math.min(start + chunkBytes, release.bytes) - 1;
        const url = new URL(release.url);
        url.searchParams.set("slice", String(start));
        const header = `${part(start)}.headers`;
        await downloadSource(url.href, part(start), [
          "--range", `${start}-${end}`, "--dump-header", header, "--max-filesize", String(end - start + 1),
        ]);
        const lines = (await readFile(header, "utf8")).toLowerCase().split(/\r?\n/);
        assert.ok(lines.includes(`content-range: bytes ${start}-${end}/${release.bytes}`), `Incorrect range for ${release.name}`);
        assert.equal((await stat(part(start))).size, end - start + 1, `Short range for ${release.name}`);
      }));
      for (const item of downloads) if (item.status === "rejected") throw item.reason;
    }
    await pipeline(Readable.from((async function* () {
      for (const start of starts) yield* createReadStream(part(start));
    })()), createWriteStream(assembled));
    assert.ok(await matchesRelease(assembled, release), `Release checksum mismatch for ${release.name}`);
    await rename(assembled, target);
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
