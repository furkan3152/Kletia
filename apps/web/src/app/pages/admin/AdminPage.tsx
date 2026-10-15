/**
 * /admin: the operator panel's wallet-free gate.
 *
 * It checks the origin, asks the API for the current session and shows the
 * gate states that need no wallet (admin off, API without the panel, store
 * missing, wrong origin, API unreachable). Everything that touches a wallet
 * (sign-in, deploys, owner actions) lives in AdminConsole, loaded lazily, so
 * this route's static chunk never reaches wagmi, RainbowKit or Wallet
 * Standard (scripts/check-route-chunks.mjs).
 */
import { RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { BACKEND_URL } from "../../../shared/config/runtime";
import { Button, ButtonLink } from "../../site/ui/Button";
import { AdminApiError, createAdminClient, describeAdminError, gateFor, type AdminGate } from "./api/adminClient";
import { AdminFrame } from "./components/AdminFrame";
import { GateCard } from "./components/GateCard";
import { adminOriginSupported } from "./model/session";
import type { AdminSessionView } from "./model/types";

const AdminConsole = React.lazy(() => import("./AdminConsole"));

/** What the first session read found. */
export type AdminProbe =
  | { readonly state: "loading" }
  | { readonly state: "session"; readonly session: AdminSessionView }
  | { readonly state: "signed-out" }
  | { readonly state: "gate"; readonly gate: AdminGate; readonly error: AdminApiError | null };

const ENV_LINES = [
  "# Kletia API service (Render), comma separated, either list alone enables admin",
  "KLETIA_ADMIN_ADDRESSES=0xff3a3cfc42d27e85dba9ea85f0bfec34bd632f9a",
  "KLETIA_ADMIN_SOLANA_ADDRESSES=D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm",
].join("\n");

function GateView({ gate, error, onRetry }: { readonly gate: AdminGate; readonly error: AdminApiError | null; readonly onRetry: () => void }) {
  const retry = (
    <Button variant="secondary" onClick={onRetry}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" />
      Check again
    </Button>
  );
  switch (gate) {
    case "disabled":
      return (
        <GateCard icon="shield" eyebrow="Admin is off" title="Admin is off on this API" code={ENV_LINES} actions={retry}>
          <p>
            The API answers every admin route with <code className="font-code text-fg">ADMIN_DISABLED</code>. It turns the panel on only when at least one
            admin wallet list is set and every entry in it is a valid address; an invalid entry turns it off.
          </p>
          <p>Add the lines below to the API service's environment, then redeploy the API.</p>
        </GateCard>
      );
    case "store":
      return (
        <GateCard icon="shield" eyebrow="Store missing" title="The admin store is not available" tone="warning" code="KLETIA_DATABASE_URL=postgres://…" actions={retry}>
          <p>In production the panel keeps sessions and its audit log in Postgres, so it stays off until the API has a database.</p>
        </GateCard>
      );
    case "missing":
      return (
        <GateCard icon="sdk" eyebrow="Not deployed" title="This API has no admin panel yet" actions={retry}>
          <p>The API at {new URL(BACKEND_URL).host} does not know the /api/admin routes. Deploy a release that includes them, then check again.</p>
        </GateCard>
      );
    case "origin":
      return <OriginGate />;
    case "unreachable":
    default:
      return (
        <GateCard icon="board" eyebrow="No answer" title="The Kletia API is unreachable" tone="warning" actions={retry}>
          <p>{error ? describeAdminError(error) : "The API did not answer."} If the API was just redeployed, it is starting up; check again in a moment.</p>
        </GateCard>
      );
  }
}

function OriginGate() {
  return (
    <GateCard
      icon="route"
      eyebrow="Wrong address"
      title="Open the admin panel on kletiaai.xyz"
      actions={
        <ButtonLink to="https://kletiaai.xyz/admin" variant="primary">
          Go to kletiaai.xyz/admin
        </ButtonLink>
      }
    >
      <p>
        The admin session is a same-site cookie of api.kletiaai.xyz. Browsers send it only from kletiaai.xyz, so the panel does not work on this address.
      </p>
    </GateCard>
  );
}

function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6" role="status">
      <span className="border-[3px] border-[#1A1A1A] bg-[#FFD60A] px-4 py-2 text-xs font-black uppercase tracking-[0.3em] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
        Checking the admin session
      </span>
    </div>
  );
}

export default function AdminPage() {
  const originOk = typeof window !== "undefined" && adminOriginSupported(window.location.origin);
  const client = useMemo(() => createAdminClient({ baseUrl: BACKEND_URL }), []);
  const [probe, setProbe] = useState<AdminProbe>({ state: "loading" });

  const probeSession = useCallback(() => {
    client.session().then(
      (session) => setProbe({ state: "session", session }),
      (error: unknown) => {
        const gate = gateFor(error);
        if (gate === "signed-out" || gate === "not-allowed") setProbe({ state: "signed-out" });
        else setProbe({ state: "gate", gate: gate ?? "unreachable", error: error instanceof AdminApiError ? error : null });
      },
    );
  }, [client]);

  const check = useCallback(() => {
    setProbe({ state: "loading" });
    probeSession();
  }, [probeSession]);

  useEffect(() => {
    if (originOk) probeSession();
  }, [probeSession, originOk]);

  if (!originOk) {
    return (
      <AdminFrame>
        <div className="px-4 py-12 sm:py-20">
          <OriginGate />
        </div>
      </AdminFrame>
    );
  }
  if (probe.state === "loading") {
    return (
      <AdminFrame>
        <Loading />
      </AdminFrame>
    );
  }
  if (probe.state === "gate") {
    return (
      <AdminFrame>
        <div className="px-4 py-12 sm:py-20">
          <GateView gate={probe.gate} error={probe.error} onRetry={check} />
        </div>
      </AdminFrame>
    );
  }
  return (
    <React.Suspense
      fallback={
        <AdminFrame>
          <Loading />
        </AdminFrame>
      }
    >
      <AdminConsole client={client} initialSession={probe.state === "session" ? probe.session : null} onGate={check} />
    </React.Suspense>
  );
}
