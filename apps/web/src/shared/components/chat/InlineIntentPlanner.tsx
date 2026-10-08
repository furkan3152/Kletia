/**
 * "Plan here" for cross-network prompts typed into the EVM chat: plans the
 * prompt through Kletia Platform API v1 with the connected wallets, shows the
 * review and the intent graph, and executes with the shared execution hook.
 * Loaded lazily by CrossNetworkHandoffCard; the console provides WalletProviders.
 */
import type { AccountId, IntentStep } from "@kletia/core";
import { LoaderCircle, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { IntentExecutionFlow } from "../../../app/site/intent/IntentExecutionFlow";
import { STUDIO_INTENT_SESSION_KEY } from "../../platform/intentSession";
import { sameOwner } from "../../platform/intentSigners";
import { useIntentExecution } from "../../platform/useIntentExecution";
import { useSolanaWallet } from "../../wallet/solana/solanaWalletContext";
import { shortenAddress } from "../../wallet/types";

export interface InlineIntentPlannerProps {
  readonly prompt: string;
}

export default function InlineIntentPlanner({ prompt }: InlineIntentPlannerProps) {
  const execution = useIntentExecution({
    sessionKey: STUDIO_INTENT_SESSION_KEY,
    metadata: { surface: "console-chat" },
  });
  const { openPicker, status: solanaStatus } = useSolanaWallet();
  const { status, intent } = execution;
  const accountsKey = execution.accounts.join(",");
  const solanaConnected = Boolean(execution.solana);

  // Plan once the Solana wallet is connected, and again if the accounts change before signing.
  const plannedForRef = useRef<string | null>(null);
  const planWithWallets = execution.plan;
  useEffect(() => {
    if (!solanaConnected) return;
    if (status !== "idle" && status !== "review" && !(status === "failed" && !intent)) return;
    if (plannedForRef.current === accountsKey) return;
    plannedForRef.current = accountsKey;
    void planWithWallets({ text: prompt });
  }, [accountsKey, intent, planWithWallets, prompt, solanaConnected, status]);

  const describeAccount = useCallback(
    (accountId: AccountId) => {
      for (const account of [execution.evm, execution.solana]) {
        if (account && sameOwner(account.accountId, accountId)) {
          return `${account.walletName} · ${shortenAddress(account.address)}`;
        }
      }
      return null;
    },
    [execution.evm, execution.solana],
  );
  const walletFor = useCallback(
    (step: IntentStep) => {
      for (const account of [execution.evm, execution.solana]) {
        if (account && sameOwner(account.accountId, step.account)) return account.walletName;
      }
      return null;
    },
    [execution.evm, execution.solana],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm font-normal leading-normal" aria-live="polite">
      {!solanaConnected ? (
        <div className="flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#F3E8FF] p-3 text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#1C1433] dark:text-white">
          <p className="text-sm font-bold">
            Connect a Solana wallet so Kletia can plan this with your own accounts. Nothing is signed until you confirm.
          </p>
          <button
            type="button"
            onClick={openPicker}
            aria-haspopup="dialog"
            disabled={solanaStatus === "connecting"}
            className="inline-flex min-h-11 items-center justify-center gap-2 self-start border-[3px] border-[#1A1A1A] bg-[#9945FF] px-3 py-2 text-xs font-black uppercase tracking-wider text-white shadow-[3px_3px_0_#1A1A1A] transition-transform duration-100 hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#14F195] active:translate-y-0.5 disabled:opacity-60 dark:border-[#4B5563]"
          >
            <Wallet className="h-4 w-4" aria-hidden="true" />
            Connect a Solana wallet
          </button>
        </div>
      ) : null}
      {status === "planning" && !intent ? (
        <p role="status" className="flex items-center gap-2 text-sm font-bold">
          <LoaderCircle className="h-4 w-4 animate-spin text-[#0052FF]" aria-hidden="true" />
          Planning with your accounts…
        </p>
      ) : null}
      {!intent && execution.error?.code === "ACCOUNT_REQUIRED" && solanaConnected && !execution.evm ? (
        <p className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] p-3 text-sm font-bold text-[#1A1A1A] dark:border-[#4B5563]">
          This route also needs an EVM account (it receives on an EVM network). Connect an EVM wallet with the button at
          the top; Kletia plans again as soon as it is connected.
        </p>
      ) : null}
      <IntentExecutionFlow
        execution={execution}
        describeAccount={describeAccount}
        walletFor={walletFor}
        onReplan={() => void planWithWallets({ text: prompt })}
        outcomeFooter={
          <p className="text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
            Every step is in the activity feed. If this page reloads mid-way, resume from Intent Studio.
          </p>
        }
      />
    </div>
  );
}
