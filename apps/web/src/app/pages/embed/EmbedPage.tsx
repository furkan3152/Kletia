import "@fontsource-variable/inter";

import {
  appearanceFromParams,
  CHAINS,
  validateAppearance,
  type AccountId,
  type IntentGraph,
  type KletiaAppearance,
  type NetworkKey,
  type SessionView,
} from "@kletia/core";
import { KletiaApiError } from "@kletia/sdk";
import { DEFAULT_WIDGET_EXAMPLES, ensureWidgetStyles, KletiaIntentWidget } from "@kletia/widget";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { WidgetAction } from "@kletia/widget";

import { LazyBoundary } from "../../../shared/components/LazyBoundary";
import { externalRecipients, leaseSigners, PREVIEW_ACCOUNTS } from "../../../shared/platform/intentBinding";
import { syncIntentActivity } from "../../../shared/platform/intentActivity";
import { readStorage } from "../../../shared/state/safeStorage";
import { SOLANA_WALLET_STORAGE_KEY } from "../../../shared/wallet/solana/solanaWalletContext";
import { useRoute } from "../../routes/useRoute";
import { Skeleton } from "../../site/ui/Skeleton";
import { readBridgeParams } from "./embedBridge";
import { EmbedBridgeNotice } from "./EmbedBridgeNotice";
import { BACKEND_URL } from "../../../shared/config/runtime";
import { createEmbedClient, type EmbedClientProject } from "./embedClient";
import {
  applyEmbedDocumentMode,
  EMBED_PILL_CLASS,
  embedWalletVms,
  isFramed,
  leaveEmbedDocumentMode,
  mergeAppearance,
  profileView,
  readEmbedFragment,
  readEmbedKey,
  readEmbedParams,
  readEmbedScope,
  searchWithDefaults,
  watchSystemTheme,
  type EmbedBrand,
  type EmbedKeyTarget,
  type EmbedTarget,
  type EmbedVm,
} from "./embedParams";
import type { EmbedBridge } from "./embedBridge";
import { embedTargetKey, embedWidgetKey, openIntentFor, type SessionIntent } from "./embedTarget";
import type { EmbedWalletState } from "./EmbedWalletBar";
import { useEmbedBridge, useEmbedResize } from "./useEmbedBridge";

/** The wallet runtime (wagmi, RainbowKit, the Solana wallet layer): fetched on Connect, or ahead of it on hover or focus. */
const loadWalletBar = () => import("./EmbedWalletBar");
const EmbedWalletBar = React.lazy(loadWalletBar);
let walletBarPrefetch: Promise<unknown> | null = null;
function prefetchWalletBar(): void {
  walletBarPrefetch ??= loadWalletBar().catch(() => {
    walletBarPrefetch = null;
  });
}

/** A visitor who connected a wallet here before gets the runtime at once, so the wallet reconnects by itself. */
function walletRemembered(): boolean {
  return Boolean(readStorage("wagmi.recentConnectorId") || readStorage(SOLANA_WALLET_STORAGE_KEY));
}

/** Every network a plan touches: where its steps run and where bridges land. */
function intentNetworks(intent: IntentGraph): string[] {
  return intent.steps.flatMap((step) => [step.network, ...(step.settlement?.destinationNetwork ? [step.settlement.destinationNetwork] : [])]);
}

const PREVIEW_ACCOUNT_LIST: readonly AccountId[] = [
  PREVIEW_ACCOUNTS.evm as AccountId,
  PREVIEW_ACCOUNTS.solana as AccountId,
];

const EMBED_METADATA: Readonly<Record<string, string>> = Object.freeze({ surface: "embed" });

/**
 * Who owns an account, without its network: an EVM wallet that switches
 * chain in the middle of a step (approve on one call, switch, supply on the
 * next) is still the same wallet and must not reset the widget.
 */
function ownerKey(accountId: string): string {
  if (!accountId.startsWith("eip155:")) return accountId;
  return `eip155:${accountId.slice(accountId.lastIndexOf(":") + 1).toLowerCase()}`;
}

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

