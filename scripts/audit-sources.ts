import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { importMusicXml, readMxlMusicXml } from "../src/import-mxl.js";
import { compareSourceAttacks, describeMidiDifferences } from "./source-attacks.js";
import { downloadSource, verifySourceBytes } from "./source-download.js";
import { extractPdmxFile, pdmxMidiUrl, pdmxRelease, pdmxScoreUrl, preparePdmx, type PdmxRow } from "./pdmx-source.js";
import { sliceScore } from "./score-slice.js";

type Range = [number, number];

interface InputFile {
  file?: string;
  source?: string;
  download?: string;
  sha256?: string;
  pdmxScoreId?: string;
  pdmxMetadata?: string;
  archiveMember?: string;
}

interface CandidateMovement {
  kind: "prelude" | "fugue";
  score: InputFile & { measureRange?: Range };
  referenceMidi: InputFile & { tickRange?: Range };
}

function pdmxSelector(input: InputFile): string | undefined {
  const metadata = input.pdmxMetadata && /^(?:\.\/)?metadata\/\d+\/(\d+)\.json$/.exec(input.pdmxMetadata);
  if (input.pdmxMetadata) assert.ok(metadata, `Invalid PDMX metadata path ${input.pdmxMetadata}`);
  if (input.pdmxScoreId !== undefined) assert.match(input.pdmxScoreId, /^\d+$/, "Expected a numeric MuseScore ID as a string");
  if (input.pdmxScoreId && metadata) assert.equal(input.pdmxScoreId, metadata[1], "PDMX selectors disagree");
  return input.pdmxScoreId ?? (metadata ? metadata[1] : input.archiveMember?.replace(/^\.\//, ""));
}

async function readCandidate(path: string) {
  const { bwv, movements } = JSON.parse(await readFile(path, "utf8")) as { bwv: string; movements: CandidateMovement[] };
  assert.match(bwv, /^[1-9]\d*$/, `Invalid BWV in ${path}`);
  assert.ok(Array.isArray(movements) && movements.length > 0, `No movements in ${path}`);
  assert.equal(new Set(movements.map(({ kind }) => kind)).size, movements.length, `Duplicate movement in ${path}`);
  for (const { kind, score, referenceMidi } of movements) {
    assert.ok(kind === "prelude" || kind === "fugue", `Unknown movement in ${path}`);
    assert.ok(score && referenceMidi, `MusicXML and MIDI inputs are required for BWV ${bwv} ${kind}`);
    assert.ok(pdmxSelector(score) || (score.download && score.download !== pdmxScoreUrl),
      `Specify a direct MusicXML download or a PDMX selector for BWV ${bwv} ${kind}`);
    assert.ok(pdmxSelector(referenceMidi) || (referenceMidi.download && referenceMidi.download !== pdmxMidiUrl),
      `Specify a direct MIDI download or a PDMX selector for BWV ${bwv} ${kind}`);
    for (const range of [score.measureRange, referenceMidi.tickRange]) {
      if (range === undefined) continue;
      assert.ok(Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger) && range[0] >= 0 && range[0] < range[1],
        `Expected a half-open range [start, end] for BWV ${bwv} ${kind}`);
    }
  }
  return { bwv, movements };
}

function movementReport(kind: string, scoreBytes: Buffer, midiBytes: Buffer, measureRange?: Range, tickRange?: Range) {
  const xml = readMxlMusicXml(scoreBytes);
  const combined = importMusicXml(xml);
  const score = measureRange ? sliceScore(combined, measureRange, kind) : combined;
  const { performedScore, reference, toMidiTick, attacks, scoreOnly, midiOnly } = compareSourceAttacks(score, midiBytes, tickRange);
  const { graceNotes, differences } = describeMidiDifferences(performedScore, toMidiTick, midiOnly);
  const identification = new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "application/xml");
  const rights = Array.from(identification.getElementsByTagName("rights"), (field) => field.textContent?.trim()).filter(Boolean);
  const measureAt = (tick: number) => performedScore.measures.find((m) => m.startTick <= tick && tick < m.startTick + m.durationTicks)?.number ?? null;
  return {
    kind, title: combined.title, workNumber: combined.workNumber, rights,
    measureRange: measureRange ?? [0, combined.measures.length], measures: score.measures.length,
    performedMeasures: performedScore.measures.length,
    tickRange: tickRange ?? null, midiFileEndTick: reference.end,
    scoreTicksPerQuarter: score.ticksPerQuarter, midiTicksPerQuarter: reference.ticksPerQuarter,
    scoreAttacks: attacks.length, midiAttacks: reference.attacks.size, matchingAttacks: attacks.length - scoreOnly.length,
    graceNotes: graceNotes.length,
    scoreOnly: scoreOnly.map(({ tick, midiPitch, scoreTick }) => ({
      scoreTick, midiTick: tick + reference.startTick, midiPitch, measure: measureAt(scoreTick),
      withinMidiHold: reference.holds.get(midiPitch)?.some(({ start, end }) => start < tick && tick < end) ?? false,
    })),
    midiOnly: differences.map(({ attack, ...notationHints }) => ({
      midiTick: attack.tick + reference.startTick, midiPitch: attack.midiPitch,
      measure: measureAt(attack.tick * score.ticksPerQuarter / reference.ticksPerQuarter), notationHints,
    })),
  };
}

