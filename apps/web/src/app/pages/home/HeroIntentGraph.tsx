import { ArrowRight, Check, LoaderCircle, Pause, PenLine, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Link } from "../../routes/Link";
import { Typewriter } from "../../site/motion/Typewriter";
import { useAutoPause } from "../../site/motion/useAutoPause";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { cx, FOCUS_RING } from "../../site/ui/styles";
import { studioHref } from "../protocols/protocolExamples";
import {
  exitStage,
  HERO_SCENARIOS,
  holdStage,
  settledStage,
  stageDuration,
  stepStatus,
  type StepStatus,
} from "./heroScenarios";
import { NetworkMap } from "./NetworkMap";

/** Full cycles through the three examples before the window rests. */
const MAX_CYCLES = 2;

interface PlayState {
  readonly scenario: number;
  readonly stage: number;
  /** Completed passes through all scenarios. */
  readonly cycle: number;
  /** Bumps on every (re)start so typed text and one-shot effects replay. */
  readonly run: number;
  /** After two cycles: rest on example 1, final state, no packets. */
  readonly resting: boolean;
}

const STATUS_STYLE: Record<StepStatus, { readonly label: string; readonly className: string }> = {
  waiting: { label: "Queued", className: "bg-[#F1EFE8] text-[#45464B] dark:bg-[#1A2841] dark:text-[#A9B6C8]" },
  awaiting: { label: "Awaiting signature", className: "bg-[#FFD60A] text-[#1A1A1A]" },
  submitted: { label: "Submitted", className: "bg-[#9945FF] text-white" },
  settled: { label: "Settled", className: "bg-[#14F195] text-[#0B1120]" },
};

function StatusChip({ status, animate }: { readonly status: StepStatus; readonly animate: boolean }) {
  const style = STATUS_STYLE[status];
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 border-2 border-[#1A1A1A] px-1.5 py-0.5 font-code text-[10px] font-bold uppercase tracking-[0.06em] dark:border-[#4B5563]",
        style.className,
        animate && status === "settled" && "kl-stamp",
      )}
    >
      {status === "awaiting" ? <PenLine className="h-3 w-3" aria-hidden="true" /> : null}
      {status === "submitted" ? <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
      {status === "settled" ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
      {style.label}
    </span>
  );
}

/**
 * Hero "intent compiler" window: types a real grammar example, compiles it
 * into tokens, draws the route on a network map and walks each step from
 * "awaiting signature" to "settled". Three examples cycle twice, then the
 * window rests. Autoplay runs only on screen in a visible tab, the pause
 * button stops everything, and reduced motion shows the final state.
 */
