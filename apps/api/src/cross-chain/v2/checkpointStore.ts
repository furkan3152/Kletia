import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolConfig } from "pg";
import type { WorkflowV2Step } from "./types.js";

const connectionString =
  process.env.WORKFLOW_V2_DATABASE_URL?.trim() ||
  process.env.STELLAR_EVENT_ARCHIVE_DATABASE_URL?.trim() ||
  "";
const sqlitePath =
  process.env.NODE_ENV === "production" || connectionString
    ? ""
    : process.env.WORKFLOW_V2_SQLITE_PATH?.trim() || ".kletia/workflow-v2.sqlite";

let pool: Pool | null = null;
let postgresInitialized: Promise<void> | null = null;
let sqlite: DatabaseSync | null = null;
let sqliteInitialized = false;

function storeError(message: string, cause?: unknown, statusCode = 503): Error {
  return Object.assign(new Error(message, { cause }), {
    code: "WORKFLOW_V2_CHECKPOINT_STORE_UNAVAILABLE",
    statusCode,
  });
}

function poolConfig(): PoolConfig {
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

function checkpointPool(): Pool {
  if (!connectionString) {
    throw storeError("The durable WorkflowPlanV2 checkpoint store is not configured.");
  }
  pool ??= new Pool(poolConfig());
  return pool;
}

function checkpointSqlite(): DatabaseSync {
  if (!sqlitePath) {
    throw storeError("The durable WorkflowPlanV2 checkpoint store is not configured.");
  }
  if (sqlitePath === ":memory:" || sqlitePath.startsWith("file::memory:")) {
    throw storeError("The WorkflowPlanV2 checkpoint store must use a durable SQLite file.");
  }
  if (!sqlite) {
    const absolutePath = resolve(sqlitePath);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(absolutePath), 0o700);
    sqlite = new DatabaseSync(absolutePath);
    chmodSync(absolutePath, 0o600);
    sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }
  return sqlite;
}

async function ensureSchema(): Promise<void> {
  if (!connectionString && !sqlitePath) {
    throw storeError("The durable WorkflowPlanV2 checkpoint store is not configured.");
  }
  if (connectionString) {
    postgresInitialized ??= checkpointPool()
      .query(`
        CREATE TABLE IF NOT EXISTS kletia_workflow_v2_checkpoints (
          workflow_id UUID NOT NULL,
          step_id VARCHAR(32) NOT NULL,
          network VARCHAR(32) NOT NULL,
          action VARCHAR(48) NOT NULL,
          replay_key TEXT,
          result_json JSONB NOT NULL,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (workflow_id, step_id),
          UNIQUE (replay_key)
        );
      `)
      .then(() => undefined)
      .catch((error) => {
        postgresInitialized = null;
        throw storeError("The WorkflowPlanV2 checkpoint schema is unavailable.", error);
      });
    return postgresInitialized;
  }
  if (!sqliteInitialized) {
    try {
      checkpointSqlite().exec(`
        CREATE TABLE IF NOT EXISTS kletia_workflow_v2_checkpoints (
          workflow_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          network TEXT NOT NULL,
          action TEXT NOT NULL,
          replay_key TEXT,
          result_json TEXT NOT NULL,
          recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (workflow_id, step_id),
          UNIQUE (replay_key)
        );
      `);
      sqliteInitialized = true;
    } catch (error) {
      throw storeError("The WorkflowPlanV2 SQLite checkpoint schema is unavailable.", error);
    }
  }
}

export async function assertWorkflowCheckpointStoreReadiness(): Promise<void> {
  await ensureSchema();
  if (connectionString) {
    await checkpointPool().query("SELECT 1").catch((error) => {
      throw storeError("The WorkflowPlanV2 checkpoint store could not be reached.", error);
    });
    return;
  }
  try {
    checkpointSqlite().prepare("SELECT 1").get();
  } catch (error) {
    throw storeError("The WorkflowPlanV2 SQLite checkpoint store could not be reached.", error);
  }
}

