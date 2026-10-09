import { Icon } from "../../site/art/Icon";
import { HalftoneEdge } from "../../site/art/Ornaments";
import { Ticket } from "../../site/art/Ticket";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx } from "../../site/ui/styles";
import { DRY_RUN_INTENT, DRY_RUN_LEGS, DRY_RUN_SERIAL, HERO_FROM, HERO_TO } from "./homeExamples";

/** The last stop: a yellow notice with a planned (unsigned) ticket for a dry run. */
export function FinalCta() {
  return (
    <section
      aria-labelledby="final-cta-heading"
      className="relative overflow-hidden border-t-[3px] border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] [--kla-muted:#3A3B3F] [--kla-table:#FFD60A] [--kla-text:#1A1A1A] dark:border-[#4B5563] [&_:focus-visible]:!outline-[#1A1A1A]"
    >
      <HalftoneEdge className="text-[#1A1A1A]" />
      <div className={cx(CONTAINER, "relative grid items-center gap-12 pb-20 pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:pb-24 lg:pt-14")}>
        <div className="max-w-3xl">
          <p className="font-code text-[11px] font-extrabold uppercase tracking-[0.2em]">Start with a dry run</p>
          <h2
            id="final-cta-heading"
            className="mt-4 text-balance font-display text-[clamp(2.4rem,6.4vw,4.25rem)] font-bold leading-[0.98] tracking-[-0.045em]"
          >
            Plan your first route without signing anything.
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-[#1A1A1A]/85">
            A dry run quotes every leg and stores nothing. When the plan looks right, run it with the wallets your users already
            have, or drop in the widget and skip most of the code.
          </p>
          <div className="mt-10 flex w-full flex-col gap-4 sm:w-auto sm:flex-row">
            {/* Blue is the primary action everywhere, on the yellow notice too. */}
            <ButtonLink
              to="/developers#keys"
              size="lg"
              className="w-full !border-[#1A1A1A] !shadow-[3px_3px_0_#1A1A1A] [--kla-plate:#FFD60A] sm:w-auto"
            >
              <Icon name="key" size={20} />
              Get an API key
            </ButtonLink>
            <ButtonLink
              to="/studio"
              variant="secondary"
              size="lg"
              className="w-full !border-[#1A1A1A] !bg-white !text-[#1A1A1A] !shadow-[3px_3px_0_#1A1A1A] sm:w-auto"
            >
              Open Studio
            </ButtonLink>
          </div>
        </div>
        <div className="min-w-0 lg:[&_.kla-ticket-wrap]:rotate-[2.5deg] [&_.kla-ticket-wrap]:[filter:drop-shadow(8px_8px_0_#1A1A1A)]">
          <Ticket
            serial={DRY_RUN_SERIAL}
            intent={DRY_RUN_INTENT}
            from={HERO_FROM}
            to={HERO_TO}
            legs={DRY_RUN_LEGS}
            state="planned"
            ticketClass="Dry run"
            example
            animateStamp
          />
        </div>
      </div>
    </section>
  );
}
