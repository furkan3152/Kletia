/**
 * Sub-agents (docs/platform/subagents.md): a main agent requests a child
 * agent key with a rule book inside its own chain; the project's owner
 * wallet (a signed, single-use message) or a project key decides; approval
 * mints the key once with a secret nobody sees; the requester claims it once
 * with its claim token, which sets and returns a fresh secret.
 *
 * Everything that grants is re-read fresh: the parent's chain on request and
 * on approval, the owner on every wallet decision. Requests lapse lazily
 * (`settle`): an open one past its expiry, an open one whose parent stopped,
 * and an approved one nobody claimed in time (its key is revoked).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ACCOUNT_EVM_NETWORKS,
  CHAINS,
  OBSERVER_POLICY,
  POLICY_MODES,
  SUBAGENT_CLAIM_TOKEN_PATTERN,
  SUBAGENT_LIMITS,
  SUBAGENT_REQUEST_ID_PATTERN,
  checkSubagentPolicy,
  describeSubagentGrant,
  formatUsdMicros,
  parseAccountId,
  policyHash,
  subagentApprovalMessage,
  subagentMessageNonce,
  type AccountWalletKind,
  type PolicyDocument,
  type PolicyMode,
  type SubagentDecision,
  type SubagentEventData,
  type SubagentGrantLine,
  type SubagentIssue,
  type SubagentRequestStatus,
} from "@kletia/core";
import { getAddress } from "viem";
import { verifyEvmMessageSignature, verifySolanaMessageSignature } from "../../../admin/auth/signatures.js";
import { evmClient, type EvmNetworkKey } from "../../engine/chains/evm.js";
import { PlatformError } from "../../errors.js";
import { accountOriginAllowed, normalizeWallet, parseNonceRequest } from "../accounts/auth.js";
import { accountStore } from "../accounts/store.js";
import { apiKeyStore, forgetCachedKey, issueAgentKey, keyKindOf, keyLive, newSecretFor, type ApiKeyRecord } from "../auth.js";
import { HttpError, invalidRequest, isRecord, type AuthContext } from "../context.js";
import { keyIdParam, MAX_ACTIVE_AGENT_KEYS_PER_PROJECT, parseChildKeyRequest, revokeKey } from "../keys.js";
import { agentForbidden, assertAgentPermission } from "../policies/agentGuard.js";
import { announceAmended, publishKeyEvent, recordKeyDecision } from "../policies/announce.js";
import { readKeyChain, type KeyChain } from "../policies/chain.js";
import { spendLedger } from "../policies/ledger.js";
import { policyStore, projectScope, subjectKey } from "../policies/store.js";
import { randomBase62, randomHex, sha256Hex } from "../secrets.js";
import { subagentRequestStore, type SubagentChallenge, type SubagentDecider, type SubagentRequestRecord } from "./store.js";

/* ================================================================= errors */

function requestNotFound(): PlatformError {
  return new PlatformError("SUBAGENT_REQUEST_NOT_FOUND", "No sub-agent request with this id in your subtree.", 404);
}

function notSubset(issues: readonly SubagentIssue[]): PlatformError {
  return new PlatformError(
    "SUBAGENT_POLICY_NOT_SUBSET",
    "The requested rule book is wider than the parent's chain; narrow the fields listed in issues.",
    403,
    issues.slice(0, 40).map((issue) => ({ path: issue.path || "policy", message: issue.message })),
  );
}

function signatureInvalid(message = "The message is unknown, used, expired or altered, or the signature does not match it. Request a new message."): PlatformError {
  return new PlatformError("SUBAGENT_SIGNATURE_INVALID", message, 403);
}

function approverNotAllowed(message: string): PlatformError {
  return new PlatformError("SUBAGENT_APPROVER_NOT_ALLOWED", message, 403);
}

function claimInvalid(message = "This claim is not valid: wrong token or key, already claimed, or the 15-minute claim window after the approval has passed."): PlatformError {
  return new PlatformError("SUBAGENT_CLAIM_INVALID", message, 403);
}

function parentInactive(): PlatformError {
  return new PlatformError("SUBAGENT_PARENT_INACTIVE", "The requesting agent key (or an ancestor) is revoked or expired; the request is cancelled.", 409);
}

function decidedError(status: SubagentRequestStatus): PlatformError {
  if (status === "expired") return new PlatformError("SUBAGENT_REQUEST_EXPIRED", "Nobody decided this request in time. File a new request.", 410);
  return new PlatformError("SUBAGENT_REQUEST_DECIDED", `This request is already ${status}; a decision is final.`, 409);
}

/* ================================================================ helpers */

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison of a presented secret with a stored SHA-256 hex digest. */
export function secretMatches(presented: string, storedHashHex: string): boolean {
  const stored = Buffer.from(storedHashHex, "hex");
  const actual = sha256(presented);
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}

