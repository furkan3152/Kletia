import type { AccountId, IntentGraph, IntentStep } from "@kletia/core";
import { CirclePause, OctagonX, PenLine, Play, RefreshCw, TriangleAlert } from "lucide-react";
import React from "react";

import type { IntentExecution, IntentExecutionError } from "../../../shared/platform/useIntentExecution";
import { ApiErrorPanel } from "../ui/ApiErrorPanel";
import { Button } from "../ui/Button";
import { cx, INK_BORDER, LABEL } from "../ui/styles";
import { IntentGraphView } from "./IntentGraphView";
import { IntentOutcome, IntentProgress, StepLinks } from "./IntentProgress";
import { IntentReview } from "./IntentReview";
import { withLocalPhases } from "./stepPhase";

/** An execution or planning failure, with a retry when it can help. */
export function ExecutionErrorPanel({
  error,
  title,
  onRetry,
  retryLabel = "Retry",
}: {
  error: IntentExecutionError;
  title: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  if (error.platform) {
    return (
      <ApiErrorPanel
        error={{ ...error.platform, retryable: error.retryable }}
        title={title}
        {...(onRetry ? { onRetry } : {})}
      />
    );
  }
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#FFE4E4] p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2] dark:shadow-[4px_4px_0_#7F1D1D]"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-display text-lg font-bold leading-tight">{title}</p>
          <p className="mt-1 text-sm">{error.message}</p>
        </div>
      </div>
      {onRetry && error.retryable ? (
        <Button size="sm" variant="secondary" onClick={onRetry} className="self-start">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

export interface IntentExecutionFlowProps {
  readonly execution: IntentExecution;
  /** Label for the wallet behind an account (review + progress hints). */
  readonly describeAccount?: (accountId: AccountId) => string | null;
  /** Wallet that prompts for a step, e.g. "Phantom". */
  readonly walletFor?: (step: IntentStep) => string | null;
  /** Re-plan with fresh quotes (review) or after a planning failure. */
  readonly onReplan?: () => void;
  /** Draw the full intent graph under the progress list. */
  readonly showGraph?: boolean;
  /** Extra content for the final summary (links to activity, "plan another"). */
  readonly outcomeFooter?: React.ReactNode;
  readonly className?: string;
}

/**
 * Everything after planning: review with explicit confirmation, live
 * progress, pauses that need the user, errors with retry and the final
 * summary. Wallet-free; the caller owns the `useIntentExecution` controller.
 */
export function IntentExecutionFlow({
  execution,
  describeAccount,
  walletFor,
  onReplan,
  showGraph = true,
  outcomeFooter,
  className,
}: IntentExecutionFlowProps) {
  const { intent, status, error } = execution;

  if (!intent) {
    if (status === "failed" && error) {
      return (
        <div className={className}>
          <ExecutionErrorPanel error={error} title="Planning failed" {...(onReplan ? { onRetry: onReplan } : {})} />
        </div>
      );
    }
    return null;
  }

  if (status === "review" || status === "planning") {
    return (
      <div className={cx("flex flex-col gap-6", className)}>
        <IntentReview
          intent={intent}
          busy={status === "planning"}
          onConfirm={() => void execution.start(intent)}
          {...(describeAccount ? { describeAccount } : {})}
          {...(onReplan ? { onReplan } : {})}
        />
        {showGraph ? <IntentGraphView intent={intent} /> : null}
      </div>
    );
  }

  const terminal = status === "completed" || status === "cancelled" || (status === "failed" && isTerminal(intent));
  const live = withLocalPhases(intent, execution.stepPhases);
  const signing = Object.values(execution.stepPhases).includes("signing");
  const anySubmitted = intent.steps.some((step) => (step.references?.length ?? 0) > 0 || !["pending", "ready", "awaiting_signature"].includes(step.status));

  return (
    <div className={cx("flex flex-col gap-6", className)}>
      {status === "paused" ? (
        <div role="status" className={cx("flex flex-col gap-3 bg-[#FFF3B0] p-4 text-[#1A1A1A]", INK_BORDER)}>
          <p className={cx(LABEL, "flex items-center gap-2")}>
            <CirclePause className="h-4 w-4" aria-hidden="true" />
            Paused
          </p>
          <p className="text-sm font-semibold">{execution.pauseReason ?? "Execution is paused."}</p>
          <div className="flex flex-wrap gap-2">
            {execution.reconfirmStepIds.length > 0 ? (
              <Button size="sm" onClick={() => void execution.resume(intent.id, { confirmResign: true })}>
                <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
                I checked my wallet — sign again
              </Button>
            ) : (
              <Button size="sm" onClick={() => void execution.resume(intent.id)}>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Resume
              </Button>
            )}
            {!anySubmitted ? (
              <Button size="sm" variant="secondary" onClick={() => void execution.cancel()}>
                <OctagonX className="h-3.5 w-3.5" aria-hidden="true" />
                Cancel intent
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {status === "failed" && error ? (
        <ExecutionErrorPanel
          error={error}
          title={error.stepId ? "A step did not go through" : "Execution stopped"}
          {...(!terminal ? { onRetry: () => void execution.resume(intent.id), retryLabel: "Retry from here" } : {})}
        />
      ) : null}

      {terminal ? <IntentOutcome intent={intent} footer={outcomeFooter} /> : null}

      {!terminal ? (
        <IntentProgress
          intent={live}
          phases={execution.stepPhases}
          activeStepId={execution.activeStepId}
          streaming={execution.streaming}
          running={status === "executing"}
          {...(walletFor ? { walletFor } : {})}
        />
      ) : null}

      {status === "executing" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => void execution.cancel()} disabled={signing}>
            <OctagonX className="h-3.5 w-3.5" aria-hidden="true" />
            {anySubmitted ? "Stop following" : "Cancel intent"}
          </Button>
          {signing ? (
            <span className="text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
              To stop now, reject the request in your wallet.
            </span>
          ) : null}
        </div>
      ) : null}

      {showGraph ? <IntentGraphView intent={live} stepFooter={(step) => <StepLinks step={step} />} /> : null}
    </div>
  );
}

function isTerminal(intent: IntentGraph): boolean {
  return ["completed", "partially_completed", "failed", "expired", "cancelled"].includes(intent.status);
}
