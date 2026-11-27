import type { Performance } from "./performance.js";

const LOOKAHEAD_SECONDS = 0.15;
const UPDATE_MS = 25;
const STOP_FADE_SECONDS = 0.012;
const VOICE_GAIN_TIME_CONSTANT = 0.003;

export interface Playback {
  position(): number;
  stop(): void;
}

export interface MixedPlayback extends Playback {
  /** Change a voice's gain without changing its placement on the playback timeline. */
  setVoiceMuted(voiceId: string, muted: boolean): void;
}

/** Schedules a performance on an already running AudioContext. */
export function playPerformance(context: AudioContext, performance: Performance, onEnded: () => void): Playback;
export function playPerformance(
  context: AudioContext,
  performance: Performance,
  onEnded: () => void,
  voiceIds: readonly string[],
): MixedPlayback;
export function playPerformance(
  context: AudioContext,
  performance: Performance,
  onEnded: () => void,
  voiceIds?: readonly string[],
): Playback | MixedPlayback {
  const master = context.createGain();
  master.gain.value = 0.6;
  master.connect(context.destination);

  const voiceGains = new Map<string, { node: GainNode; muted: boolean }>();
  for (const id of new Set(voiceIds)) {
    const node = context.createGain();
    node.connect(master);
    voiceGains.set(id, { node, muted: false });
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
    const now = context.currentTime;
    while (cursor < performance.notes.length) {
      const note = performance.notes[cursor];
      if (start + note.startSeconds >= now + LOOKAHEAD_SECONDS) break;
      const end = start + note.endSeconds;
      if (end > now) {
        const output = note.voiceId === undefined ? master : voiceGains.get(note.voiceId)?.node ?? master;
        schedule(note.midiPitch, Math.max(now, start + note.startSeconds), end, output);
      }
      cursor++;
    }

    if (now >= start + performance.durationSeconds) {
      stop();
      onEnded();
    }
  }

  const timer = setInterval(pump, UPDATE_MS);
  pump();
  const playback = {
    position: () => Math.max(0, Math.min(context.currentTime - start, performance.durationSeconds)),
    stop,
  };
  return voiceIds ? { ...playback, setVoiceMuted } : playback;
}
