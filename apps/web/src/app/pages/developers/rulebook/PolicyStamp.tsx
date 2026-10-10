import "../../../site/art/base.css";
import "../../../site/art/stamp.css";
import "./rulebook.css";

import { useReducedMotion } from "../../../site/motion/useReducedMotion";
import { Stamp } from "../../../site/art/Stamp";
import { cx } from "../../../site/ui/styles";
import type { DeskOutcome } from "./policyModel";

export interface PolicyStampProps {
  readonly outcome: DeskOutcome;
  /** "Rule book ed. 3" on CLEARED; the first rule id on REFUSED. */
  readonly detail?: string;
  /** Press once on mount (never with reduced motion). */
  readonly press?: boolean;
  readonly className?: string;
}

function fit(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The inspection desk's die. CLEARED is a double-ring oval, HELD FOR APPROVAL
 * the held bar, REFUSED a struck rectangle: the shape tells the outcome
 * before the ink does. Decorative; the desk says the outcome in text.
 */
export function PolicyStamp({ outcome, detail, press = false, className }: PolicyStampProps) {
  const reduced = useReducedMotion();
  const animate = press && !reduced;
  if (outcome === "held") {
    return <Stamp state="held" detail={detail ? fit(detail, 22) : "For approval"} animate={press} className={className} />;
  }
  const small = (detail ?? (outcome === "cleared" ? "Rule book" : "")).toUpperCase();
  if (outcome === "cleared") {
    return (
      <svg viewBox="0 0 200 104" aria-hidden="true" focusable="false" className={cx("kla-stamp kl-rb-die kl-rb-die--cleared", animate && "kl-rb-die--press", className)}>
        <g filter="url(#kla-ink)">
          <ellipse cx={100} cy={52} rx={95} ry={47} fill="none" stroke="currentColor" strokeWidth={4} />
          <ellipse cx={100} cy={52} rx={86} ry={39} fill="none" stroke="currentColor" strokeWidth={1.5} />
          <text x={100} y={58} textAnchor="middle" className="kla-stamp__word">
            CLEARED
          </text>
          <text x={100} y={77} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
            {fit(small, 26)}
          </text>
          <text x={100} y={33} textAnchor="middle" className="kla-stamp__small">
            ✶ INSPECTED ✶
          </text>
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 200 92" aria-hidden="true" focusable="false" className={cx("kla-stamp kl-rb-die kl-rb-die--refused", animate && "kl-rb-die--press", className)} style={{ ["--kl-rb-rot" as string]: "5deg" }}>
      <g filter="url(#kla-ink)">
        <rect x={3} y={3} width={194} height={86} fill="none" stroke="currentColor" strokeWidth={4} />
        <rect x={10} y={10} width={180} height={72} fill="none" stroke="currentColor" strokeWidth={1.5} />
        <text x={100} y={50} textAnchor="middle" className="kla-stamp__word">
          REFUSED
        </text>
        <text x={100} y={70} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
          {fit(small, 30)}
        </text>
        <path d="M8 84L192 8" stroke="currentColor" strokeWidth={3.5} strokeLinecap="square" />
      </g>
    </svg>
  );
}
