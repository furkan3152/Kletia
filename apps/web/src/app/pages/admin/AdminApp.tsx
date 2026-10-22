/**
 * The signed-in panel (admin design G.2): the session state machine, the bar
 * (wallets, session, sign out), the section rail and the section outlet.
 *
 * Session rules on this side: a wallet that switches to another account than
 * the one that signed the session signs the panel out (gate state 7); an
 * expired session goes back to sign-in and keeps the section (state 6); a
 * Solana session reads everything and says plainly that on-chain EVM actions
 * need the EVM admin wallet connected.
 */
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Wallet } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { useSolanaWallet } from "../../../shared/wallet/solana/useSolanaWallet";
import { WalletDock } from "../../../shared/wallet/WalletDock";
import { navigate } from "../../routes/history";
import { subscribeLocation } from "../../routes/history";
import { Icon } from "../../site/art/Icon";
import type { IconName } from "../../site/art/icons";
import { Button } from "../../site/ui/Button";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { toast } from "../../site/ui/toast";
import type { AdminConsoleProps } from "./AdminConsole";
import { gateFor } from "./api/adminClient";
import { AdminContext, useWalletOps, type AdminContextValue, type AdminSectionId, type WalletOps } from "./api/useAdmin";
import { AdminFrame } from "./components/AdminFrame";
import { buildAddressBook } from "./model/preview";
import { countdownText, evmSignerFor, SOLANA_ONLY_NOTICE, sessionEndsAt, sessionKind, shortAddress, walletSwitchedAway, type ConnectedWallets } from "./model/session";
import type { AdminSessionView } from "./model/types";
import { AuditSection } from "./sections/Audit";
import { DeploySection } from "./sections/Deploy";
import { DeploymentsSection } from "./sections/Deployments";
import { EnvironmentSection } from "./sections/Environment";
import { ExportSection } from "./sections/Export";
import { FeesSection } from "./sections/Fees";
import { ManageSection } from "./sections/Manage";
import { OverviewSection } from "./sections/Overview";
import { SafeQueueSection } from "./sections/SafeQueue";
import { ServicesSection } from "./sections/Services";
import { SignInView } from "./SignInView";

const ADMIN_SECTIONS: readonly { readonly id: AdminSectionId; readonly label: string; readonly icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "board" },
  { id: "deployments", label: "Deployments", icon: "contract" },
  { id: "deploy", label: "Deploy", icon: "route" },
  { id: "manage", label: "Manage", icon: "key" },
  { id: "safe", label: "Safe queue", icon: "shield" },
  { id: "fees", label: "Fees", icon: "ticket" },
  { id: "services", label: "Services", icon: "sdk" },
  { id: "environment", label: "Environment", icon: "verify" },
  { id: "audit", label: "Audit log", icon: "name" },
  { id: "export", label: "Export", icon: "transfer" },
];

function readSection(): AdminSectionId {
  if (typeof window === "undefined") return "overview";
  const value = new URLSearchParams(window.location.search).get("section");
  return ADMIN_SECTIONS.some((item) => item.id === value) ? (value as AdminSectionId) : "overview";
}

const SECTION_VIEWS: Readonly<Record<AdminSectionId, React.ComponentType>> = {
  overview: OverviewSection,
  deployments: DeploymentsSection,
  deploy: DeploySection,
  manage: ManageSection,
  safe: SafeQueueSection,
  fees: FeesSection,
  services: ServicesSection,
  environment: EnvironmentSection,
  audit: AuditSection,
  export: ExportSection,
};

