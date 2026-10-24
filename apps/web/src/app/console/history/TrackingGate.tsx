/**
 * Wallet sign-in and the tracking opt-in in front of the history parts of
 * the desk: no session shows the wallet sign-in, a session without tracking
 * the opt-in, a tracked set renders `children` with a small bar to add a
 * wallet (proven by its own sign-in) or turn tracking off. Nothing is
 * tracked before the person turns it on.
 */
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import type { DataLane, DataTracking } from "@kletia/core";

import { Button } from "../../site/ui/Button";
import { cx, TEXT_MUTED } from "../../site/ui/styles";
import { useAccountSession } from "../../pages/developers/keys/accountSession";
import { DESK_COPY } from "../content/copy";
import { ViewLoading, ViewNote } from "../shell/ViewParts";
import { VIEW_PANEL } from "../shell/viewStyles";
import { useTracking } from "./useTracking";

const AccountSignIn = lazy(() => import("../../pages/developers/keys/AccountSignIn"));
const copy = DESK_COPY.tracking;

export interface TrackingGateProps {
  readonly lane: DataLane;
  /** Rendered for a tracked set. */
  readonly children: (context: { readonly token: string; readonly tracking: DataTracking }) => ReactNode;
  /** A compact sign-in prompt (the dashboard) instead of the full panel. */
  readonly compact?: boolean;
}

export function TrackingGate({ lane, children, compact }: TrackingGateProps) {
  const session = useAccountSession();
  const token = session?.token ?? null;
  const { tracking, busy, error, start, stop } = useTracking(token);
  const [signingIn, setSigningIn] = useState(!compact);
  const [adding, setAdding] = useState(false);

  if (!session) {
    return (
      <div className={VIEW_PANEL}>
        <p className="text-sm">{copy.signIn}</p>
        {signingIn ? (
          <Suspense fallback={<ViewLoading>{copy.loadingWallets}</ViewLoading>}>
            <AccountSignIn onCancel={() => setSigningIn(false)} />
          </Suspense>
        ) : (
          <div>
            <Button size="sm" variant="secondary" onClick={() => setSigningIn(true)}>
              {copy.turnOn}
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (tracking === undefined) {
    return error ? <ViewNote role="alert" tone="danger">{error}</ViewNote> : <ViewLoading>{copy.checking}</ViewLoading>;
  }

  if (tracking === null) {
    return (
      <div className={VIEW_PANEL}>
        <p className="text-sm">{copy.off}</p>
        {error ? <ViewNote role="alert" tone="danger">{error}</ViewNote> : null}
        <div>
          <Button size="sm" variant="accent" loading={busy} onClick={() => void start(lane)}>
            {copy.turnOn}
          </Button>
        </div>
      </div>
    );
  }

  const count = tracking.wallets.evm.length + tracking.wallets.solana.length;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
        <p className={cx("min-w-0", TEXT_MUTED)}>
          {copy.tracked(count)} {tracking.lane !== lane ? copy.laneNote(tracking.lane) : null}
        </p>
        <div className="flex flex-wrap gap-2">
          {count < 4 ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding((value) => !value)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {copy.addWallet}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void stop()}>
            {copy.turnOff}
          </Button>
        </div>
      </div>
      {error ? <ViewNote role="alert" tone="danger">{error}</ViewNote> : null}
      {adding ? (
        <div className={VIEW_PANEL}>
          <p className="text-sm">{copy.addWalletNote}</p>
          <Suspense fallback={<ViewLoading>{copy.loadingWallets}</ViewLoading>}>
            <AccountSignIn
              onCancel={() => setAdding(false)}
              onSignedIn={(proof) => {
                setAdding(false);
                void start(tracking.lane, [proof.token]);
              }}
            />
          </Suspense>
        </div>
      ) : null}
      {children({ token: session.token, tracking })}
    </>
  );
}
