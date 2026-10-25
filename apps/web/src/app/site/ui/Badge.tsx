import React from "react";

import { cx } from "./styles";

export type BadgeTone = "neutral" | "blue" | "yellow" | "green" | "purple" | "red" | "ink" | "outline";

/**
 * Colour tones for networks, methods and printed art. A resource's state
 * (active, pending, unverified...) uses `StatusPill` and `statusTones`
 * instead, so one state never wears two colours.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-[#E6E2D9] text-[#121212] dark:bg-[#232327] dark:text-[#D6D2C8]",
  blue: "bg-[#2F5BFF] text-white",
  yellow: "bg-[#C6FF3A] text-[#121212]",
  // Status green (the departure board lamp), not a network colour.
  green: "bg-[#4ADE80] text-[#0E0E10]",
  purple: "bg-[#6D28D9] text-white",
  red: "bg-[#FF5A5F] text-[#121212]",
  ink: "bg-[#121212] text-white dark:bg-white dark:text-[#0E0E10]",
  outline: "bg-transparent text-[#121212] dark:text-[#D6D2C8]",
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
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap border-2 border-[#121212] px-2 py-0.5 text-label uppercase leading-5 dark:border-[#4A4A52]",
        TONES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 border-[1.5px] border-[#121212] dark:border-[#0E0E10]"
          style={{ backgroundColor: dot }}
        />
      ) : null}
      <span data-badge-label="" className="truncate">
        {children}
      </span>
    </span>
  );
}
