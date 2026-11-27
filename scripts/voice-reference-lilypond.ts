import { naturalSemitones } from "../src/score-ir.js";

interface ReferenceNote {
  voiceId: string;
  tick: number;
  durationTicks: number;
  midiPitch: number;
}

const ticksPerQuarter = 256;
const semitones = Object.values(naturalSemitones);
const pitchStyles = {
  italiano: { steps: ["do", "re", "mi", "fa", "sol", "la", "si"], alterations: { d: 1, dd: 2, b: -1, bb: -2 } },
  nederlands: { steps: ["c", "d", "e", "f", "g", "a", "b"], alterations: { is: 1, isis: 2, es: -1, eses: -2 } },
  english: { steps: ["c", "d", "e", "f", "g", "a", "b"], alterations: { s: 1, ss: 2, f: -1, ff: -2 } },
};
type PitchStyle = keyof typeof pitchStyles;

const displayCommands = new Set([
  "voiceOne", "voiceTwo", "voiceThree", "voiceFour", "oneVoice", "voiceUp", "voiceDown",
  "shiftOn", "shiftOff", "tieUp", "tieDown", "slurDashed", "slurUp", "glissando", "fermata", "trill",
]);

function pitchLanguage(source: string): PitchStyle {
  const languages = [...source.matchAll(/\\(?:include|language)\s+"([^"\r\n]+)"/gu)]
    .map(([, language]) => language.replace(/\.ly$/u, ""));
  const language = languages[0] ?? "nederlands";
  if (!Object.hasOwn(pitchStyles, language) || languages.some((entry) => entry !== language)) {
    throw new Error(`Unsupported LilyPond pitch language or include: ${languages.join(", ")}`);
  }
  return language as PitchStyle;
}

function pitchReader(language: PitchStyle) {
  const { steps, alterations } = pitchStyles[language];
  const name = new RegExp(`^(${steps.join("|")})([a-z]*)([',]*)[!?]?$`, "u");
  return (token: string) => {
    // Dutch E-flat and A-flat are conventionally contracted.
    const spelling = language === "nederlands" ? token.replace(/^([ea])s(es)?(?=[',!?]*$)/u, "$1es$2") : token;
    const match = name.exec(spelling);
    if (!match) return undefined;
    const [, step, alteration, marks] = match;
    if (alteration && !Object.hasOwn(alterations, alteration)) return undefined;
    return {
      step: steps.indexOf(step),
      alter: alteration ? (alterations as Record<string, number>)[alteration] : 0,
      offset: [...marks].reduce((shift, mark) => shift + (mark === "'" ? 7 : -7), 0),
    };
  };
}

function layoutAliases(source: string): ReadonlySet<string> {
  const declarations = [...source.matchAll(/^[ \t]*([A-Za-z][A-Za-z0-9_]*)[ \t]*=[ \t]*([^\r\n]+)/gmu)];
  const aliases = new Set(displayCommands);
  const declared = new Set<string>();
  const redefined = new Set<string>();
  for (const [, name] of declarations) {
    if (declared.has(name)) redefined.add(name);
    declared.add(name);
    aliases.delete(name);
  }
  for (const [, name, definition] of declarations) {
    if (redefined.has(name)) continue;
    if (/^\\change\s+Staff\s*=\s*\w+\s*$/u.test(definition) ||
      /^\\once\s*\\override\s+Tie\s+#'Y-offset\s*=\s*#-?\d+(?:\.\d+)?\s*$/u.test(definition)) {
      aliases.add(name);
      continue;
    }
    const block = /^\{\s*((?:\\[A-Za-z][A-Za-z0-9]*\s*)+)\}\s*$/u.exec(definition);
    if (block && block[1].trim().split(/\s+/u).every((command) => aliases.has(command.slice(1)))) aliases.add(name);
  }
  return aliases;
}

function voiceNotes(
  variable: string,
  voiceId: string,
  reference: string,
  body: string,
  parsePitch: ReturnType<typeof pitchReader>,
  aliases: ReadonlySet<string>,
  global: string | undefined,
): ReferenceNote[] {
  const unsupported = (token: string) => new Error(`${variable}: unsupported LilyPond token or duration ${JSON.stringify(token)}`);
  const initial = parsePitch(reference);
  if (!initial) throw unsupported(reference);
  let preceding = 21 + initial.step + initial.offset;
  let tick = 0;
  let previousDuration = ticksPerQuarter;
  let ticksPerBar = ticksPerQuarter * 4;
  const notes: ReferenceNote[] = [];
  const tokens = body.match(/"(?:[^"\\]|\\.)*"|\\[A-Za-z][A-Za-z0-9]*|[a-zA-Z]+[',]*[!?]?|\d+|\.+|[^\s]/gu) ?? [];
  let index = 0;

  function readDuration(): number {
    if (!/^\d+$/u.test(tokens[index] ?? "")) return previousDuration;
    const denominator = Number(tokens[index++]);
    const base = ticksPerQuarter * 4 / denominator;
    let duration = base;
    if (/^\.+$/u.test(tokens[index] ?? "")) {
      for (let dot = 1; dot <= tokens[index].length; dot++) duration += base / 2 ** dot;
      index++;
    }
    if (!Number.isInteger(Math.log2(denominator)) || !Number.isSafeInteger(duration) || duration <= 0) {
      throw unsupported(String(denominator));
    }
    previousDuration = duration;
    return duration;
  }

  while (index < tokens.length) {
    const token = tokens[index++];
    if (token === "|") {
      if (tick % ticksPerBar !== 0) throw new Error(`${variable}: LilyPond bar check failed at tick ${tick}`);
      continue;
    }
    if (token === "~" || token === "(" || token === ")" || token === "[" || token === "]") continue;
    if (token === "\\global") {
      const meter = /^\s*\\key\s+(\S+)\s+\\(?:major|minor)\s+\\time\s+(\d+)\/(\d+)\s*$/u.exec(global ?? "");
      if (tick !== 0 || !meter || !parsePitch(meter[1])) throw unsupported(token);
      ticksPerBar = ticksPerQuarter * 4 * Number(meter[2]) / Number(meter[3]);
      if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar <= 0) throw unsupported(meter[0]);
      continue;
    }
    if (token === "\\bar" || token === "\\clef") {
      const argument = tokens[index++] ?? "";
      if (!/^"[^"\r\n]*"$/u.test(argument) && (token !== "\\clef" || !/^(?:bass|treble|alto|tenor)$/u.test(argument))) {
        throw unsupported(`${token} ${argument}`);
      }
      continue;
    }
    if (token.startsWith("\\") && aliases.has(token.slice(1))) continue;
    if (token === "r" || token === "R" || token === "s") {
      const duration = readDuration();
      let count = 1;
      if (tokens[index] === "*") {
        index++;
        if (!/^[1-9]\d*$/u.test(tokens[index] ?? "")) throw unsupported("*");
        count = Number(tokens[index++]);
      }
      tick += duration * count;
      if (!Number.isSafeInteger(tick)) throw unsupported(token);
      continue;
    }
    const pitch = parsePitch(token);
    if (!pitch) throw unsupported(token);
    // Relative octave selection uses the diatonic distance, before applying accidentals.
    const distance = ((pitch.step - preceding + 3) % 7 + 7) % 7 - 3;
    preceding += distance + pitch.offset;
    const durationTicks = readDuration();
    if (tokens[index] === "\\rest") {
      index++;
    } else {
      const midiPitch = (Math.floor(preceding / 7) + 1) * 12 + semitones[pitch.step] + pitch.alter;
      if (midiPitch < 0 || midiPitch > 127) throw unsupported(token);
      notes.push({ voiceId, tick, durationTicks, midiPitch });
    }
    tick += durationTicks;
    if (!Number.isSafeInteger(tick)) throw unsupported(token);
  }
  return notes;
}

