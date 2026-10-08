/**
 * Solana workspace "Ask" tab: describe an outcome in plain English, plan it
 * through Kletia Platform API v1 with the connected accounts, review the
 * graph and execute it step by step with the user's wallets. Loaded lazily
 * by SolanaWorkspace (the console already provides WalletProviders).
 */
import type { AccountId, IntentStep } from "@kletia/core";
import { History, MessageSquare, Sparkles } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";

import { IntentExecutionFlow } from "../../../app/site/intent/IntentExecutionFlow";
import { SOLANA_ASK_INTENT_SESSION_KEY } from "../../../shared/platform/intentSession";
import { sameOwner } from "../../../shared/platform/intentSigners";
import { useIntentExecution } from "../../../shared/platform/useIntentExecution";
import { shortenAddress } from "../../../shared/wallet/types";
import { ui } from "../styles";
import { ConnectSolanaCta, PanelHeader } from "./SolanaUi";

/** `insert` examples need the user to finish them (a recipient address). */
const EXAMPLES: readonly { label: string; text: string; insert?: boolean }[] = [
  { label: "swap 1 SOL to USDC", text: "swap 1 SOL to USDC" },
  { label: "stake 2 SOL with jito", text: "stake 2 SOL with jito" },
  { label: "bridge 20 USDC from solana to base", text: "bridge 20 USDC from solana to base" },
  { label: "send 5 USDC to <address>", text: "send 5 USDC to ", insert: true },
];

const MAX_PROMPT = 500;

export default function SolanaAsk() {
  const execution = useIntentExecution({
    sessionKey: SOLANA_ASK_INTENT_SESSION_KEY,
    metadata: { surface: "console-solana-ask" },
  });
  const { status, intent, error } = execution;
  const [text, setText] = useState("");
  const [lastPlanned, setLastPlanned] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const baseId = useId();
  const busy = status === "planning" || status === "executing";
  const solanaConnected = Boolean(execution.solana);

  const plan = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim().slice(0, MAX_PROMPT);
      if (!trimmed) {
        setFormError("Describe what should happen first.");
        textareaRef.current?.focus();
        return;
      }
      if (/<address>/iu.test(trimmed)) {
        setFormError("Replace <address> with the recipient's Solana address.");
        textareaRef.current?.focus();
        return;
      }
      setFormError(null);
      setHint(null);
      setLastPlanned(trimmed);
      execution.reset();
      void execution.plan({ text: trimmed, defaultNetwork: "solana" });
    },
    [execution],
  );

  const pickExample = (example: (typeof EXAMPLES)[number]) => {
    setText(example.text);
    setFormError(null);
    if (example.insert) {
      setHint("Paste the recipient's Solana address after “to”, then plan.");
      window.requestAnimationFrame(() => {
        const field = textareaRef.current;
        if (!field) return;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      });
      return;
    }
    setHint(null);
    if (solanaConnected && !busy) plan(example.text);
  };

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

  const needsEvmHint = !intent && error?.code === "ACCOUNT_REQUIRED" && !execution.evm;
  const resumable = execution.resumableIntentId && !intent && status === "idle";

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        icon={MessageSquare}
        title="Ask"
        description="Describe an outcome in plain English. Kletia plans it with your connected accounts, shows every step and fee, and your wallet signs each one."
      />

      {!solanaConnected ? (
        <ConnectSolanaCta
          title="Connect a Solana wallet to plan"
          description="Kletia plans with your own accounts and balances. Connect a Wallet Standard wallet (and an EVM wallet for bridges to Base or Arbitrum)."
        />
      ) : null}

      {resumable ? (
        <section aria-label="Resume intent" className={`${ui.card} flex flex-col gap-3 bg-[#FFF7CC] dark:bg-[#2A2410]`}>
          <p className="flex items-center gap-2 text-sm font-black uppercase">
            <History className="h-4 w-4" aria-hidden="true" />
            An intent was still running in this tab
          </p>
          <p className="text-sm font-bold text-gray-700 dark:text-slate-300">
            Resume refreshes it from Kletia and continues with the next step. Submitted steps are never signed again.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={ui.primaryButton} onClick={() => void execution.resume()}>
              Resume
            </button>
            <button type="button" className={ui.ghostButton} onClick={execution.forgetResumable}>
              Dismiss
            </button>
          </div>
        </section>
      ) : null}

      <form
        className={`${ui.card} flex flex-col gap-4`}
        aria-label="Ask Kletia"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          plan(text);
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor={`${baseId}-prompt`} className={ui.label}>
            What should happen?
          </label>
          <textarea
            id={`${baseId}-prompt`}
            ref={textareaRef}
            rows={3}
            maxLength={MAX_PROMPT}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (formError) setFormError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="swap 1 SOL to USDC"
            spellCheck={false}
            aria-invalid={formError ? true : undefined}
            aria-describedby={`${baseId}-help${formError ? ` ${baseId}-error` : ""}`}
            className={`${ui.input} min-h-[5.5rem] resize-y font-mono text-sm`}
          />
          <p id={`${baseId}-help`} className="text-xs font-bold text-gray-600 dark:text-slate-400">
            {hint ?? "Ctrl/⌘ + Enter to plan. Planning never signs or moves funds."}
          </p>
          {formError ? (
            <p id={`${baseId}-error`} role="alert" className="text-xs font-black text-[#B91C1C] dark:text-red-300">
              {formError}
            </p>
          ) : null}
        </div>
        <div>
          <p id={`${baseId}-examples`} className={`${ui.label} mb-2`}>
            Examples
          </p>
          <div role="group" aria-labelledby={`${baseId}-examples`} className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example.label}
                type="button"
                onClick={() => pickExample(example)}
                disabled={busy}
                className={`${ui.chip(text.trim() === example.text.trim())} normal-case tracking-normal disabled:opacity-50`}
              >
                <span className="font-mono text-xs">{example.label}</span>
              </button>
            ))}
          </div>
        </div>
        <button type="submit" className={`${ui.primaryButton} self-start`} disabled={busy || !solanaConnected}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {status === "planning" ? "Planning…" : "Plan with my wallets"}
        </button>
      </form>

      <div className="flex min-w-0 flex-col gap-5">
        {status === "planning" && !intent ? (
          <p role="status" className={`${ui.card} text-sm font-black uppercase`}>
            Planning “{lastPlanned}” with your accounts…
          </p>
        ) : null}
        {needsEvmHint ? (
          <p role="status" className={ui.warningBox}>
            This intent also needs an EVM account (for example to receive on Base). Connect an EVM wallet from the top
            bar, then plan again.
          </p>
        ) : null}
        <IntentExecutionFlow
          execution={execution}
          describeAccount={describeAccount}
          walletFor={walletFor}
          {...(lastPlanned ? { onReplan: () => plan(lastPlanned) } : {})}
          outcomeFooter={
            <button
              type="button"
              className={`${ui.ghostButton} self-start`}
              onClick={() => {
                execution.reset();
                setText("");
                textareaRef.current?.focus();
              }}
            >
              Ask for something else
            </button>
          }
        />
      </div>
    </div>
  );
}
