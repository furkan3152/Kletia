import React from "react";

import { cx } from "./styles";

export type SkeletonSurface = "paper" | "card";

const SURFACES: Record<SkeletonSurface, string> = {
  // On the beige page vs. on white cards; navy blocks in dark mode.
  paper: "bg-[#E7E2D6] dark:bg-[#1A2841]",
  card: "bg-[#EFEBE3] dark:bg-[#1A2841]",
};

export interface SkeletonProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: "div" | "span" | "li";
  /** What the block sits on (default "paper"). */
  readonly surface?: SkeletonSurface;
  /** Sweep highlight (default true; static with reduced motion). */
  readonly shimmer?: boolean;
}

/**
 * Wireframe placeholder block: a dashed ink outline at 25% with a shimmer
 * sweep. Size it with classes that match the final layout (no shift when the
 * real content swaps in). Purely visual: wrap groups in `SkeletonGroup`.
 */
export function Skeleton({ as: Element = "div", surface = "paper", shimmer = true, className, ...rest }: SkeletonProps) {
  return (
    <Element
      aria-hidden="true"
      className={cx(
        "block border-[3px] border-dashed border-[#1A1A1A]/25 dark:border-white/15",
        SURFACES[surface],
        shimmer && "kl-shimmer kl-loop",
        className,
      )}
      {...rest}
    />
  );
}

export interface SkeletonTextProps {
  /** Number of lines (default 3); the last one is shorter. */
  readonly lines?: number;
  readonly surface?: SkeletonSurface;
  readonly className?: string;
  /** Classes for each line (default height 0.75rem). */
  readonly lineClassName?: string;
}

const LINE_WIDTHS = ["100%", "94%", "86%", "97%", "90%"];

/** Placeholder paragraph with deterministic line widths. */
export function SkeletonText({ lines = 3, surface = "paper", className, lineClassName = "h-3" }: SkeletonTextProps) {
  const count = Math.max(1, Math.floor(lines));
  return (
    <div aria-hidden="true" className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          surface={surface}
          className={cx("border-2", lineClassName)}
          style={{ width: index === count - 1 && count > 1 ? "62%" : LINE_WIDTHS[index % LINE_WIDTHS.length] }}
        />
      ))}
    </div>
  );
}

export interface SkeletonGroupProps {
  /** Announced once to screen readers, e.g. "Planning intent". */
  readonly label: string;
  /** Layout classes for the (aria-hidden) placeholder container, e.g. "grid gap-5 md:grid-cols-2". */
  readonly className?: string;
  /** Classes for the outer `role="status"` element (margins, width). */
  readonly wrapperClassName?: string;
  readonly children: React.ReactNode;
}

/** `role="status"` wrapper: an sr-only label is read, the placeholder markup is hidden. */
export function SkeletonGroup({ label, className, wrapperClassName, children }: SkeletonGroupProps) {
  return (
    <div role="status" aria-busy="true" className={wrapperClassName}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className={className}>
        {children}
      </div>
    </div>
  );
}
