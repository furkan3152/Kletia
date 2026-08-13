import React from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Bot, CreditCard, Menu } from "lucide-react";

import { NetworkSwitcher } from "./NetworkSwitcher";
import { getNetwork, type NetworkMode } from "../../config/networks";
import { useNetwork } from "../../hooks/useNetwork";

interface NavbarProps {
  onBaseMcpHandoff: () => void;
  address?: string;
  handleFundClick: (wallet: string, e: React.MouseEvent) => void;
  onMenuClick: () => void;
  networkMode?: NetworkMode;
  onNetworkToggle?: () => void | Promise<unknown>;
  isNetworkSwitching?: boolean;
  networkSwitchError?: string | null;
}

export const Navbar: React.FC<NavbarProps> = ({
  onBaseMcpHandoff,
  address,
  handleFundClick,
  onMenuClick,
  networkMode,
  onNetworkToggle,
  isNetworkSwitching,
  networkSwitchError,
}) => {
  const networkController = useNetwork();
  const effectiveNetworkMode = networkMode ?? networkController.networkMode;
  const activeNetwork = getNetwork(effectiveNetworkMode);
  const toggleNetwork = onNetworkToggle ?? networkController.toggleNetwork;
  const networkIsSwitching =
    isNetworkSwitching ?? networkController.isSwitching;
  const networkError = networkSwitchError ?? networkController.switchError;
  const baseMcpHandoffEnabled = activeNetwork.features.baseMcpHandoff;

  const handleFunding = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (activeNetwork.funding.kind === "faucet") {
      window.open(activeNetwork.funding.url, "_blank", "noopener,noreferrer");
      return;
    }

    if (address) {
      handleFundClick(address, event);
    }
  };
  return (
    <header className="shrink-0 flex items-center justify-between px-4 md:px-6 py-4 bg-white dark:bg-[#131E32] border-b-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[0_4px_0_#1A1A1A] dark:shadow-[0_4px_0_#475569] z-50 relative">
      <div className="flex items-center gap-3 md:gap-4">
        {}
        <button
          onClick={onMenuClick}
          className="p-1.5 md:p-2.5 bg-white dark:bg-[#1A2841] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all duration-100 ease-out"
        >
          <Menu className="w-5 h-5 text-[#1A1A1A] dark:text-white" />
        </button>

        {}
        <div className="flex items-center justify-center shrink-0 w-9 h-9 md:w-14 md:h-14 bg-transparent border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
          <img
            src="https://i.ibb.co/0ySyGq7N/logo.png"
            alt="Kletia"
            className="w-5 h-5 md:w-8 md:h-8 object-contain"
          />
        </div>
        <div className="flex flex-col">
          <h1 className="text-xl md:text-3xl font-black text-[#1A1A1A] dark:text-white tracking-tighter uppercase leading-none flex items-center gap-1 md:gap-2">
            KLETIA
            <span
              className="text-[10px] md:text-xs font-bold tracking-normal text-white px-2 py-0.5 border-[2px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569]"
              style={{ backgroundColor: activeNetwork.color }}
            >
              {activeNetwork.badge}
            </span>
          </h1>
        </div>
      </div>

      <div className="flex items-center gap-3 md:gap-4">
        {}
        <div className="hidden lg:block">
          <NetworkSwitcher
            networkMode={effectiveNetworkMode}
            onToggle={toggleNetwork}
            isSwitching={networkIsSwitching}
            error={networkError}
          />
        </div>

        {}
        {baseMcpHandoffEnabled && (
          <div className="relative group hidden sm:flex items-center">
            <button
              onClick={onBaseMcpHandoff}
              title="Open the official Base MCP handoff guide. This does not claim an OAuth connection."
              className="flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#EAF0FF] px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] transition-all duration-100 ease-out hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] dark:border-[#4B5563]"
            >
              <Bot className="w-4 h-4" />
              <span>BASE MCP AGENT</span>
            </button>
          </div>
        )}
        {}
        {Boolean(address) && (
          <button
            onClick={handleFunding}
            className="hidden md:flex items-center justify-center gap-2 px-3 py-1.5 bg-[#FFD700] hover:bg-[#FACC15] dark:bg-[#60A5FA] dark:hover:bg-[#3B82F6] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] text-[#1A1A1A] font-black shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all duration-100 ease-out cursor-pointer"
          >
            <CreditCard className="w-4 h-4" />
            <span className="text-xs">
              {activeNetwork.funding.label.toUpperCase()}
            </span>
          </button>
        )}

        {}
        <div className="flex gap-2 items-center">
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
                          className="px-4 py-1.5 bg-[#0052FF] text-white font-black uppercase tracking-wider text-xs md:text-sm border-[3px] border-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all"
                        >
                          Connect Wallet
                        </button>
                      );
                    }

                    if (chain.unsupported) {
                      return (
                        <button
                          onClick={openChainModal}
                          type="button"
                          className="px-4 py-1.5 bg-[#EF4444] text-white font-black uppercase tracking-wider text-xs md:text-sm border-[3px] border-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all"
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
                          className="flex items-center gap-2 px-3 md:px-4 py-1.5 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] bg-white dark:bg-[#1A2841] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all"
                        >
                          <span className="w-2 h-2 rounded-full bg-[#10B981] border-[1px] border-[#1A1A1A]"></span>
                          <span className="font-mono text-xs md:text-sm font-black text-[#1A1A1A] dark:text-white">
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
    </header>
  );
};
