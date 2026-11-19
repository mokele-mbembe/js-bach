import { playPerformance, type Playback } from "../src/oscillator-player.js";
import { soloVoice, toPerformance, type Performance } from "../src/performance.js";
import { expandRhythmTemplates, type RhythmEncodedScore } from "../src/rhythm-templates.js";
import { expandTransposedFragments, type TransposedScore } from "../src/transposed-fragments.js";
import type { VoiceGroup, WorkSource } from "../scripts/corpus.js";

const corpus = "/corpus/";

interface CompressionSizes {
  eventStream: { brotliBytes: number };
  rhythmEncoding: { brotliBytes: number };
  transposedEncoding: { brotliBytes: number };
}

interface Movement {
  score: Performance;
  source: WorkSource["movements"][number];
  sizes: CompressionSizes;
  rhythm: RhythmEncodedScore;
  transposed: TransposedScore;
}

function element<T extends HTMLElement>(selector: string): T {
  const match = document.querySelector<T>(selector);
  if (!match) throw new Error(`Missing ${selector}`);
  return match;
}

const selection = element<HTMLFormElement>("#selection");
const workChoices = element("#works");
const catalogue = element("#catalogue");
const voices = element<HTMLFieldSetElement>("#voices");
const voiceChoices = element("#voice-choices");
const play = element<HTMLButtonElement>("#play");
const stop = element<HTMLButtonElement>("#stop");
const status = element("#status");
const progress = element<HTMLProgressElement>("#progress");
const elapsed = element("#elapsed");
const duration = element("#duration");
const credits = element("#credits");
const encodingPanel = element("#encoding");
const measureMap = element("#measure-map");
const fragmentMap = element("#fragment-map");
const rhythmSummary = element("#rhythm-summary");
const fragmentSummary = element("#fragment-summary");
const eventBytes = element("#event-bytes");
const templateBytes = element("#template-bytes");
const fragmentBytes = element("#fragment-bytes");

const works = new Map<string, WorkSource>();
const movements = new Map<string, Movement>();
let current: { id: string; performance: Performance; label: string } | undefined;
let audio: AudioContext | undefined;
let playback: Playback | undefined;
let attempt = 0;
let frame = 0;

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function showPosition(position: number): void {
  progress.value = position;
  elapsed.textContent = formatTime(position);
}

function setTransport(isPlaying: boolean, message: string): void {
  play.disabled = isPlaying || !current;
  stop.disabled = !isPlaying;
  status.textContent = message;
}

function stopPlayback(): void {
  attempt++;
  playback?.stop();
  playback = undefined;
  cancelAnimationFrame(frame);
  showPosition(0);
}

function link(label: string, url: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.textContent = label;
  anchor.href = url;
  return anchor;
}

function radioOption(name: string, value: string, label: string, checked: boolean): HTMLLabelElement {
  const option = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const text = document.createElement("span");
  text.textContent = label;
  option.append(input, text);
  return option;
}

function showRhythmTemplates(encoding: RhythmEncodedScore): void {
  const templateCount = encoding.rhythmTemplates?.length ?? 0;
  const reusedMeasures = encoding.measures.filter((measure) => "templateId" in measure).length;
  const measureCount = encoding.measures.length;
  rhythmSummary.textContent = templateCount > 0
    ? `${reusedMeasures} of ${measureCount} measures use shared rhythm templates.`
    : `All ${measureCount} measures are stored as individual events.`;

  measureMap.hidden = templateCount === 0;
  measureMap.replaceChildren(...(templateCount === 0 ? [] : encoding.measures.map((measure) => {
    const item = document.createElement("li");
    const number = document.createElement("span");
    const label = document.createElement("small");
    number.textContent = measure.number;
    if ("templateId" in measure) {
      const templateNumber = measure.templateId + 1;
      item.dataset.template = String(templateNumber);
      item.setAttribute("aria-label", `Measure ${measure.number}, template ${templateNumber}`);
      label.textContent = `T${templateNumber}`;
    } else {
      item.setAttribute("aria-label", `Measure ${measure.number}, individual events`);
      label.textContent = "Events";
    }
    item.append(number, label);
    return item;
  })));
}

