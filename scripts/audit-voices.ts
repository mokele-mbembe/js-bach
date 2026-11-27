import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import { toPerformance } from "../src/performance.js";
import { midiPitch, type ScoreIR } from "../src/score-ir.js";
import { movements, performanceForMovement, readMovementScore, resolveVoiceForMovement } from "./corpus.js";
import { downloadSource, verifySourceBytes } from "./source-download.js";
import { auditVoiceAssignments, type ReferenceVoiceNote, type ScoreVoiceNote, type VoiceAudit } from "./voice-audit-matcher.js";
import { readLilyPondVoices } from "./voice-reference-lilypond.js";

interface VoiceReference {
  source: string;
  credit: string;
  license: string;
  download?: string;
  file?: string;
  sha256?: string;
  archiveMember?: string;
  memberSha256?: string;
  voices: Record<string, string>;
}

const presets: Record<string, VoiceReference> = {
  "bwv849-fugue": {
    source: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=596",
    credit: "Davide Castellone / Mutopia Project, Breitkopf & Härtel (1866)",
    license: "Public Domain",
    download: "https://raw.githubusercontent.com/MutopiaProject/MutopiaProject/master/ftp/BachJS/BWV849/bwv849b/bwv849b.ly",
    sha256: "f372279554b56ca45af5568451f96965891c6f745d74add52a9aca3d54e5b8de",
    voices: { soprano: "soprano", alto: "alto", tenor: "tenor", bariton: "baritone", bass: "bass" },
  },
  "bwv867-fugue": {
    source: "https://open.uct.ac.za/items/d2a6887b-7196-4fbe-8b56-a469bf557f93",
    credit: "Kyle Rother, University of Cape Town, based on the 1866 Bach-Gesellschaft edition",
    license: "CC BY 4.0 on the archive record, public-domain declaration in the LilyPond file",
    download: "https://open.uct.ac.za/bitstreams/2e57f26c-ff7b-4900-a360-b3974ce7a134/download",
    sha256: "944dc725ee7c6e7fa48431b1f1f5c004a1535c956b9fa56295b055636d9c5542",
    archiveMember: "book1/fugue22_867/fugue22_expanded.ly",
    memberSha256: "8d63923e1e358fd3f668f5a3460a04a32384e2238891a386f2909c4a8941891a",
    voices: { soprano: "soprano", alto: "alto", mezzo: "mezzo", tenor: "tenor", bass: "bass" },
  },
};

function commonGrid(a: number, b: number): number {
  assert.ok([a, b].every((ticks) => Number.isSafeInteger(ticks) && ticks > 0), "Expected positive integer ticks per quarter");
  let left = a;
  let right = b;
  while (right !== 0) [left, right] = [right, left % right];
  const ticks = a / left * b;
  assert.ok(Number.isSafeInteger(ticks) && ticks > 0, "Could not align the written tick grids exactly");
  return ticks;
}

async function getReference(id: string, config?: string): Promise<VoiceReference> {
  if (!config) {
    assert.ok(Object.hasOwn(presets, id), `No reference configured for ${id}. Supply --reference <config.json>.`);
    return presets[id];
  }
  const reference = JSON.parse(await readFile(config, "utf8")) as VoiceReference;
  assert.ok(reference && typeof reference === "object", "Expected a reference configuration object");
  for (const field of ["source", "credit", "license"] as const) {
    assert.ok(typeof reference[field] === "string" && reference[field].trim(), `Expected reference.${field}`);
  }
  const source = new URL(reference.source);
  assert.ok(source.protocol === "https:" || source.protocol === "http:", "Expected an HTTP(S) reference.source URL");
  for (const field of ["file", "download", "archiveMember"] as const) {
    assert.ok(reference[field] === undefined || typeof reference[field] === "string" && reference[field].trim(), `Invalid reference.${field}`);
  }
  assert.ok(Boolean(reference.file) !== Boolean(reference.download), "Provide one reference.file or reference.download");
  assert.ok(reference.voices && typeof reference.voices === "object" && !Array.isArray(reference.voices), "Expected reference.voices");
  const voices = Object.entries(reference.voices);
  assert.ok(voices.length > 0 && voices.every(([key, id]) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key) &&
    typeof id === "string" && /^[a-z][a-z0-9-]*$/.test(id)), "Expected LilyPond variable names mapped to lowercase musical voice IDs");
  assert.equal(new Set(voices.map(([, id]) => id)).size, voices.length, "Expected unique musical voice IDs");
  for (const sha256 of [reference.sha256, reference.memberSha256]) {
    if (sha256 !== undefined) assert.match(sha256, /^[a-f0-9]{64}$/i);
  }
  return { ...reference, file: reference.file && resolve(dirname(config), reference.file) };
}

