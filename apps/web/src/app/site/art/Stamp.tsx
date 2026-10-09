import "./base.css";
import "./stamp.css";

import { useId, type CSSProperties } from "react";

import { useInView } from "../motion/useInView";
import { useReducedMotion } from "../motion/useReducedMotion";
import { cx } from "../ui/styles";
import { STAMP_LABELS, type StampState } from "./stampText";

/*
 * Rubber stamps for intent states. Each state is a different die, so the
 * state reads by shape before colour: a box for planned, a round seal for
 * signed, a cut-corner plate for settled, a bar for held and an octagon for
 * failed. The ink texture comes from the shared #kla-ink filter (PaperDefs);
 * without it the stamp prints clean.
 */

export interface StampProps {
  readonly state: StampState;
  /** Small print under the word: a date for signed, a block or slot for settled. Uppercased. */
  readonly detail?: string;
  /** Small print above the word on the signed seal, e.g. "Leg 1 of 2". Uppercased. */
  readonly caption?: string;
  /** Press the stamp down once when it scrolls into view (skipped with reduced motion). */
  readonly animate?: boolean;
  /** Delay before the press, for a row of stamps. */
  readonly delayMs?: number;
  /**
   * Give the stamp an accessible name (role="img"). By default it is
   * decorative and the surrounding ticket states the outcome in text.
   */
  readonly labelled?: boolean;
  readonly className?: string;
}

const DEFAULT_DETAIL: Partial<Record<StampState, string>> = {
  planned: "NOT SIGNED YET",
  held: "RECOVER BY HASH",
  failed: "NOT SETTLED",
};

export function Stamp({ state, detail, caption, animate = false, delayMs, labelled = false, className }: StampProps) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const motion = animate && !reduced;
  const [ref, inView] = useInView<SVGSVGElement>({ once: true, threshold: 0.35 });
  const small = (detail ?? DEFAULT_DETAIL[state] ?? "").toUpperCase();
  const label = small ? `${STAMP_LABELS[state]} (${small.toLowerCase()})` : STAMP_LABELS[state];
  const props = {
    ref: motion ? ref : undefined,
    className: cx("kla-stamp", `kla-stamp--${state}`, motion && "kla-stamp--armed", motion && inView && "kla-stamp--go", className),
    style: motion && delayMs ? ({ "--kla-stamp-delay": `${delayMs}ms` } as CSSProperties) : undefined,
    focusable: "false" as const,
    ...(labelled ? { role: "img", "aria-label": label } : { "aria-hidden": true as const }),
  };

  if (state === "signed") {
    const ring = `${id}-ring`;
    return (
      <svg viewBox="0 0 120 120" {...props}>
        <g filter="url(#kla-ink)">
          <circle cx={60} cy={60} r={55} fill="none" stroke="currentColor" strokeWidth={4} />
          <circle cx={60} cy={60} r={40} fill="none" stroke="currentColor" strokeWidth={1.75} />
          <path id={ring} d="M60 60m-46.5 0a46.5 46.5 0 1 1 93 0a46.5 46.5 0 1 1 -93 0" fill="none" />
          <text className="kla-stamp__ring">
            <textPath href={`#${ring}`} startOffset="0" textLength={286} lengthAdjust="spacing">
              SIGNED IN YOUR WALLET ✶ KLETIA HOLDS NO KEYS ✶
            </textPath>
          </text>
          <path d="M30 52H90M30 74H90" stroke="currentColor" strokeWidth={1.75} />
          <text x={60} y={69} textAnchor="middle" className="kla-stamp__word kla-stamp__word--sm">
            SIGNED
          </text>
          {small ? (
            <text x={60} y={86} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
              {small}
            </text>
          ) : null}
          {caption ? (
            <text x={60} y={46} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
              {caption.toUpperCase()}
            </text>
          ) : (
            <text x={60} y={46} textAnchor="middle" className="kla-stamp__small">
              ✶
            </text>
          )}
        </g>
      </svg>
    );
  }

  if (state === "settled") {
    return (
      <svg viewBox="0 0 170 92" {...props}>
        <g filter="url(#kla-ink)">
          <path d="M12 3H158L167 12V80L158 89H12L3 80V12Z" fill="none" stroke="currentColor" strokeWidth={4} />
          <path d="M14 10H156L160 14V78L156 82H14L10 78V14Z" fill="none" stroke="currentColor" strokeWidth={1.5} />
          <text x={85} y={27} textAnchor="middle" className="kla-stamp__small">
            EVIDENCE SEEN ON-CHAIN
          </text>
          <text x={85} y={small ? 52 : 58} textAnchor="middle" className="kla-stamp__word">
            SETTLED
          </text>
          {small ? (
            <text x={85} y={71} textAnchor="middle" className="kla-stamp__small">
              {small}
            </text>
          ) : null}
        </g>
      </svg>
    );
  }

  if (state === "held") {
    return (
      <svg viewBox="0 0 170 70" {...props}>
        <g filter="url(#kla-ink)">
          <rect x={3} y={3} width={164} height={64} fill="none" stroke="currentColor" strokeWidth={4} />
          <rect x={3} y={3} width={40} height={64} fill="currentColor" />
          <text x={23} y={45} textAnchor="middle" className="kla-stamp__bang">
            !
          </text>
          <text x={105} y={38} textAnchor="middle" className="kla-stamp__word kla-stamp__word--sm">
            HELD
          </text>
          <text x={105} y={56} textAnchor="middle" className="kla-stamp__small">
            {small}
          </text>
        </g>
      </svg>
    );
  }

  if (state === "failed") {
    return (
      <svg viewBox="0 0 124 124" {...props}>
        <g filter="url(#kla-ink)">
          <path d="M37 3H87L121 37V87L87 121H37L3 87V37Z" fill="none" stroke="currentColor" strokeWidth={4} />
          <path d="M40 11H84L113 40V84L84 113H40L11 84V40Z" fill="none" stroke="currentColor" strokeWidth={1.5} />
          <rect x={11} y={50} width={102} height={26} fill="currentColor" />
          <text x={62} y={70} textAnchor="middle" className="kla-stamp__word kla-stamp__word--sm kla-stamp__word--knock">
            FAILED
          </text>
          <text x={62} y={38} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
            ROUTE STOPPED
          </text>
          <text x={62} y={93} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
            {small}
          </text>
        </g>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 170 80" {...props}>
      <g filter="url(#kla-ink)">
        <rect x={3} y={3} width={164} height={74} fill="none" stroke="currentColor" strokeWidth={4} />
        <rect x={10} y={10} width={150} height={60} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="5 3" />
        <text x={85} y={45} textAnchor="middle" className="kla-stamp__word">
          PLANNED
        </text>
        <text x={85} y={61} textAnchor="middle" className="kla-stamp__small">
          {small}
        </text>
      </g>
    </svg>
  );
}
