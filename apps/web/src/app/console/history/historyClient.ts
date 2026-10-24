/**
 * The desk's history reads (`/v1/data/*`) with the wallet's account session
 * (the same session as automations): tracking, transactions, the value
 * series and PnL of the signed-in wallet's tracked set. Failures are
 * PlatformErrors; nothing here signs or sends anything.
 */
import type { DataLane, DataPnl, DataPnlPeriod, DataSnapshotRange, DataSnapshotSeries, DataTracking, DataTransactionPage, DataTxQuery } from "@kletia/core";

import { accountRequest } from "../../pages/developers/keys/accountClient";

function query(values: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value !== undefined && value !== "" && value !== false) params.set(name, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const historyApi = {
  tracking: (token: string, signal?: AbortSignal) =>
    accountRequest<{ tracking: DataTracking | null }>("/data/tracking", { token, ...(signal ? { signal } : {}) }).then((reply) => reply.tracking),
  startTracking: (token: string, lane: DataLane, proofs: readonly string[] = []) =>
    accountRequest<{ tracking: DataTracking }>("/data/tracking", { method: "POST", token, body: { lane, proofs } }).then((reply) => reply.tracking),
  stopTracking: (token: string) => accountRequest<{ deleted: boolean }>("/data/tracking", { method: "DELETE", token }),
  transactions: (token: string, filters: DataTxQuery, signal?: AbortSignal) =>
    accountRequest<DataTransactionPage>(`/data/transactions${query({ ...filters })}`, { token, ...(signal ? { signal } : {}) }),
  snapshots: (token: string, range: DataSnapshotRange, signal?: AbortSignal) =>
    accountRequest<DataSnapshotSeries>(`/data/snapshots${query({ range })}`, { token, ...(signal ? { signal } : {}) }),
  pnl: (token: string, period: DataPnlPeriod, signal?: AbortSignal) =>
    accountRequest<DataPnl>(`/data/pnl${query({ period })}`, { token, ...(signal ? { signal } : {}) }),
};
