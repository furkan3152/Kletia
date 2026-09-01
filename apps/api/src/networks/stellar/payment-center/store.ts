import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { decodeCanonicalBase64Url } from "../../../shared/security/canonicalBase64Url.js";
import type {
  PaymentCenterSessionRecord,
  PaymentCenterSessionState,
} from "./types.js";

const connectionString =
  process.env.STELLAR_PAYMENT_CENTER_DATABASE_URL?.trim() ||
  process.env.WORKFLOW_V2_DATABASE_URL?.trim() ||
  "";
const sqlitePath =
  process.env.NODE_ENV === "production" || connectionString
    ? ""
    : process.env.STELLAR_PAYMENT_CENTER_SQLITE_PATH?.trim() ||
      ".kletia/payment-center.sqlite";

let pool: Pool | null = null;
let postgresInitialized: Promise<void> | null = null;
let sqlite: DatabaseSync | null = null;
let sqliteInitialized = false;

function controlled(
  code: string,
  message: string,
  statusCode = 503,
  cause?: unknown,
): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function configuredSecret(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length >= 32 ? value : null;
}

function signingSecret(): string {
  const configured =
    configuredSecret("PAYMENT_CENTER_SIGNING_SECRET") ||
    configuredSecret("WORKFLOW_SIGNING_SECRET");
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") {
    return "kletia-development-payment-center-signing-secret";
  }
  throw controlled(
    "PAYMENT_CENTER_SIGNING_UNAVAILABLE",
    "Payment Center session signing is not configured.",
  );
}

function encryptionSecret(): string {
  const configured =
    configuredSecret("STELLAR_PAYMENT_CENTER_ENCRYPTION_KEY") ||
    configuredSecret("WORKFLOW_SIGNING_SECRET");
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") {
    return "kletia-development-payment-center-encryption-key";
  }
  throw controlled(
    "PAYMENT_CENTER_ENCRYPTION_UNAVAILABLE",
    "Payment Center credential encryption is not configured.",
  );
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
  if (!connectionString) {
    throw controlled(
      "PAYMENT_CENTER_STORE_UNAVAILABLE",
      "Payment Center persistence is not configured.",
    );
  }
  pool ??= new Pool(postgresConfig());
  return pool;
}

function sqliteDatabase(): DatabaseSync {
  if (
    !sqlitePath ||
    sqlitePath === ":memory:" ||
    sqlitePath.startsWith("file::memory:")
  ) {
    throw controlled(
      "PAYMENT_CENTER_STORE_UNAVAILABLE",
      "Payment Center requires durable persistence.",
    );
  }
  if (!sqlite) {
    const absolute = resolve(sqlitePath);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    sqlite = new DatabaseSync(absolute);
    chmodSync(absolute, 0o600);
    sqlite.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
  }
  return sqlite;
}

async function ensureSchema(): Promise<void> {
  if (connectionString) {
    postgresInitialized ??= databasePool()
      .query(`
        CREATE TABLE IF NOT EXISTS kletia_payment_center_sessions (
          session_id UUID PRIMARY KEY,
          state VARCHAR(48) NOT NULL,
          version INTEGER NOT NULL,
          passkey_account VARCHAR(56) NOT NULL,
          provider TEXT NOT NULL,
          session_hash VARCHAR(64) NOT NULL,
          session_json JSONB NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS kletia_payment_center_account_idx
          ON kletia_payment_center_sessions(passkey_account, updated_at DESC);
      `)
      .then(() => undefined)
      .catch((error) => {
        postgresInitialized = null;
        throw controlled(
          "PAYMENT_CENTER_STORE_UNAVAILABLE",
          "Payment Center schema initialization failed.",
          503,
          error,
        );
      });
    return postgresInitialized;
  }
  if (!sqliteInitialized) {
    sqliteDatabase().exec(`
      CREATE TABLE IF NOT EXISTS kletia_payment_center_sessions (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        version INTEGER NOT NULL,
        passkey_account TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        session_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS kletia_payment_center_account_idx
        ON kletia_payment_center_sessions(passkey_account, updated_at DESC);
    `);
    sqliteInitialized = true;
  }
}

function sessionHash(session: PaymentCenterSessionRecord): string {
  return createHash("sha256").update(JSON.stringify(session)).digest("hex");
}

function verifiedRecord(
  value: unknown,
  storedHash: string,
): PaymentCenterSessionRecord {
  const session = value as PaymentCenterSessionRecord;
  if (
    !session ||
    session.schemaVersion !== "kletia_stellar_payment_session_v1" ||
    typeof session.sessionId !== "string" ||
    typeof session.version !== "number" ||
    typeof session.expiresAt !== "number"
  ) {
    throw controlled(
      "PAYMENT_CENTER_STORE_INTEGRITY_FAILED",
      "Stored Payment Center session has an invalid envelope.",
    );
  }
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(sessionHash(session), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw controlled(
      "PAYMENT_CENTER_STORE_INTEGRITY_FAILED",
      "Stored Payment Center session content failed its integrity check.",
    );
  }
  return session;
}

