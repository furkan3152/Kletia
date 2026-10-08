import type { IntentGraph, IntentStep } from "@kletia/core";
import { CircleCheck, CircleX, ExternalLink, LoaderCircle, Radio } from "lucide-react";
import React from "react";

import { stepExplorerLinks } from "../../../shared/platform/intentLinks";
import type { LocalStepPhase } from "../../../shared/platform/useIntentExecution";
import { Badge } from "../ui/Badge";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../ui/styles";
import { formatAmount, humanize, networkColor, networkName, STATUS_TONE } from "./format";
import { PHASE_PRESENTATION, stepDisplayPhase, type StepDisplayPhase } from "./stepPhase";

export interface IntentProgressProps {
  readonly intent: IntentGraph;
  readonly phases?: Readonly<Record<string, LocalStepPhase>>;
  readonly activeStepId?: string | null;
  /** True while live events stream in. */
  readonly streaming?: boolean;
  /** Name of the wallet that will prompt, for the "confirm in your wallet" hint. */
  readonly walletFor?: (step: IntentStep) => string | null;
  /** False while execution is paused or stopped: in-flight phases are drawn without motion. */
  readonly running?: boolean;
  readonly className?: string;
}

const LIVE_PHASES: ReadonlySet<StepDisplayPhase> = new Set(["preparing", "awaiting_signature", "submitted", "settling", "unconfirmed"]);

