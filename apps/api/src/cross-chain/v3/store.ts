import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolConfig } from "pg";
import { decodeCanonicalBase64Url } from "../../shared/security/canonicalBase64Url.js";
import { computeWorkflowPlanCoreSha256 } from "../v2/compiler.js";
import type { WorkflowPlanV2 } from "../v2/types.js";
import type { WorkflowEvidenceV3, WorkflowPlanV3 } from "./types.js";
import {
  bindLiveRouteHydrationV3,
  deriveRouteBoundWorkflowRootV3,
  workflowPlanV3Hash,
} from "./compiler.js";
import { synchronizeWorkflowExecutionV3 } from "./executionSync.js";

const connectionString =
  process.env.WORKFLOW_V3_DATABASE_URL?.trim() ||
  process.env.WORKFLOW_V2_DATABASE_URL?.trim() ||
  process.env.STELLAR_EVENT_ARCHIVE_DATABASE_URL?.trim() ||
  "";
const sqlitePath =
  process.env.NODE_ENV === "production" || connectionString
    ? ""
    : process.env.WORKFLOW_V3_SQLITE_PATH?.trim() || ".kletia/workflow-v3.sqlite";

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
  if (process.env.NODE_ENV !== "production") return "kletia-development-workflow-v3-secret-only";
  throw controlled("WORKFLOW_V3_SIGNING_UNAVAILABLE", "Workflow V3 signing is not configured.");
}

function config(): PoolConfig {
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
  if (!connectionString) throw controlled("WORKFLOW_V3_STORE_UNAVAILABLE", "Workflow V3 persistence is not configured.");
  pool ??= new Pool(config());
  return pool;
}