function requestIdOf(value: string): string {
  if (!SUBAGENT_REQUEST_ID_PATTERN.test(value)) throw invalidRequest("Request ids look like sar_ followed by 32 hex characters.", [{ path: "id", message: "Invalid request id." }]);
  return value;
}

function maskWallet(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function displayAddress(walletKind: AccountWalletKind, stored: string): string {
  return walletKind === "evm" ? getAddress(stored) : stored;
}

function eventDecider(decider: SubagentDecider | null): SubagentEventData["decidedBy"] {
  if (!decider) return null;
  return decider.kind === "key" ? { kind: "key", keyId: decider.keyId } : { kind: "wallet", account: displayAddress(decider.walletKind, decider.address) };
}

function publishSubagentEvent(type: "agent.subagent_requested" | "agent.subagent_approved" | "agent.subagent_denied", record: SubagentRequestRecord): void {
  publishKeyEvent(type, {
    projectId: projectScope(record.projectId),
    keyId: record.parentKeyId,
    requestId: record.id,
    name: record.name,
    policyHash: record.policyHash,
    ...(record.childKeyId ? { childKeyId: record.childKeyId } : {}),
    ...(type === "agent.subagent_requested" ? {} : { decidedBy: eventDecider(record.decidedBy) }),
  });
}

/** The chain levels the subset checker reads (root first). */
function chainLevels(chain: KeyChain) {
  return chain.levels.map((level) => ({ policy: level.policy, defaults: level.defaults, id: level.id }));
}

/* ================================================================ settle */

/**
 * Lapses a request whose time is up: an open one past its expiry or under a
 * stopped parent, an approved one past its claim window (its unclaimed key is
 * revoked, so it never lingers). Returns the current record.
 */
async function settle(record: SubagentRequestRecord, now: number): Promise<SubagentRequestRecord> {
  const store = subagentRequestStore();
  const at = new Date(now).toISOString();
  if (record.status === "pending") {
    if (Date.parse(record.expiresAt) <= now) return (await store.transition(record.id, ["pending"], "expired", { reason: "not_decided" })) ?? (await store.get(record.id)) ?? record;
    const chain = await readKeyChain(record.parentKeyId, now);
    if (!chain?.keyActive) return (await store.transition(record.id, ["pending"], "cancelled", { reason: "parent_inactive", decidedAt: at })) ?? (await store.get(record.id)) ?? record;
    return record;
  }
  if (record.status === "approved" && record.decidedAt && Date.parse(record.decidedAt) + SUBAGENT_LIMITS.claimWindowSeconds * 1000 <= now) {
    const lapsed = await store.transition(record.id, ["approved"], "expired", { reason: "claim_window" });
    if (lapsed?.childKeyId) {
      const { cascade } = await apiKeyStore().revokeSubtree(lapsed.childKeyId, lapsed.projectId, at);
      for (const id of [lapsed.childKeyId, ...cascade]) forgetCachedKey(id);
      await recordKeyDecision({ projectId: lapsed.projectId, keyId: lapsed.childKeyId, actorKeyId: null, title: `Unclaimed sub-agent ${lapsed.name.slice(0, 64)} revoked (claim window passed)`, at: now });
    }
    return lapsed ?? (await store.get(record.id)) ?? record;
  }
  return record;
}

/* ================================================================== views */

export interface SubagentRequestView {
  readonly id: string;
  readonly status: SubagentRequestStatus;
  readonly projectId: string;
  readonly parentKeyId: string;
  readonly name: string;
  readonly purpose: string;
  readonly policy: PolicyDocument;
  readonly policyHash: string;
  readonly keyExpiresAt: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: { readonly kind: "wallet" | "key"; readonly id: string } | null;
  readonly childKeyId: string | null;
  readonly claimedAt: string | null;
  /** Until when the requester may claim an approved request. */
  readonly claimBy: string | null;
  readonly reason: string | null;
  /** What is granted, with the parent's own value beside each line. */
  readonly grant: readonly SubagentGrantLine[];
}

function view(record: SubagentRequestRecord, parentDocument: PolicyDocument | null): SubagentRequestView {
  const decider = record.decidedBy;
  return {
    id: record.id,
    status: record.status,
    projectId: projectScope(record.projectId),
    parentKeyId: record.parentKeyId,
    name: record.name,
    purpose: record.purpose,
    policy: record.policy,
    policyHash: record.policyHash,
    keyExpiresAt: record.keyExpiresAt,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt,
    decidedBy: decider ? { kind: decider.kind, id: decider.kind === "key" ? decider.keyId : maskWallet(displayAddress(decider.walletKind, decider.address)) } : null,
    childKeyId: record.childKeyId,
    claimedAt: record.claimedAt,
    claimBy: record.status === "approved" && record.decidedAt ? new Date(Date.parse(record.decidedAt) + SUBAGENT_LIMITS.claimWindowSeconds * 1000).toISOString() : null,
    reason: record.reason,
    grant: describeSubagentGrant(record.policy, parentDocument),
  };
}

/** Views of several records, reading each parent's active rule book once. */
async function views(records: readonly SubagentRequestRecord[], now: number): Promise<SubagentRequestView[]> {
  if (records.length === 0) return [];
  const projectId = records[0]?.projectId ?? "";
  const parents = [...new Set(records.map((record) => record.parentKeyId))];
  const { active } = await policyStore().activeMany(parents.map((id) => ({ scope: "key" as const, subjectId: id, projectId })), now);
  return records.map((record) => view(record, active.get(subjectKey("key", record.parentKeyId))?.document ?? null));
}

/* ================================================================ callers */

/** A key of the caller's project the caller may act on: project keys any; agent keys themselves and their descendants. */
async function visibleKey(auth: AuthContext, id: string): Promise<ApiKeyRecord> {
  if (!auth.projectId || !auth.keyId || auth.tier !== "developer") throw new HttpError(401, "API_KEY_REQUIRED", "Sub-agents need a project or agent API key.");
  if (auth.keyKind === "publishable") throw new PlatformError("PUBLISHABLE_KEY_FORBIDDEN", "Publishable keys cannot manage agents. Use a server key.", 403);
  const record = await apiKeyStore().findById(keyIdParam(id));
  const visible = record && record.projectId === auth.projectId && (auth.keyKind !== "agent" || record.id === auth.keyId || (record.lineage ?? []).includes(auth.keyId));
  if (!record || !visible) throw new HttpError(404, "KEY_NOT_FOUND", "No API key with this id in your subtree.");
  return record;
}

/** A request the caller may read: its parent is the caller or in the caller's subtree (project keys: the project). */
async function visibleRequest(auth: AuthContext, id: string, now: number): Promise<SubagentRequestRecord> {
  const record = await subagentRequestStore().get(requestIdOf(id));
  if (!record || record.projectId !== auth.projectId) throw requestNotFound();
  try {
    await visibleKey(auth, record.parentKeyId);
  } catch (error) {
    if (error instanceof HttpError && error.code === "KEY_NOT_FOUND") throw requestNotFound();
    throw error;
  }
  return settle(record, now);
}

/** A project key of the project with its current secret: the portal's decider. */
function projectKeyDecider(auth: AuthContext, record: SubagentRequestRecord): SubagentDecider {
  if (!auth.keyId || auth.tier === "public") throw new HttpError(401, "API_KEY_REQUIRED", "Decide with a project key, or send { message, signature } signed by the project's owner wallet.");
  if (auth.tier !== "developer" || auth.keyKind !== "project") throw approverNotAllowed("Only project keys (or the owner wallet) decide sub-agent requests; agent, publishable and operator keys never do.");
  if (auth.viaPreviousSecret) throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Decide with the current secret.", 403);
  if (auth.projectId !== record.projectId) throw requestNotFound();
  return { kind: "key", keyId: auth.keyId };
}

/* ================================================================ request */

export interface SubagentRequestInput {
  readonly name: string;
  readonly purpose: string;
  readonly policy: PolicyDocument;
  readonly expiresInSeconds: number;
}

/** `{ name, purpose, policy? | template? + fill?, expiresInSeconds? }` (default 7 days). */
export function parseSubagentRequest(body: unknown): SubagentRequestInput {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"name\", \"purpose\", \"policy\"? | \"template\"?, \"expiresInSeconds\"? }.", [{ path: "", message: "Expected an object." }]);
  const { purpose, ...rest } = body;
  const text = typeof purpose === "string" ? purpose.trim() : "";
  if (!text || [...text].length > SUBAGENT_LIMITS.purposeLength || /[\p{Cc}\p{Cf}]/u.test(text)) {
    throw invalidRequest(`Provide purpose with 1-${SUBAGENT_LIMITS.purposeLength} printable characters: what the sub-agent is for.`, [{ path: "purpose", message: "Required." }]);
  }
  const parsed = parseChildKeyRequest({ ...rest, expiresInSeconds: rest.expiresInSeconds ?? SUBAGENT_LIMITS.defaultTtlSeconds });
  return { name: parsed.name, purpose: text, policy: parsed.policy, expiresInSeconds: parsed.expiresInSeconds };
}

