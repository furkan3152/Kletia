import { useEffect, useRef, useState } from "react";

import { decimalsOf, DURATION, easeOutExpo, lerp, roundLike } from "./tokens";
import { useInView } from "./useInView";
import { useReducedMotion } from "./useReducedMotion";

export interface AnimatedNumberProps {
  /** Final value. null/undefined/non-finite renders `fallback`. */
  readonly value: number | null | undefined;
  /** Formats the displayed number (default: en-US grouping, the value's own decimals). */
  readonly format?: (value: number) => string;
  /** First count-up duration in ms (default 900). Later changes tween over 300 ms. */
  readonly duration?: number;
  /** Start value of the first count-up (default 0). */
  readonly from?: number;
  /** Wait until the number is scrolled into view (default true). */
  readonly startOnView?: boolean;
  readonly fallback?: string;
  readonly className?: string;
}

const UPDATE_DURATION = 300;
const formatters = new Map<number, Intl.NumberFormat>();

function defaultFormat(value: number): string {
  const decimals = decimalsOf(value);
  let formatter = formatters.get(decimals);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals });
    formatters.set(decimals, formatter);
  }
  return formatter.format(value);
}

/**
 * Count-up number for live, derivable figures (latency, counts). The digits
 * that move are `aria-hidden`; screen readers read the final formatted value
 * from an sr-only copy, and a `min-width` in `ch` keeps the layout steady.
 * Reduced motion shows the final value immediately.
 *
 * Never use it for amounts, fees, minimum outputs or anything in a review or
 * signing context: those must render static and exact.
 */
export function AnimatedNumber({
  value,
  format = defaultFormat,
  duration = DURATION.count,
  from = 0,
  startOnView = true,
  fallback = "—",
  className,
}: AnimatedNumberProps) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLSpanElement>({ once: true, threshold: 0.2 });
  const ready = !startOnView || inView;
  const valid = typeof value === "number" && Number.isFinite(value);
  const target = valid ? value : 0;
  const [frame, setFrame] = useState<{ readonly value: number; readonly target: number } | null>(null);
  const shownRef = useRef(from);
  const ranRef = useRef(false);

  useEffect(() => {
    if (!valid || !ready) return undefined;
    if (reduced) {
      shownRef.current = target;
      ranRef.current = true;
      return undefined;
    }
    const start = shownRef.current;
    if (start === target) {
      ranRef.current = true;
      return undefined;
    }
    const total = ranRef.current ? UPDATE_DURATION : Math.max(0, duration);
    ranRef.current = true;
    let handle = 0;
    let startedAt: number | null = null;
    const tick = (now: number) => {
      if (startedAt === null) startedAt = now;
      const progress = total === 0 ? 1 : (now - startedAt) / total;
      const next = progress >= 1 ? target : lerp(start, target, easeOutExpo(progress));
      shownRef.current = next;
      setFrame({ value: next, target });
      if (progress < 1) handle = window.requestAnimationFrame(tick);
    };
    handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [valid, ready, reduced, target, duration]);

  if (!valid) {
    return <span className={className}>{fallback}</span>;
  }

  const finalText = format(target);
  let shown: number;
  if (reduced) shown = target;
  else if (frame && frame.target === target) shown = frame.value;
  else shown = frame ? frame.value : from;

  return (
    <span
      ref={ref}
      className={className ? `inline-block tabular-nums ${className}` : "inline-block tabular-nums"}
      style={{ minWidth: `${finalText.length}ch` }}
    >
      <span aria-hidden="true">{format(roundLike(shown, target))}</span>
      <span className="sr-only">{finalText}</span>
    </span>
  );
}
