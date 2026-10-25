/**
 * Shared parts of the desk's views (Card machine): one heading, one note, one empty
 * well and one loading line, so Trade, Portfolio, Automate and More read as one machine in both
 * themes. The class recipes are in viewStyles.ts, the styles in views.css (this file loads them
 * with the console's chunks, never with the entry stylesheet).
 */
import "./views.css";

import type { ReactNode } from "react";

import { cx } from "../../site/ui/styles";

export function ViewHeader({ id, title, intro, action }: { readonly id: string; readonly title: string; readonly intro?: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="kv-head">
      <div className="kv-head-row">
        <h2 id={id} className="kv-h2">
          {title}
        </h2>
        {action}
      </div>
      {intro ? <p className="kv-intro">{intro}</p> : null}
    </div>
  );
}

export type NoteTone = "neutral" | "info" | "warning" | "danger";

/** A note beside the content with a lamp: a rule, a warning, an error (role="alert" for errors that just happened). */
export function ViewNote({ tone = "neutral", role, className, children }: { readonly tone?: NoteTone; readonly role?: "alert" | "status"; readonly className?: string; readonly children: ReactNode }) {
  return (
    <div role={role} className={cx("kv-note", className)} data-tone={tone}>
      {children}
    </div>
  );
}

/** Nothing to show yet (no wallet, no rows): an empty recessed well, never an empty table. */
export function ViewEmpty({ children, action }: { readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="kv-empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

/** A read in flight (a blinking lamp). */
export function ViewLoading({ children }: { readonly children: ReactNode }) {
  return (
    <p role="status" className="kv-loading">
      {children}
    </p>
  );
}

/** Label/value rows (a quote, a position): label left, mono value right; "warn" prints the value in the loss colour. */
export function ViewFacts({ rows, live }: { readonly rows: readonly { readonly label: ReactNode; readonly value: ReactNode; readonly tone?: "warn" | undefined }[]; readonly live?: boolean }) {
  return (
    <dl className="kv-facts" aria-live={live ? "polite" : undefined}>
      {rows.map((row, index) => (
        <div key={index}>
          <dt>{row.label}</dt>
          <dd data-tone={row.tone}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
