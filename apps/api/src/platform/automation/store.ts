/**
 * Automation storage: rules and their runs, in memory (bounded maps) or
 * Postgres (lazy DDL through the HTTP layer's pool, like links and
 * webhooks).
 *
 * Idempotent firing: `(automation_id, window)` is unique, so a window (a
 * schedule slot, a crossing epoch) yields at most one run even when two
 * evaluators race; the loser's `claimRun` returns null. Only the evaluator
 * writes a rule's state, runs and spend (`recordEvaluation`); owners change
 * label, limits and status (`update`, optimistic on `updatedAt`).
 */
import type { AutomationAction, AutomationLimits, AutomationOwner, AutomationRunStatus, AutomationState, AutomationStatus, AutomationTrigger } from "@kletia/core";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../http/db.js";

export interface AutomationRecord {
  readonly id: string;
  /** `key:<keyId>` or `wallet:<evm|solana>:<address>`: the listing key. */
  readonly ownerRef: string;
  readonly owner: AutomationOwner;
  readonly label: string | null;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly limits: AutomationLimits & { readonly expiresAt: string };
  readonly status: AutomationStatus;
  readonly statusReason: string | null;
  readonly state: AutomationState;
  /** Runs that planned an intent (needs_signature or prepared). */
  readonly runs: number;
  /** USD micro-dollars of those runs (oracle-priced). */
  readonly spentUsdMicros: string;
  readonly lastRunAt: string | null;
  readonly checkedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationRunRecord {
  readonly id: string;
  readonly automationId: string;
  readonly ownerRef: string;
  readonly window: string;
  readonly status: AutomationRunStatus;
  readonly reason: string | null;
  readonly message: string | null;
  readonly observed: string | null;
  readonly intentId: string | null;
  readonly title: string | null;
  readonly notionalUsdMicros: string | null;
  readonly provider: { readonly id: string; readonly reference: string } | null;
  readonly firedAt: string;
  readonly updatedAt: string;
}

export type RunOutcome = Pick<AutomationRunRecord, "status" | "reason" | "message" | "intentId" | "title" | "notionalUsdMicros" | "provider">;

export interface EvaluationRecord {
  readonly state: AutomationState;
  readonly checkedAt: string;
  /** Set when a run planned an intent. */
  readonly fired?: { readonly at: string; readonly usdMicros: string };
  /** The rule ended or paused itself. */
  readonly status?: { readonly status: AutomationStatus; readonly reason: string };
}

export interface AutomationStore {
  readonly kind: "memory" | "postgres";
  /** Inserts unless the owner holds `maxLive` active or paused rules (false). */
  create(record: AutomationRecord, maxLive: number): Promise<boolean>;
  get(id: string): Promise<AutomationRecord | null>;
  /** Newest first. */
  listByOwner(ownerRef: string, limit: number): Promise<AutomationRecord[]>;
  /** Owner writes (label, limits, status): false when `updatedAt` moved. */
  update(next: AutomationRecord, expectedUpdatedAt: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  /** Active rules, least recently checked first. */
  listActive(limit: number): Promise<AutomationRecord[]>;
  /** Evaluator writes: state, run counters, spend; never touches a rule that is no longer active. */
  recordEvaluation(id: string, evaluation: EvaluationRecord): Promise<void>;
  /** Inserts a `firing` run; null when the window already has one. */
  claimRun(run: AutomationRunRecord): Promise<AutomationRunRecord | null>;
  finishRun(id: string, outcome: RunOutcome, at: string): Promise<void>;
  listRuns(automationId: string, limit: number): Promise<AutomationRunRecord[]>;
  /** Runs of the owner with these statuses fired after `since`, newest first. */
  listOwnerRuns(ownerRef: string, statuses: readonly AutomationRunStatus[], since: string, limit: number): Promise<AutomationRunRecord[]>;
  /** `firing` runs older than `before` (interrupted evaluations). */
  staleFiring(before: string, limit: number): Promise<AutomationRunRecord[]>;
  /** Runs fired before `before`. */
  pruneRuns(before: string): Promise<void>;
}

export function ownerRefOf(owner: AutomationOwner): string {
  return owner.kind === "key" ? `key:${owner.keyId}` : `wallet:${owner.walletKind}:${owner.address}`;
}

/* ================================================================= memory */

export class MemoryAutomationStore implements AutomationStore {
  readonly kind = "memory" as const;
  private readonly rules = new Map<string, AutomationRecord>();
  private readonly runs = new Map<string, AutomationRunRecord>();
  private readonly windows = new Set<string>();

