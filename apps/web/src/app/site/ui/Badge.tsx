import React from "react";

import { cx } from "./styles";

export type BadgeTone = "neutral" | "blue" | "yellow" | "green" | "purple" | "red" | "ink" | "outline";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-[#F1EFE8] text-[#1A1A1A] dark:bg-[#1A2841] dark:text-[#E2E8F0]",
  blue: "bg-[#0052FF] text-white",
  yellow: "bg-[#FFD60A] text-[#1A1A1A]",
  green: "bg-[#14F195] text-[#0B1120]",
  purple: "bg-[#9945FF] text-white",
  red: "bg-[#FF5A5F] text-[#1A1A1A]",
  ink: "bg-[#1A1A1A] text-white dark:bg-white dark:text-[#0B1120]",
  outline: "bg-transparent text-[#1A1A1A] dark:text-[#E2E8F0]",
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  /** Optional colour swatch rendered before the label (e.g. a network colour). */
  readonly dot?: string;
  readonly className?: string;
  readonly title?: string;
  readonly children: React.ReactNode;
}

/** Small uppercase label chip. */
export function Badge({ tone = "neutral", dot, className, title, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap border-2 border-[#1A1A1A] px-2 py-0.5 text-[10px] font-black uppercase leading-5 tracking-[0.14em] dark:border-[#4B5563]",
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
      <span className="truncate">{children}</span>
    </span>
  );
}
