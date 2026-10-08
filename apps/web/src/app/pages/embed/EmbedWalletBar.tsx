/**
 * Wallet runtime for `/embed`, loaded lazily so the widget renders (plan-only)
 * before wagmi, RainbowKit and the Solana wallet layer arrive.
 */
import type { AccountId } from "@kletia/core";
import type { IntentSigners } from "@kletia/sdk";
import { ShieldCheck } from "lucide-react";
import { useEffect } from "react";

import { useIntentSigners } from "../../../shared/platform/useIntentSigners";
import { WalletDock } from "../../../shared/wallet/WalletDock";
import { WalletProviders } from "../../providers";

export interface EmbedWalletState {
  /** Connected (real) accounts; empty while nothing is connected. */
  readonly accounts: readonly AccountId[];
  readonly signers: IntentSigners | undefined;
}

export interface EmbedWalletBarProps {
  readonly onChange: (state: EmbedWalletState) => void;
}

function WalletBar({ onChange }: EmbedWalletBarProps) {
  const { accounts, signers, canSign } = useIntentSigners();

  useEffect(() => {
    onChange({ accounts, signers: canSign ? signers : undefined });
  }, [accounts, canSign, onChange, signers]);

  return (
    <div
      role="region"
      aria-label="Wallets"
      className="flex flex-wrap items-center justify-between gap-2 border-[3px] border-[#1A1A1A] bg-white px-2.5 py-2 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#111827] dark:text-[#F4F4F5] dark:shadow-[3px_3px_0_#475569]"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em]" aria-live="polite">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true" />
        {canSign ? (
          <span>Signing with your wallet{accounts.length === 1 ? "" : "s"}</span>
        ) : (
          <span>Plan only · connect to execute</span>
        )}
      </p>
      <WalletDock evmWorkspace={false} />
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
