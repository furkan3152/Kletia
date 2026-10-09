import { ArrowRight, Pause, Play, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAutoPause } from "../../site/motion/useAutoPause";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx } from "../../site/ui/styles";
import { CtaMesh } from "./CtaMesh";

/** One dot period of `.kl-dot-backdrop`: drifting by exactly this loops seamlessly. */
const DOT_PERIOD = 22;

export function FinalCta() {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const { ref, active } = useAutoPause<HTMLElement>({ paused });
  const dotsRef = useRef<HTMLDivElement | null>(null);
  const driftRef = useRef<Animation | null>(null);

  // The dot backdrop drifts (one compositor animation on an oversized layer, 40 s per period).
  useEffect(() => {
    const dots = dotsRef.current;
    if (reduced || !dots || typeof dots.animate !== "function") return undefined;
    const animation = dots.animate(
      [{ transform: "translate3d(0, 0, 0)" }, { transform: `translate3d(${DOT_PERIOD}px, ${DOT_PERIOD}px, 0)` }],
      { duration: 40_000, iterations: Infinity, easing: "linear" },
    );
    animation.pause();
    driftRef.current = animation;
    return () => {
      animation.cancel();
      driftRef.current = null;
    };
  }, [reduced]);

  useEffect(() => {
    const animation = driftRef.current;
    if (!animation) return;
    if (active) animation.play();
    else animation.pause();
  }, [active, reduced]);

  return (
    <section
      ref={ref}
      aria-labelledby="final-cta-heading"
      className="relative overflow-hidden border-t-[3px] border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#4B5563]"
    >
      <div
        ref={dotsRef}
        aria-hidden="true"
        className="kl-dot-backdrop pointer-events-none absolute -inset-[44px] dark:![background-image:radial-gradient(rgba(26,26,26,0.18)_1.5px,transparent_1.5px)]"
      />
      <div className={cx(CONTAINER, "relative grid items-center gap-10 py-20 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:py-24")}>
        <div className="max-w-3xl">
          <p className="text-[11px] font-black uppercase tracking-[0.2em]">Ship intents, not integrations</p>
          <h2
            id="final-cta-heading"
            className="mt-4 text-balance font-display text-[clamp(2.4rem,7vw,5rem)] font-bold leading-[0.95] tracking-[-0.045em] lg:text-[4.25rem]"
          >
            Put cross-chain intents in your product.
          </h2>
          <p className="mt-6 max-w-xl text-lg text-[#1A1A1A]/80">
            Get a developer key, plan your first intent with a dry run, and execute it with the wallets your users
            already have. Or drop in the widget and ship today.
          </p>
          <div className="mt-10 flex w-full flex-col gap-4 sm:w-auto sm:flex-row">
            <ButtonLink
              to="/developers#keys"
              variant="ink"
              size="lg"
              className="w-full dark:!bg-[#1A1A1A] dark:!text-white dark:hover:!bg-black sm:w-auto"
            >
              <Terminal className="h-4 w-4" aria-hidden="true" />
              Get a developer key
            </ButtonLink>
            <ButtonLink to="/studio" variant="secondary" size="lg" className="w-full !border-[#1A1A1A] !bg-white !text-[#1A1A1A] !shadow-[3px_3px_0_#1A1A1A] sm:w-auto">
              Try Intent Studio
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </ButtonLink>
          </div>
        </div>
        <div className="relative hidden h-[20rem] border-[3px] border-[#1A1A1A] bg-[#FFE45C]/70 p-3 shadow-[8px_8px_0_#1A1A1A] lg:block">
          <CtaMesh active={active} still={reduced} />
          <span aria-hidden="true" className="absolute left-3 top-3 border-2 border-[#1A1A1A] bg-white px-1.5 font-code text-[10px] font-bold uppercase tracking-[0.12em]">
            production lane · illustration
          </span>
        </div>
      </div>
      {reduced ? null : (
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => setPaused((value) => !value)}
          title={paused ? "Play background animation" : "Pause background animation"}
          className={cx(
            "absolute bottom-3 right-3 inline-flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow] duration-90 ease-kl-snap active:translate-x-[3px] active:translate-y-[3px] active:shadow-none sm:h-9 sm:w-9",
            "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF]",
          )}
        >
          {paused ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
          <span className="sr-only">Pause background animation</span>
        </button>
      )}
    </section>
  );
}
