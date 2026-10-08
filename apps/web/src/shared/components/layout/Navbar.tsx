import React from "react";
import { ArrowRightLeft, Bot, CreditCard, Droplets, Menu } from "lucide-react";

import { NetworkSwitcher, type WorkspaceMode } from "./NetworkSwitcher";
import { getWorkspacePresentation } from "../../config/networks";
import { useNetwork } from "../../hooks/useNetwork";
import { WalletDock } from "../../wallet/WalletDock";

interface NavbarProps {
  address?: string;
  handleFundClick: (wallet: string, e: React.MouseEvent) => void;
  onMenuClick: () => void;
  networkMode?: WorkspaceMode;
  onNetworkSelect?: (network: WorkspaceMode) => void | Promise<unknown>;
  isNetworkSwitching?: boolean;
  networkSwitchError?: string | null;
}

export const Navbar: React.FC<NavbarProps> = ({
  address,
  handleFundClick,
  onMenuClick,
  networkMode,
  onNetworkSelect,
  isNetworkSwitching,
  networkSwitchError,
}) => {
  const networkController = useNetwork();
  const effectiveNetworkMode: WorkspaceMode =
    networkMode ?? networkController.networkMode;
  const activeWorkspace = getWorkspacePresentation(effectiveNetworkMode);
  const activeColor = activeWorkspace.color;
  const activeBadge = activeWorkspace.badge;
  const funding = activeWorkspace.funding;
  const selectNetwork =
    onNetworkSelect ??
    ((selected: WorkspaceMode) =>
      selected === "solana" ? undefined : networkController.switchNetwork(selected));
  const networkIsSwitching =
    isNetworkSwitching ?? networkController.isSwitching;
  const networkError = networkSwitchError ?? networkController.switchError;
  const showFunding = funding.kind !== "onramp" || Boolean(address);
  const FundingIcon =
    funding.kind === "bridge"
      ? ArrowRightLeft
      : funding.kind === "faucet"
        ? Droplets
        : CreditCard;
  const handleFunding = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (funding.kind === "faucet") {
      window.open(funding.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (funding.kind === "bridge") {
      window.location.assign(funding.url);
      return;
    }
    // Only Base uses the Coinbase onramp.
    if (address && effectiveNetworkMode === "base") {
      handleFundClick(address, event);
    }
  };
  return (
    <header className="relative z-50 shrink-0 border-b-[4px] border-[#1A1A1A] bg-white px-3 py-2 shadow-[0_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[0_4px_0_#475569] sm:px-4 md:px-5">
      <div className="flex min-w-0 items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3 md:gap-4">
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="Open Kletia navigation"
            className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-white shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569]"
          >
            <Menu
              className="h-5 w-5 text-[#1A1A1A] dark:text-white"
              aria-hidden="true"
            />
          </button>

        <div className="flex h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-white shadow-[3px_3px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#0B1220] dark:shadow-[3px_3px_0_#475569]">
          <img
            src="/kletia-logo.png"
            alt="Kletia"
            width="32"
            height="32"
            className="h-7 w-7 object-contain invert dark:invert-0"
          />
        </div>
        <div className="min-w-0">
          <h1 className="flex items-center gap-1 text-lg font-black uppercase leading-none tracking-tighter text-[#1A1A1A] dark:text-white sm:text-xl md:gap-2 md:text-2xl">
            KLETIA
            <span
              className="hidden border-[2px] border-[#1A1A1A] px-1.5 py-0.5 text-[9px] font-bold tracking-normal text-white shadow-[2px_2px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[2px_2px_0_#475569] sm:inline sm:px-2 sm:text-[10px] md:text-xs"
              style={
                effectiveNetworkMode === "solana"
                  ? {
                      backgroundColor: activeColor,
                      backgroundImage:
                        "linear-gradient(135deg, #9945FF 0%, #7C3AED 60%, #14F195 150%)",
                    }
                  : { backgroundColor: activeColor }
              }
            >
              {activeBadge}
            </span>
          </h1>
        </div>
      </div>

        <div className="flex min-w-0 shrink-0 items-center gap-2 md:gap-4">
        <div className="hidden md:block">
          <NetworkSwitcher
            networkMode={effectiveNetworkMode}
            onSelect={selectNetwork}
            isSwitching={networkIsSwitching}
            error={networkError}
            className="w-[15rem] lg:w-[18rem] xl:w-[20rem]"
            compact
          />
        </div>
        <a
          href="/developers#agents"
          className="hidden min-h-11 items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#EAF0FF] px-2.5 py-2 text-[10px] font-black uppercase tracking-wider text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:shadow-[3px_3px_0_#475569] 2xl:flex"
        >
          <Bot className="h-4 w-4" aria-hidden="true" />
          <span>Agents</span>
        </a>
        {showFunding && (
          <button
            type="button"
            onClick={handleFunding}
            className="hidden min-h-11 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD700] px-3 py-2 font-black text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:bg-[#FACC15] hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#60A5FA] dark:shadow-[3px_3px_0_#475569] dark:hover:bg-[#3B82F6] xl:flex"
          >
            <FundingIcon className="h-4 w-4" aria-hidden="true" />
            <span className="text-xs">{funding.label.toUpperCase()}</span>
          </button>
        )}

        <WalletDock evmWorkspace={effectiveNetworkMode !== "solana"} />
        </div>
      </div>

    </header>
  );
};
