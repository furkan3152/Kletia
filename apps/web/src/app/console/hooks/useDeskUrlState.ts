/**
 * Keeps the desk and its URL in step (console design 3.13): the path picks
 * the view (and an open tool), `?from=` sets the departure and mirrors it,
 * and `?q=` plans its sentence once, then disappears from the URL so a reload
 * never plans twice. StrictMode-safe: the plan is scheduled in an effect
 * whose cleanup cancels it, so a remount schedules it again exactly once.
 *
 * URL rewrites that only mirror state use `history.replaceState` with the
 * current history state (the router's scroll and focus handling is for
 * real navigations); switching views is a navigation.
 */
import { useCallback, useEffect, useRef } from "react";

import { navigate, useRoute } from "../../routes/useRoute";
import type { DeskView } from "../state/deskModel";
import { getDeskStore, useDeskStore } from "../state/deskStore";
import { deskLocationOf, deskPathOf, readDeskSearch, searchWithDeparture, searchWithoutQuery } from "./deskUrl";

function replaceSearch(search: string): void {
  const { pathname, hash } = window.location;
  const target = `${pathname}${search}${hash}`;
  if (target === `${pathname}${window.location.search}${hash}`) return;
  try {
    window.history.replaceState(window.history.state, "", target);
  } catch {
    // A refused history write leaves the address bar as it was.
  }
}

export interface DeskUrlState {
  /** Opens a view (and a tool): a navigation, so back returns to the previous view. */
  openView(view: DeskView, toolId?: string | null): void;
}

export function useDeskUrlState(onQuery: (sentence: string) => void): DeskUrlState {
  const { location } = useRoute();
  const departure = useDeskStore((state) => state.departure);
  const onQueryRef = useRef(onQuery);
  useEffect(() => {
    onQueryRef.current = onQuery;
  });

  // Path -> view.
  useEffect(() => {
    const { view, toolId } = deskLocationOf(location.pathname);
    const store = getDeskStore().getState();
    if (view === "tools") store.openTool(toolId);
    else store.setView(view);
  }, [location.pathname]);

  // ?from= -> departure (an unknown key is ignored).
  useEffect(() => {
    const { from } = readDeskSearch(location.search);
    if (from && from !== getDeskStore().getState().departure) getDeskStore().getState().setDeparture(from);
  }, [location.search, location.key]);

  // Departure -> ?from= (Auto is the default and drops it).
  useEffect(() => {
    replaceSearch(searchWithDeparture(window.location.search, departure));
  }, [departure]);

  // ?q= -> plan once, then remove it.
  useEffect(() => {
    const { q } = readDeskSearch(window.location.search);
    if (!q) return undefined;
    const timer = window.setTimeout(() => {
      if (readDeskSearch(window.location.search).q !== q) return;
      replaceSearch(searchWithoutQuery(window.location.search));
      onQueryRef.current(q);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [location.key]);

  const openView = useCallback((view: DeskView, toolId: string | null = null) => {
    const path = deskPathOf({ view, toolId });
    if (path === window.location.pathname) {
      const store = getDeskStore().getState();
      if (view === "tools") store.openTool(toolId);
      else store.setView(view);
      return;
    }
    navigate(`${path}${window.location.search}`);
  }, []);

  return { openView };
}
