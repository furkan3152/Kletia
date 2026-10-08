import { ArrowRight, Terminal } from "lucide-react";

import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx } from "../../site/ui/styles";

export function FinalCta() {
  return (
    <section
      aria-labelledby="final-cta-heading"
      className="kl-dot-backdrop relative overflow-hidden border-t-[3px] border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#4B5563]"
    >
      <div className={cx(CONTAINER, "relative flex flex-col items-start gap-10 py-20 lg:flex-row lg:items-end lg:justify-between lg:py-28")}>
        <div className="max-w-3xl">
          <p className="text-[11px] font-black uppercase tracking-[0.2em]">Ship intents, not integrations</p>
          <h2
            id="final-cta-heading"
            className="mt-4 text-balance font-display text-[clamp(2.4rem,7vw,5rem)] font-bold leading-[0.95] tracking-[-0.045em]"
          >
            Put cross-chain intents in your product.
          </h2>
          <p className="mt-6 max-w-xl text-lg text-[#1A1A1A]/80">
            Get a developer key, plan your first intent with a dry run, and execute it with the wallets your
            users already have.
          </p>
        </div>
        <div className="flex w-full flex-col gap-4 sm:w-auto sm:flex-row lg:flex-col xl:flex-row">
          <ButtonLink to="/developers#keys" variant="ink" size="lg" className="w-full dark:!bg-[#1A1A1A] dark:!text-white dark:hover:!bg-black sm:w-auto">
            <Terminal className="h-4 w-4" aria-hidden="true" />
            Get a developer key
          </ButtonLink>
          <ButtonLink to="/studio" variant="secondary" size="lg" className="w-full !bg-white !text-[#1A1A1A] sm:w-auto">
            Try Intent Studio
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