async function loadEngraving({ file, download, sha256, archiveMember, memberSha256 }: VoiceReference) {
  const scratch = await mkdtemp(join(tmpdir(), "js-bach-voice-reference-"));
  try {
    const path = file ?? join(scratch, "reference");
    if (download) await downloadSource(download, path);
    const bytes = await readFile(path);
    const inputSha256 = verifySourceBytes(bytes, sha256, download ?? path);
    const engraving = archiveMember ? unzipSync(bytes, { filter: ({ name }) => name === archiveMember })[archiveMember] : bytes;
    assert.ok(engraving, `Missing reference archive member ${archiveMember}`);
    const engravingSha256 = verifySourceBytes(engraving, memberSha256, archiveMember ?? "LilyPond reference");
    return { bytes: engraving, inputSha256, engravingSha256 };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function* writtenSegments(score: ScoreIR, ticksPerQuarter: number) {
  const scale = ticksPerQuarter / score.ticksPerQuarter;
  for (const { number, startTick, events } of score.measures) {
    for (const event of events) {
      if (event.kind !== "note" || event.grace || event.durationTicks <= 0) continue;
      const note: ScoreVoiceNote = { measure: number, scoreVoice: event.voice, midiPitch: midiPitch(event.pitch),
        tick: (startTick + event.offsetTicks) * scale, durationTicks: event.durationTicks * scale,
        tieStart: event.tieStart, tieStop: event.tieStop };
      yield { note, event };
    }
  }
}

function checkPlayback(score: ScoreIR, mapping: Parameters<typeof performanceForMovement>[1]) {
  try {
    const performance = performanceForMovement(score, mapping);
    assert.deepEqual({ ...performance, notes: performance.notes.map(({ voiceId, ...note }) => note) }, toPerformance(score));
    return { status: "passed", performedNotes: performance.notes.length } as const;
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) } as const;
  }
}

function compilerCheck(score: ScoreIR, audit: VoiceAudit, id: string) {
  if (audit.scope !== "global" && audit.scope !== "measure") {
    return { status: "skipped", reason: "A complete assignment expressible with measure overrides is required." } as const;
  }
  const idsByVoice = new Map<string, string[]>();
  const voiceOverrides: { scoreVoice: string; measures: string[]; voiceId: string }[] = [];
  for (const { scoreVoice, measures } of audit.scoreVoices) {
    const counts = new Map<string, number>();
    for (const { voices: [{ voiceId, count }] } of measures) counts.set(voiceId, (counts.get(voiceId) ?? 0) + count);
    const [defaultVoice] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    idsByVoice.set(defaultVoice, [...(idsByVoice.get(defaultVoice) ?? []), scoreVoice]);
    for (const { measure, voices: [{ voiceId }] } of measures) {
      if (voiceId !== defaultVoice) voiceOverrides.push({ scoreVoice, measures: [measure], voiceId });
    }
  }
  const voices = [...new Set(audit.assignments.map(({ voiceId }) => voiceId))].sort().map((name) => ({ name, ids: idsByVoice.get(name) ?? [] }));
  return checkPlayback(score, { id, voices, voiceOverrides });
}