  constructor(private readonly maxRules = 20_000, private readonly maxRuns = 200_000) {}

  async create(record: AutomationRecord, maxLive: number): Promise<boolean> {
    let live = 0;
    for (const rule of this.rules.values()) if (rule.ownerRef === record.ownerRef && (rule.status === "active" || rule.status === "paused")) live += 1;
    if (live >= maxLive) return false;
    this.rules.set(record.id, record);
    while (this.rules.size > this.maxRules) {
      const oldest = this.rules.keys().next().value;
      if (oldest === undefined) break;
      this.rules.delete(oldest);
    }
    return true;
  }

  async get(id: string): Promise<AutomationRecord | null> {
    return this.rules.get(id) ?? null;
  }

  async listByOwner(ownerRef: string, limit: number): Promise<AutomationRecord[]> {
    return [...this.rules.values()].filter((rule) => rule.ownerRef === ownerRef).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async update(next: AutomationRecord, expectedUpdatedAt: string): Promise<boolean> {
    const current = this.rules.get(next.id);
    if (!current || current.updatedAt !== expectedUpdatedAt) return false;
    // State, counters and spend belong to the evaluator.
    this.rules.set(next.id, { ...next, state: current.state, runs: current.runs, spentUsdMicros: current.spentUsdMicros, lastRunAt: current.lastRunAt, checkedAt: current.checkedAt });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.rules.delete(id);
  }

  async listActive(limit: number): Promise<AutomationRecord[]> {
    return [...this.rules.values()]
      .filter((rule) => rule.status === "active")
      .sort((a, b) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? ""))
      .slice(0, limit);
  }

  async recordEvaluation(id: string, evaluation: EvaluationRecord): Promise<void> {
    const current = this.rules.get(id);
    if (!current || current.status !== "active") return;
    this.rules.set(id, {
      ...current,
      state: evaluation.state,
      checkedAt: evaluation.checkedAt,
      ...(evaluation.fired
        ? { runs: current.runs + 1, spentUsdMicros: String(BigInt(current.spentUsdMicros) + BigInt(evaluation.fired.usdMicros)), lastRunAt: evaluation.fired.at }
        : {}),
      ...(evaluation.status ? { status: evaluation.status.status, statusReason: evaluation.status.reason, updatedAt: evaluation.checkedAt } : {}),
    });
  }

  async claimRun(run: AutomationRunRecord): Promise<AutomationRunRecord | null> {
    const window = `${run.automationId}|${run.window}`;
    if (this.windows.has(window)) return null;
    this.windows.add(window);
    this.runs.set(run.id, run);
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
    return run;
  }

  async finishRun(id: string, outcome: RunOutcome, at: string): Promise<void> {
    const run = this.runs.get(id);
    if (run) this.runs.set(id, { ...run, ...outcome, updatedAt: at });
  }

  async listRuns(automationId: string, limit: number): Promise<AutomationRunRecord[]> {
    return [...this.runs.values()].filter((run) => run.automationId === automationId).sort((a, b) => b.firedAt.localeCompare(a.firedAt)).slice(0, limit);
  }

  async listOwnerRuns(ownerRef: string, statuses: readonly AutomationRunStatus[], since: string, limit: number): Promise<AutomationRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.ownerRef === ownerRef && statuses.includes(run.status) && run.firedAt >= since)
      .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      .slice(0, limit);
  }

  async staleFiring(before: string, limit: number): Promise<AutomationRunRecord[]> {
    return [...this.runs.values()].filter((run) => run.status === "firing" && run.firedAt < before).slice(0, limit);
  }