/** Depth, children and the subset check against a fresh chain; returns the document to mint. */
async function admissible(parent: ApiKeyRecord, chain: KeyChain, policy: PolicyDocument, keyExpiresAt: string, now: number, pendingOthers: number): Promise<PolicyDocument> {
  const depth = (parent.lineage ?? []).length + 1;
  if (depth > SUBAGENT_LIMITS.maxDepth) {
    throw new PlatformError("KEY_DEPTH_EXCEEDED", `Agent keys sit at most ${SUBAGENT_LIMITS.maxDepth} levels below a project key; ${parent.id} is already at depth ${depth - 1}.`, 409);
  }
  const children = (await apiKeyStore().listByProject(parent.projectId)).filter((record) => record.parentId === parent.id && keyLive(record, now)).length;
  if (children + pendingOthers >= SUBAGENT_LIMITS.childrenPerParent) {
    throw new PlatformError("SUBAGENT_LIMIT_REACHED", `A parent has at most ${SUBAGENT_LIMITS.childrenPerParent} sub-agents and open requests together.`, 409);
  }
  const checked = checkSubagentPolicy({ child: policy, chain: chainLevels(chain), childDepth: depth, childExpiresAt: keyExpiresAt, parentExpiresAt: parent.expiresAt ?? null });
  if (!checked.ok) throw notSubset(checked.issues);
  return checked.document;
}

