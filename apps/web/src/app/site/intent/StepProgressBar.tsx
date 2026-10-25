import type { IntentGraph, IntentStep } from "@kletia/core";

import type { LocalStepPhase } from "../../../shared/platform/useIntentExecution";
import { cx } from "../ui/styles";
import { stepDisplayPhase, type StepDisplayPhase } from "./stepPhase";

/** How far each phase fills its segment, and in which colour. */
const SEGMENT: Readonly<Record<StepDisplayPhase, { fill: number; color: string; hatch?: boolean }>> = {
  waiting: { fill: 0, color: "#0052FF" },
  ready: { fill: 0, color: "#0052FF" },
  skipped: { fill: 0, color: "#94A3B8" },
  preparing: { fill: 0.15, color: "#0052FF" },
  awaiting_signature: { fill: 0.35, color: "#FFD60A", hatch: true },
  unconfirmed: { fill: 0.35, color: "#FFD60A", hatch: true },
  not_signed: { fill: 0, color: "#94A3B8" },
  signature_unknown: { fill: 0.35, color: "#FFD60A" },
  submitted: { fill: 0.6, color: "#6D28D9", hatch: true },
  settling: { fill: 0.8, color: "#6D28D9", hatch: true },
  settled: { fill: 1, color: "#4ADE80" },
  failed: { fill: 1, color: "#FF5A5F" },
};

export interface StepProgressBarProps {
  readonly intent: IntentGraph;
  readonly phases?: Readonly<Record<string, LocalStepPhase>>;
  /** False while paused or stopped: in-flight segments keep their fill but stop moving. */
  readonly running?: boolean;
  /** The phase each segment shows (default: `stepDisplayPhase` with the local phases). */
  readonly phaseOf?: (step: IntentStep) => StepDisplayPhase;
  readonly className?: string;
}

/**
 * One segment per step, filled by its phase (transform only). Exposed as a
 * progressbar of settled steps; it is not a live region, so the progress
 * list's polite announcement stays the single source of speech.
 */
export function StepProgressBar({ intent, phases = {}, running = true, phaseOf, className }: StepProgressBarProps) {
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const phaseFor = phaseOf ?? ((step: IntentStep) => stepDisplayPhase(step, phases[step.id]));
  const settled = steps.filter((step) => phaseFor(step) === "settled").length;
  return (
    <div
      role="progressbar"
      aria-label="Steps settled"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={settled}
      aria-valuetext={`${settled} of ${steps.length} step${steps.length === 1 ? "" : "s"} settled`}
      className={cx(
        "flex h-4 w-full gap-[3px] border-[3px] border-[#121212] bg-[#121212] dark:border-[#4A4A52] dark:bg-[#4A4A52]",
        className,
      )}
    >
      {steps.map((step) => {
        const phase = phaseFor(step);
        const segment = SEGMENT[phase];
        return (
          <span
            key={step.id}
            data-phase={phase}
            className={cx(
              "relative min-w-0 flex-1 overflow-hidden bg-[#E6E2D9] dark:bg-[#151517]",
              segment.hatch && running && "kl-hatch",
            )}
          >
            <span
              aria-hidden="true"
              className="absolute inset-0 origin-left transition-transform duration-240 ease-kl-out motion-reduce:transition-none"
              style={{ backgroundColor: segment.color, transform: `scaleX(${segment.fill})` }}
            />
          </span>
        );
      })}
    </div>
  );
}
