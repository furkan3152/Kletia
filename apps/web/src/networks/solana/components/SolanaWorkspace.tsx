import React from "react";
import { formatAccountId, sameAccount } from "@kletia/core";
import { LoaderCircle, ScrollText } from "lucide-react";

import { LazyBoundary } from "../../../shared/components/LazyBoundary";
import { ActivityFeed } from "../../../shared/sync/ActivityFeed";
import { useKletiaEvent } from "../../../shared/sync/bus";
import { useSolanaWallet } from "../../../shared/wallet/solana/solanaWalletContext";
import { parsePortfolio, solanaPaths } from "../api";
import { useSolanaResource } from "../hooks/useSolanaResource";
import { SOLANA_TABS, type SolanaTab } from "../solanaTabs";
import { PanelHeader } from "./SolanaUi";
import { SolanaOverview } from "./SolanaOverview";
import { SolanaSend } from "./SolanaSend";
import { SolanaStake } from "./SolanaStake";
import { SolanaSwap } from "./SolanaSwap";
import { SolanaYields } from "./SolanaYields";

// The Ask tab pulls the intent graph view and the shared execution hook;
// load it only when the tab is opened.
const SolanaAsk = React.lazy(() => import("./SolanaAsk"));

function AskFallback() {
  return (
    <p
      role="status"
      className="flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-white p-4 text-sm font-black uppercase text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white"
    >
      <LoaderCircle className="h-4 w-4 animate-spin text-[#9945FF]" aria-hidden="true" />
      Loading Ask
    </p>
  );
}

export interface SolanaWorkspaceProps {
  tab: SolanaTab;
  onTabChange: (tab: SolanaTab) => void;
}

/**
 * First-class Solana workspace for the console: portfolio, plain-English
 * intents (Ask), Jupiter swaps, transfers, liquid staking, Kamino yields and
 * Solana activity. Loaded lazily
 * when the user selects the Solana workspace.
 */
export default function SolanaWorkspace({ tab, onTabChange }: SolanaWorkspaceProps) {
  const { account } = useSolanaWallet();
  const owner = account?.address ?? null;
  const portfolio = useSolanaResource(
    owner ? solanaPaths.portfolio(owner, "solana") : null,
    parsePortfolio,
  );
  const refreshPortfolio = portfolio.refresh;
  useKletiaEvent("portfolio.invalidated", (event) => {
    if (event.network === "solana" && owner && sameAccount(event.account, formatAccountId("solana", owner))) {
      refreshPortfolio();
    }
  });

  // Keep visited panels mounted so form state survives tab switches.
  const [visited, setVisited] = React.useState<ReadonlySet<SolanaTab>>(() => new Set([tab]));
  if (!visited.has(tab)) {
    setVisited(new Set([...visited, tab]));
  }

  const tabRefs = React.useRef<Partial<Record<SolanaTab, HTMLButtonElement | null>>>({});
  const baseId = React.useId();
  const focusTab = (next: SolanaTab) => {
    onTabChange(next);
    tabRefs.current[next]?.focus();
  };
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = SOLANA_TABS.findIndex((candidate) => candidate.id === tab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % SOLANA_TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + SOLANA_TABS.length) % SOLANA_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = SOLANA_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    focusTab(SOLANA_TABS[nextIndex].id);
  };

  const panel = (id: SolanaTab): React.ReactNode => {
    switch (id) {
      case "overview":
        return <SolanaOverview owner={owner} portfolio={portfolio} onNavigate={onTabChange} />;
      case "ask":
        return (
          <LazyBoundary
            fallback={(reload) => (
              <div role="alert" className="flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#FFE4E4] p-4 text-sm font-bold text-[#1A1A1A] dark:border-[#7F1D1D]">
                The Ask tab could not load. Check your connection and reload.
                <button type="button" onClick={reload} className="inline-flex min-h-11 items-center justify-center self-start border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-wider text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none">
                  Reload
                </button>
              </div>
            )}
          >
            <React.Suspense fallback={<AskFallback />}>
              <SolanaAsk />
            </React.Suspense>
          </LazyBoundary>
        );
      case "swap":
        return <SolanaSwap owner={owner} portfolio={portfolio.data} />;
      case "send":
        return <SolanaSend owner={owner} portfolio={portfolio.data} />;
      case "stake":
        return <SolanaStake owner={owner} portfolio={portfolio.data} />;
      case "yields":
        return <SolanaYields />;
      case "activity":
        return (
          <div className="flex flex-col gap-5">
            <PanelHeader
              icon={ScrollText}
              title="Solana activity"
              description="Transactions signed in this browser on Solana mainnet and devnet, with their confirmation status."
            />
            <ActivityFeed
              network={["solana", "solana-devnet"]}
              limit={50}
              title="Solana transactions"
              emptyHint="No Solana transactions yet. Swaps, transfers and stakes you sign here appear with their confirmation status."
            />
          </div>
        );
    }
  };

  return (
    <div className="custom-scrollbar h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 md:p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header className="relative overflow-hidden border-[3px] border-[#1A1A1A] bg-white shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[4px_4px_0_#475569]">
          <div aria-hidden="true" className="h-2 bg-gradient-to-r from-[#9945FF] to-[#14F195]" />
          <div className="flex flex-col gap-3 p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-black uppercase tracking-[0.14em] text-[#1A1A1A] dark:text-white">
                Solana workspace
              </p>
              <span className="border-2 border-[#1A1A1A] bg-[#14F195] px-2 py-0.5 text-[10px] font-black uppercase text-[#1A1A1A]">
                Mainnet · Wallet Standard
              </span>
            </div>
            <div
              role="tablist"
              aria-label="Solana workspace sections"
              className="custom-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            >
              {SOLANA_TABS.map((definition) => {
                const selected = definition.id === tab;
                return (
                  <button
                    key={definition.id}
                    ref={(element) => {
                      tabRefs.current[definition.id] = element;
                    }}
                    id={`${baseId}-tab-${definition.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`${baseId}-panel-${definition.id}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onTabChange(definition.id)}
                    onKeyDown={handleTabKeyDown}
                    className={`min-h-11 shrink-0 border-[3px] border-[#1A1A1A] px-3 py-2 text-xs font-black uppercase tracking-wider transition-[transform,box-shadow,background-color] duration-100 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#9945FF] dark:border-[#4B5563] ${
                      selected
                        ? "bg-[#9945FF] text-white shadow-[3px_3px_0_#14F195]"
                        : "bg-white text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] hover:-translate-y-0.5 dark:bg-[#1A2841] dark:text-white dark:shadow-[3px_3px_0_#475569]"
                    }`}
                  >
                    {definition.label}
                  </button>
                );
              })}
            </div>
          </div>
        </header>

        {SOLANA_TABS.map((definition) =>
          visited.has(definition.id) ? (
            <div
              key={definition.id}
              id={`${baseId}-panel-${definition.id}`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-${definition.id}`}
              hidden={definition.id !== tab}
              tabIndex={0}
              className="focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-[#9945FF]"
            >
              {panel(definition.id)}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