export interface FiledSubagentRequest {
  readonly request: SubagentRequestView;
  /** Shown once; only its SHA-256 is stored. */
  readonly claimToken: string;
}

/** POST /v1/agents/{parentId}/subagents: the parent agent itself asks. */
export async function requestSubagent(auth: AuthContext, parentId: string, input: SubagentRequestInput, now = Date.now()): Promise<FiledSubagentRequest> {
  if (auth.keyKind !== "agent" || !auth.keyId || !auth.projectId) {
    throw agentForbidden("Sub-agents are requested by agent keys for themselves; project keys create agent keys directly with POST /v1/keys/{id}/children.");
  }
  if (auth.viaPreviousSecret) throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Use the current secret.", 403);
  if (keyIdParam(parentId) !== auth.keyId) throw agentForbidden("An agent requests sub-agents under itself only.");
  await assertAgentPermission(auth, "createChildKeys");
  const parent = await apiKeyStore().findById(auth.keyId);
  const chain = await readKeyChain(auth.keyId, now);
  if (!parent || !chain?.keyActive) throw parentInactive();
  const keyExpiresAt = new Date(now + input.expiresInSeconds * 1000).toISOString();
  const open = (await subagentRequestStore().list(parent.projectId, [parent.id], 100)).filter((record) => record.status === "pending" && Date.parse(record.expiresAt) > now).length;
  const document = await admissible(parent, chain, input.policy, keyExpiresAt, now, open);
  const claimToken = `kl_scl_${randomBytes(32).toString("base64url")}`;
  const record: SubagentRequestRecord = {
    id: `sar_${randomHex(16)}`,
    projectId: parent.projectId,
    parentKeyId: parent.id,
    name: input.name,
    purpose: input.purpose,
    policy: document,
    policyHash: policyHash(document),
    keyExpiresAt,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + SUBAGENT_LIMITS.requestTtlSeconds * 1000, Date.parse(keyExpiresAt))).toISOString(),
    decidedAt: null,
    decidedBy: null,
    childKeyId: null,
    claimTokenHash: sha256Hex(claimToken),
    claimedAt: null,
    challenge: null,
    reason: null,
  };
  await subagentRequestStore().create(record, SUBAGENT_LIMITS.openRequestsPerParent);
  await recordKeyDecision({ projectId: record.projectId, keyId: parent.id, actorKeyId: parent.id, title: `Sub-agent ${record.name.slice(0, 64)} requested (${record.id})`, at: now });
  publishSubagentEvent("agent.subagent_requested", record);
  return { request: view(record, chain.levels[chain.levels.length - 1]?.policy ?? null), claimToken };
}

/** GET /v1/agents/{id}/subagents: requests of `{id}` and its live children. */
export async function listSubagents(auth: AuthContext, id: string, now = Date.now()): Promise<{ readonly requests: SubagentRequestView[]; readonly children: AgentTreeNode[] }> {
  const parent = await visibleKey(auth, id);
  const records = await Promise.all((await subagentRequestStore().list(parent.projectId, [parent.id], 50)).map((record) => settle(record, now)));
  const tree = await buildTree(parent.projectId, (await apiKeyStore().listByProject(parent.projectId)).filter((record) => record.id === parent.id || (record.lineage ?? []).includes(parent.id)), now);
  return { requests: await views(records, now), children: tree[0]?.children ?? [] };
}

/** GET /v1/agents/requests/{id}. */
export async function getSubagentRequest(auth: AuthContext, id: string, now = Date.now()): Promise<SubagentRequestView> {
  const record = await visibleRequest(auth, id, now);
  return (await views([record], now))[0] as SubagentRequestView;
}

/* =================================================================== tree */

export interface AgentTreeNode {
  readonly id: string;
  readonly name: string;
  readonly kind: "project" | "agent";
  readonly parentId: string | null;
  readonly depth: number;
  readonly expiresAt: string | null;
  readonly active: boolean;
  /** The key's own mode, and the strictest of its chain (a paused parent pauses its subtree). */
  readonly mode: PolicyMode;
  readonly chainMode: PolicyMode;
  readonly policyVersion: number | null;
  readonly policyHash: string | null;
  readonly caps: PolicyDocument["caps"] | null;
  /** Counted exposure in the rolling windows (this key and everything below it). */
  readonly usage: { readonly dayUsd: string; readonly weekUsd: string };
  readonly children: AgentTreeNode[];
}