export async function createPaymentCenterSession(
  session: PaymentCenterSessionRecord,
): Promise<void> {
  await ensureSchema();
  const hash = sessionHash(session);
  if (!connectionString) {
    sqliteDatabase()
      .prepare(`INSERT INTO kletia_payment_center_sessions
        (session_id, state, version, passkey_account, provider, session_hash, session_json, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        session.sessionId,
        session.state,
        session.version,
        session.passkeyAccount,
        session.provider,
        hash,
        JSON.stringify(session),
        new Date(session.expiresAt).toISOString(),
      );
    return;
  }
  await databasePool().query(
    `INSERT INTO kletia_payment_center_sessions
      (session_id, state, version, passkey_account, provider, session_hash, session_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      session.sessionId,
      session.state,
      session.version,
      session.passkeyAccount,
      session.provider,
      hash,
      JSON.stringify(session),
      new Date(session.expiresAt),
    ],
  );
}

type StoredRow = {
  session_json: PaymentCenterSessionRecord | string;
  session_hash: string;
};

function rowRecord(row: StoredRow | undefined): PaymentCenterSessionRecord {
  if (!row) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_NOT_FOUND",
      "Payment Center session was not found.",
      404,
    );
  }
  const value =
    typeof row.session_json === "string"
      ? JSON.parse(row.session_json)
      : row.session_json;
  return verifiedRecord(value, row.session_hash);
}

export async function readPaymentCenterSession(
  sessionId: string,
): Promise<PaymentCenterSessionRecord> {
  await ensureSchema();
  if (!connectionString) {
    const row = sqliteDatabase()
      .prepare(
        "SELECT session_json, session_hash FROM kletia_payment_center_sessions WHERE session_id = ?",
      )
      .get(sessionId) as StoredRow | undefined;
    return rowRecord(row);
  }
  const result = await databasePool().query<StoredRow>(
    "SELECT session_json, session_hash FROM kletia_payment_center_sessions WHERE session_id = $1",
    [sessionId],
  );
  return rowRecord(result.rows[0]);
}

export async function readPaymentCenterStoreReadiness(): Promise<{
  ready: true;
  durable: true;
  backend: "postgres" | "sqlite";
}> {
  await ensureSchema();
  if (connectionString) {
    await databasePool().query("SELECT 1 AS ready");
    return { ready: true, durable: true, backend: "postgres" };
  }
  sqliteDatabase().prepare("SELECT 1 AS ready").get();
  return { ready: true, durable: true, backend: "sqlite" };
}

function nextRecord(
  current: PaymentCenterSessionRecord,
  mutate: (session: PaymentCenterSessionRecord) => PaymentCenterSessionRecord,
): PaymentCenterSessionRecord {
  const next = mutate(structuredClone(current));
  if (
    next.sessionId !== current.sessionId ||
    next.passkeyAccount !== current.passkeyAccount ||
    next.provider !== current.provider ||
    next.version !== current.version + 1 ||
    next.updatedAt < current.updatedAt
  ) {
    throw controlled(
      "PAYMENT_CENTER_TRANSITION_INVALID",
      "Payment Center session transition changed an immutable identity or version.",
      409,
    );
  }
  return next;
}

function assertExpectedState(
  current: PaymentCenterSessionRecord,
  expectedStates: readonly PaymentCenterSessionState[],
): void {
  if (!expectedStates.includes(current.state)) {
    throw controlled(
      "PAYMENT_CENTER_STATE_CONFLICT",
      `Payment Center session is ${current.state}; this action is no longer available.`,
      409,
    );
  }
}

