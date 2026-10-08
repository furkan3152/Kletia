import React from "react";
import { formatAccountId, sameAccount, type AccountId } from "@kletia/core";
import { RefreshCw, User, X, Zap } from "lucide-react";
import { useAccount } from "wagmi";
import { AlloraWidget } from "../../../integrations/allora/components/AlloraWidget";
import { useAppStore } from "../../state/useAppStore";
import { useNetwork } from "../../hooks/useNetwork";
import PortfolioViewer from "../../../networks/base/components/PortfolioViewer";
import ArcPortfolioViewer from "../../../networks/arc/components/ArcPortfolioViewer";
import { isArcPortfolioData, isArbitrumPortfolioData, isBasePortfolioData } from "../../types";
import { ArbitrumPortfolioViewer } from "../../../networks/arbitrum/components/ArbitrumPortfolioViewer";
import { useKletiaEvent } from "../../sync/bus";
import { EvmLiveBalances } from "./EvmLiveBalances";

interface SidebarProps {
  isPortfolioOpen: boolean;
  setIsPortfolioOpen: (open: boolean) => void;
  /** Ask the intent engine for a verified portfolio scan (prefills the chat). */
  onScanPortfolio?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isPortfolioOpen,
  setIsPortfolioOpen,
  onScanPortfolio,
}) => {
  const { isDarkMode, messages } = useAppStore();
  const { networkMode, network } = useNetwork();
  const { address } = useAccount();
  const accountId = React.useMemo<AccountId | null>(() => {
    if (!address) return null;
    try {
      return formatAccountId(networkMode, address);
    } catch {
      return null;
    }
  }, [address, networkMode]);
  const latestPortfolioMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.intentData?.action === "portfolio" &&
        message.network === networkMode &&
        message.chainId === network.chainId &&
        message.intentData.network === networkMode &&
        message.intentData.chainId === network.chainId &&
        Boolean(address) &&
        message.walletAddress?.toLowerCase() === address?.toLowerCase(),
    );
  const latestScanId = latestPortfolioMessage?.id ?? null;
  // The scan that was current when a transaction changed this account's
  // balances; it is shown as stale until a newer scan replaces it.
  const [staleScanId, setStaleScanId] = React.useState<string | null>(null);
  useKletiaEvent("portfolio.invalidated", (event) => {
    if (accountId && latestScanId && sameAccount(event.account, accountId)) {
      setStaleScanId(latestScanId);
    }
  });
  const scanIsStale = latestScanId !== null && staleScanId === latestScanId;

  React.useEffect(() => {
    if (!isPortfolioOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsPortfolioOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isPortfolioOpen, setIsPortfolioOpen]);

  if (!isPortfolioOpen) return null;

  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label={`${network.shortName} portfolio`}
      className="fixed inset-0 z-[60] flex h-[100dvh] w-full shrink-0 flex-col overflow-x-hidden overflow-y-auto border-l-[3px] border-[#1A1A1A] bg-[#FDFDFD] shadow-[-4px_0_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#0B1121] dark:shadow-[-4px_0_0_#475569] sm:left-auto sm:w-96 lg:relative lg:h-full"
    >
      <div className="sticky top-0 z-10 flex min-h-16 items-center justify-between border-b-[3px] border-[#1A1A1A] bg-[#FFD700] px-3 py-3 text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#60A5FA] sm:p-4">
        <h2 className="flex min-w-0 items-center gap-2 text-base font-black uppercase tracking-wider sm:text-lg">
          <Zap className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {network.shortName.toUpperCase()} PORTFOLIO
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setIsPortfolioOpen(false)}
          aria-label="Close portfolio"
          className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] transition-colors duration-100 hover:bg-[#1A1A1A] hover:text-[#FFD700] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:shadow-[2px_2px_0_#475569] dark:hover:text-[#60A5FA]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-4 bg-[#FDFDFD] p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] dark:bg-[#0B1121] sm:p-4">
        {accountId ? (
          <EvmLiveBalances accountId={accountId} networkName={network.shortName} />
        ) : (
          <p className="border-[3px] border-[#1A1A1A] bg-white p-4 text-sm font-bold text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white dark:shadow-[4px_4px_0_#475569]">
            Connect an EVM wallet to see live {network.shortName} balances.
          </p>
        )}
        {scanIsStale ? (
          <div
            role="status"
            className="flex flex-col gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-3 text-sm font-bold text-[#1A1A1A] dark:border-[#4B5563]"
          >
            A transaction changed this wallet after the last verified scan.
            {onScanPortfolio ? (
              <button
                type="button"
                onClick={onScanPortfolio}
                className="flex min-h-11 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-3 text-xs font-black uppercase shadow-[2px_2px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Rescan portfolio
              </button>
            ) : null}
          </div>
        ) : null}
        {networkMode === "base" && (
          <AlloraWidget isDarkMode={isDarkMode} asset="ETH" />
        )}
        {(() => {
          const latestPortfolio = latestPortfolioMessage?.intentData?.data;

          if (networkMode === "base" && isBasePortfolioData(latestPortfolio)) {
            return <PortfolioViewer data={latestPortfolio} />;
          }
          if (networkMode === "arc" && isArcPortfolioData(latestPortfolio)) {
            return <ArcPortfolioViewer data={latestPortfolio} />;
          }
          if (
            networkMode === "arbitrum" &&
            isArbitrumPortfolioData(latestPortfolio)
          ) {
            return <ArbitrumPortfolioViewer data={latestPortfolio} />;
          }
          if (latestPortfolio) {
            return (
              <div className="p-5 mt-4 border-[3px] border-[#1A1A1A] bg-[#FEE2E2] dark:bg-red-950/30 dark:border-red-500 dark:text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#EF4444] text-center font-bold">
                Portfolio response did not match the verified data schema of the active network.
                Not displayed for security; please rescan.
              </div>
            );
          }
          return (
            <div className="p-5 mt-4 border-[3px] border-[#1A1A1A] bg-white dark:bg-[#131E32] dark:border-[#4B5563] dark:text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] text-center font-bold flex flex-col items-center gap-3">
              <User className="w-8 h-8 opacity-50" />
              <span>
                No verified {network.shortName} portfolio scan yet. Ask the intent engine{" "}
                <b>
                  "
                  {networkMode === "arc"
                    ? "Show my Arc portfolio"
                    : networkMode === "arbitrum"
                      ? "Show my Arbitrum portfolio"
                      : "Show my portfolio"}
                  "
                </b>{" "}
                for positions, protocol balances and integrity details.
              </span>
              {onScanPortfolio ? (
                <button
                  type="button"
                  onClick={onScanPortfolio}
                  className="flex min-h-11 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#0052FF] px-3 text-xs font-black uppercase text-white shadow-[3px_3px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569]"
                >
                  Scan with intent engine
                </button>
              ) : null}
            </div>
          );
        })()}
      </div>
    </aside>
  );
};
