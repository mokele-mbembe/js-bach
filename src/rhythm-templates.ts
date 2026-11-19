import type { MeasureIR, NoteEvent, RestEvent, ScoreIR, WrittenPitch } from "./score-ir.js";

type TemplateEvent = Omit<NoteEvent, "pitch"> | RestEvent;

interface TemplateMeasure extends Omit<MeasureIR, "events"> {
  templateId: number;
  pitches: WrittenPitch[];
}

export interface RhythmEncodedScore extends Omit<ScoreIR, "measures"> {
  rhythmTemplates?: TemplateEvent[][];
  measures: (MeasureIR | TemplateMeasure)[];
}

export function encodeRhythmTemplates(score: ScoreIR): RhythmEncodedScore {
  const candidates = score.measures.map((measure) => {
    const template: TemplateEvent[] = [];
    const pitches: WrittenPitch[] = [];
    for (const event of measure.events) {
      if (event.kind === "note") {
        const { pitch, ...shape } = event;
        template.push(shape);
        pitches.push(pitch);
      } else {
        template.push(event);
      }
    }
    // Match entire measures, including event order, voices, ties, and markings.
    const signature = JSON.stringify([measure.durationTicks, template]);
    return { measure, template, pitches, signature };
  });

  const counts = new Map<string, number>();
  for (const { signature } of candidates) {
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }

  const rhythmTemplates: TemplateEvent[][] = [];
  const templateIds = new Map<string, number>();
  const measures = candidates.map(({ measure, template, pitches, signature }) => {
    if (counts.get(signature) === 1) return measure;
    let templateId = templateIds.get(signature);
    if (templateId === undefined) {
      templateId = rhythmTemplates.length;
      rhythmTemplates.push(template);
      templateIds.set(signature, templateId);
    }
    const { events, ...header } = measure;
    return { ...header, templateId, pitches };
  });

  return rhythmTemplates.length > 0 ? { ...score, measures, rhythmTemplates } : score;
}

export function expandRhythmTemplates(encoded: RhythmEncodedScore): ScoreIR {
  const { measures, rhythmTemplates, ...header } = encoded;
  return {
    ...header,
    measures: measures.map((measure) => {
      if ("events" in measure) return measure;
      const { templateId, pitches, ...measureHeader } = measure;
      const template = rhythmTemplates?.[templateId];
      if (!template) throw new Error(`Missing rhythm template ${templateId} for measure ${measure.number}`);

      let pitchIndex = 0;
      const events = structuredClone(template).map((event) => {
        if (event.kind === "rest") return event;
        const pitch = pitches[pitchIndex++];
        if (!pitch) throw new Error(`Missing pitch for rhythm template in measure ${measure.number}`);
        return { ...event, pitch: { ...pitch } };
      });
      if (pitchIndex !== pitches.length) throw new Error(`Extra pitches for rhythm template in measure ${measure.number}`);
      return { ...measureHeader, events };
    }),
  };
}
