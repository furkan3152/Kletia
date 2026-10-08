/**
 * Intent persistence with optimistic concurrency.
 *
 * - MemoryIntentStore: bounded LRU (default 5000 intents) for development and
 *   single-instance deployments.
 * - PostgresIntentStore: `kletia_intents` (graph as jsonb) plus
 *   `kletia_intent_references`, a global claim table that stops one on-chain
 *   transaction from completing two steps or two intents.
 *
 * `update(id, graph, expectedUpdatedAt)` succeeds only when the stored graph
 * still carries `expectedUpdatedAt`; otherwise it throws 409 INTENT_CONFLICT.
 */
import pg from "pg";
import type { IntentGraph, StepStatus } from "@kletia/core";
import { PlatformError } from "../errors.js";

export interface IntentRecordMeta {
  readonly ownerKeyId?: string;
}

export interface ReferenceClaim {
  /** Namespaced reference key (`<caip2>:<hash|signature>`). */
  readonly key: string;
  readonly intentId: string;
  readonly stepId: string;
}

export interface IntentStore {
  readonly kind: "memory" | "postgres";
  create(graph: IntentGraph, meta: IntentRecordMeta): Promise<void>;
  get(id: string): Promise<IntentGraph | null>;
  /** Replaces the graph when the stored `updatedAt` equals `expectedUpdatedAt`; 409 otherwise. */
  update(id: string, graph: IntentGraph, expectedUpdatedAt: string): Promise<void>;
  listByOwner(ownerKeyId: string, limit: number): Promise<IntentGraph[]>;
  /** Intents with steps awaiting on-chain verification or settlement, oldest update first. */
  listActive(limit: number): Promise<IntentGraph[]>;
  findByClientReference(ownerKeyId: string, clientReference: string): Promise<IntentGraph | null>;
  /** API key id that created the intent: null for keyless intents, undefined when the intent is unknown. */
  ownerOf(id: string): Promise<string | null | undefined>;
  /**
   * Claims references for one step. Re-claiming by the same intent/step is a
   * no-op; a reference already claimed elsewhere throws 422 REFERENCE_ALREADY_USED.
   */
  claimReferences(claims: readonly ReferenceClaim[]): Promise<void>;
  close(): Promise<void>;
}

const ACTIVE_STEP_STATUSES: readonly StepStatus[] = ["submitted", "confirmed", "settling"];

export function isActiveGraph(graph: IntentGraph): boolean {
  return graph.status !== "cancelled" && graph.steps.some((step) => ACTIVE_STEP_STATUSES.includes(step.status));
}

function conflict(): PlatformError {
  return new PlatformError("INTENT_CONFLICT", "The intent changed while this request was running. Read it again and retry.", 409);
}

/** Another intent from the same API key already uses this clientReference. */
export function clientReferenceExists(): PlatformError {
  return new PlatformError("CLIENT_REFERENCE_EXISTS", "An intent with this clientReference already exists for this API key.", 409);
}

function notFound(): PlatformError {
  return new PlatformError("INTENT_NOT_FOUND", "Intent not found.", 404);
}

function referenceUsed(): PlatformError {
  return new PlatformError("REFERENCE_ALREADY_USED", "A submitted transaction is already bound to another intent step.", 422);
}

function clampLimit(limit: number, max = 200): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : 50;
}

interface MemoryRecord {
  graph: IntentGraph;
  ownerKeyId?: string;
}

export class MemoryIntentStore implements IntentStore {
  readonly kind = "memory" as const;
  private readonly records = new Map<string, MemoryRecord>();
  private readonly claims = new Map<string, { intentId: string; stepId: string }>();

  constructor(
    private readonly maxIntents = 5_000,
    private readonly maxClaims = 50_000,
  ) {}

