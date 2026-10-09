/**
 * Sessions (`cs_` + 32 hex): short-lived, single-use templates an integrator
 * backend creates with its API key so the embed can turn them into an intent
 * once the visitor connects a wallet (design §7.3, flow B).
 *
 * - POST /v1/sessions (key): structured actions only, the origins allowed to
 *   embed the session, an optional bounded amount the visitor may choose for
 *   one action, a TTL (60-3600 s) and a use count (1-100). The template is
 *   planned once as a dry run with placeholder accounts, so a broken template
 *   fails here rather than in front of a user. At most 1,000 active sessions
 *   per key.
 * - GET /v1/sessions/{id} (public; the id is the capability): integrator
 *   identity, allowed origins, action labels, amount bounds and expiry. Never
 *   the key or the project.
 * - POST /v1/sessions/{id}/intents (public): re-checks expiry, the use count
 *   (one atomic conditional increment) and the host origin, then plans the
 *   template with the visitor's accounts under the session owner's key, with
 *   `metadata.sessionId` set. A failed plan gives the use back. With several
 *   uses, each intent's clientReference is `<clientReference>:<n>`, where n
 *   counts claimed uses and is never reused (a given-back use keeps its n).
 *
 * A leaked session id lets someone else run the same fixed actions with their
 * own funds and wallet, nothing more. Storage: memory (50,000 sessions) or
 * Postgres `kletia_sessions`.
 */
import {
  CHAINS,
  CONTRACT_ACTION_KINDS,
  CONTRACT_LIMITS,
  findAssetBySymbol,
  getAsset,
  isDecimalAmount,
  resolveContractAsset,
  validateSessionCreateRequest,
  validateSessionIntentRequest,
  type AccountId,
  type IntentActionSpec,
  type IntentConstraints,
  type IntentGraph,
  type NetworkKey,
  type SessionActionView,
  type SessionAmountBounds,
  type SessionView,
} from "@kletia/core";
import { PlatformError, isPlatformError } from "../errors.js";
import { createIntentDetailed } from "../index.js";
import { isKeyRevoked } from "./auth.js";
import { contractsEnabled } from "./contractChecks.js";
import { contractNow, createContractDirectory } from "./contracts.js";
import { HttpError, invalidRequest, isRecord, type AuthContext } from "./context.js";
import { dbQuery, dbTransaction, platformDatabaseUrl } from "./db.js";
import { rememberIntentOwner } from "./owners.js";
import { randomHex } from "./secrets.js";
import { kletiaWebOrigin } from "./webOrigin.js";

/** Metadata key set on every intent a session creates. */
export const SESSION_METADATA_KEY = "sessionId";
const MAX_METADATA_ENTRIES = 20;
/** Expired sessions are kept this long (GET answers `expired`), then pruned. */
const SESSION_RETENTION_MS = 24 * 60 * 60_000;

/* ================================================================== model */

export interface SessionIntegrator {
  readonly name: string;
  readonly website?: string;
  readonly domainVerified: boolean;
}

/** What a session stores besides its counters (the `template` column). */
export interface SessionTemplate {
  readonly actions: readonly IntentActionSpec[];
  readonly labels: readonly string[];
  readonly amount?: SessionAmountBounds & { readonly default: string; readonly symbol?: string; readonly decimals?: number };
  readonly constraints?: IntentConstraints;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly clientReference?: string;
  readonly integrator: SessionIntegrator;
}