async function transitionPostgres(
  client: PoolClient,
  sessionId: string,
  expectedStates: readonly PaymentCenterSessionState[],
  mutate: (session: PaymentCenterSessionRecord) => PaymentCenterSessionRecord,
): Promise<PaymentCenterSessionRecord> {
  await client.query("BEGIN");
  try {
    const result = await client.query<StoredRow>(
      "SELECT session_json, session_hash FROM kletia_payment_center_sessions WHERE session_id = $1 FOR UPDATE",
      [sessionId],
    );
    const current = rowRecord(result.rows[0]);
    assertExpectedState(current, expectedStates);
    const next = nextRecord(current, mutate);
    await client.query(
      `UPDATE kletia_payment_center_sessions
       SET state = $2, version = $3, session_hash = $4, session_json = $5::jsonb,
           expires_at = $6, updated_at = NOW()
       WHERE session_id = $1 AND version = $7`,
      [
        next.sessionId,
        next.state,
        next.version,
        sessionHash(next),
        JSON.stringify(next),
        new Date(next.expiresAt),
        current.version,
      ],
    );
    await client.query("COMMIT");
    return next;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function transitionPaymentCenterSession(
  sessionId: string,
  expectedStates: readonly PaymentCenterSessionState[],
  mutate: (session: PaymentCenterSessionRecord) => PaymentCenterSessionRecord,
): Promise<PaymentCenterSessionRecord> {
  await ensureSchema();
  if (connectionString) {
    const client = await databasePool().connect();
    try {
      return await transitionPostgres(client, sessionId, expectedStates, mutate);
    } finally {
      client.release();
    }
  }
  const database = sqliteDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database
      .prepare(
        "SELECT session_json, session_hash FROM kletia_payment_center_sessions WHERE session_id = ?",
      )
      .get(sessionId) as StoredRow | undefined;
    const current = rowRecord(row);
    assertExpectedState(current, expectedStates);
    const next = nextRecord(current, mutate);
    const updated = database
      .prepare(`UPDATE kletia_payment_center_sessions
        SET state = ?, version = ?, session_hash = ?, session_json = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE session_id = ? AND version = ?`)
      .run(
        next.state,
        next.version,
        sessionHash(next),
        JSON.stringify(next),
        new Date(next.expiresAt).toISOString(),
        next.sessionId,
        current.version,
      );
    if (updated.changes !== 1) {
      throw controlled(
        "PAYMENT_CENTER_STATE_CONFLICT",
        "Payment Center session changed while this action was being prepared.",
        409,
      );
    }
    database.exec("COMMIT");
    return next;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function sealPaymentCenterSessionToken(
  session: Pick<
    PaymentCenterSessionRecord,
    "sessionId" | "passkeyAccount" | "provider" | "expiresAt"
  >,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      sessionId: session.sessionId,
      passkeyAccount: session.passkeyAccount,
      provider: session.provider,
      expiresAt: session.expiresAt,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", signingSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function openPaymentCenterSessionToken(tokenInput: unknown): {
  sessionId: string;
  passkeyAccount: string;
  provider: string;
  expiresAt: number;
} {
  const token = String(tokenInput || "");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_TOKEN_INVALID",
      "Payment Center session authorization is malformed.",
      401,
    );
  }
  const expected = createHmac("sha256", signingSecret()).update(payload).digest();
  let actual: Buffer;
  let decoded: Record<string, unknown>;
  try {
    actual = decodeCanonicalBase64Url(signature);
    decoded = JSON.parse(
      decodeCanonicalBase64Url(payload).toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw controlled(
      "PAYMENT_CENTER_SESSION_TOKEN_INVALID",
      "Payment Center session authorization is malformed.",
      401,
    );
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_TOKEN_INVALID",
      "Payment Center session authorization is invalid.",
      401,
    );
  }
  if (
    decoded.version !== 1 ||
    typeof decoded.sessionId !== "string" ||
    typeof decoded.passkeyAccount !== "string" ||
    typeof decoded.provider !== "string" ||
    typeof decoded.expiresAt !== "number" ||
    decoded.expiresAt <= Date.now()
  ) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_TOKEN_EXPIRED",
      "Payment Center session authorization is invalid or expired.",
      401,
    );
  }
  return decoded as {
    sessionId: string;
    passkeyAccount: string;
    provider: string;
    expiresAt: number;
  };
}

type SensitivePaymentValuePurpose = "anchor-jwt" | "sep24-interactive-url";

function encryptSensitivePaymentValue(
  value: string,
  purpose: SensitivePaymentValuePurpose,
): string {
  const key = createHash("sha256").update(encryptionSecret()).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`kletia:stellar-payment-center:${purpose}:v1`));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptSensitivePaymentValue(
  value: string,
  purpose: SensitivePaymentValuePurpose,
): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue || extra) {
    throw controlled(
      "PAYMENT_CENTER_CREDENTIAL_INVALID",
      "Stored anchor credential has an invalid envelope.",
    );
  }
  try {
    const key = createHash("sha256").update(encryptionSecret()).digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      decodeCanonicalBase64Url(ivValue),
    );
    decipher.setAAD(Buffer.from(`kletia:stellar-payment-center:${purpose}:v1`));
    decipher.setAuthTag(decodeCanonicalBase64Url(tagValue));
    return Buffer.concat([
      decipher.update(decodeCanonicalBase64Url(ciphertextValue)),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw controlled(
      "PAYMENT_CENTER_CREDENTIAL_INVALID",
      "Stored anchor credential failed authentication.",
      503,
      error,
    );
  }
}

export function encryptAnchorAccessToken(token: string): string {
  return encryptSensitivePaymentValue(token, "anchor-jwt");
}

export function decryptAnchorAccessToken(value: string): string {
  return decryptSensitivePaymentValue(value, "anchor-jwt");
}

export function encryptSep24InteractiveUrl(url: string): string {
  return encryptSensitivePaymentValue(url, "sep24-interactive-url");
}

export function decryptSep24InteractiveUrl(value: string): string {
  return decryptSensitivePaymentValue(value, "sep24-interactive-url");
}
