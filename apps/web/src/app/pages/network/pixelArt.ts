/**
 * Art as code for the two line tickets, each in its product's own language:
 *
 * - Elyia, "Pixel Survey": a 4 px pixel grid, no blur. A mountain in its three
 *   altitude layers (Floor HyperCore, Ridge HyperEVM, Summit Elysium) with
 *   contour lines in contour ink, the sun, a trail, and Ely the goat climbing.
 * - Lykia, "Mosaic": every pixel is a tessera with a grout gap and a small,
 *   deterministic tone jitter. A Lycian coast (sea, waves, a rock tomb in the
 *   cliff, an olive tree) and Lyko, the Anatolian shepherd dog, trotting the
 *   shore. Lyko's trot frames and palette follow Lykia's own sprite sheet
 *   (apps/web/src/mosaic/sprites.ts in the Lykia repository).
 *
 * A scene is a logical colour grid (`Grid`), built by a pure function of time,
 * so tests can check sizes and palettes and the same time always paints the
 * same picture. Canvas painting takes any context with fillStyle/fillRect.
 */

export type Cell = string | null;
export type Grid = Cell[][];

export function grid(width: number, height: number, fill: Cell = null): Grid {
  return Array.from({ length: height }, () => Array<Cell>(width).fill(fill));
}

function put(g: Grid, colour: Cell, x: number, y: number, w = 1, h = 1) {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  for (let j = 0; j < h; j += 1) {
    const row = g[y0 + j];
    if (!row) continue;
    for (let i = 0; i < w; i += 1) if (x0 + i >= 0 && x0 + i < row.length) row[x0 + i] = colour;
  }
}

/** Stamps text art (one character per pixel, "." empty) with a palette; `flip` mirrors it. */
export function stamp(g: Grid, rows: readonly string[], x: number, y: number, palette: Readonly<Record<string, string>>, flip = false) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i += 1) {
      const colour = palette[row[i]!];
      if (colour) put(g, colour, flip ? x + width - 1 - i : x + i, y + j);
    }
  });
}

/** Draws a one pixel rim of `colour` around a sprite, so it reads on any ground (Pixel Survey's sprite halo). */
export function halo(g: Grid, rows: readonly string[], x: number, y: number, colour: string, flip = false) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const filled = (i: number, j: number) => {
    const row = rows[j];
    if (!row) return false;
    const k = flip ? width - 1 - i : i;
    return k >= 0 && k < row.length && row[k] !== ".";
  };
  for (let j = -1; j <= rows.length; j += 1) {
    for (let i = -1; i <= width; i += 1) {
      if (filled(i, j)) continue;
      if (filled(i + 1, j) || filled(i - 1, j) || filled(i, j + 1) || filled(i, j - 1)) put(g, colour, x + i, y + j);
    }
  }
}

