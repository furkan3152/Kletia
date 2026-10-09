/**
 * Rule book storage (policy design §3.5, §14): one append-only list of
 * versions per scope (`project` rule book of a project, or `key` rule book
 * of an API key), with at most one `active` and one `pending` version.
 *
 * Tighten now, loosen later: a version that `comparePolicies` finds tighter
 * or equal in every field applies at once; any loosening field makes it
 * `pending` until `activatesAt = now + delay of the version it replaces`
 * (the old delay, so a leaked key cannot shorten it in the same change).
 * A new version supersedes a pending one. Removal is a version without a
 * document (it loosens every field). Promotion of due pending versions is
 * lazy on every read and done by the background promoter (every 30 s).
 *
 * Writes are serialised per project with the lock the spend reservation
 * takes (Postgres: `pg_advisory_xact_lock(hashtext('kletia_policy:' ||
 * prj_<id>))`; memory: the shared `ProjectLocks`), so a pause that committed
 * first is always seen by a concurrent prepare (P13).
 */
import {
  comparePolicies,
  OBSERVER_POLICY,
  policyHash,
  validatePolicy,
  type PolicyComparison,
  type PolicyDefaults,
  type PolicyDocument,
} from "@kletia/core";
import type pg from "pg";
import { PlatformError } from "../../errors.js";
import { ProjectLocks } from "../../index.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../db.js";

export type PolicyScope = "project" | "key";
export type PolicyVersionStatus = "active" | "pending" | "superseded" | "cancelled" | "removed";

