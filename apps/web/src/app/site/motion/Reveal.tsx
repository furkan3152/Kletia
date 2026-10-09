import React, { useCallback, useLayoutEffect, useRef } from "react";

import { cssVars, staggerIndex } from "./tokens";
import { observeIntersection, supportsIntersectionObserver } from "./useInView";
import { prefersReducedMotion } from "./useReducedMotion";

export type RevealDistance = "md" | "lg" | "xl";

export type RevealProps = {
  /** Element to render (default `div`). */
  readonly as?: keyof JSX.IntrinsicElements;
  /** Rise direct children marked `data-reveal-item` one after another (60 ms apart, capped at 8). */
  readonly stagger?: boolean;
  /** Extra delay before the reveal, in ms. */
  readonly delay?: number;
  /** Travel distance (default "lg" = 16px). */
  readonly distance?: RevealDistance;
  /** Reveal only the first time (default true). With false it re-arms when scrolled back above. */
  readonly once?: boolean;
} & React.HTMLAttributes<HTMLElement>;

const THRESHOLD = 0.15;

function isRevealed(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= THRESHOLD) return true;
  // Very tall elements can never reach the ratio: reveal once their top is in.
  const rootHeight = entry.rootBounds?.height ?? window.innerHeight;
  return entry.boundingClientRect.height * THRESHOLD >= rootHeight;
}

/**
 * Scroll reveal with progressive enhancement. Content is in the DOM and
 * visible from the first paint; after mount, and only when motion is allowed,
 * IntersectionObserver exists and the element starts below the viewport, it
 * is armed (`data-reveal="pending"`: opacity 0 plus a small offset) and rises
 * into place when scrolled into view. Elements already on screen are never
 * hidden, focus inside forces it visible, printing shows everything, and
 * the content never leaves the accessibility tree.
 */
export function Reveal({
  as = "div",
  stagger = false,
  delay,
  distance,
  once = true,
  className,
  style,
  children,
  ...rest
}: RevealProps) {
  const elementRef = useRef<HTMLElement | null>(null);
  const setRef = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    if (stagger) {
      let index = 0;
      for (const child of Array.from(element.children)) {
        if (!child.hasAttribute("data-reveal-item")) continue;
        (child as HTMLElement).style.setProperty("--kl-i", String(staggerIndex(index)));
        index += 1;
      }
    }

    let cancelled = false;
    let stop: () => void = () => undefined;
    // Decide after the commit (a microtask runs before the next paint), so the
    // router's scroll restoration has already happened when we measure.
    queueMicrotask(() => {
      if (cancelled || prefersReducedMotion() || !supportsIntersectionObserver()) return;
      const viewportBottom = window.innerHeight || document.documentElement.clientHeight;
      if (element.getBoundingClientRect().top <= viewportBottom) return;
      element.setAttribute("data-reveal", "pending");
      stop = observeIntersection(
        element,
        (entry) => {
          if (isRevealed(entry)) {
            element.setAttribute("data-reveal", "shown");
            if (once) stop();
          } else if (!once && entry.boundingClientRect.top > (entry.rootBounds?.bottom ?? window.innerHeight)) {
            element.setAttribute("data-reveal", "pending");
          }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: [0, THRESHOLD] },
      );
    });

    const showForPrint = () => {
      if (element.getAttribute("data-reveal") === "pending") element.setAttribute("data-reveal", "shown");
    };
    window.addEventListener("beforeprint", showForPrint);
    return () => {
      cancelled = true;
      stop();
      window.removeEventListener("beforeprint", showForPrint);
      // Never leave content hidden when the effect is torn down.
      if (element.getAttribute("data-reveal") === "pending") element.removeAttribute("data-reveal");
    };
  }, [once, stagger]);

  const vars = cssVars({
    "--kl-reveal-shift": distance ? `var(--kl-shift-${distance})` : undefined,
    "--kl-reveal-delay": typeof delay === "number" && delay > 0 ? `${Math.round(delay)}ms` : undefined,
  });

  return React.createElement(
    as,
    {
      ...rest,
      ref: setRef,
      className: className ? `kl-reveal ${className}` : "kl-reveal",
      style: { ...vars, ...style },
      "data-reveal-stagger": stagger ? "" : undefined,
    },
    children,
  );
}
