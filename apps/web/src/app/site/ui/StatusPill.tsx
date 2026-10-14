import React from "react";

import { cx } from "./styles";
import { TONE_GLYPHS, type StatusEntry, type StatusGlyph, type StatusTone } from "./statusTones";

export type { StatusTone } from "./statusTones";

const TONES: Readonly<Record<StatusTone, string>> = {
  neutral: "bg-neutral-bg text-neutral",
  info: "bg-info-bg text-info",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};

/** 10 px shapes drawn in the pill's own colour: the state never rests on colour alone. */
function Glyph({ glyph }: { readonly glyph: StatusGlyph }) {
  if (glyph === "none") return null;
  return (
    <svg viewBox="0 0 10 10" width={10} height={10} aria-hidden="true" focusable="false" className="shrink-0">
      {glyph === "dot" ? <circle cx="5" cy="5" r="4" fill="currentColor" /> : null}
      {glyph === "half" ? (
        <>
          <circle cx="5" cy="5" r="3.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 1.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" />
        </>
      ) : null}
      {glyph === "pause" ? <path d="M2 1.5h2v7H2zM6 1.5h2v7H6z" fill="currentColor" /> : null}
      {glyph === "cross" ? <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /> : null}
      {glyph === "warn" ? <path d="M5 1l4.5 8h-9z" fill="currentColor" /> : null}
      {glyph === "check" ? <path d="M1.5 5.5l2.5 2.5 4.5-5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" /> : null}
      {glyph === "ring" ? <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
    </svg>
  );
}

export interface StatusPillProps {
  readonly tone: StatusTone;
  readonly children: React.ReactNode;
  /** The tone's own shape by default (dot, half, warning triangle, cross, ring). */
  readonly glyph?: StatusGlyph;
  readonly title?: string;
  readonly className?: string;
}

/**
 * A resource's state as glyph plus word in a semantic tone: 12 px label, a 2 px
 * rule in the tone's text colour, never a stamp. Use `statusTones.toneFor` to
 * pick the tone, so a state always reads the same.
 */
export function StatusPill({ tone, children, glyph, title, className }: StatusPillProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap border-2 border-current px-2 py-0.5 text-label uppercase leading-5",
        TONES[tone],
        className,
      )}
    >
      <Glyph glyph={glyph ?? TONE_GLYPHS[tone]} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A `statusTones` entry as a pill (its own tone, glyph and label). */
export function StatusEntryPill({ entry, title, className }: { readonly entry: StatusEntry; readonly title?: string; readonly className?: string }) {
  return (
    <StatusPill tone={entry.tone} glyph={entry.glyph} title={title} className={className}>
      {entry.label}
    </StatusPill>
  );
}
