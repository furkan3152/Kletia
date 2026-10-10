import type { PolicyPendingView } from "@kletia/sdk";
import { Ban } from "lucide-react";

import { Button } from "../../../site/ui/Button";
import { cx, INK_BORDER, LABEL } from "../../../site/ui/styles";
import { formatWhen, timeUntil } from "../portal/portalFormat";

export interface AmendmentNoticeProps {
  readonly pending: PolicyPendingView;
  readonly now: number;
  readonly onCancel?: () => void;
  readonly busy?: boolean;
}

/**
 * A posted notice: a loosening of this rule book is waiting for its delay.
 * Lists what it loosens, counts down to when it applies, and cancels it.
 */
export function AmendmentNotice({ pending, now, onCancel, busy = false }: AmendmentNoticeProps) {
  const left = timeUntil(pending.activatesAt, now);
  return (
    <aside
      aria-label="Pending amendment"
      className={cx("relative flex min-w-0 flex-col gap-3 bg-[#FFF3B0] p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] sm:p-5", INK_BORDER)}
    >
      <span aria-hidden="true" className="absolute -top-2 left-6 h-4 w-4 rotate-45 border-[3px] border-[#1A1A1A] bg-[#C8102E]" />
      <p className={LABEL}>Posted notice · edition {pending.version}</p>
      <p className="font-display text-xl font-bold leading-tight">
        {pending.removal ? "This rule book is to be removed" : "A loosening is waiting"}
        {left ? (left.past ? ": it applies now." : ` and applies ${left.text}.`) : "."}
      </p>
      <p className="text-sm">
        In force {formatWhen(pending.activatesAt)}, written by <code className="font-code">{pending.createdBy}</code>. Until then the current edition stays in
        force, and a later save replaces this notice.
      </p>
      {pending.loosened.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Loosened clauses">
          {pending.loosened.map((path) => (
            <li key={path} className="border-2 border-dashed border-[#A84B00] bg-white/60 px-2 py-0.5 font-code text-[11px] font-bold text-[#7A3500]">
              {path}
            </li>
          ))}
        </ul>
      ) : null}
      {onCancel ? (
        <Button size="sm" variant="ink" loading={busy} onClick={onCancel} className="self-start">
          <Ban className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel this amendment
        </Button>
      ) : null}
    </aside>
  );
}
