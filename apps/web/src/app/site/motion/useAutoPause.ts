import React, { useCallback, useEffect, useState } from "react";

import { observeIntersection } from "./useInView";
import { usePageVisible } from "./usePageVisible";
import { useReducedMotion } from "./useReducedMotion";

export interface AutoPauseOptions {
  /** Extra manual pause (e.g. a Pause button). Merged into `data-kl-paused` and `active`. */
  readonly paused?: boolean;
  /** How far outside the viewport the element still counts as visible (default "200px"). */
  readonly rootMargin?: string;
}

export interface AutoPause<T extends Element> {
  readonly ref: React.RefCallback<T>;
  /** In view, page visible, motion allowed and not manually paused: JS loops may run. */
  readonly active: boolean;
}

/**
 * Pauses looping motion inside a section that is off-screen or in a hidden
 * tab. It toggles `data-kl-paused` on the element, which pauses every CSS
 * loop inside it (`.kl-loop`, `.kl-marquee`, `.kl-ping`, ... see styles.css),
 * and returns `active` for JavaScript loops (WAAPI, timers, rAF).
 */
export function useAutoPause<T extends Element = HTMLElement>(options: AutoPauseOptions = {}): AutoPause<T> {
  const { paused = false, rootMargin = "200px" } = options;
  const [element, setElement] = useState<T | null>(null);
  // Optimistic until the first observer callback: a loop may start for one
  // frame off-screen, but on-screen content never starts paused.
  const [inView, setInView] = useState(true);
  const visible = usePageVisible();
  const reduced = useReducedMotion();

  const ref = useCallback((node: T | null) => setElement(node), []);

  useEffect(() => {
    if (!element) return undefined;
    return observeIntersection(element, (entry) => setInView(entry.isIntersecting), { rootMargin });
  }, [element, rootMargin]);

  const halted = paused || !inView || !visible;

  useEffect(() => {
    if (!element) return;
    if (halted) element.setAttribute("data-kl-paused", "");
    else element.removeAttribute("data-kl-paused");
  }, [element, halted]);

  return { ref, active: !halted && !reduced };
}
