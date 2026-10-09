import React, { useCallback, useEffect, useMemo, useRef } from "react";

import { prefersReducedMotion } from "./useReducedMotion";

export interface SpotlightOptions {
  /** Max tilt in degrees (default 0 = none, clamped to 4). Only for large cards. */
  readonly tilt?: number;
  /** Spotlight colour (default Kletia blue). */
  readonly color?: string;
}

export interface Spotlight<T extends HTMLElement> {
  readonly ref: React.RefCallback<T>;
  readonly handlers: {
    readonly onPointerEnter: React.PointerEventHandler<T>;
    readonly onPointerMove: React.PointerEventHandler<T>;
    readonly onPointerLeave: React.PointerEventHandler<T>;
  };
  /** Carries `--kl-spot` (the colour); merge it into the element's style. */
  readonly style: React.CSSProperties;
}

const MAX_TILT = 4;

function finePointer(): boolean {
  try {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    return false;
  }
}

/**
 * Cursor spotlight (and optional tilt) for cards with `.kl-spotlight`
 * (usually with `.kl-lift` too). Mouse-like pointers only, and never with
 * reduced motion. The rect is read once on enter (and again only after a
 * scroll); moves only write two custom properties in one rAF.
 */
export function useSpotlight<T extends HTMLElement>(options: SpotlightOptions = {}): Spotlight<T> {
  const { color = "#0052FF" } = options;
  const tilt = Math.max(0, Math.min(MAX_TILT, options.tilt ?? 0));
  const elementRef = useRef<T | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef(0);
  const enabledRef = useRef(false);

  const ref = useCallback((node: T | null) => {
    elementRef.current = node;
  }, []);

  const invalidate = useCallback(() => {
    rectRef.current = null;
  }, []);

  const reset = useCallback(() => {
    const element = elementRef.current;
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    pointRef.current = null;
    rectRef.current = null;
    window.removeEventListener("scroll", invalidate, true);
    if (!element) return;
    element.style.removeProperty("--kl-mx");
    element.style.removeProperty("--kl-my");
    if (tilt > 0) element.style.removeProperty("transform");
  }, [invalidate, tilt]);

  useEffect(() => reset, [reset]);

  const handlers = useMemo(() => {
    const paint = () => {
      frameRef.current = 0;
      const element = elementRef.current;
      const point = pointRef.current;
      if (!element || !point || !enabledRef.current) return;
      const rect = rectRef.current ?? (rectRef.current = element.getBoundingClientRect());
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = point.x - rect.left;
      const y = point.y - rect.top;
      element.style.setProperty("--kl-mx", `${x.toFixed(1)}px`);
      element.style.setProperty("--kl-my", `${y.toFixed(1)}px`);
      if (tilt > 0) {
        const rotateY = ((x / rect.width - 0.5) * 2 * tilt).toFixed(2);
        const rotateX = (-(y / rect.height - 0.5) * 2 * tilt).toFixed(2);
        element.style.transform = `perspective(800px) translate3d(-2px, -2px, 0) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      }
    };
    return {
      onPointerEnter: (event: React.PointerEvent<T>) => {
        enabledRef.current = event.pointerType === "mouse" && finePointer() && !prefersReducedMotion();
        if (!enabledRef.current) return;
        rectRef.current = event.currentTarget.getBoundingClientRect();
        window.addEventListener("scroll", invalidate, { capture: true, passive: true });
      },
      onPointerMove: (event: React.PointerEvent<T>) => {
        if (!enabledRef.current) return;
        pointRef.current = { x: event.clientX, y: event.clientY };
        if (!frameRef.current) frameRef.current = window.requestAnimationFrame(paint);
      },
      onPointerLeave: () => {
        enabledRef.current = false;
        reset();
      },
    };
  }, [invalidate, reset, tilt]);

  const style = useMemo(() => ({ "--kl-spot": color }) as React.CSSProperties, [color]);

  return { ref, handlers, style };
}