function markdown(id: string, report: Awaited<ReturnType<typeof auditMovement>>): string {
  const { reference, audit, ticksPerQuarter, withinMeasure, checks, scoreOnly, referenceOnly } = report;
  const byTie = audit.assignments.filter(({ evidence }) => evidence === "tie").length;
  const tieLabel = ({ tieStart, tieStop }: { tieStart: boolean; tieStop: boolean }) =>
    tieStart && tieStop ? "tie in/out" : tieStart ? "tie out" : tieStop ? "tie in" : "untied";
  const lines = [
    `# ${id} voice audit`, "",
    `- MusicXML: ${report.score.edition}. [Score source](${report.score.source})`,
    `- Reference: ${reference.credit}. ${reference.license}. [Engraving source](${reference.source})`,
    `- Input SHA-256: \`${reference.inputSha256}\`. LilyPond SHA-256: \`${reference.engravingSha256}\`.`,
    `- Written tick grid: ${ticksPerQuarter} ticks per quarter. Includes tie continuations and excludes grace notes.`, "",
    `**${audit.scoreCount - scoreOnly} exact note pairs** from ${audit.scoreCount} score segments and ${audit.referenceCount} reference segments. Musical voices were assigned to ${audit.assignments.length} score segments (${audit.assignments.length - byTie} directly and ${byTie} using written ties).`, "",
    `Exact multiset differences: ${scoreOnly} score-only segments and ${referenceOnly} reference-only segments. Unresolved exact unison groups: ${audit.ambiguities.length}. Matched spans with different tie counts or directions: ${audit.tieDifferences.length}.`, "",
    `Assignment scope: **${audit.scope}**. Measure overrides are **${report.measureCoverage}**. Within-measure conflicts with direct evidence: **${withinMeasure.length}**.`, "",
    ...(withinMeasure.some(({ sharedOnsets }) => sharedOnsets.length > 0)
      ? ["Some of those conflicts share an onset. Identifying a voice there requires distinguishing individual notes at the same tick.", ""] : []),
    `Playback compiler check: **${checks.compiler.status}**${checks.compiler.status === "passed" ? ` (${checks.compiler.performedNotes} performed notes)` : ""}.`,
    ...(checks.compiler.status === "passed" ? [] : [`- ${checks.compiler.reason}`]),
    ...(checks.manifest ? [
      `Existing manifest: ${checks.manifest.checked} assigned segments checked, ${checks.manifest.conflicts.length} disagreements. Per-voice written spans and ties: **${checks.manifest.segmentCountsMatch ? "matched" : "differ"}** (${checks.manifest.scoreSegments} score segments and ${checks.manifest.referenceSegments} reference segments).`,
      `Existing manifest playback: **${checks.manifest.playback.status}** (${checks.manifest.playback.status === "passed" ? `${checks.manifest.playback.performedNotes} performed notes` : checks.manifest.playback.reason}).`,
    ] : []),
    ...(checks.manifestError ? [`Existing manifest check failed. ${checks.manifestError}`] : []), "",
    "## Score labels and matched musical voices", "",
    "| Score voice | Musical voices and matched segments | Unassigned score segments |", "| --- | --- | ---: |",
    ...report.scoreVoices.map(({ scoreVoice, voices, unassigned }) =>
      `| ${scoreVoice} | ${voices.map(({ voiceId, count }) => `${voiceId} ${count}`).join(", ") || "—"} | ${unassigned} |`),
    "", "## Within-measure conflicts", "",
  ];
  if (withinMeasure.length === 0) lines.push("None in directly matched segments.");
  else lines.push("| Measure | Score voice | Shared onset offsets | Offsets in ticks, MIDI pitches and reference voices |", "| --- | --- | --- | --- |",
    ...withinMeasure.map(({ measure, scoreVoice, sharedOnsets, notes }) => `| ${measure} | ${scoreVoice} | ${sharedOnsets.join(", ") || "—"} | ${notes.map(({ offsetTicks, midiPitch, voiceId }) =>
      `${offsetTicks}: ${midiPitch} ${voiceId}`).join(", ")} |`));
  lines.push("", "## Written differences and unresolved unisons", "");
  const tieConflicts = new Set(audit.ambiguities.filter(({ reason }) => reason === "tie-evidence-conflict")
    .map(({ tick, durationTicks, midiPitch }) => `${tick}:${durationTicks}:${midiPitch}`));
  const findings = [
    ...audit.differences.map((bucket) => ({ ...bucket, reason: "different multiplicity" })),
    ...audit.ambiguities,
    ...audit.tieDifferences.filter(({ tick, durationTicks, midiPitch }) => !tieConflicts.has(`${tick}:${durationTicks}:${midiPitch}`))
      .map((bucket) => ({ ...bucket, reason: "different written ties" })),
  ];
  if (findings.length === 0) lines.push("None.");
  else lines.push("| Tick | Duration | MIDI pitch | Score voice labels | Reference voices | Finding |", "| ---: | ---: | ---: | --- | --- | --- |",
    ...findings
      .sort((a, b) => a.tick - b.tick || a.midiPitch - b.midiPitch)
      .map(({ tick, durationTicks, midiPitch, scoreNotes, referenceNotes, reason }) =>
        `| ${tick} | ${durationTicks} | ${midiPitch} | ${scoreNotes.map((note) => `${note.scoreVoice} (m. ${note.measure}, ${tieLabel(note)})`).join(", ") || "—"} | ${referenceNotes.map((note) => `${note.voiceId} (${tieLabel(note)})`).join(", ") || "—"} | ${reason} |`));
  lines.push("", "The JSON report retains each segment and its evidence. Review any edition differences and uncertain assignments before editing the corpus manifest.", "");
  return lines.join("\n");
}

