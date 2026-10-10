/**
 * Signing for an intent link. Loaded lazily only when the visitor asks to
 * continue with a wallet, so the link page itself ships no wallet SDK.
 *
 * The visitor's intent is created through the link (`POST /v1/links/{id}/
 * intents`, owned by the publisher's key, inside the link's envelope) and
 * then executed with the same execution flow as Intent Studio: review and
 * explicit confirmation, a fare gate before every prepare, contract reviews,
 * one wallet prompt per signature, live progress, and the receipt panel.
 */
import "../../site/art/base.css";
import "./link.css";

import type { AccountId, IntentGraph, IntentPreview, IntentStep, LinkView } from "@kletia/core";
import { History, PenLine, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { findBindingProblem, sameOwner } from "../../../shared/platform/intentBinding";
import { toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { useIntentExecution } from "../../../shared/platform/useIntentExecution";
import { shortenAddress } from "../../../shared/wallet/types";
import { WalletDock } from "../../../shared/wallet/WalletDock";
import { WalletProviders } from "../../providers";
import { Stamp } from "../../site/art/Stamp";
import type { StampState } from "../../site/art/stampText";
import { IntentExecutionFlow } from "../../site/intent/IntentExecutionFlow";
import { IntentReview } from "../../site/intent/IntentReview";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { createLinkIntent } from "./linkClient";
import { visitorAccounts, type FundingOption } from "./linkModel";

export interface LinkSignPanelProps {
  readonly linkId: string;
  readonly view: LinkView;
  readonly option: FundingOption;
  /** Input mode only. */
  readonly amount: string | null;
  /** Wallet families the quoted route signs with. */
  readonly needed: readonly ("eip155" | "solana")[];
  /** The indicative plan (its steps say where each wallet signs first). */
  readonly quoted: IntentGraph | null;
  readonly onClose: () => void;
}

function sessionKeyFor(linkId: string): string {
  return `kletia-link-intent:${linkId}`;
}

function newReference(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `link-page:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The ticket stamp for the visitor's intent, by shape: planned, signed, settled, held, failed. */
function stampFor(intent: IntentGraph | null): { state: StampState; detail?: string; caption?: string; words: string } | null {
  if (!intent) return null;
  const legs = intent.steps.filter((step) => step.mode === "wallet").length || intent.steps.length;
  const signed = intent.steps.filter((step) => (step.references?.length ?? 0) > 0 || ["submitted", "confirmed", "settling", "settled"].includes(step.status)).length;
  switch (intent.status) {
    case "completed":
      return { state: "settled", detail: "FINAL", words: "Settled: every leg was seen on-chain." };
    case "failed":
    case "partially_completed":
    case "expired":
      return { state: "failed", words: "The route stopped before every leg settled." };
    case "cancelled":
      return { state: "planned", detail: "CANCELLED", words: "Cancelled. Nothing was sent." };
    case "indeterminate":
      return { state: "held", words: "Held: the outcome is being recovered by transaction hash." };
    default:
      return signed > 0
        ? { state: "signed", caption: `Leg ${Math.min(signed, legs)} of ${legs}`, words: `Signed ${Math.min(signed, legs)} of ${legs} legs in your wallet.` }
        : { state: "planned", words: "Planned. Nothing has been signed." };
  }
}

function LinkSign({ linkId, view, option, amount, needed, quoted, onClose }: LinkSignPanelProps) {
  const execution = useIntentExecution({ sessionKey: sessionKeyFor(linkId) });
  const [created, setCreated] = useState<{ readonly intent: IntentGraph; readonly preview: IntentPreview | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<PlatformError | null>(null);
  const referenceRef = useRef(newReference());

  const needsEvm = needed.includes("eip155");
  const needsSolana = needed.includes("solana");
  const walletsReady = (!needsEvm || Boolean(execution.evm)) && (!needsSolana || Boolean(execution.solana));
  const accounts = useMemo(
    () => visitorAccounts(needed, option.network, quoted ?? { steps: [] }, { evm: execution.evm?.address ?? null, solana: execution.solana?.address ?? null }),
    [execution.evm?.address, execution.solana?.address, needed, option.network, quoted],
  );

  // A different wallet or choice means a different plan: drop one that was not started.
  const accountsKey = accounts.join(",");
  const plannedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (created && plannedForRef.current !== accountsKey && !execution.intent) {
      setCreated(null);
      referenceRef.current = newReference();
    }
  }, [accountsKey, created, execution.intent]);

  const plan = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const response = await createLinkIntent(
        linkId,
        { network: option.network, asset: option.symbol, ...(amount ? { amount } : {}) },
        accounts,
        referenceRef.current,
      );
      plannedForRef.current = accountsKey;
      setCreated({ intent: response.intent, preview: response.preview ?? null });
    } catch (error) {
      setCreateError(toPlatformError(error));
      referenceRef.current = newReference();
    } finally {
      setCreating(false);
    }
  }, [accounts, accountsKey, amount, linkId, option.network, option.symbol]);

  const describeAccount = useCallback(
    (accountId: AccountId) => {
      for (const account of [execution.evm, execution.solana]) {
        if (account && sameOwner(account.accountId, accountId)) return `${account.walletName} · ${shortenAddress(account.address)}`;
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

  const live = execution.intent ?? created?.intent ?? null;
  const stamp = stampFor(live);
  const binding = created && !execution.intent ? findBindingProblem(created.intent, execution.accounts) : null;
  const resumable = !created && !execution.intent ? execution.resumableIntentId : null;
  const busy = creating || execution.status === "executing" || execution.status === "planning";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className={cx(LABEL, "text-[#0047E0] dark:text-[#7EA6FF]")}>Sign in your wallet</p>
          <h3 id="kl-link-sign-heading" tabIndex={-1} className="mt-1 font-display text-2xl font-bold tracking-[-0.02em] focus:outline-none">
            From {option.networkName} {option.symbol}
            {amount ? `, ${amount} ${option.symbol}` : ""}
          </h3>
        </div>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy} aria-label="Close signing">
          <X className="h-4 w-4" aria-hidden="true" />
          Close
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <aside className="flex flex-col gap-4">
          <div className={cx("flex flex-col gap-3 p-4", INK_BORDER, HARD_SHADOW, SURFACE)}>
            <p className={LABEL}>Wallets this link needs</p>
            <WalletDock evmWorkspace={false} className="flex-wrap" />
            <ul className="flex flex-col gap-2">
              {needsEvm ? (
                <li className="flex items-center justify-between gap-2 text-sm font-bold">
                  <span className="flex items-center gap-2">
                    <Wallet className="h-4 w-4" aria-hidden="true" />
                    EVM wallet
                  </span>
                  <span className={cx("font-code text-xs", execution.evm ? "" : TEXT_MUTED)}>{execution.evm ? shortenAddress(execution.evm.address) : "Not connected"}</span>
                </li>
              ) : null}
              {needsSolana ? (
                <li className="flex items-center justify-between gap-2 text-sm font-bold">
                  <span className="flex items-center gap-2">
                    <Wallet className="h-4 w-4" aria-hidden="true" />
                    Solana wallet
                  </span>
                  <span className={cx("font-code text-xs", execution.solana ? "" : TEXT_MUTED)}>{execution.solana ? shortenAddress(execution.solana.address) : "Not connected"}</span>
                </li>
              ) : null}
            </ul>
            <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
              Kletia never holds keys. {view.publisher.name} can see the wallet addresses of intents created from this link.
            </p>
          </div>
          {stamp ? (
            <div className={cx("flex flex-col items-center gap-2 p-4", INK_BORDER, "bg-[#FFFCF2] text-[#1A1A1A]")}>
              <p className="kla-sr" role="status">
                {stamp.words}
              </p>
              <Stamp state={stamp.state} {...(stamp.detail ? { detail: stamp.detail } : {})} {...(stamp.caption ? { caption: stamp.caption } : {})} animate className="kl-link-stamp" />
            </div>
          ) : null}
        </aside>

        <div className="flex min-w-0 flex-col gap-5">
          {resumable ? (
            <div className={cx("flex flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
              <p className="font-display text-lg font-bold">Pick up where you left off</p>
              <p className="text-sm leading-relaxed">
                This tab was signing an intent from this link before it reloaded. Resuming refreshes it from Kletia; steps already sent are never
                signed again.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button size="sm" onClick={() => void execution.resume(resumable)}>
                  <History className="h-3.5 w-3.5" aria-hidden="true" />
                  Resume
                </Button>
                <Button size="sm" variant="secondary" onClick={() => execution.forgetResumable()}>
                  Start over
                </Button>
              </div>
            </div>
          ) : null}

          {!execution.intent && !created ? (
            <div className={cx("flex flex-col gap-3 p-4 sm:p-5", INK_BORDER, SURFACE)}>
              <p className="font-display text-lg font-bold">Plan with your wallet</p>
              <p className="text-sm leading-relaxed">
                {walletsReady
                  ? "Kletia plans this link again with your own account, balance and live quotes. Nothing is signed yet."
                  : `Connect ${needsEvm && needsSolana ? "an EVM and a Solana wallet" : needsSolana ? "a Solana wallet" : "an EVM wallet"} to plan with your own account.`}
              </p>
              <Button className="self-start" onClick={() => void plan()} disabled={!walletsReady || creating || accounts.length === 0}>
                <PenLine className="h-4 w-4" aria-hidden="true" />
                {creating ? "Planning" : "Plan with my wallet"}
              </Button>
              {createError ? <ApiErrorPanel error={createError} title="Kletia could not plan this link" onRetry={() => void plan()} /> : null}
            </div>
          ) : null}

          {created && !execution.intent ? (
            <IntentReview
              intent={created.intent}
              preview={created.preview}
              ownedAccounts={execution.accounts}
              describeAccount={describeAccount}
              blockedReason={binding?.message ?? null}
              onReplan={() => void plan()}
              // Confirming this review approves the fare it shows: it is not asked for again before the first
              // signature. Its digest still goes to prepare, and a fare that changed is shown again.
              onConfirm={() => void execution.resume(created.intent.id, { approvedPreview: created.preview })}
            />
          ) : null}

          {execution.intent ? (
            <IntentExecutionFlow execution={execution} describeAccount={describeAccount} walletFor={walletFor} notifyProgress showGraph={false} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Lazily loaded signing panel: wallet providers plus the shared execution flow. */
export default function LinkSignPanel(props: LinkSignPanelProps) {
  return (
    <WalletProviders>
      <LinkSign key={`${props.option.key}:${props.amount ?? ""}`} {...props} />
    </WalletProviders>
  );
}
