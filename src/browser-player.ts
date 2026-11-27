import { playPerformance, type Playback, type MixedPlayback } from "./oscillator-player.js";
import {
  decodePlayback, describeVoices, performanceTimeline, soloMusicalVoice,
  type PlaybackAsset, type PerformanceTimeline, type Voice,
} from "./playback-asset.js";

export type { MixedPlayback, Playback } from "./oscillator-player.js";
export type { PerformanceEvent, PerformanceTimeline, Voice } from "./playback-asset.js";

export interface MovementOptions {
  /** The selected movement. Defaults to the prelude. */
  movement?: "prelude" | "fugue";
}

export interface PlayOptions extends MovementOptions {
  /** A solo voice by its name or ID, such as "Alto" or "alto". Defaults to all voices. */
  voice?: string;
}

export interface BrowserPlayer {
  /** Start playback from a browser user gesture. Stops the previous playback. */
  play(bwv: string, options?: PlayOptions): Promise<MixedPlayback>;
  /** Stop active playback or cancel a pending play call with an AbortError. */
  stop(): void;
  /** Query verified musical voices. Returns an empty list when voice groups are unavailable. */
  getVoices(bwv: string, options?: MovementOptions): Promise<readonly Voice[]>;
  /** Read the performed pitches and timings on the full movement's timeline. */
  getPerformance(bwv: string, options?: MovementOptions): Promise<PerformanceTimeline>;
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

  function movementLoader(bwv: string, movement: MovementOptions["movement"] = "prelude") {
    if (typeof bwv !== "string" || !/^bwv\d+$/i.test(bwv.trim())) {
      throw new RangeError("Enter a work ID such as bwv846.");
    }
    if (movement !== "prelude" && movement !== "fugue") {
      throw new RangeError('Choose movement "prelude" or "fugue".');
    }
    const id = `${bwv.trim().toLowerCase()}-${movement}`;
    const loader = findMovement(id);
    if (!loader) throw new RangeError(`No playback data available for ${id}.`);
    return async () => {
      const asset = await loader();
      if (asset.source.id !== id) throw new Error(`Unexpected playback asset for ${id}.`);
      return asset;
    };
  }

  async function getVoices(bwv: string, { movement }: MovementOptions = {}): Promise<readonly Voice[]> {
    const asset = await movementLoader(bwv, movement)();
    return describeVoices(asset.source.voices).voices;
  }

  async function getPerformance(bwv: string, { movement }: MovementOptions = {}): Promise<PerformanceTimeline> {
    const asset = await movementLoader(bwv, movement)();
    return performanceTimeline(decodePlayback(asset));
  }

  async function play(bwv: string, { movement, voice }: PlayOptions = {}): Promise<MixedPlayback> {
    const load = movementLoader(bwv, movement);
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

      let performance = decodePlayback(asset);
      const { voices } = describeVoices(asset.source.voices);
      if (voice !== undefined) {
        const { id } = asset.source;
        const group = voices.find(({ id, name }) => id === voice || name === voice);
        if (!group) {
          const names = voices.map(({ name }) => name).join(", ");
          throw new RangeError(names
            ? `Unknown voice "${voice}" for ${id}. Available voices: ${names}.`
            : `${id} has no selectable solo voices.`);
        }
        performance = soloMusicalVoice(performance, group.id);
      }

      let finalPosition: number | undefined;
      let playback: MixedPlayback;
      const handle: MixedPlayback = {
        position: () => finalPosition ?? playback.position(),
        setVoiceMuted: (id, muted) => playback.setVoiceMuted(id, muted),
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
      }, voices.map(({ id }) => id));
      if (finalPosition === undefined) active = handle;
      return handle;
    } finally {
      if (pending === request) pending = undefined;
    }
  }

  return { play, stop, getVoices, getPerformance };
}
