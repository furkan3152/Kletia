import { ArrowRight, Terminal } from "lucide-react";

import { cssVars } from "../../site/motion/tokens";
import { useAutoPause } from "../../site/motion/useAutoPause";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { HeroIntentGraph } from "./HeroIntentGraph";

/** Floating shapes drift for two cycles, then rest (calm by default). */
const FLOAT_LIMIT = "![animation-iteration-count:2]";

export function HeroSection() {
  // Pauses the decorative floats when the hero is off-screen or the tab is hidden.
  const { ref } = useAutoPause<HTMLElement>();
  return (
    <section
      ref={ref}
      aria-labelledby="hero-heading"
      className="kl-grid-backdrop relative overflow-hidden border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <span
          className={cx(
            "kl-float absolute -left-8 top-24 hidden h-24 w-24 rotate-12 border-[3px] border-[#1A1A1A] bg-[#0052FF] shadow-hard [--kl-rotate:12deg] dark:border-[#4B5563] xl:block",
            FLOAT_LIMIT,
          )}
        />
        <span
          className={cx(
            "kl-float absolute bottom-10 left-[38%] hidden h-10 w-40 -rotate-6 rounded-full border-[3px] border-[#1A1A1A] bg-[#FFD60A] shadow-hard [--kl-rotate:-6deg] [animation-delay:1.5s] dark:border-[#4B5563] lg:block",
            FLOAT_LIMIT,
          )}
        />
        <span className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,#9945FF33,transparent_70%)]" />
        <span className="absolute -bottom-32 right-1/4 h-80 w-80 rounded-full bg-[radial-gradient(circle,#14F19526,transparent_70%)]" />
      </div>

      <div className={cx(CONTAINER, "relative grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-12 lg:py-20")}>
        <div className="min-w-0">
          <p
            className={cx(
              LABEL,
              "inline-flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-3 py-1.5 shadow-hard-sm dark:border-[#4B5563] dark:bg-[#131E32]",
            )}
          >
            <span aria-hidden="true" className="flex gap-0.5">
              <span className="h-2.5 w-2.5 bg-[#0052FF]" />
              <span className="h-2.5 w-2.5 bg-[#9945FF]" />
              <span className="h-2.5 w-2.5 bg-[#14F195]" />
            </span>
            Intent infrastructure for EVM + Solana
          </p>

          <h1
            id="hero-heading"
            className="mt-7 font-display text-[clamp(2.6rem,8.4vw,4.9rem)] font-bold leading-[0.95] tracking-[-0.045em]"
          >
            Say the{" "}
            <span className="relative inline-block">
              <span className="relative z-10 px-1 text-[#1A1A1A]">outcome.</span>
              <span aria-hidden="true" className="absolute inset-x-0 bottom-[0.08em] top-[0.18em] -rotate-1 bg-[#FFD60A]" />
            </span>
            <br />
            Kletia moves it{" "}
            <span className="relative inline-block whitespace-nowrap">
              across chains.
              <span
                aria-hidden="true"
                className="kl-fill-x absolute -bottom-1 left-0 h-[0.14em] w-full bg-[linear-gradient(90deg,#0052FF_0%,#0052FF_33%,#9945FF_33%,#9945FF_66%,#14F195_66%)]"
                style={{ ...cssVars({ "--kl-delay": "300ms" }), animationDuration: "700ms" }}
              />
            </span>
          </h1>

          <p className={cx("mt-8 max-w-xl text-lg leading-relaxed sm:text-xl", TEXT_MUTED)}>
            Kletia compiles financial intents into verified, wallet-signed steps across EVM networks and Solana — as a
            console for users, and an API, SDK, React widget and iframe embed for teams that want intents in their own
            product.
          </p>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
            <ButtonLink to="/app" size="lg" className="w-full sm:w-auto">
              Launch app
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </ButtonLink>
            <ButtonLink to="/developers" variant="secondary" size="lg" className="w-full sm:w-auto">
              <Terminal className="h-4 w-4" aria-hidden="true" />
              Build with Kletia
            </ButtonLink>
          </div>

          <ul className="mt-10 flex flex-wrap gap-x-5 gap-y-2 font-code text-xs text-[#45464B] dark:text-[#A9B6C8]" aria-label="Key properties">
            <li>✓ Non-custodial</li>
            <li>✓ CAIP-2 / 10 / 19 identities</li>
            <li>✓ EVM + SVM</li>
            <li>✓ Embeddable</li>
            <li>✓ MIT licensed</li>
          </ul>
        </div>

        <div className="min-w-0 lg:pl-2">
          <HeroIntentGraph />
        </div>
      </div>
    </section>
  );
}
