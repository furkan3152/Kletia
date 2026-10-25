import type { IntentGraph, IntentStep, Journey } from "@kletia/core";
import { journeyModel } from "@kletia/widget/review";
import { CircleAlert, CircleCheck, CircleX, ExternalLink, LoaderCircle, PenLine, Radio } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef } from "react";

import { whereMoneyIs } from "../art/journeyFormat";

import { stepExplorerLinks } from "../../../shared/platform/intentLinks";
import type { LocalStepPhase } from "../../../shared/platform/useIntentExecution";
import { AnimatedNumber } from "../motion/AnimatedNumber";
import { useCelebrateOnce } from "../motion/celebrate";
import { useAutoPause } from "../motion/useAutoPause";
import { useChangeKey } from "../motion/useChangeKey";
import { Badge } from "../ui/Badge";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../ui/styles";
import { toast } from "../ui/toast";
import { formatAmount, humanize, networkColor, networkName } from "./format";
import { nudgePen, useBoundedLoop } from "./phaseMotion";
import { PHASE_PRESENTATION, progressBadge, progressStepPhase, type FlowStatus, type StepDisplayPhase } from "./stepPhase";
import { StepProgressBar } from "./StepProgressBar";

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
  /**
   * Show a silent toast when a step settles while this panel is scrolled out
   * of view (the polite announcement below still does the speaking).
   */
  readonly notifySettled?: boolean;
  /**
   * The run's status (the execution hook's). When the run stopped (failed,
   * paused, cancelled) the badge says so and steps the wallet never signed
   * read "Not signed", so the panel agrees with the task's header.
   */
  readonly flowStatus?: FlowStatus;
  /** Steps whose signature request has no known outcome: shown as "Check your wallet", never as not signed. */
  readonly signatureUnknownStepIds?: readonly string[];
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
              "inline-flex min-h-9 items-center gap-1.5 border-2 border-[#121212] bg-[#FBFAF6] px-2 py-1 text-[11px] font-black uppercase tracking-[0.1em] text-[#1A36B0] hover:bg-[#E1E8FF] dark:border-[#4A4A52] dark:bg-[#0E0E10] dark:text-[#93C5FD] dark:hover:bg-[#14213D]",
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
  const phaseKey = useChangeKey(phase);
  const penRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (phaseKey > 0 && phase === "awaiting_signature") nudgePen(penRef.current);
  }, [phase, phaseKey]);
  if (phase === "settled") {
    return (
      <CircleCheck
        className={cx("h-4 w-4 text-[#047857] dark:text-[#4ADE80]", phaseKey > 0 && "kl-stamp")}
        aria-hidden="true"
      />
    );
  }
  if (phase === "failed") return <CircleX className="h-4 w-4 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />;
  if (phase === "awaiting_signature" && running) {
    return <PenLine ref={penRef} className="h-4 w-4 origin-bottom-left text-[#121212] dark:text-[#C6FF3A]" aria-hidden="true" />;
  }
  if (running && LIVE_PHASES.has(phase)) {
    return <LoaderCircle className="h-4 w-4 animate-spin text-[#1A36B0] motion-reduce:animate-none dark:text-[#8FA6FF]" aria-hidden="true" />;
  }
  return <span aria-hidden="true" className="inline-block h-3 w-3 border-2 border-[#121212] dark:border-[#94A3B8]" />;
}

/** Static outline once the signature ring has pulsed for a few seconds (and the reduced-motion look). */
const ATTENTION_REST = "outline outline-[3px] outline-offset-[3px] outline-[#C6FF3A]";

