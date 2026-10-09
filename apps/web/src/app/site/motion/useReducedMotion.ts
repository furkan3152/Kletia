import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function mediaQuery(): MediaQueryList | null {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    return window.matchMedia(QUERY);
  } catch {
    return null;
  }
}

/**
 * True when the user asked for reduced motion. Non-hook form for event
 * handlers and imperative code; never throws (false when unknown).
 */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery();
  if (!query) return () => undefined;
  try {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  } catch {
    // Safari < 14 only supports the deprecated listener API.
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }
}

const serverSnapshot = () => false;

/** Live `prefers-reduced-motion: reduce` flag (updates when the OS setting changes). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, serverSnapshot);
}