function sqliteDatabase(): DatabaseSync {
  if (!sqlitePath || sqlitePath === ":memory:" || sqlitePath.startsWith("file::memory:")) {
    throw controlled("WORKFLOW_V3_STORE_UNAVAILABLE", "Workflow V3 requires durable persistence.");
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
      CREATE TABLE IF NOT EXISTS kletia_workflow_v3_plans (
        workflow_id UUID PRIMARY KEY,
        request_id UUID NOT NULL,
        lane VARCHAR(16) NOT NULL,
        plan_hash VARCHAR(66) NOT NULL,
        plan_json JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS kletia_workflow_v3_evidence (
        workflow_id UUID NOT NULL REFERENCES kletia_workflow_v3_plans(workflow_id),
        step_id VARCHAR(128) NOT NULL,
        evidence_reference TEXT NOT NULL,
        evidence_json JSONB NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workflow_id, step_id),
        UNIQUE (evidence_reference)
      );
    `).then(() => undefined).catch((error) => {
      postgresInitialized = null;
      throw controlled("WORKFLOW_V3_STORE_UNAVAILABLE", "Workflow V3 schema initialization failed.", 503, error);
    });
    return postgresInitialized;
  }
  if (!sqliteInitialized) {
    sqliteDatabase().exec(`
      CREATE TABLE IF NOT EXISTS kletia_workflow_v3_plans (
        workflow_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS kletia_workflow_v3_evidence (
        workflow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        evidence_reference TEXT NOT NULL UNIQUE,
        evidence_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workflow_id, step_id),
        FOREIGN KEY (workflow_id) REFERENCES kletia_workflow_v3_plans(workflow_id)
      );
    `);
    sqliteInitialized = true;
  }
}

function tokenPayload(plan: WorkflowPlanV3): string {
  return Buffer.from(JSON.stringify({
    version: 3,
    workflowId: plan.workflowId,
    planHash: workflowPlanV3Hash(plan),
    expiresAt: plan.expiresAt,
  })).toString("base64url");
}

export function sealWorkflowPlanV3(plan: WorkflowPlanV3): string {
  const payload = tokenPayload(plan);
  const signature = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function openWorkflowTokenV3(tokenInput: unknown): {
  readonly workflowId: string;
  readonly planHash: `0x${string}`;
  readonly expiresAt: number;
} {
  const token = String(tokenInput ?? "");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) {
    throw controlled("WORKFLOW_V3_TOKEN_INVALID", "Workflow V3 token is malformed.", 409);
  }
  const expected = createHmac("sha256", signingSecret()).update(payload).digest();
  let actual: Buffer;
  try {
    actual = decodeCanonicalBase64Url(signature);
  } catch {
    throw controlled("WORKFLOW_V3_TOKEN_INVALID", "Workflow V3 token is malformed.", 409);
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw controlled("WORKFLOW_V3_TOKEN_INVALID", "Workflow V3 token signature is invalid.", 409);
  }
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(decodeCanonicalBase64Url(payload).toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw controlled("WORKFLOW_V3_TOKEN_INVALID", "Workflow V3 token payload is invalid.", 409, error);
  }
  if (
    decoded.version !== 3 ||
    typeof decoded.workflowId !== "string" ||
    typeof decoded.planHash !== "string" ||
    !/^0x[a-f\d]{64}$/iu.test(decoded.planHash) ||
    typeof decoded.expiresAt !== "number"
  ) {
    throw controlled("WORKFLOW_V3_TOKEN_INVALID", "Workflow V3 token payload is invalid.", 409);
  }
  if (decoded.expiresAt <= Date.now()) {
    throw controlled("WORKFLOW_V3_EXPIRED", "Workflow V3 authorization has expired.", 409);
  }
  return decoded as {
    workflowId: string;
    planHash: `0x${string}`;
    expiresAt: number;
  };
}

function verifiedStoredPlan(input: {
  readonly requestedWorkflowId: string;
  readonly plan: WorkflowPlanV3;
  readonly storedPlanHash: string;
  readonly storedExpiresAt: string | Date;
}): WorkflowPlanV3 {
  const { plan } = input;
  if (
    plan?.version !== 3 ||
    plan.schemaVersion !== "kletia_workflow_plan_v3" ||
    plan.workflowId !== input.requestedWorkflowId ||
    plan.expiresAt !== new Date(input.storedExpiresAt).getTime() ||
    !/^0x[a-f\d]{64}$/iu.test(input.storedPlanHash)
  ) {
    throw controlled(
      "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
      "Stored Workflow V3 identity or expiry did not match its database envelope.",
      503,
    );
  }
  const computed = workflowPlanV3Hash(plan);
  const expected = Buffer.from(input.storedPlanHash.toLowerCase());
  const actual = Buffer.from(computed.toLowerCase());
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw controlled(
      "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
      "Stored Workflow V3 content did not match its sealed plan hash.",
      503,
    );
  }
  return plan;
}

export async function saveWorkflowPlanV3(plan: WorkflowPlanV3): Promise<void> {
  await ensureSchema();
  const planHash = workflowPlanV3Hash(plan);
  if (!connectionString) {
    sqliteDatabase().prepare(`INSERT INTO kletia_workflow_v3_plans
      (workflow_id, request_id, lane, plan_hash, plan_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(plan.workflowId, plan.requestId, plan.lane, planHash, JSON.stringify(plan), new Date(plan.expiresAt).toISOString());
    return;
  }
  await databasePool().query(
    `INSERT INTO kletia_workflow_v3_plans
      (workflow_id, request_id, lane, plan_hash, plan_json, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [plan.workflowId, plan.requestId, plan.lane, planHash, JSON.stringify(plan), new Date(plan.expiresAt)],
  );
}

export async function readWorkflowPlanV3(workflowId: string): Promise<WorkflowPlanV3> {
  await ensureSchema();
  let row: { plan: WorkflowPlanV3; planHash: string; expiresAt: string | Date } | null = null;
  if (!connectionString) {
    const stored = sqliteDatabase().prepare(
      "SELECT plan_json, plan_hash, expires_at FROM kletia_workflow_v3_plans WHERE workflow_id = ?",
    ).get(workflowId) as { plan_json?: string; plan_hash?: string; expires_at?: string } | undefined;
    row = stored?.plan_json && stored.plan_hash && stored.expires_at
      ? {
          plan: JSON.parse(stored.plan_json) as WorkflowPlanV3,
          planHash: stored.plan_hash,
          expiresAt: stored.expires_at,
        }
      : null;
  } else {
    const result = await databasePool().query<{
      plan_json: WorkflowPlanV3;
      plan_hash: string;
      expires_at: Date;
    }>(
      "SELECT plan_json, plan_hash, expires_at FROM kletia_workflow_v3_plans WHERE workflow_id = $1",
      [workflowId],
    );
    const stored = result.rows[0];
    row = stored
      ? { plan: stored.plan_json, planHash: stored.plan_hash, expiresAt: stored.expires_at }
      : null;
  }
  if (!row) throw controlled("WORKFLOW_V3_NOT_FOUND", "Workflow V3 was not found.", 404);
  return verifiedStoredPlan({
    requestedWorkflowId: workflowId,
    plan: row.plan,
    storedPlanHash: row.planHash,
    storedExpiresAt: row.expiresAt,
  });
}

export interface SolverOpportunityV3 {
  readonly schemaVersion: "kletia_solver_opportunity_v1";
  readonly workflowId: string;
  readonly expiresAt: number;
  readonly auctionRoot: `0x${string}`;
  readonly constraintsHash: `0x${string}`;
  readonly contracts: {
    readonly bondVault: string;
    readonly routeAuction: string;
  };
  readonly minimumBondAtomic: string;
  readonly routes: readonly {
    readonly id: string;
    readonly routeHash: `0x${string}`;
    readonly quoteEvidenceHash: `0x${string}`;
    readonly chains: readonly string[];
    readonly protocols: readonly string[];
  }[];
}

/**
 * Returns the minimum public information a separate Testnet solver needs to
 * discover an already-hydrated auction. Private amount bindings, wallets,
 * prompts, policy witnesses and executor calldata never cross this boundary.
 * The solver must still read and validate the exact auction terms onchain.
 */
export async function listSolverOpportunitiesV3(): Promise<readonly SolverOpportunityV3[]> {
  await ensureSchema();
  const nowIso = new Date().toISOString();
  let rows: readonly {
    readonly workflowId: string;
    readonly plan: WorkflowPlanV3;
    readonly planHash: string;
    readonly expiresAt: string | Date;
  }[];
  if (!connectionString) {
    rows = (sqliteDatabase().prepare(
      `SELECT workflow_id, plan_json, plan_hash, expires_at
         FROM kletia_workflow_v3_plans
        WHERE lane = 'testnet' AND expires_at > ?
        ORDER BY created_at ASC
        LIMIT 64`,
    ).all(nowIso) as unknown as readonly {
      workflow_id: string;
      plan_json: string;
      plan_hash: string;
      expires_at: string;
    }[]).map((row) => ({
      workflowId: row.workflow_id,
      plan: JSON.parse(row.plan_json) as WorkflowPlanV3,
      planHash: row.plan_hash,
      expiresAt: row.expires_at,
    }));
  } else {
    const result = await databasePool().query<{
      workflow_id: string;
      plan_json: WorkflowPlanV3;
      plan_hash: string;
      expires_at: Date;
    }>(
      `SELECT workflow_id, plan_json, plan_hash, expires_at
         FROM kletia_workflow_v3_plans
        WHERE lane = 'testnet' AND expires_at > NOW()
        ORDER BY created_at ASC
        LIMIT 64`,
    );
    rows = result.rows.map((row) => ({
      workflowId: row.workflow_id,
      plan: row.plan_json,
      planHash: row.plan_hash,
      expiresAt: row.expires_at,
    }));
  }

  const opportunities: SolverOpportunityV3[] = [];
  for (const row of rows) {
    const plan = verifiedStoredPlan({
      requestedWorkflowId: row.workflowId,
      plan: row.plan,
      storedPlanHash: row.planHash,
      storedExpiresAt: row.expiresAt,
    });
    const market = plan.coordinationMarket;
    if (
      !market.required ||
      market.mode !== "stellar_commit_reveal_auction" ||
      market.network !== "stellar_testnet" ||
      (market.status !== "auction_open_required" && market.status !== "awaiting_bids") ||
      !market.contracts.bondVault ||
      !market.contracts.routeAuction ||
      !market.auctionPolicy.minimumBondAtomic ||
      !/^[1-9]\d*$/u.test(market.auctionPolicy.minimumBondAtomic)
    ) {
      continue;
    }
    const routes = plan.routes
      .filter((route) =>
        route.available &&
        route.hydration?.status === "live_quote_bound" &&
        route.metrics.amountDependentCostsComplete &&
        route.metrics.estimatedOutputAtomic !== null &&
        route.quoteExpiresAt > Date.now() &&
        route.steps.every((step) => step.executionReadiness === "ready"),
      )
      .map((route) => ({
        id: route.id,
        routeHash: route.solverRouteHash,
        quoteEvidenceHash: route.hydration!.quoteCommitment,
        chains: route.chains,
        protocols: route.protocols,
      }));
    if (routes.length === 0) continue;
    opportunities.push({
      schemaVersion: "kletia_solver_opportunity_v1",
      workflowId: plan.workflowId,
      expiresAt: plan.expiresAt,
      auctionRoot: market.auctionRoot,
      constraintsHash: market.constraintsHash,
      contracts: {
        bondVault: market.contracts.bondVault,
        routeAuction: market.contracts.routeAuction,
      },
      minimumBondAtomic: market.auctionPolicy.minimumBondAtomic,
      routes,
    });
  }
  return opportunities;
}

export async function replaceWorkflowPlanV3(plan: WorkflowPlanV3): Promise<void> {
  await ensureSchema();
  const planHash = workflowPlanV3Hash(plan);
  if (!connectionString) {
    const result = sqliteDatabase().prepare(`UPDATE kletia_workflow_v3_plans
      SET plan_hash = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE workflow_id = ?`)
      .run(planHash, JSON.stringify(plan), plan.workflowId);
    if (result.changes !== 1) throw controlled("WORKFLOW_V3_NOT_FOUND", "Workflow V3 was not found.", 404);
    return;
  }
  const result = await databasePool().query(
    `UPDATE kletia_workflow_v3_plans
        SET plan_hash = $1, plan_json = $2::jsonb, updated_at = NOW()
      WHERE workflow_id = $3`,
    [planHash, JSON.stringify(plan), plan.workflowId],
  );
  if (result.rowCount !== 1) throw controlled("WORKFLOW_V3_NOT_FOUND", "Workflow V3 was not found.", 404);
}

export async function recordWorkflowEvidenceV3(
  workflowId: string,
  evidence: WorkflowEvidenceV3,
): Promise<void> {
  await ensureSchema();
  const replayKey = `${evidence.kind}:${evidence.chain.caip2}:${evidence.reference.toLowerCase()}`;
  try {
    if (!connectionString) {
      sqliteDatabase().prepare(`INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
        VALUES (?, ?, ?, ?)`)
        .run(workflowId, evidence.stepId, replayKey, JSON.stringify(evidence));
      return;
    }
    await databasePool().query(
      `INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [workflowId, evidence.stepId, replayKey, JSON.stringify(evidence)],
    );
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "23505" || code.startsWith("SQLITE_CONSTRAINT")) {
      throw controlled(
        "WORKFLOW_V3_EVIDENCE_REPLAY",
        "This evidence was already consumed or this step was already bound.",
        409,
        error,
      );
    }
    throw error;
  }
}