/** A session (or a publishable key) runs only for the site that set it up, proven by the bridge. */
function SessionNeedsHost({ waiting, subject = "checkout" }: { waiting: boolean; subject?: "checkout" | "widget" }) {
  // The bridge notice gives a host 30 seconds to connect; so does this.
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setTimeout(() => setGaveUp(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  return (
    <p
      role="status"
      className="border-[3px] border-[#1A1A1A] bg-[#FFF3B0] px-3 py-2 text-sm font-semibold text-[#1A1A1A] dark:border-[#B45309]"
    >
      {waiting && !gaveUp
        ? "Connecting to the site that opened this widget…"
        : subject === "widget"
          ? "This widget must be opened through the Kletia embed element on the site that set it up. Nothing was planned or signed."
          : "This checkout must be opened from the site that created it, through the Kletia embed element. Nothing was planned or signed."}
    </p>
  );
}

/** A plain refusal box: the frame plans nothing (integrator 4.3 states). */
function EmbedRefusal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 border-[3px] border-[#1A1A1A] bg-[#FFF3B0] p-3 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#B45309] dark:shadow-[3px_3px_0_#475569]"
    >
      <p className="text-xs font-black uppercase tracking-[0.12em]">{title}</p>
      <p className="text-sm font-semibold">{children}</p>
    </div>
  );
}

/**
 * The verified project's name (and logo) above the widget. Only from a
 * profile whose domain Kletia verified, on a host the project allowed;
 * nothing a URL or an attribute sets can put a name here.
 */
function BrandHeader({ brand }: { brand: EmbedBrand }) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 px-0.5">
      {brand.logoPath && !logoFailed ? (
        <img
          src={`${BACKEND_URL}${brand.logoPath}`}
          alt=""
          referrerPolicy="no-referrer"
          className="h-5 w-auto max-w-[80px] object-contain"
          onError={() => setLogoFailed(true)}
        />
      ) : null}
      <p className="min-w-0 truncate text-sm font-black uppercase tracking-[0.08em]">{brand.name}</p>
      {brand.host ? (
        <p className="text-xs font-bold text-[#0F6B3A] dark:text-[#6EE7A8]">
          <span aria-hidden="true">✓ </span>
          <span className="sr-only">Domain verified: </span>
          {brand.host}
        </p>
      ) : null}
    </div>
  );
}

/** Testnet lane: test assets only. Not themable and always above the widget. */
function TestnetRibbon() {
  return (
    <p
      role="note"
      className="border-[3px] border-dashed border-[#1A1A1A] bg-[#E9D5FF] px-3 py-1 text-center text-xs font-black uppercase tracking-[0.16em] text-[#1A1A1A] dark:border-[#C4B5FD]"
    >
      Testnet · test assets only
    </p>
  );
}

type ProjectState =
  | { readonly status: "loading" }
  | { readonly status: "refused"; readonly code: "PUBLISHABLE_ORIGIN_FORBIDDEN"; readonly host: string }
  | { readonly status: "refused"; readonly code: "FLOW_UNKNOWN" | "UNAVAILABLE" }
  | {
      readonly status: "ready";
      readonly view: Extract<ReturnType<typeof profileView>, { ok: true }>;
      readonly project: EmbedClientProject;
      /** The single-use session minted from the stored flow. */
      readonly sessionId: string | null;
    };

/**
 * One profile read (and one flow session) per key, flow and proven host for
 * the life of the document: a flow session is single use, so a remount (React
 * StrictMode, a theme change) must never mint a second one.
 */
const projectLoads = new Map<string, Promise<ProjectState>>();

function loadProject(keyTarget: EmbedKeyTarget, hostOrigin: string): Promise<ProjectState> {
  const cacheKey = `${keyTarget.key}|${keyTarget.flow ?? ""}|${hostOrigin}`;
  const cached = projectLoads.get(cacheKey);
  if (cached) return cached;
  const project: EmbedClientProject = { publishableKey: keyTarget.key, hostOrigin };
  const load = (async (): Promise<ProjectState> => {
    const client = createEmbedClient("plan", project);
    try {
      const view = profileView(await client.publishable.profile(), hostOrigin, keyTarget.flow);
      if (!view.ok) {
        if (view.code === "PUBLISHABLE_ORIGIN_FORBIDDEN") return { status: "refused", code: view.code, host: view.host };
        return { status: "refused", code: view.code === "FLOW_UNKNOWN" ? "FLOW_UNKNOWN" : "UNAVAILABLE" };
      }
      const session = view.flow ? await client.sessions.create({ flow: view.flow, hostOrigin }) : null;
      return { status: "ready", view, project, sessionId: session?.id ?? null };
    } catch (error) {
      const code = error instanceof KletiaApiError ? error.code : null;
      if (code === "PUBLISHABLE_ORIGIN_FORBIDDEN") return { status: "refused", code: "PUBLISHABLE_ORIGIN_FORBIDDEN", host: new URL(hostOrigin).host };
      if (code === "FLOW_UNKNOWN") return { status: "refused", code: "FLOW_UNKNOWN" };
      // Nothing to retry blindly: the visitor reloads, the host sees the code.
      projectLoads.delete(cacheKey);
      return { status: "refused", code: "UNAVAILABLE" };
    }
  })();
  projectLoads.set(cacheKey, load);
  return load;
}

