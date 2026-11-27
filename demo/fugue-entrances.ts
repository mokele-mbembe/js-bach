interface EntranceNote {
  readonly voiceId: string | null;
  readonly midiPitch: number;
  readonly startSeconds: number;
}

export interface FugueEntrance extends EntranceNote {
  readonly voiceId: string;
  readonly kind: "subject" | "answer";
  readonly measure: number;
}

// The opening entries follow Ebenezer Prout, Analysis of J. S. Bach's
// Forty-Eight Fugues, Fugues 1–3. Each starts on its voice's first performed note.
const openingEntries: ReadonlyMap<string, readonly Omit<FugueEntrance, "startSeconds">[]> = new Map([
  ["bwv846-fugue", [
    { voiceId: "alto", kind: "subject", measure: 1, midiPitch: 60 },
    { voiceId: "soprano", kind: "answer", measure: 2, midiPitch: 67 },
    { voiceId: "tenor", kind: "answer", measure: 4, midiPitch: 55 },
    { voiceId: "bass", kind: "subject", measure: 5, midiPitch: 48 },
  ]],
  ["bwv847-fugue", [
    { voiceId: "alto", kind: "subject", measure: 1, midiPitch: 72 },
    { voiceId: "soprano", kind: "answer", measure: 3, midiPitch: 79 },
    { voiceId: "bass", kind: "subject", measure: 7, midiPitch: 60 },
  ]],
  ["bwv848-fugue", [
    { voiceId: "soprano", kind: "subject", measure: 1, midiPitch: 68 },
    { voiceId: "alto", kind: "answer", measure: 3, midiPitch: 61 },
    { voiceId: "bass", kind: "subject", measure: 5, midiPitch: 56 },
  ]],
]);

export function getFugueEntrances(id: string, notes: readonly EntranceNote[]): readonly FugueEntrance[] {
  return (openingEntries.get(id) ?? []).flatMap((entrance) => {
    const firstNote = notes.find((note) => note.voiceId === entrance.voiceId);
    if (firstNote?.midiPitch !== entrance.midiPitch) return [];
    return [{ ...entrance, startSeconds: firstNote.startSeconds }];
  });
}
