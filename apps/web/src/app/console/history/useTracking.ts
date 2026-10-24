/**
 * The tracked set of the signed-in wallet: read once per session, turned on
 * (with extra wallets proven by their own sign-in) or off. `tracking` is
 * undefined while unknown, null when the wallet is not tracked.
 */
import { useCallback, useEffect, useState } from "react";
import type { DataLane, DataTracking } from "@kletia/core";

import { isPlatformError } from "../../pages/developers/keys/accountClient";
import { accountErrorText } from "../../pages/developers/keys/accountModel";
import { historyApi } from "./historyClient";

export interface TrackingState {
  readonly tracking: DataTracking | null | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  start(lane: DataLane, proofs?: readonly string[]): Promise<void>;
  stop(): Promise<void>;
}

export function errorText(failure: unknown): string {
  return isPlatformError(failure) ? accountErrorText(failure.code, failure.message) : "Something went wrong. Try again.";
}

export function useTracking(token: string | null): TrackingState {
  const [read, setRead] = useState<{ readonly token: string; readonly tracking: DataTracking | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    historyApi.tracking(token, controller.signal).then(
      (tracking) => setRead({ token, tracking }),
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(errorText(failure));
      },
    );
    return () => controller.abort();
  }, [token]);

  const start = useCallback(async (lane: DataLane, proofs: readonly string[] = []) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setRead({ token, tracking: await historyApi.startTracking(token, lane, proofs) });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }, [token]);

  const stop = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await historyApi.stopTracking(token);
      setRead({ token, tracking: null });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }, [token]);

  return { tracking: read && read.token === token ? read.tracking : undefined, busy, error, start, stop };
}