function assertTransitionEnvelope(
  previous: WorkflowPlanV3,
  next: WorkflowPlanV3,
  evidence: WorkflowEvidenceV3,
): void {
  if (
    next.workflowId !== previous.workflowId ||
    next.requestId !== previous.requestId ||
    next.lane !== previous.lane ||
    next.createdAt !== previous.createdAt ||
    next.expiresAt !== previous.expiresAt ||
    evidence.stepId !== previous.currentStepId
  ) {
    throw controlled(
      "WORKFLOW_V3_TRANSITION_INVALID",
      "The Workflow V3 transition changed a sealed identity, lane, expiry or current-step binding.",
      409,
    );
  }
}

function mapAtomicAdvanceError(error: unknown): never {
  const code = String((error as { code?: unknown }).code ?? "");
  if (code === "23505" || code.startsWith("SQLITE_CONSTRAINT")) {
    throw controlled(
      "WORKFLOW_V3_EVIDENCE_REPLAY",
      "This evidence was already consumed or this step was already bound.",
      409,
      error,
    );
  }
  throw error;
}

export async function commitWorkflowRouteHydrationV3(input: {
  readonly expectedPlanHash: `0x${string}`;
  readonly previousPlan: WorkflowPlanV3;
  readonly nextPlan: WorkflowPlanV3;
  readonly routeId: string;
  readonly evidence: WorkflowEvidenceV3;
}): Promise<void> {
  await ensureSchema();
  const nextRoute = input.nextPlan.routes.find((route) => route.id === input.routeId);
  if (
    !nextRoute?.hydration ||
    input.evidence.kind !== "route_quote" ||
    !input.evidence.stepId.startsWith(`route-hydration:${input.routeId}:`) ||
    input.evidence.reference.toLowerCase() !== nextRoute.hydration.quoteCommitment.toLowerCase()
  ) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_HYDRATION_TRANSITION_INVALID",
      "The route hydration transition lacked an exact quote, commitment and evidence binding.",
      409,
    );
  }
  const expectedNext = bindLiveRouteHydrationV3({
    plan: input.previousPlan,
    routeId: input.routeId,
    hydration: nextRoute.hydration,
    metrics: nextRoute.metrics,
  });
  if (
    workflowPlanV3Hash(input.previousPlan) !== input.expectedPlanHash ||
    workflowPlanV3Hash(expectedNext) !== workflowPlanV3Hash(input.nextPlan)
  ) {
    throw controlled(
      "WORKFLOW_V3_ROUTE_HYDRATION_TRANSITION_INVALID",
      "The route quote changed fields outside the reviewed hydration boundary or used a stale token.",
      409,
    );
  }
  const nextHash = workflowPlanV3Hash(input.nextPlan);
  const replayKey = `${input.evidence.kind}:${input.evidence.chain.caip2}:${input.evidence.reference.toLowerCase()}`;

  if (!connectionString) {
    const database = sqliteDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const stored = database.prepare(
        "SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans WHERE workflow_id = ?",
      ).get(input.previousPlan.workflowId) as { plan_json?: string; plan_hash?: string } | undefined;
      if (!stored?.plan_json || stored.plan_hash?.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before route hydration.", 409);
      }
      if (workflowPlanV3Hash(JSON.parse(stored.plan_json) as WorkflowPlanV3) !== input.expectedPlanHash) {
        throw controlled(
          "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
          "The stored workflow content did not match the locked plan hash.",
          503,
        );
      }
      database.prepare(`INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
        VALUES (?, ?, ?, ?)`).run(
          input.nextPlan.workflowId,
          input.evidence.stepId,
          replayKey,
          JSON.stringify(input.evidence),
        );
      const updated = database.prepare(`UPDATE kletia_workflow_v3_plans
        SET plan_hash = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workflow_id = ? AND plan_hash = ?`).run(
          nextHash,
          JSON.stringify(input.nextPlan),
          input.nextPlan.workflowId,
          input.expectedPlanHash,
        );
      if (updated.changes !== 1) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during route hydration.", 409);
      }
      database.exec("COMMIT");
      return;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* rollback is best effort */ }
      mapAtomicAdvanceError(error);
    }
  }

  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ plan_json: WorkflowPlanV3; plan_hash: string }>(
      `SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans
       WHERE workflow_id = $1 FOR UPDATE`,
      [input.previousPlan.workflowId],
    );
    const stored = locked.rows[0];
    if (!stored || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before route hydration.", 409);
    }
    if (workflowPlanV3Hash(stored.plan_json) !== input.expectedPlanHash) {
      throw controlled(
        "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
        "The stored workflow content did not match the locked plan hash.",
        503,
      );
    }
    await client.query(
      `INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [input.nextPlan.workflowId, input.evidence.stepId, replayKey, JSON.stringify(input.evidence)],
    );
    const updated = await client.query(
      `UPDATE kletia_workflow_v3_plans
          SET plan_hash = $1, plan_json = $2::jsonb, updated_at = NOW()
        WHERE workflow_id = $3 AND plan_hash = $4`,
      [nextHash, JSON.stringify(input.nextPlan), input.nextPlan.workflowId, input.expectedPlanHash],
    );
    if (updated.rowCount !== 1) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during route hydration.", 409);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* rollback is best effort */ }
    mapAtomicAdvanceError(error);
  } finally {
    client.release();
  }
}

/**
 * Commits one verified live-read result and its state transition atomically.
 * The expected hash is the hash sealed in the caller's current workflow token;
 * concurrent or stale callers cannot both advance the same step.
 */
export async function commitWorkflowAdvanceV3(input: {
  readonly expectedPlanHash: `0x${string}`;
  readonly previousPlan: WorkflowPlanV3;
  readonly nextPlan: WorkflowPlanV3;
  readonly evidence: WorkflowEvidenceV3;
}): Promise<void> {
  await ensureSchema();
  assertTransitionEnvelope(input.previousPlan, input.nextPlan, input.evidence);
  if (workflowPlanV3Hash(input.previousPlan) !== input.expectedPlanHash) {
    throw controlled(
      "WORKFLOW_V3_TOKEN_STALE",
      "The expected workflow hash did not match the current plan content.",
      409,
    );
  }
  const nextHash = workflowPlanV3Hash(input.nextPlan);
  const replayKey = `${input.evidence.kind}:${input.evidence.chain.caip2}:${input.evidence.reference.toLowerCase()}`;

  if (!connectionString) {
    const database = sqliteDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const stored = database.prepare(
        "SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans WHERE workflow_id = ?",
      ).get(input.previousPlan.workflowId) as { plan_json?: string; plan_hash?: string } | undefined;
      if (!stored?.plan_json || stored.plan_hash?.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
        throw controlled(
          "WORKFLOW_V3_TOKEN_STALE",
          "The workflow changed before this result could be committed.",
          409,
        );
      }
      const storedPlan = JSON.parse(stored.plan_json) as WorkflowPlanV3;
      if (workflowPlanV3Hash(storedPlan) !== input.expectedPlanHash) {
        throw controlled(
          "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
          "The stored workflow content did not match the locked plan hash.",
          503,
        );
      }
      database.prepare(`INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
        VALUES (?, ?, ?, ?)`)
        .run(input.nextPlan.workflowId, input.evidence.stepId, replayKey, JSON.stringify(input.evidence));
      const updated = database.prepare(`UPDATE kletia_workflow_v3_plans
        SET plan_hash = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workflow_id = ? AND plan_hash = ?`)
        .run(
          nextHash,
          JSON.stringify(input.nextPlan),
          input.nextPlan.workflowId,
          input.expectedPlanHash,
        );
      if (updated.changes !== 1) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during advancement.", 409);
      }
      database.exec("COMMIT");
      return;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* rollback is best effort */ }
      mapAtomicAdvanceError(error);
    }
  }

  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ plan_json: WorkflowPlanV3; plan_hash: string }>(
      `SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans
       WHERE workflow_id = $1 FOR UPDATE`,
      [input.previousPlan.workflowId],
    );
    const stored = locked.rows[0];
    if (!stored || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
      throw controlled(
        "WORKFLOW_V3_TOKEN_STALE",
        "The workflow changed before this result could be committed.",
        409,
      );
    }
    if (workflowPlanV3Hash(stored.plan_json) !== input.expectedPlanHash) {
      throw controlled(
        "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
        "The stored workflow content did not match the locked plan hash.",
        503,
      );
    }
    await client.query(
      `INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [input.nextPlan.workflowId, input.evidence.stepId, replayKey, JSON.stringify(input.evidence)],
    );
    const updated = await client.query(
      `UPDATE kletia_workflow_v3_plans
          SET plan_hash = $1, plan_json = $2::jsonb, updated_at = NOW()
        WHERE workflow_id = $3 AND plan_hash = $4`,
      [nextHash, JSON.stringify(input.nextPlan), input.nextPlan.workflowId, input.expectedPlanHash],
    );
    if (updated.rowCount !== 1) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during advancement.", 409);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* rollback is best effort */ }
    mapAtomicAdvanceError(error);
  } finally {
    client.release();
  }
}

