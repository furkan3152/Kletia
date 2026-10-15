/**
 * Counts and name lists for page copy, read from the @kletia/core registry at
 * render time so headings like "Six production lines and one test yard." never
 * drift from what the API plans against.
 */
import { PRODUCTION_LINES, YARD_LINES, type Line } from "./art";

export { countWord, countWordTitle, NETWORK_COUNT, PRODUCTION_NETWORK_COUNT, TEST_NETWORK_COUNT } from "./networkCount";

/** "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Networks that carry real funds, in registry order. */
export const PRODUCTION: readonly Line[] = PRODUCTION_LINES;
/** Testnets, parked in the test yard. */
export const YARD: readonly Line[] = YARD_LINES;

