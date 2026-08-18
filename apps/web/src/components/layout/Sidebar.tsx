import React from "react";
import { User, X, Zap } from "lucide-react";
import { useAccount } from "wagmi";
import { AlloraWidget } from "../integrations/allora/AlloraWidget";
import { useAppStore } from "../../store/useAppStore";
import { useNetwork } from "../../hooks/useNetwork";
import PortfolioViewer from "../base/PortfolioViewer";
import ArcPortfolioViewer from "../arc/ArcPortfolioViewer";
import { isArcPortfolioData, isArbitrumPortfolioData, isBasePortfolioData } from "../../types";
import { ArbitrumPortfolioViewer } from "../arbitrum/ArbitrumPortfolioViewer";

interface SidebarProps {
  isPortfolioOpen: boolean;
  setIsPortfolioOpen: (open: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isPortfolioOpen,
  setIsPortfolioOpen,
}) => {
  const { isDarkMode, messages } = useAppStore();
  const { networkMode, network } = useNetwork();
  const { address } = useAccount();

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
        {networkMode === "base" && (
          <AlloraWidget isDarkMode={isDarkMode} asset="ETH" />
        )}
        {(() => {
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
                For this wallet {network.shortName} the portfolio has not been scanned yet.
                To chat{" "}
                <b>
                  "
                  {networkMode === "arc"
                    ? "Show my Arc portfolio"
                    : networkMode === "arbitrum"
                      ? "Show my Arbitrum portfolio"
                      : "Show my portfolio"}
                  "
                </b>{" "}
                to load live balances.
              </span>
            </div>
          );
        })()}
      </div>
    </aside>
  );
};
