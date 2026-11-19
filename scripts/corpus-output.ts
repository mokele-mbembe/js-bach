import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const output = new URL("../corpus/", import.meta.url);
const current = new URL("current", output);
const builds = new URL("builds/", output);

export function currentCorpus(): URL | undefined {
  let generation: string;
  try {
    generation = readFileSync(current, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
  assert.match(generation, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, "Invalid published corpus generation");
  return new URL(`${generation}/`, builds);
}

export function publishCorpus(writeAssets: (directory: URL) => void): URL {
  const generation = randomUUID();
  const directory = new URL(`${generation}/`, builds);
  const pending = new URL(`.current-${generation}`, output);
  mkdirSync(builds, { recursive: true });
  mkdirSync(directory);
  try {
    writeAssets(directory);
    // Readers pin one directory. Only a complete build becomes visible through this pointer.
    writeFileSync(pending, `${generation}\n`, { flag: "wx" });
    renameSync(pending, current);
  } catch (error) {
    rmSync(pending, { force: true });
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return directory;
}