/**
 * Atomically replaces the device-proof boundary after a live pinned-registry
 * verification. Proof bytes are deliberately absent from both plans and from
 * the database; only their hash and public-input binding are retained.
 */
export async function commitWorkflowPolicyProofBindingV3(input: {
  readonly expectedPlanHash: `0x${string}`;
  readonly previousPlan: WorkflowPlanV3;
  readonly nextPlan: WorkflowPlanV3;
}): Promise<void> {
  await ensureSchema();
  const { previousPlan: previous, nextPlan: next } = input;
  const selectedRoute = next.selectedRouteId
    ? previous.routes.find((route) => route.id === next.selectedRouteId)
    : undefined;
  const expectedRoutes = selectedRoute
    ? previous.routes.map((route) =>
        route.id === selectedRoute.id
          ? {
              ...route,
              steps: route.steps.map((step) =>
                step.operation === "control_plane_commit"
                  ? {
                      ...step,
                      executionReadiness: "ready" as const,
                      status: step.id.startsWith(`${selectedRoute.id}-`)
                        ? "awaiting_signature" as const
                        : step.status,
                      unavailableReason: step.id.startsWith(`${selectedRoute.id}-`)
                        ? undefined
                        : step.unavailableReason,
                    }
                  : step,
              ),
            }
          : route,
      )
    : [];
  const expectedCurrentStepId = expectedRoutes
    .find((route) => route.id === next.selectedRouteId)
    ?.steps.find((step) => step.status === "awaiting_signature" || step.status === "ready")
    ?.id ?? null;
  const expectedCommitment = {
    ...previous.controlPlane.commitment,
    status: "awaiting_signature" as const,
  };
  if (
    previous.workflowId !== next.workflowId ||
    previous.requestId !== next.requestId ||
    previous.lane !== next.lane ||
    previous.createdAt !== next.createdAt ||
    previous.expiresAt !== next.expiresAt ||
    JSON.stringify(previous.intent) !== JSON.stringify(next.intent) ||
    JSON.stringify(previous.walletBindings) !== JSON.stringify(next.walletBindings) ||
    JSON.stringify(previous.privacy) !== JSON.stringify(next.privacy) ||
    JSON.stringify(previous.executionPolicy) !== JSON.stringify(next.executionPolicy) ||
    JSON.stringify(previous.coordinationMarket) !== JSON.stringify(next.coordinationMarket) ||
    JSON.stringify(previous.compatibility) !== JSON.stringify(next.compatibility) ||
    previous.controlPlane.proofBinding.status !== "device_proof_required" ||
    previous.controlPlane.commitment.status !== "device_proof_required" ||
    previous.controlPlane.receiptRegistry.status !== "control_plane_required" ||
    next.controlPlane.proofBinding.status !== "bound" ||
    JSON.stringify(next.controlPlane.commitment) !== JSON.stringify(expectedCommitment) ||
    JSON.stringify(next.controlPlane.receiptRegistry) !==
      JSON.stringify(previous.controlPlane.receiptRegistry) ||
    next.controlPlane.required !== previous.controlPlane.required ||
    next.controlPlane.mode !== previous.controlPlane.mode ||
    next.controlPlane.network !== previous.controlPlane.network ||
    next.controlPlane.status !== previous.controlPlane.status ||
    next.controlPlane.planningPolicyCommitment !==
      previous.controlPlane.planningPolicyCommitment ||
    next.controlPlane.privacyBudgetCommitment !==
      previous.controlPlane.privacyBudgetCommitment ||
    next.controlPlane.externalExecutionTruthProven !== false ||
    !next.controlPlane.proofBinding.proofSha256 ||
    !next.controlPlane.proofBinding.publicInputsHash ||
    !selectedRoute ||
    JSON.stringify(next.routes) !== JSON.stringify(expectedRoutes) ||
    next.currentStepId !== expectedCurrentStepId ||
    next.controlPlane.workflowRoot !==
      deriveRouteBoundWorkflowRootV3(next, selectedRoute.id)
  ) {
    throw controlled(
      "WORKFLOW_V3_POLICY_BINDING_TRANSITION_INVALID",
      "The policy-proof transition changed immutable workflow fields or lacked a verified route binding.",
      409,
    );
  }
  if (workflowPlanV3Hash(previous) !== input.expectedPlanHash) {
    throw controlled("WORKFLOW_V3_TOKEN_STALE", "The policy-proof token is stale.", 409);
  }
  const nextHash = workflowPlanV3Hash(next);

  if (!connectionString) {
    const database = sqliteDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const stored = database.prepare(
        "SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans WHERE workflow_id = ?",
      ).get(previous.workflowId) as { plan_json?: string; plan_hash?: string } | undefined;
      if (!stored?.plan_json || stored.plan_hash?.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before proof binding.", 409);
      }
      if (workflowPlanV3Hash(JSON.parse(stored.plan_json) as WorkflowPlanV3) !== input.expectedPlanHash) {
        throw controlled(
          "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
          "The stored workflow content did not match the locked plan hash.",
          503,
        );
      }
      const updated = database.prepare(`UPDATE kletia_workflow_v3_plans
        SET plan_hash = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workflow_id = ? AND plan_hash = ?`)
        .run(nextHash, JSON.stringify(next), next.workflowId, input.expectedPlanHash);
      if (updated.changes !== 1) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during proof binding.", 409);
      }
      database.exec("COMMIT");
      return;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* rollback is best effort */ }
      throw error;
    }
  }

  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ plan_json: WorkflowPlanV3; plan_hash: string }>(
      `SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans
       WHERE workflow_id = $1 FOR UPDATE`,
      [previous.workflowId],
    );
    const stored = locked.rows[0];
    if (!stored || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before proof binding.", 409);
    }
    if (workflowPlanV3Hash(stored.plan_json) !== input.expectedPlanHash) {
      throw controlled(
        "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
        "The stored workflow content did not match the locked plan hash.",
        503,
      );
    }
    const updated = await client.query(
      `UPDATE kletia_workflow_v3_plans
          SET plan_hash = $1, plan_json = $2::jsonb, updated_at = NOW()
        WHERE workflow_id = $3 AND plan_hash = $4`,
      [nextHash, JSON.stringify(next), next.workflowId, input.expectedPlanHash],
    );
    if (updated.rowCount !== 1) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during proof binding.", 409);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* rollback is best effort */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomically records the hash-only handoff to the reviewed WorkflowPlanV2
 * financial executor. The V2 bearer token is returned to the browser and is
 * deliberately never copied into V3 durable state.
 */
