/**
 * The print bed's ordered-dither art (Bayer 8x8): a route ribbon plotted across a woven floor,
 * with a lime pulse travelling along it. A small canvas (about 100 x 120 cells) upscaled with
 * `image-rendering: pixelated`. The field is computed once per size; frames only redraw the
 * pulse, every second animation frame, and only while the canvas is on screen.
 */

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map((v) => (v + 0.5) / 64);

export interface DitherOptions {
  /** CSS pixels per cell. */
  readonly cell: () => number;
  /** Palette from dark to bright; null is transparent. */
  readonly colors: (dark: boolean) => readonly (string | null)[];
  /** Route points in unit coordinates. */
  readonly path: readonly (readonly [number, number])[];
  readonly tube: number;
  readonly station: number;
  readonly tubeValue: number;
  readonly stationValue: number;
  readonly pulseValue: number;
  readonly floor: (x: number, y: number) => number;
}

export interface Dither {
  /** Re-reads the theme and redraws. */
  palette(): void;
  /** Recomputes the field for the canvas size. */
  setup(): void;
  /** Advances the pulse and redraws (call from the frame loop). */
  step(delta: number): void;
  draw(): void;
}

function rgba(color: string | null): [number, number, number, number] {
  if (!color) return [0, 0, 0, 0];
  const hex = color.replace("#", "");
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
}

const isDark = () => document.documentElement.classList.contains("dark");

export function createDither(canvas: HTMLCanvasElement, options: DitherOptions): Dither | null {
  const context = canvas.getContext("2d");
  if (!context) return null;
  let width = 0;
  let height = 0;
  let image: ImageData | null = null;
  let base = new Float32Array(0);
  let along = new Float32Array(0);
  let near = new Float32Array(0);
  let colors: [number, number, number, number][] = [];
  let phase = 0;

  const draw = () => {
    if (!image) return;
    const levels = colors.length - 1;
    const data = image.data;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const k = y * width + x;
        let dt = along[k]! - phase;
        dt -= Math.round(dt);
        const value = base[k]! + options.pulseValue * near[k]! * Math.exp(-(dt * dt) / 0.004);
        const level = Math.max(0, Math.min(levels, Math.floor(value * levels + BAYER[(y & 7) * 8 + (x & 7)]!)));
        const color = colors[level]!;
        const o = k * 4;
        data[o] = color[0];
        data[o + 1] = color[1];
        data[o + 2] = color[2];
        data[o + 3] = color[3];
      }
    }
    context.putImageData(image, 0, 0);
  };

  const setup = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cell = options.cell();
    width = Math.max(8, Math.round(rect.width / cell));
    height = Math.max(8, Math.round(rect.height / cell));
    canvas.width = width;
    canvas.height = height;
    image = context.createImageData(width, height);
    base = new Float32Array(width * height);
    along = new Float32Array(width * height);
    near = new Float32Array(width * height);
    const points = options.path.map(([x, y]) => [x * width, y * height] as const);
    // A smooth path through the points (Catmull-Rom).
    const samples: (readonly [number, number])[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[Math.max(0, i - 1)]!;
      const p1 = points[i]!;
      const p2 = points[i + 1]!;
      const p3 = points[Math.min(points.length - 1, i + 2)]!;
      for (let t = 0; t < 1; t += 0.02) {
        const t2 = t * t;
        const t3 = t2 * t;
        const at = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        samples.push([at(p0[0], p1[0], p2[0], p3[0]), at(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    samples.push(points[points.length - 1]!);
    const tube = options.tube * width;
    const station = options.station * width;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let best = Infinity;
        let index = 0;
        for (let i = 0; i < samples.length; i += 2) {
          const dx = samples[i]![0] - x;
          const dy = samples[i]![1] - y;
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            index = i;
          }
        }
        let value = options.floor(x / width, y / height) + options.tubeValue * Math.exp(-best / (2 * tube * tube));
        for (const [px, py] of points) {
          const dx = px - x;
          const dy = py - y;
          value += options.stationValue * Math.exp(-(dx * dx + dy * dy) / (2 * station * station));
        }
        const k = y * width + x;
        base[k] = value;
        along[k] = index / samples.length;
        near[k] = Math.exp(-best / (2 * tube * tube * 1.4));
      }
    }
    draw();
  };

  const palette = () => {
    colors = options.colors(isDark()).map(rgba);
    draw();
  };

  palette();
  setup();
  return {
    palette,
    setup,
    draw,
    step(delta: number) {
      phase = (phase + delta) % 1;
      draw();
    },
  };
}

/** The hero print bed: a route ribbon from the top left, round the right edge, out at the bottom. */
export const BED_DITHER: DitherOptions = {
  cell: () => (window.matchMedia("(max-width: 760px)").matches ? 5 : 6),
  colors: (dark) => [dark ? "#070708" : "#121212", dark ? "#1F1F24" : "#26262B", "#2F5BFF", "#FF3D9A", "#C6FF3A"],
  path: [[-0.05, 0.08], [0.35, 0.12], [0.9, 0.2], [0.82, 0.52], [0.55, 0.7], [0.88, 0.88], [1.05, 0.98]],
  tube: 0.028,
  station: 0.03,
  tubeValue: 0.62,
  stationValue: 0.42,
  pulseValue: 0.5,
  floor: (x, y) => 0.07 + 0.1 * y + 0.05 * Math.sin(x * 9 + y * 4),
};

/** The final call to action: an ink route on the lime slab. */
export const CTA_DITHER: DitherOptions = {
  cell: () => 7,
  colors: () => [null, "#121212"],
  path: [[0.1, -0.1], [0.3, 0.4], [0.75, 0.3], [0.6, 0.8], [1.1, 1.05]],
  tube: 0.045,
  station: 0.05,
  tubeValue: 0.5,
  stationValue: 0.4,
  pulseValue: 0.35,
  floor: (x) => 0.02 + 0.2 * x * x,
};