  async pruneRuns(before: string): Promise<void> {
    for (const [id, run] of this.runs) if (run.firedAt < before) this.runs.delete(id);
  }
}

/* =============================================================== postgres */

const AUTOMATIONS_SCHEMA = {
  name: "kletia_automations",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_automations (
  id text PRIMARY KEY,
  owner_ref text NOT NULL,
  owner jsonb NOT NULL,
  label text,
  trigger jsonb NOT NULL,
  action jsonb NOT NULL,
  limits jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'expired')),
  status_reason text,
  state jsonb NOT NULL DEFAULT '{"epoch":0}',
  runs integer NOT NULL DEFAULT 0,
  spent_usd_micros bigint NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_automations_owner_idx ON kletia_automations (owner_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS kletia_automations_active_idx ON kletia_automations (checked_at NULLS FIRST) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS kletia_automation_runs (
  id text PRIMARY KEY,
  automation_id text NOT NULL,
  owner_ref text NOT NULL,
  window_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('firing', 'prepared', 'needs_signature', 'skipped', 'failed')),
  reason text,
  message text,
  observed text,
  intent_id text,
  title text,
  notional_usd_micros bigint,
  provider jsonb,
  fired_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, window_key)
);
CREATE INDEX IF NOT EXISTS kletia_automation_runs_rule_idx ON kletia_automation_runs (automation_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS kletia_automation_runs_owner_idx ON kletia_automation_runs (owner_ref, status, fired_at DESC);`,
} as const;

const RULE_COLUMNS = "id, owner_ref, owner, label, trigger, action, limits, status, status_reason, state, runs, spent_usd_micros::text AS spent_usd_micros, last_run_at, checked_at, created_at, updated_at";
const RUN_COLUMNS = "id, automation_id, owner_ref, window_key, status, reason, message, observed, intent_id, title, notional_usd_micros::text AS notional_usd_micros, provider, fired_at, updated_at";

interface RuleRow {
  id: string;
  owner_ref: string;
  owner: unknown;
  label: string | null;
  trigger: unknown;
  action: unknown;
  limits: unknown;
  status: string;
  status_reason: string | null;
  state: unknown;
  runs: number;
  spent_usd_micros: string;
  last_run_at: Date | string | null;
  checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunRow {
  id: string;
  automation_id: string;
  owner_ref: string;
  window_key: string;
  status: string;
  reason: string | null;
  message: string | null;
  observed: string | null;
  intent_id: string | null;
  title: string | null;
  notional_usd_micros: string | null;
  provider: unknown;
  fired_at: Date | string;
  updated_at: Date | string;
}

function isoOf(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

const STATUSES: readonly AutomationStatus[] = ["active", "paused", "completed", "expired"];
const RUN_STATUSES: readonly AutomationRunStatus[] = ["firing", "prepared", "needs_signature", "skipped", "failed"];

function ruleFromRow(row: RuleRow): AutomationRecord {
  return {
    id: row.id,
    ownerRef: row.owner_ref,
    owner: row.owner as AutomationOwner,
    label: row.label,
    trigger: row.trigger as AutomationTrigger,
    action: row.action as AutomationAction,
    limits: row.limits as AutomationRecord["limits"],
    // An unknown stored status reads as paused: never evaluated by accident.
    status: STATUSES.includes(row.status as AutomationStatus) ? (row.status as AutomationStatus) : "paused",
    statusReason: row.status_reason,
    state: (row.state ?? { epoch: 0 }) as AutomationState,
    runs: row.runs,
    spentUsdMicros: row.spent_usd_micros,
    lastRunAt: row.last_run_at === null ? null : isoOf(row.last_run_at),
    checkedAt: row.checked_at === null ? null : isoOf(row.checked_at),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
  };
}

function runFromRow(row: RunRow): AutomationRunRecord {
  return {
    id: row.id,
    automationId: row.automation_id,
    ownerRef: row.owner_ref,
    window: row.window_key,
    status: RUN_STATUSES.includes(row.status as AutomationRunStatus) ? (row.status as AutomationRunStatus) : "failed",
    reason: row.reason,
    message: row.message,
    observed: row.observed,
    intentId: row.intent_id,
    title: row.title,
    notionalUsdMicros: row.notional_usd_micros,
    provider: (row.provider ?? null) as AutomationRunRecord["provider"],
    firedAt: isoOf(row.fired_at),
    updatedAt: isoOf(row.updated_at),
  };
}

export class PostgresAutomationStore implements AutomationStore {
  readonly kind = "postgres" as const;

  async create(record: AutomationRecord, maxLive: number): Promise<boolean> {
    return dbTransaction(AUTOMATIONS_SCHEMA, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_automations:${record.ownerRef}`]);
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kletia_automations WHERE owner_ref = $1 AND status IN ('active', 'paused')",
        [record.ownerRef],
      );
      if (Number(count.rows[0]?.count ?? "0") >= maxLive) return false;
      await client.query(
        `INSERT INTO kletia_automations (id, owner_ref, owner, label, trigger, action, limits, status, status_reason, state, runs, spent_usd_micros, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, 0, 0, $11, $12)`,
        [
          record.id, record.ownerRef, JSON.stringify(record.owner), record.label, JSON.stringify(record.trigger), JSON.stringify(record.action),
          JSON.stringify(record.limits), record.status, record.statusReason, JSON.stringify(record.state), record.createdAt, record.updatedAt,
        ],
      );
      return true;
    });
  }

  async get(id: string): Promise<AutomationRecord | null> {
    const result = await dbQuery<RuleRow>(AUTOMATIONS_SCHEMA, `SELECT ${RULE_COLUMNS} FROM kletia_automations WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? ruleFromRow(row) : null;
  }

  async listByOwner(ownerRef: string, limit: number): Promise<AutomationRecord[]> {
    const result = await dbQuery<RuleRow>(AUTOMATIONS_SCHEMA, `SELECT ${RULE_COLUMNS} FROM kletia_automations WHERE owner_ref = $1 ORDER BY created_at DESC LIMIT $2`, [ownerRef, limit]);
    return result.rows.map(ruleFromRow);
  }

  async update(next: AutomationRecord, expectedUpdatedAt: string): Promise<boolean> {
    const result = await dbQuery(
      AUTOMATIONS_SCHEMA,
      "UPDATE kletia_automations SET label = $2, limits = $3::jsonb, status = $4, status_reason = $5, updated_at = $6 WHERE id = $1 AND updated_at = $7",
      [next.id, next.label, JSON.stringify(next.limits), next.status, next.statusReason, next.updatedAt, expectedUpdatedAt],
    );
    return result.rowCount === 1;
  }

  async delete(id: string): Promise<boolean> {
    const result = await dbQuery(AUTOMATIONS_SCHEMA, "DELETE FROM kletia_automations WHERE id = $1", [id]);
    return result.rowCount === 1;
  }

  async listActive(limit: number): Promise<AutomationRecord[]> {
    const result = await dbQuery<RuleRow>(
      AUTOMATIONS_SCHEMA,
      `SELECT ${RULE_COLUMNS} FROM kletia_automations WHERE status = 'active' ORDER BY checked_at NULLS FIRST LIMIT $1`,
      [limit],
    );
    return result.rows.map(ruleFromRow);
  }

  async recordEvaluation(id: string, evaluation: EvaluationRecord): Promise<void> {
    await dbQuery(
      AUTOMATIONS_SCHEMA,
      `UPDATE kletia_automations SET state = $2::jsonb, checked_at = $3,
         runs = runs + $4, spent_usd_micros = spent_usd_micros + $5::bigint, last_run_at = COALESCE($6, last_run_at),
         status = COALESCE($7, status), status_reason = COALESCE($8, status_reason), updated_at = CASE WHEN $7::text IS NULL THEN updated_at ELSE $3 END
       WHERE id = $1 AND status = 'active'`,
      [
        id, JSON.stringify(evaluation.state), evaluation.checkedAt, evaluation.fired ? 1 : 0, evaluation.fired?.usdMicros ?? "0",
        evaluation.fired?.at ?? null, evaluation.status?.status ?? null, evaluation.status?.reason ?? null,
      ],
    );
  }

  async claimRun(run: AutomationRunRecord): Promise<AutomationRunRecord | null> {
    const result = await dbQuery<RunRow>(
      AUTOMATIONS_SCHEMA,
      `INSERT INTO kletia_automation_runs (id, automation_id, owner_ref, window_key, status, observed, fired_at, updated_at)
       VALUES ($1, $2, $3, $4, 'firing', $5, $6, $6)
       ON CONFLICT (automation_id, window_key) DO NOTHING
       RETURNING ${RUN_COLUMNS}`,
      [run.id, run.automationId, run.ownerRef, run.window, run.observed, run.firedAt],
    );
    const row = result.rows[0];
    return row ? runFromRow(row) : null;
  }

  async finishRun(id: string, outcome: RunOutcome, at: string): Promise<void> {
    await dbQuery(
      AUTOMATIONS_SCHEMA,
      `UPDATE kletia_automation_runs SET status = $2, reason = $3, message = $4, intent_id = $5, title = $6, notional_usd_micros = $7::bigint, provider = $8::jsonb, updated_at = $9
       WHERE id = $1`,
      [id, outcome.status, outcome.reason, outcome.message, outcome.intentId, outcome.title, outcome.notionalUsdMicros, outcome.provider ? JSON.stringify(outcome.provider) : null, at],
    );
  }

  async listRuns(automationId: string, limit: number): Promise<AutomationRunRecord[]> {
    const result = await dbQuery<RunRow>(AUTOMATIONS_SCHEMA, `SELECT ${RUN_COLUMNS} FROM kletia_automation_runs WHERE automation_id = $1 ORDER BY fired_at DESC LIMIT $2`, [automationId, limit]);
    return result.rows.map(runFromRow);
  }

  async listOwnerRuns(ownerRef: string, statuses: readonly AutomationRunStatus[], since: string, limit: number): Promise<AutomationRunRecord[]> {
    const result = await dbQuery<RunRow>(
      AUTOMATIONS_SCHEMA,
      `SELECT ${RUN_COLUMNS} FROM kletia_automation_runs WHERE owner_ref = $1 AND status = ANY($2::text[]) AND fired_at >= $3 ORDER BY fired_at DESC LIMIT $4`,
      [ownerRef, [...statuses], since, limit],
    );
    return result.rows.map(runFromRow);
  }

  async staleFiring(before: string, limit: number): Promise<AutomationRunRecord[]> {
    const result = await dbQuery<RunRow>(
      AUTOMATIONS_SCHEMA,
      `SELECT ${RUN_COLUMNS} FROM kletia_automation_runs WHERE status = 'firing' AND fired_at < $1 ORDER BY fired_at LIMIT $2`,
      [before, limit],
    );
    return result.rows.map(runFromRow);
  }

  async pruneRuns(before: string): Promise<void> {
    await dbQuery(AUTOMATIONS_SCHEMA, "DELETE FROM kletia_automation_runs WHERE fired_at < $1", [before]);
  }

  /**
   * Runs `task` only when this process holds the evaluator lock (a
   * transaction-scoped advisory lock, held for the whole pass): one runner
   * across replicas. Resolves false when another instance holds it.
   */
  async withLeaderLock(task: () => Promise<void>): Promise<boolean> {
    return dbTransaction(AUTOMATIONS_SCHEMA, async (client) => {
      const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('kletia_automation_evaluator', 0)) AS locked");
      if (locked.rows[0]?.locked !== true) return false;
      await task();
      return true;
    });
  }
}

let store: AutomationStore | null = null;

export function automationStore(): AutomationStore {
  store ??= platformDatabaseUrl() ? new PostgresAutomationStore() : new MemoryAutomationStore();
  return store;
}

/** Replaces the store (tests); null re-selects by KLETIA_DATABASE_URL on next use. */
export function configureAutomationStore(custom: AutomationStore | null): void {
  store = custom;
}