async function buildTree(projectId: string, records: readonly ApiKeyRecord[], now: number): Promise<AgentTreeNode[]> {
  const shown = records.filter((record) => keyKindOf(record) !== "publishable" && keyLive(record, now));
  const { active } = await policyStore().activeMany(
    [{ scope: "project" as const, subjectId: projectId, projectId }, ...shown.map((record) => ({ scope: "key" as const, subjectId: record.id, projectId }))],
    now,
  );
  const usage = await spendLedger().usage(shown.map((record) => record.id), now);
  const ownMode = (record: ApiKeyRecord): PolicyMode => {
    const document = active.get(subjectKey("key", record.id))?.document ?? (keyKindOf(record) === "agent" ? OBSERVER_POLICY : null);
    return document?.mode ?? "live";
  };
  const byId = new Map(shown.map((record) => [record.id, record]));
  const projectMode = active.get(subjectKey("project", projectId))?.document?.mode ?? "live";
  const node = (record: ApiKeyRecord): AgentTreeNode => {
    const version = active.get(subjectKey("key", record.id));
    const modes = [projectMode, ...[...(record.lineage ?? []), record.id].map((id) => (byId.get(id) ? ownMode(byId.get(id) as ApiKeyRecord) : "live"))];
    const used = usage.get(record.id);
    return {
      id: record.id,
      name: record.name,
      kind: keyKindOf(record) === "agent" ? "agent" : "project",
      parentId: record.parentId ?? null,
      depth: (record.lineage ?? []).length,
      expiresAt: record.expiresAt ?? null,
      active: true,
      mode: ownMode(record),
      chainMode: POLICY_MODES[Math.max(...modes.map((mode) => POLICY_MODES.indexOf(mode)))] ?? "live",
      policyVersion: version?.document ? version.version : null,
      policyHash: version?.document ? version.hash : null,
      caps: version?.document?.caps ?? null,
      usage: { dayUsd: formatUsdMicros(used?.dayUsdMicros ?? 0n), weekUsd: formatUsdMicros(used?.weekUsdMicros ?? 0n) },
      children: shown.filter((candidate) => candidate.parentId === record.id).map(node),
    };
  };
  return shown.filter((record) => !record.parentId || !byId.has(record.parentId)).map(node);
}

/** GET /v1/agents/tree: the caller's subtree (project keys: every key of the project) and its requests. */
export async function agentTree(auth: AuthContext, now = Date.now()): Promise<{ readonly nodes: AgentTreeNode[]; readonly requests: SubagentRequestView[] }> {
  if (!auth.projectId || !auth.keyId || auth.tier !== "developer") throw new HttpError(401, "API_KEY_REQUIRED", "The agent tree needs a project or agent API key.");
  const records = await apiKeyStore().listByProject(auth.projectId);
  const mine = auth.keyKind === "agent" ? records.filter((record) => record.id === auth.keyId || (record.lineage ?? []).includes(auth.keyId ?? "")) : records;
  const nodes = await buildTree(auth.projectId, mine, now);
  const parents = auth.keyKind === "agent" ? mine.map((record) => record.id) : null;
  const requests = await Promise.all((await subagentRequestStore().list(auth.projectId, parents, 100)).map((record) => settle(record, now)));
  return { nodes, requests: await views(requests, now) };
}

/* ================================================================ decide */

export interface ChallengeInput {
  readonly decision: SubagentDecision;
  readonly walletKind: AccountWalletKind;
  readonly address: string;
  readonly chainId: number | null;
}

/** `{ decision, walletKind, address, chainId? }` (the account sign-in rules for the wallet part). */
export function parseChallengeRequest(body: unknown): ChallengeInput {
  if (!isRecord(body)) throw invalidRequest("Body must be { \"decision\", \"walletKind\", \"address\", \"chainId\"? }.", [{ path: "", message: "Expected an object." }]);
  const { decision, ...wallet } = body;
  if (decision !== "approve" && decision !== "deny") throw invalidRequest("decision must be approve or deny.", [{ path: "decision", message: "Expected approve or deny." }]);
  return { decision, ...parseNonceRequest(wallet) };
}

/** The project's owner wallet, or a refusal (only the owner gets a message to sign). */
async function assertOwner(projectId: string, walletKind: AccountWalletKind, address: string): Promise<void> {
  const owner = await accountStore().ownerOf(projectId);
  if (!owner || owner.walletKind !== walletKind || owner.address !== address) {
    throw approverNotAllowed("Only the wallet that owns this project decides with a signature; use a project key otherwise.");
  }
}

