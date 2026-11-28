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
  voiceColor(id: string): string;
}

interface RollLayout {
  minimumPitch: number;
  maximumPitch: number;
  plotWidth: number;
  plotEnd: number;
  rowHeight: number;
  transpose: number;
  xAt(seconds: number): number;
  yAt(pitch: number): number;
}

const voiceColors = new Map([
  ["soprano", "#ffc778"],
  ["alto", "#98e4b8"],
  ["tenor", "#9acbff"],
  ["baritone", "#c6b4ff"],
  ["bass", "#efaed8"],
  ["mezzo", "#ff8b70"],
]);
const fallbackVoiceColors = ["#e7d547", "#44d7dc", "#8ace51", "#dc82e0", "#64a0f2"];
const backgroundColor = "#102321";
const mutedAlpha = 0.26;
const left = 34;
const right = 8;
const top = 23;
const bottom = 24;

export function createPianoRollPalette(voiceIds: readonly string[]): (id: string) => string {
  const colors = new Map(voiceColors);
  let fallback = 0;
  for (const id of voiceIds) {
    if (colors.has(id)) continue;
    colors.set(id, fallbackVoiceColors[fallback++ % fallbackVoiceColors.length]);
  }
  return (id) => colors.get(id) ?? fallbackVoiceColors[0];
}

function timeLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function rollLayout(width: number, height: number, { durationSeconds, notes }: PianoRollMovement, transpose: number): RollLayout | undefined {
  if (durationSeconds <= 0 || notes.length === 0) return undefined;
  let minimumPitch = Infinity;
  let maximumPitch = -Infinity;
  for (const { midiPitch } of notes) {
    const pitch = midiPitch + transpose;
    minimumPitch = Math.min(minimumPitch, pitch - 1);
    maximumPitch = Math.max(maximumPitch, pitch + 1);
  }
  const plotWidth = width - left - right;
  const plotEnd = height - bottom;
  const rowHeight = (plotEnd - top) / (maximumPitch - minimumPitch + 1);
  return {
    minimumPitch, maximumPitch, plotWidth, plotEnd, rowHeight, transpose,
    xAt: (seconds) => left + seconds / durationSeconds * plotWidth,
    yAt: (pitch) => top + (maximumPitch - pitch) * rowHeight,
  };
}

function drawScore(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  movement: PianoRollMovement | undefined,
  layout: RollLayout | undefined,
  muted: ReadonlySet<string>,
): void {
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, width, height);
  if (!movement || !layout) return;
  const { durationSeconds, notes, entries, voiceColor } = movement;
  const { minimumPitch, maximumPitch, plotWidth, plotEnd, rowHeight, transpose, xAt, yAt } = layout;

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
    const color = voiceColor(entry.voiceId);
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
    context.globalAlpha = drawMuted ? mutedAlpha : 0.65;
    for (const { voiceId, startSeconds, endSeconds, midiPitch } of notes) {
      if (muted.has(voiceId) !== drawMuted) continue;
      const x = xAt(startSeconds);
      context.fillStyle = voiceColor(voiceId);
      context.fillRect(x, yAt(midiPitch + transpose) + inset, Math.max(1, xAt(endSeconds) - x), rowHeight - 2 * inset);
    }
  }
  context.globalAlpha = 1;
}

