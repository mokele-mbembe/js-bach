import { playPerformance, type MixedPlayback } from "../src/oscillator-player.js";
import type { Performance } from "../src/performance.js";
import { decodePlayback, describeVoices, soloMusicalVoice, type PlaybackAsset } from "../src/playback-asset.js";
import type { createPolyphony } from "./polyphony.js";

const corpus = new URL("../corpus/", import.meta.url);

interface Movement {
  asset: PlaybackAsset;
  performance: Performance;
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
const retry = element<HTMLButtonElement>("#retry");
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
const polyphonyPanel = element("#polyphony");

const movements = new Map<string, Movement>();
let pendingMovement: { id: string; controller: AbortController; promise: Promise<Movement> } | undefined;
let selected: Movement | undefined;
let selectionAttempt = 0;
let current: { performance: Performance; label: string } | undefined;
let audio: AudioContext | undefined;
let playback: MixedPlayback | undefined;
let polyphony: ReturnType<typeof createPolyphony> | undefined;
let attempt = 0;
let frame = 0;

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function showPosition(position: number): void {
  progress.value = position;
  elapsed.textContent = formatTime(position);
  if (!polyphonyPanel.hidden) polyphony?.setPosition(position, playback !== undefined && position > 0);
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

function showRhythmTemplates({ templateCount, measures }: PlaybackAsset["analysis"]["rhythm"]): void {
  const reusedMeasures = measures.filter(([, templateId]) => templateId !== undefined).length;
  const measureCount = measures.length;
  rhythmSummary.textContent = templateCount > 0
    ? `${reusedMeasures} of ${measureCount} measures use shared rhythm templates.`
    : `All ${measureCount} measures are stored as individual events.`;

  measureMap.hidden = templateCount === 0;
  measureMap.replaceChildren(...(templateCount === 0 ? [] : measures.map(([measureNumber, templateId]) => {
    const item = document.createElement("li");
    const number = document.createElement("span");
    const label = document.createElement("small");
    number.textContent = measureNumber;
    if (templateId !== undefined) {
      const templateNumber = templateId + 1;
      item.dataset.template = String(templateNumber);
      item.setAttribute("aria-label", `Measure ${measureNumber}, template ${templateNumber}`);
      label.textContent = `T${templateNumber}`;
    } else {
      item.setAttribute("aria-label", `Measure ${measureNumber}, individual events`);
      label.textContent = "Events";
    }
    item.append(number, label);
    return item;
  })));
}

function showTransposedFragments(
  { ticksPerQuarter, measures, fragments }: PlaybackAsset["analysis"]["transposed"],
  { voices: groups, scopedScoreVoices }: PlaybackAsset["source"],
): void {
  const count = fragments.reduce((sum, [, , occurrences]) => sum + occurrences.length, 0);
  const voiceNames = new Map(groups?.flatMap(({ name, ids }) => ids.map((id) => [id, name] as const)));
  for (const scoreVoice of scopedScoreVoices ?? []) voiceNames.delete(scoreVoice);
  fragmentSummary.textContent = count > 0
    ? `${count} occurrences of ${fragments.length} shared fragments. Shifts are measured from the first occurrence shown for each fragment.`
    : "The fragment search kept the ordinary event stream.";
  fragmentMap.hidden = count === 0;

  const containingMeasure = (tick: number) => measures.find(([, start, duration]) =>
    tick >= start && tick < start + duration,
  );

  fragmentMap.replaceChildren(...fragments.map(([noteCount, length, occurrences], index) => {
    const item = document.createElement("li");
    item.className = "fragment-group";
    const title = document.createElement("h3");
    title.textContent = `Fragment ${index + 1} · ${noteCount} notes`;
    const locations = document.createElement("ul");
    locations.className = "fragment-locations";
    const originPitch = occurrences[0][2];

    for (const [voice, start, pitch] of occurrences) {
      const first = containingMeasure(start);
      const last = containingMeasure(start + length - 1);
      if (!first || !last) throw new Error(`Missing measure for fragment at tick ${start}`);
      const location = first === last ? `m. ${first[0]}` : `mm. ${first[0]}–${last[0]}`;
      const part = voiceNames.get(voice) ?? `Score voice ${voice}`;
      const beat = 1 + (start - first[1]) / ticksPerQuarter;
      const shift = pitch - originPitch;
      const marker = document.createElement("li");
      marker.title = `${part}, ${location}, starts on beat ${beat}, ${shift} semitones`;
      const interval = document.createElement("span");
      interval.textContent = `${shift > 0 ? "+" : ""}${shift} st`;
      marker.append(`${part} · ${location}`, interval);
      locations.append(marker);
    }

    item.append(title, locations);
    return item;
  }));
}

function showEncoding({ analysis, sizes, source }: PlaybackAsset): void {
  showRhythmTemplates(analysis.rhythm);
  showTransposedFragments(analysis.transposed, source);
  eventBytes.textContent = `${sizes.eventStream.brotliBytes.toLocaleString("en-US")} B`;
  templateBytes.textContent = `${sizes.rhythmEncoding.brotliBytes.toLocaleString("en-US")} B`;
  fragmentBytes.textContent = `${sizes.transposedEncoding.brotliBytes.toLocaleString("en-US")} B`;
  encodingPanel.hidden = false;
}

function showMovement(movement: Movement): void {
  const { asset } = movement;
  const { source, work } = asset;
  const groups = source.voices ?? [];
  showEncoding(asset);
  voices.hidden = groups.length === 0;
  voices.disabled = groups.length === 0;
  voiceChoices.replaceChildren(
    radioOption("voice", "all", "All voices", true),
    ...groups.map(({ name }) => radioOption("voice", name, name, false)),
  );
  catalogue.textContent = `BWV ${work.bwv} / ${source.key ?? work.key} / ${work.collection}`;

  const { title, score, referenceMidi } = source;
  const attribution = score.attribution ?? `${referenceMidi.typesetter} / Mutopia Project (${referenceMidi.edition})`;
  credits.replaceChildren(
    `${work.composer}, ${title}, BWV ${work.bwv}. MusicXML from `,
    link(score.edition, score.source),
    " (",
    score.licenseUrl ? link(score.license, score.licenseUrl) : score.license.toLowerCase(),
    "), based on the ",
    link(attribution, score.upstream ?? referenceMidi.source),
    ". ",
    score.changes,
  );

  selected = movement;
  updateVoice();
}

function updateVoice(): void {
  if (!selected) return;
  stopPlayback();
  const { source } = selected.asset;
  const voice = element<HTMLInputElement>('input[name="voice"]:checked').value;
  const { voices: groups } = describeVoices(source.voices);
  const group = groups.find(({ name }) => name === voice);
  const label = source.kind === "fugue" ? "Fugue" : "Prelude";
  current = {
    performance: group ? soloMusicalVoice(selected.performance, group.id) : selected.performance,
    label: group ? `${label} · ${group.name}` : label,
  };
  polyphony?.setVisible(groups.length > 0 && !group);
  progress.max = current.performance.durationSeconds;
  duration.textContent = formatTime(current.performance.durationSeconds);
  setTransport(false, "Ready");
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
    const onEnded = () => {
      playback = undefined;
      cancelAnimationFrame(frame);
      showPosition(performance.durationSeconds);
      setTransport(false, `Finished ${label}`);
    };
    const mixer = polyphonyPanel.hidden ? undefined : polyphony;
    playback = playPerformance(audio, performance, onEnded, mixer?.voiceIds ?? [], { muted: mixer && [...mixer.muted] });
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

selection.addEventListener("change", ({ target }) => {
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === "voice") updateVoice();
  else void loadSelection();
});

retry.addEventListener("click", () => {
  if (workChoices.childElementCount > 0) void loadSelection();
  else void loadCatalog();
});

async function fetchJson<T>(file: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(new URL(file, corpus), { signal });
  if (!response.ok) throw new Error(`Could not load ${file}`);
  return response.json() as Promise<T>;
}

async function fetchMovement(bwv: string, id: string): Promise<Movement> {
  if (pendingMovement?.id === id) return pendingMovement.promise;
  pendingMovement?.controller.abort();
  pendingMovement = undefined;

  const cached = movements.get(id);
  if (cached) return cached;

  const controller = new AbortController();
  const promise = fetchJson<PlaybackAsset>(`bwv${bwv}/${id}.playback.json`, controller.signal).then((asset) => {
    controller.signal.throwIfAborted();
    if (asset.source.id !== id) throw new Error(`Unexpected score for ${id}`);
    const movement = { asset, performance: decodePlayback(asset) };
    movements.set(id, movement);
    return movement;
  }).finally(() => {
    if (pendingMovement?.controller === controller) pendingMovement = undefined;
  });
  pendingMovement = { id, controller, promise };
  return promise;
}

async function loadSelection(): Promise<void> {
  const bwv = document.querySelector<HTMLInputElement>('input[name="work"]:checked')?.value;
  if (!bwv) return;
  const kind = element<HTMLInputElement>('input[name="movement"]:checked').value;
  const id = `bwv${bwv}-${kind}`;
  const request = ++selectionAttempt;
  stopPlayback();
  current = undefined;
  selected = undefined;
  voices.hidden = true;
  voices.disabled = true;
  encodingPanel.hidden = true;
  polyphony?.setVisible(false);
  catalogue.textContent = `BWV ${bwv}`;
  credits.replaceChildren();
  duration.textContent = formatTime(0);
  retry.hidden = true;
  setTransport(false, `Loading BWV ${bwv} ${kind}…`);
  try {
    const movement = await fetchMovement(bwv, id);
    if (request !== selectionAttempt) return;
    const hasVoices = Boolean(movement.asset.source.voices?.length);
    if (hasVoices) {
      if (!polyphony) {
        const roll = await import("./polyphony.js").catch(() => undefined);
        if (request !== selectionAttempt) return;
        polyphony = roll?.createPolyphony(polyphonyPanel, (id, muted) => playback?.setVoiceMuted(id, muted));
      }
      polyphony?.show(movement.performance, movement.asset);
    }
    showMovement(movement);
    if (hasVoices && !polyphony) setTransport(false, "Ready. Piano roll unavailable.");
  } catch (error) {
    if (request !== selectionAttempt) return;
    movements.delete(id);
    const message = error instanceof Error ? error.message : "Could not read the score";
    setTransport(false, `${message}. Select another movement or retry.`);
    retry.hidden = false;
  }
}

async function loadCatalog(): Promise<void> {
  retry.hidden = true;
  setTransport(false, "Loading catalog…");
  try {
    const { works } = await fetchJson<{ works: Pick<PlaybackAsset["work"], "bwv" | "key">[] }>("catalog.json");
    const mainWork = works.find(({ bwv }) => bwv === "846") ?? works[0];
    if (!mainWork) throw new Error("The catalog contains no works");
    workChoices.replaceChildren(...works.map(({ bwv, key }) => radioOption("work", bwv, `BWV ${bwv} · ${key}`, bwv === mainWork.bwv)));
    await loadSelection();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the catalog";
    setTransport(false, `${message}. Retry to load the catalog.`);
    retry.hidden = false;
  }
}

void loadCatalog();
