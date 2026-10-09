import type { PolicyOutcomeView } from "@kletia/widget/review";
import { ExternalLink, RefreshCw } from "lucide-react";

import { Stamp } from "../art/Stamp";
import { Button } from "../ui/Button";
import { cx, INK_BORDER, LABEL } from "../ui/styles";

const timeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function timeText(iso: string | null): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? timeFormatter.format(new Date(time)) : null;
}

export interface PolicyNoticeProps {
  readonly outcome: PolicyOutcomeView;
  /** Held intents: try again after the approver decided. */
  readonly onCheckAgain?: () => void;
  readonly busy?: boolean;
  readonly className?: string;
}

/**
 * A Rule Book outcome in the Interchange style: "Held for approval" (the
 * held bar stamp) with the approval link, which is safe to hand to the
 * approver (reading it is not approving it), or "Refused" (the failed
 * octagon) with the ids of the rules that decided. The stamp is decorative;
 * the outcome is in the text.
 */
export function PolicyNotice({ outcome, onCheckAgain, busy = false, className }: PolicyNoticeProps) {
  const held = outcome.kind === "held";
  const expires = timeText(outcome.approval?.expiresAt ?? null);
  const retry = timeText(outcome.retryAt);
  return (
    <div
      role={held ? "status" : "alert"}
      className={cx(
        "relative flex flex-col gap-3 p-4 pr-4 text-[#1A1A1A] sm:pr-36",
        INK_BORDER,
        "shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]",
        held ? "bg-[#FFF3B0]" : "bg-[#FFE4E4]",
        className,
      )}
    >
      <Stamp
        state={held ? "held" : "failed"}
        detail={held ? "Waiting for approval" : "Rule book"}
        className="pointer-events-none !absolute right-3 top-3 hidden w-28 sm:block"
      />
      <p className={cx(LABEL, "!text-[#1A1A1A]")}>{held ? "Held" : "Refused"} · Rule Book</p>
      <p className="font-display text-xl font-bold leading-tight">{outcome.title}</p>
      <p className="text-sm font-semibold leading-relaxed">{outcome.message}</p>
      {outcome.rules.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Rules that decided">
          {outcome.rules.map((rule) => (
            <li key={rule.key} className="flex flex-col gap-0.5 border-l-[3px] border-[#1A1A1A] pl-3 text-sm sm:flex-row sm:flex-wrap sm:gap-2">
              <code className="font-code text-xs font-bold">{rule.rule}</code>
              {rule.message ? <span>{rule.message}</span> : null}
              {rule.detail ? <span className="text-[#45464B]">({rule.detail})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {outcome.approval ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {outcome.approval.href ? (
            <a
              href={outcome.approval.href}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 font-bold text-[#0047E0] underline decoration-2 underline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF]"
            >
              Open the approval request
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <span>
              Approval <code className="font-code font-bold">{outcome.approval.id}</code>
            </span>
          )}
          {outcome.approval.ceilingUsd ? <span className="text-[#45464B]">Up to {outcome.approval.ceilingUsd}</span> : null}
          {expires ? <span className="text-[#45464B]">Expires {expires}</span> : null}
        </p>
      ) : null}
      {held ? (
        <p className="text-xs font-semibold text-[#45464B]">
          The link only shows the request. An approver with the right key or wallet decides; nothing is signed until then.
        </p>
      ) : null}
      {retry ? <p className="text-xs font-semibold text-[#45464B]">A retry may pass after {retry}.</p> : null}
      {held && onCheckAgain ? (
        <Button size="sm" variant="secondary" onClick={onCheckAgain} disabled={busy} className="self-start">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Check approval and continue
        </Button>
      ) : null}
    </div>
  );
}
