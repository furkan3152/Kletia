import { formatAccountId, isEvmAddress, isSolanaAddress, type AccountId, type IntentRequest } from "@kletia/core";
import { useCallback, useState } from "react";

import { PREVIEW_ACCOUNTS } from "../../../shared/platform/kletiaClient";
import { planIntentDryRun } from "../../../shared/platform/platformApi";
import { useApiAction } from "../../../shared/platform/useApiResource";

export interface StudioAccounts {
  readonly evm: AccountId;
  readonly solana: AccountId;
  /** True when the account came from the preview defaults. */
  readonly evmIsPreview: boolean;
  readonly solanaIsPreview: boolean;
}

export function resolveStudioAccounts(evmAddress: string, solanaAddress: string): StudioAccounts {
  const evm = evmAddress.trim();
  const solana = solanaAddress.trim();
  return {
    evm: evm && isEvmAddress(evm) ? formatAccountId("base", evm) : (PREVIEW_ACCOUNTS.evm as AccountId),
    solana: solana && isSolanaAddress(solana) ? formatAccountId("solana", solana) : (PREVIEW_ACCOUNTS.solana as AccountId),
    evmIsPreview: !(evm && isEvmAddress(evm)),
    solanaIsPreview: !(solana && isSolanaAddress(solana)),
  };
}

/**
 * State for the Studio composer: prompt, optional accounts and the dry-run
 * plan request. Kept separate from the page so a wallet-aware wrapper can
 * reuse it and pass connected accounts in.
 */
export function useStudioPlanner(initialText = "") {
  const [text, setText] = useState(initialText);
  const [evmAddress, setEvmAddress] = useState("");
  const [solanaAddress, setSolanaAddress] = useState("");
  const [submittedText, setSubmittedText] = useState<string | null>(null);

  const plan = useApiAction((client, signal, request: IntentRequest) => planIntentDryRun(client, signal, request));
  const runPlan = plan.run;

  const evmError =
    evmAddress.trim() && !isEvmAddress(evmAddress.trim()) ? "Not a valid EVM address (0x followed by 40 hex characters)." : undefined;
  const solanaError =
    solanaAddress.trim() && !isSolanaAddress(solanaAddress.trim()) ? "Not a valid Solana address (base58 public key)." : undefined;
  const textError = submittedText !== null && !text.trim() ? "Describe an outcome first." : undefined;

  const submit = useCallback(
    async (override?: string) => {
      const prompt = (override ?? text).trim();
      setSubmittedText(prompt);
      if (override !== undefined) setText(override);
      if (!prompt || evmError || solanaError) return undefined;
      const accounts = resolveStudioAccounts(evmAddress, solanaAddress);
      return runPlan({ text: prompt, accounts: [accounts.evm, accounts.solana] });
    },
    [text, evmAddress, solanaAddress, evmError, solanaError, runPlan],
  );

  return {
    text,
    setText,
    evmAddress,
    setEvmAddress,
    solanaAddress,
    setSolanaAddress,
    evmError,
    solanaError,
    textError,
    accounts: resolveStudioAccounts(evmAddress, solanaAddress),
    plan,
    submit,
  };
}
