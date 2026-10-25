/**
 * Trade's machine parts: the layout (an
 * instrument on the left, one ticket per instrument on the right, one column on phones), the
 * ticket as a slab module, the side switch (Long lime, Short magenta), the price tape with its
 * levels, and the signing strip. Perps, Orders and Predict share them; the styles are in
 * trade.css, loaded with these views, never with the entry stylesheet.
 */
import "./trade.css";

import type { ReactNode } from "react";

import { tapeChart, type TapeLevel, type TapePoint } from "./tapeModel";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/**
 * The instrument (`main`: head and chart) and its ticket side by side on wide screens, with the
 * lists (`rest`) under the instrument; on phones the ticket follows the chart, then the lists.
 */
export function TradeLayout({ main, ticket, rest, className }: { readonly main: ReactNode; readonly ticket: ReactNode; readonly rest?: ReactNode; readonly className?: string }) {
  return (
    <div className={cx("kt", className)}>
      <div className="kt-main">{main}</div>
      <div className="kt-side">{ticket}</div>
      {rest ? <div className="kt-rest">{rest}</div> : null}
    </div>
  );
}

/** The ticket: the one slab on the screen (2 px ink + hard offset), a named region. */
export function Ticket({ id, title, children, className }: { readonly id: string; readonly title: ReactNode; readonly children: ReactNode; readonly className?: string }) {
  return (
    <section aria-labelledby={id} className={cx("kt-ticket", className)}>
      <h3 id={id} className="kt-ticket-h">
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface SideOption<T extends string> {
  readonly id: T;
  readonly label: string;
  /** "go" draws the knob lime, "stop" magenta (short, sell). */
  readonly tone: "go" | "stop";
}

/** Long / Short (Buy / Sell) as one sliding key in a well; a group of two pressed buttons for assistive tech. */
export function SideSwitch<T extends string>({ label, options, value, onChange }: { readonly label: string; readonly options: readonly [SideOption<T>, SideOption<T>]; readonly value: T; readonly onChange: (next: T) => void }) {
  const index = options[1].id === value ? 1 : 0;
  return (
    <div role="group" aria-label={label} className="kt-side-sw" data-at={index} data-tone={options[index].tone}>
      <span className="kt-side-knob" aria-hidden="true" />
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={option.id === value} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Big instrument heading: symbol (or a picker), venue line, the live value and its change. */
export function InstrumentHead({ title, sub, value, change, changeTone }: { readonly title: ReactNode; readonly sub?: ReactNode; readonly value?: ReactNode; readonly change?: ReactNode; readonly changeTone?: "up" | "down" | "flat" }) {
  return (
    <div className="kt-head">
      <div className="kt-head-l">
        {title}
        {sub ? <p className="kt-head-sub">{sub}</p> : null}
      </div>
      {value ? (
        <p className="kt-head-v">
          <b className="kv-num">{value}</b>
          {change ? (
            <span className="kv-num" data-tone={changeTone ?? "flat"}>
              {change}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The price tape: the reads this browser made, a dot-matrix fill under the line, the live head,
 * and dashed level lines with tags (entry, liquidation). Decorative: the same numbers are in the
 * text beside it, and `label` names the figure.
 */
export function PriceTape({ points, levels, label, caption, empty }: { readonly points: readonly TapePoint[]; readonly levels: readonly TapeLevel[]; readonly label: string; readonly caption?: ReactNode; readonly empty?: ReactNode }) {
  const chart = tapeChart(points, levels);
  return (
    <figure className="kt-tape" aria-label={label}>
      <div className="kt-tape-plot">
        {chart ? (
          <>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <defs>
                <pattern id="kt-dots" width="1.6" height="3.2" patternUnits="userSpaceOnUse">
                  <circle cx="0.8" cy="1.6" r="0.28" className="kt-tape-dot" />
                </pattern>
              </defs>
              {chart.area ? <path d={chart.area} fill="url(#kt-dots)" className="kt-tape-area" /> : null}
              {chart.path ? <path d={chart.path} className="kt-tape-line" vectorEffect="non-scaling-stroke" /> : null}
            </svg>
            {chart.levels.map((level) => (
              <span key={level.id} className="kt-level" data-tone={level.tone} style={{ top: `${level.y}%` }} aria-hidden="true">
                <span className="kt-ctag">{level.label}</span>
              </span>
            ))}
            {chart.head ? <span className="kt-tape-head" style={{ left: `${chart.head.x}%`, top: `${chart.head.y}%` }} aria-hidden="true" /> : null}
          </>
        ) : (
          <p className="kt-tape-empty">{empty}</p>
        )}
      </div>
      {caption ? <figcaption className="kt-tape-cap">{caption}</figcaption> : null}
    </figure>
  );
}

export type StripState = "waiting" | "active" | "done" | "failed";

/** The signing strip: one row per wallet step, a ring that ratchets while active, a check when done. */
export function SigningStrip({ id, title, steps, children }: { readonly id: string; readonly title: ReactNode; readonly steps: readonly { readonly id: string; readonly title: ReactNode; readonly state: StripState; readonly word: ReactNode; readonly extra?: ReactNode }[]; readonly children?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="kt-strip">
      <h4 id={id} className="kv-eng">
        {title}
      </h4>
      <ol>
        {steps.map((step, index) => (
          <li key={step.id} data-state={step.state}>
            <span className="kt-strip-ring" aria-hidden="true">
              {step.state === "done" ? "✓" : index + 1}
            </span>
            <span className="kt-strip-t">
              {step.title}
              {step.extra}
            </span>
            <span className="kt-strip-w" role="status">
              {step.word}
            </span>
          </li>
        ))}
      </ol>
      {children}
    </section>
  );
}
