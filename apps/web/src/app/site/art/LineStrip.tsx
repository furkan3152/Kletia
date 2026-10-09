import "./base.css";
import "./strip.css";

import type { CSSProperties, ReactNode } from "react";

import { cx } from "../ui/styles";
import { YELLOW, type Line } from "./tokens";

export interface StripStop {
  readonly id: string;
  readonly title: ReactNode;
  readonly body?: ReactNode;
}

export interface LineStripProps {
  /** The stops, in the order a journey passes them. */
  readonly stops: readonly StripStop[];
  /** Where the line starts and ends, printed above it ("Your sentence", "Your signature"). */
  readonly from: ReactNode;
  readonly to: ReactNode;
  /** A network line, only when the strip is about that network. Without one it is the Kletia line, in signage yellow. */
  readonly line?: Line;
  /** "ink" on dark sections: casing and stop numbers change, the line colour does not. */
  readonly tone?: "paper" | "ink";
  /** Heading level of each stop's title. Default 3. */
  readonly headingLevel?: 3 | 4;
  readonly className?: string;
}

/**
 * The strip map printed above the doors of a train: one line, every stop in
 * order, the stop names under it. It measures its own width (container
 * queries): every stop on one line from about 900 px, three per row from
 * 560 px, and a vertical strip on phones. The stops are an ordered list; the
 * line, its casing and the stop rings are drawn in CSS and never read aloud.
 */
export function LineStrip({ stops, from, to, line, tone = "paper", headingLevel = 3, className }: LineStripProps) {
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const style = {
    "--kla-strip-line": line?.color ?? YELLOW,
    "--kla-strip-n": stops.length,
  } as CSSProperties;
  return (
    <div className={cx("kla-strip", `kla-strip--${tone}`, line?.gauge === "svm" && "kla-strip--svm", className)} style={style}>
      <p className="kla-strip__ends">
        <span className="kla-strip__end">
          <span className="kla-strip__end-k">From</span> {from}
        </span>
        <span className="kla-strip__end kla-strip__end--to">
          <span className="kla-strip__end-k">To</span> {to}
        </span>
      </p>
      <ol className="kla-strip__stops">
        {stops.map((stop, index) => (
          <li key={stop.id} className="kla-strip__stop">
            <span aria-hidden="true" className="kla-strip__ring" />
            <Heading className="kla-strip__title">
              <span className="kla-strip__no">{String(index + 1).padStart(2, "0")}</span>
              {stop.title}
            </Heading>
            {stop.body ? <p className="kla-strip__body">{stop.body}</p> : null}
          </li>
        ))}
      </ol>
      {/* On the vertical strip the far end is printed under the last stop (only one of the two "To" lines is ever displayed). */}
      <p className="kla-strip__tail">
        <span className="kla-strip__end-k">To</span> {to}
      </p>
    </div>
  );
}