export interface SessionRecord {
  readonly id: string;
  readonly ownerKeyId: string;
  readonly template: SessionTemplate;
  readonly allowedOrigins: readonly string[];
  readonly maxIntents: number;
  /** Uses taken and not given back (a failed plan releases its use). */
  readonly used: number;
  /**
   * Uses ever claimed; never decremented. Numbers the clientReference suffix
   * of each intent, so a released use never hands its number to the next
   * visitor while a concurrent visitor already holds the following one.
   */
  readonly issued: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export type SessionUse = { readonly state: "used_ok"; readonly record: SessionRecord } | { readonly state: "missing" | "expired" | "used" };

function sessionNotFound(): HttpError {
  return new HttpError(404, "SESSION_NOT_FOUND", "Session not found.");
}

function sessionExpired(): PlatformError {
  return new PlatformError("SESSION_EXPIRED", "This session expired. Ask the integrator for a new one.", 410);
}

function sessionUsed(): PlatformError {
  return new PlatformError("SESSION_USED", "This session was already used. Ask the integrator for a new one.", 409);
}

function sessionLimitReached(max: number): HttpError {
  return new HttpError(429, "RATE_LIMITED", `An API key holds at most ${max} active sessions. Retry when some have expired or been used.`, {
    headers: { "Retry-After": "60" },
  });
}

/* ================================================================== store */

export interface SessionStore {
  readonly kind: "memory" | "postgres";
  /** Inserts unless the owner already holds `maxActive` active sessions (429 RATE_LIMITED). */
  create(record: SessionRecord, maxActive: number, now: string): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  /**
   * One atomic use: `used + 1` and `issued + 1` only while `used < maxIntents`
   * and the session has not expired. The returned record's `issued` is this
   * use's number, unique for the session's lifetime.
   */
  use(id: string, now: string): Promise<SessionUse>;
  /** Gives one use back (a plan that failed after the use was taken); `issued` stays. */
  release(id: string): Promise<void>;
  /** Deletes sessions that expired before `before`. */
  prune(before: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  readonly kind = "memory" as const;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly maxSessions = 50_000) {}