export function HeroIntentGraph() {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const { ref: pauseRef, active } = useAutoPause<HTMLDivElement>({ paused });
  const [play, setPlay] = useState<PlayState>({ scenario: 0, stage: 0, cycle: 0, run: 0, resting: false });

  const scenario = HERO_SCENARIOS[play.scenario] ?? HERO_SCENARIOS[0]!;
  // Reduced motion and the resting state show the final state with no motion.
  const still = reduced || play.resting;
  const stage = still ? settledStage(scenario) : play.stage;
  const exiting = !still && stage === exitStage(scenario);

  const advance = useCallback(() => {
    setPlay((current) => {
      const currentScenario = HERO_SCENARIOS[current.scenario] ?? HERO_SCENARIOS[0]!;
      if (current.resting) return current;
      if (current.stage < exitStage(currentScenario)) return { ...current, stage: current.stage + 1 };
      const nextScenario = (current.scenario + 1) % HERO_SCENARIOS.length;
      const cycle = nextScenario === 0 ? current.cycle + 1 : current.cycle;
      if (cycle >= MAX_CYCLES) return { scenario: 0, stage: 0, cycle, run: current.run + 1, resting: true };
      return { scenario: nextScenario, stage: 0, cycle, run: current.run + 1, resting: false };
    });
  }, []);

  // Stage timer (stage 0 advances when typing finishes).
  useEffect(() => {
    if (still || !active) return undefined;
    const duration = stageDuration(scenario, play.stage);
    if (duration === null) return undefined;
    const timer = window.setTimeout(advance, duration);
    return () => window.clearTimeout(timer);
  }, [still, active, scenario, play.stage, play.run, advance]);

  const onTyped = useCallback(() => {
    setPlay((current) => (current.stage === 0 && !current.resting ? { ...current, stage: 1 } : current));
  }, []);

  const jumpTo = (index: number) => {
    setPlay((current) => ({
      scenario: index,
      stage: 0,
      cycle: current.cycle,
      run: current.run + 1,
      // A jump after the window came to rest shows that example's final state.
      resting: current.resting,
    }));
  };

  const compiled = stage >= 1;
  const packets = !still && active && stage >= 2 && stage <= holdStage(scenario);

  return (
    <figure className="relative">
      <figcaption className="sr-only">
        Three example intents and the plans Kletia compiles for them.{" "}
        {HERO_SCENARIOS.map((item, index) => (
          <span key={item.id}>
            Example {index + 1}: “{item.prompt}”. {item.description}{" "}
          </span>
        ))}
      </figcaption>

      <div
        ref={pauseRef}
        className="relative border-[3px] border-[#1A1A1A] bg-[#FBFAF7] shadow-hard-xl dark:border-[#4B5563] dark:bg-[#131E32]"
      >
        {/* Window chrome */}
        <div className="flex items-center justify-between gap-2 border-b-[3px] border-[#1A1A1A] bg-[#1A1A1A] px-3 py-1.5 text-white dark:border-[#4B5563] dark:bg-[#060A14]">
          <span aria-hidden="true" className="flex shrink-0 gap-1.5">
            <span className="h-3 w-3 border-2 border-[#1A1A1A] bg-[#FF5A5F]" />
            <span className="h-3 w-3 border-2 border-[#1A1A1A] bg-[#FFD60A]" />
            <span className="h-3 w-3 border-2 border-[#1A1A1A] bg-[#14F195]" />
          </span>
          <span aria-hidden="true" className="min-w-0 truncate font-code text-[11px] text-white/75">
            kletia · intent compiler
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {reduced ? null : (
              <button
                type="button"
                aria-pressed={paused}
                onClick={() => setPaused((value) => !value)}
                title={paused ? "Play animation" : "Pause animation"}
                className={cx(
                  "inline-flex h-8 w-8 items-center justify-center border-2 border-white/40 text-white transition-colors duration-150 hover:border-[#FFD60A] hover:text-[#FFD60A] motion-reduce:transition-none",
                  "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]",
                )}
              >
                {paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
                <span className="sr-only">Pause animation</span>
              </button>
            )}
            <span aria-hidden="true" className="hidden border-2 border-white/30 px-1.5 font-code text-[10px] uppercase text-white/80 sm:inline">
              dry run · example
            </span>
          </span>
        </div>

        <div aria-hidden="true" className={cx("transition-opacity duration-300 motion-reduce:transition-none", exiting ? "opacity-0" : "opacity-100")}>
          {/* Prompt and compile output */}
          <div className="border-b-[3px] border-[#1A1A1A] bg-white px-4 py-3 dark:border-[#4B5563] dark:bg-[#0B1120]">
            <p className="relative min-h-[3rem] font-code text-[13px] leading-6 text-[#1A1A1A] dark:text-[#E2E8F0] sm:text-sm">
              {stage === 1 && !still ? (
                <span
                  key={`${play.run}-scan`}
                  className="kl-fill-x pointer-events-none absolute inset-0 bg-[#FFD60A]/35 dark:bg-[#FFD60A]/15"
                  style={{ animationDuration: "350ms" }}
                />
              ) : null}
              <span className="relative">
                <span className="mr-2 font-bold text-[#0052FF] dark:text-[#7EA6FF]">&gt;</span>
                {still ? (
                  scenario.prompt
                ) : (
                  <Typewriter
                    key={play.run}
                    text={scenario.prompt}
                    speed={28}
                    startDelay={250}
                    play={active}
                    onDone={onTyped}
                    caret={stage === 0}
                    caretClassName="kl-caret kl-loop ml-0.5 inline-block h-4 w-2 translate-y-0.5 bg-[#0052FF] dark:bg-[#FFD60A]"
                  />
                )}
              </span>
            </p>
            <div className="mt-2 flex min-h-[1.75rem] flex-wrap items-center gap-1.5">
              {compiled
                ? scenario.tokens.map((token, index) => (
                    <span
                      key={`${play.run}-${token}`}
                      className={cx(
                        "border-2 border-[#1A1A1A] bg-[#FFF7CC] px-1.5 font-code text-[11px] font-bold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-[#F1F5F9]",
                        !still && "kl-pop",
                      )}
                      style={still ? undefined : { animationDelay: `${index * 60}ms` }}
                    >
                      {token}
                    </span>
                  ))
                : null}
              {compiled ? (
                <span
                  key={`${play.run}-compiled`}
                  className={cx(
                    "inline-flex items-center gap-1 font-code text-[11px] font-bold text-[#0B7A4B] dark:text-[#14F195]",
                    !still && "kl-fade-in",
                  )}
                  style={still ? undefined : { animationDelay: `${scenario.tokens.length * 60 + 120}ms` }}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  compiled · {scenario.summary}
                </span>
              ) : null}
            </div>
          </div>

          {/* Network map */}
          <div className="border-b-[3px] border-[#1A1A1A] px-2 py-2 dark:border-[#4B5563] sm:px-3">
            <NetworkMap key={play.run} scenario={scenario} stage={stage} packets={packets} still={still} />
          </div>

          {/* Steps */}
          <ol className="divide-y-2 divide-dashed divide-[#1A1A1A]/20 border-b-[3px] border-[#1A1A1A] bg-white dark:divide-white/10 dark:border-[#4B5563] dark:bg-[#0B1120]">
            {scenario.steps.map((step, index) => {
              const status = stepStatus(scenario, stage, index);
              return (
                <li key={`${play.run}-${index}`} className="flex flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="font-display text-sm font-bold text-[#0052FF] dark:text-[#7EA6FF]">{String(index + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 text-[13px] font-semibold leading-snug">
                      {step.title} <span className="text-[#45464B] dark:text-[#A9B6C8]">· {step.venue}</span>
                    </span>
                  </span>
                  <StatusChip key={status} status={status} animate={!still} />
                </li>
              );
            })}
          </ol>
        </div>

        {/* Footer: summary, example switcher and the Studio link */}
        <div className="flex flex-col gap-3 bg-[#FBFAF7] px-4 py-3 dark:bg-[#131E32] sm:flex-row sm:items-center sm:justify-between">
          <p aria-hidden="true" className="font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">
            {scenario.signatures} · advances on on-chain evidence
          </p>
          <div className="flex items-center justify-between gap-4 sm:justify-end">
            <div role="group" aria-label="Examples" className="flex items-center gap-1">
              {HERO_SCENARIOS.map((item, index) => {
                const current = index === play.scenario;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={current}
                    aria-label={item.label}
                    onClick={() => jumpTo(index)}
                    className={cx("group inline-flex h-8 w-8 items-center justify-center", FOCUS_RING)}
                  >
                    <span
                      aria-hidden="true"
                      className={cx(
                        "block h-3.5 w-3.5 border-2 border-[#1A1A1A] transition-[background-color,transform] duration-150 ease-kl-snap motion-reduce:transition-none dark:border-[#CBD5E1]",
                        current ? "scale-110 bg-[#0052FF] dark:bg-[#FFD60A]" : "bg-transparent group-hover:bg-[#1A1A1A]/20 dark:group-hover:bg-white/20",
                      )}
                    />
                  </button>
                );
              })}
            </div>
            <Link
              to={studioHref(scenario.prompt)}
              className={cx(
                "group/run inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap text-[11px] font-black uppercase tracking-[0.12em] text-[#0052FF] underline decoration-2 underline-offset-4 dark:text-[#7EA6FF]",
                FOCUS_RING,
              )}
            >
              Run this in Studio
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform duration-150 group-hover/run:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover/run:translate-x-0"
                aria-hidden="true"
              />
              <span className="sr-only">: {scenario.prompt}</span>
            </Link>
          </div>
        </div>
      </div>
    </figure>
  );
}
