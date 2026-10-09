/**
 * Approvals (policy design §7): one hold per intent whose plan raised a
 * `confirm.*` trigger. The approval id (`apr_` + 32 hex, a 128-bit
 * capability) is safe to hand to the agent: reading it is not approving.
 *
 * Who may decide (§7.3):
 * - an active **project** key of the intent's project that is not the
 *   requesting key (agent keys, operator keys and rotated-out secrets never
 *   decide); every rule book that asked for the approval must accept it:
 *   none may set `requireWallet`, and one listing `approvers.keys` must list
 *   the caller;
 * - or a **wallet** listed by every one of those rule books
 *   (`approvers.wallets`, CAIP-10 patterns), signing the EIP-712 typed data
 *   ("Kletia Approvals" v1, verified with viem: EOA by recovery, smart
 *   accounts through ERC-1271 / ERC-6492 `eth_call`s on the signer's chain)
 *   or, on Solana, the canonical message text (ed25519).
 *
 * A signature that cannot be checked (the ERC-1271 read fails) is
 * RPC_UNAVAILABLE and never counts. A decision is single-use (`pending →
 * approved | rejected | expired`, one conditional write); a rejection
 * cancels the intent.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { getBase58Encoder } from "@solana/kit";
import { verifyTypedData as verifyEoaTypedData, type Hex } from "viem";
import {
  accountMatchesPattern,
  approvalMessageText,
  approvalTypedData,
  CHAINS,
  parseAccountId,
  type AccountId,
  type PolicyDecision,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { cancelIntent, getIntent, isEvmNetwork, publishPolicyEvent, type ApproverRequirement, type PolicyApprovalRecord, type PolicyApprovalStore } from "../../index.js";
import { evmClient } from "../../engine/chains/evm.js";
import { HttpError, invalidRequest, isRecord, type AuthContext } from "../context.js";
import { dbQuery, platformDatabaseUrl } from "../db.js";
import { newDecisionIdHex } from "./announce.js";
import { decisionStore } from "./decisions.js";
import { projectScope } from "./store.js";

export type ApprovalDecidedBy = { readonly kind: "key"; readonly keyId: string } | { readonly kind: "wallet"; readonly account: AccountId; readonly signature: string };

export interface StoredApproval extends PolicyApprovalRecord {
  readonly decidedBy?: ApprovalDecidedBy;
}

export interface ApprovalQuery {
  /** `prj_…` */
  readonly projectId: string;
  /** Requesters (owner keys) to include; null: every key of the project. */
  readonly keyIds: readonly string[] | null;
  readonly status?: PolicyApprovalRecord["status"];
  readonly limit: number;
}

export interface ApprovalStore extends PolicyApprovalStore {
  readonly kind: "memory" | "postgres";
  get(id: string): Promise<StoredApproval | null>;
  /**
   * Single winner: a pending approval becomes `status` (expired ones only
   * become `expired`). Null when it was not pending (or already expired for
   * an approve/reject).
   */
  decide(id: string, status: "approved" | "rejected" | "expired", decidedBy: ApprovalDecidedBy | null, at: number): Promise<StoredApproval | null>;
  /** Newest first. */
  list(query: ApprovalQuery): Promise<StoredApproval[]>;
  prune(before: string): Promise<void>;
}

/* ================================================================= memory */

export class MemoryApprovalStoreHttp implements ApprovalStore {
  readonly kind = "memory" as const;
  private readonly byId = new Map<string, StoredApproval>();
  private readonly byIntent = new Map<string, string>();

  constructor(private readonly maxApprovals = 20_000) {}

  async forIntent(intentId: string): Promise<PolicyApprovalRecord | undefined> {
    const id = this.byIntent.get(intentId);
    return id ? this.byId.get(id) : undefined;
  }

