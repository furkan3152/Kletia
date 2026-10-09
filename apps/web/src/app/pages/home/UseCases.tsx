import type { NetworkKey } from "@kletia/core";
import { ArrowRight } from "lucide-react";
import { Fragment } from "react";

import { Link } from "../../routes/Link";
import { LINES, type IconName } from "../../site/art";
import { Icon } from "../../site/art/Icon";
import { LineBullet } from "../../site/art/LineBullet";
import { Reveal } from "../../site/motion/Reveal";
import { countWordTitle } from "../../site/registryCopy";
import { Section } from "../../site/ui/Section";
import { cx, FOCUS_RING } from "../../site/ui/styles";
import { studioHref } from "../protocols/protocolExamples";

interface UseCase {
  readonly title: string;
  readonly body: string;
  readonly example: string;
  /** Networks the example sentence travels, in order (names and colours come from the registry). */
  readonly route: readonly NetworkKey[];
  readonly icon: IconName;
}

const USE_CASES: readonly UseCase[] = [
  {
    title: "Wallets",
    body: "Offer swaps, bridges and staking on EVM and Solana without integrating each venue yourself.",
    example: "move 0.01 ETH from arbitrum to solana as SOL",
    route: ["arbitrum", "solana"],
    icon: "key",
  },
  {
    title: "Payments and neobanks",
    body: "Take USDC on one network, settle it where your treasury lives, and reconcile from signed webhooks.",
    example: "bridge 25 USDC from base to solana",
    route: ["base", "solana"],
    icon: "transfer",
  },
  {
    title: "Agents",
    body: "An agent proposes a plan through the API or MCP, and a person signs it. Paid calls can settle over x402.",
    example: "swap 1 SOL to USDC",
    route: ["solana"],
    icon: "route",
  },
  {
    title: "Treasuries",
    body: "Move stablecoins between networks and park idle USDC in a lending market, with evidence for every leg.",
    example: "bridge 20 USDC from solana to base and deposit it into aave",
    route: ["solana", "base"],
    icon: "lend",
  },
  {
    title: "Games",
    body: "Top up an in-game balance from whichever network the player's funds are on.",
    example: "bridge 50 USDC from base to solana then swap half to JitoSOL",
    route: ["base", "solana"],
    icon: "swap",
  },
];

/** The lines a route travels: bullets joined by a short length of track. */
function RouteLines({ route }: { readonly route: readonly NetworkKey[] }) {
  const lines = route.map((key) => LINES[key]);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="sr-only">{lines.length > 1 ? `${lines.map((line) => line.name).join(" to ")}.` : `On ${lines[0]!.name}.`}</span>
      {lines.map((line, index) => (
        <Fragment key={line.key}>
          {index > 0 ? <span
              aria-hidden="true"
              className="h-2.5 w-7 [background:linear-gradient(#1A1A1A,#1A1A1A)_center/100%_2px_no-repeat,repeating-linear-gradient(90deg,#1A1A1A_0_2px,transparent_2px_7px)_center/100%_10px_no-repeat]"
            /> : null}
          <LineBullet line={line} decorative />
        </Fragment>
      ))}
      {lines.length === 1 ? (
        <span aria-hidden="true" className="font-code text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#55565B]">
          one line
        </span>
      ) : null}
    </p>
  );
}

/**
 * Routes people ask for, printed as a timetable: route number, the service,
 * the lines it travels and the sentence that books it. Printed stock: the
 * timetable keeps its ink at night.
 */
export function UseCases() {
  return (
    <Section
      id="use-cases"
      platform={7}
      eyebrow="Routes people ask for"
      reveal
      title={`${countWordTitle(USE_CASES.length)} products that move money between networks.`}
      intro="Each example is a sentence the v1 grammar accepts today. Open one in Studio to see its legs."
    >
      <div className="kla-grain border-[3px] border-[#1A1A1A] bg-[#FFFCF2] text-[#1A1A1A] shadow-hard-lg dark:bg-[#ECE6D6] [--kla-grain:var(--kla-stock-grain)] [--kla-plate:#FFD60A]">
        <p className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 bg-[#1A1A1A] px-5 py-3 font-code text-xs font-extrabold uppercase leading-tight tracking-[0.18em] text-[#FFD60A] sm:px-6">
          <span>Timetable · routes in service</span>
          <span className="font-semibold text-[#F4F1EA]">Valid on the v1 grammar</span>
        </p>
        <div
          aria-hidden="true"
          className="hidden grid-cols-[3rem_minmax(0,1.15fr)_9.5rem_minmax(0,1fr)_9rem] gap-x-6 border-b-[3px] border-[#1A1A1A] px-6 py-2.5 font-code text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#55565B] lg:grid"
        >
          <span>Route</span>
          <span>Service</span>
          <span>Lines</span>
          <span>Say</span>
          <span />
        </div>
        <Reveal as="ol" stagger className="px-5 sm:px-6">
          {USE_CASES.map((useCase, index) => (
            <li
              key={useCase.title}
              data-reveal-item
              className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 border-b-[1.5px] border-dashed border-[#1A1A1A]/40 py-6 last:border-b-0 lg:grid-cols-[3rem_minmax(0,1.15fr)_9.5rem_minmax(0,1fr)_9rem] lg:items-start lg:gap-x-6"
            >
              <span
                aria-hidden="true"
                className="row-span-2 mt-0.5 flex h-8 w-10 items-center justify-center bg-[#1A1A1A] font-code text-[13px] font-extrabold text-[#F4F1EA] lg:row-span-1"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <h3 className="flex items-center gap-2.5 font-display text-xl font-bold leading-snug tracking-[-0.015em]">
                  <Icon name={useCase.icon} size={24} />
                  {useCase.title}
                </h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-[#45464B]">{useCase.body}</p>
              </div>
              <div className="col-start-2 lg:col-start-auto lg:pt-1.5">
                <RouteLines route={useCase.route} />
              </div>
              <p className="col-start-2 font-code text-[13px] font-semibold leading-relaxed [overflow-wrap:anywhere] lg:col-start-auto lg:pt-1">
                <span className="text-[#0047E0]" aria-hidden="true">
                  &gt;{" "}
                </span>
                {useCase.example}
              </p>
              <Link
                to={studioHref(useCase.example)}
                className={cx(
                  "group/try col-start-2 inline-flex min-h-9 items-center gap-1.5 self-start justify-self-start whitespace-nowrap text-xs font-black uppercase tracking-[0.12em] text-[#0047E0] underline decoration-2 underline-offset-4 lg:col-start-auto lg:justify-self-end",
                  FOCUS_RING,
                )}
              >
                Open in Studio
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover/try:translate-x-1 motion-reduce:transition-none" aria-hidden="true" />
                <span className="sr-only">: {useCase.example}</span>
              </Link>
            </li>
          ))}
        </Reveal>
      </div>
    </Section>
  );
}
