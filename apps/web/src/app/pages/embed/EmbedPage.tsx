import "@fontsource-variable/inter";

import type { AccountId, IntentGraph } from "@kletia/core";
import { DEFAULT_WIDGET_EXAMPLES, KletiaIntentWidget } from "@kletia/widget";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { PREVIEW_ACCOUNTS } from "../../../shared/platform/kletiaClient";
import { syncIntentActivity } from "../../../shared/platform/intentActivity";
import { useRoute } from "../../routes/useRoute";
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

function WalletBarFallback() {
  return (
    <div
      role="status"
      className="flex min-h-[3.75rem] items-center border-[3px] border-dashed border-[#1A1A1A]/40 px-3 text-[11px] font-black uppercase tracking-[0.12em] text-[#45464B] dark:border-white/20 dark:text-[#A9B6C8]"
    >
      Loading wallets…
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
  const client = useMemo(() => createEmbedClient(live ? "live" : "plan"), [live]);
  const accounts = live ? wallet.accounts : PREVIEW_ACCOUNT_LIST;

  const onIntentCreated = useCallback((intent: IntentGraph) => {
    if (intent.request.text) setLastText(intent.request.text);
  }, []);

  return (
    <main
      id="main-content"
      className="mx-auto flex w-full max-w-[492px] flex-col gap-3 px-1.5 pb-3 pt-1.5 font-body text-[#1A1A1A] dark:text-[#F1F5F9]"
    >
      <h1 className="sr-only">Kletia intent widget</h1>
      <React.Suspense fallback={<WalletBarFallback />}>
        <EmbedWalletBar onChange={setWallet} />
      </React.Suspense>
      {!live ? (
        <p className="px-0.5 text-xs font-semibold text-[#45464B] dark:text-[#A9B6C8]">
          Plans below use demo accounts and are not saved. Connect a wallet to plan with your own accounts and sign.
        </p>
      ) : null}
      <KletiaIntentWidget
        // A new account set invalidates any plan on screen: start fresh with the last prompt.
        key={live ? `live:${accountsKey}` : "plan"}
        client={client}
        accounts={accounts}
        {...(live && wallet.signers ? { signers: wallet.signers } : {})}
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