  async create(record: PolicyApprovalRecord): Promise<PolicyApprovalRecord> {
    const existing = await this.forIntent(record.intentId);
    if (existing) return existing;
    this.byId.set(record.id, record);
    this.byIntent.set(record.intentId, record.id);
    while (this.byId.size > this.maxApprovals) {
      const oldest = this.byId.values().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest.id);
      this.byIntent.delete(oldest.intentId);
    }
    return record;
  }

  async get(id: string): Promise<StoredApproval | null> {
    return this.byId.get(id) ?? null;
  }

  async decide(id: string, status: "approved" | "rejected" | "expired", decidedBy: ApprovalDecidedBy | null, at: number): Promise<StoredApproval | null> {
    const record = this.byId.get(id);
    if (!record || record.status !== "pending") return null;
    const expired = Date.parse(record.expiresAt) <= at;
    if (status !== "expired" && expired) return null;
    const next: StoredApproval = { ...record, status, decidedAt: new Date(at).toISOString(), ...(decidedBy ? { decidedBy } : {}) };
    this.byId.set(id, next);
    return next;
  }

  async list(query: ApprovalQuery): Promise<StoredApproval[]> {
    return [...this.byId.values()]
      .filter((record) => record.projectId === query.projectId && (query.keyIds === null || query.keyIds.includes(record.keyId)) && (!query.status || record.status === query.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit);
  }

  async prune(before: string): Promise<void> {
    for (const [id, record] of this.byId) {
      if (record.status !== "pending" && (record.decidedAt ?? record.createdAt) < before) {
        this.byId.delete(id);
        this.byIntent.delete(record.intentId);
      }
    }
  }
}

/* =============================================================== postgres */

