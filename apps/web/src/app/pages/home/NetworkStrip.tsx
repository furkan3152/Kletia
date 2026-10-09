import { CHAINS, type ProtocolDescriptor } from "@kletia/core";
import { ArrowRight } from "lucide-react";

import { MAINNET_NETWORKS } from "../../../shared/platform/registry";
import { Link } from "../../routes/Link";
import { Marquee, MarqueeChip } from "../../site/motion/Marquee";
import { Reveal } from "../../site/motion/Reveal";
import { Badge } from "../../site/ui/Badge";
import { Monogram } from "../../site/ui/Monogram";
import { CONTAINER, cx, FOCUS_RING, INK_BORDER, LABEL, LIFT, SHADOW_HARD, TEXT_MUTED } from "../../site/ui/styles";

const FEATURED = [...MAINNET_NETWORKS, "arc" as const].map((key) => CHAINS[key]);
const TESTNETS = Object.values(CHAINS).filter((chain) => chain.environment === "testnet" && chain.key !== "arc");

export interface NetworkStripProps {
  /** Live `/v1/protocols` when available, else the registry. */
  readonly protocols: readonly ProtocolDescriptor[];
}

/** Networks from CHAINS and a protocol ticker (monograms and names only, no third-party marks). */
export function NetworkStrip({ protocols }: NetworkStripProps) {
  return (
    <section
      aria-labelledby="network-strip-heading"
      className="border-b-[3px] border-[#1A1A1A] bg-white dark:border-[#4B5563] dark:bg-[#0E1729]"
    >
      <div className={cx(CONTAINER, "py-12 sm:py-14")}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h2 id="network-strip-heading" className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
            One intent spec. Two virtual machines.
          </h2>
          <p className={cx("text-sm", TEXT_MUTED)}>
            {Object.keys(CHAINS).length} networks · {protocols.length} protocol integrations in the registry
          </p>
        </div>

        <Reveal as="ul" stagger className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURED.map((chain) => (
            <li
              key={chain.key}
              data-reveal-item
              className={cx("group relative flex min-w-0 bg-[#FBFAF7] pl-[19px] dark:bg-[#131E32]", INK_BORDER, SHADOW_HARD, LIFT)}
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-4 origin-left scale-x-75 transition-transform duration-240 ease-kl-snap group-hover:scale-x-100 group-focus-within:scale-x-100 motion-reduce:transition-none"
                style={{ backgroundColor: chain.color }}
              />
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-3 w-[3px] bg-[#1A1A1A] transition-transform duration-240 ease-kl-snap group-hover:translate-x-1 group-focus-within:translate-x-1 motion-reduce:transition-none dark:bg-[#4B5563]"
              />
              <div className="min-w-0 flex-1 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 font-display text-xl font-bold leading-tight">{chain.name}</p>
                  <Badge tone={chain.vm === "svm" ? "purple" : "blue"}>{chain.vm === "svm" ? "SVM" : "EVM"}</Badge>
                </div>
                <p className="mt-2 truncate font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]" title={chain.id}>
                  {chain.id}
                </p>
                <p className={cx(LABEL, "mt-3 !text-[10px]", chain.lane === "testnet" ? "text-[#B45309] dark:text-[#FFD60A]" : "text-[#0B7A4B] dark:text-[#14F195]")}>
                  {chain.lane === "testnet" ? "Testnet lane" : "Production lane"}
                </p>
              </div>
            </li>
          ))}
          <li data-reveal-item className="flex min-w-0">
            <Link
              to="/networks"
              className={cx(
                "group/all flex w-full flex-col justify-between gap-3 border-[3px] border-dashed border-[#1A1A1A]/50 p-4 transition-colors duration-150 hover:border-[#1A1A1A] hover:bg-[#FFF7CC] motion-reduce:transition-none dark:border-white/25 dark:hover:border-white/60 dark:hover:bg-[#1A2841]",
                FOCUS_RING,
              )}
            >
              <span className="font-display text-xl font-bold leading-tight">Live network status</span>
              <span className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em]">
                RPC health & capabilities
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover/all:translate-x-1 motion-reduce:transition-none" aria-hidden="true" />
              </span>
            </Link>
          </li>
        </Reveal>
        <p className={cx("mt-5 flex flex-wrap items-center gap-2 text-xs", TEXT_MUTED)}>
          <Badge tone="yellow">Testnets</Badge>
          {TESTNETS.map((chain) => (
            <Badge key={chain.key} tone="outline" dot={chain.color}>
              {chain.name}
            </Badge>
          ))}
          <span>Mainnet and testnet capital never share an intent graph.</span>
        </p>
      </div>

      <Marquee
        label="Protocols in the Kletia registry"
        speed={36}
        gap={12}
        className="border-t-[3px] border-[#1A1A1A] bg-[#FFD60A] dark:border-[#4B5563] dark:bg-[#1A2841]"
        listClassName="py-4"
      >
        {protocols.map((protocol) => (
          <MarqueeChip key={protocol.id} className="pl-1.5">
            <Monogram name={protocol.name} category={protocol.category} size="sm" className="!h-7 !w-7 !border-2 text-[11px] !shadow-none [&>span]:hidden" />
            {protocol.name}
          </MarqueeChip>
        ))}
      </Marquee>
      <div className="border-t-[3px] border-[#1A1A1A] bg-[#111318] dark:border-[#4B5563] dark:bg-[#060A14]">
        <div className={cx(CONTAINER, "flex flex-wrap items-center justify-between gap-3 py-3")}>
          <p className="text-xs text-white/70">Execute, quote or discover: every venue with what Kletia can do there.</p>
          <Link
            to="/protocols"
            className={cx(
              "group/browse inline-flex min-h-9 items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-[#FFD60A] underline decoration-2 underline-offset-4",
              "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#FFD60A]",
            )}
          >
            Browse all {protocols.length} protocols
            <ArrowRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover/browse:translate-x-1 motion-reduce:transition-none" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