async function auditMovement(id: string, reference: VoiceReference) {
  const movement = movements.find((candidate) => candidate.id === id);
  assert.ok(movement, `Unknown corpus movement ${id}`);
  const score = readMovementScore(movement);
  const { bytes, inputSha256, engravingSha256 } = await loadEngraving(reference);
  const engraving = readLilyPondVoices(new TextDecoder("utf-8", { fatal: true }).decode(bytes), reference.voices);
  const ticksPerQuarter = commonGrid(score.ticksPerQuarter, engraving.ticksPerQuarter);
  const scale = ticksPerQuarter / engraving.ticksPerQuarter;
  const written = Array.from(writtenSegments(score, ticksPerQuarter), ({ note }) => note);
  const referenceNotes = engraving.notes.map((note) => ({
    ...note, tick: note.tick * scale, durationTicks: note.durationTicks * scale,
  }));
  const audit = auditVoiceAssignments(written, referenceNotes);
  const countByScoreVoice = new Map<string, number>();
  for (const { scoreVoice } of written) countByScoreVoice.set(scoreVoice, (countByScoreVoice.get(scoreVoice) ?? 0) + 1);
  const scoreVoices = [...countByScoreVoice].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([scoreVoice, count]) => {
    const counts = new Map<string, number>();
    const assignments = audit.assignments.filter((note) => note.scoreVoice === scoreVoice);
    for (const { voiceId } of assignments) counts.set(voiceId, (counts.get(voiceId) ?? 0) + 1);
    return { scoreVoice, unassigned: count - assignments.length,
      voices: [...counts].map(([voiceId, count]) => ({ voiceId, count })).sort((a, b) => b.count - a.count) };
  });
  const withinMeasure = score.measures.flatMap(({ number, startTick }) => {
    const direct = audit.assignments.filter(({ measure, evidence }) => measure === number && evidence === "exact");
    return [...new Set(direct.map(({ scoreVoice }) => scoreVoice))].flatMap((scoreVoice) => {
      const notes = direct.filter((note) => note.scoreVoice === scoreVoice);
      if (new Set(notes.map(({ voiceId }) => voiceId)).size < 2) return [];
      const offsets = notes.map(({ tick, midiPitch, voiceId }) => ({
        offsetTicks: tick - startTick * ticksPerQuarter / score.ticksPerQuarter, midiPitch, voiceId,
      }));
      const sharedOnsets = [...new Set(offsets.map(({ offsetTicks }) => offsetTicks))].filter((offsetTicks) =>
        new Set(offsets.filter((note) => note.offsetTicks === offsetTicks).map(({ voiceId }) => voiceId)).size > 1,
      );
      return [{ measure: number, scoreVoice, sharedOnsets, notes: offsets }];
    });
  });
  let manifest: ManifestCheck | undefined;
  let manifestError: string | undefined;
  if (movement.voices?.length) {
    try {
      manifest = checkManifest(movement, score, ticksPerQuarter, referenceNotes, audit);
    } catch (error) {
      manifestError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    id, ticksPerQuarter, measureCount: score.measures.length, audit, withinMeasure, scoreVoices,
    measureCoverage: withinMeasure.length || audit.scope === "within-measure" ? "insufficient" : audit.scope === "incomplete" ? "undetermined" : "sufficient",
    score: { edition: movement.score.edition, source: movement.score.source, license: movement.score.license, sha256: movement.score.sha256 },
    reference: { ...reference, inputSha256, engravingSha256 },
    scoreOnly: audit.differences.reduce((sum, row) => sum + Math.max(0, row.scoreNotes.length - row.referenceNotes.length), 0),
    referenceOnly: audit.differences.reduce((sum, row) => sum + Math.max(0, row.referenceNotes.length - row.scoreNotes.length), 0),
    checks: { compiler: compilerCheck(score, audit, id), manifest, manifestError },
  };
}