function ProgressRow({
  step,
  phase,
  active,
  running,
}: {
  step: IntentStep;
  phase: StepDisplayPhase;
  active: boolean;
  running: boolean;
}) {
  const presentation = PHASE_PRESENTATION[phase];
  const phaseKey = useChangeKey(phase);
  const changed = phaseKey > 0;
  const attention = running && phase === "awaiting_signature";
  const ringLoop = useBoundedLoop(attention);
  const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
  const received = formatAmount(step.actualOutput);
  return (
    <li
      aria-current={active ? "step" : undefined}
      data-phase={phase}
      className={cx(
        "relative flex flex-col gap-2 border-2 border-[#121212] p-3 transition-colors duration-240 dark:border-[#4A4A52]",
        active ? "bg-[#EEFBC8] dark:bg-[#232327]" : "bg-[#FBFAF6] dark:bg-[#151517]",
        attention && (ringLoop ? "kl-attn-ring" : ATTENTION_REST),
        changed && phase === "failed" && "kl-shake",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <PhaseIcon phase={phase} running={running} />
        <span className="font-code text-xs font-bold text-[#5C5850] dark:text-[#9A968C]">
          {String(step.index + 1).padStart(2, "0")}
        </span>
        <span className="min-w-[9rem] flex-1 text-sm font-bold">{step.title}</span>
        <Badge
          tone={presentation.tone}
          className={cx(phase === "preparing" && running && "kl-shimmer", changed && phase === "settled" && "kl-stamp")}
        >
          {presentation.label}
        </Badge>
      </div>
      <p className={cx("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-black uppercase tracking-[0.12em]", TEXT_MUTED)}>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="inline-block h-2 w-2 border border-[#121212]" style={{ backgroundColor: networkColor(step.network) }} />
          {networkName(step.network)}
        </span>
        {destination ? (
          <span className="inline-flex items-center gap-1">
            →
            <span aria-hidden="true" className="inline-block h-2 w-2 border border-[#121212]" style={{ backgroundColor: networkColor(destination) }} />
            {networkName(destination)}
          </span>
        ) : null}
        {received ? <span className="normal-case tracking-normal">Received {received}</span> : null}
      </p>
      {step.failure ? (
        <p className={cx("text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]", changed && phase === "failed" && "kl-rise")}>
          {step.failure.message}
        </p>
      ) : null}
      <StepLinks step={step} />
    </li>
  );
}

/** Silent "Step N settled" toasts while the progress panel is scrolled away. */
function useSettledToasts(intent: IntentGraph, enabled: boolean, panel: React.RefObject<HTMLElement | null>) {
  const seenRef = useRef<{ id: string; settled: Set<string> } | null>(null);
  useEffect(() => {
    const settled = new Set(intent.steps.filter((step) => step.status === "settled").map((step) => step.id));
    const seen = seenRef.current;
    seenRef.current = { id: intent.id, settled };
    // The first render of an intent only records what was already settled.
    if (!enabled || !seen || seen.id !== intent.id) return;
    const element = panel.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) return;
    for (const step of intent.steps) {
      if (!settled.has(step.id) || seen.settled.has(step.id)) continue;
      const network = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork ?? step.network : step.network;
      toast.success(`Step ${step.index + 1} settled on ${networkName(network)}`, {
        id: `step-settled:${intent.id}:${step.id}`,
        silent: true,
      });
    }
  }, [intent, enabled, panel]);
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
  notifySettled = false,
  flowStatus,
  signatureUnknownStepIds = [],
  className,
}: IntentProgressProps) {
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const phaseOf = (step: IntentStep) =>
    progressStepPhase(step, phases[step.id], { running, signatureUnknown: signatureUnknownStepIds.includes(step.id) });
  const badge = progressBadge(intent, flowStatus ?? (running ? "executing" : "paused"));
  const active = steps.find((step) => step.id === activeStepId) ?? null;
  const activePhase = active ? phaseOf(active) : null;
  const wallet = active && walletFor ? walletFor(active) : null;
  const announcement = active && activePhase
    ? `Step ${active.index + 1}, ${active.title}: ${PHASE_PRESENTATION[activePhase].label}.`
    : `Intent ${badge.label.toLowerCase()}.`;
  const sectionRef = useRef<HTMLElement | null>(null);
  const { ref: pauseRef } = useAutoPause<HTMLElement>();
  const setSection = useCallback(
    (node: HTMLElement | null) => {
      sectionRef.current = node;
      pauseRef(node);
    },
    [pauseRef],
  );
  useSettledToasts(intent, notifySettled, sectionRef);

  return (
    <section
      ref={setSection}
      aria-label="Execution progress"
      className={cx("flex flex-col gap-3 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE, className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={LABEL}>Progress</p>
        <div className="flex flex-wrap items-center gap-2">
          {streaming && running ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-[#047857] dark:text-[#4ADE80]">
              <Radio className="h-3.5 w-3.5" aria-hidden="true" />
              Live
            </span>
          ) : null}
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
      </div>
      <StepProgressBar intent={intent} phases={phases} running={running} phaseOf={phaseOf} />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {running && active && activePhase === "awaiting_signature" ? (
        <p className="kl-rise border-[3px] border-[#121212] bg-[#C6FF3A] px-3 py-2 text-sm font-black text-[#121212] dark:border-[#4A4A52]">
          Confirm step {active.index + 1} in {wallet ?? "your wallet"}.
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <ProgressRow
            key={step.id}
            step={step}
            phase={phaseOf(step)}
            active={step.id === activeStepId}
            running={running}
          />
        ))}
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
export function IntentOutcome({
  intent,
  footer,
  celebrate = false,
  journey = null,
  className,
}: {
  intent: IntentGraph;
  footer?: React.ReactNode;
  /**
   * This view watched the intent run (it saw a non-terminal state first), so
   * a completion may celebrate, once per intent per tab. Opening an intent
   * that was already complete never celebrates.
   */
  celebrate?: boolean;
  /**
   * The journey of this intent: "Where your money is now" replaces
   * "Received" (which hid arrival stops when a later leg did not run).
   */
  journey?: Journey | null;
  className?: string;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const copy = OUTCOME_COPY[intent.status];
  const money = useMemo(() => {
    if (!journey || journey.intentId !== intent.id) return [];
    return whereMoneyIs(journey, journeyModel(journey));
  }, [intent.id, journey]);
  useCelebrateOnce(intent.id, Boolean(copy) && celebrate && intent.status === "completed", cardRef);
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
          : "bg-[#E6E2D9] dark:bg-[#232327]";
  const entrance = copy.tone === "green" || copy.tone === "yellow" ? "kl-drop" : "kl-fade-in";
  return (
    <section
      ref={cardRef}
      aria-label="Intent outcome"
      className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, background, entrance, className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        {copy.tone === "green" ? (
          <span
            aria-hidden="true"
            className="kl-stamp flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#121212] bg-[#4ADE80] text-[#0E0E10] shadow-[3px_3px_0_#121212] dark:border-[#4A4A52] dark:shadow-[3px_3px_0_#2A2A30]"
            style={{ animationDelay: "160ms" }}
          >
            <CircleCheck className="h-6 w-6" strokeWidth={2.5} />
          </span>
        ) : copy.tone === "yellow" ? (
          <span
            aria-hidden="true"
            className="kl-stamp flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#121212] bg-[#C6FF3A] text-[#121212] shadow-[3px_3px_0_#121212] dark:border-[#4A4A52] dark:shadow-[3px_3px_0_#2A2A30]"
            style={{ animationDelay: "160ms" }}
          >
            <CircleAlert className="h-6 w-6" strokeWidth={2.5} />
          </span>
        ) : (
          <CircleX className="h-6 w-6 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />
        )}
        <h3 className="font-display text-2xl font-bold tracking-[-0.02em]">{copy.title}</h3>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Steps settled</dt>
          <dd className="font-display text-xl font-bold">
            <AnimatedNumber value={settled.length} duration={700} startOnView={false} /> / {steps.length}
          </dd>
        </div>
        {money.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Where your money is now</dt>
            {money.map((line) => (
              <dd key={`${line.stopId}-${line.sentence}`} className="font-display text-xl font-bold">
                <span className="sr-only">{line.spoken}: </span>
                {line.sentence}
                {line.usd ? <span className={cx("ml-2 font-code text-sm font-semibold", TEXT_MUTED)}>≈ {line.usd}</span> : null}
              </dd>
            ))}
          </div>
        ) : (
          <div className="sm:col-span-2">
            <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Received</dt>
            <dd className="font-display text-xl font-bold">{received.join(" + ") || "—"}</dd>
          </div>
        )}
      </dl>
      <ul className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.id} className="flex flex-col gap-1.5 border-t-2 border-dashed border-[#121212]/20 pt-2 dark:border-white/10">
            <span className="text-sm font-bold">
              {String(step.index + 1).padStart(2, "0")} · {step.title}: {humanize(step.status)}
            </span>
            <StepLinks step={step} />
          </li>
        ))}
      </ul>
      {footer}
    </section>
  );
}