/** POST /v1/agents/requests/{id}/challenge: the message the owner's wallet signs (single use, 10 minutes). */
export async function issueChallenge(origin: string | undefined, id: string, body: unknown, now = Date.now()): Promise<{ readonly message: string; readonly expiresAt: string }> {
  if (!accountOriginAllowed(origin)) throw new HttpError(403, "ACCOUNT_ORIGIN_FORBIDDEN", "Wallet decisions are signed in the Kletia developer portal only.");
  const input = parseChallengeRequest(body);
  const found = await subagentRequestStore().get(requestIdOf(id));
  if (!found) throw requestNotFound();
  const record = await settle(found, now);
  if (record.status !== "pending") throw decidedError(record.status);
  await assertOwner(record.projectId, input.walletKind, input.address);
  const nonce = randomBase62(24);
  const expiresAt = new Date(Math.min(now + SUBAGENT_LIMITS.challengeTtlSeconds * 1000, Date.parse(record.expiresAt))).toISOString();
  const message = subagentApprovalMessage({
    origin,
    walletKind: input.walletKind,
    address: displayAddress(input.walletKind, input.address),
    chainId: input.chainId,
    decision: input.decision,
    requestId: record.id,
    projectId: projectScope(record.projectId),
    parentKeyId: record.parentKeyId,
    name: record.name,
    policyHash: record.policyHash,
    document: record.policy,
    keyExpiresAt: record.keyExpiresAt,
    nonce,
    issuedAt: new Date(now).toISOString(),
    expiresAt,
  });
  const challenge: SubagentChallenge = { nonceHash: sha256Hex(nonce), message, origin, walletKind: input.walletKind, address: input.address, chainId: input.chainId, decision: input.decision, expiresAt };
  if (!(await subagentRequestStore().setChallenge(record.id, challenge))) throw decidedError((await subagentRequestStore().get(record.id))?.status ?? "cancelled");
  return { message, expiresAt };
}

function evmNetworkOf(chainId: number | null): EvmNetworkKey | null {
  const network = ACCOUNT_EVM_NETWORKS.find((key) => CHAINS[key].evmChainId === chainId);
  return (network as EvmNetworkKey | undefined) ?? null;
}

/** Verifies a wallet signature of the stored message; RPC_UNAVAILABLE when a smart account cannot be checked, never "valid on doubt". */
async function walletSignatureValid(challenge: SubagentChallenge, signature: string): Promise<boolean> {
  if (challenge.walletKind === "solana") return verifySolanaMessageSignature(challenge.address, challenge.message, signature);
  const network = evmNetworkOf(challenge.chainId);
  if (!network) return false;
  return verifyEvmMessageSignature({ client: () => evmClient(network), network, address: getAddress(challenge.address), message: challenge.message, signature });
}

/** `{ message, signature }` from the owner wallet: consumes the challenge first (single use), then checks the signature. */
async function walletDecider(record: SubagentRequestRecord, decision: SubagentDecision, body: Record<string, unknown>, origin: string | undefined, now: number): Promise<SubagentDecider> {
  const unknown = Object.keys(body).filter((key) => key !== "message" && key !== "signature");
  if (unknown.length > 0) throw invalidRequest("Unknown fields.", unknown.slice(0, 5).map((key) => ({ path: key, message: "Unknown field." })));
  const { message, signature } = body;
  if (typeof message !== "string" || message.length > 4_000 || typeof signature !== "string" || signature.length === 0 || signature.length > 4_000) {
    throw invalidRequest("Send { message, signature }: the message from …/challenge and the wallet's signature of it.", [{ path: "message", message: "Required." }]);
  }
  const nonce = subagentMessageNonce(message);
  if (!nonce) throw signatureInvalid();
  const challenge = await subagentRequestStore().consumeChallenge(record.id, sha256Hex(nonce), now);
  if (!challenge || challenge.message !== message || challenge.decision !== decision || challenge.origin !== origin) throw signatureInvalid();
  if (!(await walletSignatureValid(challenge, signature))) throw signatureInvalid("The signature does not match the message and the owner wallet.");
  // Ownership is read again: a project never changes owner, but a missing owner row fails closed.
  await assertOwner(record.projectId, challenge.walletKind, challenge.address);
  return { kind: "wallet", walletKind: challenge.walletKind, address: challenge.address };
}

/** Mints the approved key with a secret nobody sees and writes its rule book as version 1. */
async function mint(record: SubagentRequestRecord, parent: ApiKeyRecord, actor: string, now: number): Promise<string> {
  const issued = await issueAgentKey(record.name, parent, record.keyExpiresAt, MAX_ACTIVE_AGENT_KEYS_PER_PROJECT, now);
  try {
    const written = await policyStore().write({ scope: "key", subjectId: issued.id, projectId: record.projectId, next: record.policy, defaults: "agent", createdBy: actor, ifMatch: "none", now });
    if (written.applied !== "now") throw new Error(`sub-agent rule book ${written.applied}`);
    await announceAmended(written.version, null, now);
  } catch (error) {
    await apiKeyStore().revokeSubtree(issued.id, record.projectId, new Date(now).toISOString());
    forgetCachedKey(issued.id);
    throw error;
  }
  return issued.id;
}

