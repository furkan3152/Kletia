/**
 * Reads the Dashboard view's data: `GET /v1/data/portfolio` for the
 * connected wallets and `GET /v1/data/markets/yields` for the lane, in
 * parallel, on mount, on wallet or lane changes and on refresh. A refresh
 * keeps the previous reading on screen until the new one lands; another
 * wallet never shows the last wallet's reading. A failed read is shown,
 * never hidden as empty.
 */
import { useCallback, useEffect, useState } from "react";
import type { DataPortfolio, DataYields } from "@kletia/core";

import { describePlatformError, getKletiaClient, sdkSignal, toPlatformError } from "../../../shared/platform/kletiaClient";
import { dashboardWallets, type DashboardLane } from "./dashboardModel";

export interface DashboardData {
  readonly portfolio: DataPortfolio | null;
  readonly yields: DataYields | null;
  readonly loading: boolean;
  /** Why the last read failed, or null. */
  readonly error: string | null;
  refresh(): void;
}

interface Reading {
  /** The wallet set and lane it was read for. */
  readonly key: string;
  readonly round: number;
  readonly portfolio: DataPortfolio | null;
  readonly yields: DataYields | null;
  readonly error: string | null;
}

export function useDashboardData(evm: string | null, solana: string | null, lane: DashboardLane): DashboardData {
  const [reading, setReading] = useState<Reading | null>(null);
  const [round, setRound] = useState(0);
  const key = evm || solana ? `${evm ?? ""}|${solana ?? ""}|${lane}` : null;

  useEffect(() => {
    const wallets = dashboardWallets(evm, solana, lane);
    if (!wallets || key === null) return undefined;
    const controller = new AbortController();
    const signal = sdkSignal(controller.signal);
    const client = getKletiaClient();
    void Promise.allSettled([client.data.portfolio(wallets, { signal }), client.data.yields({ lane }, { signal })]).then(([read, rates]) => {
      if (controller.signal.aborted) return;
      const failed = read.status === "rejected" ? read.reason : rates.status === "rejected" ? rates.reason : null;
      setReading((previous) => ({
        key,
        round,
        portfolio: read.status === "fulfilled" ? read.value : previous?.key === key ? previous.portfolio : null,
        yields: rates.status === "fulfilled" ? rates.value : (previous?.yields ?? null),
        error: failed === null ? null : describePlatformError(toPlatformError(failed)),
      }));
    });
    return () => controller.abort();
  }, [evm, solana, lane, key, round]);

  const refresh = useCallback(() => setRound((value) => value + 1), []);
  const current = reading !== null && reading.key === key;
  return {
    portfolio: current ? reading.portfolio : null,
    yields: reading?.yields ?? null,
    loading: key !== null && (!current || reading.round !== round),
    error: current ? reading.error : null,
    refresh,
  };
}
