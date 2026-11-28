import { playPerformance, validateVoicePan, type Playback, type MixedPlayback, type ScheduledNote } from "./oscillator-player.js";
import {
  decodePlayback, describeVoices, performanceTimeline, soloMusicalVoice,
  type PlaybackAsset, type PerformanceTimeline, type Voice,
} from "./playback-asset.js";

export type { MixedPlayback, Playback, ScheduledNote } from "./oscillator-player.js";
export type { PerformanceEvent, PerformanceTimeline, Voice } from "./playback-asset.js";

export interface MovementOptions {
  /** The selected movement. Defaults to the prelude. */
  movement?: "prelude" | "fugue";
}

export interface PlayOptions extends MovementOptions {
  /** A solo voice by its name or ID, such as "Alto" or "alto". Defaults to all voices. */
  voice?: string;
  /** Voice names or IDs to mute from the start. During a solo, only the selected voice is available. */
  muted?: readonly string[];
  /** Initial stereo positions from -1 to 1 by voice name or ID. During a solo, only that voice is available. */
  pan?: Readonly<Record<string, number>>;
  /** Start on the full movement timeline. Omit for the usual solo playback starting at its first entrance. */
  startSeconds?: number;
  /**
   * Called after play resolves, up to 150 ms before a note starts. Includes muted notes.
   * After a seek, a sustained note retains its original score times, with its audio onset clipped to the new start.
   * Scheduling continues while a callback promise is pending. A throw or rejection stops playback.
   */
  onNote?: (note: ScheduledNote) => void;
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

  async function play(bwv: string, {
    movement, voice, muted = [], pan = {}, startSeconds, onNote,
  }: PlayOptions = {}): Promise<MixedPlayback> {
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

      const { voices } = describeVoices(asset.source.voices);
      function voiceId(label: string, available: readonly Voice[]): string {
        const group = available.find(({ id, name }) => id === label || name === label);
        if (group) return group.id;
        const names = available.map(({ name }) => name).join(", ");
        throw new RangeError(names
          ? `Unknown voice "${label}" for ${asset.source.id}. Available voices: ${names}.`
          : `${asset.source.id} has no selectable voices.`);
      }
      const soloId = voice === undefined ? undefined : voiceId(voice, voices);
      const available = soloId === undefined ? voices : voices.filter(({ id }) => id === soloId);
      const mutedIds = muted.map((name) => voiceId(name, available));
      const panById = Object.fromEntries(Object.entries(pan).map(([name, value]) => {
        validateVoicePan(value);
        return [voiceId(name, available), value];
      }));
      const fullPerformance = decodePlayback(asset);
      const performance = soloId === undefined ? fullPerformance
        : soloMusicalVoice(fullPerformance, soloId, startSeconds === undefined ? "solo" : "movement");

      let finalPosition: number | undefined;
      let playback: MixedPlayback;
      const handle: MixedPlayback = {
        position: () => finalPosition ?? playback.position(),
        setVoiceMuted: (name, muted) => playback.setVoiceMuted(voiceId(name, available), muted),
        setVoicePan: (name, value) => playback.setVoicePan(voiceId(name, available), value),
        stop() {
          if (finalPosition === undefined) {
            finalPosition = playback.position();
            playback.stop();
          }
          if (active === handle) active = undefined;
        },
      };
      function stopOnCallbackError(error: unknown): never {
        handle.stop();
        throw error;
      }
      playback = playPerformance(context, performance, () => {
        finalPosition = performance.durationSeconds;
        if (active === handle) active = undefined;
      }, available.map(({ id }) => id), {
        muted: mutedIds,
        pan: panById,
        startSeconds,
        onNote: onNote && ((note) => {
          try {
            const result: unknown = onNote(note);
            if (result !== null && (typeof result === "object" || typeof result === "function")) {
              return Promise.resolve(result).catch(stopOnCallbackError);
            }
          } catch (error) {
            stopOnCallbackError(error);
          }
        }),
      });
      if (finalPosition === undefined) active = handle;
      return handle;
    } finally {
      if (pending === request) pending = undefined;
    }
  }

  return { play, stop, getVoices, getPerformance };
}
