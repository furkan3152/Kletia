/**
 * The station directory on /protocols: one row per sign word ("Swap" covers
 * both dex and dex-aggregator, "Bridge" both bridge and intent-network),
 * and each row is a button that sets the category filter to that group. The
 * category filter accepts a group key or, for old links, a registry
 * category. Pure, so `node --test` loads it directly.
 */
import { categoryIcon, categoryWord, type IconName } from "../../site/art/icons.ts";

export interface DirectoryRow {
  /** The filter value this row sets: the slug of its sign word ("swap", "bridge", "lending"). */
  readonly key: string;
  readonly word: string;
  readonly icon: IconName;
  readonly count: number;
  /** The registry categories the row covers, in first-seen order. */
  readonly categories: readonly string[];
}

/** "Swap" -> "swap", "Your contract" -> "your-contract": the filter value of a category's group. */
export function categoryGroupKey(category: string | undefined | null): string {
  return categoryWord(category || "other")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** Directory rows for these protocols, largest first (ties by word). */
export function directoryRows(protocols: readonly { readonly category?: string }[]): DirectoryRow[] {
  const rows = new Map<string, { key: string; word: string; icon: IconName; count: number; categories: string[] }>();
  for (const protocol of protocols) {
    const category = protocol.category || "other";
    const key = categoryGroupKey(category);
    const row = rows.get(key) ?? { key, word: categoryWord(category), icon: categoryIcon(category), count: 0, categories: [] };
    row.count += 1;
    if (!row.categories.includes(category)) row.categories.push(category);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, "en"));
}

/** Whether a protocol's category passes the category filter ("all", a group key, or a registry category from an old link). */
export function categoryMatches(category: string | undefined, filter: string): boolean {
  if (filter === "all") return true;
  const value = category || "other";
  return value === filter || categoryGroupKey(value) === filter;
}

/** The filter values the data knows: every group key and every registry category. */
export function knownCategoryFilters(protocols: readonly { readonly category?: string }[]): Set<string> {
  const known = new Set<string>();
  for (const protocol of protocols) {
    const category = protocol.category || "other";
    known.add(category);
    known.add(categoryGroupKey(category));
  }
  return known;
}

/** Pressing a row selects its group; pressing the selected row again clears the category. */
export function directoryRowFilter(row: Pick<DirectoryRow, "key" | "categories">, current: string): string {
  const selected = current === row.key || (row.categories.length === 1 && current === row.categories[0]);
  return selected ? "all" : row.key;
}

/** Whether a row shows as pressed for the current filter (a group key, or the row's only category). */
export function isRowSelected(row: Pick<DirectoryRow, "key" | "categories">, current: string): boolean {
  return current === row.key || row.categories.includes(current);
}