export function AdminApp({ client, initialSession, onGate }: AdminConsoleProps) {
  const evm = useAccount();
  const solana = useSolanaWallet();
  const queryClient = useQueryClient();
  const [session, setSession] = useState<AdminSessionView | null>(initialSession);
  const [section, setSection] = useState<AdminSectionId>(readSection);
  const [now, setNow] = useState(() => Date.now());
  const wallets = useMemo<ConnectedWallets>(
    () => ({ evm: evm.address ?? null, evmChainId: evm.chainId ?? null, solana: solana.account?.address ?? null }),
    [evm.address, evm.chainId, solana.account?.address],
  );
  const ops = useWalletOps(session);

  const endSession = useCallback(
    (reason: "expired" | "switched" | "signed-out") => {
      setSession(null);
      queryClient.removeQueries({ queryKey: ["admin"] });
      if (reason === "expired") toast.warning("Your admin session ended", { description: "Sign in again to continue where you were.", id: "admin-session" });
      if (reason === "switched") toast.info("Signed out", { description: "The wallet switched to another account than the one that signed in.", id: "admin-session" });
    },
    [queryClient],
  );

  const reportGateError = useCallback(
    (error: unknown) => {
      const gate = gateFor(error);
      if (gate === "signed-out") endSession("expired");
      else if (gate) onGate();
    },
    [endSession, onGate],
  );

  // Gate state 7: the signing wallet moved to another account. The panel stops showing the session at once
  // (derived below) and ends it on the server.
  const switchedAway = session !== null && walletSwitchedAway(session, wallets);
  useEffect(() => {
    if (!switchedAway) return;
    void client
      .logout()
      .catch(() => undefined)
      .finally(() => endSession("switched"));
  }, [client, endSession, switchedAway]);

  // Countdown, and gate state 6 when the session runs out.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!session || sessionEndsAt(session) > now) return;
    client.session().then(setSession, reportGateError);
  }, [client, now, reportGateError, session]);

  // Back and forward move between sections.
  useEffect(() => subscribeLocation(() => setSection(readSection())), []);

  const goTo = useCallback((next: AdminSectionId, focus?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("section", next);
    if (focus) url.searchParams.set("focus", focus);
    else url.searchParams.delete("focus");
    navigate(`${url.pathname}${url.search}`);
    setSection(next);
    window.requestAnimationFrame(() => document.getElementById("admin-section-title")?.focus({ preventScroll: true }));
  }, []);

  if (!session || switchedAway) {
    return (
      <AdminFrame barEnd={<WalletDock evmWorkspace={false} />}>
        <SignInView client={client} ops={ops} onSignedIn={(next) => setSession(next)} />
      </AdminFrame>
    );
  }
  return (
    <SignedIn
      client={client}
      ops={ops}
      session={session}
      wallets={wallets}
      section={section}
      goTo={goTo}
      now={now}
      reportGateError={reportGateError}
      onSignOut={async () => {
        await client.logout().catch(() => undefined);
        endSession("signed-out");
      }}
    />
  );
}

