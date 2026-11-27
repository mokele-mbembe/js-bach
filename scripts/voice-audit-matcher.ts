interface WrittenSpan {
  tick: number;
  durationTicks: number;
  midiPitch: number;
}

interface WrittenNote extends WrittenSpan {
  tieStart: boolean;
  tieStop: boolean;
}

export interface ScoreVoiceNote extends WrittenNote {
  scoreVoice: string;
  measure: string;
}

export interface ReferenceVoiceNote extends WrittenNote {
  voiceId: string;
}

interface Assignment extends ScoreVoiceNote {
  voiceId: string;
  evidence: "exact" | "tie";
}

interface NoteBucket extends WrittenSpan {
  scoreNotes: ScoreVoiceNote[];
  referenceNotes: ReferenceVoiceNote[];
}

interface Ambiguity extends NoteBucket {
  reason: "underdetermined" | "tie-evidence-conflict";
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
  tieDifferences: NoteBucket[];
  ambiguities: Ambiguity[];
  scoreVoices: AuditedScoreVoice[];
  scope: "global" | "measure" | "within-measure" | "incomplete";
}

type VoiceCounts = Map<string, number>;

function addCount(counts: VoiceCounts, id: string): void {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

function groupByTie<T extends WrittenNote>(notes: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const note of notes) {
    const key = `${note.tieStart}:${note.tieStop}`;
    const group = groups.get(key) ?? [];
    group.push(note);
    groups.set(key, group);
  }
  return groups;
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
  const tieDifferences: NoteBucket[] = [];
  const ambiguities: Ambiguity[] = [];
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
      continue;
    }

    const scoreGroups = groupByTie(scoreNotes);
    const referenceGroups = groupByTie(referenceNotes);
    const tieMismatch = [...scoreGroups].some(([key, notes]) => referenceGroups.get(key)?.length !== notes.length);
    if (tieMismatch) tieDifferences.push(bucket);

    const { voiceId } = referenceNotes[0];
    if (referenceNotes.every((note) => note.voiceId === voiceId)) {
      for (const note of scoreNotes) record(note, voiceId, "exact");
      continue;
    }
    if (tieMismatch) {
      ambiguities.push({ ...bucket, reason: "tie-evidence-conflict" });
      continue;
    }

    // Neighboring assignments can suggest a label, but a written voice number
    // can change roles within a measure. Require independent evidence here.
    for (const [key, compatibleScore] of scoreGroups) {
      const compatibleReference = referenceGroups.get(key)!;
      const { voiceId: compatibleVoice } = compatibleReference[0];
      if (compatibleReference.every((note) => note.voiceId === compatibleVoice)) {
        for (const note of compatibleScore) record(note, compatibleVoice, "tie");
      } else {
        ambiguities.push({ ...bucket, scoreNotes: compatibleScore, referenceNotes: compatibleReference, reason: "underdetermined" });
      }
    }
  }

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

  return { scoreCount: score.length, referenceCount: reference.length, assignments, differences, tieDifferences, ambiguities, scoreVoices, scope };
}
