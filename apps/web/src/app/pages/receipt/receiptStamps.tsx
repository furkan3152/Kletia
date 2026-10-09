import "../../site/art/base.css";
import "../../site/art/stamp.css";
import "./receipt.css";

import { useId, type CSSProperties } from "react";

import { useInView } from "../../site/motion/useInView";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { cx } from "../../site/ui/styles";

/*
 * Receipt dies. Each one has its own shape, so the state reads by shape
 * before colour (the art rule): a notched notary seal for VERIFIED, a wide
 * cancel bar for VOID, a wax seal for SEALED, a postmark with wavy cancel
 * lines for LOGGED and a date box for RECHECKED. They print with the shared
 * #kla-ink filter (PaperDefs) and are decorative: the page always says the
 * same thing in text next to them.
 */

export type ReceiptDie = "verified" | "void" | "sealed" | "logged" | "rechecked";

interface DieProps {
  /** Press the die once when it scrolls into view (never with reduced motion). */
  readonly animate?: boolean;
  readonly delayMs?: number;
  readonly className?: string;
}

function usePress(die: ReceiptDie, { animate = false, delayMs, className }: DieProps) {
  const reduced = useReducedMotion();
  const motion = animate && !reduced;
  const [ref, inView] = useInView<SVGSVGElement>({ once: true, threshold: 0.35 });
  return {
    ref: motion ? ref : undefined,
    className: cx("kla-stamp", "kl-rdie", `kl-rdie--${die}`, motion && "kla-stamp--armed", motion && inView && "kla-stamp--go", className),
    style: motion && delayMs ? ({ "--kla-stamp-delay": `${delayMs}ms` } as CSSProperties) : undefined,
    focusable: "false" as const,
    "aria-hidden": true as const,
  };
}

