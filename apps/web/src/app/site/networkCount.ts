/**
 * Network counts and number words for page copy, read from the @kletia/core
 * registry so every "nine networks" on the site (home kicker and headline,
 * console lead, footer) is one number that cannot drift from what the API
 * plans against. Pure and dependency-free apart from the registry, so the
 * console copy and `node --test` can load it without the art module.
 */
import { CHAINS } from "@kletia/core";

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

const CHAIN_LIST = Object.values(CHAINS);

/** Every registry network, production and test (9). */
export const NETWORK_COUNT = CHAIN_LIST.length;
/** Networks that carry real funds (6). */
export const PRODUCTION_NETWORK_COUNT = CHAIN_LIST.filter((chain) => chain.lane !== "testnet").length;
/** Test networks (3). */
export const TEST_NETWORK_COUNT = NETWORK_COUNT - PRODUCTION_NETWORK_COUNT;
