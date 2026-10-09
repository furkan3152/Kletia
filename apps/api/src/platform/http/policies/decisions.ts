/**
 * The Rule Book decision log (policy design §9): every plan, prepare,
 * submit, evaluate, approval, amendment and key decision, hash-chained per
 * project (`seq`, `prevHash`, `chainHash`) so an integrator who stores a
 * head detects any rewrite before it (`verifyDecisionChain` in core).
 *
 * `seq` is gapless per project: appends take the project lock (Postgres:
 * the advisory lock of spend reservations and rule book writes). Retention
 * is 30 days (KLETIA_POLICY_DECISION_RETENTION_DAYS); after pruning, chains
 * verify from the oldest retained record. Volume guard: past 50,000
 * decisions a project a UTC day, `allow` decisions of dry runs are counted
 * but not stored (denials, confirms, prepares, approvals always are).
 */
import {
  POLICY_DECISION_GENESIS,
  policyDecisionChainHash,
  type PolicyDecision,
  type PolicyDecisionOutcome,
  type PolicyDecisionStage,
} from "@kletia/core";
import { ProjectLocks, type PolicyDecisionDraft, type PolicyDecisionLog } from "../../index.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "../db.js";
import { memoryProjectLocks } from "./store.js";

export const DECISION_DAILY_VOLUME_GUARD = 50_000;
const DEFAULT_RETENTION_DAYS = 30;

export interface DecisionQuery {
  /** `prj_…` */
  readonly projectId: string;
  /** Only decisions about these keys (the caller's subtree); undefined: the whole project. */
  readonly keyIds?: readonly string[];
  readonly keyId?: string;
  readonly intentId?: string;
  readonly outcome?: PolicyDecisionOutcome;
  readonly stage?: PolicyDecisionStage;
  /** ISO time: decisions at or after. */
  readonly since?: string;
  /** Page after this decision (newest first: older ones). */
  readonly after?: string;
  readonly limit: number;
}

export interface DecisionHead {
  readonly seq: number;
  readonly chainHash: string;
}

export interface DecisionStore extends PolicyDecisionLog {
  readonly kind: "memory" | "postgres";
  get(id: string): Promise<PolicyDecision | null>;
  /** Newest first. */
  list(query: DecisionQuery): Promise<PolicyDecision[]>;
  head(projectId: string): Promise<DecisionHead | null>;
  prune(before: string): Promise<void>;
}