/** Reads selected inline relative voice lines as data, preserving written tie segments. */
export function readLilyPondVoices(source: string, variables: Readonly<Record<string, string>>): {
  ticksPerQuarter: number;
  notes: ReferenceNote[];
} {
  const code = source.replace(/("(?:[^"\\]|\\.)*")|%\{[\s\S]*?%\}|%[^\r\n]*/gu, (_, quoted: string | undefined) => quoted ?? "");
  const parsePitch = pitchReader(pitchLanguage(code));
  const aliases = layoutAliases(code);
  const global = [...code.matchAll(/^[ \t]*global\s*=/gmu)].length === 1
    ? /^[ \t]*global\s*=\s*\{([^{}]*)\}/mu.exec(code)?.[1]
    : undefined;
  const entries = Object.entries(variables);
  if (entries.length === 0 || new Set(entries.map(([, id]) => id)).size !== entries.length) {
    throw new Error("Select at least one LilyPond variable with a distinct voice ID");
  }
  const notes = entries.flatMap(([variable, voiceId]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(variable) || !voiceId) throw new Error(`Invalid LilyPond voice selection: ${variable}`);
    const assignment = `^[ \\t]*${variable}\\s*=`;
    const match = new RegExp(`${assignment}\\s*\\\\relative\\s*([^{}]*?)\\{([^{}]*)\\}`, "mu").exec(code);
    if (!match || [...code.matchAll(new RegExp(assignment, "gmu"))].length !== 1) {
      throw new Error(`${variable}: expected one inline LilyPond relative voice block`);
    }
    const [, header, body] = match;
    const reference = header.replace(/\s*(?:\\context\s+Staff\s*=\s*"[^"\r\n]+"\s*)?\\new\s+Voice\s*$/u, "").trim();
    const voice = voiceNotes(variable, voiceId, reference, body, parsePitch, aliases, global);
    if (voice.length === 0) throw new Error(`${variable}: no timed notes in LilyPond voice`);
    return voice;
  });
  return { ticksPerQuarter, notes };
}