function showTransposedFragments(encoding: TransposedScore, voiceGroups: VoiceGroup[]): void {
  const groups = encoding.transposedFragments ?? [];
  const count = groups.reduce((sum, [, occurrences]) => sum + occurrences.length, 0);
  const voiceNames = new Map(voiceGroups.flatMap(({ name, ids }) => ids.map((id) => [id, name] as const)));
  fragmentSummary.textContent = count > 0
    ? `${count} occurrences of ${groups.length} shared fragments. Shifts are measured from the first occurrence shown for each fragment.`
    : "The fragment search kept the ordinary event stream.";
  fragmentMap.hidden = count === 0;

  const containingMeasure = (tick: number) => encoding.measures.find((measure) =>
    tick >= measure.startTick && tick < measure.startTick + measure.durationTicks,
  );

  fragmentMap.replaceChildren(...groups.map(([notes, occurrences], index) => {
    const item = document.createElement("li");
    item.className = "fragment-group";
    const title = document.createElement("h3");
    title.textContent = `Fragment ${index + 1} · ${notes.length} notes`;
    const locations = document.createElement("ul");
    locations.className = "fragment-locations";
    const length = Math.max(...notes.map(([offset, duration]) => offset + duration));
    const originPitch = occurrences[0][4];

    for (const [voice, , start, , pitch] of occurrences) {
      const first = containingMeasure(start);
      const last = containingMeasure(start + length - 1);
      if (!first || !last) throw new Error(`Missing measure for fragment at tick ${start}`);
      const measures = first === last ? `m. ${first.number}` : `mm. ${first.number}–${last.number}`;
      const part = voiceNames.get(voice) ?? `Voice ${voice}`;
      const beat = 1 + (start - first.startTick) / encoding.ticksPerQuarter;
      const shift = pitch - originPitch;
      const marker = document.createElement("li");
      marker.title = `${part}, ${measures}, starts on beat ${beat}, ${shift} semitones`;
      const interval = document.createElement("span");
      interval.textContent = `${shift > 0 ? "+" : ""}${shift} st`;
      marker.append(`${part} · ${measures}`, interval);
      locations.append(marker);
    }

    item.append(title, locations);
    return item;
  }));
}

function showEncoding(movement: Movement): void {
  const { sizes } = movement;
  showRhythmTemplates(movement.rhythm);
  showTransposedFragments(movement.transposed, movement.source.voices ?? []);
  eventBytes.textContent = `${sizes.eventStream.brotliBytes.toLocaleString("en-US")} B`;
  templateBytes.textContent = `${sizes.rhythmEncoding.brotliBytes.toLocaleString("en-US")} B`;
  fragmentBytes.textContent = `${sizes.transposedEncoding.brotliBytes.toLocaleString("en-US")} B`;
  encodingPanel.hidden = false;
}