/** POST /v1/agents/requests/{id}/approve | deny. */
export async function decideSubagentRequest(id: string, decision: SubagentDecision, auth: AuthContext, body: unknown, origin: string | undefined, now = Date.now()): Promise<SubagentRequestView> {
  const store = subagentRequestStore();
  const found = await store.get(requestIdOf(id));
  if (!found) throw requestNotFound();
  const record = await settle(found, now);
  const wanted: SubagentRequestStatus = decision === "approve" ? "approved" : "denied";
  if (body !== undefined && body !== null && !isRecord(body)) throw invalidRequest("Body must be empty (project key) or { message, signature } (owner wallet).", [{ path: "", message: "Expected an object." }]);
  const wallet = isRecord(body) && Object.keys(body).length > 0;
  if (record.status !== "pending") {
    // A project key repeating the same decision reads the final state (approved and later claimed counts as approved).
    const same = record.status === wanted || (wanted === "approved" && record.status === "claimed");
    if (same && !wallet && auth.keyKind === "project" && auth.projectId === record.projectId) return (await views([record], now))[0] as SubagentRequestView;
    throw decidedError(record.status);
  }
  const decider = wallet ? await walletDecider(record, decision, body as Record<string, unknown>, origin, now) : projectKeyDecider(auth, record);
  const actor = decider.kind === "key" ? decider.keyId : `wallet:${displayAddress(decider.walletKind, decider.address)}`;
  const at = new Date(now).toISOString();
  if (decision === "deny") {
    const denied = await store.transition(record.id, ["pending"], "denied", { decidedAt: at, decidedBy: decider });
    if (!denied) return decideSubagentRequest(id, decision, auth, undefined, origin, now);
    await recordKeyDecision({ projectId: denied.projectId, keyId: denied.parentKeyId, actorKeyId: decider.kind === "key" ? decider.keyId : null, title: `Sub-agent ${denied.name.slice(0, 64)} denied (${denied.id})`, at: now });
    publishSubagentEvent("agent.subagent_denied", denied);
    return (await views([denied], now))[0] as SubagentRequestView;
  }
  // Approval: the chain is read again; a stopped or narrowed parent never gets the key.
  const parent = await apiKeyStore().findById(record.parentKeyId);
  const chain = await readKeyChain(record.parentKeyId, now);
  if (!parent || !chain?.keyActive) {
    await store.transition(record.id, ["pending"], "cancelled", { reason: "parent_inactive", decidedAt: at });
    throw parentInactive();
  }
  const others = (await store.list(record.projectId, [record.parentKeyId], 100)).filter((entry) => entry.id !== record.id && entry.status === "pending" && Date.parse(entry.expiresAt) > now).length;
  await admissible(parent, chain, record.policy, record.keyExpiresAt, now, others);
  const approved = await store.transition(record.id, ["pending"], "approved", { decidedAt: at, decidedBy: decider });
  if (!approved) return decideSubagentRequest(id, decision, auth, undefined, origin, now);
  let childKeyId: string;
  try {
    childKeyId = await mint(approved, parent, actor, now);
  } catch (error) {
    await store.transition(record.id, ["approved"], "cancelled", { reason: "mint_failed" });
    if (error instanceof PlatformError || error instanceof HttpError) throw error;
    throw new PlatformError("STORE_UNAVAILABLE", "The sub-agent could not be minted; nothing was granted. Ask again.", 503);
  }
  const minted = (await store.transition(record.id, ["approved"], "approved", { childKeyId })) ?? { ...approved, childKeyId };
  await recordKeyDecision({ projectId: minted.projectId, keyId: childKeyId, actorKeyId: decider.kind === "key" ? decider.keyId : null, title: `Sub-agent ${minted.name.slice(0, 64)} approved under ${minted.parentKeyId} (${minted.id})`, at: now });
  publishKeyEvent("key.created", { projectId: projectScope(minted.projectId), keyId: childKeyId, kind: "agent", parentId: minted.parentKeyId, expiresAt: minted.keyExpiresAt });
  publishSubagentEvent("agent.subagent_approved", minted);
  return (await views([minted], now))[0] as SubagentRequestView;
}

/* ================================================================== claim */

export interface ClaimedSubagent {
  readonly key: { readonly id: string; readonly name: string; readonly key: string; readonly parentId: string; readonly expiresAt: string; readonly kind: "agent" };
  readonly policy: { readonly hash: string; readonly version: 1 };
}

