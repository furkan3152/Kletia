/**
 * Scoring for the portal search palette (portal design 4.6): an exact code or
 * path first, then a title that starts with the query, then every query word
 * as the start of a word, then plain substrings. Pure and deterministic.
 */

/** Lower-case words of a title or keyword list: "POLICY_VIOLATION" → policy, violation; "/v1/intents/{id}" → v1, intents, id. */
export function words(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/gu, " ");
}

export const SCORE = Object.freeze({
  exact: 1_000,
  exactKeyword: 950,
  prefix: 800,
  wordPrefixTitle: 600,
  wordPrefixAny: 450,
  substringTitle: 400,
  substringAny: 200,
  none: 0,
});

export interface Scorable {
  readonly title: string;
  readonly detail: string;
  /** Lower-case extra terms, space separated (ids, paths, tags, statuses). */
  readonly keywords: string;
}

/** Higher is better; 0 means no match. Ties inside one band favour the shorter title. */
export function scoreEntry(entry: Scorable, rawQuery: string): number {
  const query = normalizeQuery(rawQuery);
  if (!query) return SCORE.none;
  const title = entry.title.toLowerCase();
  const keywords = entry.keywords.toLowerCase();
  const detail = entry.detail.toLowerCase();
  const brevity = Math.max(0, 40 - title.length) / 100;
  if (title === query) return SCORE.exact + brevity;
  if (keywords.split(" ").includes(query)) return SCORE.exactKeyword + brevity;
  if (title.startsWith(query)) return SCORE.prefix + brevity;
  const tokens = words(query);
  if (tokens.length > 0) {
    const titleWords = words(title);
    const startsAWord = (pool: readonly string[]) => tokens.every((token) => pool.some((word) => word.startsWith(token)));
    if (startsAWord(titleWords)) return SCORE.wordPrefixTitle + brevity;
    if (startsAWord([...titleWords, ...words(keywords), ...words(detail)])) return SCORE.wordPrefixAny + brevity;
  }
  if (title.includes(query)) return SCORE.substringTitle + brevity;
  if (keywords.includes(query) || detail.includes(query)) return SCORE.substringAny + brevity;
  return SCORE.none;
}
