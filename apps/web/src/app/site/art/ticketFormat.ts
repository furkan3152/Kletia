/**
 * Pure formatting helpers for tickets and receipts. Dependency-free so
 * `node --test` can load it directly.
 */

/** "0x8f2c…91ab" for a long hash or signature; short values are returned as they are. */
export function shortHash(value: string, head = 6, tail = 4): string {
  const text = value.trim();
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Leg number on two digits: 1 -> "01". */
export function legNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/** "2/2" style count for the stub, clamped to the total. */
export function countOf(done: number, total: number): string {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeDone = Math.min(Math.max(0, Math.floor(done)), safeTotal);
  return `${safeDone}/${safeTotal}`;
}

/** Punch holes printed on a stub: one per leg up to `max`; beyond that the count is printed instead. */
export function punchCount(total: number, max = 8): number {
  const safe = Math.max(0, Math.floor(total));
  return safe > max ? 0 : safe;
}
