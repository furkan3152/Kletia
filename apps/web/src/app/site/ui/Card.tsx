import "./ui.css";

import React from "react";

import { useSpotlight } from "../motion/useSpotlight";
import { cx, LIFT, SPOTLIGHT, SURFACE } from "./styles";

export type CardTone = "surface" | "muted" | "yellow" | "blue" | "ink" | "solana";

const TONES: Record<CardTone, string> = {
  surface: SURFACE,
  muted: "bg-[#FBFAF6] dark:bg-[#151517]",
  yellow: "bg-[#C6FF3A] text-[#121212]",
  blue: "bg-[#2F5BFF] text-white",
  ink: "bg-[#111318] text-white dark:bg-[#060A14]",
  solana: "bg-[#14F195] text-[#0E0E10]",
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

/** A raised module (Card machine): hairline, radius 16, the object shadow. */
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
  const {
    ref: spotRef,
    handlers: spotHandlers,
    style: spotStyle,
  } = useSpotlight<HTMLElement>({ color: spotlightColor ?? SPOT_COLORS[tone] });
  const classes = cx(
    "relative ku-card",
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
      ref={spotRef}
      {...rest}
      onPointerEnter={(event: React.PointerEvent<HTMLElement>) => {
        onPointerEnter?.(event);
        spotHandlers.onPointerEnter(event);
      }}
      onPointerMove={(event: React.PointerEvent<HTMLElement>) => {
        onPointerMove?.(event);
        spotHandlers.onPointerMove(event);
      }}
      onPointerLeave={(event: React.PointerEvent<HTMLElement>) => {
        onPointerLeave?.(event);
        spotHandlers.onPointerLeave(event);
      }}
      className={classes}
      style={{ ...spotStyle, ...style }}
    >
      {children}
    </Element>
  );
}
