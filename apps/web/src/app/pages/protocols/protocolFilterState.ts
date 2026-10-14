/**
 * Filter state for /protocols (pure: parsing, writing and applying; the hook
 * lives in useProtocolFilters.ts), mirrored into the URL
 * (`?q=&network=base,solana&cap=execute&category=swap&xchain=1&sort=az`).
 * `category` is a directory group ("swap" covers dex and dex-aggregator) or,
 * from older links, one registry category.
 *
 * The URL is written with `history.replaceState`, never `navigate()`: the
 * router scrolls to the top on every navigation it emits, and a filter
 * change must not move the page. Unknown values are ignored.
 */
import { type ProtocolCapability } from "@kletia/core";

import { categoryMatches } from "./directoryFilter.ts";
import {
  CAPABILITIES,
  capabilitiesOf,
  humanizeCategory,
  networkLabel,
  networksOf,
  strongestCapability,
  type ProtocolEntry,
} from "./protocolStats.ts";

export type ProtocolSort = "execute" | "az" | "category";
export const SORTS: readonly { readonly value: ProtocolSort; readonly label: string }[] = [
  { value: "execute", label: "Execute first" },
  { value: "az", label: "A–Z" },
  { value: "category", label: "Category" },
];

export interface ProtocolFilterState {
  readonly q: string;
  /** Network keys; a protocol matches when it is on any of them. */
  readonly networks: readonly string[];
  readonly cap: "all" | ProtocolCapability;
  readonly category: string;
  readonly xchain: boolean;
  readonly sort: ProtocolSort;
}

export const EMPTY_FILTERS: ProtocolFilterState = Object.freeze({
  q: "",
  networks: Object.freeze([]) as readonly string[],
  cap: "all",
  category: "all",
  xchain: false,
  sort: "execute",
});

const TOKEN = /^[a-z0-9][a-z0-9-]{0,47}$/u;

/** Reads filters from a query string. Malformed values fall back to defaults. */
export function parseFilters(search: string): ProtocolFilterState {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return EMPTY_FILTERS;
  }
  const q = (params.get("q") ?? "").slice(0, 80);
  const networks = [
    ...new Set(
      (params.get("network") ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter((value) => TOKEN.test(value)),
    ),
  ].slice(0, 16);
  const capRaw = params.get("cap") ?? "";
  const cap = (CAPABILITIES as readonly string[]).includes(capRaw) ? (capRaw as ProtocolCapability) : "all";
  const categoryRaw = (params.get("category") ?? "").toLowerCase();
  const category = TOKEN.test(categoryRaw) ? categoryRaw : "all";
  const xchain = params.get("xchain") === "1";
  const sortRaw = params.get("sort") ?? "";
  const sort = SORTS.some((option) => option.value === sortRaw) ? (sortRaw as ProtocolSort) : "execute";
  return { q, networks, cap, category, xchain, sort };
}

/** Writes filters as a query string ("" when everything is default). */
export function serializeFilters(filters: ProtocolFilterState): string {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set("q", q);
  if (filters.networks.length > 0) params.set("network", filters.networks.join(","));
  if (filters.cap !== "all") params.set("cap", filters.cap);
  if (filters.category !== "all") params.set("category", filters.category);
  if (filters.xchain) params.set("xchain", "1");
  if (filters.sort !== "execute") params.set("sort", filters.sort);
  const text = params.toString().replace(/%2C/gu, ",");
  return text ? `?${text}` : "";
}

/** Drops filter values the current data does not know (e.g. a network from an old link). */
export function sanitizeFilters(
  filters: ProtocolFilterState,
  available: { readonly networks: ReadonlySet<string>; readonly categories: ReadonlySet<string> },
): ProtocolFilterState {
  const networks = filters.networks.filter((key) => available.networks.has(key));
  const category = filters.category === "all" || available.categories.has(filters.category) ? filters.category : "all";
  if (networks.length === filters.networks.length && category === filters.category) return filters;
  return { ...filters, networks, category };
}

/** Number of active filters, for the mobile "Filters (n)" button (search and sort excluded). */
export function activeFilterCount(filters: ProtocolFilterState): number {
  return (
    filters.networks.length +
    (filters.cap === "all" ? 0 : 1) +
    (filters.category === "all" ? 0 : 1) +
    (filters.xchain ? 1 : 0)
  );
}

export function hasActiveFilters(filters: ProtocolFilterState): boolean {
  return activeFilterCount(filters) > 0 || filters.q.trim().length > 0;
}

const CAPABILITY_RANK: Readonly<Record<ProtocolCapability, number>> = { execute: 0, quote: 1, discover: 2 };

function searchText(protocol: ProtocolEntry): string {
  return [
    protocol.name,
    protocol.id,
    protocol.summary,
    protocol.category,
    humanizeCategory(protocol.category),
    ...networksOf(protocol).map((key) => networkLabel(key).name),
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
}

export function applyFilters(protocols: readonly ProtocolEntry[], filters: ProtocolFilterState): ProtocolEntry[] {
  const terms = filters.q.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const selected = new Set(filters.networks);
  const result = protocols.filter((protocol) => {
    if (filters.cap !== "all" && !capabilitiesOf(protocol).includes(filters.cap)) return false;
    if (!categoryMatches(protocol.category, filters.category)) return false;
    if (filters.xchain && !protocol.crossChain) return false;
    if (selected.size > 0 && !networksOf(protocol).some((key) => selected.has(key))) return false;
    if (terms.length > 0) {
      const text = searchText(protocol);
      if (!terms.every((term) => text.includes(term))) return false;
    }
    return true;
  });
  const byName = (a: ProtocolEntry, b: ProtocolEntry) =>
    String(a.name).localeCompare(String(b.name), "en", { sensitivity: "base" });
  if (filters.sort === "az") return result.sort(byName);
  if (filters.sort === "category") {
    return result.sort(
      (a, b) => humanizeCategory(a.category).localeCompare(humanizeCategory(b.category), "en") || byName(a, b),
    );
  }
  return result.sort(
    (a, b) => CAPABILITY_RANK[strongestCapability(a)] - CAPABILITY_RANK[strongestCapability(b)] || byName(a, b),
  );
}

