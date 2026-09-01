import React from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Bot, CreditCard, Menu } from "lucide-react";

import { NetworkSwitcher, type WorkspaceMode } from "./NetworkSwitcher";
import { getNetwork } from "../../config/networks";
import { useNetwork } from "../../hooks/useNetwork";

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
  const effectiveNetworkMode = networkMode ?? networkController.networkMode;
  const isStellarWorkspace = effectiveNetworkMode === "stellar";
  const activeNetwork = isStellarWorkspace
    ? networkController.network
    : getNetwork(effectiveNetworkMode);
  const activeColor = isStellarWorkspace ? "#8B5CF6" : activeNetwork.color;
  const activeBadge = isStellarWorkspace ? "BUILT ON STELLAR" : activeNetwork.badge;
  const selectNetwork =
    onNetworkSelect ??
    ((selected: WorkspaceMode) =>
      selected === "stellar"
        ? Promise.resolve(false)
        : networkController.switchNetwork(selected));
  const networkIsSwitching =
    isNetworkSwitching ?? networkController.isSwitching;
  const networkError = networkSwitchError ?? networkController.switchError;
  const baseMcpHandoffEnabled =
    !isStellarWorkspace && activeNetwork.features.baseMcpHandoff;
  const handleFunding = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isStellarWorkspace) {
      window.open("https://faucet.circle.com/", "_blank", "noopener,noreferrer");
      return;
    }
    if (activeNetwork.funding.kind === "faucet") {
      window.open(activeNetwork.funding.url, "_blank", "noopener,noreferrer");
      return;
    }

    if (address) {
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
              style={{ backgroundColor: activeColor }}
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
            className="w-[17rem] lg:w-[19rem]"
            compact
          />
        </div>
        {baseMcpHandoffEnabled && (
          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Base Agent Mode is in development."
            className="hidden min-h-11 cursor-not-allowed items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#EAF0FF] px-2.5 py-2 text-[9px] font-black uppercase tracking-wider text-[#1A1A1A] opacity-75 shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white 2xl:flex"
          >
            <Bot className="h-4 w-4" aria-hidden="true" />
            <span>BASE AGENT</span>
            <span className="border-2 border-[#1A1A1A] bg-[#FFD700] px-1 py-0.5 text-[8px] leading-none text-[#1A1A1A]">
              SOON
            </span>
          </button>
        )}
        {Boolean(address) && !isStellarWorkspace && (
          <button
            type="button"
            onClick={handleFunding}
            className="hidden min-h-11 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#FFD700] px-3 py-2 font-black text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:bg-[#FACC15] hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#60A5FA] dark:shadow-[3px_3px_0_#475569] dark:hover:bg-[#3B82F6] xl:flex"
          >
            <CreditCard className="w-4 h-4" />
            <span className="text-xs">
              {activeNetwork.funding.label.toUpperCase()}
            </span>
          </button>
        )}

        <div className="flex min-w-0 items-center">
          <ConnectButton.Custom>
            {({
              account,
              chain,
              openAccountModal,
              openChainModal,
              openConnectModal,
              authenticationStatus,
              mounted,
            }) => {
              const ready = mounted && authenticationStatus !== "loading";
              const connected =
                ready &&
                account &&
                chain &&
                (!authenticationStatus ||
                  authenticationStatus === "authenticated");

              return (
                <div
                  className="min-w-0"
                  {...(!ready && {
                    "aria-hidden": true,
                    style: {
                      opacity: 0,
                      pointerEvents: "none",
                      userSelect: "none",
                    },
                  })}
                >
                  {(() => {
                    if (!connected) {
                      return (
                        <button
                          onClick={openConnectModal}
                          type="button"
                          className="min-h-11 border-[3px] border-[#1A1A1A] bg-[#0052FF] px-3 py-2 text-[11px] font-black uppercase tracking-wider text-white shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none sm:px-4 sm:text-xs md:text-sm"
                        >
                          <span className="sm:hidden">
                            {isStellarWorkspace ? "EVM" : "Connect"}
                          </span>
                          <span className="hidden sm:inline">
                            {isStellarWorkspace ? "Connect EVM" : "Connect Wallet"}
                          </span>
                        </button>
                      );
                    }

                    if (chain.unsupported) {
                      return (
                        <button
                          onClick={openChainModal}
                          type="button"
                          className="min-h-11 border-[3px] border-[#1A1A1A] bg-[#EF4444] px-3 py-2 text-[10px] font-black uppercase tracking-wider text-white shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none sm:px-4 sm:text-xs md:text-sm"
                        >
                          Wrong Network
                        </button>
                      );
                    }

                    return (
                      <div className="flex gap-2">
                        <button
                          onClick={openAccountModal}
                          type="button"
                          className="flex min-h-11 max-w-[7.5rem] items-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-2.5 py-2 shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569] sm:max-w-[10rem] sm:px-3 md:px-4"
                        >
                          <span className="w-2 h-2 rounded-full bg-[#10B981] border-[1px] border-[#1A1A1A]"></span>
                          <span className="truncate font-mono text-[11px] font-black text-[#1A1A1A] dark:text-white sm:text-xs md:text-sm">
                            {account.displayName}
                          </span>
                        </button>
                      </div>
                    );
                  })()}
                </div>
              );
            }}
          </ConnectButton.Custom>
        </div>
        </div>
      </div>

    </header>
  );
};
