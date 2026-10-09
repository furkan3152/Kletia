import type { IntentGraph, IntentStep } from "@kletia/core";
import { CircleAlert, CircleCheck, CircleX, ExternalLink, LoaderCircle, PenLine, Radio } from "lucide-react";
import React, { useCallback, useEffect, useRef } from "react";

import { stepExplorerLinks } from "../../../shared/platform/intentLinks";
import type { LocalStepPhase } from "../../../shared/platform/useIntentExecution";
import { AnimatedNumber } from "../motion/AnimatedNumber";
import { useCelebrateOnce } from "../motion/celebrate";
import { useAutoPause } from "../motion/useAutoPause";
import { useChangeKey } from "../motion/useChangeKey";
import { Badge } from "../ui/Badge";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../ui/styles";
import { toast } from "../ui/toast";
import { formatAmount, humanize, networkColor, networkName, STATUS_TONE } from "./format";
import { nudgePen, useBoundedLoop } from "./phaseMotion";
import { PHASE_PRESENTATION, stepDisplayPhase, type StepDisplayPhase } from "./stepPhase";
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
    return <PenLine ref={penRef} className="h-4 w-4 origin-bottom-left text-[#1A1A1A] dark:text-[#FFD60A]" aria-hidden="true" />;
  }
  if (running && LIVE_PHASES.has(phase)) {
    return <LoaderCircle className="h-4 w-4 animate-spin text-[#0052FF] motion-reduce:animate-none dark:text-[#7EA6FF]" aria-hidden="true" />;
  }
  return <span aria-hidden="true" className="inline-block h-3 w-3 border-2 border-[#1A1A1A] dark:border-[#94A3B8]" />;
}

/** Static outline once the signature ring has pulsed for a few seconds (and the reduced-motion look). */
const ATTENTION_REST = "outline outline-[3px] outline-offset-[3px] outline-[#FFD60A]";

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
        "relative flex flex-col gap-2 border-2 border-[#1A1A1A] p-3 transition-colors duration-240 dark:border-[#4B5563]",
        active ? "bg-[#FFF7CC] dark:bg-[#1A2841]" : "bg-[#FBFAF7] dark:bg-[#0F1A2C]",
        attention && (ringLoop ? "kl-attn-ring" : ATTENTION_REST),
        changed && phase === "failed" && "kl-shake",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <PhaseIcon phase={phase} running={running} />
        <span className="font-code text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
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
  className,
}: IntentProgressProps) {
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const active = steps.find((step) => step.id === activeStepId) ?? null;
  const activePhase = active ? stepDisplayPhase(active, phases[active.id]) : null;
  const wallet = active && walletFor ? walletFor(active) : null;
  const announcement = active && activePhase
    ? `Step ${active.index + 1}, ${active.title}: ${PHASE_PRESENTATION[activePhase].label}.`
    : `Intent ${humanize(intent.status)}.`;
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
          {streaming ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-[#047857] dark:text-[#4ADE80]">
              <Radio className="h-3.5 w-3.5" aria-hidden="true" />
              Live
            </span>
          ) : null}
          <Badge tone={STATUS_TONE[intent.status] ?? "neutral"}>{humanize(intent.status)}</Badge>
        </div>
      </div>
      <StepProgressBar intent={intent} phases={phases} running={running} />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {running && active && activePhase === "awaiting_signature" ? (
        <p className="kl-rise border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-3 py-2 text-sm font-black text-[#1A1A1A] dark:border-[#4B5563]">
          Confirm step {active.index + 1} in {wallet ?? "your wallet"}.
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {steps.map((step) => (
          <ProgressRow
            key={step.id}
            step={step}
            phase={stepDisplayPhase(step, phases[step.id])}
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
  className?: string;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const copy = OUTCOME_COPY[intent.status];
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
          : "bg-[#F1EFE8] dark:bg-[#1A2841]";
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
            className="kl-stamp flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#4ADE80] text-[#0B1120] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]"
            style={{ animationDelay: "160ms" }}
          >
            <CircleCheck className="h-6 w-6" strokeWidth={2.5} />
          </span>
        ) : copy.tone === "yellow" ? (
          <span
            aria-hidden="true"
            className="kl-stamp flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]"
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
        <div className="sm:col-span-2">
          <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Received</dt>
          <dd className="font-display text-xl font-bold">{received.join(" + ") || "—"}</dd>
        </div>
      </dl>
      <ul className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.id} className="flex flex-col gap-1.5 border-t-2 border-dashed border-[#1A1A1A]/20 pt-2 dark:border-white/10">
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