/** Deterministic 0..1 noise for a cell. */
export function hash(i: number, j: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** "#rrggbb" with its channels scaled by `f`, as "#rrggbb". */
export function shade(hex: string, f: number): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${((1 << 24) | (ch(n >> 16) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1)}`;
}

export interface FillContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

/** Paints a grid as plain square pixels, `scale` canvas pixels each. */
export function paintPixels(ctx: FillContext, g: Grid, scale = 1) {
  const height = g.length;
  const width = g[0]?.length ?? 0;
  ctx.clearRect(0, 0, width * scale, height * scale);
  for (let y = 0; y < height; y += 1) {
    const row = g[y]!;
    let x = 0;
    while (x < width) {
      const colour = row[x];
      let run = 1;
      while (x + run < width && row[x + run] === colour) run += 1;
      if (colour) {
        ctx.fillStyle = colour;
        ctx.fillRect(x * scale, y * scale, run * scale, scale);
      }
      x += run;
    }
  }
}

/** Wave delay of a stone in the assemble reveal (0..0.76). */
export function assembleDelay(x: number, y: number, width: number, height: number): number {
  return (x / width) * 0.45 + (1 - y / height) * 0.25 + hash(x + 11, y + 5) * 0.06;
}

/**
 * Paints a grid as tesserae: `tile` canvas pixels per stone, a `gap` of grout,
 * a tone jitter per stone. `assemble` (0..1) drops the stones in by a wave.
 */
export function paintTesserae(ctx: FillContext, g: Grid, options: { readonly tile: number; readonly gap: number; readonly grout: string; readonly jitter?: number; readonly assemble?: number }) {
  const { tile, gap, grout } = options;
  const jitter = options.jitter ?? 0.07;
  const assemble = options.assemble ?? 1;
  const height = g.length;
  const width = g[0]?.length ?? 0;
  ctx.clearRect(0, 0, width * tile, height * tile);
  ctx.fillStyle = grout;
  ctx.fillRect(0, 0, width * tile, height * tile);
  for (let y = 0; y < height; y += 1) {
    const row = g[y]!;
    for (let x = 0; x < width; x += 1) {
      const colour = row[x];
      if (!colour) continue;
      let drop = 0;
      if (assemble < 1) {
        const local = (assemble - assembleDelay(x, y, width, height)) / 0.24;
        if (local <= 0) continue;
        if (local < 1) {
          ctx.globalAlpha = local;
          drop = (1 - local) * tile * 1.6;
        }
      }
      ctx.fillStyle = shade(colour, 1 + (hash(x, y) - 0.5) * 2 * jitter);
      const nudge = hash(y, x) > 0.86 ? 0.5 : 0;
      ctx.fillRect(x * tile + gap / 2 + nudge, y * tile + gap / 2 - drop, tile - gap, tile - gap);
      if (ctx.globalAlpha !== 1) ctx.globalAlpha = 1;
    }
  }
}

/* ===========================================================================
 * Elyia · Pixel Survey
 * ======================================================================== */

export const ELYIA_W = 96;
export const ELYIA_H = 54;

export const SURVEY = {
  card: "#FFF9EC",
  paper: "#F2ECDD",
  ink: "#16201B",
  rule: "#C9BFA6",
  contour: "#7A5230",
  sun: "#F2C200",
  sunHi: "#FFE27A",
  rope: "#C62D1F",
  snow: "#FFFFFF",
} as const;

/** Altitude palettes, low band to high band (Pixel Survey LAYERS). */
export const SURVEY_LAYERS = {
  floor: ["#0F4C5C", "#1E6B7D", "#2D8796"],
  ridge: ["#6B4423", "#8A5A2B", "#B07A44"],
  summit: ["#2E7F94", "#4FA7BA", "#85CCD8"],
} as const;

/** Ely, side view facing right: rock fur, ivory horns swept back, a white blaze. Two climbing frames. */
export const ELY_PALETTE: Readonly<Record<string, string>> = {
  k: SURVEY.ink,
  f: "#B98552",
  d: "#8A5A2B",
  l: "#DCAA78",
  h: "#EAD5A9",
  H: "#B0915E",
  w: "#FFFFFF",
  m: "#F1DFC0",
};

export const ELY_CLIMB: readonly (readonly string[])[] = [
  [
    "..........kkk.....",
    ".........khhHk....",
    "........khk.kHk...",
    "........kk..kfkk..",
    ".............kffk.",
    "............kfwkfk",
    "............kfffmk",
    "..kkkkkkkkkkfffmmk",
    ".klllllllllllfkkk.",
    "kdffffffffffffk...",
    "kdffffffffffffk...",
    ".kdddddddddddk....",
    ".kdk.kdk..kdk.kdk.",
    ".kkk.kkk..kkk.kkk.",
  ],
  [
    "..........kkk.....",
    ".........khhHk....",
    "........khk.kHk...",
    "........kk..kfkk..",
    ".............kffk.",
    "............kfwkfk",
    "............kfffmk",
    "..kkkkkkkkkkfffmmk",
    ".klllllllllllfkkk.",
    "kdffffffffffffk...",
    "kdffffffffffffk...",
    ".kdddddddddddk....",
    "..kdkkdk...kdkkdk.",
    "..kkkkkk...kkkkkk.",
  ],
];

/** The mountain's ridge line: the top row of rock at column x (lower number = higher). */
export function ridgeTop(x: number): number {
  const main = 6 + (x < 60 ? (60 - x) * 0.92 : (x - 60) * 1.05);
  const shoulder = 25 + Math.abs(x - 84) * 1.1;
  const foothill = 36 + Math.abs(x - 12) * 0.8;
  return Math.round(Math.min(main, shoulder, foothill) + (hash(x, 3) > 0.7 ? 1 : 0));
}

/** The trail Ely climbs: a zigzag of points from the foot to just below the summit. */
export const TRAIL: readonly (readonly [number, number])[] = [
  [22, 48],
  [46, 43],
  [30, 37],
  [50, 31],
  [40, 27],
  [55, 21],
  [50, 17],
  [58, 10],
]

/** A point `p` (0..1) along the trail, by length. */
export function trailPoint(p: number): { readonly x: number; readonly y: number; readonly dir: 1 | -1 } {
  const segments = TRAIL.slice(1).map((point, index) => {
    const from = TRAIL[index]!;
    return { from, to: point, length: Math.hypot(point[0] - from[0], point[1] - from[1]) };
  });
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let left = Math.max(0, Math.min(1, p)) * total;
  for (const segment of segments) {
    if (left <= segment.length) {
      const t = segment.length ? left / segment.length : 0;
      return {
        x: segment.from[0] + (segment.to[0] - segment.from[0]) * t,
        y: segment.from[1] + (segment.to[1] - segment.from[1]) * t,
        dir: segment.to[0] >= segment.from[0] ? 1 : -1,
      };
    }
    left -= segment.length;
  }
  const last = segments[segments.length - 1]!;
  return { x: last.to[0], y: last.to[1], dir: 1 };
}

export const ELYIA_REVEAL_S = 1.2;
export const ELYIA_CLIMB_S = 9;
export const ELYIA_REST_S = 3;

/**
 * The Elyia ticket's scene at `t` seconds. The bands draw bottom to top in
 * steps during the reveal, then Ely climbs the trail, rests at the top with
 * the flag, and starts again. `still` draws the finished scene, Ely on top.
 */
export function elyiaScene(time: number, still = false): Grid {
  const t = Math.max(0, time);
  const g = grid(ELYIA_W, ELYIA_H, SURVEY.card);
  const reveal = still ? 1 : Math.min(1, Math.floor((t / ELYIA_REVEAL_S) * 6) / 6);
  const waterline = ELYIA_H - Math.round(reveal * ELYIA_H);

  // Sun: a stepped disc with a lighter core.
  const sx = 84;
  const sy = 9;
  for (let y = -5; y <= 5; y += 1) for (let x = -5; x <= 5; x += 1) {
    const d = x * x + y * y;
    if (d <= 26) put(g, d <= 9 ? SURVEY.sunHi : SURVEY.sun, sx + x, sy + y);
  }
  // Survey grid ticks along the top and the left edge.
  for (let x = 0; x < ELYIA_W; x += 8) put(g, SURVEY.rule, x, 0, 1, 2);
  for (let y = 0; y < ELYIA_H; y += 8) put(g, SURVEY.rule, 0, y, 2, 1);

  // The mountain, band by band.
  for (let x = 0; x < ELYIA_W; x += 1) {
    const top = ridgeTop(x);
    for (let y = Math.max(top, 0); y < ELYIA_H; y += 1) {
      if (y < waterline) continue;
      const altitude = 1 - (y - 4) / (ELYIA_H - 4);
      const layer = altitude > 0.62 ? SURVEY_LAYERS.summit : altitude > 0.33 ? SURVEY_LAYERS.ridge : SURVEY_LAYERS.floor;
      const shadeIndex = x > 60 + (y - 6) * 0.25 ? 0 : hash(x, y) > 0.82 ? 2 : 1;
      let colour: string = layer[shadeIndex]!;
      if (y - top < 3 && altitude > 0.78) colour = SURVEY.snow;
      // Contour lines every 6 rows, stepped by the slope.
      if ((y + Math.floor(x / 9)) % 6 === 0 && y - top > 1) colour = SURVEY.contour;
      if (y === top) colour = SURVEY.ink;
      put(g, colour, x, y);
    }
  }

  if (reveal < 1) return g;

  // The trail: dashed rope red between the stops.
  for (let i = 0; i <= 160; i += 1) {
    const point = trailPoint(i / 160);
    if (i % 4 < 2) put(g, SURVEY.rope, point.x, point.y + 1);
  }
  // Summit flag.
  put(g, SURVEY.ink, 60, 0, 1, 7);
  put(g, SURVEY.sun, 61, 0, 4, 3);

  // Ely.
  let p = 1;
  if (!still) {
    const cycle = ELYIA_CLIMB_S + ELYIA_REST_S;
    const local = Math.max(0, t - ELYIA_REVEAL_S) % cycle;
    p = Math.min(1, local / ELYIA_CLIMB_S);
  }
  const at = trailPoint(p);
  const frame = still || p >= 1 ? 0 : Math.floor(t * 6) % 2;
  const sprite = ELY_CLIMB[frame]!;
  halo(g, sprite, at.x - 9, at.y - 13, SURVEY.card, at.dir < 0);
  stamp(g, sprite, at.x - 9, at.y - 13, ELY_PALETTE, at.dir < 0);
  return g;
}

/* ===========================================================================
 * Lykia · Mosaic
 * ======================================================================== */

export const LYKIA_W = 112;
export const LYKIA_H = 50;

export const MOSAIC = {
  navy: "#13233A",
  terra: "#B9472E",
  ochre: "#D9A441",
  sea: "#1E8FA3",
  seaDeep: "#176F80",
  olive: "#5F8A3A",
  cream: "#FBF5E6",
  sky: "#E7F1EE",
  sand: "#E9C98A",
  stone: "#D8C7A3",
  grout: "#C9B791",
  foam: "#FFFFFF",
} as const;

/** Lyko's palette: cream coat, black mask, amber eye, terra collar, gold Tag. */
export const LYKO_PALETTE: Readonly<Record<string, string>> = {
  k: "#1E1A22",
  f: "#EBCB94",
  F: "#FAE9C6",
  d: "#C99E62",
  D: "#9A7442",
  m: "#2B2220",
  M: "#4E3E36",
  a: "#E3A13A",
  n: "#0E0B0A",
  r: "#B8442B",
  s: "#E9EEF1",
  g: "#F4CB4E",
  G: "#B88A1E",
  t: "#E9737E",
};

/** Lyko trotting, facing right (two frames), after Lykia's sprite sheet. */
export const LYKO_TROT: readonly (readonly string[])[] = [
  [
    "...kkkk................kkkk.....",
    "..kFFFFk..............kmmMmk....",
    ".kFfkkfFk............kmmmmmmk...",
    ".kfk..kfk...........kfFFFmmmmk..",
    ".kfk..kfk..........kfFFFFfmmmk..",
    "..kfkkfdk.........kfFFkaFFfmmk..",
    "...kffdk.........kfFFFkkFFmmmkk.",
    "....kfdkkkkkkkkkkfFFFFFFfmmmmmnk",
    "...kfFFFFFFFFFFFFFFFFFFFmmmmmmk.",
    "..kdFFFFFFFFFFFFFFFFFFffkmmmtk..",
    "..kdffFFFFFFFFFFFFFFFffrsrsrkk..",
    "..kdfffffffffffffffffffkrgrk....",
    "..kDddffffffffffffffffdkkGk.....",
    "..kDdddddddffffffffdddddk.......",
    "...kDdkkdddk....kddkkdddk.......",
    "...kDdk.kddk....kddk.kddk.......",
    "...kdk..kddk....kddk..kddk......",
    "...kdk...kdk.....kdk...kdk......",
    "...kmmk..kmmk....kmmk..kmmk.....",
    "...kkkk..kkkk....kkkk..kkkk.....",
  ],
  [
    "...kkkk................kkkk.....",
    "..kFFFFk..............kmmMmk....",
    ".kFfkkfFk............kmmmmmmk...",
    ".kfk..kfk...........kfFFFmmmmk..",
    ".kfk..kfk..........kfFFFFfmmmk..",
    "..kfkkfdk.........kfFFkaFFfmmk..",
    "...kffdk.........kfFFFkkFFmmmkk.",
    "....kfdkkkkkkkkkkfFFFFFFfmmmmmnk",
    "...kfFFFFFFFFFFFFFFFFFFFmmmmmmk.",
    "..kdFFFFFFFFFFFFFFFFFFffkmmmtk..",
    "..kdffFFFFFFFFFFFFFFFffrsrsrkk..",
    "..kdfffffffffffffffffffkrgrk....",
    "..kDddffffffffffffffffdkkGk.....",
    "..kDdddddddffffffffdddddk.......",
    "....kDdkdddk.....kddkddk........",
    "....kDddddk......kdddddk........",
    ".....kdddk........kdddk.........",
    ".....kdkdk........kdkdk.........",
    ".....kmkmk........kmkmk.........",
    ".....kkkkk........kkkkk.........",
  ],
];

const LYKO_W = 32;
export const LYKIA_ASSEMBLE_S = 1.6;
export const LYKIA_WALK_S = 11;

/** The Lycian rock tomb: a temple front cut into the cliff. */
const TOMB = [
  "....kkkkkkkkkk....",
  "...kooooooooook...",
  "..kooooooooooook..",
  ".kkkkkkkkkkkkkkkk.",
  ".kSSSSSSSSSSSSSSk.",
  ".kSkkSSSSSSSSkkSk.",
  ".kSkkSSknnkSSkkSk.",
  ".kSkkSSknnkSSkkSk.",
  ".kSkkSSknnkSSkkSk.",
  ".kSkkSSknnkSSkkSk.",
  ".kSSSSSSSSSSSSSSk.",
  "kkkkkkkkkkkkkkkkkk",
];
const TOMB_PALETTE: Readonly<Record<string, string>> = { k: "#7E2C1B", o: MOSAIC.ochre, S: MOSAIC.stone, n: MOSAIC.navy };

const OLIVE = [
  "...ggg.gg...",
  ".gggGggggg..",
  "gggGgggGggg.",
  ".ggggGgggggg",
  "..ggg.gGgg..",
  ".....bb.....",
  "....bb......",
  "....bb......",
  "...bbbb.....",
];
const OLIVE_PALETTE: Readonly<Record<string, string>> = { g: MOSAIC.olive, G: "#7FA653", b: "#6B4A2B" };

/**
 * The Lykia ticket's scene at `t` seconds: sky, a sun in ochre, the sea with
 * a running-dog wave, the shore, the cliff with its tomb, an olive tree, and
 * Lyko trotting left to right. `still` stands him in the middle of the shore.
 */
export function lykiaScene(time: number, still = false): Grid {
  const t = Math.max(0, time);
  const g = grid(LYKIA_W, LYKIA_H, MOSAIC.sky);
  // Sun.
  for (let y = -4; y <= 4; y += 1) for (let x = -4; x <= 4; x += 1) if (x * x + y * y <= 17) put(g, MOSAIC.ochre, 58 + x, 8 + y);
  // Far hills.
  for (let x = 0; x < LYKIA_W; x += 1) {
    const top = Math.round(19 + 3 * Math.sin(x / 9) + 2 * Math.sin(x / 4.3));
    for (let y = top; y < 25; y += 1) put(g, y === top ? "#4E7430" : MOSAIC.olive, x, y);
  }
  // Sea, with crests that roll with time.
  const roll = still ? 0 : Math.floor(t * 3);
  for (let y = 25; y < 37; y += 1) for (let x = 0; x < LYKIA_W; x += 1) {
    const crest = (x + roll + (y % 2) * 5) % 14;
    put(g, y % 3 === 0 && crest < 3 ? MOSAIC.foam : y > 31 ? MOSAIC.seaDeep : MOSAIC.sea, x, y);
  }
  // Shore.
  for (let y = 37; y < LYKIA_H; y += 1) for (let x = 0; x < LYKIA_W; x += 1) put(g, y === 37 ? MOSAIC.foam : hash(x, y) > 0.9 ? MOSAIC.ochre : MOSAIC.sand, x, y);
  // Cliff on the right with the tomb.
  for (let x = 86; x < LYKIA_W; x += 1) {
    const top = Math.round(8 + (x - 86) * 0.15 + (hash(x, 1) > 0.6 ? 1 : 0));
    for (let y = top; y < 40; y += 1) put(g, y === top ? "#8F3622" : hash(x, y) > 0.8 ? "#A33F28" : MOSAIC.terra, x, y);
  }
  stamp(g, TOMB, 90, 18, TOMB_PALETTE);
  stamp(g, OLIVE, 70, 28, OLIVE_PALETTE);
  // Meander band along the bottom edge.
  for (let x = 0; x < LYKIA_W; x += 1) {
    const k = x % 8;
    put(g, MOSAIC.navy, x, LYKIA_H - 1);
    if (k === 0 || k === 4) put(g, MOSAIC.navy, x, LYKIA_H - 3, 1, 2);
    if (k < 4) put(g, MOSAIC.navy, x, LYKIA_H - 3);
  }

  // Lyko.
  const span = LYKIA_W + LYKO_W;
  const x = still ? 38 : Math.round((((t - LYKIA_ASSEMBLE_S) / LYKIA_WALK_S) % 1 + 1) % 1 * span) - LYKO_W;
  const frame = still ? 0 : Math.floor(t * 6) % 2;
  stamp(g, LYKO_TROT[frame]!, x, 25, LYKO_PALETTE);
  return g;
}

/** Every colour a sprite uses, for palette checks. */
export function spriteColours(rows: readonly string[]): Set<string> {
  return new Set(rows.join("").replace(/\./gu, "").split(""));
}
