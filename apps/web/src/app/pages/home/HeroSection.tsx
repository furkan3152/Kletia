import { ArrowRight } from "lucide-react";

import { Link } from "../../routes/Link";
import { Icon } from "../../site/art/Icon";
import { RouteMapCard } from "../../site/art/MapCard";
import { Ticket } from "../../site/art/Ticket";
import { countWord, PRODUCTION } from "../../site/registryCopy";
import { ButtonLink } from "../../site/ui/Button";
import { CONTAINER, cx, FOCUS_RING, TEXT_MUTED } from "../../site/ui/styles";
import { studioHref } from "../protocols/protocolExamples";
import { HERO_FROM, HERO_INTENT, HERO_SERIAL, HERO_TO, heroLegs } from "./homeExamples";

const FACTS = [
  "MIT licensed",
  "Non-custodial: the API never signs",
  "CAIP-2, CAIP-10 and CAIP-19 ids",
  "REST, SDK, widget, iframe, MCP",
] as const;

/** The map's title block: an edition date from the day the page is read (the map is drawn from today's registry). */
function mapEdition(): string {
  const now = new Date();
  return `${now.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${now.getUTCFullYear()}`;
}

export interface HeroSectionProps {
  /** Venues Kletia can call (live /v1/protocols when available, else the registry). */
  readonly venues: number;
}

/**
 * Home hero: the sentence, the route map it travels on and the ticket it
 * prints. The map and the ticket are illustrations; everything they say is
 * also in the copy on the left.
 */
export function HeroSection({ venues }: HeroSectionProps) {
  const production = PRODUCTION.length;
  return (
    <section
      aria-labelledby="hero-heading"
      className="kla-grain relative overflow-hidden border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]"
    >
      <div
        className={cx(
          CONTAINER,
          "relative grid items-start gap-12 pb-16 pt-12 sm:pb-20 sm:pt-16 xl:grid-cols-[minmax(0,0.84fr)_minmax(0,1.16fr)] xl:gap-14 xl:pb-24",
        )}
      >
        <div className="min-w-0 xl:pt-6">
          <p className="inline-flex max-w-full items-center gap-2.5 border-[3px] border-[#1A1A1A] bg-[#FBFAF7] px-3 py-1.5 font-code text-[11px] font-bold uppercase leading-snug tracking-[0.12em] shadow-hard-sm dark:border-[#4B5563] dark:bg-[#131E32]">
            <Icon name="route" size={18} />
            <span>
              Intent routing API · {production} networks · {venues} venues
            </span>
          </p>

          <h1
            id="hero-heading"
            className="mt-7 text-balance font-display text-[clamp(2.5rem,7.6vw,4.4rem)] font-bold leading-[0.98] tracking-[-0.045em] xl:text-[clamp(2.6rem,4.6vw,4.4rem)]"
          >
            Route money across {countWord(production)} networks from a single sentence.
          </h1>

          <p className={cx("mt-7 max-w-xl text-lg leading-relaxed sm:text-[1.2rem]", TEXT_MUTED)}>
            Send Kletia <q className="font-semibold text-[#1A1A1A] dark:text-white">bridge 50 USDC from Base to Solana, then swap half to JitoSOL</q>.
            It plans two legs, quotes each one and returns unsigned transactions. Your users sign them in their own wallets,
            and Kletia marks a leg done only after it reads it on-chain.
          </p>

          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
            <ButtonLink to="/developers#keys" size="lg" className="w-full [--kla-plate:#FFD60A] sm:w-auto">
              <Icon name="key" size={20} />
              Get an API key
            </ButtonLink>
            <ButtonLink to={studioHref(HERO_INTENT)} variant="secondary" size="lg" className="w-full sm:w-auto">
              Try a route in Studio
            </ButtonLink>
          </div>
          <p className={cx("mt-4 text-sm", TEXT_MUTED)}>
            <Link
              to="/app"
              className={cx(
                "group inline-flex min-h-9 items-center gap-1.5 font-semibold underline decoration-2 underline-offset-4 hover:text-[#1A1A1A] dark:hover:text-white",
                FOCUS_RING,
              )}
            >
              or open the console
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
            </Link>
          </p>

          <ul className="mt-9 flex flex-wrap gap-2" aria-label="Facts">
            {FACTS.map((fact) => (
              <li
                key={fact}
                className="border-2 border-[#1A1A1A]/35 px-2.5 py-1.5 font-code text-[11.5px] font-semibold leading-none text-[#45464B] dark:border-white/25 dark:text-[#A9B6C8]"
              >
                {fact}
              </li>
            ))}
          </ul>
        </div>

        <figure className="relative m-0 min-w-0 px-1 pt-7 sm:px-7">
          <RouteMapCard margin slug={<>Map 01 · {mapEdition()} · Not to scale</>} />
          <div className="relative z-[2] mt-8 sm:-ml-5 sm:-mt-14 [&_.kla-ticket-wrap]:w-[min(560px,100%)] sm:[&_.kla-ticket-wrap]:-rotate-[1.5deg] [&_.kla-ticket-wrap]:origin-top-left motion-reduce:[&_.kla-ticket-wrap]:transition-none">
            <Ticket
              serial={HERO_SERIAL}
              intent={HERO_INTENT}
              from={HERO_FROM}
              to={HERO_TO}
              legs={heroLegs([true, true])}
              state="settled"
              ticketClass="Live"
              example
              animateStamp
            />
          </div>
          <figcaption className={cx("mt-6 max-w-2xl font-code text-[11.5px] font-medium leading-relaxed", TEXT_MUTED)}>
            Map 01, not to scale. A line means Kletia can plan on that network. A station is a venue it can call. The testnets
            are parked in their own yard.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
