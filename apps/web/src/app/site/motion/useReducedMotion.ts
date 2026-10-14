import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The site's own motion switch (portal design S-09): the footer's
 * "Animations" setting stores "off" under this key and marks the document
 * `html[data-motion="off"]` (index.html applies it before the first paint).
 * Off means reduced motion everywhere, whatever the operating system says.
 */
export const MOTION_STORAGE_KEY = "kletia-site-motion";
export type MotionSetting = "on" | "off";

function mediaQuery(): MediaQueryList | null {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    return window.matchMedia(QUERY);
  } catch {
    return null;
  }
}

function documentMotionOff(): boolean {
  try {
    return typeof document !== "undefined" && document.documentElement.getAttribute("data-motion") === "off";
  } catch {
    return false;
  }
}

/**
 * True when the user asked for reduced motion: the operating system setting
 * or the site's own switch. Non-hook form for event handlers and imperative
 * code; never throws (false when unknown).
 */
export function prefersReducedMotion(): boolean {
  return documentMotionOff() || (mediaQuery()?.matches ?? false);
}

const listeners = new Set<() => void>();

/** The stored site setting ("on" unless the visitor turned animations off). */
export function readMotionSetting(): MotionSetting {
  try {
    return window.localStorage.getItem(MOTION_STORAGE_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

/** Marks the document; `prefersReducedMotion()` and the CSS (html[data-motion="off"]) follow it. */
export function applyMotionSetting(setting: MotionSetting) {
  try {
    if (setting === "off") document.documentElement.setAttribute("data-motion", "off");
    else document.documentElement.removeAttribute("data-motion");
  } catch {
    // No document (tests, workers): nothing to mark.
  }
}

/** Stores, applies and announces the site setting to every `useReducedMotion` subscriber. */
export function setMotionSetting(setting: MotionSetting) {
  try {
    if (setting === "off") window.localStorage.setItem(MOTION_STORAGE_KEY, "off");
    else window.localStorage.removeItem(MOTION_STORAGE_KEY);
  } catch {
    // Storage can be blocked; the choice then lasts for this page view.
  }
  applyMotionSetting(setting);
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const query = mediaQuery();
  if (!query) return () => listeners.delete(onChange);
  try {
    query.addEventListener("change", onChange);
    return () => {
      listeners.delete(onChange);
      query.removeEventListener("change", onChange);
    };
  } catch {
    // Safari < 14 only supports the deprecated listener API.
    query.addListener?.(onChange);
    return () => {
      listeners.delete(onChange);
      query.removeListener?.(onChange);
    };
  }
}

const serverSnapshot = () => false;

/** Live reduced-motion flag: the OS setting or the site's switch (updates when either changes). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, serverSnapshot);
}

/** Live site setting for the footer switch. */
export function useMotionSetting(): MotionSetting {
  return useSyncExternalStore(subscribe, readMotionSetting, () => "on");
}