/**
 * Phase 2 (integrator 4.8): with `#key=kl_pub_…` the frame needs the bridge,
 * reads the project profile with the proven host origin, refuses a host the
 * project did not allow and mints the stored flow's session. `null` without a key.
 */
function useProject(keyTarget: EmbedKeyTarget | null, hostOrigin: string | null, bridge: EmbedBridge | null): ProjectState | null {
  const [state, setState] = useState<{ readonly for: string; readonly value: ProjectState } | null>(null);
  const cacheKey = keyTarget && hostOrigin ? `${keyTarget.key}|${keyTarget.flow ?? ""}|${hostOrigin}` : null;
  useEffect(() => {
    if (!keyTarget || !hostOrigin || !cacheKey) return undefined;
    let current = true;
    void loadProject(keyTarget, hostOrigin).then((value) => {
      if (!current) return;
      setState({ for: cacheKey, value });
      if (value.status === "refused") bridge?.error({ code: value.code === "UNAVAILABLE" ? "EMBED_ERROR" : value.code });
    });
    return () => {
      current = false;
    };
  }, [bridge, cacheKey, hostOrigin, keyTarget]);
  if (!keyTarget || !cacheKey) return null;
  return state?.for === cacheKey ? state.value : { status: "loading" };
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
        {/* The dock's two connect pills: "EVM" / "SOL" on phones, "Connect EVM" / "Connect Solana" from sm. */}
        <Skeleton shimmer={false} className="h-11 w-[54px] sm:w-[128px]" />
        <Skeleton shimmer={false} className="h-11 w-[68px] sm:w-[173px]" />
      </div>
    </div>
  );
}

/**
 * The wallet bar before the wallet runtime loads: the same box with the
 * connect buttons this frame needs. Hover or focus prefetches the runtime;
 * a click loads it and opens that wallet's picker.
 */
