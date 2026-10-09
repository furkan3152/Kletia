/**
 * `GET /v1/usage?scope=subtree` (policy design §8.4): per-key attribution
 * for the caller's subtree (project keys: every key of the project; agent
 * keys: themselves and their descendants): requests in the window, intents
 * created by status, and the rolling 24 h / 7 d USD notional counted against
 * caps. Revoked keys are listed while they still have rows in the window.
 */
import type { Request } from "express";
import { keyKindOf } from "../auth.js";
import { invalidRequest, queryParam, type AuthContext } from "../context.js";
import { intentCounts, usageStore, USAGE_WINDOWS, type UsageWindow } from "../usage.js";
import { subtreeOf } from "./chain.js";
import { spendLedger } from "./ledger.js";

const HOUR_MS = 3_600_000;
/** Keys reported at most (newest first beyond that are left out; `truncated` says so). */
export const SUBTREE_USAGE_MAX_KEYS = 100;

export interface SubtreeKeyUsage {
  readonly keyId: string;
  readonly name: string;
  readonly kind: "project" | "agent";
  readonly parentId: string | null;
  readonly revokedAt: string | null;
  readonly requests: number;
  readonly intents: { readonly created: number; readonly byStatus: Readonly<Record<string, number>> };
  readonly notional: { readonly dayUsd: string; readonly weekUsd: string };
}

/** `scope` query: `self` (default) or `subtree`. */
export function parseUsageScope(req: Request): "self" | "subtree" {
  const value = queryParam(req, "scope", 8) ?? "self";
  if (value !== "self" && value !== "subtree") throw invalidRequest("scope must be self or subtree.", [{ path: "scope", message: "Expected self or subtree." }]);
  return value;
}

function usd(micros: bigint): string {
  return `${micros / 1_000_000n}.${((micros % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
}

/** Per-key usage of the caller's subtree (call after `usageReport`, which flushes pending counts). */
export async function subtreeUsage(auth: AuthContext, window: UsageWindow, now = Date.now()): Promise<{ readonly keys: SubtreeKeyUsage[]; readonly truncated: boolean }> {
  const subtree = await subtreeOf(auth);
  const records = [...subtree.records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const listed = records.slice(0, SUBTREE_USAGE_MAX_KEYS);
  const since = new Date(Math.floor(now / HOUR_MS) * HOUR_MS - (USAGE_WINDOWS[window] - 1) * HOUR_MS).toISOString();
  const spend = await spendLedger()
    .usage(listed.map((record) => record.id), now)
    .catch(() => new Map<string, { dayUsdMicros: bigint; weekUsdMicros: bigint }>());
  const keys = await Promise.all(
    listed.map(async (record): Promise<SubtreeKeyUsage> => {
      const rows = await usageStore().read(record.id, since);
      const byStatus = await intentCounts(record.id, since);
      const used = spend.get(record.id) ?? { dayUsdMicros: 0n, weekUsdMicros: 0n };
      return {
        keyId: record.id,
        name: record.name,
        kind: keyKindOf(record),
        parentId: record.parentId ?? null,
        revokedAt: record.revokedAt ?? null,
        requests: rows.reduce((sum, row) => sum + row.count, 0),
        intents: { created: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus },
        notional: { dayUsd: usd(used.dayUsdMicros), weekUsd: usd(used.weekUsdMicros) },
      };
    }),
  );
  return { keys, truncated: records.length > listed.length };
}
