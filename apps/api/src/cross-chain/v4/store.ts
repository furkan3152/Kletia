import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolConfig } from "pg";
import { decodeCanonicalBase64Url } from "../../shared/security/canonicalBase64Url.js";
import { workflowPlanV4Hash } from "./compiler.js";
import type { WorkflowPlanV4 } from "./types.js";

const connectionString =
  process.env.WORKFLOW_V4_DATABASE_URL?.trim() ||
  process.env.WORKFLOW_V3_DATABASE_URL?.trim() ||
  process.env.STELLAR_EVENT_ARCHIVE_DATABASE_URL?.trim() ||
  "";
const sqlitePath = process.env.NODE_ENV === "production" || connectionString
  ? ""
  : process.env.WORKFLOW_V4_SQLITE_PATH?.trim() || ".kletia/workflow-v4.sqlite";

let pool: Pool | null = null;
let postgresInitialized: Promise<void> | null = null;
let sqlite: DatabaseSync | null = null;
let sqliteInitialized = false;

function controlled(code: string, message: string, statusCode = 503, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function signingSecret(): string {
  const configured = process.env.WORKFLOW_SIGNING_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV !== "production") return "kletia-development-workflow-v4-secret-only";
  throw controlled("WORKFLOW_V4_SIGNING_UNAVAILABLE", "Workflow V4 signing is not configured.");
}

function postgresConfig(): PoolConfig {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  return {
    connectionString,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(sslMode === "require" || sslMode === "verify-full"
      ? { ssl: { rejectUnauthorized: sslMode === "verify-full" } }
      : {}),
  };
}

function databasePool(): Pool {
  if (!connectionString) throw controlled("WORKFLOW_V4_STORE_UNAVAILABLE", "Workflow V4 persistence is not configured.");
  pool ??= new Pool(postgresConfig());
  return pool;
}

function sqliteDatabase(): DatabaseSync {
  if (!sqlitePath || sqlitePath === ":memory:" || sqlitePath.startsWith("file::memory:")) {
    throw controlled("WORKFLOW_V4_STORE_UNAVAILABLE", "Workflow V4 requires durable persistence.");
  }
  if (!sqlite) {
    const absolute = resolve(sqlitePath);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    sqlite = new DatabaseSync(absolute);
    chmodSync(absolute, 0o600);
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  }
  return sqlite;
}

async function ensureSchema(): Promise<void> {
  if (connectionString) {
    postgresInitialized ??= databasePool().query(`
      CREATE TABLE IF NOT EXISTS kletia_workflow_v4_plans (
        workflow_id UUID PRIMARY KEY,
        request_id UUID NOT NULL,
        lane VARCHAR(16) NOT NULL,
        plan_hash VARCHAR(66) NOT NULL,
        plan_json JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS kletia_workflow_v4_evidence (
        workflow_id UUID NOT NULL REFERENCES kletia_workflow_v4_plans(workflow_id),
        evidence_id VARCHAR(128) NOT NULL,
        evidence_json JSONB NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workflow_id, evidence_id)
      );
    `).then(() => undefined).catch((error) => {
      postgresInitialized = null;
      throw controlled("WORKFLOW_V4_STORE_UNAVAILABLE", "Workflow V4 schema initialization failed.", 503, error);
    });
    return postgresInitialized;
  }
  if (!sqliteInitialized) {
    sqliteDatabase().exec(`
      CREATE TABLE IF NOT EXISTS kletia_workflow_v4_plans (
        workflow_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS kletia_workflow_v4_evidence (
        workflow_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workflow_id, evidence_id),
        FOREIGN KEY (workflow_id) REFERENCES kletia_workflow_v4_plans(workflow_id)
      );
    `);
    sqliteInitialized = true;
  }
}

function verifiedPlan(input: {
  readonly workflowId: string;
  readonly plan: WorkflowPlanV4;
  readonly planHash: string;
  readonly expiresAt: string | Date;
}): WorkflowPlanV4 {
  if (
    input.plan?.version !== 4 ||
    input.plan.schemaVersion !== "kletia_workflow_plan_v4" ||
    input.plan.workflowId !== input.workflowId ||
    input.plan.expiresAt !== new Date(input.expiresAt).getTime() ||
    workflowPlanV4Hash(input.plan).toLowerCase() !== input.planHash.toLowerCase()
  ) {
    throw controlled("WORKFLOW_V4_STORE_INTEGRITY_FAILED", "Stored Workflow V4 content failed its identity or hash check.");
  }
  return input.plan;
}

