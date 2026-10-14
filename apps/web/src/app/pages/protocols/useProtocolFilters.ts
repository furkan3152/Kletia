/**
 * The /protocols filter hook. The URL is written with `history.replaceState`,
 * never `navigate()`: the router scrolls to the top on every navigation it
 * emits, and a filter change must not move the page. The pure state helpers
 * live in protocolFilterState.ts and are re-exported here.
 */
import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { useRoute } from "../../routes/useRoute";
import { runViewTransition } from "../../site/motion/viewTransition";
import { EMPTY_FILTERS, parseFilters, sanitizeFilters, serializeFilters, type ProtocolFilterState } from "./protocolFilterState";

export {
  activeFilterCount,
  applyFilters,
  EMPTY_FILTERS,
  hasActiveFilters,
  parseFilters,
  sanitizeFilters,
  serializeFilters,
  SORTS,
  type ProtocolFilterState,
  type ProtocolSort,
} from "./protocolFilterState";

const PROTOCOLS_PATH = "/protocols";

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
