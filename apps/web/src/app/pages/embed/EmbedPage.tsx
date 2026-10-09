import "@fontsource-variable/inter";

import type { AccountId, IntentGraph } from "@kletia/core";
import { DEFAULT_WIDGET_EXAMPLES, KletiaIntentWidget } from "@kletia/widget";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { LazyBoundary } from "../../../shared/components/LazyBoundary";
import { externalRecipients, leaseSigners, PREVIEW_ACCOUNTS } from "../../../shared/platform/intentBinding";
import { syncIntentActivity } from "../../../shared/platform/intentActivity";
import { useRoute } from "../../routes/useRoute";
import { Skeleton } from "../../site/ui/Skeleton";
import { createEmbedClient } from "./embedClient";
import {
  applyEmbedDocumentMode,
  leaveEmbedDocumentMode,
  readEmbedParams,
  watchSystemTheme,
} from "./embedParams";
import type { EmbedWalletState } from "./EmbedWalletBar";

const EmbedWalletBar = React.lazy(() => import("./EmbedWalletBar"));

const PREVIEW_ACCOUNT_LIST: readonly AccountId[] = [
  PREVIEW_ACCOUNTS.evm as AccountId,
  PREVIEW_ACCOUNTS.solana as AccountId,
];

const EMBED_METADATA = Object.freeze({ surface: "embed" });

/**
 * The prompt can be prefilled by the site that embeds this page, so a plan
 * that pays an address outside the user's own accounts is called out before
 * the Execute button, with the full address (no truncation to spoof).
 */
