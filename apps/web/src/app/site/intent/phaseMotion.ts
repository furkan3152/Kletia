import { useEffect, useState } from "react";

import { DURATION, EASE } from "../motion/tokens";
import { useChangeKey } from "../motion/useChangeKey";
import { prefersReducedMotion } from "../motion/useReducedMotion";

/**
 * Presentation-only motion for step phases. Nothing here reads or changes
 * execution state; it only animates elements that already rendered the new
 * state. Keep it out of `stepPhase.ts`, which must stay Node-safe.
 */

/** How long an attention loop (signature ring, "checking" pulse) runs before it rests as a static outline. */
export const ATTENTION_LOOP_MS = 4800;

/** One-shot Web Animation; a no-op with reduced motion or without WAAPI. */
export function playOnce(
  element: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): void {
  if (!element || typeof element.animate !== "function" || prefersReducedMotion()) return;
  try {
    element.animate(keyframes, options);
  } catch {
    // Decorative only.
  }
}

/** Pen icon when a step starts waiting for its signature: rotate -12° → 0. */
export function nudgePen(element: Element | null | undefined): void {
  playOnce(element, [{ transform: "rotate(-12deg)" }, { transform: "rotate(0deg)" }], {
    duration: DURATION.base,
    easing: EASE.snap,
  });
}

/** A text value that just changed meaning (e.g. "Settles on" while settling): one soft pulse. */
export function pulseText(element: Element | null | undefined): void {
  playOnce(element, [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], {
    duration: DURATION.slower,
    easing: EASE.standard,
  });
}

/** A control that just unlocked (e.g. Confirm): it pops out of its pressed position into its shadow. */
export function popOut(element: Element | null | undefined): void {
  playOnce(element, [{ transform: "translate(3px, 3px)" }, { transform: "translate(0, 0)" }], {
    duration: DURATION.base,
    easing: EASE.snap,
  });
}

/** Send button: the icon nudges up-right 3px and returns. */
export function nudgeUpRight(element: Element | null | undefined): void {
  playOnce(
    element,
    [{ transform: "translate(0, 0)" }, { transform: "translate(3px, -3px)" }, { transform: "translate(0, 0)" }],
    { duration: 180, easing: EASE.out },
  );
}

/**
 * Bounds a looping attention animation: true while `active` and for at most
 * `limitMs` after it became active, so nothing pulses for longer than about
 * five seconds (WCAG 2.2.2). Callers show a static outline afterwards.
 */
export function useBoundedLoop(active: boolean, limitMs = ATTENTION_LOOP_MS): boolean {
  const epoch = useChangeKey(active);
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => setExpired(epoch), limitMs);
    return () => window.clearTimeout(timer);
  }, [active, epoch, limitMs]);
  return active && expired !== epoch;
}
