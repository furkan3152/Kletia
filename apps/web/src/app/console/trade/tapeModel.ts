/**
 * The Trade screen's price tape: the venue's mark price as Kletia read it
 * while the view was open, plus the levels the ticket computes (entry, liquidation). The API has
 * no candle history, so the tape is only what this browser saw: never a back-filled line. Pure
 * functions (node --test loads this file).
 */

export interface TapePoint {
  /** Read time, ms since epoch. */
  readonly t: number;
  /** Mark price, USD. */
  readonly p: number;
}

export interface TapeLevel {
  readonly id: string;
  readonly label: string;
  readonly price: number;
  readonly tone: "mark" | "entry" | "liq";
}

/** Keeps a tape short (the newest `max` reads); a read at the same time or a non-positive price is dropped. */
export function addTapePoint(points: readonly TapePoint[], point: TapePoint, max = 240): TapePoint[] {
  if (!Number.isFinite(point.p) || point.p <= 0 || !Number.isFinite(point.t)) return [...points];
  const last = points[points.length - 1];
  if (last && point.t <= last.t) return [...points];
  return [...points, point].slice(-max);
}

export interface TapeChart {
  /** SVG path of the line in a 100 x 100 box (null with fewer than two reads). */
  readonly path: string | null;
  readonly area: string | null;
  /** Each level's vertical position, 0 (top) to 100 (bottom). */
  readonly levels: readonly (TapeLevel & { readonly y: number })[];
  readonly min: number;
  readonly max: number;
  /** The last read's position (the live dot). */
  readonly head: { readonly x: number; readonly y: number } | null;
}

/**
 * Geometry of the tape and its levels in one price range, padded 8 % so the liquidation line
 * never sits on the edge. Null when there is nothing to draw (no read and no level).
 */
export function tapeChart(points: readonly TapePoint[], levels: readonly TapeLevel[]): TapeChart | null {
  const prices = [...points.map((point) => point.p), ...levels.map((level) => level.price)].filter((price) => Number.isFinite(price) && price > 0);
  if (prices.length === 0) return null;
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (max - min < max * 0.002) {
    const mid = (max + min) / 2;
    min = mid * 0.996;
    max = mid * 1.004;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  const y = (price: number) => 100 - ((price - min) / (max - min)) * 100;
  let path: string | null = null;
  let area: string | null = null;
  let head: TapeChart["head"] = null;
  if (points.length >= 2) {
    const start = points[0]!.t;
    const span = points[points.length - 1]!.t - start || 1;
    const xy = points.map((point) => [((point.t - start) / span) * 100, y(point.p)] as const);
    path = xy.map(([x, py], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${py.toFixed(2)}`).join(" ");
    area = `${path} L100 100 L0 100 Z`;
    const last = xy[xy.length - 1]!;
    head = { x: last[0], y: last[1] };
  }
  return {
    path,
    area,
    head,
    min,
    max,
    levels: levels.filter((level) => Number.isFinite(level.price) && level.price > 0).map((level) => ({ ...level, y: y(level.price) })),
  };
}

/** "since 14:02" (the first read), for the caption under the tape. */
export function tapeSince(points: readonly TapePoint[]): string | null {
  const first = points[0];
  if (!first) return null;
  return new Date(first.t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
