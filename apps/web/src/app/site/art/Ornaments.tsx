import "./base.css";
import "./ornaments.css";

import { useId, type CSSProperties, type ReactNode } from "react";

import { cx } from "../ui/styles";
import { YELLOW, type Line } from "./tokens";

/*
 * Ornaments: small print-shop and railway details that structure a page.
 * All decorative (aria-hidden) except PlatformNumber, whose label is real
 * text (the section eyebrow).
 */

export interface PlatformNumberProps {
  /** Section number, printed with two digits. */
  readonly n: number;
  /** The eyebrow text, read aloud. */
  readonly children: ReactNode;
  /** "ink" on dark (ink or blue) sections: the label turns yellow. */
  readonly tone?: "paper" | "ink";
  readonly className?: string;
}

/** Section marker: a yellow platform plate with the section number, then the eyebrow text. */
export function PlatformNumber({ n, children, tone = "paper", className }: PlatformNumberProps) {
  return (
    <p className={cx("kla-platform-no", `kla-platform-no--${tone}`, className)}>
      <span className="kla-platform-no__plate" aria-hidden="true">
        <span className="kla-platform-no__k">Platform</span>
        {String(n).padStart(2, "0")}
      </span>
      <span className="kla-platform-no__label">{children}</span>
    </p>
  );
}

export interface TrackDividerProps {
  /** A line running between the rails: only when the section is about that network. */
  readonly line?: Line;
  readonly className?: string;
}

/** Full-width railway divider: two rails on sleepers, optionally carrying one network's colour. */
export function TrackDivider({ line, className }: TrackDividerProps) {
  return (
    <div
      aria-hidden="true"
      className={cx("kla-track", className)}
      style={line ? ({ "--kla-track-line": line.color } as CSSProperties) : undefined}
    />
  );
}

/** Ticket tear line: a row of punched dots. */
export function Perforation({ className }: { readonly className?: string }) {
  return <div aria-hidden="true" className={cx("kla-perf", className)} />;
}

export interface CropMarksProps {
  /** Registration target above the top edge (default true). */
  readonly target?: boolean;
  /** Process colour bar above the top-left corner, outside the trim (default false). */
  readonly colorBar?: boolean;
}

/* Printer's process inks (cyan, magenta, yellow, key) and the two spot inks of the house: Kletia yellow and action blue. */
const COLOR_BAR = ["#00AEEF", "#EC008C", "#FFF200", "#1A1A1A", "#FFD60A", "#0052FF"] as const;

/**
 * Printer's crop marks just outside the four corners of the positioned
 * parent, plus a registration target and an optional colour bar. The parent
 * needs `position: relative` and room around it (about 24 px) for the marks.
 */
export function CropMarks({ target = true, colorBar = false }: CropMarksProps) {
  return (
    <span aria-hidden="true" className="kla-crop">
      <span className="kla-crop__m kla-crop__m--tl" />
      <span className="kla-crop__m kla-crop__m--tr" />
      <span className="kla-crop__m kla-crop__m--bl" />
      <span className="kla-crop__m kla-crop__m--br" />
      {target ? (
        <svg viewBox="0 0 24 24" className="kla-crop__target" focusable="false">
          <circle cx={12} cy={12} r={6} fill="none" stroke="currentColor" strokeWidth={1.25} />
          <circle cx={12} cy={12} r={2.5} fill="currentColor" />
          <path d="M12 0V24M0 12H24" stroke="currentColor" strokeWidth={1.25} />
        </svg>
      ) : null}
      {colorBar ? (
        <span className="kla-crop__bar">
          {COLOR_BAR.map((color) => (
            <span key={color} style={{ background: color }} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** Halftone dots fading away from a section edge, in the current text colour. */
export function HalftoneEdge({ flip = false, className }: { readonly flip?: boolean; readonly className?: string }) {
  return <div aria-hidden="true" className={cx("kla-halftone-edge", flip && "kla-halftone-edge--flip", className)} />;
}

export interface LineRuleProps {
  /** The network this rule stands for. Without one it is the Kletia line, in signage yellow. */
  readonly line?: Line;
  readonly className?: string;
}

/**
 * A map line used as a section rule: ink casing, hard shadow, the line colour
 * and a station tick every 96 px (SVG patterns, so nothing stretches). SVM
 * lines carry the sleeper stripe of their gauge.
 */
export function LineRule({ line, className }: LineRuleProps) {
  const id = useId().replace(/:/g, "");
  const color = line?.color ?? YELLOW;
  const svm = line?.gauge === "svm";
  return (
    <svg aria-hidden="true" focusable="false" className={cx("kla-linerule", className)} preserveAspectRatio="none">
      <defs>
        <pattern id={`${id}-c`} width={96} height={34} patternUnits="userSpaceOnUse">
          <rect x={40} y={2} width={10} height={14} className="kla-linerule__ink" />
        </pattern>
        <pattern id={`${id}-t`} width={96} height={34} patternUnits="userSpaceOnUse">
          <rect x={42.5} y={4.5} width={5} height={12} fill={color} />
        </pattern>
        {svm ? (
          <pattern id={`${id}-s`} width={14} height={34} patternUnits="userSpaceOnUse">
            <rect x={0} y={20} width={8} height={4} className="kla-linerule__sleeper" />
          </pattern>
        ) : null}
      </defs>
      <rect x={4} y={18} width="100%" height={18} className="kla-linerule__shadow" />
      <rect x={0} y={13} width="100%" height={18} className="kla-linerule__ink" />
      <rect x={0} y={0} width="100%" height={34} fill={`url(#${id}-c)`} />
      <rect x={0} y={16} width="100%" height={12} fill={color} />
      <rect x={0} y={0} width="100%" height={34} fill={`url(#${id}-t)`} />
      {svm ? <rect x={0} y={0} width="100%" height={34} fill={`url(#${id}-s)`} /> : null}
    </svg>
  );
}
