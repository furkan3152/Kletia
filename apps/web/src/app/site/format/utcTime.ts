/**
 * One clock for every status surface: "13:57:52 UTC", never the
 * reader's locale ("1:57:52 PM") next to a UTC board clock. Pure and
 * dependency-free so `node --test` loads it directly.
 */

function toDate(value: Date | number | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

const two = (value: number) => String(value).padStart(2, "0");

/** "13:57:52 UTC"; null for a value that is not a valid time. */
export function formatUtcTime(value: Date | number | string): string | null {
  const date = toDate(value);
  if (!date) return null;
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC`;
}

/** "13:57 UTC", for clocks that show minutes only (the departure board). */
export function formatUtcMinutes(value: Date | number | string): string | null {
  const date = toDate(value);
  if (!date) return null;
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

/** The machine-readable form for `<time dateTime>`; null when invalid. */
export function isoTime(value: Date | number | string): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}
