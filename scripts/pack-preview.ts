import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentCorpus } from "./corpus-output.js";
import { works } from "./corpus.js";
import { demoAssets, workAssets } from "./demo-assets.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const corpus = currentCorpus();
assert.ok(corpus, "Build the corpus before packaging the preview");
const corpusDirectory = fileURLToPath(corpus);
const generation = basename(corpusDirectory);
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this script through npm run pack:preview");

const { version, description, license, engines, repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const destination = join(root, "dist/npm");
const stage = mkdtempSync(join(tmpdir(), "js-bach-preview-"));

function copy(from: string, to: string): void {
  const path = join(stage, to);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(from, path);
}

function scoreLicense({ license, licenseUrl }: { license: string; licenseUrl?: string }, id: string): string {
  if (license === "Public Domain") return "Public Domain";
  const url = license === "CC BY-SA 4.0" ? "https://creativecommons.org/licenses/by-sa/4.0/" :
    /^CC0[ -]1\.0$/.test(license) ? "https://creativecommons.org/publicdomain/zero/1.0/" : undefined;
  assert.ok(url && licenseUrl === url, `Review ${id}'s redistribution terms before packaging`);
  return `[${license}](${url})`;
}

try {
  const entry = "dist/scripts/serve-demo.js";
  writeFileSync(join(stage, "package.json"), `${JSON.stringify({
    name: "@mokele-mbembe/js-bach", version, description, type: "module", license, engines, repository,
    bin: { "js-bach": entry },
    files: ["demo/", "dist/", "source/", "SCORE-LICENSES.md"],
    publishConfig: { access: "public", tag: "preview" },
  }, null, 2)}\n`);
  copy(join(root, "LICENSE"), "LICENSE");
  copy(join(root, "docs/npm-preview.md"), "README.md");
  const runtimeFiles = [entry, "dist/scripts/corpus-output.js", "dist/scripts/demo-assets.js", ...Object.values(demoAssets)];
  for (const file of runtimeFiles) copy(join(root, file), file);

  const sourceFiles = ["LICENSE", "README.md", "package.json", "package-lock.json", "tsconfig.json",
    "demo/index.html", "demo/demo.css", "demo/main.ts", "docs/mvp.md", "docs/npm-preview.md"];
  for (const directory of ["src", "scripts", "test"]) {
    sourceFiles.push(...readdirSync(join(root, directory)).filter((file) => file.endsWith(".ts")).map((file) => `${directory}/${file}`));
  }

  const published = `dist/corpus/builds/${generation}`;
  for (const file of ["catalog.json", "compression.md"]) copy(join(corpusDirectory, file), `${published}/${file}`);
  writeFileSync(join(stage, "dist/corpus/current"), `${generation}\n`);
  const notices = [
    "# Score licenses", "",
    "Johann Sebastian Bach composed these works. The player code is licensed under GPL-3.0-only. The digital scores and playback data retain the terms below.", "",
    "js-bach converts the MusicXML into Score IR and two lossless encodings. Noctave converted the credited Mutopia engravings into MusicXML for the CC BY-SA 4.0 works. The original files and source manifests are included in `source/corpus/`.", "",
    "| Movement | Edition credit | MusicXML and generated score data | Reference MIDI |",
    "| --- | --- | --- | --- |",
  ];
  for (const work of works) {
    const directory = `bwv${work.bwv}`;
    assert.ok(readFileSync(join(corpusDirectory, directory, "sources.json")).equals(work.manifest), `The build for BWV ${work.bwv} is stale`);
    for (const file of workAssets(work.bwv)) copy(join(corpusDirectory, directory, file), `${published}/${directory}/${file}`);
    const originals = work.movements.flatMap(({ score, referenceMidi }) => [score.file, referenceMidi.file]);
    sourceFiles.push(...[...new Set(["sources.json", ...originals])].map((file) => `corpus/${directory}/${file}`));

    for (const { id, title, score, referenceMidi } of work.movements) {
      if (score.license === "CC BY-SA 4.0") assert.ok(score.attribution, `Missing ShareAlike attribution for ${id}`);
      const credit = score.attribution ?? `${referenceMidi.typesetter} / ${referenceMidi.edition}`;
      notices.push(`| BWV ${work.bwv} ${title} | ${credit} | ${scoreLicense(score, id)} · [MusicXML source](${score.source}) | ${scoreLicense(referenceMidi, id)} · [MIDI source](${referenceMidi.source}) |`);
    }
  }
  writeFileSync(join(stage, "SCORE-LICENSES.md"), `${notices.join("\n")}\n`);
  for (const file of sourceFiles) copy(join(root, file), `source/${file}`);

  mkdirSync(destination, { recursive: true });
  const packed = execFileSync(process.execPath, [npm, "pack", "--ignore-scripts", "--silent", "--pack-destination", destination], { cwd: stage, encoding: "utf8" });
  console.log(`Packed ${join(destination, packed.trim())}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