/* A notary edge: 40 teeth between two radii around (cx, cy). */
function toothedRing(cx: number, cy: number, outer: number, inner: number, teeth = 40): string {
  const points: string[] = [];
  for (let index = 0; index < teeth * 2; index += 1) {
    const angle = (index / (teeth * 2)) * Math.PI * 2;
    const radius = index % 2 === 0 ? outer : inner;
    points.push(`${index ? "L" : "M"}${(cx + Math.cos(angle) * radius).toFixed(2)} ${(cy + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `${points.join("")}Z`;
}

const VERIFIED_EDGE = toothedRing(64, 64, 61, 57);

/** VERIFIED: a round notary seal, "SIGNED BY KLETIA ✶ CHECK IT YOURSELF ✶" around the rim. */
export function VerifiedStamp({ detail, ...props }: DieProps & { readonly detail?: string }) {
  const ring = `${useId().replace(/:/g, "")}-ring`;
  return (
    <svg viewBox="0 0 128 128" {...usePress("verified", props)}>
      <g filter="url(#kla-ink)">
        <path d={VERIFIED_EDGE} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
        <circle cx={64} cy={64} r={52.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
        <path id={ring} d="M64 64m-43.5 0a43.5 43.5 0 1 1 87 0a43.5 43.5 0 1 1 -87 0" fill="none" />
        <text className="kla-stamp__ring">
          <textPath href={`#${ring}`} startOffset="0" textLength={270} lengthAdjust="spacing">
            SIGNED BY KLETIA ✶ CHECK IT YOURSELF ✶
          </textPath>
        </text>
        <circle cx={64} cy={64} r={37} fill="none" stroke="currentColor" strokeWidth={1.75} />
        <path d="M31 55H97M31 77H97" stroke="currentColor" strokeWidth={1.5} />
        <text x={64} y={71.5} textAnchor="middle" className="kla-stamp__word kl-rdie__word--verified">
          VERIFIED
        </text>
        <text x={64} y={50} textAnchor="middle" className="kla-stamp__small">
          ✶
        </text>
        {detail ? (
          <text x={64} y={89} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
            {detail.toUpperCase()}
          </text>
        ) : null}
      </g>
    </svg>
  );
}

/** VOID: a wide cancel bar with the word knocked out of the ink. */
export function VoidStamp({ detail, ...props }: DieProps & { readonly detail: string }) {
  return (
    <svg viewBox="0 0 200 80" {...usePress("void", props)}>
      <g filter="url(#kla-ink)">
        <rect x={3} y={3} width={194} height={74} fill="none" stroke="currentColor" strokeWidth={4} />
        <rect x={3} y={3} width={194} height={44} fill="currentColor" />
        <text x={100} y={37} textAnchor="middle" className="kla-stamp__word kla-stamp__word--knock kl-rdie__word--void">
          VOID
        </text>
        <text x={100} y={65} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
          {detail.toUpperCase()}
        </text>
      </g>
    </svg>
  );
}

/* Wax: a round blob with soft lobes and three notches, like a seal pressed by hand. */
const WAX_EDGE = (() => {
  const points: string[] = [];
  const steps = 72;
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    const lobe = Math.sin(angle * 9) * 1.6 + Math.sin(angle * 4 + 1) * 1.1;
    const notch = [0.6, 2.7, 4.6].some((at) => Math.abs(((angle - at + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.09) ? -5 : 0;
    const radius = 48 + lobe + notch;
    points.push(`${index ? "L" : "M"}${(55 + Math.cos(angle) * radius).toFixed(2)} ${(55 + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `${points.join("")}Z`;
})();

/** SEALED: a wax seal. `small` drops the words (inline marks next to a sealed detail). */
export function SealedStamp({ small = false, ...props }: DieProps & { readonly small?: boolean }) {
  return (
    <svg viewBox="0 0 110 110" {...usePress("sealed", props)} data-small={small || undefined}>
      <g filter="url(#kla-ink)">
        <path d={WAX_EDGE} fill="currentColor" />
        <circle cx={55} cy={55} r={34} fill="none" className="kl-rdie__knock-stroke" strokeWidth={2} />
        {small ? (
          <path d="M55 37l5.3 11.2 12.2 1.6-9 8.4 2.3 12.1L55 64.4l-10.8 5.9 2.3-12.1-9-8.4 12.2-1.6Z" className="kl-rdie__knock-fill" />
        ) : (
          <>
            <circle cx={55} cy={55} r={28} fill="none" className="kl-rdie__knock-stroke" strokeWidth={1} strokeDasharray="2 2.5" />
            <text x={55} y={60} textAnchor="middle" className="kla-stamp__word kla-stamp__word--knock kl-rdie__word--sealed">
              SEALED
            </text>
            <text x={55} y={75} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight kl-rdie__knock-fill">
              BY THE OWNER
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

/** LOGGED: a postmark with wavy cancel lines. */
export function LoggedStamp({ batch, anchored, ...props }: DieProps & { readonly batch: number; readonly anchored: boolean }) {
  const waves = [28, 41, 54, 67].map((y) => `M100 ${y}c8-6 16-6 24 0s16 6 24 0 16-6 24 0 16 6 24 0`);
  return (
    <svg viewBox="0 0 200 96" {...usePress("logged", props)}>
      <g filter="url(#kla-ink)">
        <circle cx={48} cy={48} r={44} fill="none" stroke="currentColor" strokeWidth={3} />
        <circle cx={48} cy={48} r={37} fill="none" stroke="currentColor" strokeWidth={1} />
        <text x={48} y={45} textAnchor="middle" className="kla-stamp__word kl-rdie__word--logged">
          LOGGED
        </text>
        <path d="M18 51H78" stroke="currentColor" strokeWidth={1} />
        <text x={48} y={63} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
          BATCH {batch}
        </text>
        <text x={48} y={74} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
          {anchored ? "ON BASE" : "KLETIA LOG"}
        </text>
        {waves.map((d) => (
          <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
        ))}
      </g>
    </svg>
  );
}

/** RECHECKED: a date box with how many sources agreed. */
export function RecheckedStamp({ day, sources, ...props }: DieProps & { readonly day: string; readonly sources: number }) {
  return (
    <svg viewBox="0 0 150 86" {...usePress("rechecked", props)}>
      <g filter="url(#kla-ink)">
        <rect x={3} y={3} width={144} height={80} fill="none" stroke="currentColor" strokeWidth={3} />
        <rect x={3} y={3} width={144} height={22} fill="currentColor" />
        <text x={75} y={19} textAnchor="middle" className="kla-stamp__small kla-stamp__word--knock kl-rdie__band">
          RECHECKED
        </text>
        <text x={75} y={53} textAnchor="middle" className="kla-stamp__word kl-rdie__word--date">
          {day}
        </text>
        <text x={75} y={72} textAnchor="middle" className="kla-stamp__small kla-stamp__small--tight">
          {sources === 1 ? "1 SOURCE" : `${sources} SOURCES`}
        </text>
      </g>
    </svg>
  );
}
