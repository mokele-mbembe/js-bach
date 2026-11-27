interface WrittenSpan {
  tick: number;
  durationTicks: number;
  midiPitch: number;
}

export interface ScoreVoiceNote extends WrittenSpan {
  scoreVoice: string;
  measure: string;
}

export interface ReferenceVoiceNote extends WrittenSpan {
  voiceId: string;
}

interface Assignment extends ScoreVoiceNote {
  voiceId: string;
  evidence: "exact" | "context";
}

interface NoteBucket extends WrittenSpan {
  scoreNotes: ScoreVoiceNote[];
  referenceNotes: ReferenceVoiceNote[];
}

interface Ambiguity extends NoteBucket {
  reason: "underdetermined" | "conflicting-evidence";
}

interface AuditedScoreVoice {
  scoreVoice: string;
  measures: { measure: string; voices: { voiceId: string; count: number }[] }[];
}

export interface VoiceAudit {
  scoreCount: number;
  referenceCount: number;
  assignments: Assignment[];
  differences: NoteBucket[];
  ambiguities: Ambiguity[];
  scoreVoices: AuditedScoreVoice[];
  scope: "global" | "measure" | "within-measure" | "incomplete";
}

type VoiceCounts = Map<string, number>;

function addCount(counts: VoiceCounts, id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

function uniqueVoice(counts: VoiceCounts | undefined): string | undefined {
  return counts?.size === 1 ? counts.keys().next().value : undefined;
}

/** Compare written note segments on a common integer tick grid, including tie continuations. */
export function auditVoiceAssignments(
  score: readonly ScoreVoiceNote[],
  reference: readonly ReferenceVoiceNote[],
): VoiceAudit {
  const buckets = new Map<string, NoteBucket>();
  function bucketFor({ tick, durationTicks, midiPitch }: WrittenSpan): NoteBucket {
    const key = `${tick}:${durationTicks}:${midiPitch}`;
    const bucket = buckets.get(key) ?? { tick, durationTicks, midiPitch, scoreNotes: [], referenceNotes: [] };
    buckets.set(key, bucket);
    return bucket;
  }
  for (const note of score) bucketFor(note).scoreNotes.push(note);
  for (const note of reference) bucketFor(note).referenceNotes.push(note);

  const assignments: Assignment[] = [];
  const differences: NoteBucket[] = [];
  const ambiguities: Ambiguity[] = [];
  const unisons: NoteBucket[] = [];
  const global = new Map<string, VoiceCounts>();
  const local = new Map<string, Map<string, VoiceCounts>>();

  function record(note: ScoreVoiceNote, voiceId: string, evidence: Assignment["evidence"]): void {
    assignments.push({ ...note, voiceId, evidence });
    const byVoice = global.get(note.scoreVoice) ?? new Map<string, number>();
    addCount(byVoice, voiceId);
    global.set(note.scoreVoice, byVoice);
    const byMeasure = local.get(note.scoreVoice) ?? new Map<string, VoiceCounts>();
    const voices = byMeasure.get(note.measure) ?? new Map<string, number>();
    addCount(voices, voiceId);
    byMeasure.set(note.measure, voices);
    local.set(note.scoreVoice, byMeasure);
  }

  for (const bucket of buckets.values()) {
    const { scoreNotes, referenceNotes } = bucket;
    if (scoreNotes.length !== referenceNotes.length) {
      differences.push(bucket);
    } else if (referenceNotes.every(({ voiceId }) => voiceId === referenceNotes[0].voiceId)) {
      for (const note of scoreNotes) record(note, referenceNotes[0].voiceId, "exact");
    } else {
      unisons.push(bucket);
    }
  }

  // Use only direct evidence when resolving unisons. A contextual assignment
  // must not become evidence for guessing at another ambiguous group.
  const contextual: Assignment[] = [];
  for (const bucket of unisons) {
    const remaining = new Map<string, ReferenceVoiceNote[]>();
    for (const note of bucket.referenceNotes) {
      const notes = remaining.get(note.voiceId) ?? [];
      notes.push(note);
      remaining.set(note.voiceId, notes);
    }

    const matched: Assignment[] = [];
    const unresolved: ScoreVoiceNote[] = [];
    let conflict = false;
    for (const note of bucket.scoreNotes) {
      const localEvidence = local.get(note.scoreVoice)?.get(note.measure);
      const voiceId = uniqueVoice(localEvidence ?? global.get(note.scoreVoice));
      if (voiceId === undefined) {
        unresolved.push(note);
        continue;
      }
      const candidates = remaining.get(voiceId);
      if (!candidates?.pop()) {
        conflict = true;
        break;
      }
      if (candidates.length === 0) remaining.delete(voiceId);
      matched.push({ ...note, voiceId, evidence: "context" });
    }
    if (conflict) {
      ambiguities.push({ ...bucket, reason: "conflicting-evidence" });
      continue;
    }

    contextual.push(...matched);
    if (unresolved.length === 0) continue;
    if (remaining.size === 1) {
      const [voiceId] = remaining.keys();
      for (const note of unresolved) contextual.push({ ...note, voiceId, evidence: "context" });
    } else {
      ambiguities.push({
        ...bucket,
        scoreNotes: unresolved,
        referenceNotes: [...remaining.values()].flat(),
        reason: "underdetermined",
      });
    }
  }
  for (const { voiceId, evidence, ...note } of contextual) record(note, voiceId, evidence);

  const scoreVoices = [...local].map(([scoreVoice, measures]) => ({
    scoreVoice,
    measures: [...measures].map(([measure, voices]) => ({
      measure, voices: [...voices].map(([voiceId, count]) => ({ voiceId, count })),
    })),
  }));
  let scope: VoiceAudit["scope"] = "global";
  if (differences.length || ambiguities.length) scope = "incomplete";
  else if (scoreVoices.some(({ measures }) => measures.some(({ voices }) => voices.length > 1))) scope = "within-measure";
  else if ([...global.values()].some((voices) => voices.size > 1)) scope = "measure";

  return { scoreCount: score.length, referenceCount: reference.length, assignments, differences, ambiguities, scoreVoices, scope };
}