export async function saveWorkflowPlanV4(plan: WorkflowPlanV4): Promise<void> {
  await ensureSchema();
  const planHash = workflowPlanV4Hash(plan);
  const expiresAt = new Date(plan.expiresAt).toISOString();
  if (!connectionString) {
    sqliteDatabase().prepare(`INSERT INTO kletia_workflow_v4_plans
      (workflow_id, request_id, lane, plan_hash, plan_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(plan.workflowId, plan.requestId, plan.lane, planHash, JSON.stringify(plan), expiresAt);
    return;
  }
  await databasePool().query(
    `INSERT INTO kletia_workflow_v4_plans
      (workflow_id, request_id, lane, plan_hash, plan_json, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [plan.workflowId, plan.requestId, plan.lane, planHash, JSON.stringify(plan), expiresAt],
  );
}

export async function readWorkflowPlanV4(workflowId: string): Promise<WorkflowPlanV4> {
  await ensureSchema();
  if (!connectionString) {
    const row = sqliteDatabase().prepare(
      "SELECT plan_json, plan_hash, expires_at FROM kletia_workflow_v4_plans WHERE workflow_id = ?",
    ).get(workflowId) as { plan_json?: string; plan_hash?: string; expires_at?: string } | undefined;
    if (!row?.plan_json || !row.plan_hash || !row.expires_at) {
      throw controlled("WORKFLOW_V4_NOT_FOUND", "Workflow V4 was not found.", 404);
    }
    return verifiedPlan({
      workflowId,
      plan: JSON.parse(row.plan_json) as WorkflowPlanV4,
      planHash: row.plan_hash,
      expiresAt: row.expires_at,
    });
  }
  const result = await databasePool().query<{
    plan_json: WorkflowPlanV4;
    plan_hash: string;
    expires_at: Date;
  }>("SELECT plan_json, plan_hash, expires_at FROM kletia_workflow_v4_plans WHERE workflow_id = $1", [workflowId]);
  const row = result.rows[0];
  if (!row) throw controlled("WORKFLOW_V4_NOT_FOUND", "Workflow V4 was not found.", 404);
  return verifiedPlan({ workflowId, plan: row.plan_json, planHash: row.plan_hash, expiresAt: row.expires_at });
}

export async function readWorkflowEvidenceV4(workflowId: string): Promise<readonly unknown[]> {
  await ensureSchema();
  if (!connectionString) {
    return sqliteDatabase().prepare(
      "SELECT evidence_json FROM kletia_workflow_v4_evidence WHERE workflow_id = ? ORDER BY recorded_at, evidence_id",
    ).all(workflowId).map((row) => JSON.parse(String((row as { evidence_json: string }).evidence_json)));
  }
  const result = await databasePool().query<{ evidence_json: unknown }>(
    "SELECT evidence_json FROM kletia_workflow_v4_evidence WHERE workflow_id = $1 ORDER BY recorded_at, evidence_id",
    [workflowId],
  );
  return result.rows.map((row) => row.evidence_json);
}

export async function replaceWorkflowPlanV4(input: {
  readonly previous: WorkflowPlanV4;
  readonly next: WorkflowPlanV4;
  readonly expectedPlanHash: `0x${string}`;
  readonly evidenceId: string;
  readonly evidence: unknown;
}): Promise<void> {
  await ensureSchema();
  if (
    input.previous.workflowId !== input.next.workflowId ||
    input.previous.requestId !== input.next.requestId ||
    input.previous.lane !== input.next.lane ||
    input.previous.createdAt !== input.next.createdAt ||
    workflowPlanV4Hash(input.previous) !== input.expectedPlanHash ||
    !/^[a-z][a-z0-9:_-]{7,127}$/u.test(input.evidenceId)
  ) {
    throw controlled("WORKFLOW_V4_TRANSITION_INVALID", "Workflow V4 transition identity or evidence is invalid.", 409);
  }
  const nextHash = workflowPlanV4Hash(input.next);
  const expiresAt = new Date(input.next.expiresAt).toISOString();
  if (!connectionString) {
    const db = sqliteDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const stored = db.prepare(
        "SELECT plan_hash, plan_json FROM kletia_workflow_v4_plans WHERE workflow_id = ?",
      ).get(input.previous.workflowId) as { plan_hash?: string; plan_json?: string } | undefined;
      if (!stored?.plan_hash || !stored.plan_json || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
        throw controlled("WORKFLOW_V4_TOKEN_STALE", "The workflow changed before this transition.", 409);
      }
      const storedPlan = JSON.parse(stored.plan_json) as WorkflowPlanV4;
      if (workflowPlanV4Hash(storedPlan) !== input.expectedPlanHash) {
        throw controlled("WORKFLOW_V4_STORE_INTEGRITY_FAILED", "Stored Workflow V4 content failed its hash check.");
      }
      db.prepare(`INSERT INTO kletia_workflow_v4_evidence
        (workflow_id, evidence_id, evidence_json) VALUES (?, ?, ?)`)
        .run(input.next.workflowId, input.evidenceId, JSON.stringify(input.evidence));
      const updated = db.prepare(`UPDATE kletia_workflow_v4_plans
        SET plan_hash = ?, plan_json = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workflow_id = ? AND plan_hash = ?`)
        .run(nextHash, JSON.stringify(input.next), expiresAt, input.next.workflowId, input.expectedPlanHash);
      if (Number(updated.changes) !== 1) {
        throw controlled("WORKFLOW_V4_TOKEN_STALE", "The workflow changed during this transition.", 409);
      }
      db.exec("COMMIT");
      return;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* rollback is best effort */ }
      if ((error as { code?: string }).code) throw error;
      if (String((error as { message?: string }).message ?? "").includes("UNIQUE")) {
        throw controlled("WORKFLOW_V4_EVIDENCE_REPLAY", "This Workflow V4 evidence was already recorded.", 409, error);
      }
      throw controlled("WORKFLOW_V4_TRANSITION_FAILED", "Workflow V4 transition failed atomically.", 503, error);
    }
  }

  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ plan_hash: string; plan_json: WorkflowPlanV4 }>(
      "SELECT plan_hash, plan_json FROM kletia_workflow_v4_plans WHERE workflow_id = $1 FOR UPDATE",
      [input.previous.workflowId],
    );
    const stored = locked.rows[0];
    if (!stored || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
      throw controlled("WORKFLOW_V4_TOKEN_STALE", "The workflow changed before this transition.", 409);
    }
    if (workflowPlanV4Hash(stored.plan_json) !== input.expectedPlanHash) {
      throw controlled("WORKFLOW_V4_STORE_INTEGRITY_FAILED", "Stored Workflow V4 content failed its hash check.");
    }
    await client.query(
      `INSERT INTO kletia_workflow_v4_evidence
        (workflow_id, evidence_id, evidence_json) VALUES ($1, $2, $3::jsonb)`,
      [input.next.workflowId, input.evidenceId, JSON.stringify(input.evidence)],
    );
    const updated = await client.query(
      `UPDATE kletia_workflow_v4_plans
       SET plan_hash = $1, plan_json = $2::jsonb, expires_at = $3, updated_at = NOW()
       WHERE workflow_id = $4 AND plan_hash = $5`,
      [nextHash, JSON.stringify(input.next), expiresAt, input.next.workflowId, input.expectedPlanHash],
    );
    if (updated.rowCount !== 1) {
      throw controlled("WORKFLOW_V4_TOKEN_STALE", "The workflow changed during this transition.", 409);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* rollback is best effort */ }
    if ((error as { code?: string }).code?.startsWith("WORKFLOW_V4_")) throw error;
    if ((error as { code?: string }).code === "23505") {
      throw controlled("WORKFLOW_V4_EVIDENCE_REPLAY", "This Workflow V4 evidence was already recorded.", 409, error);
    }
    throw controlled("WORKFLOW_V4_TRANSITION_FAILED", "Workflow V4 transition failed atomically.", 503, error);
  } finally {
    client.release();
  }
}