  async create(record: SessionRecord, maxActive: number, now: string): Promise<void> {
    let active = 0;
    for (const session of this.sessions.values()) {
      if (session.ownerKeyId === record.ownerKeyId && session.expiresAt > now && session.used < session.maxIntents) active += 1;
    }
    if (active >= maxActive) throw sessionLimitReached(maxActive);
    this.sessions.set(record.id, record);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async use(id: string, now: string): Promise<SessionUse> {
    // Synchronous between the read and the write: concurrent uses in this process cannot both pass.
    const record = this.sessions.get(id);
    if (!record) return { state: "missing" };
    if (record.expiresAt <= now) return { state: "expired" };
    if (record.used >= record.maxIntents) return { state: "used" };
    const next = { ...record, used: record.used + 1, issued: Math.max(record.issued, record.used) + 1 };
    this.sessions.set(id, next);
    return { state: "used_ok", record: next };
  }

  async release(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (record && record.used > 0) this.sessions.set(id, { ...record, used: record.used - 1 });
  }

  async prune(before: string): Promise<void> {
    for (const [id, record] of this.sessions) if (record.expiresAt < before) this.sessions.delete(id);
  }
}

const SESSIONS_SCHEMA = {
  name: "kletia_sessions",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_sessions (
  id text PRIMARY KEY,
  owner_key_id text NOT NULL,
  template jsonb NOT NULL,
  allowed_origins text[] NOT NULL,
  max_intents integer NOT NULL,
  used integer NOT NULL DEFAULT 0,
  issued integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kletia_sessions ADD COLUMN IF NOT EXISTS issued integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS kletia_sessions_owner_idx ON kletia_sessions (owner_key_id, created_at);
CREATE INDEX IF NOT EXISTS kletia_sessions_expiry_idx ON kletia_sessions (expires_at);`,
} as const;

interface SessionRow {
  id: string;
  owner_key_id: string;
  template: unknown;
  allowed_origins: string[];
  max_intents: number;
  used: number;
  issued: number | null;
  expires_at: Date | string;
  created_at: Date | string;
}

const SESSION_COLUMNS = "id, owner_key_id, template, allowed_origins, max_intents, used, issued, expires_at, created_at";

function isoOf(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function sessionFromRow(row: SessionRow): SessionRecord | null {
  if (!isRecord(row.template) || !Array.isArray(row.template.actions)) return null;
  return {
    id: row.id,
    ownerKeyId: row.owner_key_id,
    template: row.template as unknown as SessionTemplate,
    allowedOrigins: Array.isArray(row.allowed_origins) ? row.allowed_origins : [],
    maxIntents: row.max_intents,
    used: row.used,
    issued: Math.max(row.issued ?? 0, row.used),
    expiresAt: isoOf(row.expires_at),
    createdAt: isoOf(row.created_at),
  };
}

export class PostgresSessionStore implements SessionStore {
  readonly kind = "postgres" as const;

  async create(record: SessionRecord, maxActive: number, now: string): Promise<void> {
    const inserted = await dbTransaction(SESSIONS_SCHEMA, async (client) => {
      // Serialise per owner so the active-session cap holds across instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`kletia_sessions:${record.ownerKeyId}`]);
      const count = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kletia_sessions WHERE owner_key_id = $1 AND expires_at > $2 AND used < max_intents",
        [record.ownerKeyId, now],
      );
      if (Number(count.rows[0]?.count ?? "0") >= maxActive) return false;
      await client.query(
        `INSERT INTO kletia_sessions (id, owner_key_id, template, allowed_origins, max_intents, used, issued, expires_at, created_at)
         VALUES ($1, $2, $3::jsonb, $4::text[], $5, $6, $7, $8, $9)`,
        [record.id, record.ownerKeyId, JSON.stringify(record.template), [...record.allowedOrigins], record.maxIntents, record.used, Math.max(record.issued, record.used), record.expiresAt, record.createdAt],
      );
      return true;
    });
    if (!inserted) throw sessionLimitReached(maxActive);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const result = await dbQuery<SessionRow>(SESSIONS_SCHEMA, `SELECT ${SESSION_COLUMNS} FROM kletia_sessions WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? sessionFromRow(row) : null;
  }

  async use(id: string, now: string): Promise<SessionUse> {
    const result = await dbQuery<SessionRow>(
      SESSIONS_SCHEMA,
      `UPDATE kletia_sessions SET used = used + 1, issued = GREATEST(issued, used) + 1
       WHERE id = $1 AND used < max_intents AND expires_at > $2
       RETURNING ${SESSION_COLUMNS}`,
      [id, now],
    );
    const row = result.rows[0];
    const record = row ? sessionFromRow(row) : null;
    if (record) return { state: "used_ok", record };
    const current = await this.get(id);
    if (!current) return { state: "missing" };
    return current.expiresAt <= now ? { state: "expired" } : { state: "used" };
  }

  async release(id: string): Promise<void> {
    await dbQuery(SESSIONS_SCHEMA, "UPDATE kletia_sessions SET used = used - 1 WHERE id = $1 AND used > 0", [id]);
  }

  async prune(before: string): Promise<void> {
    await dbQuery(SESSIONS_SCHEMA, "DELETE FROM kletia_sessions WHERE expires_at < $1", [before]);
  }
}

let store: SessionStore | null = null;

export function sessionStore(): SessionStore {
  store ??= platformDatabaseUrl() ? new PostgresSessionStore() : new MemorySessionStore();
  return store;
}

/** Replaces the store (tests); `null` re-selects by KLETIA_DATABASE_URL on next use. */
export function configureSessionStore(custom: SessionStore | null): void {
  store = custom;
}

/* ================================================================ helpers */

function iso(time: number): string {
  return new Date(time).toISOString();
}

function compareDecimals(a: string, b: string): number {
  const [aWhole = "0", aFraction = ""] = a.split(".");
  const [bWhole = "0", bFraction = ""] = b.split(".");
  const width = Math.max(aFraction.length, bFraction.length);
  const left = BigInt(aWhole + aFraction.padEnd(width, "0"));
  const right = BigInt(bWhole + bFraction.padEnd(width, "0"));
  return left < right ? -1 : left > right ? 1 : 0;
}

function fractionDigits(value: string): number {
  return (value.split(".")[1] ?? "").replace(/0+$/u, "").length;
}

/** A visitor-facing description of one template action. */
function actionLabel(action: IntentActionSpec): string {
  const amount = action.amount === "max" ? "all" : action.amount;
  const parts: string[] = [action.kind];
  if (amount) parts.push(amount);
  if (action.from) parts.push(action.from);
  if (action.to) parts.push(`to ${action.to}`);
  parts.push(`on ${CHAINS[action.network].name}`);
  if (action.toNetwork && action.toNetwork !== action.network) parts.push(`to ${CHAINS[action.toNetwork].name}`);
  return parts.join(" ").slice(0, 160);
}

/** Placeholder accounts for the creation-time dry run: one per VM the template touches. */
function placeholderAccounts(actions: readonly IntentActionSpec[]): AccountId[] {
  const networks = actions.flatMap((action) => [action.network, ...(action.toNetwork ? [action.toNetwork] : [])]);
  const accounts: AccountId[] = [];
  const evm = networks.find((network) => CHAINS[network].vm === "evm");
  const svm = networks.find((network) => CHAINS[network].vm === "svm");
  if (evm) accounts.push(`${CHAINS[evm].id}:0x000000000000000000000000000000000000c0de` as AccountId);
  if (svm) accounts.push(`${CHAINS[svm].id}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId);
  return accounts;
}

/**
 * Codes that mean the template itself is wrong (refused at creation). Other
 * dry-run failures (quotes, providers, a placeholder account's balance, a
 * registration still pending) do not block the session. Shared with intent
 * links (links/service.ts), which refuse the same template errors.
 */
export const TEMPLATE_ERRORS: ReadonlySet<string> = new Set([
  "INTENT_UNSUPPORTED",
  "ACCOUNT_REQUIRED",
  "AMOUNT_INVALID",
  "ASSET_INVALID",
  "ASSET_MISMATCH",
  "ASSET_NETWORK_MISMATCH",
  "ASSET_REQUIRED",
  "CAPITAL_LANE_MIXED",
  "NETWORK_UNSUPPORTED",
  "PLAN_INVALID",
  "RECIPIENT_INVALID",
  "RECIPIENT_NETWORK_MISMATCH",
  "RECIPIENT_REQUIRED",
  "ROUTE_UNSUPPORTED",
  "SWAP_SAME_ASSET",
  "TESTNET_NOT_ALLOWED",
  "TOKEN_UNKNOWN",
  "VENUE_UNKNOWN",
  "VENUE_UNSUPPORTED",
  "VENUE_ASSET_MISMATCH",
  "CONTRACT_UNKNOWN",
  "CONTRACT_ACTION_UNKNOWN",
  "CONTRACT_PARAM_INVALID",
  "CONTRACT_AMOUNT_LIMIT",
  "CONTRACT_BINDING_INVALID",
  "CONTRACTS_DISABLED",
]);

export function isTemplateError(error: unknown): boolean {
  return isPlatformError(error) && (error.status === 400 || TEMPLATE_ERRORS.has(error.code));
}

/** The decimals of the asset an action spends, when the registry knows it. */
function spentAsset(action: IntentActionSpec, contractInput: { symbol: string; decimals: number } | null): { symbol: string; decimals: number } | null {
  if (contractInput) return contractInput;
  if (!action.from) return null;
  const asset = action.from.includes("/") ? getAsset(action.from) : findAssetBySymbol(action.network, action.from);
  return asset && asset.network === action.network ? { symbol: asset.symbol, decimals: asset.decimals } : null;
}

/* =============================================================== handlers */

function sessionView(record: SessionRecord, now: number, withEmbed = false): SessionView {
  const { template } = record;
  const status = record.used >= record.maxIntents ? "used" : Date.parse(record.expiresAt) <= now ? "expired" : "active";
  const actions: SessionActionView[] = template.actions.map((action, index) => ({
    kind: action.kind,
    network: action.network,
    ...(action.toNetwork ? { toNetwork: action.toNetwork } : {}),
    ...(action.from ? { from: action.from } : {}),
    ...(action.to ? { to: action.to } : {}),
    ...(action.amount ? { amount: action.amount } : {}),
    ...(action.contract ? { contract: action.contract } : {}),
    ...(action.entry ? { entry: action.entry } : {}),
    label: template.labels[index] ?? actionLabel(action),
  }));
  return {
    id: record.id,
    status,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    integrator: template.integrator,
    allowedOrigins: record.allowedOrigins,
    actions,
    ...(template.amount
      ? {
          amount: {
            action: template.amount.action,
            min: template.amount.min,
            max: template.amount.max,
            default: template.amount.default,
            ...(template.amount.symbol ? { symbol: template.amount.symbol } : {}),
          },
        }
      : {}),
    maxIntents: record.maxIntents,
    used: record.used,
    ...(withEmbed ? { embedUrl: `${kletiaWebOrigin()}/embed#session=${record.id}` } : {}),
  };
}

/** POST /v1/sessions. */
export async function createSession(auth: AuthContext, body: unknown): Promise<SessionView> {
  if (!auth.keyId) throw new HttpError(401, "API_KEY_REQUIRED", "Creating sessions requires an API key.");
  const ownerKeyId = auth.keyId;
  const validated = validateSessionCreateRequest(body);
  if (!validated.ok) throw invalidRequest("The session request is invalid.", validated.issues);
  const request = validated.value;
  if (request.metadata && Object.keys(request.metadata).filter((key) => key !== SESSION_METADATA_KEY).length >= MAX_METADATA_ENTRIES) {
    throw invalidRequest(`metadata holds at most ${MAX_METADATA_ENTRIES - 1} entries in a session (Kletia adds ${SESSION_METADATA_KEY}).`, [
      { path: "metadata", message: `At most ${MAX_METADATA_ENTRIES - 1} entries.` },
    ]);
  }

  // Contract actions: the session owner must be able to use each registration and entry. Aliases are
  // replaced by the registration id, so a later alias change can never redirect the session.
  const actions: IntentActionSpec[] = [...request.actions];
  const labels: string[] = request.actions.map(actionLabel);
  const contractInputs: ({ symbol: string; decimals: number } | null)[] = request.actions.map(() => null);
  let integrator: SessionIntegrator | null = null;
  if (request.actions.some((action) => CONTRACT_ACTION_KINDS.includes(action.kind))) {
    if (!contractsEnabled()) throw new PlatformError("CONTRACTS_DISABLED", "Custom contracts are disabled on this deployment.", 503);
    const directory = createContractDirectory();
    for (const [index, action] of request.actions.entries()) {
      if (!CONTRACT_ACTION_KINDS.includes(action.kind) || !action.contract || !action.entry) continue;
      const registration = await directory.resolve(ownerKeyId, action.contract, action.network);
      if (!registration || registration.definition.network !== action.network) {
        throw new PlatformError("CONTRACT_UNKNOWN", `Unknown contract "${action.contract.slice(0, 64)}" for this API key on ${action.network}.`, 422, [
          { path: `actions[${index}].contract`, message: "Unknown contract." },
        ]);
      }
      const entry = registration.definition.actions.find((candidate) => candidate.id === action.entry);
      if (!entry) {
        throw new PlatformError("CONTRACT_ACTION_UNKNOWN", `No action "${action.entry}" in ${registration.id}.`, 422, [
          { path: `actions[${index}].entry`, message: "Unknown action id." },
        ]);
      }
      labels[index] = entry.label;
      actions[index] = { ...action, contract: registration.id };
      const input = entry.input ? resolveContractAsset(registration.definition.network, entry.input.token) : null;
      contractInputs[index] = input ? { symbol: input.symbol, decimals: input.decimals } : null;
      integrator ??= { ...registration.definition.integrator, domainVerified: registration.verification.domain.verified };
    }
  }
  const firstOrigin = new URL(request.allowedOrigins[0] ?? "https://unknown.invalid");
  integrator ??= { name: firstOrigin.hostname, domainVerified: false };

  // Amount bounds: within the spent asset's precision.
  let amount: SessionTemplate["amount"];
  if (request.amount) {
    const action = request.actions[request.amount.action];
    const asset = action ? spentAsset(action, contractInputs[request.amount.action] ?? null) : null;
    for (const [field, value] of [["min", request.amount.min], ["max", request.amount.max]] as const) {
      if (asset && fractionDigits(value) > asset.decimals) {
        throw invalidRequest(`amount.${field} has more decimals than ${asset.symbol} (${asset.decimals}).`, [{ path: `amount.${field}`, message: "Too many decimals." }]);
      }
    }
    amount = {
      ...request.amount,
      default: action?.amount ?? request.amount.min,
      ...(asset ? { symbol: asset.symbol, decimals: asset.decimals } : {}),
    };
  }

  // A broken template fails here, not in front of a visitor.
  try {
    await createIntentDetailed(
      { actions, accounts: placeholderAccounts(actions), ...(request.constraints ? { constraints: request.constraints } : {}) },
      { ownerKeyId, dryRun: true },
    );
  } catch (error) {
    if (isTemplateError(error)) throw error;
  }

  const now = contractNow();
  const record: SessionRecord = {
    id: `cs_${randomHex(16)}`,
    ownerKeyId,
    template: {
      actions,
      labels,
      ...(amount ? { amount } : {}),
      ...(request.constraints ? { constraints: request.constraints } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
      ...(request.clientReference ? { clientReference: request.clientReference } : {}),
      integrator,
    },
    allowedOrigins: request.allowedOrigins,
    maxIntents: request.maxIntents ?? 1,
    used: 0,
    issued: 0,
    expiresAt: iso(now + (request.expiresInSeconds ?? CONTRACT_LIMITS.sessionDefaultTtlSeconds) * 1000),
    createdAt: iso(now),
  };
  await sessionStore().create(record, CONTRACT_LIMITS.activeSessionsPerKey, iso(now));
  return sessionView(record, now, true);
}

async function liveSession(id: string): Promise<SessionRecord> {
  const record = await sessionStore().get(id);
  // A revoked key's sessions stop working with it.
  if (!record || (await isKeyRevoked(record.ownerKeyId))) throw sessionNotFound();
  return record;
}

/** GET /v1/sessions/{id} (public). */
export async function getSession(id: string): Promise<SessionView> {
  return sessionView(await liveSession(id), contractNow());
}

/**
 * The clientReference of a session's intent: unique per claimed use when a
 * session allows several. `use` is the monotonic `issued` number, never the
 * `used` count: a failed plan gives its use back, and numbering by `used`
 * would hand a later visitor the suffix a concurrent visitor's intent already
 * holds (409 CLIENT_REFERENCE_EXISTS for every visitor after it).
 */
function useReference(reference: string | undefined, use: number, maxIntents: number): string | undefined {
  if (!reference) return undefined;
  if (maxIntents === 1) return reference;
  const suffix = `:${use}`;
  return `${reference.slice(0, 80 - suffix.length)}${suffix}`;
}

function sameAccounts(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (accounts: readonly string[]) => accounts.map((account) => account.toLowerCase()).sort().join("\n");
  return normalize(left) === normalize(right);
}

export interface SessionIntentResult {
  readonly intent: IntentGraph;
  readonly replayed: boolean;
}

/** POST /v1/sessions/{id}/intents (public; the session id is the capability). */
export async function createSessionIntent(id: string, body: unknown): Promise<SessionIntentResult> {
  const validated = validateSessionIntentRequest(body);
  if (!validated.ok) throw invalidRequest("The request is invalid.", validated.issues);
  const request = validated.value;
  const record = await liveSession(id);
  const now = contractNow();
  if (Date.parse(record.expiresAt) <= now) throw sessionExpired();
  if (record.used >= record.maxIntents) throw sessionUsed();
  // Defence in depth: the frame refuses foreign hosts first.
  if (!record.allowedOrigins.includes(request.hostOrigin)) {
    throw new PlatformError("SESSION_ORIGIN_FORBIDDEN", "This session cannot be used from this site.", 403, [{ path: "hostOrigin", message: "Not an allowed origin." }]);
  }
  const { template } = record;
  let actions: IntentActionSpec[] = [...template.actions];
  if (request.amount !== undefined) {
    const bounds = template.amount;
    if (!bounds) throw invalidRequest("This session has fixed amounts.", [{ path: "amount", message: "Not adjustable." }]);
    if (!isDecimalAmount(request.amount) || compareDecimals(request.amount, bounds.min) < 0 || compareDecimals(request.amount, bounds.max) > 0) {
      throw invalidRequest(`amount must lie between ${bounds.min} and ${bounds.max}.`, [{ path: "amount", message: "Outside the session bounds." }]);
    }
    if (bounds.decimals !== undefined && fractionDigits(request.amount) > bounds.decimals) {
      throw invalidRequest(`amount has more decimals than ${bounds.symbol ?? "the asset"} (${bounds.decimals}).`, [{ path: "amount", message: "Too many decimals." }]);
    }
    actions = actions.map((action, index) => (index === bounds.action ? { ...action, amount: request.amount } : action));
  }

  const claim = await sessionStore().use(id, iso(now));
  if (claim.state !== "used_ok") {
    if (claim.state === "missing") throw sessionNotFound();
    throw claim.state === "expired" ? sessionExpired() : sessionUsed();
  }
  const reference = useReference(template.clientReference, claim.record.issued, record.maxIntents);
  const intentRequest = {
    actions,
    accounts: request.accounts,
    ...(template.constraints ? { constraints: template.constraints } : {}),
    metadata: { ...(template.metadata ?? {}), [SESSION_METADATA_KEY]: id },
    ...(reference ? { clientReference: reference } : {}),
  };
  let created: { intent: IntentGraph; replayed: boolean };
  try {
    created = await createIntentDetailed(intentRequest, { ownerKeyId: record.ownerKeyId });
  } catch (error) {
    await sessionStore().release(id).catch(() => undefined);
    throw error;
  }
  if (created.replayed) {
    // No new intent was created: the use goes back. Another visitor's intent is never handed out.
    await sessionStore().release(id).catch(() => undefined);
    if (!sameAccounts(created.intent.request.accounts, request.accounts) || created.intent.metadata?.[SESSION_METADATA_KEY] !== id) {
      throw new PlatformError("CLIENT_REFERENCE_EXISTS", "The integrator already used this clientReference for another intent; ask for a new session.", 409);
    }
    return created;
  }
  rememberIntentOwner(created.intent.id, record.ownerKeyId);
  return created;
}

/* ================================================================= pruner */

/** Deletes sessions expired for more than a day; hourly on long-running hosts. Returns a stop function. */
export function startSessionPruner(intervalMs = 60 * 60_000): () => void {
  const timer = setInterval(() => {
    sessionStore()
      .prune(iso(contractNow() - SESSION_RETENTION_MS))
      .catch((error: unknown) => console.warn("[platform] session prune failed:", error instanceof Error ? error.message : error));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Networks a session template touches (tests, diagnostics). */
export function sessionNetworks(record: SessionRecord): NetworkKey[] {
  return [...new Set(record.template.actions.flatMap((action) => [action.network, ...(action.toNetwork ? [action.toNetwork] : [])]))];
}
