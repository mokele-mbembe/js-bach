import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentCorpus } from "./corpus-output.js";
import type { WorkSource } from "./corpus.js";
import { demoAssets, workAssets } from "./demo-assets.js";

const corpus = currentCorpus();
assert.ok(corpus, "Build the corpus first with npm run build:corpus.");
const catalog = new URL("catalog.json", corpus);
const { works } = JSON.parse(readFileSync(catalog, "utf8")) as { works: Pick<WorkSource, "bwv">[] };
const workNumbers = works.map(({ bwv }) => bwv);
assert.ok(workNumbers.length > 0, "The generated catalog must include at least one work.");
assert.equal(new Set(workNumbers).size, workNumbers.length, "The generated catalog must list each work once.");
for (const bwv of workNumbers) assert.match(bwv, /^[1-9]\d*$/, "Invalid BWV number in the generated catalog.");

const sourceUrl = process.env.JS_BACH_PAGES_SOURCE_URL;
let sourceLink = "";
if (sourceUrl) {
  const url = new URL(sourceUrl);
  assert.equal(url.protocol, "https:", "Use an HTTPS archive URL for the corresponding source.");
  assert.ok(!url.username && !url.password, "The source archive URL must be available without credentials.");
  const href = url.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  sourceLink = ` · <a id="corresponding-source" href="${href}">Corresponding source</a>`;
}

const root = new URL("../../", import.meta.url);
const destination = fileURLToPath(new URL("../pages/", import.meta.url));
const stage = mkdtempSync(fileURLToPath(new URL("../.pages-", import.meta.url)));

function copy(from: URL, to: string): void {
  const path = join(stage, to);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(from, path);
}

try {
  for (const [route, file] of Object.entries(demoAssets)) {
    if (route !== "/") copy(new URL(file, root), route.slice(1));
  }
  copy(new URL("LICENSE", root), "LICENSE");
  copy(catalog, "corpus/catalog.json");
  for (const bwv of workNumbers) {
    for (const file of workAssets(bwv)) {
      const path = `bwv${bwv}/${file}`;
      copy(new URL(path, corpus), `corpus/${path}`);
    }
  }

  const html = readFileSync(new URL(demoAssets["/"], root), "utf8");
  const marker = "<!-- static-site-links -->";
  assert.ok(html.includes(marker), "The demo must provide a slot for the static site's license and source links.");
  writeFileSync(join(stage, "index.html"), html.replace(marker, () =>
    `<footer aria-label="Project license"><a id="project-license" href="./LICENSE">GPL-3.0-only license</a>${sourceLink}</footer>`));

  // Keep any preceding site intact until all files for its replacement are ready.
  chmodSync(stage, 0o755);
  rmSync(destination, { recursive: true, force: true });
  renameSync(stage, destination);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log(`Built GitHub Pages demo with ${workNumbers.length * 2} movements at ${destination}`);
