/**
 * Motion tokens for the Kletia site: mechanical, snappy and confident (paper
 * cards on a desk, never floaty). These mirror the `--kl-*` custom properties
 * in `src/app/styles.css` and the Tailwind additions in `tailwind.config.js`.
 *
 * Pure and Node-safe: no DOM access at import time.
 */
import type { CSSProperties } from "react";

/** Durations in milliseconds. */
export const DURATION = {
  /** Press, toggle. */
  instant: 90,
  /** Hover, colour, icon swap. */
  fast: 150,
  /** Enter/exit of UI (toast, banner, message). */
  base: 240,
  /** Scroll reveal, panel open. */
  slow: 420,
  /** Hero phases, line reveal. */
  slower: 700,
  /** AnimatedNumber count-up. */
  count: 900,
  /** Hero network map, celebration. */
  epic: 1200,
} as const;

/** Easing curves (CSS syntax, usable in WAAPI `easing` too). */
export const EASE = {
  /** Reveals, count-up, route in. */
  out: "cubic-bezier(0.16, 1, 0.3, 1)",
  /** General UI. */
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  /** Exits. */
  in: "cubic-bezier(0.4, 0, 1, 1)",
  /** Brutalist pop/stamp (overshoots). */
  snap: "cubic-bezier(0.2, 0.9, 0.3, 1.25)",
  linear: "linear",
} as const;

/** Travel distances in px. */
export const DISTANCE = { xs: 2, sm: 4, md: 8, lg: 16, xl: 24 } as const;

/** Stagger step per item; lists stop adding delay after `maxItems`. */
export const STAGGER = { step: 60, maxItems: 8 } as const;

/** Index-based delay, capped so long lists never wait more than 480 ms. */
export function staggerDelay(index: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), STAGGER.maxItems) * STAGGER.step;
}

/** Index to write into `--kl-i` (capped like `staggerDelay`). */
export function staggerIndex(index: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), STAGGER.maxItems);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? 1 : 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** easeOutExpo, used by JS tweens (AnimatedNumber). `t` is clamped to [0, 1]. */
export function easeOutExpo(t: number): number {
  const x = clamp01(t);
  return x >= 1 ? 1 : 1 - 2 ** (-10 * x);
}

/** Linear interpolation. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Decimal places of a number (max 3), e.g. 12 → 0, 0.25 → 2. */
export function decimalsOf(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return 0;
  const text = String(value);
  const dot = text.indexOf(".");
  if (dot < 0 || text.includes("e")) return 3;
  return Math.min(3, text.length - dot - 1);
}

/** Rounds an in-between tween value to the precision of its target (so 12 never shows as 11.73). */
export function roundLike(value: number, target: number): number {
  const factor = 10 ** decimalsOf(target);
  return Math.round(value * factor) / factor;
}

/**
 * Typed helper for CSS custom properties in `style` props:
 * `style={cssVars({ "--kl-i": 2, "--kl-delay": "140ms" })}`.
 */
export function cssVars(vars: Readonly<Record<`--${string}`, string | number | undefined>>): CSSProperties {
  const style: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) style[name] = value;
  }
  return style as CSSProperties;
}

/** Deterministic 0–12 ms jitter per typed character: feels human, replays identically. */
export function typingJitter(index: number): number {
  const x = Math.sin((index + 1) * 12.9898) * 43758.5453;
  return Math.floor((x - Math.floor(x)) * 13);
}

/** Small deterministic PRNG (mulberry32) so "random" motion is reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