  private touch(id: string, record: MemoryRecord): void {
    this.records.delete(id);
    this.records.set(id, record);
    while (this.records.size > this.maxIntents) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  async create(graph: IntentGraph, meta: IntentRecordMeta): Promise<void> {
    if (this.records.has(graph.id)) throw new PlatformError("INTENT_EXISTS", "Intent id already exists.", 409);
    const clientReference = graph.request.clientReference;
    if (meta.ownerKeyId && clientReference && (await this.findByClientReference(meta.ownerKeyId, clientReference))) {
      throw clientReferenceExists();
    }
    this.touch(graph.id, { graph: structuredClone(graph), ...(meta.ownerKeyId ? { ownerKeyId: meta.ownerKeyId } : {}) });
  }

  async get(id: string): Promise<IntentGraph | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record.graph) : null;
  }

  async update(id: string, graph: IntentGraph, expectedUpdatedAt: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw notFound();
    if (record.graph.updatedAt !== expectedUpdatedAt) throw conflict();
    this.touch(id, { ...record, graph: structuredClone(graph) });
  }

  async listByOwner(ownerKeyId: string, limit: number): Promise<IntentGraph[]> {
    return [...this.records.values()]
      .filter((record) => record.ownerKeyId === ownerKeyId)
      .map((record) => record.graph)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, clampLimit(limit))
      .map((graph) => structuredClone(graph));
  }

  async listActive(limit: number): Promise<IntentGraph[]> {
    return [...this.records.values()]
      .map((record) => record.graph)
      .filter(isActiveGraph)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
      .slice(0, clampLimit(limit, 500))
      .map((graph) => structuredClone(graph));
  }

  async findByClientReference(ownerKeyId: string, clientReference: string): Promise<IntentGraph | null> {
    for (const record of this.records.values()) {
      if (record.ownerKeyId === ownerKeyId && record.graph.request.clientReference === clientReference) {
        return structuredClone(record.graph);
      }
    }
    return null;
  }

  async ownerOf(id: string): Promise<string | null | undefined> {
    const record = this.records.get(id);
    return record ? (record.ownerKeyId ?? null) : undefined;
  }

  async claimReferences(claims: readonly ReferenceClaim[]): Promise<void> {
    for (const claim of claims) {
      const existing = this.claims.get(claim.key);
      if (existing && (existing.intentId !== claim.intentId || existing.stepId !== claim.stepId)) throw referenceUsed();
    }
    for (const claim of claims) {
      this.claims.set(claim.key, { intentId: claim.intentId, stepId: claim.stepId });
      while (this.claims.size > this.maxClaims) {
        const oldest = this.claims.keys().next().value;
        if (oldest === undefined) break;
        this.claims.delete(oldest);
      }
    }
  }

  async close(): Promise<void> {
    this.records.clear();
    this.claims.clear();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kletia_intents (
  id text PRIMARY KEY,
  owner_key_id text,
  status text NOT NULL,
  graph jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_intents_owner_idx ON kletia_intents (owner_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kletia_intents_status_idx ON kletia_intents (status, updated_at);
ALTER TABLE kletia_intents ADD COLUMN IF NOT EXISTS client_reference text;
CREATE UNIQUE INDEX IF NOT EXISTS kletia_intents_client_reference_idx
  ON kletia_intents (owner_key_id, client_reference)
  WHERE owner_key_id IS NOT NULL AND client_reference IS NOT NULL;
CREATE TABLE IF NOT EXISTS kletia_intent_references (
  reference text PRIMARY KEY,
  intent_id text NOT NULL,
  step_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

const ACTIVE_INTENT_STATUSES = ["executing", "settling", "indeterminate", "partially_completed", "failed"];

export class PostgresIntentStore implements IntentStore {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: Number(process.env.KLETIA_DATABASE_POOL_SIZE) || 5, idleTimeoutMillis: 30_000 });
    this.pool.on("error", (error) => {
      console.error("[platform] postgres pool error:", error.message);
    });
  }

  private async init(): Promise<void> {
    this.ready ??= this.pool.query(SCHEMA_SQL).then(() => undefined).catch((error: unknown) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private async query<R extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      await this.init();
      return await this.pool.query<R>(text, values);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      console.error("[platform] postgres query failed:", error instanceof Error ? error.message : error);
      throw new PlatformError("STORE_UNAVAILABLE", "Intent storage is temporarily unavailable.", 503);
    }
  }

  private static parse(row: { graph: unknown } | undefined): IntentGraph | null {
    if (!row || typeof row.graph !== "object" || row.graph === null) return null;
    return row.graph as IntentGraph;
  }

  async create(graph: IntentGraph, meta: IntentRecordMeta): Promise<void> {
    const clientReference = meta.ownerKeyId ? graph.request.clientReference ?? null : null;
    // No conflict target: a duplicate id and a duplicate (owner, clientReference)
    // are both refused, so concurrent retries across instances create one intent.
    const result = await this.query(
      `INSERT INTO kletia_intents (id, owner_key_id, status, graph, created_at, updated_at, client_reference)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [graph.id, meta.ownerKeyId ?? null, graph.status, JSON.stringify(graph), graph.createdAt, graph.updatedAt, clientReference],
    );
    if (result.rowCount !== 0) return;
    if (clientReference && !(await this.get(graph.id))) throw clientReferenceExists();
    throw new PlatformError("INTENT_EXISTS", "Intent id already exists.", 409);
  }

  async get(id: string): Promise<IntentGraph | null> {
    const result = await this.query<{ graph: unknown }>("SELECT graph FROM kletia_intents WHERE id = $1", [id]);
    return PostgresIntentStore.parse(result.rows[0]);
  }

  async update(id: string, graph: IntentGraph, expectedUpdatedAt: string): Promise<void> {
    const result = await this.query(
      `UPDATE kletia_intents SET graph = $2::jsonb, status = $3, updated_at = $4
       WHERE id = $1 AND graph->>'updatedAt' = $5`,
      [id, JSON.stringify(graph), graph.status, graph.updatedAt, expectedUpdatedAt],
    );
    if (result.rowCount === 1) return;
    const exists = await this.query("SELECT 1 FROM kletia_intents WHERE id = $1", [id]);
    throw exists.rowCount === 0 ? notFound() : conflict();
  }

  async listByOwner(ownerKeyId: string, limit: number): Promise<IntentGraph[]> {
    const result = await this.query<{ graph: unknown }>(
      "SELECT graph FROM kletia_intents WHERE owner_key_id = $1 ORDER BY created_at DESC LIMIT $2",
      [ownerKeyId, clampLimit(limit)],
    );
    return result.rows.map((row) => PostgresIntentStore.parse(row)).filter((graph): graph is IntentGraph => graph !== null);
  }

  async listActive(limit: number): Promise<IntentGraph[]> {
    const result = await this.query<{ graph: unknown }>(
      `SELECT graph FROM kletia_intents
       WHERE status = ANY($1::text[])
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(graph->'steps') AS step WHERE step->>'status' = ANY($2::text[]))
       ORDER BY updated_at ASC LIMIT $3`,
      [ACTIVE_INTENT_STATUSES, ACTIVE_STEP_STATUSES, clampLimit(limit, 500)],
    );
    return result.rows.map((row) => PostgresIntentStore.parse(row)).filter((graph): graph is IntentGraph => graph !== null);
  }

  async findByClientReference(ownerKeyId: string, clientReference: string): Promise<IntentGraph | null> {
    const result = await this.query<{ graph: unknown }>(
      `SELECT graph FROM kletia_intents
       WHERE owner_key_id = $1 AND (client_reference = $2 OR graph->'request'->>'clientReference' = $2)
       ORDER BY created_at DESC LIMIT 1`,
      [ownerKeyId, clientReference],
    );
    return PostgresIntentStore.parse(result.rows[0]);
  }

  async ownerOf(id: string): Promise<string | null | undefined> {
    const result = await this.query<{ owner_key_id: string | null }>("SELECT owner_key_id FROM kletia_intents WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? row.owner_key_id : undefined;
  }

  async claimReferences(claims: readonly ReferenceClaim[]): Promise<void> {
    if (claims.length === 0) return;
    await this.init().catch(() => {
      throw new PlatformError("STORE_UNAVAILABLE", "Intent storage is temporarily unavailable.", 503);
    });
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new PlatformError("STORE_UNAVAILABLE", "Intent storage is temporarily unavailable.", 503);
    }
    try {
      await client.query("BEGIN");
      const values: unknown[] = [];
      const rows = claims.map((claim, index) => {
        values.push(claim.key, claim.intentId, claim.stepId);
        return `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`;
      });
      await client.query(
        `INSERT INTO kletia_intent_references (reference, intent_id, step_id) VALUES ${rows.join(", ")} ON CONFLICT (reference) DO NOTHING`,
        values,
      );
      const existing = await client.query<{ reference: string; intent_id: string; step_id: string }>(
        "SELECT reference, intent_id, step_id FROM kletia_intent_references WHERE reference = ANY($1::text[])",
        [claims.map((claim) => claim.key)],
      );
      const clash = existing.rows.some((row) => {
        const claim = claims.find((entry) => entry.key === row.reference);
        return claim !== undefined && (row.intent_id !== claim.intentId || row.step_id !== claim.stepId);
      });
      if (clash) {
        await client.query("ROLLBACK");
        throw referenceUsed();
      }
      await client.query("COMMIT");
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("[platform] postgres claim failed:", error instanceof Error ? error.message : error);
      throw new PlatformError("STORE_UNAVAILABLE", "Intent storage is temporarily unavailable.", 503);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

let announced = false;

/** Postgres when KLETIA_DATABASE_URL is set, otherwise an in-memory store. */
export function createIntentStore(): IntentStore {
  const url = process.env.KLETIA_DATABASE_URL?.trim();
  const store: IntentStore = url ? new PostgresIntentStore(url) : new MemoryIntentStore();
  if (!announced) {
    announced = true;
    console.log(
      url
        ? "[platform] intent store: postgres (KLETIA_DATABASE_URL)"
        : "[platform] intent store: in-memory (set KLETIA_DATABASE_URL for durable intents)",
    );
  }
  return store;
}
