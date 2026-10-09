/**
 * The exposure ledger (policy design §6): every payload Kletia hands out for
 * a governed key counts against the rolling 24 h and 7 d caps of each scope
 * of its chain (the owner, each ancestor, the project) until proven dead.
 *
 * Postgres: one transaction per reservation under the project's advisory
 * lock (`hashtext('kletia_policy:' || prj_<id>)`, the lock rule book writes
 * take): the chain heads the gate evaluated are re-read (a pause that
 * committed first is always seen), window usage is summed with mutually
 * exclusive exposures (same pinned nonce) counted once at their largest
 * amount, every capped scope is checked, and one row per scope is inserted
 * (`ON CONFLICT DO NOTHING`: retries are idempotent). The window arithmetic
 * is the engine's (`windowUsage`, `windowRetryAt`), shared with the memory
 * ledger, so both stores answer identically.
 *
 * Memory: the engine's `MemorySpendLedger` with the chain check.
 * Background: a reaper marks open Solana exposures dead once their
 * `lastValidBlockHeight` passed (every minute, ≤ 500 rows), and rows older
 * than 8 days are pruned hourly.
 */
import type { NetworkKey, PolicyChainLink, PolicyWindowUsage } from "@kletia/core";
import type pg from "pg";
import {
  MemorySpendLedger,
  windowRetryAt,
  windowUsage,
  type ExposureRecord,
  type ScopeUsage,
  type SpendLedger,
  type SpendReservation,
  type SpendReservationResult,
} from "../../index.js";
import { DAY_MS, solanaBlockHeight, WEEK_MS, type ExposureGroup } from "../../engine/policy/index.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../db.js";
import { chainLinks, readKeyChain } from "./chain.js";
import { activeHeadsOn, POLICIES_SCHEMA, rawProjectId, subjectKey, type PolicyScope } from "./store.js";

const RETENTION_MS = 8 * DAY_MS;

function chainText(chain: readonly PolicyChainLink[]): string {
  return chain.map((link) => `${link.scope}:${link.id}:${link.version}:${link.hash}`).sort().join("|");
}

/** Groups of counted rows: rows sharing an exclusive key count once (largest amount, latest time). */
function groupsOf(rows: readonly { readonly id: string; readonly exclusiveKey: string | null; readonly usdMicros: bigint; readonly at: number }[], now: number): ExposureGroup[] {
  const groups = new Map<string, { usdMicros: bigint; at: number }>();
  for (const row of rows) {
    if (row.at <= now - WEEK_MS) continue;
    const key = row.exclusiveKey ?? row.id;
    const known = groups.get(key);
    groups.set(key, {
      usdMicros: known && known.usdMicros > row.usdMicros ? known.usdMicros : row.usdMicros,
      at: known && known.at > row.at ? known.at : row.at,
    });
  }
  return [...groups].map(([key, value]) => ({ key, ...value }));
}

/* =============================================================== postgres */

const EXPOSURES_SCHEMA = {
  name: "kletia_policy_exposures",
  // The reservation re-reads rule book heads under its lock, so the policies table must exist too.
  ddl: `${POLICIES_SCHEMA.ddl}
CREATE TABLE IF NOT EXISTS kletia_policy_exposures (
  id text NOT NULL,
  scope_key_id text NOT NULL,
  project_id text NOT NULL,
  owner_key_id text NOT NULL,
  intent_id text NOT NULL,
  step_id text NOT NULL,
  network text NOT NULL,
  quote_binding text NOT NULL,
  exclusive_key text,
  valid_until_height bigint,
  usd_micros bigint NOT NULL CHECK (usd_micros >= 0),
  state text NOT NULL CHECK (state IN ('open', 'landed', 'dead')),
  decision_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, scope_key_id)
);
CREATE INDEX IF NOT EXISTS kletia_policy_exposures_scope_idx ON kletia_policy_exposures (scope_key_id, created_at) WHERE state <> 'dead';
CREATE INDEX IF NOT EXISTS kletia_policy_exposures_step_idx ON kletia_policy_exposures (intent_id, step_id);
CREATE INDEX IF NOT EXISTS kletia_policy_exposures_exclusive_idx ON kletia_policy_exposures (exclusive_key) WHERE exclusive_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS kletia_policy_exposures_reap_idx ON kletia_policy_exposures (network, created_at) WHERE state = 'open' AND valid_until_height IS NOT NULL;`,
} as const;

