import React from "react";

import { useSpotlight } from "../motion/useSpotlight";
import { cx, HARD_SHADOW, INK_BORDER, LIFT, SPOTLIGHT, SURFACE } from "./styles";

export type CardTone = "surface" | "muted" | "yellow" | "blue" | "ink" | "solana";

const TONES: Record<CardTone, string> = {
  surface: SURFACE,
  muted: "bg-[#FBFAF7] dark:bg-[#0F1A2C]",
  yellow: "bg-[#FFD60A] text-[#1A1A1A]",
  blue: "bg-[#0052FF] text-white",
  ink: "bg-[#111318] text-white dark:bg-[#060A14]",
  solana: "bg-[#14F195] text-[#0B1120]",
};

/** Spotlight colour per tone (ink on yellow so the light reads). */
const SPOT_COLORS: Record<CardTone, string> = {
  surface: "#0052FF",
  muted: "#0052FF",
  yellow: "#1A1A1A",
  blue: "#FFD60A",
  ink: "#FFD60A",
  solana: "#0052FF",
};

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  readonly as?: "div" | "article" | "li" | "section" | "aside" | "figure";
  readonly tone?: CardTone;
  /** Lift on hover and keyboard focus (for cards that contain a primary link). */
  readonly interactive?: boolean;
  /** Cursor spotlight on hover (pointer devices, motion allowed). */
  readonly spotlight?: boolean;
  /** Spotlight colour (default by tone). */
  readonly spotlightColor?: string;
  readonly padded?: boolean;
}

/** Bordered surface with a hard offset shadow. */
export function Card({
  as: Element = "div",
  tone = "surface",
  interactive = false,
  spotlight = false,
  spotlightColor,
  padded = true,
  className,
  style,
  children,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
  ...rest
}: CardProps) {
  const spot = useSpotlight<HTMLElement>({ color: spotlightColor ?? SPOT_COLORS[tone] });
  const classes = cx(
    "relative",
    INK_BORDER,
    HARD_SHADOW,
    TONES[tone],
    padded && "p-5 sm:p-6",
    interactive && LIFT,
    spotlight && SPOTLIGHT,
    className,
  );
  if (!spotlight) {
    return (
      <Element
        className={classes}
        style={style}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        {...rest}
      >
        {children}
      </Element>
    );
  }
  return (
    <Element
      ref={spot.ref}
      {...rest}
      onPointerEnter={(event: React.PointerEvent<HTMLElement>) => {
        onPointerEnter?.(event);
        spot.handlers.onPointerEnter(event);
      }}
      onPointerMove={(event: React.PointerEvent<HTMLElement>) => {
        onPointerMove?.(event);
        spot.handlers.onPointerMove(event);
      }}
      onPointerLeave={(event: React.PointerEvent<HTMLElement>) => {
        onPointerLeave?.(event);
        spot.handlers.onPointerLeave(event);
      }}
      className={classes}
      style={{ ...spot.style, ...style }}
    >
      {children}
    </Element>
  );
}