type ReportMovement = ReturnType<typeof movementReport>;
interface FileEvidence {
  file: string;
  source?: string;
  download: string;
  sha256: string;
  expectedSha256?: string;
  pdmxIndex?: PdmxRow;
}

interface AuditedMovement extends ReportMovement {
  score: FileEvidence;
  referenceMidi: FileEvidence;
}

function markdown(bwv: string, movements: AuditedMovement[]) {
  const lines = [
    `# BWV ${bwv} source audit`, "",
    "Review the edition and redistribution terms against the linked sources. Notation hints are evidence for reviewing differences.", "",
    "| Movement | Measures | Score attacks | MIDI attacks | Matches | Score only | MIDI only |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...movements.map((m) => `| ${m.kind} | ${m.measures} | ${m.scoreAttacks} | ${m.midiAttacks} | ${m.matchingAttacks} | ${m.scoreOnly.length} | ${m.midiOnly.length} |`),
  ];
  for (const m of movements) {
    lines.push("", `## ${m.kind === "prelude" ? "Prelude" : "Fugue"}`, "",
      `Score measure indices [${m.measureRange.join(", ")}) and MIDI tick range ${m.tickRange ? `[${m.tickRange.join(", ")})` : "entire file"}. MIDI ticks below are absolute within the reference file.`, "");
    if (m.performedMeasures !== m.measures) lines.push(`The repeat signs expand ${m.measures} written measures to ${m.performedMeasures} performed measures.`, "");
    for (const file of [m.score, m.referenceMidi]) {
      const origin = file.source ?? file.download;
      lines.push(`- \`${file.file}\` SHA-256 \`${file.sha256}\` (${file.expectedSha256 ? "matched supplied checksum" : "recorded for review"}). [Source](${origin})`);
    }
    for (const notice of m.rights) {
      if (notice) lines.push(`- Embedded MusicXML rights statement\n\n  > ${notice.replace(/\s+/g, " ")}`);
    }
    const row = m.referenceMidi.pdmxIndex ?? m.score.pdmxIndex;
    if (row) {
      lines.push(`- PDMX lists “${row.title}” at \`${row.metadata}\` with license \`${row.license}\` and conflict flag \`${row.licenseConflict}\`. [Reported license](${row.licenseUrl})`);
    }
    if (m.scoreOnly.length > 0) {
      lines.push("", "| Measure | Score tick | MIDI tick | MIDI pitch | Within MIDI hold |", "| --- | ---: | ---: | ---: | --- |",
        ...m.scoreOnly.map((a) => `| ${a.measure ?? "—"} | ${a.scoreTick} | ${a.midiTick} | ${a.midiPitch} | ${a.withinMidiHold ? "yes" : "no"} |`));
    }
    if (m.midiOnly.length > 0) {
      lines.push("", "| Measure | MIDI tick | MIDI pitch | Possible notation matches |", "| --- | ---: | ---: | --- |",
        ...m.midiOnly.map(({ measure, midiTick, midiPitch, notationHints: hints }) => {
          const matches = hints.ornaments.map(({ kind, measure, voice }) => `${kind} in m. ${measure}, voice ${voice}`);
          if (hints.earlyGrace) matches.push("grace note");
          if (hints.staggeredChord) matches.push("arpeggiated chord");
          if (hints.tieContinuation) matches.push("tie continuation");
          return `| ${measure ?? "—"} | ${midiTick} | ${midiPitch} | ${matches.join(", ") || "—"} |`;
        }));
    }
  }
  return [...lines, ""].join("\n");
}

const output = fileURLToPath(new URL("../source-audit/", import.meta.url));
type PdmxInputs = Awaited<ReturnType<typeof preparePdmx>>;

