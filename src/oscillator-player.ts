import type { Performance } from "./performance.js";

const LOOKAHEAD_SECONDS = 0.15;
const UPDATE_MS = 25;
const STOP_FADE_SECONDS = 0.012;

export interface Playback {
  position(): number;
  stop(): void;
}

/** Schedules a performance on an already running AudioContext. */
export function playPerformance(context: AudioContext, performance: Performance, onEnded: () => void): Playback {
  const master = context.createGain();
  master.gain.value = 0.6;
  master.connect(context.destination);

  const start = context.currentTime + 0.05;
  const active = new Map<OscillatorNode, number>();
  let cursor = 0;
  let stopped = false;

  function schedule(pitch: number, onset: number, end: number): void {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
    oscillator.connect(envelope);
    envelope.connect(master);

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
      if (stopped && active.size === 0) master.disconnect();
    }, { once: true });
    oscillator.start(onset);
    oscillator.stop(end);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (active.size === 0) {
      master.disconnect();
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
      if (end > now) schedule(note.midiPitch, Math.max(now, start + note.startSeconds), end);
      cursor++;
    }

    if (now >= start + performance.durationSeconds) {
      stop();
      onEnded();
    }
  }

  const timer = setInterval(pump, UPDATE_MS);
  pump();
  return {
    position: () => Math.max(0, Math.min(context.currentTime - start, performance.durationSeconds)),
    stop,
  };
}