function ExternalRecipientWarning({ intent, owned, live }: { intent: IntentGraph; owned: readonly AccountId[]; live: boolean }) {
  const recipients = externalRecipients(intent, owned);
  if (recipients.length === 0) return null;
  return (
    <div
      role="alert"
      className="kl-rise kl-attn-ring kl-attn-ring--once flex flex-col gap-2 border-[3px] border-[#1A1A1A] bg-[#FFF3B0] p-3 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#B45309] dark:shadow-[3px_3px_0_#475569]"
    >
      <p className="text-xs font-black uppercase tracking-[0.12em]">Check the recipient</p>
      <p className="text-sm font-semibold">
        This plan sends funds to {recipients.length === 1 ? "an address" : "addresses"} outside{" "}
        {live ? "your connected wallets" : "the accounts it was planned for"}:
      </p>
      <ul className="flex flex-col gap-1">
        {recipients.map((item) => (
          <li key={`${item.stepId}:${item.recipient}`} className="text-xs font-semibold">
            Step {item.stepIndex + 1} on {item.network}:{" "}
            <span className="break-all font-mono font-bold">{item.recipient.slice(item.recipient.lastIndexOf(":") + 1)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs font-semibold">
        The request in this widget can be prefilled by the site that embeds it. Only sign if you meant to pay this
        address.
      </p>
    </div>
  );
}

/** The widget keeps planning (dry runs) when the wallet runtime cannot load. */
function WalletBarFailed() {
  return (
    <p
      role="status"
      className="border-[3px] border-[#1A1A1A] bg-[#FFF3B0] px-3 py-2 text-xs font-bold text-[#1A1A1A] dark:border-[#B45309]"
    >
      Wallets could not load in this frame, so plans stay previews. Reload the page or open Kletia in a new tab to
      execute.
    </p>
  );
}

/**
 * Mirrors the wallet bar box for box (padding, label width, two 44px wallet
 * pills, wrapping), so nothing below it moves when the wallet runtime
 * arrives. Static: the embed runs no loops.
 */
function WalletBarFallback() {
  return (
    <div
      role="status"
      className="flex min-h-[3.75rem] flex-wrap items-center justify-between gap-2 border-[3px] border-dashed border-[#1A1A1A]/40 px-2.5 py-2 dark:border-white/20"
    >
      <p className="relative flex min-w-0 items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#45464B] dark:text-[#A9B6C8]">
        <Skeleton as="span" shimmer={false} className="h-3.5 w-3.5 shrink-0 border-2" />
        {/* Reserves the width of the bar's own label so both wrap at the same widths. */}
        <span className="invisible" aria-hidden="true">
          Plan only · connect to execute
        </span>
        <span className="absolute inset-y-0 left-5 flex items-center whitespace-nowrap">Loading wallets…</span>
      </p>
      <div className="flex items-center gap-1.5 sm:gap-2" aria-hidden="true">
        <Skeleton shimmer={false} className="h-11 w-[54px]" />
        <Skeleton shimmer={false} className="h-11 w-[68px]" />
      </div>
    </div>
  );
}

/**
 * Embeddable intent widget (`/embed`): no site shell, a compact wallet bar
 * and `KletiaIntentWidget`. Without a wallet it plans dry runs for demo
 * accounts; with wallets it plans with the user's accounts and executes with
 * their signatures. Public tier only: no API key is read from the URL.
 */
export default function EmbedPage() {
  const { location } = useRoute();
  const params = useMemo(() => readEmbedParams(location.search), [location.search]);
  const [wallet, setWallet] = useState<EmbedWalletState>({ accounts: [], signers: undefined });
  const [lastText, setLastText] = useState(params.text);
  const [planned, setPlanned] = useState<{ key: string; intent: IntentGraph } | null>(null);

  useLayoutEffect(() => {
    applyEmbedDocumentMode(params);
    return () => leaveEmbedDocumentMode();
  }, [params]);

  useEffect(() => {
    if (params.theme !== "auto") return undefined;
    return watchSystemTheme(() => applyEmbedDocumentMode(params));
  }, [params]);

  const live = wallet.accounts.length > 0 && wallet.signers !== undefined;
  const accountsKey = wallet.accounts.join(",");

  // The widget's executor checks for cancellation only between steps, so a
  // step being prepared when the widget remounts (wallet switched or
  // disconnected) or the page unmounts would still open a wallet prompt.
  // Signers handed to one widget instance stop working once it is replaced.
  const lease = useMemo(() => (live && wallet.signers ? leaseSigners(wallet.signers) : null), [live, wallet.signers]);
  useEffect(() => lease?.activate(), [lease]);
  const client = useMemo(() => createEmbedClient(live ? "live" : "plan"), [live]);
  const accounts = live ? wallet.accounts : PREVIEW_ACCOUNT_LIST;

  // A new account set invalidates any plan on screen: start fresh with the last prompt.
  const widgetKey = live ? `live:${accountsKey}` : "plan";
  const plannedIntent = planned?.key === widgetKey ? planned.intent : null;

  const onIntentCreated = useCallback(
    (intent: IntentGraph) => {
      if (intent.request.text) setLastText(intent.request.text);
      setPlanned({ key: widgetKey, intent });
    },
    [widgetKey],
  );

  return (
    <main
      id="main-content"
      className="mx-auto flex w-full max-w-[492px] flex-col gap-3 px-1.5 pb-3 pt-1.5 font-body text-[#1A1A1A] dark:text-[#F1F5F9]"
    >
      <h1 className="sr-only">Kletia intent widget</h1>
      <LazyBoundary fallback={() => <WalletBarFailed />}>
        <React.Suspense fallback={<WalletBarFallback />}>
          <EmbedWalletBar onChange={setWallet} />
        </React.Suspense>
      </LazyBoundary>
      {!live ? (
        <p className="kl-fade-in px-0.5 text-xs font-semibold text-[#45464B] dark:text-[#A9B6C8]">
          Plans below use demo accounts and are not saved. Connect a wallet to plan with your own accounts and sign.
        </p>
      ) : null}
      {plannedIntent ? (
        // Keyed by plan: a new plan with an outside recipient rises in and rings once again.
        <ExternalRecipientWarning key={plannedIntent.id} intent={plannedIntent} owned={accounts} live={live} />
      ) : null}
      <KletiaIntentWidget
        key={widgetKey}
        client={client}
        accounts={accounts}
        {...(lease ? { signers: lease.signers } : {})}
        defaultText={lastText}
        examples={params.examples ?? DEFAULT_WIDGET_EXAMPLES}
        theme={params.theme}
        metadata={EMBED_METADATA}
        onIntentCreated={onIntentCreated}
        onUpdate={syncIntentActivity}
        onComplete={syncIntentActivity}
        className="!max-w-none"
      />
    </main>
  );
}