function resolveAsset(input: InputFile, format: "mxl" | "mid", pdmx?: PdmxInputs) {
  const selector = pdmxSelector(input);
  if (!selector) {
    assert.ok(input.download, `Expected a ${format} download URL`);
    return { download: input.download };
  }
  const row = pdmx?.rows.get(selector);
  assert.ok(row, `Missing PDMX row for ${selector}`);
  const { download, archive, member } = format === "mxl"
    ? { download: pdmxScoreUrl, archive: pdmx?.scoreArchive, member: row.scoreArchiveMember }
    : { download: pdmxMidiUrl, archive: pdmx?.midiArchive, member: row.archiveMember };
  assert.ok(archive, `Expected a verified PDMX ${format} archive`);
  if (input.archiveMember) assert.equal(input.archiveMember.replace(/^\.\//, ""), member);
  if (input.pdmxMetadata) assert.equal(input.pdmxMetadata.replace(/^\.\//, ""), row.metadata);
  if (input.download) assert.equal(input.download, download, "This audit supports PDMX v9");
  return { download, archive, member, row };
}

async function auditCandidate({ bwv, movements }: Awaited<ReturnType<typeof readCandidate>>, pdmx?: PdmxInputs) {
  const directory = await mkdtemp(join(output, `bwv${bwv}-`));
  const downloaded = new Map<string, { file: string; bytes: Buffer }>();
  const filenames = new Set<string>();
  async function acquire(input: InputFile, { download, archive, member, row }: ReturnType<typeof resolveAsset>, fallbackName: string) {
    const key = member ? `${download}#${member}` : download;
    let asset = downloaded.get(key);
    if (!asset) {
      const file = input.file ?? fallbackName;
      assert.match(file, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(mxl|mid)$/, `Expected a local filename for ${key}`);
      assert.ok(!filenames.has(file), `Different inputs use the same filename ${file}`);
      const path = join(directory, file);
      if (archive && member) {
        await writeFile(path, await extractPdmxFile(archive, member));
      } else await downloadSource(download, path);
      asset = { file, bytes: await readFile(path) };
      downloaded.set(key, asset);
      filenames.add(file);
    }
    const sha256 = verifySourceBytes(asset.bytes, input.sha256, key);
    return { bytes: asset.bytes, evidence: {
      file: asset.file, source: input.source ?? (row ? pdmxRelease : undefined), download, sha256, expectedSha256: input.sha256, pdmxIndex: row,
    } };
  }

  try {
    const reports: AuditedMovement[] = [];
    const usedWindows = new Map<string, Range | undefined>();
    const checkWindow = (key: string, range: Range | undefined) => {
      if (usedWindows.has(key)) {
        const earlier = usedWindows.get(key);
        assert.ok(earlier && range && (earlier[1] <= range[0] || range[1] <= earlier[0]), `Provide disjoint ranges when reusing ${key}`);
      }
      usedWindows.set(key, range);
    };
    for (const { kind, score, referenceMidi } of movements) {
      const scoreAsset = resolveAsset(score, "mxl", pdmx);
      const midiAsset = resolveAsset(referenceMidi, "mid", pdmx);
      checkWindow(`MusicXML ${scoreAsset.member ?? scoreAsset.download}`, score.measureRange);
      checkWindow(`MIDI ${midiAsset.member ?? midiAsset.download}`, referenceMidi.tickRange);
      const mxl = await acquire(score, scoreAsset, `${kind}.mxl`);
      const midi = await acquire(referenceMidi, midiAsset, `${kind}.mid`);
      reports.push({
        ...movementReport(kind, mxl.bytes, midi.bytes, score.measureRange, referenceMidi.tickRange),
        score: mxl.evidence,
        referenceMidi: midi.evidence,
      });
    }
    await writeFile(join(directory, "attack-diff.json"), `${JSON.stringify({ bwv, editionAndLicense: "manual review required", movements: reports }, null, 2)}\n`);
    await writeFile(join(directory, "attack-diff.md"), markdown(bwv, reports));
    for (const m of reports) console.log(`BWV ${bwv} ${m.kind} — ${m.matchingAttacks} matched, ${m.scoreOnly.length} score only, ${m.midiOnly.length} MIDI only`);
    console.log(join(directory, "attack-diff.md"));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const paths = process.argv.slice(2);
if (paths.length === 0 || paths.includes("--help")) {
  console.log("Usage: npm run audit:sources -- <candidate.json> [candidate.json ...]");
  process.exit(paths.length === 0 ? 1 : 0);
}
const candidates = await Promise.all(paths.map(readCandidate));
const selectors = candidates.flatMap(({ movements }) => movements.flatMap(({ score, referenceMidi }) => [pdmxSelector(score), pdmxSelector(referenceMidi)]));
const requested = new Set(selectors.filter((selector): selector is string => selector !== undefined));
const needsScore = candidates.some(({ movements }) => movements.some(({ score }) => pdmxSelector(score)));
await mkdir(output, { recursive: true });
const pdmx = requested.size ? preparePdmx(join(output, "cache", "pdmx-v9"), requested, needsScore) : undefined;
const results = await Promise.allSettled(candidates.map(async (candidate) =>
  auditCandidate(candidate, candidate.movements.some(({ score, referenceMidi }) => pdmxSelector(score) || pdmxSelector(referenceMidi)) ? await pdmx : undefined),
));
for (const [index, result] of results.entries()) {
  if (result.status === "rejected") {
    console.error(`${paths[index]} — ${result.reason instanceof Error ? result.reason.message : result.reason}`);
    process.exitCode = 1;
  }
}