function WalletConnectBar({ vms, onConnect }: { vms: ReadonlySet<EmbedVm>; onConnect: (vm: EmbedVm) => void }) {
  return (
    <div
      role="region"
      aria-label="Wallets"
      className="flex min-h-[3.75rem] flex-wrap items-center justify-between gap-2 border-[3px] border-[#1A1A1A] bg-white px-2.5 py-2 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#111827] dark:text-[#F4F4F5] dark:shadow-[3px_3px_0_#475569]"
    >
      <p className="flex min-w-0 items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em]">
        <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 border-2 border-[#0052FF] dark:border-[#7EA6FF]" />
        <span>Plan only · connect to execute</span>
      </p>
      <div role="group" aria-label="Connect a wallet" className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        {vms.has("evm") ? (
          <button
            type="button"
            aria-label="Connect EVM wallet"
            onPointerEnter={prefetchWalletBar}
            onFocus={prefetchWalletBar}
            onClick={() => onConnect("evm")}
            className={`${EMBED_PILL_CLASS} bg-[#0052FF] text-white focus-visible:outline-[#FFD60A]`}
          >
            <span className="sm:hidden">EVM</span>
            <span className="hidden sm:inline">Connect EVM</span>
          </button>
        ) : null}
        {vms.has("svm") ? (
          <button
            type="button"
            aria-label="Connect Solana wallet"
            onPointerEnter={prefetchWalletBar}
            onFocus={prefetchWalletBar}
            onClick={() => onConnect("svm")}
            className={`${EMBED_PILL_CLASS} whitespace-nowrap bg-[#9945FF] text-white focus-visible:outline-[#9945FF]`}
          >
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 border border-[#1A1A1A] bg-gradient-to-br from-[#9945FF] to-[#14F195]" />
            <span className="sm:hidden">SOL</span>
            <span className="hidden sm:inline">Connect Solana</span>
          </button>
        ) : null}
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
  // Integrator-created work (`#intent=` / `#session=`): ids travel in the fragment only.
  const fragmentTarget = useMemo(() => readEmbedFragment(location.hash), [location.hash]);
  // A project's publishable key (and stored flow), also in the fragment; integrator-created work wins.
  const keyTarget = useMemo(() => (fragmentTarget ? null : readEmbedKey(location.hash)), [fragmentTarget, location.hash]);
  const bridgeParams = useMemo(() => readBridgeParams(location.search), [location.search]);
  const { bridge, snapshot: bridgeSnapshot } = useEmbedBridge();
  const provenHost = bridgeSnapshot.status === "connected" ? bridgeSnapshot.origin : null;
  const projectState = useProject(keyTarget, provenHost, bridge);
  const project = projectState?.status === "ready" ? projectState : null;
  // The project's defaults sit under the element's own settings (attributes win).
  const search = useMemo(() => (project ? searchWithDefaults(location.search, project.view.defaults) : location.search), [location.search, project]);
  const params = useMemo(() => readEmbedParams(search), [search]);
  const target = useMemo<EmbedTarget | null>(
    () => fragmentTarget ?? (project?.sessionId ? { kind: "session", id: project.sessionId } : null),
    [fragmentTarget, project],
  );
  // Cosmetic and scope settings from the URL, validated here (the element validated them too): anything a URL sets
  // is presentation or a refusal boundary, never trust.
  const appearance = useMemo(() => {
    const fromUrl = appearanceFromParams(new URLSearchParams(location.search)).appearance;
    const defaults = project ? validateAppearance(project.view.defaults.appearance) : null;
    return mergeAppearance<KletiaAppearance>(defaults?.ok ? defaults.value : null, fromUrl);
  }, [location.search, project]);
  const scope = useMemo(() => readEmbedScope(search, CHAINS), [search]);
  const scopeNetworks = useMemo(() => (scope.networks ?? undefined) as readonly NetworkKey[] | undefined, [scope.networks]);
  const scopeActions = useMemo(() => (scope.actions ?? undefined) as readonly WidgetAction[] | undefined, [scope.actions]);
  const [framed] = useState(isFramed);
  /** null until the visitor asks for a wallet ("" = load without opening a picker, for a remembered wallet). */
  const [walletRequest, setWalletRequest] = useState<EmbedVm | "" | null>(() => (walletRemembered() ? "" : null));
  const [sessionView, setSessionView] = useState<SessionView | null>(null);
  useEmbedResize(bridge);
  // The host's reference travels with the intent so its server can match it (it is publicly readable).
  const metadata = useMemo(
    () => (bridgeParams.reference ? Object.freeze({ surface: "embed", hostRef: bridgeParams.reference }) : EMBED_METADATA),
    [bridgeParams.reference],
  );
  const [wallet, setWallet] = useState<EmbedWalletState>({ accounts: [], signers: undefined });
  const [lastText, setLastText] = useState(params.text);
  const [planned, setPlanned] = useState<{ key: string; intent: IntentGraph } | null>(null);
  /**
   * The intent a session created for this visitor: reopened by id if the widget remounts (the session may be
   * used up), and only while that same session is the target (a host moving the frame to another session never
   * shows this one's intent).
   */
  const [sessionIntent, setSessionIntent] = useState<SessionIntent | null>(null);
  const openIntentId = openIntentFor(target, sessionIntent);
  const sessionNetworks = useMemo(
    () =>
      target?.kind === "session" && sessionView?.id === target.id
        ? sessionView.actions.flatMap((action) => [action.network, ...(action.toNetwork ? [action.toNetwork] : [])])
        : null,
    [sessionView, target],
  );

  useLayoutEffect(() => {
    applyEmbedDocumentMode(params);
    return () => leaveEmbedDocumentMode();
  }, [params]);

  // The widget injects its stylesheet in an effect, after its first paint; inject it before paint
  // so the frame never shows the unstyled widget and then shifts.
  useLayoutEffect(() => ensureWidgetStyles(), []);

  useEffect(() => {
    if (params.theme !== "auto") return undefined;
    return watchSystemTheme(() => applyEmbedDocumentMode(params));
  }, [params]);

  const live = wallet.accounts.length > 0 && wallet.signers !== undefined;
  const openedIntent = planned?.intent && target?.kind === "intent" ? planned.intent : null;
  const vmsKey = [
    ...embedWalletVms({ networks: scope.networks, session: sessionNetworks, intent: openedIntent ? intentNetworks(openedIntent) : null }, CHAINS),
  ]
    .sort()
    .join(",");
  const vms = useMemo(() => new Set(vmsKey.split(",") as EmbedVm[]), [vmsKey]);
  const accountsKey = wallet.accounts.map(ownerKey).join(",");
  const targetKey = embedTargetKey(target);

  // The widget's executor checks for cancellation only between steps, so a
  // step being prepared when the widget remounts (wallet switched or
  // disconnected, or the host moved the frame to another target) or the page
  // unmounts would still open a wallet prompt. Signers handed to one widget
  // instance stop working once it is replaced; the lease is keyed by the
  // target too, and switches before the new widget's effects run.
  const lease = useMemo(
    () => (live && wallet.signers ? { targetKey, ...leaseSigners(wallet.signers) } : null),
    [live, targetKey, wallet.signers],
  );
  useLayoutEffect(() => lease?.activate(), [lease]);
  const projectClient = project?.project ?? null;
  const client = useMemo(() => createEmbedClient(live ? "live" : "plan", projectClient), [live, projectClient]);
  const accounts = live ? wallet.accounts : PREVIEW_ACCOUNT_LIST;

  // A new account set or a new target invalidates any plan on screen: start fresh with the last prompt.
  // Keyed on owners, not networks, so a mid-step chain switch keeps the running execution.
  const widgetKey = embedWidgetKey(live, accountsKey, target);
  const plannedIntent = planned?.key === widgetKey ? planned.intent : null;

  const onIntentCreated = useCallback(
    (intent: IntentGraph) => {
      if (intent.request.text) setLastText(intent.request.text);
      setPlanned({ key: widgetKey, intent });
      if (target?.kind === "session") {
        // A session's intent is stored with the integrator's key; its client reference is the host's own.
        setSessionIntent({ sessionId: target.id, intentId: intent.id });
        bridge?.intentCreated(intent, true, intent.request.clientReference ?? null);
        return;
      }
      // Previews (no wallet) are dry runs: the host learns that a plan exists, never an id.
      bridge?.intentCreated(intent, live);
    },
    [bridge, live, target, widgetKey],
  );
  const onIntentOpened = useCallback(
    (intent: IntentGraph) => {
      setPlanned({ key: widgetKey, intent });
      bridge?.trackIntent(intent);
    },
    [bridge, widgetKey],
  );
  const onUpdate = useCallback(
    (intent: IntentGraph) => {
      syncIntentActivity(intent);
      bridge?.intentUpdated(intent);
    },
    [bridge],
  );
  const onComplete = useCallback(
    (intent: IntentGraph) => {
      syncIntentActivity(intent);
      bridge?.intentCompleted(intent);
    },
    [bridge],
  );
  const onError = useCallback((error: unknown) => bridge?.error(error), [bridge]);
  // Questions before a plan: the host learns how many and why, never the values.
  const onClarify = useCallback((report: unknown) => bridge?.question(report), [bridge]);
  const onSessionLoaded = useCallback((view: SessionView) => setSessionView(view), []);

  // Flow A: the host's backend created the intent. Flow B: a session; it needs the host origin the bridge proved.
  const sessionWaiting = target?.kind === "session" && !openIntentId && bridge !== null && bridgeSnapshot.status !== "connected";
  const sessionBlocked = target?.kind === "session" && !openIntentId && (bridge === null || bridgeSnapshot.status !== "connected");
  // A publishable key needs the bridge (the proven host is checked against the project), then the profile.
  const keyGate: React.ReactNode = !keyTarget ? null : bridge === null || !provenHost ? (
    <SessionNeedsHost waiting={bridge !== null} subject="widget" />
  ) : projectState?.status === "loading" ? (
    <p role="status" className="px-0.5 text-sm font-semibold text-[#45464B] dark:text-[#A9B6C8]">
      Loading this site&apos;s settings…
    </p>
  ) : projectState?.status === "refused" ? (
    projectState.code === "PUBLISHABLE_ORIGIN_FORBIDDEN" ? (
      <EmbedRefusal title="Not set up for this site">
        This widget is not set up for {projectState.host}. Nothing was planned.
      </EmbedRefusal>
    ) : projectState.code === "FLOW_UNKNOWN" ? (
      <EmbedRefusal title="Checkout not available">This checkout is not set up on this site. Nothing was planned.</EmbedRefusal>
    ) : (
      <EmbedRefusal title="Not available right now">This site&apos;s widget settings could not be read. Nothing was planned; reload to try again.</EmbedRefusal>
    )
  ) : null;

  return (
    <main
      id="main-content"
      className={`mx-auto flex w-full max-w-[492px] flex-col gap-3 px-1.5 pb-3 pt-1.5 font-body text-[#1A1A1A] dark:text-[#F1F5F9]${framed ? "" : " min-h-screen justify-center py-8"}`}
    >
      <h1 className="sr-only">Kletia intent widget</h1>
      {framed ? null : (
        <p className="px-0.5 text-sm font-semibold text-[#45464B] dark:text-[#A9B6C8]">
          This is the widget partners embed.{" "}
          <a className="font-bold text-[#0047E0] underline underline-offset-2 dark:text-[#7EA6FF]" href="/developers/embed">
            Build yours in the Embed builder.
          </a>
        </p>
      )}
      {bridge && bridgeParams.hostOrigin ? (
        <EmbedBridgeNotice bridge={bridge} snapshot={bridgeSnapshot} expectedOrigin={bridgeParams.hostOrigin} />
      ) : null}
      {keyGate ?? (
        <>
      {project?.view.testnet ? <TestnetRibbon /> : null}
      {project?.view.brand ? <BrandHeader brand={project.view.brand} /> : null}
      {walletRequest === null ? (
        <WalletConnectBar vms={vms} onConnect={setWalletRequest} />
      ) : (
        <LazyBoundary fallback={() => <WalletBarFailed />}>
          <React.Suspense fallback={<WalletBarFallback />}>
            <EmbedWalletBar onChange={setWallet} vms={vms} autoOpen={walletRequest || null} />
          </React.Suspense>
        </LazyBoundary>
      )}
      {!live ? (
        <p className="kl-fade-in px-0.5 text-xs font-semibold text-[#45464B] dark:text-[#A9B6C8]">
          {target?.kind === "intent"
            ? "Review it here, then connect the wallet it was prepared for to sign it."
            : target?.kind === "session"
              ? "Connect a wallet: the plan is made for your own accounts, and you sign every step."
              : "Plans below use demo accounts and are not saved. Connect a wallet to plan with your own accounts and sign."}
        </p>
      ) : null}
      {plannedIntent ? (
        // Keyed by plan: a new plan with an outside recipient rises in and rings once again.
        // Without a wallet, "own" accounts are the ones the plan was made for (demo accounts, or the
        // accounts an integrator planned its intent for); with one, the wallets connected here.
        <ExternalRecipientWarning
          key={plannedIntent.id}
          intent={plannedIntent}
          owned={live ? accounts : plannedIntent.request.accounts}
          live={live}
        />
      ) : null}
      {sessionBlocked ? (
        <SessionNeedsHost waiting={sessionWaiting} />
      ) : (
        <KletiaIntentWidget
          key={widgetKey}
          client={client}
          accounts={accounts}
          {...(lease ? { signers: lease.signers } : {})}
          defaultText={lastText}
          examples={params.examples ?? DEFAULT_WIDGET_EXAMPLES}
          theme={params.theme}
          appearance={appearance}
          {...(scopeNetworks ? { networks: scopeNetworks } : {})}
          {...(scopeActions ? { actions: scopeActions } : {})}
          {...(scope.source ? { sourceNetwork: scope.source as NetworkKey | "auto" } : {})}
          metadata={metadata}
          // Fares are asked for stored plans only: demo-account previews are not saved and cannot run.
          preview={live || target !== null}
          linkOrigin={typeof window === "undefined" ? null : window.location.origin}
          {...(openIntentId ? { intentId: openIntentId } : {})}
          {...(target?.kind === "session" && !openIntentId ? { sessionId: target.id, hostOrigin: bridgeSnapshot.origin } : {})}
          onIntentCreated={onIntentCreated}
          onIntentOpened={onIntentOpened}
          onSessionLoaded={onSessionLoaded}
          onUpdate={onUpdate}
          onComplete={onComplete}
          onError={onError}
          onClarify={onClarify}
          className="!max-w-none"
        />
      )}
        </>
      )}
    </main>
  );
}
