/**
 * Counts and name lists for page copy, read from the @kletia/core registry at
 * render time so headings like "Six production lines and one test yard." never
 * drift from what the API plans against.
 */
import { PRODUCTION_LINES, YARD_LINES, type Line } from "./art";

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** "six" for 6, digits from 13 up (headings read better with small numbers in words). */
export function countWord(count: number): string {
  return Number.isInteger(count) && count >= 0 && count < WORDS.length ? WORDS[count]! : String(count);
}

/** "Six", for the start of a sentence. */
export function countWordTitle(count: number): string {
  const word = countWord(count);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Networks that carry real funds, in registry order. */
export const PRODUCTION: readonly Line[] = PRODUCTION_LINES;
/** Testnets, parked in the test yard. */
export const YARD: readonly Line[] = YARD_LINES;

