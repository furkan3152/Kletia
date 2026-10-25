import type React from "react";

import { StatusPill, type StatusTone } from "../../../site/ui/StatusPill";
import { cx, INK_BORDER_THIN, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { CHIP_LABELS, type PlanChip } from "../model/plan";

const CHIP_TONES: Readonly<Record<PlanChip, StatusTone>> = {
  pinned: "success",
  verified: "success",
  foreign: "danger",
  failed: "danger",
  ready: "info",
  waiting: "warning",
  "not-applicable": "neutral",
  quarantined: "danger",
  legacy: "neutral",
};

export function PlanChipPill({ chip }: { readonly chip: PlanChip }) {
  return (
    <StatusPill tone={CHIP_TONES[chip]} glyph={chip === "verified" || chip === "pinned" ? "check" : undefined}>
      {CHIP_LABELS[chip]}
    </StatusPill>
  );
}

/** One checklist row: the step number on the track, the title, its chip, one line of detail and the row's actions. */
export function StepRow({
  n,
  title,
  chip,
  detail,
  actions,
  children,
  muted = false,
}: {
  readonly n: number;
  readonly title: string;
  readonly chip: PlanChip;
  readonly detail: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly children?: React.ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <li className="relative flex gap-3 sm:gap-4">
      <span
        aria-hidden="true"
        className={cx(
          "kl-admin__step-dot mt-3 flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#121212] font-code text-sm font-extrabold dark:border-[#94A3B8]",
          chip === "verified" || chip === "pinned" ? "bg-[#C6FF3A] text-[#121212]" : muted ? "bg-surface-2 text-muted" : "bg-surface text-fg",
        )}
      >
        {String(n).padStart(2, "0")}
      </span>
      <div className={cx("flex min-w-0 flex-1 flex-col gap-3 p-4", INK_BORDER_THIN, SURFACE, muted && "opacity-80")}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="break-words font-display text-lg font-bold leading-tight">{title}</h3>
            <p className={cx("mt-1 break-words text-sm", TEXT_MUTED)}>{detail}</p>
          </div>
          <PlanChipPill chip={chip} />
        </div>
        {children}
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </li>
  );
}
