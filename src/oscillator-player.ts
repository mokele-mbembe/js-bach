import type { Performance } from "./performance.js";
import type { PerformanceEvent } from "./playback-asset.js";

const LOOKAHEAD_SECONDS = 0.15;
const UPDATE_MS = 25;
const STOP_FADE_SECONDS = 0.012;
const VOICE_GAIN_TIME_CONSTANT = 0.003;

export interface Playback {
  position(): number;
  stop(): void;
}

export interface MixedPlayback extends Playback {
  /** Change a voice's gain by ID while the timeline continues. Browser playback also accepts its display name. */
  setVoiceMuted(voice: string, muted: boolean): void;
}

/** A note on the selected performance's timeline with its scheduled AudioContext times. */
export interface ScheduledNote extends PerformanceEvent {
  readonly audioStartTime: number;
  readonly audioEndTime: number;
}

export interface PlayOptions {
  /** Voice IDs whose gains start at zero. Their notes are still scheduled. */
  muted?: readonly string[];
  /** Called within the 150 ms lookahead, including for muted notes. A rejected callback stops playback. */
  onNote?: (note: ScheduledNote) => void;
}

/** Schedules a performance on an already running AudioContext. */
export function playPerformance(context: AudioContext, performance: Performance, onEnded: () => void): Playback;
export function playPerformance(
  context: AudioContext,
  performance: Performance,
  onEnded: () => void,
  voiceIds: readonly string[],
  options?: PlayOptions,
): MixedPlayback;
export function playPerformance(
  context: AudioContext,
  performance: Performance,
  onEnded: () => void,
  voiceIds?: readonly string[],
  { muted, onNote }: PlayOptions = {},
): Playback | MixedPlayback {
  const ids = new Set(voiceIds);
  const initiallyMuted = new Set(muted);
  for (const id of initiallyMuted) {
    if (!ids.has(id)) throw new RangeError(`Unknown playback voice "${id}".`);
  }

  const master = context.createGain();
  master.gain.value = 0.6;
  master.connect(context.destination);

  const voiceGains = new Map<string, { node: GainNode; muted: boolean }>();
  for (const id of ids) {
    const node = context.createGain();
    const isMuted = initiallyMuted.has(id);
    node.gain.value = isMuted ? 0 : 1;
    node.connect(master);
    voiceGains.set(id, { node, muted: isMuted });
  }

  const start = context.currentTime + 0.05;
  const active = new Map<OscillatorNode, number>();
  let cursor = 0;
  let stopped = false;

  function disconnect(): void {
    for (const { node } of voiceGains.values()) node.disconnect();
    master.disconnect();
  }

  function setVoiceMuted(voiceId: string, muted: boolean): void {
    if (stopped) return;
    const voice = voiceGains.get(voiceId);
    if (!voice) throw new RangeError(`Unknown playback voice "${voiceId}".`);
    if (voice.muted === muted) return;
    voice.node.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, VOICE_GAIN_TIME_CONSTANT);
    voice.muted = muted;
  }

  function schedule(pitch: number, onset: number, end: number, output: GainNode): void {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
    oscillator.connect(envelope);
    envelope.connect(output);

    const quarterDuration = (end - onset) / 4;
    envelope.gain.setValueAtTime(0, onset);
    envelope.gain.linearRampToValueAtTime(0.18, onset + Math.min(0.008, quarterDuration));
    envelope.gain.setValueAtTime(0.18, end - Math.min(0.018, quarterDuration));
    envelope.gain.linearRampToValueAtTime(0, end);

    active.set(oscillator, onset);
    oscillator.addEventListener("ended", () => {
      active.delete(oscillator);
      oscillator.disconnect();
      envelope.disconnect();
      if (stopped && active.size === 0) disconnect();
    }, { once: true });
    oscillator.start(onset);
    oscillator.stop(end);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (active.size === 0) {
      disconnect();
      return;
    }

    const now = context.currentTime;
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + STOP_FADE_SECONDS);
    for (const [oscillator, onset] of active) {
      oscillator.stop(onset > now ? now : now + STOP_FADE_SECONDS);
    }
  }

  function pump(): void {
    try {
      const deadline = context.currentTime + LOOKAHEAD_SECONDS;
      while (!stopped && cursor < performance.notes.length) {
        const { midiPitch, startSeconds, endSeconds, voice, voiceId } = performance.notes[cursor];
        const onset = start + startSeconds;
        if (onset >= deadline) break;
        cursor++;
        const now = context.currentTime;
        const end = start + endSeconds;
        if (end <= now) continue;
        const output = voiceId === undefined ? master : voiceGains.get(voiceId)?.node ?? master;
        const audioStartTime = Math.max(now, onset);
        schedule(midiPitch, audioStartTime, end, output);
        const result: unknown = onNote?.({ midiPitch, startSeconds, endSeconds, voiceId: voiceId ?? null, scoreVoice: voice,
          audioStartTime, audioEndTime: end });
        if (result !== null && (typeof result === "object" || typeof result === "function")) {
          // Observe returned promises without pausing the lookahead loop.
          void Promise.resolve(result).catch((error: unknown) => {
            stop();
            queueMicrotask(() => { throw error; });
          });
        }
      }

      if (!stopped && context.currentTime >= start + performance.durationSeconds) {
        stop();
        onEnded();
      }
    } catch (error) {
      stop();
      throw error;
    }
  }

  const timer = setInterval(pump, UPDATE_MS);
  // Let callers receive the handle before any callback can stop playback.
  if (!onNote) pump();
  const playback = {
    position: () => Math.max(0, Math.min(context.currentTime - start, performance.durationSeconds)),
    stop,
  };
  return voiceIds ? { ...playback, setVoiceMuted } : playback;
}