export async function commitWorkflowExecutionHandoffV3(input: {
  readonly expectedPlanHash: `0x${string}`;
  readonly previousPlan: WorkflowPlanV3;
  readonly nextPlan: WorkflowPlanV3;
  readonly executorPlan: WorkflowPlanV2;
}): Promise<void> {
  await ensureSchema();
  const { previousPlan: previous, nextPlan: next } = input;
  const { compatibility: _previousCompatibility, ...previousCore } = previous;
  const { compatibility, ...nextCore } = next;
  const route = previous.routes.find((candidate) => candidate.id === previous.selectedRouteId);
  const current = route?.steps.find((candidate) => candidate.id === previous.currentStepId);
  const amountCommitment = previous.intent.privateBindings.find(
    (binding) => binding.field === "amount",
  )?.commitment;
  const recipientCommitment = previous.intent.privateBindings.find(
    (binding) => binding.field === "recipient",
  )?.commitment;
  if (
    workflowPlanV3Hash(previous) !== input.expectedPlanHash ||
    previous.compatibility !== undefined ||
    JSON.stringify(previousCore) !== JSON.stringify(nextCore) ||
    previous.controlPlane.proofBinding.status !== "bound" ||
    previous.controlPlane.commitment.status !== "confirmed" ||
    previous.controlPlane.receiptRegistry.status !== "confirmed" ||
    previous.controlPlane.externalExecutionTruthProven !== false ||
    !route ||
    route.id !== "arc-arbitrum-direct-cctp" ||
    !route.hydration ||
    !current ||
    current.operation !== "approve" ||
    current.chain.key !== "arc_testnet" ||
    current.status !== "awaiting_signature" ||
    compatibility?.engine !== "workflow_v2" ||
    compatibility.routeId !== route.id ||
    compatibility.policyRouteHash !== route.solverRouteHash ||
    compatibility.parentPlanHash !== input.expectedPlanHash ||
    compatibility.amountCommitment !== amountCommitment ||
    compatibility.recipientCommitment !== recipientCommitment ||
    compatibility.latestPlanCoreSha256 !== compatibility.planCoreSha256 ||
    compatibility.confirmedCheckpointCount !== 0 ||
    compatibility.totalCheckpointCount !== input.executorPlan.steps.length ||
    compatibility.currentAction !== input.executorPlan.steps[0]?.action ||
    compatibility.terminalReceiptSha256 !== null ||
    !Number.isFinite(Date.parse(compatibility.updatedAt)) ||
    compatibility.status !== "bound" ||
    compatibility.executionQuoteExpiresAt <= Date.now() ||
    !Number.isFinite(Date.parse(compatibility.executionEvidenceObservedAt)) ||
    input.executorPlan.workflowId !== compatibility.workflowId ||
    input.executorPlan.selectedRoute !== "direct_cctp" ||
    input.executorPlan.authorizationBoundary.planCoreSha256 !==
      compatibility.planCoreSha256 ||
    computeWorkflowPlanCoreSha256(input.executorPlan) !==
      compatibility.planCoreSha256 ||
    input.executorPlan.privacy.amountCommitment !== amountCommitment ||
    input.executorPlan.privacy.recipientCommitment !== recipientCommitment ||
    input.executorPlan.parentWorkflowV3?.workflowId !== previous.workflowId ||
    input.executorPlan.parentWorkflowV3?.workflowRoot !==
      previous.controlPlane.workflowRoot ||
    input.executorPlan.parentWorkflowV3?.planHashAtHandoff !==
      input.expectedPlanHash ||
    input.executorPlan.parentWorkflowV3?.expiresAt !== previous.expiresAt ||
    input.executorPlan.parentWorkflowV3?.controlPlaneTransactionHash !==
      previous.controlPlane.commitment.transactionHash ||
    input.executorPlan.parentWorkflowV3?.receiptRegistryTransactionHash !==
      previous.controlPlane.receiptRegistry.transactionHash ||
    input.executorPlan.parentWorkflowV3?.externalExecutionTruthProvenByStellar !== false ||
    input.executorPlan.routeCandidates.find(
      (candidate) => candidate.kind === input.executorPlan.selectedRoute,
    )?.liveEvidence.quoteExpiresAt !== compatibility.executionQuoteExpiresAt ||
    input.executorPlan.routeCandidates.find(
      (candidate) => candidate.kind === input.executorPlan.selectedRoute,
    )?.liveEvidence.observedAt !== compatibility.executionEvidenceObservedAt ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      compatibility.workflowId,
    ) ||
    !/^0x[a-f\d]{64}$/u.test(compatibility.planCoreSha256)
  ) {
    throw controlled(
      "WORKFLOW_V3_EXECUTOR_HANDOFF_TRANSITION_INVALID",
      "The V2 executor handoff changed sealed V3 state or lacked an exact hash binding.",
      409,
    );
  }
  const nextHash = workflowPlanV3Hash(next);
  if (!connectionString) {
    const database = sqliteDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const stored = database.prepare(
        "SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans WHERE workflow_id = ?",
      ).get(previous.workflowId) as { plan_json?: string; plan_hash?: string } | undefined;
      if (!stored?.plan_json || stored.plan_hash?.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before executor handoff.", 409);
      }
      if (workflowPlanV3Hash(JSON.parse(stored.plan_json) as WorkflowPlanV3) !== input.expectedPlanHash) {
        throw controlled(
          "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
          "The stored workflow content did not match the locked plan hash.",
          503,
        );
      }
      const updated = database.prepare(`UPDATE kletia_workflow_v3_plans
        SET plan_hash = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workflow_id = ? AND plan_hash = ?`)
        .run(nextHash, JSON.stringify(next), next.workflowId, input.expectedPlanHash);
      if (updated.changes !== 1) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during executor handoff.", 409);
      }
      database.exec("COMMIT");
      return;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* rollback is best effort */ }
      throw error;
    }
  }
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ plan_json: WorkflowPlanV3; plan_hash: string }>(
      `SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans
       WHERE workflow_id = $1 FOR UPDATE`,
      [previous.workflowId],
    );
    const stored = locked.rows[0];
    if (!stored || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before executor handoff.", 409);
    }
    if (workflowPlanV3Hash(stored.plan_json) !== input.expectedPlanHash) {
      throw controlled(
        "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
        "The stored workflow content did not match the locked plan hash.",
        503,
      );
    }
    const updated = await client.query(
      `UPDATE kletia_workflow_v3_plans
          SET plan_hash = $1, plan_json = $2::jsonb, updated_at = NOW()
        WHERE workflow_id = $3 AND plan_hash = $4`,
      [nextHash, JSON.stringify(next), next.workflowId, input.expectedPlanHash],
    );
    if (updated.rowCount !== 1) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during executor handoff.", 409);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* rollback is best effort */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomically mirrors only server-opened V2 progress into V3. The V2 bearer is
 * used as transition evidence and is never written to the workflow store.
 */
