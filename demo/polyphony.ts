import type { Performance } from "../src/performance.js";
import { describeVoices, performanceTimeline, type PlaybackAsset } from "../src/playback-asset.js";
import { getFugueEntrances } from "./fugue-entrances.js";
import { createPianoRoll, createPianoRollPalette } from "./piano-roll.js";

export function createPolyphony(panel: HTMLElement, onMute: (id: string, muted: boolean) => void) {
  const canvas = panel.querySelector("canvas")!;
  const roll = createPianoRoll(canvas);
  const heading = panel.querySelector("#polyphony-title")!;
  const choices = panel.querySelector("#mute-choices")!;
  const entranceList = panel.querySelector<HTMLOListElement>("#fugue-entrances")!;
  const muted = new Set<string>();
  let voiceIds: readonly string[] = [];

  function show(performance: Performance, { source, work }: PlaybackAsset): void {
    const { voices } = describeVoices(source.voices);
    voiceIds = voices.map(({ id }) => id);
    const voiceColor = createPianoRollPalette(voiceIds);
    muted.clear();
    const timeline = performanceTimeline(performance);
    const notes = timeline.notes.flatMap((note) => note.voiceId === null ? [] : [{ ...note, voiceId: note.voiceId }]);
    const entries = getFugueEntrances(source.id, notes);
    roll.setMovement({ ...timeline, notes, entries, voiceColor });
    heading.textContent = `BWV ${work.bwv} ${source.kind} · piano roll`;
    canvas.setAttribute("aria-label", `${voices.length} ${source.kind} voices by pitch and elapsed time`);

    choices.replaceChildren(...voices.map(({ id, name }) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = id;
      input.addEventListener("change", () => {
        if (input.checked) muted.add(id);
        else muted.delete(id);
        onMute(id, input.checked);
        roll.setMutedVoices(muted);
      });
      label.style.setProperty("--voice-color", voiceColor(id));
      const text = document.createElement("span");
      text.textContent = `Mute ${name}`;
      label.append(input, text);
      return label;
    }));

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
  };
}