interface ExposureRow {
  id: string;
  scope_key_id: string;
  project_id: string;
  owner_key_id: string;
  intent_id: string;
  step_id: string;
  network: string;
  quote_binding: string;
  exclusive_key: string | null;
  valid_until_height: string | null;
  usd_micros: string;
  decision_id: string;
  created_at: Date | string;
}

const EXPOSURE_COLUMNS = "id, scope_key_id, project_id, owner_key_id, intent_id, step_id, network, quote_binding, exclusive_key, valid_until_height::text AS valid_until_height, usd_micros::text AS usd_micros, decision_id, created_at";

function millis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function recordFromRow(row: ExposureRow): ExposureRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerKeyId: row.owner_key_id,
    intentId: row.intent_id,
    stepId: row.step_id,
    network: row.network as NetworkKey,
    quoteBinding: row.quote_binding,
    exclusiveKey: row.exclusive_key,
    validUntilHeight: row.valid_until_height === null ? null : Number(row.valid_until_height),
    usdMicros: BigInt(row.usd_micros),
    decisionId: row.decision_id,
    createdAt: millis(row.created_at),
  };
}

type Queryable = Pick<pg.PoolClient, "query">;

async function lockProject(client: Queryable, projectScopeId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_policy:${projectScopeId}`]);
}

/** Counted rows (not dead, within 7 days) of some scopes. */
async function countedRows(client: Queryable, scopes: readonly string[], now: number): Promise<Map<string, { id: string; exclusiveKey: string | null; usdMicros: bigint; at: number }[]>> {
  const out = new Map<string, { id: string; exclusiveKey: string | null; usdMicros: bigint; at: number }[]>();
  if (scopes.length === 0) return out;
  const result = await client.query<{ scope_key_id: string; id: string; exclusive_key: string | null; usd_micros: string; created_at: Date | string }>(
    `SELECT scope_key_id, id, exclusive_key, usd_micros::text AS usd_micros, created_at FROM kletia_policy_exposures
     WHERE scope_key_id = ANY($1::text[]) AND state <> 'dead' AND created_at > $2`,
    [[...scopes], new Date(now - WEEK_MS).toISOString()],
  );
  for (const row of result.rows) {
    const list = out.get(row.scope_key_id) ?? [];
    list.push({ id: row.id, exclusiveKey: row.exclusive_key, usdMicros: BigInt(row.usd_micros), at: millis(row.created_at) });
    out.set(row.scope_key_id, list);
  }
  return out;
}

async function insertRows(client: Queryable, exposure: ExposureRecord, scopes: readonly string[], state: "open" | "landed"): Promise<void> {
  if (scopes.length === 0) return;
  await client.query(
    `INSERT INTO kletia_policy_exposures (id, scope_key_id, project_id, owner_key_id, intent_id, step_id, network, quote_binding, exclusive_key, valid_until_height, usd_micros, state, decision_id, created_at)
     SELECT $1, scope, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14 FROM unnest($2::text[]) AS scope
     ON CONFLICT (id, scope_key_id) DO NOTHING`,
    [
      exposure.id, [...scopes], exposure.projectId, exposure.ownerKeyId, exposure.intentId, exposure.stepId, exposure.network,
      exposure.quoteBinding, exposure.exclusiveKey, exposure.validUntilHeight, exposure.usdMicros.toString(), state, exposure.decisionId,
      new Date(exposure.createdAt).toISOString(),
    ],
  );
}

/** Current heads of the chain levels named by `scopes` (key ids and `prj_…`), read under the lock. */
async function currentLinks(client: Queryable, scopes: readonly string[]): Promise<PolicyChainLink[]> {
  const subjects = scopes.map((scope): { scope: PolicyScope; subjectId: string } =>
    scope.startsWith("prj_") ? { scope: "project", subjectId: rawProjectId(scope) } : { scope: "key", subjectId: scope });
  const heads = await activeHeadsOn(client, subjects);
  return subjects.flatMap((subject) => {
    const version = heads.get(subjectKey(subject.scope, subject.subjectId));
    return version?.document && version.hash
      ? [{ scope: subject.scope, id: subject.scope === "project" ? `prj_${subject.subjectId}` : subject.subjectId, version: version.version, hash: version.hash }]
      : [];
  });
}

export class PostgresSpendLedger implements SpendLedger {
  async usage(scopes: readonly string[], now: number): Promise<ReadonlyMap<string, PolicyWindowUsage>> {
    const rows = await dbTransaction(EXPOSURES_SCHEMA, (client) => countedRows(client, scopes, now));
    return new Map(scopes.map((scope) => [scope, windowUsage(groupsOf(rows.get(scope) ?? [], now), now)]));
  }

  async reserve(reservation: SpendReservation): Promise<SpendReservationResult> {
    const { exposure, now } = reservation;
    return dbTransaction(EXPOSURES_SCHEMA, async (client) => {
      await lockProject(client, exposure.projectId);
      // P13: the rule books the gate evaluated must still be the heads (a pause that committed first is seen).
      if (chainText(await currentLinks(client, reservation.scopes)) !== chainText(reservation.chain)) return { ok: false, reason: "chain_changed" } as const;
      const existing = await client.query<{ scope_key_id: string }>(
        "SELECT scope_key_id FROM kletia_policy_exposures WHERE id = $1",
        [exposure.id],
      );
      const have = new Set(existing.rows.map((row) => row.scope_key_id));
      const replayed = reservation.scopes.length > 0 && reservation.scopes.every((scope) => have.has(scope));
      const rows = await countedRows(client, reservation.caps.map((cap) => cap.scope), now);
      const usage: ScopeUsage[] = [];
      for (const cap of reservation.caps) {
        const scoped = rows.get(cap.scope) ?? [];
        const before = groupsOf(scoped, now);
        const after = replayed ? before : groupsOf([...scoped, { id: exposure.id, exclusiveKey: exposure.exclusiveKey, usdMicros: exposure.usdMicros, at: exposure.createdAt }], now);
        const used = windowUsage(before, now);
        const next = windowUsage(after, now);
        for (const [window, limit, prior, total, windowMs] of [
          ["24h", cap.dailyUsdMicros, used.dayUsdMicros, next.dayUsdMicros, DAY_MS],
          ["7d", cap.weeklyUsdMicros, used.weekUsdMicros, next.weekUsdMicros, WEEK_MS],
        ] as const) {
          if (limit === undefined) continue;
          usage.push({ scope: cap.scope, window, usedUsdMicros: total, capUsdMicros: limit, deltaUsdMicros: total - prior });
          if (!replayed && total > limit) {
            return { ok: false, reason: "cap", scope: cap.scope, window, usage, retryAt: windowRetryAt(before, limit, exposure.usdMicros, windowMs, now) } as const;
          }
        }
      }
      if (!replayed) await insertRows(client, exposure, reservation.scopes, "open");
      return { ok: true, replayed, usage } as const;
    });
  }

  async abort(exposureId: string): Promise<void> {
    await dbQuery(EXPOSURES_SCHEMA, "UPDATE kletia_policy_exposures SET state = 'dead', updated_at = now() WHERE id = $1 AND state = 'open'", [exposureId]);
  }

  async land(input: { readonly intentId: string; readonly stepId: string; readonly quoteBinding: string | null; readonly now: number }): Promise<readonly ExposureRecord[]> {
    // A verified payload is never dead, whatever a reaper concluded (binding match); unknown binding: every open one.
    const result = await dbQuery<ExposureRow>(
      EXPOSURES_SCHEMA,
      `UPDATE kletia_policy_exposures SET state = 'landed', updated_at = now()
       WHERE intent_id = $1 AND step_id = $2 AND (($3::text IS NOT NULL AND quote_binding = $3) OR ($3::text IS NULL AND state = 'open'))
       RETURNING ${EXPOSURE_COLUMNS}`,
      [input.intentId, input.stepId, input.quoteBinding],
    );
    const byId = new Map<string, ExposureRecord>();
    for (const row of result.rows) if (!byId.has(row.id)) byId.set(row.id, recordFromRow(row));
    return [...byId.values()];
  }

  async recordLanded(exposure: ExposureRecord, scopes: readonly string[]): Promise<void> {
    await dbTransaction(EXPOSURES_SCHEMA, async (client) => {
      await lockProject(client, exposure.projectId);
      await insertRows(client, exposure, scopes, "landed");
    });
  }

  async expire(intentId: string, stepId: string, height: bigint): Promise<number> {
    const result = await dbQuery<{ id: string }>(
      EXPOSURES_SCHEMA,
      `UPDATE kletia_policy_exposures SET state = 'dead', updated_at = now()
       WHERE intent_id = $1 AND step_id = $2 AND state = 'open' AND valid_until_height IS NOT NULL AND valid_until_height < $3
       RETURNING id`,
      [intentId, stepId, height.toString()],
    );
    return new Set(result.rows.map((row) => row.id)).size;
  }

  async clearExclusive(exclusiveKey: string): Promise<void> {
    await dbQuery(EXPOSURES_SCHEMA, "UPDATE kletia_policy_exposures SET exclusive_key = NULL, updated_at = now() WHERE exclusive_key = $1", [exclusiveKey]);
  }

  /** Open Solana exposures past their block height become dead (≤ `limit` rows per network). */
  async reap(height: (network: NetworkKey) => Promise<bigint | null>, limit = 500): Promise<number> {
    const networks = await dbQuery<{ network: string }>(
      EXPOSURES_SCHEMA,
      "SELECT DISTINCT network FROM kletia_policy_exposures WHERE state = 'open' AND valid_until_height IS NOT NULL",
      [],
    );
    let reaped = 0;
    for (const { network } of networks.rows) {
      const current = await height(network as NetworkKey);
      if (current === null) continue;
      const result = await dbQuery<{ id: string }>(
        EXPOSURES_SCHEMA,
        `UPDATE kletia_policy_exposures SET state = 'dead', updated_at = now()
         WHERE ctid IN (
           SELECT ctid FROM kletia_policy_exposures
           WHERE network = $1 AND state = 'open' AND valid_until_height IS NOT NULL AND valid_until_height < $2 LIMIT $3
         ) RETURNING id`,
        [network, current.toString(), limit],
      );
      reaped += result.rowCount ?? 0;
    }
    return reaped;
  }

  async prune(before: number): Promise<void> {
    await dbQuery(EXPOSURES_SCHEMA, "DELETE FROM kletia_policy_exposures WHERE created_at < $1", [new Date(before).toISOString()]);
  }
}

/* ================================================================ selection */

let ledger: SpendLedger | null = null;

/** Heads of an owner's chain read for the memory ledger's check (P13). */
async function memoryCurrentChain(ownerKeyId: string): Promise<readonly PolicyChainLink[] | null> {
  const chain = await readKeyChain(ownerKeyId);
  return chain ? chainLinks(chain.levels) : null;
}

export function spendLedger(): SpendLedger {
  ledger ??= platformDatabaseUrl() ? new PostgresSpendLedger() : new MemorySpendLedger({ currentChain: memoryCurrentChain });
  return ledger;
}

export function configureSpendLedger(custom: SpendLedger | null): void {
  ledger = custom;
}

export function spendLedgerKind(): "memory" | "postgres" | "custom" {
  const current = spendLedger();
  return current instanceof PostgresSpendLedger ? "postgres" : current instanceof MemorySpendLedger ? "memory" : "custom";
}

/** Reaper (every minute) and pruner (hourly) of the ledger; returns a stop function. */
export function startExposureReaper(intervalMs = 60_000): () => void {
  let ticks = 0;
  const timer = setInterval(() => {
    const current = spendLedger();
    ticks += 1;
    if (current instanceof PostgresSpendLedger) {
      void current.reap((network) => solanaBlockHeight(network)).catch((error: unknown) => {
        console.warn("[platform] exposure reaper failed:", error instanceof Error ? error.message : error);
      });
      if (ticks % 60 === 0) {
        void current.prune(Date.now() - RETENTION_MS).catch((error: unknown) => {
          console.warn("[platform] exposure prune failed:", error instanceof Error ? error.message : error);
        });
      }
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
