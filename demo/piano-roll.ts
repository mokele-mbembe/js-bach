interface RollNote {
  readonly voiceId: string;
  readonly midiPitch: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
}

interface RollEntry {
  readonly voiceId: string;
  readonly kind: "subject" | "answer";
  readonly startSeconds: number;
}

interface PianoRollMovement {
  readonly durationSeconds: number;
  readonly notes: readonly RollNote[];
  readonly entries: readonly RollEntry[];
}

const voiceColors = new Map([
  ["soprano", "#ffc778"],
  ["alto", "#98e4b8"],
  ["tenor", "#9acbff"],
  ["bass", "#efaed8"],
]);
const left = 34;
const right = 8;
const top = 23;
const bottom = 24;

export function pianoRollVoiceColor(id: string): string {
  return voiceColors.get(id) ?? "#f5f5eb";
}

function timeLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function drawScore(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  movement: PianoRollMovement | undefined,
  muted: ReadonlySet<string>,
): void {
  context.fillStyle = "#102321";
  context.fillRect(0, 0, width, height);
  if (!movement || movement.notes.length === 0) return;

  const plotWidth = width - left - right;
  const plotEnd = height - bottom;
  const { durationSeconds, notes, entries } = movement;
  const minimumPitch = Math.min(...notes.map(({ midiPitch }) => midiPitch)) - 1;
  const maximumPitch = Math.max(...notes.map(({ midiPitch }) => midiPitch)) + 1;
  const rowHeight = (plotEnd - top) / (maximumPitch - minimumPitch + 1);
  const xAt = (seconds: number) => left + seconds / durationSeconds * plotWidth;
  const yAt = (pitch: number) => top + (maximumPitch - pitch) * rowHeight;

  context.font = "11px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.textAlign = "right";
  for (let pitch = minimumPitch; pitch <= maximumPitch; pitch++) {
    const pitchClass = pitch % 12;
    const y = yAt(pitch);
    if ([1, 3, 6, 8, 10].includes(pitchClass)) {
      context.fillStyle = "#142b28";
      context.fillRect(left, y, plotWidth, rowHeight);
    }
    if (pitchClass === 0) {
      context.fillStyle = "#38504a";
      context.fillRect(left, y + rowHeight, plotWidth, 1);
      context.fillStyle = "#b5c5bb";
      context.fillText(`C${pitch / 12 - 1}`, left - 6, y + rowHeight / 2);
    }
  }

  const minimumStep = 48 * durationSeconds / plotWidth;
  const step = [5, 10, 15, 30, 60].find((seconds) => seconds >= minimumStep) ?? 120;
  context.textAlign = "center";
  for (let time = 0; time <= durationSeconds; time += step) {
    const x = xAt(time);
    context.fillStyle = "#38504a";
    context.fillRect(x, top, 1, plotEnd - top);
    context.fillStyle = "#b5c5bb";
    context.fillText(timeLabel(time), Math.min(x, width - 17), plotEnd + 12);
  }

  for (const entry of entries) {
    const x = xAt(entry.startSeconds);
    const color = pianoRollVoiceColor(entry.voiceId);
    context.strokeStyle = color;
    context.globalAlpha = 0.55;
    context.setLineDash([2, 3]);
    context.beginPath();
    context.moveTo(x, top);
    context.lineTo(x, plotEnd);
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
    context.fillStyle = color;
    context.fillText(entry.kind === "subject" ? "S" : "A", x, top / 2);
  }

  const inset = Math.min(0.5, rowHeight / 6);
  for (const drawMuted of [true, false]) {
    context.globalAlpha = drawMuted ? 0.26 : 1;
    for (const { voiceId, startSeconds, endSeconds, midiPitch } of notes) {
      if (muted.has(voiceId) !== drawMuted) continue;
      const x = xAt(startSeconds);
      context.fillStyle = pianoRollVoiceColor(voiceId);
      context.fillRect(x, yAt(midiPitch) + inset, Math.max(1, xAt(endSeconds) - x), rowHeight - 2 * inset);
    }
  }
  context.globalAlpha = 1;
}

export function createPianoRoll(canvas: HTMLCanvasElement) {
  const backdrop = document.createElement("canvas");
  const background = backdrop.getContext("2d");
  const context = canvas.getContext("2d");
  let movement: PianoRollMovement | undefined;
  let muted: ReadonlySet<string> = new Set();
  let position = 0;
  let width = 0;
  let height = 0;
  let pixelRatio = 0;
  let dirty = true;

  function paint(): void {
    if (!context || !background || width <= left + right || height <= top + bottom) return;
    if (pixelRatio !== window.devicePixelRatio) {
      pixelRatio = window.devicePixelRatio;
      dirty = true;
    }
    if (dirty) {
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        backdrop.width = pixelWidth;
        backdrop.height = pixelHeight;
      }
      background.setTransform(backdrop.width / width, 0, 0, backdrop.height / height, 0, 0);
      drawScore(background, width, height, movement, muted);
      dirty = false;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(backdrop, 0, 0);
    if (!movement || movement.durationSeconds <= 0) return;
    context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    const fraction = Math.min(1, Math.max(0, position / movement.durationSeconds));
    const x = left + fraction * (width - left - right);
    context.fillStyle = "#f5f5eb";
    context.fillRect(x, top, 1.5, height - top - bottom);
  }

  new ResizeObserver(([{ contentRect }]) => {
    width = contentRect.width;
    height = contentRect.height;
    dirty = true;
    paint();
  }).observe(canvas);

  return {
    setMovement(next: PianoRollMovement | undefined): void {
      movement = next;
      muted = new Set();
      position = 0;
      dirty = true;
      paint();
    },
    setPosition(seconds: number): void {
      if (!movement || (seconds === position && pixelRatio === window.devicePixelRatio)) return;
      position = seconds;
      paint();
    },
    setMutedVoices(ids: ReadonlySet<string>): void {
      muted = new Set(ids);
      dirty = true;
      paint();
    },
  };
}