const APPROVALS_SCHEMA = {
  name: "kletia_policy_approvals",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_policy_approvals (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  key_id text NOT NULL,
  lineage text[] NOT NULL DEFAULT '{}',
  intent_id text NOT NULL UNIQUE,
  digest text NOT NULL,
  ceiling_usd_cents bigint NOT NULL,
  notional_usd text NOT NULL,
  triggers jsonb NOT NULL,
  approvers jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  url text NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kletia_policy_approvals_pending_idx ON kletia_policy_approvals (project_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS kletia_policy_approvals_project_idx ON kletia_policy_approvals (project_id, created_at DESC);`,
} as const;

const APPROVAL_COLUMNS = "id, project_id, key_id, lineage, intent_id, digest, ceiling_usd_cents::text AS ceiling_usd_cents, notional_usd, triggers, approvers, status, url, expires_at, decided_at, decided_by, created_at";

interface ApprovalRow {
  id: string;
  project_id: string;
  key_id: string;
  lineage: string[] | null;
  intent_id: string;
  digest: string;
  ceiling_usd_cents: string;
  notional_usd: string;
  triggers: unknown;
  approvers: unknown;
  status: string;
  url: string;
  expires_at: Date | string;
  decided_at: Date | string | null;
  decided_by: unknown;
  created_at: Date | string;
}

function isoOf(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function approvalFromRow(row: ApprovalRow): StoredApproval {
  const status = ["pending", "approved", "rejected", "expired"].includes(row.status) ? (row.status as PolicyApprovalRecord["status"]) : "expired";
  return {
    id: row.id,
    projectId: row.project_id,
    keyId: row.key_id,
    lineage: row.lineage ?? [],
    intentId: row.intent_id,
    digest: row.digest,
    ceilingUsdCents: BigInt(row.ceiling_usd_cents),
    notionalUsd: row.notional_usd,
    triggers: Array.isArray(row.triggers) ? (row.triggers as string[]) : [],
    approvers: Array.isArray(row.approvers) ? (row.approvers as ApproverRequirement[]) : [],
    status,
    url: row.url,
    expiresAt: isoOf(row.expires_at),
    createdAt: isoOf(row.created_at),
    ...(row.decided_at ? { decidedAt: isoOf(row.decided_at) } : {}),
    ...(isRecord(row.decided_by) ? { decidedBy: row.decided_by as unknown as ApprovalDecidedBy } : {}),
  };
}

export class PostgresApprovalStore implements ApprovalStore {
  readonly kind = "postgres" as const;

  async forIntent(intentId: string): Promise<PolicyApprovalRecord | undefined> {
    const result = await dbQuery<ApprovalRow>(APPROVALS_SCHEMA, `SELECT ${APPROVAL_COLUMNS} FROM kletia_policy_approvals WHERE intent_id = $1`, [intentId]);
    const row = result.rows[0];
    return row ? approvalFromRow(row) : undefined;
  }

  async create(record: PolicyApprovalRecord): Promise<PolicyApprovalRecord> {
    await dbQuery(
      APPROVALS_SCHEMA,
      `INSERT INTO kletia_policy_approvals (id, project_id, key_id, lineage, intent_id, digest, ceiling_usd_cents, notional_usd, triggers, approvers, status, url, expires_at, created_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14)
       ON CONFLICT (intent_id) DO NOTHING`,
      [
        record.id, record.projectId, record.keyId, [...record.lineage], record.intentId, record.digest, record.ceilingUsdCents.toString(),
        record.notionalUsd, JSON.stringify(record.triggers), JSON.stringify(record.approvers), record.status, record.url, record.expiresAt, record.createdAt,
      ],
    );
    return (await this.forIntent(record.intentId)) ?? record;
  }

  async get(id: string): Promise<StoredApproval | null> {
    const result = await dbQuery<ApprovalRow>(APPROVALS_SCHEMA, `SELECT ${APPROVAL_COLUMNS} FROM kletia_policy_approvals WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? approvalFromRow(row) : null;
  }

  async decide(id: string, status: "approved" | "rejected" | "expired", decidedBy: ApprovalDecidedBy | null, at: number): Promise<StoredApproval | null> {
    const result = await dbQuery<ApprovalRow>(
      APPROVALS_SCHEMA,
      `UPDATE kletia_policy_approvals SET status = $2, decided_at = $3, decided_by = $4::jsonb
       WHERE id = $1 AND status = 'pending' AND (($2 = 'expired' AND expires_at <= $3) OR ($2 <> 'expired' AND expires_at > $3))
       RETURNING ${APPROVAL_COLUMNS}`,
      [id, status, new Date(at).toISOString(), decidedBy ? JSON.stringify(decidedBy) : null],
    );
    const row = result.rows[0];
    return row ? approvalFromRow(row) : null;
  }

  async list(query: ApprovalQuery): Promise<StoredApproval[]> {
    const values: unknown[] = [query.projectId];
    const clauses = ["project_id = $1"];
    if (query.keyIds !== null) {
      values.push([...query.keyIds]);
      clauses.push(`key_id = ANY($${values.length}::text[])`);
    }
    if (query.status) {
      values.push(query.status);
      clauses.push(`status = $${values.length}`);
    }
    values.push(Math.min(100, Math.max(1, query.limit)));
    const result = await dbQuery<ApprovalRow>(
      APPROVALS_SCHEMA,
      `SELECT ${APPROVAL_COLUMNS} FROM kletia_policy_approvals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(approvalFromRow);
  }

  async prune(before: string): Promise<void> {
    await dbQuery(APPROVALS_SCHEMA, "DELETE FROM kletia_policy_approvals WHERE status <> 'pending' AND COALESCE(decided_at, created_at) < $1", [before]);
  }
}

let store: ApprovalStore | null = null;

export function approvalStore(): ApprovalStore {
  store ??= platformDatabaseUrl() ? new PostgresApprovalStore() : new MemoryApprovalStoreHttp();
  return store;
}

export function configureApprovalStore(custom: ApprovalStore | null): void {
  store = custom;
}

/* ================================================================== views */

function centsText(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** `0x4b20…9cD1`: enough to recognise a wallet, not enough to read the list. */
export function maskAddress(pattern: string): string {
  const address = pattern.split(":").pop() ?? pattern;
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Status as of `now` (pending past expiry reads as expired). */
export function approvalStatus(record: PolicyApprovalRecord, now: number): PolicyApprovalRecord["status"] {
  return record.status === "pending" && Date.parse(record.expiresAt) <= now ? "expired" : record.status;
}

export interface ApprovalView {
  readonly id: string;
  readonly status: PolicyApprovalRecord["status"];
  readonly intentId: string;
  readonly keyId: string;
  readonly title: string | null;
  readonly steps: readonly Record<string, unknown>[];
  readonly recipients: readonly string[];
  readonly notionalUsd: string;
  readonly ceilingUsd: string;
  readonly triggers: readonly string[];
  readonly digest: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: { readonly kind: "key" | "wallet"; readonly id: string } | null;
  readonly approvers: { readonly requireWallet: boolean; readonly wallets: readonly string[]; readonly keys: number };
  /** Inputs of the typed data / message an approver signs (core `approvalTypedData` / `approvalMessageText`). */
  readonly signing: { readonly approvalId: string; readonly intentId: string; readonly digest: string; readonly ceilingUsdCents: string; readonly maxExpiresAt: number };
}

/** Public capability view (gate page): masked approvers, the intent's legs and recipients, never secrets or calldata. */
export async function approvalView(record: StoredApproval, now = Date.now()): Promise<ApprovalView> {
  const intent = await getIntent(record.intentId).catch(() => null);
  const steps = (intent?.steps ?? []).map((step) => ({
    id: step.id,
    kind: step.kind,
    network: step.network,
    ...(step.settlement?.destinationNetwork ? { destinationNetwork: step.settlement.destinationNetwork } : {}),
    protocol: step.protocol,
    ...(step.input ? { input: `${step.input.formatted} ${step.input.symbol}` } : {}),
    ...(step.expectedOutput ? { output: `${step.expectedOutput.formatted} ${step.expectedOutput.symbol}` } : {}),
    recipient: step.recipient ?? step.account,
    ...(step.recipientName ? { recipientName: step.recipientName } : {}),
  }));
  const wallets = [...new Set(record.approvers.flatMap((requirement) => requirement.wallets))];
  const decidedBy = (record as StoredApproval).decidedBy;
  return {
    id: record.id,
    status: approvalStatus(record, now),
    intentId: record.intentId,
    keyId: record.keyId,
    title: intent?.summary.title ?? null,
    steps,
    recipients: [...new Set(steps.map((step) => String(step.recipient)))],
    notionalUsd: record.notionalUsd,
    ceilingUsd: centsText(record.ceilingUsdCents),
    triggers: record.triggers,
    digest: record.digest,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt ?? null,
    decidedBy: decidedBy ? { kind: decidedBy.kind, id: decidedBy.kind === "key" ? decidedBy.keyId : maskAddress(decidedBy.account) } : null,
    approvers: {
      requireWallet: record.approvers.some((requirement) => requirement.requireWallet),
      wallets: wallets.map(maskAddress),
      keys: new Set(record.approvers.flatMap((requirement) => requirement.keys)).size,
    },
    signing: {
      approvalId: record.id,
      intentId: record.intentId,
      digest: record.digest,
      ceilingUsdCents: record.ceilingUsdCents.toString(),
      maxExpiresAt: Math.floor(Date.parse(record.expiresAt) / 1000),
    },
  };
}

/* ============================================================== deciding */

export interface WalletDecision {
  readonly account: AccountId;
  readonly signature: string;
  /** Unix seconds the signature is valid until (≤ the approval's expiry). */
  readonly expiresAt: number;
}

/** `{}` / no body (key approval) or `{ account, signature, expiresAt }` (wallet approval). */
export function parseDecisionBody(body: unknown): WalletDecision | null {
  if (body === undefined || body === null || (isRecord(body) && Object.keys(body).length === 0)) return null;
  if (!isRecord(body)) throw invalidRequest("Body must be empty (key approval) or { account, signature, expiresAt } (wallet approval).", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => !["account", "signature", "expiresAt"].includes(key));
  if (unknown.length > 0) throw invalidRequest("Unknown fields.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  const account = typeof body.account === "string" ? parseAccountId(body.account) : null;
  if (!account) throw invalidRequest("account must be the approver's CAIP-10 account.", [{ path: "account", message: "Invalid CAIP-10 account." }]);
  if (typeof body.signature !== "string" || body.signature.length < 64 || body.signature.length > 4_096 || !/^[0-9A-Za-z+/=_x-]+$/u.test(body.signature)) {
    throw invalidRequest("signature must be the hex (EVM) or base58/base64 (Solana) signature.", [{ path: "signature", message: "Invalid signature encoding." }]);
  }
  const expires = typeof body.expiresAt === "number" ? body.expiresAt : typeof body.expiresAt === "string" ? Math.floor(Date.parse(body.expiresAt) / 1000) : Number.NaN;
  if (!Number.isSafeInteger(expires) || expires <= 0) {
    throw invalidRequest("expiresAt must be the unix seconds (or ISO time) the signature was made for.", [{ path: "expiresAt", message: "Required." }]);
  }
  return { account: account.id as AccountId, signature: body.signature, expiresAt: expires };
}

function signatureInvalid(message = "The signature does not match this approval, decision and wallet."): PlatformError {
  return new PlatformError("APPROVAL_SIGNATURE_INVALID", message, 403);
}

function notAllowed(message: string): PlatformError {
  return new PlatformError("APPROVER_NOT_ALLOWED", message, 403);
}

function decodeSolanaSignature(value: string): Uint8Array | null {
  try {
    const base58 = getBase58Encoder().encode(value);
    if (base58.length === 64) return new Uint8Array(base58);
  } catch {
    // Not base58: try base64.
  }
  const base64 = Buffer.from(value, "base64");
  return base64.length === 64 ? new Uint8Array(base64) : null;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verifies a wallet's decision signature; throws APPROVAL_SIGNATURE_INVALID or RPC_UNAVAILABLE (never "valid" on doubt). */
export async function verifyWalletDecision(record: PolicyApprovalRecord, decision: "approve" | "reject", wallet: WalletDecision): Promise<void> {
  const account = parseAccountId(wallet.account);
  if (!account) throw signatureInvalid();
  const input = { approvalId: record.id, intentId: record.intentId, digest: record.digest, ceilingUsdCents: record.ceilingUsdCents, decision, expiresAt: wallet.expiresAt };
  if (account.chain.vm === "svm") {
    const signature = decodeSolanaSignature(wallet.signature);
    let publicKey: Uint8Array;
    try {
      publicKey = new Uint8Array(getBase58Encoder().encode(account.address));
    } catch {
      throw signatureInvalid();
    }
    if (!signature || publicKey.length !== 32) throw signatureInvalid();
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
    const message = Buffer.from(approvalMessageText(input), "utf8");
    if (!verifySignature(null, message, key, Buffer.from(signature))) throw signatureInvalid();
    return;
  }
  if (!/^0x[0-9a-fA-F]+$/u.test(wallet.signature)) throw signatureInvalid();
  const typed = approvalTypedData({ ...input, signer: account.id });
  const address = account.address as Hex;
  const signature = wallet.signature as Hex;
  // EOAs by recovery (no network read); anything else through the signer's chain (ERC-1271 / ERC-6492).
  try {
    if (await verifyEoaTypedData({ address, signature, ...typed })) return;
  } catch {
    // Not a 65-byte ECDSA signature: a smart account's signature, checked on chain below.
  }
  const network = account.chain.key;
  if (!isEvmNetwork(network) || CHAINS[network].vm !== "evm") throw signatureInvalid("This wallet's chain is not one Kletia reads, so its contract signature cannot be checked.");
  let valid: boolean;
  try {
    valid = await evmClient(network).verifyTypedData({ address, signature, ...typed });
  } catch {
    throw new PlatformError("RPC_UNAVAILABLE", "The wallet's signature could not be checked on chain right now (ERC-1271 read failed). Retry shortly.", 502);
  }
  if (!valid) throw signatureInvalid();
}

/** Throws APPROVER_NOT_ALLOWED unless every requirement accepts this wallet. */
function assertWalletAllowed(record: PolicyApprovalRecord, account: AccountId): void {
  if (record.approvers.length === 0) throw notAllowed("No rule book of this intent lists approver wallets.");
  for (const requirement of record.approvers) {
    if (!requirement.wallets.some((pattern) => accountMatchesPattern(account, pattern))) {
      throw notAllowed(`This approval needs ${requirement.wallets.length > 0 ? requirement.wallets.map(maskAddress).join(" or ") : "an approver key"}; ${maskAddress(account)} is not listed by the rule book of ${requirement.id}.`);
    }
  }
}

/** Throws unless the authenticated key may decide (project key of the project, not the requester, no requireWallet). */
function assertKeyAllowed(record: PolicyApprovalRecord, auth: AuthContext): string {
  if (!auth.keyId || auth.tier === "public") {
    throw new HttpError(401, "API_KEY_REQUIRED", "Approve with a project API key, or send { account, signature, expiresAt } signed by a listed wallet.");
  }
  if (auth.tier === "operator" || auth.keyKind === "agent") throw notAllowed("Only project keys (or listed wallets) decide approvals; agent and operator keys never do.");
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Decide approvals with the current secret.", 403);
  }
  if (!auth.projectId || projectScope(auth.projectId) !== record.projectId) throw notAllowed("This key is not a key of the intent's project.");
  // The requester never approves itself (its subtree holds only agent keys, refused above).
  if (auth.keyId === record.keyId) throw notAllowed("The key that requested the intent cannot approve it.");
  for (const requirement of record.approvers) {
    if (requirement.requireWallet) throw notAllowed(`The rule book of ${requirement.id} requires a wallet signature (requireWallet).`);
    if (requirement.keys.length > 0 && !requirement.keys.includes(auth.keyId)) throw notAllowed(`The rule book of ${requirement.id} lists other approver keys.`);
  }
  return auth.keyId;
}

export interface DecideResult {
  readonly approval: StoredApproval;
  /** False when the same decision was already recorded (idempotent replay). */
  readonly changed: boolean;
}

async function recordApprovalDecision(record: StoredApproval, status: "approved" | "rejected", actorKeyId: string | null, at: number): Promise<PolicyDecision | null> {
  try {
    return await decisionStore().append({
      id: newDecisionIdHex(),
      at: new Date(at).toISOString(),
      stage: "approval",
      outcome: status,
      projectId: record.projectId,
      keyId: record.keyId,
      actorKeyId,
      intentId: record.intentId,
      dryRun: false,
      chain: [],
      violations: [],
      triggers: [],
      warnings: [],
      requestDigest: `sha256:${record.digest.slice(2)}`,
      notionalUsd: record.notionalUsd,
      approvalId: record.id,
      title: `Approval ${status} (${record.triggers.join(", ")})`.slice(0, 200),
    });
  } catch (error) {
    console.warn("[platform] approval decision not recorded:", error instanceof Error ? error.message : error);
    return null;
  }
}

function expiredError(): PlatformError {
  return new PlatformError("POLICY_APPROVAL_EXPIRED", "Nobody decided this approval in time. Plan a new intent to ask again.", 410);
}

/** Settles a final state: the same decision replays (200), another one is APPROVAL_DECIDED. */
function finalState(record: StoredApproval, decision: "approve" | "reject", now: number): DecideResult {
  const status = approvalStatus(record, now);
  if (status === "expired") throw expiredError();
  if ((status === "approved" && decision === "approve") || (status === "rejected" && decision === "reject")) return { approval: record, changed: false };
  throw new PlatformError("APPROVAL_DECIDED", `This approval was already ${status}; a decision is final.`, 409);
}

/** POST /v1/policy/approvals/{id}/approve | reject. */
export async function decideApproval(id: string, decision: "approve" | "reject", auth: AuthContext, body: unknown, now = Date.now()): Promise<DecideResult> {
  const wallet = parseDecisionBody(body);
  const store = approvalStore();
  const record = await store.get(id);
  if (!record) throw new PlatformError("APPROVAL_NOT_FOUND", "No approval with this id.", 404);
  if (record.status === "pending" && Date.parse(record.expiresAt) <= now) {
    const expired = await store.decide(id, "expired", null, now);
    if (expired) {
      publishPolicyEvent("policy.approval_decided", { projectId: record.projectId, keyId: record.keyId, approvalId: id, intentId: record.intentId, decision: "expired", decidedBy: null });
    }
    throw expiredError();
  }
  if (record.status !== "pending") return finalState(record, decision, now);

  let decidedBy: ApprovalDecidedBy;
  if (wallet) {
    if (wallet.expiresAt * 1000 <= now) throw signatureInvalid("The signature's expiresAt has passed; sign again.");
    if (wallet.expiresAt * 1000 > Date.parse(record.expiresAt)) throw signatureInvalid("The signature's expiresAt is later than the approval's expiry.");
    assertWalletAllowed(record, wallet.account);
    await verifyWalletDecision(record, decision, wallet);
    decidedBy = { kind: "wallet", account: wallet.account, signature: wallet.signature };
  } else {
    decidedBy = { kind: "key", keyId: assertKeyAllowed(record, auth) };
  }
  const status = decision === "approve" ? "approved" : "rejected";
  const decided = await store.decide(id, status, decidedBy, now);
  if (!decided) {
    // Lost a race (or expired in between): answer from the final state.
    const fresh = await store.get(id);
    if (!fresh) throw new PlatformError("APPROVAL_NOT_FOUND", "No approval with this id.", 404);
    return finalState(fresh, decision, now);
  }
  await recordApprovalDecision(decided, status, decidedBy.kind === "key" ? decidedBy.keyId : null, now);
  publishPolicyEvent("policy.approval_decided", {
    projectId: decided.projectId,
    keyId: decided.keyId,
    approvalId: id,
    intentId: decided.intentId,
    decision: status,
    decidedBy: decidedBy.kind === "key" ? { kind: "key", keyId: decidedBy.keyId } : { kind: "wallet", account: decidedBy.account },
  });
  if (status === "rejected") {
    // A rejection cancels the intent (nothing can be prepared for it any more; submitted steps keep settling).
    await cancelIntent(decided.intentId).catch((error: unknown) => {
      console.warn(`[platform] cancelling rejected intent ${decided.intentId} failed:`, error instanceof Error ? error.message : error);
    });
  }
  return { approval: decided, changed: true };
}

/** Approvals a key may decide (`approver`) or its subtree requested (`requester`). */
export async function listApprovals(auth: AuthContext, role: "approver" | "requester", status: PolicyApprovalRecord["status"] | undefined, subtree: readonly string[] | null, limit: number, now = Date.now()): Promise<StoredApproval[]> {
  if (!auth.projectId || !auth.keyId) return [];
  const projectId = projectScope(auth.projectId);
  if (role === "requester") return approvalStore().list({ projectId, keyIds: subtree, ...(status ? { status } : {}), limit });
  if (auth.keyKind === "agent") return [];
  const pending = await approvalStore().list({ projectId, keyIds: null, status: "pending", limit: 100 });
  return pending
    .filter((record) => approvalStatus(record, now) === "pending" && record.keyId !== auth.keyId)
    .filter((record) => record.approvers.every((requirement) => !requirement.requireWallet && (requirement.keys.length === 0 || requirement.keys.includes(auth.keyId ?? ""))))
    .slice(0, limit);
}
