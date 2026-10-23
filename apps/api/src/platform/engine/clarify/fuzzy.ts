/**
 * Deterministic typo matching for the clarify layer (clarify design §4.3):
 * optimal-string-alignment Damerau-Levenshtein distance against a closed
 * vocabulary. A token is corrected only when exactly one vocabulary word is
 * closest within its threshold; ties are reported to the caller (which asks),
 * never guessed.
 *
 * Thresholds: shorter than 3 characters, never; 3 characters, only one
 * missing letter into a 4-letter word ("frm" -> "from"); 4-6 characters,
 * distance 1; 7 or more, distance 2.
 *
 * Keyword corrections (verbs, connectors, networks, venues) go through
 * `keywordCandidates`, which never corrects a token that is itself an
 * English word ("case" is not "base", "delay" is not "relay"; design A.2 L2,
 * red-team A9).
 */
import { isEnglishWord } from "./englishWords.js";

export function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const d: number[][] = Array.from({ length: s.length + 1 }, () => new Array<number>(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i += 1) d[i]![0] = i;
  for (let j = 0; j <= t.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    const row = d[i]!;
    const prev = d[i - 1]!;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[s.length]![t.length]!;
}

/** Largest distance a token of this length may be corrected across. */
export function threshold(token: string): number {
  if (token.length < 3) return 0;
  if (token.length >= 7) return 2;
  return 1;
}

function isSingleDeletion(short: string, long: string): boolean {
  if (long.length !== short.length + 1) return false;
  const lower = short.toLowerCase();
  for (let i = 0; i < long.length; i += 1) {
    if ((long.slice(0, i) + long.slice(i + 1)).toLowerCase() === lower) return true;
  }
  return false;
}

/** The closest vocabulary words within the token's threshold (vocabulary order); empty when none, several on a tie. */
export function candidates(token: string, vocabulary: readonly string[]): string[] {
  const limit = threshold(token);
  if (limit === 0) return [];
  const scored = vocabulary
    .map((word, order) => ({ word, order, score: distance(token, word) }))
    .filter((entry) => entry.score > 0 && entry.score <= limit)
    .filter((entry) => token.length > 3 || (entry.word.length === 4 && entry.score === 1 && isSingleDeletion(token, entry.word)));
  if (scored.length === 0) return [];
  const best = Math.min(...scored.map((entry) => entry.score));
  return [...new Set(scored.filter((entry) => entry.score === best).sort((x, y) => x.order - y.order).map((entry) => entry.word))];
}

/**
 * `candidates` for keyword corrections: none when the token is itself an
 * English word (clarify/englishWords.ts), so a word the person typed is
 * never turned into a network, venue, verb or connector.
 */
export function keywordCandidates(token: string, vocabulary: readonly string[]): string[] {
  if (isEnglishWord(token)) return [];
  return candidates(token, vocabulary);
}
