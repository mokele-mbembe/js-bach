import { DOMParser, onErrorStopParsing, type Element } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import { midiPitch, naturalSemitones, type MeasureIR, type NotationMark, type ScoreIR, type WrittenPitch } from "./score-ir.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

function rootOf(xml: string): Element {
  const document = new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "application/xml");
  if (!document.documentElement) throw new Error("Missing XML root element");
  return document.documentElement;
}

function children(element: Element, name?: string): Element[] {
  return Array.from(element.children).filter((child) => name === undefined || child.localName === name);
}

function child(element: Element, name: string): Element | undefined {
  return children(element, name)[0];
}

function content(element: Element, name: string): string | undefined {
  return child(element, name)?.textContent?.trim() || undefined;
}

function readZipEntry(archive: Uint8Array, path: string): string {
  const entries = unzipSync(archive, { filter: (entry) => entry.name === path });
  if (!Object.hasOwn(entries, path)) throw new Error(`Missing ${path} in MXL archive`);
  return decoder.decode(entries[path]);
}

export function importMxl(archive: Uint8Array): ScoreIR {
  return importMusicXml(readMxlMusicXml(archive));
}

export function readMxlMusicXml(archive: Uint8Array): string {
  const container = rootOf(readZipEntry(archive, "META-INF/container.xml"));
  const rootfiles = child(container, "rootfiles");
  const path = rootfiles && child(rootfiles, "rootfile")?.getAttribute("full-path");
  if (container.localName !== "container" || !path) {
    throw new Error("MXL container must identify the score in its first rootfile");
  }
  return readZipEntry(archive, path);
}

function integer(value: string | undefined, label: string, minimum?: number): number {
  const result = Number(value);
  if (!value || !/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(result) || (minimum !== undefined && result < minimum)) {
    throw new Error(`Invalid ${label}: ${value ?? "missing"}`);
  }
  return result;
}

