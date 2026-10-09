import React from "react";

import { AnimatedNumber } from "../motion/AnimatedNumber";
import { cx, LABEL } from "./styles";

export interface StatProps {
  /** Static figure. Ignored when `animateTo` is set. */
  readonly value?: React.ReactNode;
  readonly label: React.ReactNode;
  readonly note?: React.ReactNode;
  readonly accent?: string;
  readonly className?: string;
  /** Count up to this number when it scrolls into view (live, derivable counts only — never money). */
  readonly animateTo?: number | null;
  /** Formats the animated number (e.g. `(n) => `${Math.round(n)} ms``). */
  readonly format?: (value: number) => string;
}

/** A large figure with a label. Only use values derivable from code or registries. */
export function Stat({ value, label, note, accent = "#0052FF", className, animateTo, format }: StatProps) {
  return (
    <div className={cx("flex flex-col gap-2 border-l-[6px] pl-4", className)} style={{ borderColor: accent }}>
      <dt className={cx(LABEL, "order-2 text-[#45464B] dark:text-[#A9B6C8]")}>{label}</dt>
      <dd className="order-1 font-display text-4xl font-bold leading-none tracking-[-0.04em] sm:text-5xl">
        {animateTo !== undefined ? <AnimatedNumber value={animateTo} format={format} /> : value}
      </dd>
      {note ? <dd className="order-3 text-sm text-[#45464B] dark:text-[#A9B6C8]">{note}</dd> : null}
    </div>
  );
}
