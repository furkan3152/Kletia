import { Pause, Play } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { cx, FOCUS_RING } from "../ui/styles";
import { useAutoPause } from "./useAutoPause";
import { useReducedMotion } from "./useReducedMotion";

export interface MarqueeProps {
  /** Accessible name of the band, e.g. "Protocols in the Kletia registry". */
  readonly label: string;
  /** Scroll speed in px per second (default 40). */
  readonly speed?: number;
  /** Space between items in px (also used between copies, default 12). */
  readonly gap?: number;
  /** Accessible name of the pause toggle (default "Pause ticker"; `aria-pressed` carries the state). */
  readonly pauseLabel?: string;
  /** Classes for the band (background, borders, padding). */
  readonly className?: string;
  /** Classes for each item list (vertical padding, alignment). */
  readonly listClassName?: string;
  /** `<li>` items, usually `MarqueeChip`s. Keep them non-interactive (no links or buttons). */
  readonly children: React.ReactNode;
}

const setInert = (node: HTMLElement | null) => node?.setAttribute("inert", "");

/**
 * Infinite ticker band with a visible Pause/Play toggle (WCAG 2.2.2).
 *
 * One real `<ul>` is read by screen readers; the copies that make the loop
 * seamless are `aria-hidden` and `inert`. The loop is a CSS transform whose
 * duration follows the measured width, and it pauses on hover, keyboard
 * focus, off-screen, in a hidden tab and when the toggle is pressed. With
 * reduced motion there is no loop, no copy and no toggle: the list wraps,
 * centred.
 *
 * Items move, so they must not be the only way to a destination: put a static
 * link (e.g. "Browse all 24 protocols →") next to the band.
 */
export function Marquee({
  label,
  speed = 40,
  gap = 12,
  pauseLabel = "Pause ticker",
  className,
  listClassName,
  children,
}: MarqueeProps) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const { ref: pauseRef } = useAutoPause<HTMLElement>({ paused });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [copies, setCopies] = useState(2);

  const measure = useCallback(() => {
    const list = listRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!list || !viewport || !track) return;
    const listWidth = list.offsetWidth;
    if (listWidth <= 0) return;
    const needed = Math.max(2, Math.ceil(viewport.clientWidth / listWidth) + 1);
    track.style.setProperty("--kl-mq-duration", `${(listWidth / Math.max(1, speed)).toFixed(2)}s`);
    track.style.setProperty("--kl-mq-shift", `${(-100 / needed).toFixed(4)}%`);
    setCopies(needed);
  }, [speed]);

  useEffect(() => {
    if (reduced) return undefined;
    const list = listRef.current;
    const viewport = viewportRef.current;
    if (!list || !viewport || typeof ResizeObserver === "undefined") return undefined;
    // The first callback arrives before the next paint with the initial sizes.
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [measure, reduced]);

  const listStyle: React.CSSProperties = { columnGap: gap, paddingRight: gap };

  if (reduced) {
    return (
      <section aria-label={label} className={cx("kl-mq", className)}>
        <ul
          className={cx("flex flex-wrap items-center justify-center px-4", listClassName)}
          style={{ columnGap: gap, rowGap: gap }}
        >
          {children}
        </ul>
      </section>
    );
  }

  return (
    <section ref={pauseRef} aria-label={label} className={cx("kl-mq relative flex items-center", className)}>
      <div ref={viewportRef} className="relative min-w-0 flex-1 overflow-hidden">
        <div ref={trackRef} className="kl-mq-track kl-loop flex w-max">
          <ul ref={listRef} className={cx("flex shrink-0 items-center", listClassName)} style={listStyle}>
            {children}
          </ul>
          {Array.from({ length: copies - 1 }, (_, index) => (
            <ul
              key={index}
              ref={setInert}
              aria-hidden="true"
              className={cx("flex shrink-0 items-center", listClassName)}
              style={listStyle}
            >
              {children}
            </ul>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center px-2 sm:px-3">
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => setPaused((value) => !value)}
          title={paused ? "Play ticker" : "Pause ticker"}
          className={cx(
            "inline-flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-hard-sm transition-[transform,box-shadow] duration-90 ease-kl-snap active:translate-x-[3px] active:translate-y-[3px] active:shadow-none sm:h-9 sm:w-9 dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white",
            FOCUS_RING,
          )}
        >
          {paused ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
          <span className="sr-only">{pauseLabel}</span>
        </button>
      </div>
    </section>
  );
}

export interface MarqueeChipProps {
  readonly className?: string;
  readonly children: React.ReactNode;
}

/** Default ticker item: an ink-bordered label chip. */
export function MarqueeChip({ className, children }: MarqueeChipProps) {
  return (
    <li
      className={cx(
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-2 border-[#1A1A1A] bg-white px-3 py-1.5 font-display text-sm font-bold uppercase tracking-wide text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-[#E2E8F0]",
        className,
      )}
    >
      {children}
    </li>
  );
}