function drawActiveNotes(
  context: CanvasRenderingContext2D,
  { notes, voiceColor }: PianoRollMovement,
  { rowHeight, transpose, xAt, yAt }: RollLayout,
  position: number,
  muted: ReadonlySet<string>,
): void {
  const soundingByPitch = new Map<number, RollNote[]>();
  for (const note of notes) {
    if (note.startSeconds > position) break;
    if (note.endSeconds <= position) continue;
    const samePitch = soundingByPitch.get(note.midiPitch);
    if (samePitch) samePitch.push(note);
    else soundingByPitch.set(note.midiPitch, [note]);
  }

  // Reserve a band for every active note so muting one voice leaves the others in place.
  for (const [pitch, sounding] of soundingByPitch) {
    const bandHeight = rowHeight / sounding.length;
    const inset = Math.min(0.5, bandHeight / 6);
    for (const [index, { voiceId, startSeconds, endSeconds }] of sounding.entries()) {
      const x = xAt(startSeconds);
      const y = yAt(pitch + transpose) + index * bandHeight + inset;
      const width = Math.max(1, xAt(endSeconds) - x);
      const height = bandHeight - 2 * inset;
      if (muted.has(voiceId)) {
        context.fillStyle = backgroundColor;
        context.fillRect(x, y, width, height);
        context.globalAlpha = mutedAlpha;
      }
      context.fillStyle = voiceColor(voiceId);
      context.fillRect(x, y, width, height);
      context.globalAlpha = 1;
    }
  }
}

export function createPianoRoll(canvas: HTMLCanvasElement, onSeek?: (seconds: number) => void) {
  const backdrop = document.createElement("canvas");
  const background = backdrop.getContext("2d");
  const context = canvas.getContext("2d");
  let movement: PianoRollMovement | undefined;
  let layout: RollLayout | undefined;
  let muted: ReadonlySet<string> = new Set();
  let position = 0;
  let transpose = 0;
  let playing = false;
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
      layout = movement && rollLayout(width, height, movement, transpose);
      drawScore(background, width, height, movement, layout, muted);
      dirty = false;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(backdrop, 0, 0);
    if (!movement || !layout) return;
    context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    if (playing) drawActiveNotes(context, movement, layout, position, muted);
    context.fillStyle = "#f5f5eb";
    context.fillRect(layout.xAt(position), top, 1.5, layout.plotEnd - top);
  }

  new ResizeObserver(([{ contentRect }]) => {
    width = contentRect.width;
    height = contentRect.height;
    dirty = true;
    paint();
  }).observe(canvas);

  if (onSeek) {
    canvas.setAttribute("role", "slider");
    canvas.tabIndex = 0;
    canvas.addEventListener("click", (event) => {
      if (!movement || !layout) return;
      const x = event.offsetX - left;
      if (x >= 0 && x <= layout.plotWidth) onSeek(movement.durationSeconds * (x / layout.plotWidth));
    });
    canvas.addEventListener("keydown", (event) => {
      if (!movement) return;
      const end = movement.durationSeconds;
      const { key } = event;
      let target: number;
      if (key === "Home") target = 0;
      else if (key === "End") target = end;
      else if (key === "ArrowLeft" || key === "ArrowDown") target = position - 5;
      else if (key === "ArrowRight" || key === "ArrowUp") target = position + 5;
      else return;
      event.preventDefault();
      onSeek(Math.max(0, Math.min(target, end)));
    });
  }

  return {
    setMovement(next: PianoRollMovement | undefined): void {
      movement = next;
      muted = new Set();
      position = 0;
      if (next && onSeek) {
        canvas.setAttribute("aria-valuemin", "0");
        canvas.setAttribute("aria-valuemax", String(next.durationSeconds));
        canvas.setAttribute("aria-valuenow", "0");
        canvas.setAttribute("aria-valuetext", "0:00");
      }
      playing = false;
      dirty = true;
      paint();
    },
    setPosition(seconds: number, isPlaying: boolean): void {
      if (!movement || (seconds === position && playing === isPlaying && pixelRatio === window.devicePixelRatio)) return;
      const wholeSeconds = Math.floor(seconds);
      if (onSeek && wholeSeconds !== Math.floor(position)) {
        canvas.setAttribute("aria-valuenow", String(wholeSeconds));
        canvas.setAttribute("aria-valuetext", timeLabel(wholeSeconds));
      }
      position = seconds;
      playing = isPlaying;
      paint();
    },
    setMutedVoices(ids: ReadonlySet<string>): void {
      muted = new Set(ids);
      dirty = true;
      paint();
    },
    setTranspose(semitones: number): void {
      if (semitones === transpose) return;
      transpose = semitones;
      dirty = true;
      paint();
    },
  };
}
