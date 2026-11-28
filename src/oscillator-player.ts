import type { Performance } from "./performance.js";
import type { PerformanceEvent } from "./playback-asset.js";

const LOOKAHEAD_SECONDS = 0.15;
const UPDATE_MS = 25;
const STOP_FADE_SECONDS = 0.012;
const VOICE_GAIN_TIME_CONSTANT = 0.003;
const VOICE_PAN_TIME_CONSTANT = 0.01;
const NOTE_PEAK_GAIN = 0.18;

export interface Playback {
  position(): number;
  stop(): void;
}

export interface MixedPlayback extends Playback {
  /** Change a voice's gain by ID while the timeline continues. Browser playback also accepts its display name. */
  setVoiceMuted(voice: string, muted: boolean): void;
  /** Pan a voice between -1 (left) and 1 (right). Browser playback also accepts its display name. */
  setVoicePan(voice: string, pan: number): void;
}

/** A note on the selected performance's timeline with its scheduled AudioContext times. */
export interface ScheduledNote extends PerformanceEvent {
  /** Audio clock onset. After a seek, a sustained note starts at the new playback origin. */
  readonly audioStartTime: number;
  readonly audioEndTime: number;
}

export interface PlayOptions {
  /** Voice IDs whose gains start at zero. Their notes are still scheduled. */
  muted?: readonly string[];
  /** Initial stereo position by voice ID. Unspecified voices start centered. */
  pan?: Readonly<Record<string, number>>;
  /** Start at this point on the performance timeline, including any notes still sounding. */
  startSeconds?: number;
  /** Called within the 150 ms lookahead, including for muted notes. A rejected callback stops playback. */
  onNote?: (note: ScheduledNote) => void;
}

export function validateVoicePan(value: number): void {
  if (!Number.isFinite(value) || value < -1 || value > 1) {
    throw new RangeError("Voice pan must be between -1 and 1.");
  }
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
  { muted, pan, startSeconds: seek = 0, onNote }: PlayOptions = {},
): Playback | MixedPlayback {
  if (!Number.isFinite(seek) || seek < 0 || seek > performance.durationSeconds) {
    throw new RangeError(`startSeconds must be between 0 and ${performance.durationSeconds}.`);
  }
  const ids = new Set(voiceIds);
  const initiallyMuted = new Set(muted);
  const initialPan = new Map(Object.entries(pan ?? {}));
  function checkVoice(id: string): void {
    if (!ids.has(id)) throw new RangeError(`Unknown playback voice "${id}".`);
  }
  for (const id of initiallyMuted) checkVoice(id);
  for (const [id, value] of initialPan) {
    checkVoice(id);
    validateVoicePan(value);
  }

  const master = context.createGain();
  master.gain.value = 0.6;
  master.connect(context.destination);

  const voices = new Map<string, { gain: GainNode; panner?: StereoPannerNode; muted: boolean }>();
  for (const id of ids) {
    const gain = context.createGain();
    const panner = context.createStereoPanner?.();
    const isMuted = initiallyMuted.has(id);
    gain.gain.value = isMuted ? 0 : 1;
    if (panner) {
      panner.pan.value = initialPan.get(id) ?? 0;
      panner.connect(master);
    }
    gain.connect(panner ?? master);
    voices.set(id, { gain, panner, muted: isMuted });
  }

  const start = context.currentTime + 0.05;
  const active = new Map<OscillatorNode, number>();
  let cursor = 0;
  let stopped = false;

  function disconnect(): void {
    for (const { gain, panner } of voices.values()) {
      gain.disconnect();
      panner?.disconnect();
    }
    master.disconnect();
  }

  function setVoiceMuted(voiceId: string, muted: boolean): void {
    if (stopped) return;
    const voice = voices.get(voiceId);
    if (!voice) throw new RangeError(`Unknown playback voice "${voiceId}".`);
    if (voice.muted === muted) return;
    voice.gain.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, VOICE_GAIN_TIME_CONSTANT);
    voice.muted = muted;
  }

  function setVoicePan(voiceId: string, value: number): void {
    checkVoice(voiceId);
    validateVoicePan(value);
    if (!stopped) voices.get(voiceId)?.panner?.pan.setTargetAtTime(value, context.currentTime, VOICE_PAN_TIME_CONSTANT);
  }

  function schedule(pitch: number, onset: number, end: number, output: GainNode, peak: number): void {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
    oscillator.connect(envelope);
    envelope.connect(output);

    const quarterDuration = (end - onset) / 4;
    envelope.gain.setValueAtTime(0, onset);
    envelope.gain.linearRampToValueAtTime(peak, onset + Math.min(0.008, quarterDuration));
    envelope.gain.setValueAtTime(peak, end - Math.min(0.018, quarterDuration));
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
        const onset = start + Math.max(0, startSeconds - seek);
        if (onset >= deadline) break;
        cursor++;
        const now = context.currentTime;
        if (endSeconds <= seek) continue;
        const end = start + (endSeconds - seek);
        if (end <= now) continue;
        const bus = voiceId === undefined ? undefined : voices.get(voiceId);
        // Offset the centered mono panner's 1/√2 per channel while preserving its equal-power curve.
        const peak = bus?.panner ? NOTE_PEAK_GAIN * Math.SQRT2 : NOTE_PEAK_GAIN;
        const audioStartTime = Math.max(now, onset);
        schedule(midiPitch, audioStartTime, end, bus?.gain ?? master, peak);
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

      if (!stopped && context.currentTime >= start + (performance.durationSeconds - seek)) {
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
    position: () => Math.min(seek + Math.max(0, context.currentTime - start), performance.durationSeconds),
    stop,
  };
  return voiceIds ? { ...playback, setVoiceMuted, setVoicePan } : playback;
}