export async function commitWorkflowExecutionProgressV3(input: {
  readonly expectedPlanHash: `0x${string}`;
  readonly previousPlan: WorkflowPlanV3;
  readonly nextPlan: WorkflowPlanV3;
  readonly workflowTokenV2: unknown;
}): Promise<void> {
  await ensureSchema();
  if (workflowPlanV3Hash(input.previousPlan) !== input.expectedPlanHash) {
    throw controlled("WORKFLOW_V3_TOKEN_STALE", "The execution-sync token is stale.", 409);
  }
  const derived = synchronizeWorkflowExecutionV3(
    input.previousPlan,
    input.workflowTokenV2,
  );
  if (workflowPlanV3Hash(derived.plan) !== workflowPlanV3Hash(input.nextPlan)) {
    throw controlled(
      "WORKFLOW_V3_EXECUTION_SYNC_TRANSITION_INVALID",
      "The execution-sync transition was not derived from the exact sealed V2 progress token.",
      409,
    );
  }
  const nextHash = workflowPlanV3Hash(input.nextPlan);
  if (!connectionString) {
    const database = sqliteDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const stored = database.prepare(
        "SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans WHERE workflow_id = ?",
      ).get(input.previousPlan.workflowId) as { plan_json?: string; plan_hash?: string } | undefined;
      if (!stored?.plan_json || stored.plan_hash?.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before execution sync.", 409);
      }
      if (workflowPlanV3Hash(JSON.parse(stored.plan_json) as WorkflowPlanV3) !== input.expectedPlanHash) {
        throw controlled(
          "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
          "The stored workflow content did not match the locked plan hash.",
          503,
        );
      }
      const updated = database.prepare(`UPDATE kletia_workflow_v3_plans
        SET plan_hash = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workflow_id = ? AND plan_hash = ?`)
        .run(nextHash, JSON.stringify(input.nextPlan), input.nextPlan.workflowId, input.expectedPlanHash);
      if (updated.changes !== 1) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during execution sync.", 409);
      }
      database.exec("COMMIT");
      return;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* rollback is best effort */ }
      throw error;
    }
  }
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ plan_json: WorkflowPlanV3; plan_hash: string }>(
      `SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans
       WHERE workflow_id = $1 FOR UPDATE`,
      [input.previousPlan.workflowId],
    );
    const stored = locked.rows[0];
    if (!stored || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before execution sync.", 409);
    }
    if (workflowPlanV3Hash(stored.plan_json) !== input.expectedPlanHash) {
      throw controlled(
        "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
        "The stored workflow content did not match the locked plan hash.",
        503,
      );
    }
    const updated = await client.query(
      `UPDATE kletia_workflow_v3_plans
          SET plan_hash = $1, plan_json = $2::jsonb, updated_at = NOW()
        WHERE workflow_id = $3 AND plan_hash = $4`,
      [nextHash, JSON.stringify(input.nextPlan), input.nextPlan.workflowId, input.expectedPlanHash],
    );
    if (updated.rowCount !== 1) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during execution sync.", 409);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* rollback is best effort */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Atomically binds a live Stellar auction winner and its still-active bond to
 * the sealed workflow. No policy proof or financial step may skip this state
 * transition when competitive coordination is required.
 */
