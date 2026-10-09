import type { CSSProperties } from "react";

import { categoryColor, monogramFor } from "./monogramStyle";
import { cx } from "./styles";

export type MonogramSize = "sm" | "md" | "lg";

const SIZES: Record<MonogramSize, string> = {
  sm: "h-9 w-9 text-[13px]",
  md: "h-12 w-12 text-base",
  lg: "h-16 w-16 text-xl",
};

/** The version tag hangs off the bottom-right corner so it never covers the letters. */
const TAG_SIZES: Record<MonogramSize, string> = {
  sm: "-bottom-[7px] -right-[7px] text-[9px] leading-[10px]",
  md: "-bottom-2 -right-2 text-[10px] leading-[12px]",
  lg: "-bottom-2 -right-2 text-[11px] leading-[13px]",
};

export interface MonogramProps {
  /** Protocol name, e.g. "Uniswap V3" (renders "UN" with a "v3" tag). */
  readonly name: string;
  /** Protocol category id; picks the tile colour (unknown → slate). */
  readonly category: string;
  readonly size?: MonogramSize;
  readonly className?: string;
}

/**
 * Protocol identity tile: initials on the category colour, with an optional
 * version tag. Decorative (`aria-hidden`): always render the protocol name
 * as text next to it. Helpers live in `./monogramStyle`.
 */
export function Monogram({ name, category, size = "md", className }: MonogramProps) {
  const { letters, version } = monogramFor(name);
  const color = categoryColor(category);
  return (
    <span
      aria-hidden="true"
      className={cx(
        "relative inline-flex shrink-0 select-none items-center justify-center border-[3px] border-[#1A1A1A] font-display font-bold uppercase leading-none tracking-[-0.02em] shadow-hard-sm dark:border-[#4B5563]",
        "bg-[var(--kl-mono-bg)] text-[var(--kl-mono-fg)] dark:bg-[var(--kl-mono-bg-dark)] dark:text-[var(--kl-mono-fg-dark)]",
        SIZES[size],
        className,
      )}
      style={
        {
          "--kl-mono-bg": color.bg,
          "--kl-mono-fg": color.fg,
          "--kl-mono-bg-dark": color.darkBg ?? color.bg,
          "--kl-mono-fg-dark": color.darkFg ?? color.fg,
        } as CSSProperties
      }
    >
      {letters}
      {version ? (
        <span
          className={cx(
            "absolute border-2 border-[#1A1A1A] bg-[#1A1A1A] px-0.5 font-code font-bold lowercase tracking-normal text-white dark:border-[#4B5563] dark:bg-[#0B1120]",
            TAG_SIZES[size],
          )}
        >
          {version}
        </span>
      ) : null}
    </span>
  );
}
