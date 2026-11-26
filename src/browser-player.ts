import { playPerformance, type Playback } from "./oscillator-player.js";
import { decodePlayback, soloVoice, type PlaybackAsset } from "./playback-asset.js";

export type { Playback } from "./oscillator-player.js";

export interface PlayOptions {
  /** The selected movement. Defaults to the prelude. */
  movement?: "prelude" | "fugue";
  /** A solo voice by its score label, such as "Alto". Defaults to all voices. */
  voice?: string;
}

export interface BrowserPlayer {
  /** Start playback from a browser user gesture. Stops the previous playback. */
  play(bwv: string, options?: PlayOptions): Promise<Playback>;
  /** Stop active playback or cancel a pending play call with an AbortError. */
  stop(): void;
}

export function createBrowserPlayer(
  findMovement: (id: string) => (() => Promise<PlaybackAsset>) | undefined,
): BrowserPlayer {
  let audio: AudioContext | undefined;
  let pending: AbortController | undefined;
  let active: Playback | undefined;

  function stop(): void {
    pending?.abort();
    pending = undefined;
    active?.stop();
  }

  async function play(bwv: string, { movement = "prelude", voice }: PlayOptions = {}): Promise<Playback> {
    if (typeof bwv !== "string" || !/^bwv\d+$/i.test(bwv.trim())) {
      throw new RangeError("Enter a work ID such as bwv846.");
    }
    if (movement !== "prelude" && movement !== "fugue") {
      throw new RangeError('Choose movement "prelude" or "fugue".');
    }
    const id = `${bwv.trim().toLowerCase()}-${movement}`;
    const load = findMovement(id);
    if (!load) throw new RangeError(`No playback data available for ${id}.`);
    if (typeof AudioContext !== "function") throw new Error("Playback requires a browser with Web Audio.");

    stop();
    const request = new AbortController();
    const { signal } = request;
    pending = request;
    try {
      const context = audio ??= new AudioContext();
      // Request audio access while still inside the user's click or key handler.
      const resumed = context.resume();
      const assetPromise = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return load();
      });
      const canceled = new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const [asset] = await Promise.race([Promise.all([assetPromise, resumed]), canceled]);
      signal.throwIfAborted();
      if (asset.source.id !== id) throw new Error(`Unexpected playback asset for ${id}.`);

      let performance = decodePlayback(asset.performance);
      if (voice !== undefined) {
        const voices = asset.source.voices ?? [];
        const group = voices.find(({ name }) => name === voice);
        if (!group) {
          const names = voices.map(({ name }) => name).join(", ");
          throw new RangeError(names
            ? `Unknown voice "${voice}" for ${id}. Available voices: ${names}.`
            : `${id} has no selectable solo voices.`);
        }
        performance = soloVoice(performance, group.ids);
      }

      let finalPosition: number | undefined;
      let playback: Playback;
      const handle: Playback = {
        position: () => finalPosition ?? playback.position(),
        stop() {
          if (finalPosition === undefined) {
            finalPosition = playback.position();
            playback.stop();
          }
          if (active === handle) active = undefined;
        },
      };
      playback = playPerformance(context, performance, () => {
        finalPosition = performance.durationSeconds;
        if (active === handle) active = undefined;
      });
      if (finalPosition === undefined) active = handle;
      return handle;
    } finally {
      if (pending === request) pending = undefined;
    }
  }

  return { play, stop };
}
