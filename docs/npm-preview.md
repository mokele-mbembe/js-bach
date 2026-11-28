# js-bach npm preview

The local player includes 64 movements from The Well-Tempered Clavier, BWV 846–877. It requires Node.js 22 or later and a browser with Web Audio.

Install the preview and start the player from your terminal.

```sh
npm install @mokele-mbembe/js-bach@preview
npm exec -- js-bach
```

Open the local address printed in the terminal. Choose a work and select Prelude or Fugue, then click **Play**. Changing the selection stops playback. The default address is `http://127.0.0.1:4173/`. Set `PORT` to use another port.

## Use the browser API

In an ESM browser app, import `play` and `stop` from the package. The package includes TypeScript declarations and loads the selected movement on demand through the app's own assets.

```html
<button id="bach-play">Play Bach</button>
<button id="bach-stop">Stop</button>
```

```js
import { play, stop } from "@mokele-mbembe/js-bach";

document.querySelector("#bach-play").addEventListener("click", () => {
  play("bwv846").catch((error) => {
    if (error.name !== "AbortError") console.error(error);
  });
});
document.querySelector("#bach-stop").addEventListener("click", stop);
```

Call `play` directly from a user gesture so the browser can start Web Audio. The default movement is the prelude. Pass `{ movement: "fugue" }` for the fugue or `{ movement: "fugue", voice: "Alto" }` to solo the alto in BWV 846. `play` resolves to a handle with `position()` in seconds and `stop()` for that playback. Starting another movement replaces the current playback. Calling the exported `stop()` also cancels pending playback. If a start is canceled or superseded, its promise rejects with `AbortError`.

### Programmable voices

The `0.1.3` preview introduced two read-only queries. Both work without Web Audio and load only the requested movement. `getVoices` returns the verified musical voice IDs and names in your installed corpus. The current repository includes verified groups for the fugues BWV 846–849 and BWV 855. A solo can use either form, such as `"alto"` or `"Alto"`. `getPerformance` returns `durationSeconds` and note events with `startSeconds`, `endSeconds`, `midiPitch`, `voiceId`, and `scoreVoice`. Times are seconds from the beginning of the full movement, including written repeats and tied durations. `scoreVoice` is the source label at the attack and can appear under different `voiceId` values in different measures. Movements without verified groups return an empty voice list and `null` for each note’s `voiceId`.

```js
import { getVoices, getPerformance, play } from "@mokele-mbembe/js-bach";

const fugue = { movement: "fugue" };
const voices = await getVoices("bwv846", fugue);
const { notes, durationSeconds } = await getPerformance("bwv846", fugue);
const alto = voices.find(({ id }) => id === "alto");
let scheduled = [];

let playback;
document.querySelector("#bach-play").addEventListener("click", async () => {
  scheduled = [];
  playback = await play("bwv846", {
    ...fugue,
    muted: ["Alto"],
    onNote(note) {
      scheduled.push(note);
      // On the same audio clock, a synth can use note.audioStartTime and note.audioEndTime.
    },
  });
});
document.querySelector("#mute-alto").addEventListener("change", (event) => {
  if (alto) playback?.setVoiceMuted(alto.id, event.currentTarget.checked);
});
```

Draw a piano roll from `notes` and `durationSeconds`. To highlight scheduled notes when they sound, compare `playback.position()` with their `startSeconds` and `endSeconds`. Whole-movement playback uses the `getPerformance()` timeline. Solo playback rebases the selected voice to its first entrance.

`onNote` receives a `ScheduledNote` when Web Audio schedules the oscillator, up to 150 ms ahead. `audioStartTime` and `audioEndTime` are seconds on the player's `AudioContext` clock. Use those times directly with the same audio clock, or translate them before passing them to a synth on a different clock. The callback starts after `play()` returns its handle. Calling `stop()` in the callback stops further callbacks immediately.

Scheduling continues while a callback promise is pending. A synchronous throw or a rejected callback promise stops the playback that invoked the callback and surfaces as an uncaught browser error. A rejection from an earlier playback leaves its replacement playing.

`muted` starts the listed voice buses at zero gain. Muted voices still schedule oscillators and emit `onNote`, so restoring a sustained voice keeps its original timing. `voice`, `muted`, and `setVoiceMuted` accept either the voice ID or its display name. During a solo, the initial and live mute settings apply to the selected voice. Other labels raise `RangeError`.

### Seek and stereo pan

The `0.1.4` preview adds `startSeconds`, `pan`, and `setVoicePan`. From a click handler, start anywhere on the movement timeline and set initial pan by voice ID or display name.

```js
const playback = await play("bwv846", {
  movement: "fugue",
  startSeconds: 20,
  pan: { Alto: -0.6, bass: 0.6 },
  muted: ["Tenor"],
});
playback.setVoicePan("Alto", 0);
```

Pan ranges from `-1` (left) to `1` (right) with `0` at center. Unspecified voices start centered. During a solo, both controls accept the selected voice only. Unknown voices and out-of-range or non-finite pan values raise `RangeError`. In browsers without stereo panners, the voice buses keep their centered routing and mute controls.

`startSeconds` ranges from zero to `getPerformance().durationSeconds`, inclusive. At the endpoint playback completes without scheduling notes. Passing a start time uses full movement coordinates even for a solo. Omitting it starts a solo at its first entrance with the existing rebased timeline. When seeking into a sustained note, the player starts a new oscillator at the seek point for the remaining duration. `position()` and the callback's `startSeconds` and `endSeconds` use the movement timeline. The callback keeps the note's original musical times, while `audioStartTime` reflects the new oscillator onset.

### Tempo and transposition

The `0.1.4` preview supports `tempoRate` from `0.5` through `2` and integer `transpose` values from `-12` through `12` semitones. The defaults are `1` and `0`. Invalid values raise `RangeError`.

```js
const playback = await play("bwv848", {
  movement: "fugue",
  startSeconds: 127.55,
  tempoRate: 1.5,
  transpose: 2,
});
```

`startSeconds`, `position()`, and the callback's `startSeconds` and `endSeconds` are measured at the original tempo. At `tempoRate: 2`, two seconds of that timeline pass in one audio second. The 150 ms scheduling window and `audioStartTime` and `audioEndTime` use the Web Audio clock. `onNote.midiPitch` gives the sounding pitch after transposition, while `getPerformance()` still returns the original pitches and timings.

In the demo, changing speed or pitch during play resumes from the current position with the same mute and pan settings. The piano roll shows the sounding pitches on the original time scale.

## Rebuild and licenses

The TypeScript source, build scripts, and original score files are in `source/`. To rebuild from source, run `npm ci` and `npm run pack:preview` in that directory.

The player code is licensed under [GPL-3.0-only](LICENSE). The [score licenses and credits](SCORE-LICENSES.md) apply to the bundled score data and the original MusicXML and MIDI files.