/** Explorer links for one step (https only), as small inline buttons. */
export function StepLinks({ step, className }: { step: IntentStep; className?: string }) {
  const links = stepExplorerLinks(step);
  if (links.length === 0) return null;
  return (
    <ul className={cx("flex flex-wrap gap-2", className)}>
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cx(
              "inline-flex min-h-9 items-center gap-1.5 border-2 border-[#1A1A1A] bg-white px-2 py-1 text-[11px] font-black uppercase tracking-[0.1em] text-[#0052FF] hover:bg-[#EAF0FF] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#93C5FD] dark:hover:bg-[#14213D]",
              FOCUS_RING,
            )}
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            {link.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function PhaseIcon({ phase, running }: { phase: StepDisplayPhase; running: boolean }) {
  if (phase === "settled") return <CircleCheck className="h-4 w-4 text-[#047857] dark:text-[#14F195]" aria-hidden="true" />;
  if (phase === "failed") return <CircleX className="h-4 w-4 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />;
  if (running && LIVE_PHASES.has(phase)) {
    return <LoaderCircle className="h-4 w-4 animate-spin text-[#0052FF] motion-reduce:animate-none dark:text-[#7EA6FF]" aria-hidden="true" />;
  }
  return <span aria-hidden="true" className="inline-block h-3 w-3 border-2 border-[#1A1A1A] dark:border-[#94A3B8]" />;
}

/**
 * Step-by-step execution progress: what the wallet and the API are doing for
 * each step, failure reasons and explorer links. Announces changes politely.
 */
export function IntentProgress({
  intent,
  phases = {},
  activeStepId,
  streaming = false,
  walletFor,
  running = true,
  className,
}: IntentProgressProps) {
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const active = steps.find((step) => step.id === activeStepId) ?? null;
  const activePhase = active ? stepDisplayPhase(active, phases[active.id]) : null;
  const wallet = active && walletFor ? walletFor(active) : null;
  const announcement = active && activePhase
    ? `Step ${active.index + 1}, ${active.title}: ${PHASE_PRESENTATION[activePhase].label}.`
    : `Intent ${humanize(intent.status)}.`;

  return (
    <section aria-label="Execution progress" className={cx("flex flex-col gap-3 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE, className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={LABEL}>Progress</p>
        <div className="flex flex-wrap items-center gap-2">
          {streaming ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-[#047857] dark:text-[#14F195]">
              <Radio className="h-3.5 w-3.5" aria-hidden="true" />
              Live
            </span>
          ) : null}
          <Badge tone={STATUS_TONE[intent.status] ?? "neutral"}>{humanize(intent.status)}</Badge>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {running && active && activePhase === "awaiting_signature" ? (
        <p className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-3 py-2 text-sm font-black text-[#1A1A1A] dark:border-[#4B5563]">
          Confirm step {active.index + 1} in {wallet ?? "your wallet"}.
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {steps.map((step) => {
          const phase = stepDisplayPhase(step, phases[step.id]);
          const presentation = PHASE_PRESENTATION[phase];
          const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
          const received = formatAmount(step.actualOutput);
          return (
            <li
              key={step.id}
              aria-current={step.id === activeStepId ? "step" : undefined}
              className={cx(
                "flex flex-col gap-2 border-2 border-[#1A1A1A] p-3 dark:border-[#4B5563]",
                step.id === activeStepId ? "bg-[#FFF7CC] dark:bg-[#1A2841]" : "bg-[#FBFAF7] dark:bg-[#0F1A2C]",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <PhaseIcon phase={phase} running={running} />
                <span className="font-code text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
                  {String(step.index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-[9rem] flex-1 text-sm font-bold">{step.title}</span>
                <Badge tone={presentation.tone}>{presentation.label}</Badge>
              </div>
              <p className={cx("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-black uppercase tracking-[0.12em]", TEXT_MUTED)}>
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden="true" className="inline-block h-2 w-2 border border-[#1A1A1A]" style={{ backgroundColor: networkColor(step.network) }} />
                  {networkName(step.network)}
                </span>
                {destination ? (
                  <span className="inline-flex items-center gap-1">
                    →
                    <span aria-hidden="true" className="inline-block h-2 w-2 border border-[#1A1A1A]" style={{ backgroundColor: networkColor(destination) }} />
                    {networkName(destination)}
                  </span>
                ) : null}
                {received ? <span className="normal-case tracking-normal">Received {received}</span> : null}
              </p>
              {step.failure ? (
                <p className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]">{step.failure.message}</p>
              ) : null}
              <StepLinks step={step} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const OUTCOME_COPY: Partial<Record<IntentGraph["status"], { title: string; tone: "green" | "yellow" | "red" | "neutral" }>> = {
  completed: { title: "Intent completed", tone: "green" },
  partially_completed: { title: "Intent partially completed", tone: "yellow" },
  failed: { title: "Intent failed", tone: "red" },
  expired: { title: "Intent expired", tone: "neutral" },
  cancelled: { title: "Intent cancelled", tone: "neutral" },
};

/** Final summary once an intent reached a terminal status. */
export function IntentOutcome({ intent, footer, className }: { intent: IntentGraph; footer?: React.ReactNode; className?: string }) {
  const copy = OUTCOME_COPY[intent.status];
  if (!copy) return null;
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const settled = steps.filter((step) => step.status === "settled");
  const received = settled
    .filter((step) => !steps.some((other) => other.dependsOn.includes(step.id)))
    .map((step) => formatAmount(step.actualOutput ?? step.expectedOutput))
    .filter((value): value is string => Boolean(value));
  const background =
    copy.tone === "green"
      ? "bg-[#DCFCE7] dark:bg-[#0F2A1D]"
      : copy.tone === "red"
        ? "bg-[#FFE4E4] dark:bg-[#2A1215]"
        : copy.tone === "yellow"
          ? "bg-[#FFF3B0] dark:bg-[#2A2410]"
          : "bg-[#F1EFE8] dark:bg-[#1A2841]";
  return (
    <section aria-label="Intent outcome" className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, background, className)}>
      <div className="flex flex-wrap items-center gap-2">
        {copy.tone === "green" ? (
          <CircleCheck className="h-6 w-6 text-[#047857] dark:text-[#14F195]" aria-hidden="true" />
        ) : (
          <CircleX className="h-6 w-6 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />
        )}
        <h3 className="font-display text-2xl font-bold tracking-[-0.02em]">{copy.title}</h3>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Steps settled</dt>
          <dd className="font-display text-xl font-bold">
            {settled.length} / {steps.length}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Received</dt>
          <dd className="font-display text-xl font-bold">{received.join(" + ") || "—"}</dd>
        </div>
      </dl>
      <ul className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.id} className="flex flex-col gap-1.5 border-t-2 border-dashed border-[#1A1A1A]/20 pt-2 dark:border-white/10">
            <span className="text-sm font-bold">
              {String(step.index + 1).padStart(2, "0")} · {step.title} — {humanize(step.status)}
            </span>
            <StepLinks step={step} />
          </li>
        ))}
      </ul>
      {footer}
    </section>
  );
}
