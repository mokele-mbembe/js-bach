import { naturalSemitones } from "../src/score-ir.js";

interface ReferenceNote {
  voiceId: string;
  tick: number;
  durationTicks: number;
  midiPitch: number;
  tieStart: boolean;
  tieStop: boolean;
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
const contextCommands = new Set(["\\change", "\\context", "\\new"]);
const parsedCommands = new Set(["relative", "context", "new", "bar", "clef", "rest", "key", "major", "minor", "time"]);
const topLevelDirectives = new Set([
  "\\book", "\\bookpart", "\\header", "\\include", "\\language", "\\layout", "\\midi", "\\paper", "\\score", "\\version",
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

function readDeclarations(source: string): ReadonlyMap<string, string[]> {
  const tokens = [...source.matchAll(/"(?:[^"\\]|\\.)*"|\\[A-Za-z][\w-]*|[A-Za-z][\w-]*|<<|>>|[{}=]/gu)];
  const statements: { start: number; assignment?: { name: string; valueStart: number } }[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const { 0: token, index: start } = tokens[index];
    if (token === "{" || token === "<<") depth++;
    if (token === "}" || token === ">>") depth--;
    if (depth !== 0) continue;
    if (topLevelDirectives.has(token)) {
      statements.push({ start });
      continue;
    }
    const equals = tokens[index + 1];
    // Staff = name in a context expression belongs to the expression, not the variable scope.
    if (equals?.[0] !== "=" || contextCommands.has(tokens[index - 1]?.[0]) ||
      !/^\s*$/u.test(source.slice(start + token.length, equals.index))) continue;
    const name = token.startsWith('"') ? token.slice(1, -1) : token;
    if (/^[A-Za-z][A-Za-z0-9_]*$/u.test(name)) statements.push({ start, assignment: { name, valueStart: equals.index + 1 } });
  }
  const declarations = new Map<string, string[]>();
  for (const [index, { assignment }] of statements.entries()) {
    if (!assignment) continue;
    const { name, valueStart } = assignment;
    const definitions = declarations.get(name) ?? [];
    definitions.push(source.slice(valueStart, statements[index + 1]?.start).trim());
    declarations.set(name, definitions);
  }
  return declarations;
}

function layoutAliases(declarations: ReadonlyMap<string, string[]>): ReadonlySet<string> {
  const aliases = new Set(displayCommands);
  for (const name of declarations.keys()) aliases.delete(name);
  for (const [name, definitions] of declarations) {
    if (definitions.length !== 1) continue;
    const [definition] = definitions;
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
  let openTie: ReferenceNote | undefined;
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
    if (token === "~") {
      const previous = notes.at(-1);
      if (!previous || openTie || previous.tick + previous.durationTicks !== tick) throw unsupported(token);
      previous.tieStart = true;
      openTie = previous;
      continue;
    }
    if (token === "(" || token === ")" || token === "[" || token === "]") continue;
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
      if (openTie) throw unsupported("tie followed by rest or skip");
      let duration = readDuration();
      if (tokens[index] === "*") {
        index++;
        if (!/^[1-9]\d*$/u.test(tokens[index] ?? "")) throw unsupported("*");
        duration *= Number(tokens[index++]);
      }
      previousDuration = duration;
      tick += duration;
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
      if (openTie) throw unsupported("tie followed by pitched rest");
      index++;
    } else {
      const midiPitch = (Math.floor(preceding / 7) + 1) * 12 + semitones[pitch.step] + pitch.alter;
      if (midiPitch < 0 || midiPitch > 127) throw unsupported(token);
      if (openTie && openTie.midiPitch !== midiPitch) throw unsupported("tie to a different pitch");
      notes.push({ voiceId, tick, durationTicks, midiPitch, tieStart: false, tieStop: openTie !== undefined });
      openTie = undefined;
    }
    tick += durationTicks;
    if (!Number.isSafeInteger(tick)) throw unsupported(token);
  }
  if (openTie) throw unsupported("tie without a continuation");
  return notes;
}

/** Reads selected inline relative voice lines as data, preserving written tie segments. */
export function readLilyPondVoices(source: string, variables: Readonly<Record<string, string>>): {
  ticksPerQuarter: number;
  notes: ReferenceNote[];
} {
  const code = source.replace(/("(?:[^"\\]|\\.)*")|%\{[\s\S]*?%\}|%[^\r\n]*/gu, (_, quoted: string | undefined) => quoted ?? " ");
  const parsePitch = pitchReader(pitchLanguage(code));
  const declarations = readDeclarations(code);
  for (const name of parsedCommands) {
    if (declarations.has(name)) throw new Error(`Unsupported redefinition of LilyPond command: ${name}`);
  }
  const aliases = layoutAliases(declarations);
  const globalDefinitions = declarations.get("global");
  const global = globalDefinitions?.length === 1
    ? /^\{([^{}]*)\}/u.exec(globalDefinitions[0])?.[1]
    : undefined;
  const entries = Object.entries(variables);
  if (entries.length === 0 || new Set(entries.map(([, id]) => id)).size !== entries.length) {
    throw new Error("Select at least one LilyPond variable with a distinct voice ID");
  }
  const notes = entries.flatMap(([variable, voiceId]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(variable) || !voiceId) throw new Error(`Invalid LilyPond voice selection: ${variable}`);
    const definitions = declarations.get(variable);
    const match = definitions?.length === 1 && /^\\relative\s*([^{}]*?)\{([^{}]*)\}/u.exec(definitions[0]);
    if (!match) {
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