export function decisionRetentionDays(): number {
  const raw = Number(process.env.KLETIA_POLICY_DECISION_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 3650 ? Math.floor(raw) : DEFAULT_RETENTION_DAYS;
}

/** Decisions the volume guard may drop (counted, not stored). */
function guardable(draft: PolicyDecisionDraft): boolean {
  return draft.dryRun && draft.outcome === "allow" && (draft.stage === "plan" || draft.stage === "evaluate");
}

function matches(decision: PolicyDecision, query: DecisionQuery): boolean {
  if (query.keyIds && !(decision.keyId !== null && query.keyIds.includes(decision.keyId))) return false;
  if (query.keyId && decision.keyId !== query.keyId) return false;
  if (query.intentId && decision.intentId !== query.intentId) return false;
  if (query.outcome && decision.outcome !== query.outcome) return false;
  if (query.stage && decision.stage !== query.stage) return false;
  if (query.since && decision.at < query.since) return false;
  return true;
}

/* ================================================================= memory */

export class MemoryDecisionStore implements DecisionStore {
  readonly kind = "memory" as const;
  private readonly byProject = new Map<string, PolicyDecision[]>();
  private readonly heads = new Map<string, DecisionHead>();
  private readonly daily = new Map<string, number>();
  private total = 0;

  constructor(private readonly locks: ProjectLocks = memoryProjectLocks, private readonly maxRecords = 100_000) {}

  async append(draft: PolicyDecisionDraft): Promise<PolicyDecision> {
    return this.locks.run(`decisions:${draft.projectId}`, async () => {
      const head = this.heads.get(draft.projectId) ?? { seq: 0, chainHash: POLICY_DECISION_GENESIS };
      const day = `${draft.projectId}|${draft.at.slice(0, 10)}`;
      const count = (this.daily.get(day) ?? 0) + 1;
      this.daily.set(day, count);
      if (this.daily.size > 10_000) this.daily.delete(this.daily.keys().next().value as string);
      if (count > DECISION_DAILY_VOLUME_GUARD && guardable(draft)) {
        // Counted, not stored: the returned record is outside the chain.
        return { ...draft, seq: 0, prevHash: head.chainHash, chainHash: head.chainHash };
      }
      const seq = head.seq + 1;
      const decision: PolicyDecision = { ...draft, seq, prevHash: head.chainHash, chainHash: policyDecisionChainHash(head.chainHash, draft) };
      this.heads.set(draft.projectId, { seq, chainHash: decision.chainHash });
      const list = this.byProject.get(draft.projectId) ?? [];
      list.push(decision);
      this.byProject.set(draft.projectId, list);
      this.total += 1;
      while (this.total > this.maxRecords) {
        const [project, oldest] = [...this.byProject.entries()].sort((a, b) => (a[1][0]?.at ?? "").localeCompare(b[1][0]?.at ?? ""))[0] ?? [];
        if (!project || !oldest || oldest.length === 0) break;
        oldest.shift();
        this.total -= 1;
        if (oldest.length === 0) this.byProject.delete(project);
      }
      return decision;
    });
  }

  async get(id: string): Promise<PolicyDecision | null> {
    for (const list of this.byProject.values()) {
      const found = list.find((decision) => decision.id === id);
      if (found) return found;
    }
    return null;
  }

  async list(query: DecisionQuery): Promise<PolicyDecision[]> {
    const list = this.byProject.get(query.projectId) ?? [];
    let afterSeq = Number.POSITIVE_INFINITY;
    if (query.after) {
      const anchor = list.find((decision) => decision.id === query.after);
      if (!anchor) return [];
      afterSeq = anchor.seq;
    }
    const out: PolicyDecision[] = [];
    for (let index = list.length - 1; index >= 0 && out.length < query.limit; index -= 1) {
      const decision = list[index] as PolicyDecision;
      if (decision.seq >= afterSeq) continue;
      if (matches(decision, query)) out.push(decision);
    }
    return out;
  }

  async head(projectId: string): Promise<DecisionHead | null> {
    return this.heads.get(projectId) ?? null;
  }

  async prune(before: string): Promise<void> {
    for (const [project, list] of this.byProject) {
      const kept = list.filter((decision) => decision.at >= before);
      this.total -= list.length - kept.length;
      if (kept.length === 0) this.byProject.delete(project);
      else this.byProject.set(project, kept);
    }
  }
}

/* =============================================================== postgres */

const DECISIONS_SCHEMA = {
  name: "kletia_policy_decisions",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_policy_decisions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  seq bigint NOT NULL,
  prev_hash text NOT NULL,
  chain_hash text NOT NULL,
  key_id text,
  actor_key_id text,
  intent_id text,
  step_id text,
  stage text NOT NULL,
  outcome text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, seq)
);
CREATE INDEX IF NOT EXISTS kletia_policy_decisions_key_idx ON kletia_policy_decisions (key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kletia_policy_decisions_intent_idx ON kletia_policy_decisions (intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kletia_policy_decisions_time_idx ON kletia_policy_decisions (created_at);
CREATE INDEX IF NOT EXISTS kletia_policy_decisions_project_idx ON kletia_policy_decisions (project_id, seq DESC);`,
} as const;

interface DecisionRow {
  record: unknown;
}

function fromRow(row: DecisionRow): PolicyDecision {
  return row.record as PolicyDecision;
}

export class PostgresDecisionStore implements DecisionStore {
  readonly kind = "postgres" as const;

  async append(draft: PolicyDecisionDraft): Promise<PolicyDecision> {
    return dbTransaction(DECISIONS_SCHEMA, async (client) => {
      // The project lock of reservations and rule book writes: seq stays gapless across instances.
      // The head is ordered by the bigint column (`d.seq`): ORDER BY on the bare name would sort the
      // text alias of the same name, so "9" would outrank "10" and the 11th append would collide.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_policy:${draft.projectId}`]);
      const last = await client.query<{ seq: string; chain_hash: string }>(
        "SELECT d.seq::text AS seq, d.chain_hash FROM kletia_policy_decisions d WHERE d.project_id = $1 ORDER BY d.seq DESC LIMIT 1",
        [draft.projectId],
      );
      const head = last.rows[0] ? { seq: Number(last.rows[0].seq), chainHash: last.rows[0].chain_hash } : { seq: 0, chainHash: POLICY_DECISION_GENESIS };
      if (guardable(draft)) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM kletia_policy_decisions WHERE project_id = $1 AND created_at >= $2",
          [draft.projectId, `${draft.at.slice(0, 10)}T00:00:00.000Z`],
        );
        if (Number(count.rows[0]?.count ?? "0") >= DECISION_DAILY_VOLUME_GUARD) return { ...draft, seq: 0, prevHash: head.chainHash, chainHash: head.chainHash };
      }
      const seq = head.seq + 1;
      // The stored record is exactly what was hashed (JSON round trip drops nothing canonicalJson keeps).
      const decision: PolicyDecision = JSON.parse(JSON.stringify({ ...draft, seq, prevHash: head.chainHash, chainHash: policyDecisionChainHash(head.chainHash, draft) })) as PolicyDecision;
      await client.query(
        `INSERT INTO kletia_policy_decisions (id, project_id, seq, prev_hash, chain_hash, key_id, actor_key_id, intent_id, step_id, stage, outcome, dry_run, record, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
        [
          decision.id, decision.projectId, seq, decision.prevHash, decision.chainHash, decision.keyId, decision.actorKeyId,
          decision.intentId ?? null, decision.stepId ?? null, decision.stage, decision.outcome, decision.dryRun, JSON.stringify(decision), decision.at,
        ],
      );
      return decision;
    });
  }

  async get(id: string): Promise<PolicyDecision | null> {
    const result = await dbQuery<DecisionRow>(DECISIONS_SCHEMA, "SELECT record FROM kletia_policy_decisions WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? fromRow(row) : null;
  }

  async list(query: DecisionQuery): Promise<PolicyDecision[]> {
    const clauses = ["project_id = $1"];
    const values: unknown[] = [query.projectId];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (query.keyIds) add("key_id = ANY(?::text[])", [...query.keyIds]);
    if (query.keyId) add("key_id = ?", query.keyId);
    if (query.intentId) add("intent_id = ?", query.intentId);
    if (query.outcome) add("outcome = ?", query.outcome);
    if (query.stage) add("stage = ?", query.stage);
    if (query.since) add("created_at >= ?", query.since);
    if (query.after) add("seq < (SELECT seq FROM kletia_policy_decisions WHERE id = ?)", query.after);
    values.push(Math.min(200, Math.max(1, query.limit)));
    const result = await dbQuery<DecisionRow>(
      DECISIONS_SCHEMA,
      `SELECT record FROM kletia_policy_decisions WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(fromRow);
  }

  async head(projectId: string): Promise<DecisionHead | null> {
    const result = await dbQuery<{ seq: string; chain_hash: string }>(
      DECISIONS_SCHEMA,
      "SELECT d.seq::text AS seq, d.chain_hash FROM kletia_policy_decisions d WHERE d.project_id = $1 ORDER BY d.seq DESC LIMIT 1",
      [projectId],
    );
    const row = result.rows[0];
    return row ? { seq: Number(row.seq), chainHash: row.chain_hash } : null;
  }

  async prune(before: string): Promise<void> {
    await dbQuery(DECISIONS_SCHEMA, "DELETE FROM kletia_policy_decisions WHERE created_at < $1", [before]);
  }
}

let store: DecisionStore | null = null;

export function decisionStore(): DecisionStore {
  store ??= platformDatabaseUrl() ? new PostgresDecisionStore() : new MemoryDecisionStore();
  return store;
}

export function configureDecisionStore(custom: DecisionStore | null): void {
  store = custom;
}