function SignedIn({
  client,
  ops,
  session,
  wallets,
  section,
  goTo,
  now,
  reportGateError,
  onSignOut,
}: {
  readonly client: AdminConsoleProps["client"];
  readonly ops: WalletOps;
  readonly session: AdminSessionView;
  readonly wallets: ConnectedWallets;
  readonly section: AdminSectionId;
  readonly goTo: AdminContextValue["goTo"];
  readonly now: number;
  readonly reportGateError: (error: unknown) => void;
  readonly onSignOut: () => Promise<void>;
}) {
  const { openConnectModal } = useConnectModal();
  const catalog = useQuery({ queryKey: ["admin", "catalog"], queryFn: () => client.catalog(), staleTime: Infinity, retry: 1 });
  const profiles = useQuery({ queryKey: ["admin", "profiles"], queryFn: () => client.profiles(), staleTime: 60_000, retry: 1 });
  useEffect(() => {
    if (catalog.error) reportGateError(catalog.error);
  }, [catalog.error, reportGateError]);
  const signer = evmSignerFor(session, wallets);
  const book = useMemo(
    () => buildAddressBook({ catalog: catalog.data ?? null, profiles: profiles.data ?? [], sessionAddress: session.address, signer: signer.ready ? signer.address : null }),
    [catalog.data, profiles.data, session.address, signer],
  );
  // Every write signs a step-up confirmation with the wallet that holds this session (EVM or Solana).
  useEffect(() => {
    client.setConfirmer({ walletKind: sessionKind(session), address: session.address, chainId: session.chainId, sign: ops.signWithSessionWallet });
    return () => client.setConfirmer(null);
  }, [client, ops.signWithSessionWallet, session]);
  const value = useMemo<AdminContextValue>(
    () => ({ client, session, wallets, signer, catalog: catalog.data ?? null, book, ops, reportGateError, goTo }),
    [book, catalog.data, client, goTo, ops, reportGateError, session, signer, wallets],
  );
  const kind = sessionKind(session);
  const left = countdownText(sessionEndsAt(session), now);
  const View = SECTION_VIEWS[section];

  const barEnd = (
    <>
      <WalletDock evmWorkspace={false} />
      <div className="flex min-h-11 items-center gap-2 border-[3px] border-control bg-surface px-2.5 text-xs font-bold shadow-hard-sm" title={session.address}>
        <span className={cx(LABEL, "border-2 border-current px-1", kind === "solana" ? "bg-[#14F195] text-[#0B1120]" : "bg-[#0052FF] text-white")}>{kind === "solana" ? "SOL" : "EVM"}</span>
        <code className="font-code text-[13px]">{shortAddress(session.address)}</code>
        <span className={cx("hidden sm:inline", TEXT_MUTED)} aria-label={`Session ends in ${left}`}>
          {left}
        </span>
      </div>
      <Button variant="ink" size="sm" onClick={() => void onSignOut()} className="min-h-11">
        <LogOut className="h-4 w-4" aria-hidden="true" />
        Sign out
      </Button>
    </>
  );

  return (
    <AdminContext.Provider value={value}>
      <AdminFrame barEnd={barEnd} wide>
        <div className="mx-auto grid w-full max-w-[96rem] gap-6 px-4 pb-16 pt-4 sm:px-6 lg:grid-cols-[14.5rem_minmax(0,1fr)] lg:gap-10 lg:px-8 lg:pt-8">
          <nav aria-label="Admin sections" className="min-w-0">
            {/* Under 1024 px: one scrolling row of tabs. */}
            <ul className="kl-admin__tabs -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:hidden">
              {ADMIN_SECTIONS.map((item) => (
                <li key={item.id} className="shrink-0">
                  <a
                    href={`?section=${item.id}`}
                    aria-current={item.id === section ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      goTo(item.id);
                    }}
                    className={cx(
                      "flex min-h-11 items-center gap-2 border-[3px] px-3 text-sm font-bold",
                      item.id === section ? "border-control bg-[#FFD60A] text-[#1A1A1A] shadow-hard-sm" : "border-control bg-surface text-fg",
                      FOCUS_RING,
                    )}
                  >
                    <Icon name={item.icon} size={18} plate={item.id !== section} />
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
            {/* 1024 px and up: the rail. */}
            <ul className="sticky top-28 hidden flex-col gap-1 lg:flex">
              {ADMIN_SECTIONS.map((item) => {
                const active = item.id === section;
                return (
                  <li key={item.id}>
                    <a
                      href={`?section=${item.id}`}
                      aria-current={active ? "page" : undefined}
                      onClick={(event) => {
                        event.preventDefault();
                        goTo(item.id);
                      }}
                      className={cx(
                        "-ml-[3px] flex min-h-11 items-center gap-3 border-l-[3px] px-3 text-[15px] font-bold transition-colors",
                        active ? "border-[#0052FF] bg-surface text-accent-text dark:border-[#FFD60A] dark:text-[#FFD60A]" : "border-transparent text-fg hover:border-control hover:bg-surface",
                        FOCUS_RING,
                        "focus-visible:-outline-offset-2",
                      )}
                    >
                      <Icon name={item.icon} size={22} plate={!active} />
                      {item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="flex min-w-0 flex-col gap-6">
            {!signer.ready ? (
              <div role="note" className="flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#FFF3B0] p-4 text-[#1A1A1A] shadow-hard-sm sm:flex-row sm:items-center sm:justify-between dark:border-[#FFD60A] dark:bg-[#2A2110] dark:text-[#FDE68A]">
                <p className="flex items-start gap-2 text-sm font-semibold">
                  <Wallet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{kind === "solana" && !wallets.evm ? SOLANA_ONLY_NOTICE : signer.reason}</span>
                </p>
                <Button size="sm" variant="primary" onClick={() => openConnectModal?.()} className="shrink-0 self-start sm:self-auto">
                  Connect EVM wallet
                </Button>
              </div>
            ) : null}
            <div key={section} className="kl-rise min-w-0">
              <View />
            </div>
          </div>
        </div>
      </AdminFrame>
    </AdminContext.Provider>
  );
}
