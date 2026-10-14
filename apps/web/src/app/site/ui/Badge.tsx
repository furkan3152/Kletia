import React from "react";

import { cx } from "./styles";

export type BadgeTone = "neutral" | "blue" | "yellow" | "green" | "purple" | "red" | "ink" | "outline";

/**
 * Colour tones for networks, methods and printed art. A resource's state
 * (active, pending, unverified...) uses `StatusPill` and `statusTones`
 * instead, so one state never wears two colours.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-[#F1EFE8] text-[#1A1A1A] dark:bg-[#1A2841] dark:text-[#E2E8F0]",
  blue: "bg-[#0052FF] text-white",
  yellow: "bg-[#FFD60A] text-[#1A1A1A]",
  // Status green (the departure board lamp), not a network colour.
  green: "bg-[#4ADE80] text-[#0B1120]",
  purple: "bg-[#6D28D9] text-white",
  red: "bg-[#FF5A5F] text-[#1A1A1A]",
  ink: "bg-[#1A1A1A] text-white dark:bg-white dark:text-[#0B1120]",
  outline: "bg-transparent text-[#1A1A1A] dark:text-[#E2E8F0]",
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  /** Optional colour swatch rendered before the label (e.g. a network colour). */
  readonly dot?: string;
  readonly className?: string;
  /** Tooltip; without one, a label cut short by the badge's width shows its full text on hover. */
  readonly title?: string;
  readonly children: React.ReactNode;
}

/** Shows the whole label as a tooltip only when the badge had to cut it short. */
function titleWhenTruncated(event: React.SyntheticEvent<HTMLSpanElement>) {
  const badge = event.currentTarget;
  const label = badge.querySelector<HTMLElement>("[data-badge-label]");
  if (!label) return;
  if (label.scrollWidth > label.clientWidth + 1) badge.setAttribute("title", label.textContent?.trim() ?? "");
  else badge.removeAttribute("title");
}

/** Small uppercase label chip: 12 px, 0.08em (the type floor). */
export function Badge({ tone = "neutral", dot, className, title, children }: BadgeProps) {
  return (
    <span
      title={title}
      onMouseEnter={title === undefined ? titleWhenTruncated : undefined}
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap border-2 border-[#1A1A1A] px-2 py-0.5 text-label uppercase leading-5 dark:border-[#4B5563]",
        TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 border-[1.5px] border-[#1A1A1A] dark:border-[#0B1120]"
          style={{ backgroundColor: dot }}
        />
      ) : null}
      <span data-badge-label="" className="truncate">
        {children}
      </span>
    </span>
  );
}