function safeTicks(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid tick position or duration: ${value}`);
  return value;
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function readPitch(pitch: Element): WrittenPitch {
  const step = content(pitch, "step");
  if (!step || !Object.hasOwn(naturalSemitones, step)) throw new Error(`Invalid pitch step: ${step ?? "missing"}`);
  const result: WrittenPitch = {
    step: step as WrittenPitch["step"],
    alter: integer(content(pitch, "alter") ?? "0", "pitch alteration"),
    octave: integer(content(pitch, "octave"), "octave", 0),
  };
  const number = midiPitch(result);
  if (number < 0 || number > 127) throw new Error(`Pitch outside MIDI range: ${number}`);
  return result;
}

function readNotations(event: Element): NotationMark[] {
  return children(event, "notations").flatMap((notations) =>
    children(notations)
      .filter((mark) => mark.localName !== "tied")
      .flatMap((mark) => mark.localName === "ornaments" ? children(mark) : [mark])
      .map((mark) => ({
        kind: mark.localName ?? mark.tagName,
        attributes: Object.fromEntries(Array.from(mark.attributes, ({ name, value }) => [name, value])),
        text: mark.textContent?.trim() ?? "",
      })),
  );
}

/** Imports the pitched, single-part MusicXML subset used by the keyboard corpus. */
export function importMusicXml(xml: string): ScoreIR {
  const root = rootOf(xml);
  const version = root.getAttribute("version");
  if (root.localName !== "score-partwise" || (version !== "3.1" && version !== "4.0")) {
    throw new Error("Expected a MusicXML 3.1 or 4.0 score-partwise document");
  }

  const parts = children(root, "part");
  if (parts.length !== 1) throw new Error(`Expected one part, found ${parts.length}`);
  const part = parts[0];
  const partId = part.getAttribute("id");
  if (!partId) throw new Error("Missing part ID");
  const measures = children(part, "measure");
  if (measures.length === 0) throw new Error(`Part ${partId} has no measures`);

  // Take the least common multiple so changes in divisions never require rounding.
  const divisionsByElement = new Map<Element, number>();
  let ticksPerQuarter = 1;
  for (const measure of measures) {
    try {
      for (const attributes of children(measure, "attributes")) {
        const divisions = child(attributes, "divisions");
        if (!divisions) continue;
        const value = integer(divisions.textContent?.trim(), "divisions", 1);
        divisionsByElement.set(attributes, value);
        ticksPerQuarter = safeTicks((ticksPerQuarter / greatestCommonDivisor(ticksPerQuarter, value)) * value);
      }
    } catch (cause) {
      throw measureError(partId, measure.getAttribute("number"), cause);
    }
  }

  const work = child(root, "work");
  const identification = child(root, "identification");
  const score: ScoreIR = {
    workNumber: work && content(work, "work-number"),
    title: content(root, "movement-title") ?? (work && content(work, "work-title")),
    composer: identification && children(identification, "creator")
      .find((creator) => creator.getAttribute("type") === "composer")?.textContent?.trim(),
    partId,
    ticksPerQuarter,
    tempoChanges: [],
    measures: [],
  };

  let measureStart = 0;
  let divisions: number | undefined;
  for (const measure of measures) {
    const number = measure.getAttribute("number");
    try {
      if (!number) throw new Error("Missing measure number");
      const result: MeasureIR = { number, startTick: measureStart, durationTicks: 0, events: [] };
      let cursor = 0;
      let chordOnset: number | undefined;

      for (const element of children(measure)) {
        switch (element.localName) {
          case "attributes":
            if (child(element, "measure-style")) throw new Error("Measure styles are unsupported");
            divisions = divisionsByElement.get(element) ?? divisions;
            break;
          case "backup":
          case "forward": {
            const duration = durationOf(element, divisions, ticksPerQuarter);
            cursor = safeTicks(cursor + (element.localName === "forward" ? duration : -duration));
            result.durationTicks = Math.max(result.durationTicks, cursor);
            chordOnset = undefined;
            break;
          }
          case "note": {
            if (child(element, "cue") || element.hasAttribute("attack") || element.hasAttribute("release") || element.hasAttribute("time-only")) {
              throw new Error("Cue and explicitly retimed notes are unsupported");
            }
            const grace = child(element, "grace");
            const rest = child(element, "rest");
            const chord = child(element, "chord");
            if (grace && (rest || chord || child(element, "duration"))) throw new Error("Expected a pitched grace note without duration");
            const onset = chord ? chordOnset : cursor;
            if (onset === undefined || (rest && chord)) throw new Error("Chord tone has no preceding pitched note");
            const duration = grace ? 0 : durationOf(element, divisions, ticksPerQuarter);
            const end = safeTicks(onset + duration);
            const timed = {
              offsetTicks: onset,
              durationTicks: duration,
              voice: content(element, "voice") ?? "1",
              staff: integer(content(element, "staff") ?? "1", "staff", 1),
              notations: readNotations(element),
            };
            if (!chord) cursor = end;
            result.durationTicks = Math.max(result.durationTicks, end);

            if (rest) {
              result.events.push({ kind: "rest", ...timed });
              chordOnset = undefined;
            } else {
              const pitch = child(element, "pitch");
              if (!pitch) throw new Error("Expected a pitched note");
              const ties = children(element, "tie").map((tie) => {
                const type = tie.getAttribute("type");
                if ((type !== "start" && type !== "stop") || tie.hasAttribute("time-only")) {
                  throw new Error("Unsupported playback tie");
                }
                return type;
              });
              result.events.push({
                kind: "note", ...timed, pitch: readPitch(pitch),
                tieStart: ties.includes("start"), tieStop: ties.includes("stop"),
                ...(grace && { grace: {
                  type: content(element, "type"),
                  attributes: Object.fromEntries(Array.from(grace.attributes, ({ name, value }) => [name, value])),
                } }),
              });
              chordOnset = grace ? undefined : onset;
            }
            break;
          }
          case "direction":
          case "sound": {
            const sound = element.localName === "sound" ? element : child(element, "sound");
            if (!sound) break;
            if (Array.from(sound.attributes).some(({ name }) => name !== "tempo") || child(element, "offset") || child(sound, "offset")) {
              throw new Error("Unsupported playback direction");
            }
            const beatsPerMinute = Number(sound.getAttribute("tempo"));
            if (!Number.isFinite(beatsPerMinute) || beatsPerMinute <= 0) throw new Error("Invalid tempo");
            score.tempoChanges.push({ tick: safeTicks(measureStart + cursor), beatsPerMinute });
            break;
          }
          case "barline": {
            if (child(element, "ending")) throw new Error("Alternate endings are unsupported");
            const repeat = child(element, "repeat");
            if (!repeat) break;
            const location = element.getAttribute("location") || "right";
            const direction = repeat.getAttribute("direction");
            if (repeat.hasAttribute("after-jump")) throw new Error("Conditional repeats are unsupported");
            if (location === "left" && direction === "forward" && !result.repeatStart && !repeat.hasAttribute("times")) {
              result.repeatStart = true;
            } else if (location === "right" && direction === "backward" && result.repeatEnd === undefined) {
              result.repeatEnd = integer(repeat.getAttribute("times") ?? "2", "repeat times", 1);
            } else {
              throw new Error("Unsupported repeat barline");
            }
            break;
          }
        }
      }

      if (result.durationTicks === 0) throw new Error("Measure has no timed content");
      score.measures.push(result);
      measureStart = safeTicks(measureStart + result.durationTicks);
    } catch (cause) {
      throw measureError(partId, number, cause);
    }
  }

  score.tempoChanges.sort((a, b) => a.tick - b.tick);
  return score;
}

function durationOf(element: Element, divisions: number | undefined, ticksPerQuarter: number): number {
  if (divisions === undefined) throw new Error("Missing divisions before timed content");
  return safeTicks(integer(content(element, "duration"), `${element.localName} duration`, 1) * (ticksPerQuarter / divisions));
}

function measureError(partId: string, number: string | null, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Part ${partId}, measure ${number || "(unknown)"}: ${detail}`, { cause });
}
