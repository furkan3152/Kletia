/**
 * Shared parts of the desk's views (round 9): one heading, one panel, one
 * form field and one look for notes, empty, loading and error states, so
 * Perps, Orders, Automations, Dashboard and Activity read as one desk in
 * both themes (class recipes in viewStyles.ts). Colours come from the
 * semantic tokens only.
 */
import type { ReactNode } from "react";

import { cx } from "../../site/ui/styles";

export function ViewHeader({ id, title, intro, action }: { readonly id: string; readonly title: string; readonly intro?: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="font-display text-2xl font-bold">
          {title}
        </h2>
        {action}
      </div>
      {intro ? <p className="max-w-prose text-sm">{intro}</p> : null}
    </div>
  );
}

export type NoteTone = "neutral" | "info" | "warning" | "danger";

const NOTE_TONES: Readonly<Record<NoteTone, string>> = {
  neutral: "border-control bg-neutral-bg",
  info: "border-info bg-info-bg",
  warning: "border-warning bg-warning-bg",
  danger: "border-danger bg-danger-bg font-semibold",
};

/** A note beside the content: a rule, a warning, an error (role="alert" for errors that just happened). */
export function ViewNote({ tone = "neutral", role, className, children }: { readonly tone?: NoteTone; readonly role?: "alert" | "status"; readonly className?: string; readonly children: ReactNode }) {
  return (
    <div role={role} className={cx("border-l-4 px-3 py-2 text-sm text-fg", NOTE_TONES[tone], className)}>
      {children}
    </div>
  );
}

/** Nothing to show yet (no wallet, no rows): a dashed box, never an empty table. */
export function ViewEmpty({ children, action }: { readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 border-2 border-dashed border-control p-3 text-sm font-semibold">
      <p>{children}</p>
      {action}
    </div>
  );
}

/** A read in flight. */
export function ViewLoading({ children }: { readonly children: ReactNode }) {
  return (
    <p role="status" className="text-sm font-semibold text-muted">
      {children}
    </p>
  );
}