export function sealWorkflowPlanV4(plan: WorkflowPlanV4): string {
  const payload = Buffer.from(JSON.stringify({
    version: 4,
    workflowId: plan.workflowId,
    planHash: workflowPlanV4Hash(plan),
    expiresAt: plan.expiresAt,
  })).toString("base64url");
  const signature = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function openWorkflowTokenV4(value: unknown): {
  readonly workflowId: string;
  readonly planHash: `0x${string}`;
  readonly expiresAt: number;
} {
  const [payload, signature, extra] = String(value ?? "").split(".");
  if (!payload || !signature || extra) throw controlled("WORKFLOW_V4_TOKEN_INVALID", "Workflow V4 token is malformed.", 401);
  const expected = createHmac("sha256", signingSecret()).update(payload).digest();
  let actual: Buffer;
  let decoded: Record<string, unknown>;
  try {
    actual = decodeCanonicalBase64Url(signature);
    decoded = JSON.parse(decodeCanonicalBase64Url(payload).toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw controlled("WORKFLOW_V4_TOKEN_INVALID", "Workflow V4 token is malformed.", 401, error);
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw controlled("WORKFLOW_V4_TOKEN_INVALID", "Workflow V4 token signature is invalid.", 401);
  }
  if (
    decoded.version !== 4 ||
    typeof decoded.workflowId !== "string" ||
    typeof decoded.planHash !== "string" ||
    !/^0x[a-f\d]{64}$/iu.test(decoded.planHash) ||
    typeof decoded.expiresAt !== "number" ||
    decoded.expiresAt <= Date.now()
  ) {
    throw controlled("WORKFLOW_V4_TOKEN_INVALID", "Workflow V4 token payload is invalid or expired.", 401);
  }
  return decoded as { workflowId: string; planHash: `0x${string}`; expiresAt: number };
}

export async function readWorkflowV4StoreReadiness(): Promise<{
  readonly backend: "postgresql" | "sqlite";
  readonly ready: boolean;
  readonly durable: true;
}> {
  await ensureSchema();
  return { backend: connectionString ? "postgresql" : "sqlite", ready: true, durable: true };
}
