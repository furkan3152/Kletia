import type { AccountId, IntentGraph, IntentStep } from "@kletia/core";
import { CircleAlert, PenLine, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import React, { useId, useState } from "react";

import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../ui/styles";
import {
  formatAmount,
  formatSeconds,
  formatUsd,
  networkColor,
  networkName,
  protocolName,
  shortAccount,
} from "./format";

export interface IntentReviewProps {
  /** A persisted intent planned with the user's own accounts. */
  readonly intent: IntentGraph;
  /** Human label for the wallet behind an account, e.g. "Phantom · 9WzD…AWWM". */
  readonly describeAccount?: (accountId: AccountId) => string | null;
  readonly onConfirm: () => void;
  /** Re-plan with fresh quotes. */
  readonly onReplan?: () => void;
  readonly confirmLabel?: string;
  readonly busy?: boolean;
  /** When set, confirming is blocked and this explains why. */
  readonly blockedReason?: string | null;
  readonly className?: string;
}

const timeFormatter = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function formatTime(iso: string): string | null {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? timeFormatter.format(new Date(time)) : null;
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{label}</dt>
      <dd className="mt-0.5 break-words font-code text-[12.5px] font-bold">{children}</dd>
    </div>
  );
}

function ReviewStep({ step, describeAccount }: { step: IntentStep; describeAccount?: IntentReviewProps["describeAccount"] }) {
  const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
  const signer = step.mode === "wallet" ? describeAccount?.(step.account) ?? shortAccount(step.account) : null;
  const fees = formatUsd(step.feesUsd);
  return (
    <li className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-code text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
          {String(step.index + 1).padStart(2, "0")}
        </span>
        <Badge tone="ink">{step.kind}</Badge>
        <Badge tone="outline" dot={networkColor(step.network)}>
          {networkName(step.network)}
        </Badge>
        {destination ? (
          <Badge tone="outline" dot={networkColor(destination)}>
            → {networkName(destination)}
          </Badge>
        ) : null}
        <span className="text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">via {protocolName(step.protocol)}</span>
      </div>
      <p className="font-display text-base font-bold leading-snug">{step.title}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Cell label="You pay">{formatAmount(step.input) ?? "—"}</Cell>
        <Cell label="Expected">{formatAmount(step.expectedOutput) ?? "—"}</Cell>
        <Cell label="Minimum">{formatAmount(step.minimumOutput) ?? "—"}</Cell>
        <Cell label="Fees">{fees ?? "—"}</Cell>
      </dl>
      <p className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
        <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
        {signer ? (
          <>
            Signed by <span className="font-code" title={step.account}>{signer}</span>
          </>
        ) : step.mode === "settlement" ? (
          "Completed by the settlement network (no signature)"
        ) : (
          "Read only (no signature)"
        )}
        {step.recipient && step.recipient !== step.account ? (
          <span className={TEXT_MUTED}>
            {" "}
            · receives <span className="font-code" title={step.recipient}>{shortAccount(step.recipient)}</span>
          </span>
        ) : null}
      </p>
      {step.warnings && step.warnings.length > 0 ? (
        <ul className="space-y-1 border-2 border-[#1A1A1A] bg-[#FFF3B0] p-2.5 text-xs font-semibold text-[#1A1A1A] dark:border-[#4B5563]">
          {step.warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Pre-signing review of a persisted intent: networks, amounts, minimum
 * outputs, fees, signatures and who signs each step, with an explicit
 * confirmation before any wallet prompt.
 */
export function IntentReview({
  intent,
  describeAccount,
  onConfirm,
  onReplan,
  confirmLabel = "Confirm and sign",
  busy = false,
  blockedReason,
  className,
}: IntentReviewProps) {
  const checkboxId = useId();
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = confirmedFor === intent.id;
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const { summary } = intent;
  const fees = formatUsd(summary.totalFeesUsd);
  const eta = formatSeconds(summary.estimatedSeconds);
  const expires = formatTime(intent.expiresAt);
  const minimums = steps
    .filter((step) => !steps.some((other) => other.dependsOn.includes(step.id)))
    .map((step) => formatAmount(step.minimumOutput))
    .filter((value): value is string => Boolean(value));
  const signatures = summary.signaturesRequired;
  const warnings = intent.warnings;

  return (
    <section aria-label="Review before signing" className={cx("flex flex-col gap-4", className)}>
      <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={cx(LABEL, "flex items-center gap-2 text-[#0052FF] dark:text-[#7EA6FF]")}>
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Review before signing
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge tone={summary.crossNetwork ? "purple" : "neutral"}>
              {summary.crossNetwork ? "Cross-network" : "Single network"}
            </Badge>
            <Badge tone="yellow">
              {signatures} signature{signatures === 1 ? "" : "s"}
            </Badge>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Cell label="Networks">{summary.networks.map(networkName).join(" → ") || "—"}</Cell>
          <Cell label="Total fees">{fees ?? "—"}</Cell>
          <Cell label="Est. time">{eta ?? "—"}</Cell>
          <Cell label="You receive (expected)">
            {summary.outputs.map((output) => formatAmount(output)).join(" + ") || "—"}
          </Cell>
          <Cell label="Minimum received">{minimums.join(" + ") || "—"}</Cell>
          <Cell label="Quotes valid until">{expires ?? "—"}</Cell>
        </dl>
      </div>

      <ol className="flex flex-col gap-3" aria-label="Steps to sign">
        {steps.map((step) => (
          <ReviewStep key={step.id} step={step} describeAccount={describeAccount} />
        ))}
      </ol>

      {warnings.length > 0 ? (
        <div className="border-[3px] border-[#1A1A1A] bg-[#FFF3B0] p-4 text-sm font-semibold text-[#1A1A1A] dark:border-[#4B5563]">
          <p className={cx(LABEL, "flex items-center gap-2")}>
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            Warnings
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {blockedReason ? (
        <p role="alert" className="flex gap-2 border-[3px] border-[#1A1A1A] bg-[#FFE4E4] p-3 text-sm font-bold text-[#7F1D1D] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {blockedReason}
        </p>
      ) : null}

      <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, SURFACE)}>
        <div className="flex items-start gap-3">
          <input
            id={checkboxId}
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmedFor(event.target.checked ? intent.id : null)}
            disabled={busy || Boolean(blockedReason)}
            className={cx(
              "mt-0.5 h-5 w-5 shrink-0 cursor-pointer appearance-none border-[3px] border-[#1A1A1A] bg-white checked:bg-[#0052FF] checked:[background-image:url(\"data:image/svg+xml,%3Csvg viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 8.5l3 3 7-7' fill='none' stroke='white' stroke-width='2.5'/%3E%3C/svg%3E\")] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#94A3B8] dark:bg-[#0B1120] dark:checked:bg-[#0052FF]",
              FOCUS_RING,
            )}
          />
          <label htmlFor={checkboxId} className="text-sm font-semibold leading-relaxed">
            I reviewed the networks, amounts, minimum outputs and fees. My wallet will ask me to sign{" "}
            {signatures} time{signatures === 1 ? "" : "s"}, and nothing moves without that signature.
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button onClick={onConfirm} disabled={!confirmed || busy || Boolean(blockedReason)} size="lg">
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {busy ? "Starting…" : confirmLabel}
          </Button>
          {onReplan ? (
            <Button variant="secondary" size="lg" onClick={onReplan} disabled={busy}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Refresh quotes
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