interface ManifestCheck {
  checked: number;
  conflicts: VoiceAudit["assignments"];
  scoreSegments: number;
  referenceSegments: number;
  segmentCountsMatch: boolean;
  playback: ReturnType<typeof checkPlayback>;
}

export function checkManifest(
  movement: Parameters<typeof resolveVoiceForMovement>[1], score: ScoreIR, ticksPerQuarter: number,
  reference: readonly ReferenceVoiceNote[], audit: VoiceAudit,
): ManifestCheck {
  const resolveVoice = resolveVoiceForMovement(score, movement);
  const voiceBySegment = new Map<string, string | undefined>();
  const scoreSegmentKey = ({ measure, scoreVoice, tick, durationTicks, midiPitch, tieStart, tieStop }: ScoreVoiceNote) =>
    JSON.stringify([measure, scoreVoice, tick, durationTicks, midiPitch, tieStart, tieStop]);
  const segmentKey = ({ tick, durationTicks, midiPitch, tieStart, tieStop }: ScoreVoiceNote | ReferenceVoiceNote, voiceId?: string) =>
    `${voiceId ?? ""}:${tick}:${durationTicks}:${midiPitch}:${tieStart}:${tieStop}`;
  // Verify the existing manifest as a hypothesis without feeding it to the matcher.
  const scoreSegments = Array.from(writtenSegments(score, ticksPerQuarter), ({ note, event }) => {
    // Override offsets are in the score's native grid, so resolve using the original event.
    const voiceId = resolveVoice?.(note.measure, note.scoreVoice, event);
    voiceBySegment.set(scoreSegmentKey(note), voiceId);
    return segmentKey(note, voiceId);
  }).sort();
  const referenceSegments = reference.map((note) => segmentKey(note, note.voiceId)).sort();
  return {
    checked: audit.assignments.length,
    conflicts: audit.assignments.filter((note) => voiceBySegment.get(scoreSegmentKey(note)) !== note.voiceId),
    scoreSegments: scoreSegments.length,
    referenceSegments: referenceSegments.length,
    segmentCountsMatch: scoreSegments.length === referenceSegments.length &&
      scoreSegments.every((segment, index) => segment === referenceSegments[index]),
    playback: checkPlayback(score, movement),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const usage = "Usage: npm run audit:voices -- <movement-id> [--reference <config.json>]";
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { reference: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) console.log(usage);
    else {
      assert.equal(positionals.length, 1, usage);
      const [id] = positionals;
      const report = await auditMovement(id, await getReference(id, values.reference));
      const output = fileURLToPath(new URL("../voice-audit/", import.meta.url));
      await mkdir(output, { recursive: true });
      const directory = await mkdtemp(join(output, `${id}-`));
      try {
        await writeFile(join(directory, "voice-audit.json"), `${JSON.stringify(report, null, 2)}\n`);
        await writeFile(join(directory, "voice-audit.md"), markdown(id, report));
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      console.log(`${id} — ${report.audit.assignments.length}/${report.audit.scoreCount} assigned, ${report.withinMeasure.length} within-measure conflicts`);
      console.log(join(directory, "voice-audit.md"));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