export interface PolicyVersion {
  readonly scope: PolicyScope;
  /** Raw project id (scope `project`) or key id (scope `key`). */
  readonly subjectId: string;
  /** Raw project id the subject belongs to. */
  readonly projectId: string;
  readonly version: number;
  /** Canonical document (defaults not filled); null for a removal. */
  readonly document: PolicyDocument | null;
  /** `sha256:` hash of the canonical document; null for a removal. */
  readonly hash: string | null;
  readonly status: PolicyVersionStatus;
  /** When a pending version activates (null otherwise). */
  readonly activatesAt: string | null;
  readonly loosened: readonly string[];
  readonly tightened: readonly string[];
  /** Key id that wrote the version. */
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface PolicyHeads {
  readonly active: PolicyVersion | null;
  readonly pending: PolicyVersion | null;
}

export interface PolicyWrite {
  readonly scope: PolicyScope;
  readonly subjectId: string;
  readonly projectId: string;
  /** Canonical document; null removes the rule book. */
  readonly next: PolicyDocument | null;
  /** `agent` for agent keys: absent fields compare with their agent defaults, and no rule book is the observer. */
  readonly defaults: PolicyDefaults;
  readonly createdBy: string;
  /** `If-Match` hash of the active version (`none` when there is none); a mismatch is POLICY_CONFLICT. */
  readonly ifMatch?: string;
  readonly now: number;
}

export interface PolicyWriteResult {
  /** The version written (or the active one, unchanged, when the document is identical). */
  readonly version: PolicyVersion;
  /** `now`: in force at once; `pending`: until `activatesAt`; `unchanged`: identical to the active version. */
  readonly applied: "now" | "pending" | "unchanged";
  /** The pending version this write superseded, if any. */
  readonly supersededPending: PolicyVersion | null;
  readonly comparison: PolicyComparison;
  /** Pending versions that were due and got promoted first (announce them). */
  readonly promoted: readonly PolicyVersion[];
}

export interface PolicyStore {
  readonly kind: "memory" | "postgres";
  /** Active and pending versions (due pending versions promoted first). */
  heads(scope: PolicyScope, subjectId: string, now: number): Promise<PolicyHeads & { readonly promoted: readonly PolicyVersion[] }>;
  /** Active versions of several subjects at once (chain reads), keyed `scope:subjectId`; due versions promoted first. */
  activeMany(subjects: readonly { readonly scope: PolicyScope; readonly subjectId: string; readonly projectId: string }[], now: number): Promise<{ readonly active: ReadonlyMap<string, PolicyVersion>; readonly promoted: readonly PolicyVersion[] }>;
  write(input: PolicyWrite): Promise<PolicyWriteResult>;
  /** Cancels the pending version (POLICY_NOT_FOUND when none). */
  cancelPending(scope: PolicyScope, subjectId: string, projectId: string, now: number): Promise<PolicyVersion>;
  /** Versions newest first (at most `limit`, ≤ 100). */
  versions(scope: PolicyScope, subjectId: string, limit: number): Promise<PolicyVersion[]>;
  /** Promotes due pending versions of every subject (background, at most `limit`). */
  promoteDue(now: number, limit: number): Promise<PolicyVersion[]>;
}

/* ================================================================ helpers */

export function subjectKey(scope: PolicyScope, subjectId: string): string {
  return `${scope}:${subjectId}`;
}

/** Spend scope and decision-log project id of a raw project id. */
export function projectScope(projectId: string): string {
  return projectId.startsWith("prj_") ? projectId : `prj_${projectId}`;
}

/** The raw project id of a `prj_…` scope. */
export function rawProjectId(scope: string): string {
  return scope.startsWith("prj_") ? scope.slice(4) : scope;
}

/** The advisory-lock / ProjectLocks key of a project (shared with spend reservations). */
export function projectLockKey(projectId: string): string {
  return projectScope(projectId);
}

function policyNotFound(message = "This key or project has no rule book."): PlatformError {
  return new PlatformError("POLICY_NOT_FOUND", message, 404);
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** A stored document re-validated (never trust a row blindly: fail closed to an error, not to "no rules"). */
function storedDocument(value: unknown): PolicyDocument | null {
  if (value === null || value === undefined) return null;
  const result = validatePolicy(value);
  if (!result.ok) throw new PlatformError("STORE_UNAVAILABLE", "A stored rule book could not be read; nothing is planned or prepared for this key until it is fixed.", 503);
  return result.value;
}

/** Due pending → in force: returns the rows to change (`[pending, active]` new states). */
function promotion(heads: PolicyHeads, now: number): { readonly promoted: PolicyVersion; readonly superseded: PolicyVersion | null } | null {
  const pending = heads.pending;
  if (!pending || pending.activatesAt === null || Date.parse(pending.activatesAt) > now) return null;
  return {
    promoted: { ...pending, status: pending.document === null ? "removed" : "active", activatesAt: null },
    superseded: heads.active ? { ...heads.active, status: "superseded" } : null,
  };
}

/** The decision of a write against the current heads (pure: both stores apply it under their lock). */
function planWrite(heads: PolicyHeads, latestVersion: number, input: PolicyWrite): {
  readonly result: Omit<PolicyWriteResult, "promoted">;
  readonly insert: PolicyVersion | null;
  readonly updates: readonly PolicyVersion[];
} {
  const activeHash = heads.active?.hash ?? "none";
  if (input.ifMatch !== undefined && input.ifMatch !== activeHash) {
    throw new PlatformError("POLICY_CONFLICT", `If-Match ${input.ifMatch.slice(0, 80)} is not the active version (${activeHash}). Read the rule book again and resend the change.`, 409);
  }
  if (input.next === null) {
    if (!heads.active) throw policyNotFound("There is no rule book to remove.");
    if (heads.pending) {
      throw new PlatformError("POLICY_AMENDMENT_PENDING", "An amendment is pending; cancel it with DELETE …/policy/pending before removing the rule book.", 409);
    }
  }
  const before = heads.active?.document ?? (input.defaults === "agent" ? OBSERVER_POLICY : null);
  const comparison = comparePolicies(before, input.next, { defaults: input.defaults });
  const hash = input.next ? policyHash(input.next) : null;
  if (hash !== null && heads.active && heads.active.hash === hash && !heads.pending) {
    return { result: { version: heads.active, applied: "unchanged", supersededPending: null, comparison: { tightened: [], loosened: [] } }, insert: null, updates: [] };
  }
  // The delay of the version being replaced (§3.5): a leaked key cannot shorten it in the same change.
  const delaySeconds = heads.active?.document?.amendments?.delaySeconds ?? 0;
  const now = comparison.loosened.length === 0 || delaySeconds === 0;
  const version: PolicyVersion = {
    scope: input.scope,
    subjectId: input.subjectId,
    projectId: input.projectId,
    version: latestVersion + 1,
    document: input.next,
    hash,
    status: now ? (input.next === null ? "removed" : "active") : "pending",
    activatesAt: now ? null : iso(input.now + delaySeconds * 1000),
    loosened: comparison.loosened,
    tightened: comparison.tightened,
    createdBy: input.createdBy,
    createdAt: iso(input.now),
  };
  const updates: PolicyVersion[] = [];
  if (heads.pending) updates.push({ ...heads.pending, status: "superseded", activatesAt: null });
  if (now && heads.active) updates.push({ ...heads.active, status: "superseded" });
  return {
    result: { version, applied: now ? "now" : "pending", supersededPending: heads.pending, comparison },
    insert: version,
    updates,
  };
}

/* ================================================================= memory */

export class MemoryPolicyStore implements PolicyStore {
  readonly kind = "memory" as const;
  private readonly subjects = new Map<string, PolicyVersion[]>();

  /** `locks`: shared with the memory spend ledger (writes and reservations serialise per project). */
  constructor(private readonly locks: ProjectLocks = new ProjectLocks(), private readonly maxSubjects = 50_000) {}

  private list(scope: PolicyScope, subjectId: string): PolicyVersion[] {
    return this.subjects.get(subjectKey(scope, subjectId)) ?? [];
  }

  private save(version: PolicyVersion): void {
    const key = subjectKey(version.scope, version.subjectId);
    const list = this.subjects.get(key) ?? [];
    const index = list.findIndex((entry) => entry.version === version.version);
    if (index >= 0) list[index] = version;
    else list.push(version);
    this.subjects.delete(key);
    this.subjects.set(key, list);
    while (this.subjects.size > this.maxSubjects) {
      const oldest = this.subjects.keys().next().value;
      if (oldest === undefined) break;
      this.subjects.delete(oldest);
    }
  }

  private headsOf(scope: PolicyScope, subjectId: string): PolicyHeads {
    const list = this.list(scope, subjectId);
    return { active: list.find((entry) => entry.status === "active") ?? null, pending: list.find((entry) => entry.status === "pending") ?? null };
  }

  /** Synchronous (no lock needed in one process): due pending versions are promoted. */
  private promote(scope: PolicyScope, subjectId: string, now: number): PolicyVersion[] {
    const change = promotion(this.headsOf(scope, subjectId), now);
    if (!change) return [];
    if (change.superseded) this.save(change.superseded);
    this.save(change.promoted);
    return [change.promoted];
  }

  async heads(scope: PolicyScope, subjectId: string, now: number): Promise<PolicyHeads & { readonly promoted: readonly PolicyVersion[] }> {
    const promoted = this.promote(scope, subjectId, now);
    return { ...this.headsOf(scope, subjectId), promoted };
  }

  async activeMany(subjects: readonly { readonly scope: PolicyScope; readonly subjectId: string }[], now: number) {
    const active = new Map<string, PolicyVersion>();
    const promoted: PolicyVersion[] = [];
    for (const subject of subjects) {
      promoted.push(...this.promote(subject.scope, subject.subjectId, now));
      const head = this.headsOf(subject.scope, subject.subjectId).active;
      if (head) active.set(subjectKey(subject.scope, subject.subjectId), head);
    }
    return { active, promoted };
  }

  async write(input: PolicyWrite): Promise<PolicyWriteResult> {
    return this.locks.run(projectLockKey(input.projectId), async () => {
      const promoted = this.promote(input.scope, input.subjectId, input.now);
      const list = this.list(input.scope, input.subjectId);
      const latest = list.reduce((max, entry) => Math.max(max, entry.version), 0);
      const planned = planWrite(this.headsOf(input.scope, input.subjectId), latest, input);
      for (const update of planned.updates) this.save(update);
      if (planned.insert) this.save(planned.insert);
      return { ...planned.result, promoted };
    });
  }

  async cancelPending(scope: PolicyScope, subjectId: string, projectId: string, now: number): Promise<PolicyVersion> {
    return this.locks.run(projectLockKey(projectId), async () => {
      this.promote(scope, subjectId, now);
      const pending = this.headsOf(scope, subjectId).pending;
      if (!pending) throw policyNotFound("There is no pending amendment to cancel.");
      const cancelled: PolicyVersion = { ...pending, status: "cancelled", activatesAt: null };
      this.save(cancelled);
      return cancelled;
    });
  }

  async versions(scope: PolicyScope, subjectId: string, limit: number): Promise<PolicyVersion[]> {
    return [...this.list(scope, subjectId)].sort((a, b) => b.version - a.version).slice(0, Math.min(100, limit));
  }

  async promoteDue(now: number, limit: number): Promise<PolicyVersion[]> {
    const out: PolicyVersion[] = [];
    for (const list of [...this.subjects.values()]) {
      const pending = list.find((entry) => entry.status === "pending");
      if (!pending) continue;
      out.push(...this.promote(pending.scope, pending.subjectId, now));
      if (out.length >= limit) break;
    }
    return out;
  }
}

/* =============================================================== postgres */

export const POLICIES_SCHEMA = {
  name: "kletia_policies",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_policies (
  scope text NOT NULL CHECK (scope IN ('project', 'key')),
  subject_id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL,
  document jsonb,
  hash text,
  status text NOT NULL CHECK (status IN ('active', 'pending', 'superseded', 'cancelled', 'removed')),
  activates_at timestamptz,
  loosened text[] NOT NULL DEFAULT '{}',
  tightened text[] NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, subject_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS kletia_policies_active_idx ON kletia_policies (scope, subject_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS kletia_policies_pending_idx ON kletia_policies (scope, subject_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS kletia_policies_due_idx ON kletia_policies (activates_at) WHERE status = 'pending';`,
} as const;

const POLICY_COLUMNS = "scope, subject_id, project_id, version, document, hash, status, activates_at, loosened, tightened, created_by, created_at";
/** The same columns qualified by the `p` alias (joins with unnest). */
const POLICY_COLUMNS_P = POLICY_COLUMNS.split(", ").map((column) => `p.${column}`).join(", ");

interface PolicyRow {
  scope: string;
  subject_id: string;
  project_id: string;
  version: number;
  document: unknown;
  hash: string | null;
  status: string;
  activates_at: Date | string | null;
  loosened: string[] | null;
  tightened: string[] | null;
  created_by: string;
  created_at: Date | string;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const STATUSES: readonly PolicyVersionStatus[] = ["active", "pending", "superseded", "cancelled", "removed"];

function versionFromRow(row: PolicyRow): PolicyVersion {
  const status = STATUSES.includes(row.status as PolicyVersionStatus) ? (row.status as PolicyVersionStatus) : "superseded";
  return {
    scope: row.scope === "project" ? "project" : "key",
    subjectId: row.subject_id,
    projectId: row.project_id,
    version: row.version,
    document: storedDocument(row.document),
    hash: row.hash,
    status,
    activatesAt: isoOrNull(row.activates_at),
    loosened: row.loosened ?? [],
    tightened: row.tightened ?? [],
    createdBy: row.created_by,
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
  };
}

type Queryable = Pick<pg.PoolClient, "query">;

async function lockProject(client: Queryable, projectId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_policy:${projectLockKey(projectId)}`]);
}

async function readHeads(client: Queryable, scope: PolicyScope, subjectId: string): Promise<PolicyHeads> {
  const result = await client.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS} FROM kletia_policies WHERE scope = $1 AND subject_id = $2 AND status IN ('active', 'pending')`,
    [scope, subjectId],
  );
  const rows = result.rows.map(versionFromRow);
  return { active: rows.find((row) => row.status === "active") ?? null, pending: rows.find((row) => row.status === "pending") ?? null };
}

async function saveRow(client: Queryable, version: PolicyVersion, insert: boolean): Promise<void> {
  if (insert) {
    await client.query(
      `INSERT INTO kletia_policies (${POLICY_COLUMNS})
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::text[], $10::text[], $11, $12)`,
      [
        version.scope, version.subjectId, version.projectId, version.version,
        version.document === null ? null : JSON.stringify(version.document), version.hash, version.status, version.activatesAt,
        [...version.loosened], [...version.tightened], version.createdBy, version.createdAt,
      ],
    );
    return;
  }
  await client.query(
    "UPDATE kletia_policies SET status = $4, activates_at = $5 WHERE scope = $1 AND subject_id = $2 AND version = $3",
    [version.scope, version.subjectId, version.version, version.status, version.activatesAt],
  );
}

/** Promotes the subject's due pending version on `client` (caller holds the project lock). */
async function promoteOn(client: Queryable, scope: PolicyScope, subjectId: string, now: number): Promise<PolicyVersion[]> {
  const change = promotion(await readHeads(client, scope, subjectId), now);
  if (!change) return [];
  // Superseded first: the unique "one active" index holds at every statement.
  if (change.superseded) await saveRow(client, change.superseded, false);
  await saveRow(client, change.promoted, false);
  return [change.promoted];
}

export class PostgresPolicyStore implements PolicyStore {
  readonly kind = "postgres" as const;

  async heads(scope: PolicyScope, subjectId: string, now: number): Promise<PolicyHeads & { readonly promoted: readonly PolicyVersion[] }> {
    const due = await dbQuery<{ project_id: string }>(
      POLICIES_SCHEMA,
      "SELECT project_id FROM kletia_policies WHERE scope = $1 AND subject_id = $2 AND status = 'pending' AND activates_at <= $3 LIMIT 1",
      [scope, subjectId, iso(now)],
    );
    const projectId = due.rows[0]?.project_id;
    if (projectId) {
      return dbTransaction(POLICIES_SCHEMA, async (client) => {
        await lockProject(client, projectId);
        const promoted = await promoteOn(client, scope, subjectId, now);
        return { ...(await readHeads(client, scope, subjectId)), promoted };
      });
    }
    const result = await dbQuery<PolicyRow>(
      POLICIES_SCHEMA,
      `SELECT ${POLICY_COLUMNS} FROM kletia_policies WHERE scope = $1 AND subject_id = $2 AND status IN ('active', 'pending')`,
      [scope, subjectId],
    );
    const rows = result.rows.map(versionFromRow);
    return { active: rows.find((row) => row.status === "active") ?? null, pending: rows.find((row) => row.status === "pending") ?? null, promoted: [] };
  }

  async activeMany(subjects: readonly { readonly scope: PolicyScope; readonly subjectId: string; readonly projectId: string }[], now: number) {
    if (subjects.length === 0) return { active: new Map<string, PolicyVersion>(), promoted: [] };
    const scopes = subjects.map((subject) => subject.scope);
    const ids = subjects.map((subject) => subject.subjectId);
    const read = () => dbQuery<PolicyRow>(
      POLICIES_SCHEMA,
      `SELECT ${POLICY_COLUMNS_P} FROM kletia_policies p
       JOIN unnest($1::text[], $2::text[]) AS s(scope, subject_id) ON p.scope = s.scope AND p.subject_id = s.subject_id
       WHERE p.status IN ('active', 'pending')`,
      [scopes, ids],
    );
    let rows = (await read()).rows.map(versionFromRow);
    const promoted: PolicyVersion[] = [];
    const due = rows.filter((row) => row.status === "pending" && row.activatesAt !== null && Date.parse(row.activatesAt) <= now);
    if (due.length > 0) {
      for (const row of due) {
        promoted.push(...(await dbTransaction(POLICIES_SCHEMA, async (client) => {
          await lockProject(client, row.projectId);
          return promoteOn(client, row.scope, row.subjectId, now);
        })));
      }
      rows = (await read()).rows.map(versionFromRow);
    }
    const active = new Map<string, PolicyVersion>();
    for (const row of rows) if (row.status === "active") active.set(subjectKey(row.scope, row.subjectId), row);
    return { active, promoted };
  }

  async write(input: PolicyWrite): Promise<PolicyWriteResult> {
    return dbTransaction(POLICIES_SCHEMA, async (client) => {
      await lockProject(client, input.projectId);
      const promoted = await promoteOn(client, input.scope, input.subjectId, input.now);
      const latest = await client.query<{ version: number | null }>(
        "SELECT max(version) AS version FROM kletia_policies WHERE scope = $1 AND subject_id = $2",
        [input.scope, input.subjectId],
      );
      const planned = planWrite(await readHeads(client, input.scope, input.subjectId), Number(latest.rows[0]?.version ?? 0), input);
      for (const update of planned.updates) await saveRow(client, update, false);
      if (planned.insert) await saveRow(client, planned.insert, true);
      return { ...planned.result, promoted };
    });
  }

  async cancelPending(scope: PolicyScope, subjectId: string, projectId: string, now: number): Promise<PolicyVersion> {
    return dbTransaction(POLICIES_SCHEMA, async (client) => {
      await lockProject(client, projectId);
      await promoteOn(client, scope, subjectId, now);
      const pending = (await readHeads(client, scope, subjectId)).pending;
      if (!pending) throw policyNotFound("There is no pending amendment to cancel.");
      const cancelled: PolicyVersion = { ...pending, status: "cancelled", activatesAt: null };
      await saveRow(client, cancelled, false);
      return cancelled;
    });
  }

  async versions(scope: PolicyScope, subjectId: string, limit: number): Promise<PolicyVersion[]> {
    const result = await dbQuery<PolicyRow>(
      POLICIES_SCHEMA,
      `SELECT ${POLICY_COLUMNS} FROM kletia_policies WHERE scope = $1 AND subject_id = $2 ORDER BY version DESC LIMIT $3`,
      [scope, subjectId, Math.min(100, Math.max(1, limit))],
    );
    return result.rows.map(versionFromRow);
  }

  async promoteDue(now: number, limit: number): Promise<PolicyVersion[]> {
    const due = await dbQuery<{ scope: string; subject_id: string; project_id: string }>(
      POLICIES_SCHEMA,
      "SELECT scope, subject_id, project_id FROM kletia_policies WHERE status = 'pending' AND activates_at <= $1 ORDER BY activates_at LIMIT $2",
      [iso(now), limit],
    );
    const out: PolicyVersion[] = [];
    for (const row of due.rows) {
      out.push(...(await dbTransaction(POLICIES_SCHEMA, async (client) => {
        await lockProject(client, row.project_id);
        return promoteOn(client, row.scope === "project" ? "project" : "key", row.subject_id, now);
      })));
    }
    return out;
  }
}

/** Active heads of several subjects read on an open transaction (the spend ledger, under the project lock). */
export async function activeHeadsOn(client: Queryable, subjects: readonly { readonly scope: PolicyScope; readonly subjectId: string }[]): Promise<Map<string, PolicyVersion>> {
  const out = new Map<string, PolicyVersion>();
  if (subjects.length === 0) return out;
  const result = await client.query<PolicyRow>(
    `SELECT ${POLICY_COLUMNS_P} FROM kletia_policies p
     JOIN unnest($1::text[], $2::text[]) AS s(scope, subject_id) ON p.scope = s.scope AND p.subject_id = s.subject_id
     WHERE p.status = 'active'`,
    [subjects.map((subject) => subject.scope), subjects.map((subject) => subject.subjectId)],
  );
  for (const row of result.rows.map(versionFromRow)) out.set(subjectKey(row.scope, row.subjectId), row);
  return out;
}

/* ================================================================ selection */

/** One lock table per process: memory policy writes and memory reservations serialise on it. */
export const memoryProjectLocks = new ProjectLocks();

let store: PolicyStore | null = null;

export function policyStore(): PolicyStore {
  store ??= platformDatabaseUrl() ? new PostgresPolicyStore() : new MemoryPolicyStore(memoryProjectLocks);
  return store;
}

/** Replaces the store (tests); null re-selects by KLETIA_DATABASE_URL on next use. */
export function configurePolicyStore(custom: PolicyStore | null): void {
  store = custom;
}

export function policyStoreKind(): "memory" | "postgres" {
  return policyStore().kind;
}