export async function readWorkflowCheckpointStoreReadiness(): Promise<{
  configured: boolean;
  status: "ready" | "unconfigured";
  backend: "postgresql" | "sqlite" | null;
}> {
  if (!connectionString && !sqlitePath) {
    return { configured: false, status: "unconfigured", backend: null };
  }
  await assertWorkflowCheckpointStoreReadiness();
  return {
    configured: true,
    status: "ready",
    backend: connectionString ? "postgresql" : "sqlite",
  };
}

function replayKey(result: NonNullable<WorkflowV2Step["result"]>): string | null {
  return result.kind === "read_result"
    ? null
    : `${result.kind}:${result.reference.toLowerCase()}`;
}

export async function recordWorkflowCheckpoint(input: {
  workflowId: string;
  step: WorkflowV2Step;
  result: NonNullable<WorkflowV2Step["result"]>;
}): Promise<NonNullable<WorkflowV2Step["result"]>> {
  await ensureSchema();
  const key = replayKey(input.result);
  if (!connectionString) {
    try {
      const database = checkpointSqlite();
      const inserted = database
        .prepare(`INSERT INTO kletia_workflow_v2_checkpoints
          (workflow_id, step_id, network, action, replay_key, result_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workflow_id, step_id) DO NOTHING`)
        .run(
          input.workflowId,
          input.step.id,
          input.step.network,
          input.step.action,
          key,
          JSON.stringify(input.result),
        );
      if (inserted.changes === 1) return input.result;
      const row = database
        .prepare(`SELECT replay_key, result_json
                    FROM kletia_workflow_v2_checkpoints
                   WHERE workflow_id = ? AND step_id = ?`)
        .get(input.workflowId, input.step.id) as
        | { replay_key: string | null; result_json: string }
        | undefined;
      if (!row || row.replay_key !== key) {
        throw storeError(
          "This workflow checkpoint was already bound to different evidence.",
          undefined,
          409,
        );
      }
      return JSON.parse(row.result_json) as NonNullable<WorkflowV2Step["result"]>;
    } catch (error) {
      const code = String((error as { code?: unknown }).code || "");
      const sqliteExtendedCode = Number((error as { errcode?: unknown }).errcode);
      if (code.startsWith("SQLITE_CONSTRAINT") || sqliteExtendedCode === 2067) {
        throw storeError(
          "This onchain evidence was already consumed by another workflow checkpoint.",
          error,
          409,
        );
      }
      if ((error as { code?: unknown }).code === "WORKFLOW_V2_CHECKPOINT_STORE_UNAVAILABLE") {
        throw error;
      }
      throw storeError("The WorkflowPlanV2 SQLite checkpoint could not be recorded.", error);
    }
  }
  try {
    const inserted = await checkpointPool().query<{ result_json: WorkflowV2Step["result"] }>(
      `INSERT INTO kletia_workflow_v2_checkpoints
        (workflow_id, step_id, network, action, replay_key, result_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (workflow_id, step_id) DO NOTHING
       RETURNING result_json`,
      [
        input.workflowId,
        input.step.id,
        input.step.network,
        input.step.action,
        key,
        JSON.stringify(input.result),
      ],
    );
    if (inserted.rows[0]?.result_json) return inserted.rows[0].result_json;
    const existing = await checkpointPool().query<{
      replay_key: string | null;
      result_json: NonNullable<WorkflowV2Step["result"]>;
    }>(
      `SELECT replay_key, result_json
         FROM kletia_workflow_v2_checkpoints
        WHERE workflow_id = $1 AND step_id = $2`,
      [input.workflowId, input.step.id],
    );
    const row = existing.rows[0];
    if (!row || row.replay_key !== key) {
      throw storeError(
        "This workflow checkpoint was already bound to different evidence.",
        undefined,
        409,
      );
    }
    return row.result_json;
  } catch (error) {
    if ((error as { code?: unknown }).code === "23505") {
      throw storeError(
        "This onchain evidence was already consumed by another workflow checkpoint.",
        error,
        409,
      );
    }
    if ((error as { code?: unknown }).code === "WORKFLOW_V2_CHECKPOINT_STORE_UNAVAILABLE") {
      throw error;
    }
    throw storeError("The WorkflowPlanV2 checkpoint could not be recorded.", error);
  }
}
