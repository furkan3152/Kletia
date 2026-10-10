import "../../site/art/base.css";
import "../../site/art/stamp.css";
import "./approve.css";

import type { CSSProperties } from "react";

import { useInView } from "../../site/motion/useInView";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { cx } from "../../site/ui/styles";

/*
 * Gate dies. APPROVED is a double-ring oval with a tick, REJECTED a struck
 * rectangle: different shapes, so the decision reads before the colour does
 * (the art rule). They print with the shared #kla-ink filter and are
 * decorative; the page always says the decision in text next to them.
 */

interface DieProps {
  /** Press the die once when it scrolls into view (never with reduced motion). */
  readonly animate?: boolean;
  readonly detail?: string;
  readonly className?: string;
}

function usePress(die: "approved" | "rejected", animate: boolean, className: string | undefined) {
  const reduced = useReducedMotion();
  const motion = animate && !reduced;
  const [ref, inView] = useInView<SVGSVGElement>({ once: true, threshold: 0.35 });
  return {
    ref: motion ? ref : undefined,
    className: cx("kla-stamp", "kl-adie", `kl-adie--${die}`, motion && "kla-stamp--armed", motion && inView && "kla-stamp--go", className),
    style: undefined as CSSProperties | undefined,
    focusable: "false" as const,
    "aria-hidden": true as const,
  };
}

/** APPROVED: a double-ring oval with a tick. */
export function ApprovedStamp({ animate = false, detail, className }: DieProps) {
  return (
    <svg viewBox="0 0 200 104" {...usePress("approved", animate, className)}>
      <g filter="url(#kla-ink)">
        <ellipse cx={100} cy={52} rx={95} ry={47} fill="none" stroke="currentColor" strokeWidth={4} />
        <ellipse cx={100} cy={52} rx={86} ry={39} fill="none" stroke="currentColor" strokeWidth={1.5} />
        <path d="M30 50l9 9 17-19" fill="none" stroke="currentColor" strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <text x={112} y={58} textAnchor="middle" className="kla-stamp__word kl-adie__word">
          APPROVED
        </text>
        <text x={112} y={76} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
          {(detail ?? "AT THE GATE").toUpperCase()}
        </text>
      </g>
    </svg>
  );
}

/** REJECTED: a rectangle struck through corner to corner. */
export function RejectedStamp({ animate = false, detail, className }: DieProps) {
  return (
    <svg viewBox="0 0 200 92" {...usePress("rejected", animate, className)}>
      <g filter="url(#kla-ink)">
        <rect x={4} y={4} width={192} height={84} fill="none" stroke="currentColor" strokeWidth={4} />
        <path d="M10 82L190 10" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
        <text x={100} y={56} textAnchor="middle" className="kla-stamp__word kl-adie__word kl-adie__word--rejected">
          REJECTED
        </text>
        <text x={100} y={77} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
          {(detail ?? "INTENT CANCELLED").toUpperCase()}
        </text>
      </g>
    </svg>
  );
}
