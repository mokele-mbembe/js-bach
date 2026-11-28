import type { Performance } from "../src/performance.js";
import { describeVoices, performanceTimeline, type PlaybackAsset } from "../src/playback-asset.js";
import { getFugueEntrances } from "./fugue-entrances.js";
import { createPianoRoll, createPianoRollPalette } from "./piano-roll.js";

interface MixerControls {
  mute(id: string, muted: boolean): void;
  pan(id: string, position: number): void;
  seek(seconds: number): void;
}

export function createPolyphony(panel: HTMLElement, controls: MixerControls) {
  const canvas = panel.querySelector("canvas")!;
  const roll = createPianoRoll(canvas, controls.seek);
  const heading = panel.querySelector("#polyphony-title")!;
  const choices = panel.querySelector("#mute-choices")!;
  const entranceList = panel.querySelector<HTMLOListElement>("#fugue-entrances")!;
  const muted = new Set<string>();
  let voiceIds: readonly string[] = [];
  let pan: Readonly<Record<string, number>> | undefined;
  const spread = document.createElement("button");
  spread.type = "button";
  spread.textContent = "Spread voices";
  spread.addEventListener("click", () => {
    pan = pan ? undefined : Object.fromEntries(voiceIds.map((id, index) => [id, 2 * index / (voiceIds.length - 1) - 1]));
    spread.setAttribute("aria-pressed", String(pan !== undefined));
    for (const id of voiceIds) controls.pan(id, pan?.[id] ?? 0);
  });

  function show(performance: Performance, { source, work }: PlaybackAsset): void {
    const { voices } = describeVoices(source.voices);
    voiceIds = voices.map(({ id }) => id);
    const voiceColor = createPianoRollPalette(voiceIds);
    muted.clear();
    pan = undefined;
    spread.disabled = voiceIds.length < 2;
    spread.setAttribute("aria-pressed", "false");
    const timeline = performanceTimeline(performance);
    const notes = timeline.notes.flatMap((note) => note.voiceId === null ? [] : [{ ...note, voiceId: note.voiceId }]);
    const entries = getFugueEntrances(source.id, notes);
    roll.setMovement({ ...timeline, notes, entries, voiceColor });
    heading.textContent = `BWV ${work.bwv} ${source.kind} · piano roll`;
    canvas.setAttribute("aria-label", `Playback position in the ${voices.length}-voice ${source.kind} piano roll`);

    choices.replaceChildren(...voices.map(({ id, name }) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = id;
      input.addEventListener("change", () => {
        if (input.checked) muted.add(id);
        else muted.delete(id);
        controls.mute(id, input.checked);
        roll.setMutedVoices(muted);
      });
      label.style.setProperty("--voice-color", voiceColor(id));
      const text = document.createElement("span");
      text.textContent = `Mute ${name}`;
      label.append(input, text);
      return label;
    }), spread);

    entranceList.hidden = entries.length === 0;
    entranceList.replaceChildren(...entries.map(({ kind, measure, voiceId, startSeconds }) => {
      const { name } = voices.find(({ id }) => id === voiceId)!;
      const item = document.createElement("li");
      item.style.setProperty("--voice-color", voiceColor(voiceId));
      item.textContent = `${kind === "subject" ? "S" : "A"} · ${name} ${kind} · m. ${measure} · ${startSeconds.toFixed(2)} s`;
      return item;
    }));
  }

  return {
    show,
    setVisible: (visible: boolean) => { panel.hidden = !visible; },
    setPosition: roll.setPosition,
    get voiceIds() { return voiceIds; },
    get muted(): ReadonlySet<string> { return muted; },
    get pan() { return pan; },
  };
}