export async function commitWorkflowMarketSelectionV3(input: {
  readonly expectedPlanHash: `0x${string}`;
  readonly previousPlan: WorkflowPlanV3;
  readonly nextPlan: WorkflowPlanV3;
  readonly evidence: WorkflowEvidenceV3;
}): Promise<void> {
  await ensureSchema();
  const { previousPlan: previous, nextPlan: next } = input;
  const winner = next.coordinationMarket.winner;
  const selectedRoute = winner
    ? next.routes.find((route) => route.id === winner.routeId)
    : null;
  const expectedNext: WorkflowPlanV3 = {
    ...previous,
    selectedRouteId: winner?.routeId ?? null,
    currentStepId: null,
    coordinationMarket: {
      ...previous.coordinationMarket,
      status: "winner_selected",
      winner,
    },
  };
  if (
    previous.workflowId !== next.workflowId ||
    previous.coordinationMarket.required !== true ||
    (previous.coordinationMarket.status !== "auction_open_required" &&
      previous.coordinationMarket.status !== "awaiting_bids") ||
    next.coordinationMarket.status !== "winner_selected" ||
    !winner ||
    !selectedRoute ||
    !selectedRoute.available ||
    selectedRoute.quoteExpiresAt <= Date.now() ||
    selectedRoute.steps.some((step) => step.executionReadiness !== "ready") ||
    selectedRoute.solverRouteHash.toLowerCase() !== winner.routeHash.toLowerCase() ||
    input.evidence.stepId !== "solver-market-selection" ||
    input.evidence.kind !== "auction_result" ||
    input.evidence.level !== "chain_native_verified" ||
    workflowPlanV3Hash(expectedNext) !== workflowPlanV3Hash(next)
  ) {
    throw controlled(
      "WORKFLOW_V3_MARKET_SELECTION_TRANSITION_INVALID",
      "The solver-market transition changed sealed fields or lacked an exact auction, route and bond binding.",
      409,
    );
  }
  if (workflowPlanV3Hash(previous) !== input.expectedPlanHash) {
    throw controlled("WORKFLOW_V3_TOKEN_STALE", "The solver-market workflow token is stale.", 409);
  }
  const nextHash = workflowPlanV3Hash(next);
  const replayKey = `${input.evidence.kind}:${input.evidence.chain.caip2}:${input.evidence.reference.toLowerCase()}`;

  if (!connectionString) {
    const database = sqliteDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const stored = database.prepare(
        "SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans WHERE workflow_id = ?",
      ).get(previous.workflowId) as { plan_json?: string; plan_hash?: string } | undefined;
      if (!stored?.plan_json || stored.plan_hash?.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before auction selection.", 409);
      }
      if (workflowPlanV3Hash(JSON.parse(stored.plan_json) as WorkflowPlanV3) !== input.expectedPlanHash) {
        throw controlled(
          "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
          "The stored workflow content did not match the locked plan hash.",
          503,
        );
      }
      database.prepare(`INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
        VALUES (?, ?, ?, ?)`).run(
          next.workflowId,
          input.evidence.stepId,
          replayKey,
          JSON.stringify(input.evidence),
        );
      const updated = database.prepare(`UPDATE kletia_workflow_v3_plans
        SET plan_hash = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE workflow_id = ? AND plan_hash = ?`).run(
          nextHash,
          JSON.stringify(next),
          next.workflowId,
          input.expectedPlanHash,
        );
      if (updated.changes !== 1) {
        throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during auction selection.", 409);
      }
      database.exec("COMMIT");
      return;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* rollback is best effort */ }
      mapAtomicAdvanceError(error);
    }
  }

  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ plan_json: WorkflowPlanV3; plan_hash: string }>(
      `SELECT plan_json, plan_hash FROM kletia_workflow_v3_plans
       WHERE workflow_id = $1 FOR UPDATE`,
      [previous.workflowId],
    );
    const stored = locked.rows[0];
    if (!stored || stored.plan_hash.toLowerCase() !== input.expectedPlanHash.toLowerCase()) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed before auction selection.", 409);
    }
    if (workflowPlanV3Hash(stored.plan_json) !== input.expectedPlanHash) {
      throw controlled(
        "WORKFLOW_V3_STORE_INTEGRITY_FAILED",
        "The stored workflow content did not match the locked plan hash.",
        503,
      );
    }
    await client.query(
      `INSERT INTO kletia_workflow_v3_evidence
        (workflow_id, step_id, evidence_reference, evidence_json)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [next.workflowId, input.evidence.stepId, replayKey, JSON.stringify(input.evidence)],
    );
    const updated = await client.query(
      `UPDATE kletia_workflow_v3_plans
          SET plan_hash = $1, plan_json = $2::jsonb, updated_at = NOW()
        WHERE workflow_id = $3 AND plan_hash = $4`,
      [nextHash, JSON.stringify(next), next.workflowId, input.expectedPlanHash],
    );
    if (updated.rowCount !== 1) {
      throw controlled("WORKFLOW_V3_TOKEN_STALE", "The workflow changed during auction selection.", 409);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* rollback is best effort */ }
    mapAtomicAdvanceError(error);
  } finally {
    client.release();
  }
}

export async function readWorkflowV3StoreReadiness(): Promise<{
  readonly status: "ready" | "unavailable";
  readonly backend: "postgresql" | "sqlite" | null;
}> {
  try {
    await ensureSchema();
    if (connectionString) await databasePool().query("SELECT 1");
    else sqliteDatabase().prepare("SELECT 1").get();
    return { status: "ready", backend: connectionString ? "postgresql" : "sqlite" };
  } catch {
    return { status: "unavailable", backend: null };
  }
}