/** POST /v1/agents/requests/{id}/claim `{ claimToken }`: the requester sets and receives the secret, once. */
export async function claimSubagent(auth: AuthContext, id: string, body: unknown, now = Date.now()): Promise<ClaimedSubagent> {
  const token = isRecord(body) && typeof body.claimToken === "string" ? body.claimToken : "";
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "claimToken") || !SUBAGENT_CLAIM_TOKEN_PATTERN.test(token)) {
    throw invalidRequest("Body must be { \"claimToken\": \"kl_scl_…\" } from the request.", [{ path: "claimToken", message: "Required." }]);
  }
  const found = await subagentRequestStore().get(requestIdOf(id));
  // Only the requesting parent claims; anyone else reads not found.
  if (!found || auth.keyId !== found.parentKeyId || auth.projectId !== found.projectId) throw requestNotFound();
  if (auth.viaPreviousSecret) throw claimInvalid("Claim with the parent's current secret.");
  if (!secretMatches(token, found.claimTokenHash)) throw claimInvalid();
  const record = await settle(found, now);
  if (record.status !== "approved" || !record.childKeyId) throw claimInvalid();
  const claimed = await subagentRequestStore().transition(record.id, ["approved"], "claimed", { claimedAt: new Date(now).toISOString() });
  if (!claimed?.childKeyId) throw claimInvalid();
  const secret = newSecretFor({ kind: "agent" });
  const rotated = await apiKeyStore()
    .rotate(claimed.childKeyId, claimed.projectId, secret.hash, secret.last4, new Date(now).toISOString(), null)
    .catch(() => null);
  forgetCachedKey(claimed.childKeyId);
  if (!rotated || !keyLive(rotated, now)) {
    // Nothing was handed out: the claim can be tried again inside the window.
    await subagentRequestStore().transition(record.id, ["claimed"], "approved", { claimedAt: null });
    throw new PlatformError("STORE_UNAVAILABLE", "The sub-agent's secret could not be set. Claim again.", 503);
  }
  return {
    key: { id: rotated.id, name: rotated.name, key: secret.key, parentId: claimed.parentKeyId, expiresAt: claimed.keyExpiresAt, kind: "agent" },
    policy: { hash: claimed.policyHash, version: 1 },
  };
}

/* ======================================================== revoke, pause */

/** POST /v1/agents/{id}/revoke: the key and its subtree (DELETE /v1/keys/{id} rules). */
export async function revokeSubagent(auth: AuthContext, id: string): Promise<{ readonly keyId: string; readonly revoked: readonly string[] }> {
  const target = await visibleKey(auth, id);
  if (keyKindOf(target) !== "agent") throw new HttpError(404, "KEY_NOT_FOUND", "No agent key with this id in your subtree; revoke project keys with DELETE /v1/keys/{id}.");
  const cascade = await revokeKey(auth, target.id);
  const revoked = [...new Set([target.id, ...cascade])];
  publishKeyEvent("agent.subagent_revoked", {
    projectId: projectScope(target.projectId),
    keyId: target.parentId ?? null,
    name: target.name,
    childKeyId: target.id,
    cascade: revoked,
    decidedBy: auth.keyId ? { kind: "key", keyId: auth.keyId } : null,
  });
  return { keyId: target.id, revoked };
}

/** POST /v1/agents/{id}/pause (project keys): `mode: "paused"`, a tightening that applies at once to the key and its subtree. */
export async function pauseAgent(auth: AuthContext, id: string, now = Date.now()): Promise<{ readonly keyId: string; readonly mode: "paused"; readonly version: number }> {
  if (auth.keyKind !== "project" || auth.tier !== "developer") throw agentForbidden("Only project keys pause agents; an agent may revoke its own sub-agents instead.");
  if (auth.viaPreviousSecret) throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Use the current secret.", 403);
  const target = await visibleKey(auth, id);
  if (keyKindOf(target) !== "agent" || !keyLive(target, now)) throw new HttpError(404, "KEY_NOT_FOUND", "No active agent key with this id in your project.");
  const heads = await policyStore().heads("key", target.id, now);
  const current = heads.active?.document ?? OBSERVER_POLICY;
  const written = await policyStore().write({
    scope: "key",
    subjectId: target.id,
    projectId: target.projectId,
    next: { ...current, mode: "paused" },
    defaults: "agent",
    createdBy: auth.keyId ?? "",
    ifMatch: heads.active?.hash ?? "none",
    now,
  });
  if (written.applied === "now") await announceAmended(written.version, auth.keyId ?? null, now);
  return { keyId: target.id, mode: "paused", version: written.version.version };
}

/* ======================================================== notifications */

/** GET /v1/agents/pending?account=<CAIP-10>: how many open requests wait in projects that wallet owns (a count only). */
export async function pendingForAccount(account: string | undefined, now = Date.now()): Promise<{ readonly pending: number }> {
  const parsed = account ? parseAccountId(account) : null;
  if (!parsed) throw invalidRequest("account must be a CAIP-10 account (eip155:<chain id>:0x… or solana:<genesis>:<address>).", [{ path: "account", message: "Invalid CAIP-10 account." }]);
  const walletKind: AccountWalletKind = parsed.chain.namespace === "solana" ? "solana" : "evm";
  const address = normalizeWallet(walletKind, parsed.address);
  if (!address) return { pending: 0 };
  const projects = await accountStore().projectsOf(walletKind, address);
  return { pending: await subagentRequestStore().countPending(projects.map((project) => project.projectId), now) };
}
