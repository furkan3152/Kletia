/**
 * Wallet runtime for `/embed`, loaded only when the visitor asks to connect
 * (or hovers or focuses a connect button, which prefetches it), so a
 * plan-only visit never downloads wagmi, RainbowKit or the Solana wallet
 * layer. It offers only the wallets the frame needs (`vms`): a widget scoped
 * to EVM networks, or a session that only touches Arbitrum Sepolia, shows no
 * Solana button.
 */
import type { AccountId } from "@kletia/core";
import type { IntentSigners } from "@kletia/sdk";
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";

import { useIntentSigners } from "../../../shared/platform/useIntentSigners";
import { useSolanaWallet } from "../../../shared/wallet/solana/useSolanaWallet";
import { shortenAddress } from "../../../shared/wallet/types";
import { WalletProviders } from "../../providers";
import { EMBED_PILL_CLASS, type EmbedVm } from "./embedParams";

export interface EmbedWalletState {
  /** Connected (real) accounts; empty while nothing is connected. */
  readonly accounts: readonly AccountId[];
  readonly signers: IntentSigners | undefined;
}

export interface EmbedWalletBarProps {
  readonly onChange: (state: EmbedWalletState) => void;
  /** The wallets this frame offers. */
  readonly vms: ReadonlySet<EmbedVm>;
  /** The connect button the visitor pressed before the runtime loaded: its picker opens once it is ready. */
  readonly autoOpen?: EmbedVm | null;
}

const CONNECTED_PILL = "max-w-[8.5rem] bg-white text-[#1A1A1A] dark:bg-[#1A2841] dark:text-white sm:max-w-[10rem]";

function EvmPill({ autoOpen }: { autoOpen: boolean }) {
  const { address, status } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const opened = useRef(false);
  useEffect(() => {
    if (!autoOpen || opened.current || !openConnectModal || status === "reconnecting" || status === "connecting") return;
    opened.current = true;
    if (!address) openConnectModal();
  }, [address, autoOpen, openConnectModal, status]);
  if (address) {
    return (
      <button
        type="button"
        onClick={openAccountModal}
        aria-label={`EVM wallet ${shortenAddress(address)}. Open account options`}
        className={`${EMBED_PILL_CLASS} ${CONNECTED_PILL} focus-visible:outline-[#0052FF]`}
      >
        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 border border-[#1A1A1A] bg-[#10B981]" />
        <span className="truncate font-mono normal-case tracking-normal">{shortenAddress(address)}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={openConnectModal}
      disabled={!openConnectModal}
      aria-label="Connect EVM wallet"
      className={`${EMBED_PILL_CLASS} bg-[#0052FF] text-white focus-visible:outline-[#FFD60A]`}
    >
      <span className="sm:hidden">EVM</span>
      <span className="hidden sm:inline">Connect EVM</span>
    </button>
  );
}

function SolanaPill({ autoOpen }: { autoOpen: boolean }) {
  const { account, status, openPicker } = useSolanaWallet();
  const opened = useRef(false);
  useEffect(() => {
    if (!autoOpen || opened.current) return;
    opened.current = true;
    if (!account) openPicker();
  }, [account, autoOpen, openPicker]);
  return (
    <button
      type="button"
      onClick={openPicker}
      aria-haspopup="dialog"
      aria-label={account ? `Solana wallet ${shortenAddress(account.address)}. Open wallet options` : "Connect Solana wallet"}
      className={`${EMBED_PILL_CLASS} focus-visible:outline-[#9945FF] ${account ? CONNECTED_PILL : "whitespace-nowrap bg-[#9945FF] text-white"}`}
    >
      {status === "connecting" ? (
        <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 border border-[#1A1A1A] bg-gradient-to-br from-[#9945FF] to-[#14F195]" />
      )}
      {account ? (
        <span className="truncate font-mono normal-case tracking-normal">{shortenAddress(account.address)}</span>
      ) : (
        <>
          <span className="sm:hidden">SOL</span>
          <span className="hidden sm:inline">Connect Solana</span>
        </>
      )}
    </button>
  );
}

function WalletBar({ onChange, vms, autoOpen = null }: EmbedWalletBarProps) {
  const { accounts, signers, canSign } = useIntentSigners();

  useEffect(() => {
    onChange({ accounts, signers: canSign ? signers : undefined });
  }, [accounts, canSign, onChange, signers]);

  return (
    <div
      role="region"
      aria-label="Wallets"
      className="flex min-h-[3.75rem] flex-wrap items-center justify-between gap-2 border-[3px] border-[#1A1A1A] bg-white px-2.5 py-2 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#111827] dark:text-[#F4F4F5] dark:shadow-[3px_3px_0_#475569]"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em]" aria-live="polite">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true" />
        {canSign ? <span>Signing with your wallet{accounts.length === 1 ? "" : "s"}</span> : <span>Plan only · connect to execute</span>}
      </p>
      <div role="group" aria-label="Connected wallets" className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        {vms.has("evm") ? <EvmPill autoOpen={autoOpen === "evm"} /> : null}
        {vms.has("svm") ? <SolanaPill autoOpen={autoOpen === "svm"} /> : null}
      </div>
    </div>
  );
}

export default function EmbedWalletBar(props: EmbedWalletBarProps) {
  return (
    <WalletProviders>
      <WalletBar {...props} />
    </WalletProviders>
  );
}
