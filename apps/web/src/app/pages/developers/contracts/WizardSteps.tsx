import { Check } from "lucide-react";

import { cx, FOCUS_RING } from "../../../site/ui/styles";

export interface WizardStep {
  readonly n: number;
  readonly label: string;
}

export interface WizardStepsProps {
  readonly steps: readonly WizardStep[];
  readonly current: number;
  /** Highest step reached; earlier steps are buttons. */
  readonly reached: number;
  /** Steps with open issues (marked, never coloured only). */
  readonly flagged?: readonly number[];
  readonly onGo: (n: number) => void;
}

/** The wizard as stations on a line: done, here, ahead; with an "!" on stations that have open issues. */
export function WizardSteps({ steps, current, reached, flagged = [], onGo }: WizardStepsProps) {
  return (
    <nav aria-label="Steps" className="min-w-0">
      <ol className="flex min-w-0 flex-wrap gap-x-1 gap-y-2">
        {steps.map((step, index) => {
          const here = step.n === current;
          const done = step.n < current;
          const open = step.n <= reached;
          const issue = flagged.includes(step.n);
          return (
            <li key={step.n} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <span aria-hidden="true" className={cx("hidden h-[3px] w-4 sm:block", step.n <= reached ? "bg-[#121212] dark:bg-[#D6D2C8]" : "bg-[#121212]/25 dark:bg-white/20")} /> : null}
              <button
                type="button"
                disabled={!open}
                onClick={() => onGo(step.n)}
                aria-current={here ? "step" : undefined}
                className={cx(
                  "inline-flex min-h-10 items-center gap-2 border-[3px] px-2.5 text-[12px] font-black uppercase tracking-[0.1em] disabled:cursor-not-allowed",
                  here
                    ? "border-[#121212] bg-[#C6FF3A] text-[#121212] dark:border-[#C6FF3A]"
                    : done
                      ? "border-[#121212] bg-[#FBFAF6] text-[#121212] dark:border-[#4A4A52] dark:bg-[#19191C] dark:text-white"
                      : "border-dashed border-[#121212]/40 text-[#5C5850] dark:border-white/25 dark:text-[#9A968C]",
                  FOCUS_RING,
                )}
              >
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-current font-code text-[12px]">
                  {done && !issue ? <Check className="h-3 w-3" aria-hidden="true" /> : step.n}
                </span>
                {step.label}
                {issue ? (
                  <>
                    <span aria-hidden="true" className={cx("font-code text-[12px]", here ? "text-[#9F1239]" : "text-[#B91C1C] dark:text-[#FCA5A5]")}>
                      !
                    </span>
                    <span className="sr-only">(has issues)</span>
                  </>
                ) : null}
                {done && !issue ? <span className="sr-only">(done)</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
