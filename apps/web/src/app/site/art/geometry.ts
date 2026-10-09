/**
 * Geometry for octilinear transit drawings (the route map and its rules).
 * Pure and dependency-free so `node --test` can load it directly.
 */

export type Pt = readonly [number, number];

/** Rounds to one decimal place, which keeps generated path data short. */
const r1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Octilinear polyline with rounded bends, as SVG path data. Each bend is a
 * quadratic curve that starts `radius` before the corner and ends `radius`
 * after it (never more than half of either segment, so short legs stay
 * straight). Throws on fewer than two points or a zero-length segment.
 */
export function rounded(points: readonly Pt[], radius = 18): string {
  if (points.length < 2) throw new Error("A line needs at least two points.");
  let d = `M${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1]!;
    const [cx, cy] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const d1 = Math.hypot(cx - px, cy - py);
    const d2 = Math.hypot(nx - cx, ny - cy);
    if (d1 === 0 || d2 === 0) throw new Error("A line cannot have a zero-length segment.");
    const a = Math.min(radius, d1 / 2);
    const b = Math.min(radius, d2 / 2);
    d += `L${r1(cx - ((cx - px) / d1) * a)} ${r1(cy - ((cy - py) / d1) * a)}`;
    d += `Q${cx} ${cy} ${r1(cx + ((nx - cx) / d2) * b)} ${r1(cy + ((ny - cy) / d2) * b)}`;
  }
  const last = points[points.length - 1]!;
  return `${d}L${last[0]} ${last[1]}`;
}

/** Straight segment from `p` along the unit normal `n`, between distances `a` and `b`. */
export function tick(p: Pt, n: Pt, a: number, b: number): string {
  return `M${r1(p[0] + n[0] * a)} ${r1(p[1] + n[1] * a)}L${r1(p[0] + n[0] * b)} ${r1(p[1] + n[1] * b)}`;
}

/** True when every segment is horizontal, vertical or at 45 degrees. */
export function isOctilinear(points: readonly Pt[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    const dx = Math.abs(points[i]![0] - points[i - 1]![0]);
    const dy = Math.abs(points[i]![1] - points[i - 1]![1]);
    if (!(dx === 0 || dy === 0 || dx === dy)) return false;
  }
  return true;
}

export const D = Math.SQRT1_2;
export const UP: Pt = [0, -1];
export const DOWN: Pt = [0, 1];
export const LEFT: Pt = [-1, 0];
export const RIGHT: Pt = [1, 0];
export const UP_LEFT: Pt = [-D, -D];
export const UP_RIGHT: Pt = [D, -D];
export const DOWN_LEFT: Pt = [-D, D];
export const DOWN_RIGHT: Pt = [D, D];
