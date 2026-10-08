import React from "react";

import { cx, HARD_SHADOW, INK_BORDER, SURFACE } from "./styles";

export type CardTone = "surface" | "muted" | "yellow" | "blue" | "ink" | "solana";

const TONES: Record<CardTone, string> = {
  surface: SURFACE,
  muted: "bg-[#FBFAF7] dark:bg-[#0F1A2C]",
  yellow: "bg-[#FFD60A] text-[#1A1A1A]",
  blue: "bg-[#0052FF] text-white",
  ink: "bg-[#111318] text-white dark:bg-[#060A14]",
  solana: "bg-[#14F195] text-[#0B1120]",
};

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: "div" | "article" | "li" | "section" | "aside" | "figure";
  readonly tone?: CardTone;
  /** Lift on hover (for cards that contain a primary link). */
  readonly interactive?: boolean;
  readonly padded?: boolean;
}

/** Bordered surface with a hard offset shadow. */
export function Card({
  as: Element = "div",
  tone = "surface",
  interactive = false,
  padded = true,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Element
      className={cx(
        "relative",
        INK_BORDER,
        HARD_SHADOW,
        TONES[tone],
        padded && "p-5 sm:p-6",
        interactive &&
          "transition-[transform,box-shadow] duration-150 ease-out hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[8px_8px_0_#1A1A1A] focus-within:-translate-x-1 focus-within:-translate-y-1 focus-within:shadow-[8px_8px_0_#1A1A1A] dark:hover:shadow-[8px_8px_0_#475569] dark:focus-within:shadow-[8px_8px_0_#475569] motion-reduce:transition-none motion-reduce:hover:translate-x-0 motion-reduce:hover:translate-y-0",
        className,
      )}
      {...rest}
    >
      {children}
    </Element>
  );
}
