import { totalFeesUsd, type AccountId, type IntentGraph, type IntentPreview, type IntentStep } from "@kletia/core";
import { contractReviewModel, fareModel, isContractStep } from "@kletia/widget/review";
import { CircleAlert, PenLine, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import React, { useEffect, useId, useRef, useState } from "react";

import { ContractReviewCard } from "../../../shared/platform/ContractReviewCard";
import { externalRecipients } from "../../../shared/platform/intentBinding";

import { cssVars, staggerIndex } from "../motion/tokens";
import { useChangeKey } from "../motion/useChangeKey";
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
import { FareTable } from "./FareTable";
import { popOut } from "./phaseMotion";
import { PolicyNotice } from "./PolicyNotice";
import { holdOf } from "./policyView";
import { formatUtcTime } from "../format/utcTime";

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
  /**
   * The user's own accounts. Steps that pay anyone else are listed with the
   * full recipient address above the confirmation.
   */
  readonly ownedAccounts?: readonly AccountId[];
  /**
   * The plan's fare (asset-change preview). Confirming approves this fare;
   * a fare that changes later is shown again before anything is signed.
   */
  readonly preview?: IntentPreview | null;
  /** The itinerary (JourneyPanel), printed above the fare. */
  readonly journey?: React.ReactNode;
  /**
   * Open journey blockers: Confirm stays disabled until each is answered,
   * with the reason next to it; pressing it moves focus to the first one.
   */
  readonly journeyBlockers?: number;
  readonly onFocusBlocker?: () => void;
  readonly className?: string;
}

/** "20:23:53 UTC": every clock on the desk is UTC, 24 h. */
function formatTime(iso: string): string | null {
  return formatUtcTime(iso);
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{label}</dt>
      <dd className="mt-0.5 break-words font-code text-[12.5px] font-bold">{children}</dd>
    </div>
  );
}

