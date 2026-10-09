/**
 * Filter state for /protocols, mirrored into the URL
 * (`?q=&network=base,solana&cap=execute&category=dex&xchain=1&sort=az`).
 *
 * The URL is written with `history.replaceState`, never `navigate()`: the
 * router scrolls to the top on every navigation it emits, and a filter
 * change must not move the page. Unknown values are ignored.
 */
import { type ProtocolCapability } from "@kletia/core";
import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { useRoute } from "../../routes/useRoute";
import { runViewTransition } from "../../site/motion/viewTransition";
import {
  CAPABILITIES,
  capabilitiesOf,
  humanizeCategory,
  networkLabel,
  networksOf,
  strongestCapability,
  type ProtocolEntry,
} from "./protocolStats";

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
const PROTOCOLS_PATH = "/protocols";

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
    if (filters.category !== "all" && protocol.category !== filters.category) return false;
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

export interface ProtocolFiltersApi {
  readonly filters: ProtocolFilterState;
  /** The search box value (filters.q follows it after a 120 ms debounce). */
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  /** Applies a change; `animate` runs it inside a View Transition (cards glide). */
  readonly update: (change: Partial<ProtocolFilterState>, options?: { readonly animate?: boolean }) => void;
  readonly clear: (options?: { readonly animate?: boolean }) => void;
}

function isProtocolsPath(): boolean {
  const path = window.location.pathname.replace(/\/+$/u, "") || "/";
  return path === PROTOCOLS_PATH;
}

/**
 * @param available Values the loaded data knows. When given, the URL drops
 *   anything else (a network from an old link, a removed category). Pass null
 *   while the data is still loading so a valid value is not dropped early.
 */
export function useProtocolFilters(
  available: { readonly networks: ReadonlySet<string>; readonly categories: ReadonlySet<string> } | null = null,
): ProtocolFiltersApi {
  const { location } = useRoute();
  const [state, setState] = useState(() => ({ key: location.key, filters: parseFilters(location.search) }));
  const [draft, setDraftState] = useState(state.filters.q);

  // A navigation to /protocols with a new query (a link, back/forward) resets the filters.
  if (state.key !== location.key && location.pathname === PROTOCOLS_PATH) {
    const filters = parseFilters(location.search);
    setState({ key: location.key, filters });
    setDraftState(filters.q);
  }

  const { filters } = state;

  // Mirror into the URL without emitting a navigation (no scroll jump).
  useEffect(() => {
    if (!isProtocolsPath()) return;
    const shown = available ? sanitizeFilters(filters, available) : filters;
    const next = `${PROTOCOLS_PATH}${serializeFilters(shown)}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next === current) return;
    try {
      window.history.replaceState(window.history.state, "", next);
    } catch {
      // Some embedded browsers refuse replaceState; the filters still work.
    }
  }, [filters, available]);

  // Debounced search.
  useEffect(() => {
    if (draft === filters.q) return undefined;
    const timer = window.setTimeout(() => {
      setState((current) => (current.filters.q === draft ? current : { ...current, filters: { ...current.filters, q: draft } }));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [draft, filters.q]);

  const update = useCallback(
    (change: Partial<ProtocolFilterState>, options: { readonly animate?: boolean } = {}) => {
      const apply = () =>
        setState((current) => ({ ...current, filters: { ...current.filters, ...change } }));
      if (options.animate) {
        void runViewTransition("filter", () => flushSync(apply));
      } else {
        apply();
      }
    },
    [],
  );

  const clear = useCallback(
    (options: { readonly animate?: boolean } = {}) => {
      setDraftState("");
      update({ ...EMPTY_FILTERS, sort: state.filters.sort }, options);
    },
    [update, state.filters.sort],
  );

  return { filters, draft, setDraft: setDraftState, update, clear };
}
