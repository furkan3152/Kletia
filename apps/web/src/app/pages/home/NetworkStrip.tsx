import { CHAINS, PROTOCOLS } from "@kletia/core";

import { MAINNET_NETWORKS } from "../../../shared/platform/registry";
import { Badge } from "../../site/ui/Badge";
import { CONTAINER, cx, LABEL, TEXT_MUTED } from "../../site/ui/styles";

const FEATURED = [...MAINNET_NETWORKS, "arc" as const].map((key) => CHAINS[key]);
const TESTNETS = Object.values(CHAINS).filter((chain) => chain.environment === "testnet" && chain.key !== "arc");

function ProtocolRow({ clone = false }: { clone?: boolean }) {
  return (
    <ul
      aria-hidden={clone || undefined}
      className={cx("flex shrink-0 items-center gap-3 pr-3", clone && "kl-marquee-clone")}
    >
      {PROTOCOLS.map((protocol) => (
        <li
          key={protocol.id}
          className="whitespace-nowrap border-2 border-[#1A1A1A] bg-white px-3 py-1.5 font-display text-sm font-bold uppercase tracking-wide text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-[#E2E8F0]"
        >
          {protocol.name}
        </li>
      ))}
    </ul>
  );
}

/** Networks from CHAINS and protocol names from PROTOCOLS (text only, no third-party marks). */
export function NetworkStrip() {
  return (
    <section
      aria-labelledby="network-strip-heading"
      className="border-b-[3px] border-[#1A1A1A] bg-white dark:border-[#4B5563] dark:bg-[#0E1729]"
    >
      <div className={cx(CONTAINER, "py-12")}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h2 id="network-strip-heading" className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
            One intent spec. Two virtual machines.
          </h2>
          <p className={cx("text-sm", TEXT_MUTED)}>
            {Object.keys(CHAINS).length} networks · {PROTOCOLS.length} protocol integrations in the registry
          </p>
        </div>

        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURED.map((chain) => (
            <li
              key={chain.key}
              className="group relative flex items-stretch border-[3px] border-[#1A1A1A] bg-[#FBFAF7] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[4px_4px_0_#475569]"
            >
              <span aria-hidden="true" className="w-3 shrink-0 border-r-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: chain.color }} />
              <div className="min-w-0 flex-1 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-display text-xl font-bold leading-tight">{chain.name}</p>
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
        </ul>
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

      <div className="kl-marquee-host relative overflow-hidden border-t-[3px] border-[#1A1A1A] bg-[#FFD60A] py-4 dark:border-[#4B5563] dark:bg-[#1A2841]">
        <h3 className="sr-only">Protocols in the Kletia registry</h3>
        <div className="kl-marquee flex w-max">
          <ProtocolRow />
          <ProtocolRow clone />
        </div>
      </div>
    </section>
  );
}