function ReviewStep({
  step,
  describeAccount,
  order,
}: {
  step: IntentStep;
  describeAccount?: IntentReviewProps["describeAccount"];
  order: number;
}) {
  const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
  const signer = step.mode === "wallet" ? describeAccount?.(step.account) ?? shortAccount(step.account) : null;
  const fees = formatUsd(step.feesUsd);
  // The card rises in (opacity and translate only); the values inside never animate.
  return (
    <li className={cx("kl-rise flex flex-col gap-3 p-4", INK_BORDER, SURFACE)} style={cssVars({ "--kl-i": staggerIndex(order) })}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-code text-xs font-bold text-[#5C5850] dark:text-[#9A968C]">
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
        <span className="text-xs font-bold text-[#5C5850] dark:text-[#9A968C]">via {protocolName(step.protocol)}</span>
      </div>
      <p className="font-display text-base font-bold leading-snug">{step.title}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Cell label="You pay">{formatAmount(step.input, "up") ?? "—"}</Cell>
        <Cell label="Expected">{formatAmount(step.expectedOutput) ?? "—"}</Cell>
        <Cell label="Minimum">{formatAmount(step.minimumOutput) ?? "—"}</Cell>
        <Cell label="Fees">{fees ?? "—"}</Cell>
      </dl>
      <p className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
        <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
        {signer ? (
          <>
            {/* Before any signature: who will sign, never "Signed". */}
            Signs with <span className="font-code" title={step.account}>{signer}</span>
          </>
        ) : step.mode === "settlement" ? (
          "Completed by the settlement network (no signature)"
        ) : (
          "Read only (no signature)"
        )}
        {step.recipient && step.recipient !== step.account ? (
          <span className={TEXT_MUTED}>
            {" "}
            · receives{" "}
            {step.recipientName ? <span className="font-semibold text-[#121212] dark:text-white">{step.recipientName} </span> : null}
            <span className="font-code" title={step.recipient}>
              {step.recipientName ? `(${shortAccount(step.recipient)})` : shortAccount(step.recipient)}
            </span>
          </span>
        ) : null}
      </p>
      {step.warnings && step.warnings.length > 0 ? (
        <ul className="space-y-1 border-2 border-[#121212] bg-[#FFF3B0] p-2.5 text-xs font-semibold text-[#121212] dark:border-[#4A4A52]">
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
  blockedReason: blockedByCaller,
  ownedAccounts,
  preview,
  journey,
  journeyBlockers = 0,
  onFocusBlocker,
  className,
}: IntentReviewProps) {
  const checkboxId = useId();
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = confirmedFor === intent.id;
  // Custom-contract steps: an unverified source, program or domain needs an explicit acknowledgement.
  const [acks, setAcks] = useState<Readonly<Record<string, boolean>>>({});
  const contractSteps = [...intent.steps]
    .sort((a, b) => a.index - b.index)
    .filter((step) => isContractStep(step) && step.call?.review);
  const missingAck = contractSteps.some(
    (step) => step.call?.review && contractReviewModel(step.call.review).needsAcknowledgement && !acks[`${intent.id}:${step.id}`],
  );
  const fare = preview && preview.intentId === intent.id ? preview : null;
  const fareBlocking = fare ? fareModel(fare, intent).blocking : [];
  const hold = holdOf(intent);
  const blockedReason =
    blockedByCaller ??
    (fareBlocking.length > 0
      ? `Kletia will not sign this plan: ${fareBlocking.map((issue) => issue.message || issue.code).join(" ")}`
      : missingAck
        ? "Read each custom contract below and tick its acknowledgement before signing."
        : null);
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const { summary } = intent;
  // One fee total everywhere: the fare's fee lines when there is a fare, the plan's estimates otherwise.
  const fees = formatUsd(totalFeesUsd({ summary, preview: fare }));
  const eta = formatSeconds(summary.estimatedSeconds);
  const expires = formatTime(intent.expiresAt);
  const minimums = steps
    .filter((step) => !steps.some((other) => other.dependsOn.includes(step.id)))
    .map((step) => formatAmount(step.minimumOutput))
    .filter((value): value is string => Boolean(value));
  const signatures = summary.signaturesRequired;
  const warnings = intent.warnings;
  const external = ownedAccounts ? externalRecipients(intent, ownedAccounts) : [];
  // Names (ENS, Basenames, SNS) the API resolved a recipient from, shown next to the full address, never instead of it.
  const recipientNames = new Map(intent.steps.filter((step) => step.recipientName).map((step) => [step.id, step.recipientName as string]));
  const journeyBlocked = journeyBlockers > 0;
  const blockerReason = journeyBlocked
    ? journeyBlockers === 1
      ? "Answer 1 question above before signing."
      : `Answer ${journeyBlockers} questions above before signing.`
    : null;
  const canConfirm = confirmed && !busy && !blockedReason && !journeyBlocked;

  // The Confirm button "unlocks": when it becomes enabled it pops out of its
  // pressed position into its shadow (never on mount, never when disabling).
  const actionsRef = useRef<HTMLDivElement>(null);
  const unlockKey = useChangeKey(canConfirm);
  useEffect(() => {
    if (unlockKey === 0 || !canConfirm) return;
    popOut(actionsRef.current?.querySelector("button[data-confirm]"));
  }, [unlockKey, canConfirm]);

  return (
    <section aria-label="Review before signing" className={cx("flex flex-col gap-4", className)}>
      <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={cx(LABEL, "flex items-center gap-2 text-[#1A36B0] dark:text-[#8FA6FF]")}>
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
        {steps.map((step, order) => (
          <ReviewStep key={step.id} step={step} describeAccount={describeAccount} order={order} />
        ))}
      </ol>

      {journey}

      {fare ? <FareTable preview={fare} intent={intent} /> : null}

      {contractSteps.map((step) => (
        <ContractReviewCard
          key={step.id}
          review={step.call!.review}
          title={`Step ${step.index + 1} · ${step.call?.label ?? step.title}`}
          acknowledged={Boolean(acks[`${intent.id}:${step.id}`])}
          onAcknowledge={(value) => setAcks((current) => ({ ...current, [`${intent.id}:${step.id}`]: value }))}
          disabled={busy}
        />
      ))}

      {hold ? <PolicyNotice outcome={hold} /> : null}

      {warnings.length > 0 ? (
        <div className="border-[3px] border-[#121212] bg-[#FFF3B0] p-4 text-sm font-semibold text-[#121212] dark:border-[#4A4A52]">
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

      {external.length > 0 ? (
        <div className="border-[3px] border-[#121212] bg-[#FFF3B0] p-4 text-sm font-semibold text-[#121212] dark:border-[#B45309]">
          <p className={cx(LABEL, "flex items-center gap-2")}>
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            Funds leave your wallets
          </p>
          <p className="mt-2">
            {external.length === 1 ? "This step pays an address" : "These steps pay addresses"} that{" "}
            {external.length === 1 ? "is" : "are"} not one of your connected wallets. Check every character before you
            sign:
          </p>
          <ul className="mt-2 space-y-1">
            {external.map((item) => (
              <li key={`${item.stepId}:${item.recipient}`}>
                Step {item.stepIndex + 1} on {item.network}:{" "}
                {recipientNames.get(item.stepId) ? <span className="font-bold">{recipientNames.get(item.stepId)}, resolved to </span> : null}
                <span className="break-all font-code font-bold">
                  {item.recipient.slice(item.recipient.lastIndexOf(":") + 1)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {blockedReason ? (
        <p role="alert" className="flex gap-2 border-[3px] border-[#121212] bg-[#FFE4E4] p-3 text-sm font-bold text-[#7F1D1D] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {blockedReason}
        </p>
      ) : null}

      <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, SURFACE)}>
        <div className="flex items-start gap-3">
          <span className="relative mt-0.5 flex h-5 w-5 shrink-0">
            <input
              id={checkboxId}
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmedFor(event.target.checked ? intent.id : null)}
              disabled={busy || Boolean(blockedReason)}
              className={cx(
                "peer h-5 w-5 shrink-0 cursor-pointer appearance-none border-[3px] border-[#121212] bg-[#FBFAF6] transition-colors duration-150 checked:bg-[#2F5BFF] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none dark:border-[#94A3B8] dark:bg-[#0E0E10] dark:checked:bg-[#2F5BFF]",
                FOCUS_RING,
              )}
            />
            {confirmed ? (
              // The check mark draws in (same 16-unit mark the box used to paint as a background).
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="pointer-events-none absolute inset-[3px] h-[14px] w-[14px] peer-disabled:opacity-50"
              >
                <path d="M3 8.5l3 3 7-7" fill="none" stroke="white" strokeWidth={2.5} pathLength={1} className="kl-draw" />
              </svg>
            ) : null}
          </span>
          <label htmlFor={checkboxId} className="text-sm font-semibold leading-relaxed">
            I reviewed the {fare ? "fare, " : ""}networks, amounts, minimum outputs and fees. My wallet will ask me to sign{" "}
            {signatures} time{signatures === 1 ? "" : "s"}, and nothing moves without that signature.
          </label>
        </div>
        <div ref={actionsRef} className="flex flex-wrap gap-3">
          <Button
            onClick={() => {
              // A journey blocker keeps the button focusable but never confirms: it takes you to the question.
              if (journeyBlocked) {
                onFocusBlocker?.();
                return;
              }
              onConfirm();
            }}
            disabled={!confirmed || busy || Boolean(blockedReason)}
            aria-disabled={journeyBlocked || undefined}
            aria-describedby={journeyBlocked ? `${checkboxId}-blocked` : undefined}
            size="lg"
            data-confirm=""
            className={cx("disabled:shadow-none", journeyBlocked && "cursor-not-allowed opacity-60 shadow-none")}
          >
            <PenLine className="h-4 w-4" aria-hidden="true" />
            {busy ? "Starting…" : confirmLabel}
          </Button>
          {blockerReason ? (
            <p id={`${checkboxId}-blocked`} className="self-center text-sm font-bold text-[#7F1D1D] dark:text-[#FCA5A5]">
              {blockerReason}
            </p>
          ) : null}
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