function updateSelection(): void {
  const bwv = document.querySelector<HTMLInputElement>('input[name="work"]:checked')?.value;
  const work = bwv && works.get(bwv);
  if (!work) return;
  stopPlayback();
  const kind = element<HTMLInputElement>('input[name="movement"]:checked').value;
  const source = work.movements.find((candidate) => candidate.kind === kind);
  const movement = source && movements.get(source.id);
  if (!movement) return;

  const groups = movement.source.voices ?? [];
  voices.hidden = groups.length === 0;
  voices.disabled = groups.length === 0;
  if (current?.id !== movement.source.id) {
    voiceChoices.replaceChildren(
      radioOption("voice", "all", "All voices", true),
      ...groups.map(({ name }) => radioOption("voice", name, name, false)),
    );
  }
  const voice = element<HTMLInputElement>('input[name="voice"]:checked').value;
  const group = groups.find(({ name }) => name === voice);
  const label = kind === "fugue" ? "Fugue" : "Prelude";
  current = {
    id: movement.source.id,
    performance: group ? soloVoice(movement.score, group.ids) : movement.score,
    label: group ? `${label} · ${group.name}` : label,
  };
  catalogue.textContent = `BWV ${work.bwv} / ${source.key ?? work.key} / ${work.collection}`;
  progress.max = current.performance.durationSeconds;
  duration.textContent = formatTime(current.performance.durationSeconds);
  setTransport(false, "Ready");
  showEncoding(movement);

  const { title, score, referenceMidi } = movement.source;
  const attribution = score.attribution ?? `${referenceMidi.typesetter} / Mutopia Project (${referenceMidi.edition})`;
  credits.replaceChildren(
    `${work.composer}, ${title}, BWV ${work.bwv}. MusicXML from `,
    link(score.edition, score.source),
    " (",
    score.licenseUrl ? link(score.license, score.licenseUrl) : score.license.toLowerCase(),
    "), based on the ",
    link(attribution, score.upstream ?? referenceMidi.source),
    ". Converted to js-bach score data.",
  );
}

function updateProgress(): void {
  if (!playback) return;
  showPosition(playback.position());
  frame = requestAnimationFrame(updateProgress);
}

play.addEventListener("click", async () => {
  if (!current) return;
  const { performance, label } = current;
  const request = ++attempt;
  setTransport(true, "Starting audio…");
  showPosition(0);
  try {
    audio ??= new AudioContext();
    await audio.resume();
    if (request !== attempt) return;
    playback = playPerformance(audio, performance, () => {
      playback = undefined;
      cancelAnimationFrame(frame);
      showPosition(performance.durationSeconds);
      setTransport(false, `Finished ${label}`);
    });
    setTransport(true, `Playing ${label}`);
    updateProgress();
  } catch (error) {
    if (request !== attempt) return;
    const message = error instanceof Error ? error.message : "Unknown audio error";
    setTransport(false, `Could not play audio. ${message}`);
  }
});

stop.addEventListener("click", () => {
  stopPlayback();
  setTransport(false, "Stopped");
});

selection.addEventListener("change", updateSelection);

async function fetchJson<T>(file: string): Promise<T> {
  const response = await fetch(`${corpus}${file}`);
  if (!response.ok) throw new Error(`Could not load ${file}`);
  return response.json() as Promise<T>;
}

async function load(): Promise<void> {
  try {
    const catalog = await fetchJson<{ works: Pick<WorkSource, "bwv" | "key">[] }>("catalog.json");
    await Promise.all(catalog.works.map(async ({ bwv }) => {
      const path = `bwv${bwv}/`;
      const [work, compression] = await Promise.all([
        fetchJson<WorkSource>(`${path}sources.json`),
        fetchJson<{ movements: Record<string, CompressionSizes> }>(`${path}compression.json`),
      ]);
      works.set(bwv, work);
      await Promise.all(work.movements.map(async (source) => {
        const { id } = source;
        const [rhythm, transposed] = await Promise.all([
          fetchJson<RhythmEncodedScore>(`${path}${id}.rhythm.json`),
          fetchJson<TransposedScore>(`${path}${id}.transposed.json`),
        ]);
        const sizes = compression.movements[id];
        if (!sizes) throw new Error(`Missing compression sizes for ${id}`);
        const score = sizes.rhythmEncoding.brotliBytes <= sizes.transposedEncoding.brotliBytes
          ? expandRhythmTemplates(rhythm)
          : expandTransposedFragments(transposed);
        movements.set(id, { score: toPerformance(score), source, sizes, rhythm, transposed });
      }));
    }));
    workChoices.replaceChildren(...catalog.works.map(({ bwv, key }, index) => radioOption("work", bwv, `BWV ${bwv} · ${key}`, index === 0)));
    updateSelection();
  } catch (error) {
    works.clear();
    movements.clear();
    const message = error instanceof Error ? error.message : "Could not read the scores";
    setTransport(false, `${message}. Reload to retry.`);
  }
}

void load();
