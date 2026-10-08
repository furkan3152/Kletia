import { ConnectButton } from "@rainbow-me/rainbowkit";
import { LoaderCircle } from "lucide-react";

import { shortenAddress } from "./types";
import { useSolanaWallet } from "./solana/solanaWalletContext";

export interface WalletDockProps {
  /**
   * True when the active workspace is an EVM network. The "Wrong network"
   * prompt is only shown there; the Solana workspace never asks the EVM
   * wallet to switch chains.
   */
  evmWorkspace?: boolean;
  className?: string;
}

const pillBase =
  "flex min-h-11 min-w-0 items-center gap-2 border-[3px] border-[#1A1A1A] px-2.5 py-2 text-[11px] font-black uppercase tracking-wider shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,background-color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569] sm:px-3 sm:text-xs";

function EvmPill({ evmWorkspace }: { evmWorkspace: boolean }) {
  return (
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
          (!authenticationStatus || authenticationStatus === "authenticated");

        return (
          <div
            className="min-w-0"
            {...(!ready && {
              "aria-hidden": true,
              style: { opacity: 0, pointerEvents: "none", userSelect: "none" },
            })}
          >
            {!connected ? (
              <button
                type="button"
                onClick={openConnectModal}
                aria-label="Connect an EVM wallet"
                className={`${pillBase} bg-[#0052FF] text-white focus-visible:outline-[#FFD60A]`}
              >
                <span className="sm:hidden">EVM</span>
                <span className="hidden sm:inline">Connect EVM</span>
              </button>
            ) : chain.unsupported && evmWorkspace ? (
              <button
                type="button"
                onClick={openChainModal}
                className={`${pillBase} bg-[#EF4444] text-white focus-visible:outline-[#FFD60A]`}
              >
                Wrong network
              </button>
            ) : (
              <button
                type="button"
                onClick={openAccountModal}
                aria-label={`EVM wallet ${account.displayName}. Open account options`}
                className={`${pillBase} max-w-[8.5rem] bg-white text-[#1A1A1A] focus-visible:outline-[#0052FF] dark:bg-[#1A2841] dark:text-white sm:max-w-[10rem]`}
              >
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 shrink-0 border border-[#1A1A1A] ${chain.unsupported ? "bg-[#FFD60A]" : "bg-[#10B981]"}`}
                />
                <span className="truncate font-mono normal-case tracking-normal">
                  {account.displayName}
                </span>
              </button>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function SolanaPill() {
  const { account, status, openPicker } = useSolanaWallet();
  const connected = Boolean(account);
  return (
    <button
      type="button"
      onClick={openPicker}
      aria-haspopup="dialog"
      aria-label={
        account
          ? `Solana wallet ${shortenAddress(account.address)}. Open wallet options`
          : "Connect a Solana wallet"
      }
      className={`${pillBase} max-w-[8.5rem] focus-visible:outline-[#9945FF] sm:max-w-[10rem] ${
        connected
          ? "bg-white text-[#1A1A1A] dark:bg-[#1A2841] dark:text-white"
          : "bg-[#9945FF] text-white"
      }`}
    >
      {status === "connecting" ? (
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 border border-[#1A1A1A] bg-gradient-to-br from-[#9945FF] to-[#14F195]"
        />
      )}
      {account ? (
        <span className="truncate font-mono normal-case tracking-normal">
          {shortenAddress(account.address)}
        </span>
      ) : (
        <>
          <span className="sm:hidden">SOL</span>
          <span className="hidden sm:inline">Connect Solana</span>
        </>
      )}
    </button>
  );
}

/**
 * Navbar wallet dock: one pill per namespace. The EVM pill keeps the
 * RainbowKit flow; the Solana pill opens the Wallet Standard picker.
 */
export function WalletDock({ evmWorkspace = true, className = "" }: WalletDockProps) {
  return (
    <div
      role="group"
      aria-label="Connected wallets"
      className={`flex min-w-0 items-center gap-1.5 sm:gap-2 ${className}`}
    >
      <EvmPill evmWorkspace={evmWorkspace} />
      <SolanaPill />
    </div>
  );
}

export default WalletDock;
