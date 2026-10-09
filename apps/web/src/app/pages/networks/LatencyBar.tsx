import { useState } from "react";

import { useInView } from "../../site/motion/useInView";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { cx } from "../../site/ui/styles";
import { LATENCY_COLORS, latencyScale, latencyTone } from "./useHealthHistory";

export interface LatencyBarProps {
  /** Latest round trip in ms; null/undefined renders an empty track. */
  readonly ms: number | null | undefined;
  /** Real samples from this page session, oldest first (max 12). */
  readonly history?: readonly number[];
  readonly className?: string;
}

/**
 * Latency as a bar (log scale up to 2 s) plus a strip of the last 12 checks.
 * Purely visual (`aria-hidden`): the ms text next to it carries the value.
 * The fill grows in when first seen (700 ms) and eases on updates (240 ms).
 */
export function LatencyBar({ ms, history = [], className }: LatencyBarProps) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLSpanElement>({ once: true, threshold: 0.2 });
  const [grown, setGrown] = useState(false);
  const valid = typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
  const scale = valid && (inView || reduced) ? latencyScale(ms) : 0;
  const color = valid ? LATENCY_COLORS[latencyTone(ms)] : "transparent";
  const samples = history.slice(-12);

  return (
    <span ref={ref} aria-hidden="true" className={cx("flex min-w-0 items-center gap-2", className)}>
      <span className="relative block h-3 min-w-[3.5rem] flex-1 overflow-hidden border-2 border-[#1A1A1A] bg-[#F1EFE8] dark:border-[#4B5563] dark:bg-[#0B1120]">
        <span
          className={cx(
            "absolute inset-y-0 left-0 w-full origin-left",
            !reduced && (grown ? "transition-transform duration-240 ease-kl-out" : "transition-transform duration-700 ease-kl-out"),
          )}
          style={{ transform: `scaleX(${scale})`, backgroundColor: color }}
          onTransitionEnd={() => setGrown(true)}
        />
      </span>
      <span className="flex h-3 shrink-0 items-end gap-px" title={samples.length > 1 ? `Last ${samples.length} checks` : undefined}>
        {samples.map((sample, index) => (
          <span
            key={index}
            className="block w-1 border border-[#1A1A1A]/60 dark:border-white/30"
            style={{
              height: `${Math.max(2, Math.round(latencyScale(sample) * 12))}px`,
              backgroundColor: LATENCY_COLORS[latencyTone(sample)],
            }}
          />
        ))}
      </span>
    </span>
  );
}
