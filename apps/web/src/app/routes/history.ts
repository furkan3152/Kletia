/**
 * Minimal history-API location store. No router dependency: one module-level
 * location, a listener set and `navigate()`. The router component subscribes
 * and renders inside a transition so lazy routes never flash a fallback.
 */

export type NavigationAction = "initial" | "push" | "replace" | "pop";

export interface RouteLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  /** Monotonic key; changes on every navigation, including hash-only ones. */
  readonly key: number;
  readonly action: NavigationAction;
  /** Scroll position to restore on back/forward navigation (null when unknown). */
  readonly restoreScrollY: number | null;
}

interface HistoryState {
  readonly kletiaKey?: number;
  readonly scrollY?: number;
}

type Listener = (location: RouteLocation) => void;

const listeners = new Set<Listener>();
let sequence = 0;

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/u, "") || "/";
  return pathname || "/";
}

function readWindowLocation(action: NavigationAction, restoreScrollY: number | null): RouteLocation {
  sequence += 1;
  return {
    pathname: normalizePathname(window.location.pathname),
    search: window.location.search,
    hash: window.location.hash,
    key: sequence,
    action,
    restoreScrollY,
  };
}

let current: RouteLocation = readWindowLocation("initial", null);

function emit() {
  for (const listener of [...listeners]) listener(current);
}

function currentState(): HistoryState {
  const state: unknown = window.history.state;
  return state && typeof state === "object" ? (state as HistoryState) : {};
}

function rememberScroll() {
  try {
    window.history.replaceState({ ...currentState(), scrollY: window.scrollY }, "");
  } catch {
    // History state can be unavailable in sandboxed frames; scroll restore is best effort.
  }
}

let installed = false;

/** Installs the popstate listener once. Called by the router on module load. */
export function installHistoryListener() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    window.history.scrollRestoration = "manual";
  } catch {
    // Not supported: the browser keeps its default behaviour.
  }
  // Keep the current entry's scroll position up to date, so forward (as well as back) navigation can
  // restore it: once popstate fires, the entry being left can no longer be written.
  let saveTimer: number | undefined;
  window.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(rememberScroll, 150);
    },
    { passive: true },
  );
  window.addEventListener("pagehide", rememberScroll);
  window.addEventListener("popstate", (event: PopStateEvent) => {
    // A save scheduled on the previous page must not land on the entry we just moved to.
    window.clearTimeout(saveTimer);
    const state = (event.state ?? {}) as HistoryState;
    current = readWindowLocation("pop", typeof state.scrollY === "number" ? state.scrollY : null);
    emit();
  });
}

export function getLocation(): RouteLocation {
  return current;
}

export function subscribeLocation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface NavigateOptions {
  readonly replace?: boolean;
}

/** True when `href` resolves to this origin (so the router can handle it). */
export function isInternalHref(href: string): boolean {
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Navigate to a same-origin URL. Cross-origin URLs fall back to a full page
 * load. Hash-only changes on the same path still produce a new location so
 * the router can scroll to the target.
 */
export function navigate(to: string, options: NavigateOptions = {}) {
  let url: URL;
  try {
    url = new URL(to, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) {
    window.location.assign(url.toString());
    return;
  }
  const target = `${url.pathname}${url.search}${url.hash}`;
  rememberScroll();
  const state: HistoryState = { kletiaKey: sequence + 1, scrollY: 0 };
  if (options.replace) {
    window.history.replaceState(state, "", target);
  } else {
    window.history.pushState(state, "", target);
  }
  current = readWindowLocation(options.replace ? "replace" : "push", null);
  emit();
}
