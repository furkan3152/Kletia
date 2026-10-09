/**
 * Verifiable intent receipts, `kletia.receipt/v1` (receipts design R1).
 *
 * A receipt is Kletia's Ed25519-signed statement about one finished intent:
 * a public skeleton (networks, step kinds, protocols, assets, statuses, day)
 * plus salted, path-bound SHA-256 commitments to private groups (request,
 * plan, timing, outcome, and per step parties, amounts and evidence).
 * Disclosures travel outside the signature, so a holder can share any subset
 * and the signature still verifies.
 *
 *   intentRef  = hex(SHA-256("kletia.intent-ref.v1:" + intentId))
 *   commitment = hex(SHA-256("kletia.disclosure.v1:" + JCS({ path, salt, value })))
 *   digest     = hex(SHA-256(JCS(payload)))
 *   signature  = Ed25519(key, "kletia.receipt.v1:" + digest)
 *   kid        = base64url(SHA-256(JCS({ crv: "Ed25519", kty: "OKP", x })))     (RFC 7638)
 *
 * Everything here is pure: `buildReceipt` never reads the chain (the engine's
 * `collectReceiptInputs` supplies anchors), `verifyReceipt` uses Web Crypto
 * only for Ed25519. JCS is the receipt profile of `receiptJcs`.
 */
import { CHAINS, isNetworkKey, type CaipChainId, type NetworkKey } from "./chains.js";
import type { AccountId, AssetId } from "./caip.js";
import { base64UrlDecode, base64UrlEncode, sha256, sha256Hex, timingSafeEqualString, toWellFormedString } from "./hash.js";
import { verifyMerkleInclusion } from "./merkle.js";
import type { ProtocolId } from "./protocols.js";
import { receiptAnchorIssues, type ReceiptAnchor } from "./receiptAnchors.js";
import { receiptJcs, ReceiptProfileError } from "./receiptProfile.js";
import type {
  AssetAmount,
  ExecutionMode,
  IntentActionKind,
  IntentGraph,
  IntentRequest,
  IntentStatus,
  IntentStep,
  StepStatus,
} from "./intent.js";

/* ================================================================ constants */

export const RECEIPT_SPEC_VERSION = "kletia.receipt/v1" as const;
export const RECEIPT_LOG_SPEC_VERSION = "kletia.receipt-log/v1" as const;
export const PLAN_RECORD_SPEC_VERSION = "kletia.plan/v1" as const;
/** `rcpt_` + 32 hex (128 random bits). */
export const RECEIPT_ID_PATTERN = /^rcpt_[0-9a-f]{32}$/u;
/** `rsh_` + 24 hex. */
export const RECEIPT_SHARE_ID_PATTERN = /^rsh_[0-9a-f]{24}$/u;
/** Receipt, request, plan and batch digests: lower-case hex SHA-256. */
export const RECEIPT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
/** Salts: base64url of 16 CSPRNG bytes. */
export const RECEIPT_SALT_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export const RECEIPT_SIGNING_PREFIX = "kletia.receipt.v1:";
export const RECEIPT_LOG_SIGNING_PREFIX = "kletia.receipt-log.v1:";
export const RECEIPT_DISCLOSURE_PREFIX = "kletia.disclosure.v1:";
export const RECEIPT_INTENT_REF_PREFIX = "kletia.intent-ref.v1:";
/** AES-256-GCM additional data of a share: prefix + receiptId + ":" + shareId (design §5.9). */
export const RECEIPT_SHARE_AAD_PREFIX = "kletia.receipt-share.v1:";
/** A receipt not included in a log batch this long after `issuedOn` gets `INCLUSION_OVERDUE`. */
export const RECEIPT_INCLUSION_GRACE_DAYS = 2;

export type ReceiptIntentStatus = "completed" | "partially_completed" | "failed" | "cancelled";
/** Intent statuses that get a receipt. Not `expired` (nothing executed) nor `indeterminate` (manual review first). */
export const RECEIPTABLE_STATUSES: readonly ReceiptIntentStatus[] = Object.freeze(["completed", "partially_completed", "failed", "cancelled"]);
/** Statuses whose receipt can never be superseded. */
export const TERMINAL_RECEIPT_STATUSES: readonly ReceiptIntentStatus[] = Object.freeze(["completed", "cancelled"]);

export function isReceiptableStatus(status: IntentStatus): status is ReceiptIntentStatus {
  return (RECEIPTABLE_STATUSES as readonly string[]).includes(status);
}

/** Intent-level disclosure groups. */
export const RECEIPT_INTENT_GROUPS = Object.freeze(["request", "plan", "timing", "outcome"] as const);
/** Per-step disclosure groups. */
export const RECEIPT_STEP_GROUPS = Object.freeze(["parties", "amounts", "evidence"] as const);
export type ReceiptIntentGroup = (typeof RECEIPT_INTENT_GROUPS)[number];
export type ReceiptStepGroup = (typeof RECEIPT_STEP_GROUPS)[number];

export type ReceiptProfile = "route" | "amounts" | "proof" | "full";
/** Share profiles (design §9.2) as group path patterns (`*` = every step). */
export const RECEIPT_PROFILES: Readonly<Record<ReceiptProfile, readonly string[]>> = Object.freeze({
  route: Object.freeze([]),
  amounts: Object.freeze(["steps.*.amounts", "intent.outcome"]),
  proof: Object.freeze(["steps.*.amounts", "intent.outcome", "steps.*.evidence", "intent.timing"]),
  full: Object.freeze([
    "intent.request",
    "intent.plan",
    "intent.timing",
    "intent.outcome",
    "steps.*.parties",
    "steps.*.amounts",
    "steps.*.evidence",
  ]),
});

export const RECEIPT_PROBLEM_CODES = Object.freeze([
  "SPEC_UNSUPPORTED",
  "SCHEMA_INVALID",
  "PROFILE_VIOLATION",
  "DIGEST_MISMATCH",
  "KEY_UNKNOWN",
  "KEY_NOT_YET_VALID",
  "KEY_REVOKED",
  "SIGNATURE_INVALID",
  "DISCLOSURE_PATH_UNKNOWN",
  "DISCLOSURE_INVALID",
  "DISCLOSURE_MISMATCH",
  "DISCLOSURE_MISSING",
  "INCLUSION_INVALID",
  "INTENT_REF_MISMATCH",
  /** SDK: a share link that does not decrypt. */
  "SHARE_DECRYPT_FAILED",
  /** SDK: an EAS envelope that does not verify. */
  "ATTESTATION_INVALID",
] as const);
export type ReceiptProblemCode = (typeof RECEIPT_PROBLEM_CODES)[number];

export const RECEIPT_WARNING_CODES = Object.freeze([
  "NOT_TERMINAL",
  "SEALED_GROUPS",
  "KEY_RETIRED",
  "KEY_DEVELOPMENT",
  "INCLUSION_PENDING",
  "INCLUSION_OVERDUE",
  /** Reverify: only one usable source per network. */
  "SINGLE_SOURCE",
] as const);
export type ReceiptWarningCode = (typeof RECEIPT_WARNING_CODES)[number];

/* ==================================================================== types */

/** An amount as carried by receipts: no formatted text, no float USD. */
export interface ReceiptAmount {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units, decimal integer string. */
  readonly amount: string;
}

export interface ReceiptIssuer {
  readonly name: "Kletia";
  /** "https://api.kletiaai.xyz" */
  readonly origin: string;
  /** PLATFORM_API_VERSION ("1.0.0" today). */
  readonly apiVersion: string;
  /** Must equal `signature.kid`. */
  readonly kid: string;
}

export interface ReceiptIntentSkeleton {
  /** hex sha256("kletia.intent-ref.v1:" + intentId). The id itself is a bearer capability and never appears. */
  readonly ref: string;
  readonly spec: "kletia.intent/v1";
  readonly status: ReceiptIntentStatus;
  /** completed / cancelled: true. failed / partially_completed: false (may be superseded). */
  readonly terminal: boolean;
  readonly lane: "production" | "testnet";
  readonly source: "structured" | "grammar" | "assistant";
  /** Step and destination networks, in first-use order. */
  readonly networks: readonly NetworkKey[];
  /** UTC day of the last state change. */
  readonly finishedOn: string;
  /** First reference submitted → last state change; null when nothing was submitted. */
  readonly durationSeconds: number | null;
  /** `none`: no anchors (cancelled, or nothing landed). */
  readonly finality: "finalized" | "none";
  readonly commitments: { readonly request: string; readonly plan: string; readonly timing: string; readonly outcome: string };
}

export interface ReceiptStepContract {
  readonly integrator: string;
  readonly domainVerified: boolean;
  readonly vm: "evm" | "svm";
  readonly target: string;
  readonly function: string | null;
  readonly definitionHash: string;
  readonly revision: number;
}

export interface ReceiptStepSkeleton {
  /** s1, s2, … */
  readonly id: string;
  readonly index: number;
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  readonly chain: CaipChainId;
  readonly protocol: ProtocolId;
  readonly mode: ExecutionMode;
  readonly status: StepStatus;
  readonly dependsOn: readonly string[];
  readonly settlement: { readonly kind: "same-network" | "cross-network"; readonly destinationNetwork: NetworkKey | null } | null;
  /** CAIP-19 ids only (no amounts). */
  readonly assets: { readonly input: AssetId | null; readonly output: AssetId | null };
  /** YIELD_VENUES id. */
  readonly venue: string | null;
  /** Call / action steps: the integrator's brand and the contract are public facts. */
  readonly contract: ReceiptStepContract | null;
  /** The message lives in the evidence group. */
  readonly failure: { readonly code: string } | null;
  readonly evidenceClass: "onchain" | "onchain+provider" | "none";
  readonly commitments: { readonly parties: string; readonly amounts: string; readonly evidence: string };
}

export interface ReceiptEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "funds" | "orders";
}

export interface ReceiptPayload {
  readonly spec: typeof RECEIPT_SPEC_VERSION;
  readonly receiptId: string;
  /** 1-based per intent. */
  readonly sequence: number;
  /** Digest of the receipt this one replaces, or null. */
  readonly supersedes: string | null;
  /** UTC day of signing (YYYY-MM-DD). The exact time is in the timing group. */
  readonly issuedOn: string;
  readonly issuer: ReceiptIssuer;
  readonly intent: ReceiptIntentSkeleton;
  readonly steps: readonly ReceiptStepSkeleton[];
  readonly edges: readonly ReceiptEdge[];
}

/* ------------------------------------------------------------ request and plan */

/** One structured action, projected into the profile (params as sorted `[key, type, value]`). */
export interface ReceiptRequestAction {
  readonly kind: string;
  readonly network: string;
  readonly from?: string;
  readonly to?: string;
  readonly amount?: string;
  readonly toNetwork?: string;
  readonly recipient?: string;
  readonly protocol?: string;
  readonly params?: readonly (readonly [string, "string" | "number" | "boolean", string])[];
  readonly contract?: string;
  readonly entry?: string;
}

/** `projectRequest(graph.request)`: user-keyed maps become sorted pairs, numbers that are not safe integers become decimal strings. */
export interface ReceiptRequest {
  readonly text?: string;
  readonly actions?: readonly ReceiptRequestAction[];
  readonly accounts: readonly string[];
  readonly defaultNetwork?: string;
  readonly constraints?: {
    readonly maxSlippageBps?: number | string;
    readonly deadline?: number | string;
    readonly maxFeeUsd?: string;
    readonly maxSeconds?: number | string;
    readonly preferProtocols?: readonly string[];
    readonly avoidProtocols?: readonly string[];
    readonly allowTestnets?: boolean;
  };
  readonly metadata?: readonly (readonly [string, string])[];
  readonly clientReference?: string;
}

export interface PlanRecordStep {
  readonly id: string;
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  readonly account: AccountId;
  readonly recipient: AccountId | null;
  readonly recipientName: string | null;
  readonly protocol: ProtocolId;
  readonly venue: string | null;
  readonly mode: ExecutionMode;
  readonly dependsOn: readonly string[];
  readonly input: ReceiptAmount | null;
  readonly expectedOutput: ReceiptAmount | null;
  readonly minimumOutput: ReceiptAmount | null;
  readonly extraCosts: readonly ReceiptAmount[];
  /** USD, 4 decimals. */
  readonly feesUsd: string | null;
  readonly estimatedSeconds: number | null;
  readonly settlement: { readonly kind: string; readonly destinationNetwork: NetworkKey | null; readonly expectedSeconds: number | null } | null;
  readonly call: { readonly contract: string; readonly revision: number; readonly definitionHash: string; readonly entry: string; readonly target: string } | null;
}

/** Immutable record of the plan as created (the graph mutates at every prepare). Digest = hex sha256(JCS(record)). */
export interface PlanRecord {
  readonly spec: typeof PLAN_RECORD_SPEC_VERSION;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly interpretation: {
    readonly source: string;
    readonly normalizedText: string | null;
    /** confidence × 10,000, rounded (floats never enter the profile). */
    readonly confidenceBps: number;
    readonly optimizations: readonly string[];
  };
  readonly steps: readonly PlanRecordStep[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------ disclosure groups */

export interface RequestGroup {
  /** hex sha256(JCS(request)). */
  readonly requestDigest: string;
  readonly request: ReceiptRequest;
}

export interface PlanGroup {
  /** `graph.plan.digest`; null for intents created before plan records. */
  readonly planDigest: string | null;
  readonly plan: PlanRecord | null;
  readonly reason?: "intent created before plan records";
}

export type ReceiptFinalityHead = { readonly chain: CaipChainId; readonly block: string } | { readonly chain: CaipChainId; readonly slot: string };
export interface ReceiptFinalityMode {
  readonly chain: CaipChainId;
  readonly mode: "finalized" | `depth:${number}`;
}

export interface TimingGroup {
  readonly createdAt: string;
  readonly firstSubmittedAt: string | null;
  readonly finishedAt: string;
  readonly issuedAt: string;
  /** Finalized heads read at issuance (the anchors carry their own block hashes). */
  readonly finalityHeads: readonly ReceiptFinalityHead[];
  readonly finalityMode: readonly ReceiptFinalityMode[];
}

export interface OutcomeGroup {
  readonly title: string;
  /** Consumed: inputs of submitted root steps. */
  readonly inputs: readonly ReceiptAmount[];
  /** Actual outputs, where observed. */
  readonly outputs: readonly ReceiptAmount[];
  readonly totalFeesUsd: string | null;
  readonly warnings: readonly string[];
}

export interface PartiesGroup {
  readonly account: AccountId;
  readonly recipient: AccountId | null;
  readonly recipientName: string | null;
  /** Cross-network steps: where the venue pays out. */
  readonly destinationAccount: AccountId | null;
}

export interface AmountsGroup {
  readonly input: ReceiptAmount | null;
  readonly expectedOutput: ReceiptAmount | null;
  readonly minimumOutput: ReceiptAmount | null;
  readonly actualOutput: ReceiptAmount | null;
  /** From the plan record: input and minimum as planned (base units). */
  readonly plannedInput: string | null;
  readonly plannedMinimum: string | null;
  readonly extraCosts: readonly ReceiptAmount[];
  readonly feesUsd: string | null;
}

export interface EvidenceGroup {
  /** Every prepared payload of the step. */
  readonly quotes: readonly { readonly binding: string; readonly preparedAt: string }[];
  /** EVM: the prepared binding the landed transactions reproduce. null on Solana and non-wallet steps. */
  readonly landedBinding: string | null;
  /** Origin transactions, then fills. */
  readonly anchors: readonly ReceiptAnchor[];
  readonly provider: { readonly name: "relay" | "lifi" | "debridge"; readonly trackingId: string; readonly kind: string } | null;
  readonly contract: { readonly contractId: string; readonly pins: unknown; readonly reviewDigest: string } | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  /** Kletia-attested notes from step.evidence. */
  readonly notes: readonly { readonly kind: string; readonly observedAt: string; readonly detail: string }[];
}

export type ReceiptGroupValue = RequestGroup | PlanGroup | TimingGroup | OutcomeGroup | PartiesGroup | AmountsGroup | EvidenceGroup;

export interface ReceiptDisclosure<V = ReceiptGroupValue> {
  /** base64url of 16 CSPRNG bytes. */
  readonly salt: string;
  readonly value: V;
}

export interface ReceiptLogBatch {
  readonly spec: typeof RECEIPT_LOG_SPEC_VERSION;
  readonly seq: number;
  readonly size: number;
  /** RFC 6962 Merkle Tree Hash over the leaves' digests. */
  readonly root: string;
  /** batchDigest of seq − 1, or null. */
  readonly previous: string | null;
  readonly closedOn: string;
}

export interface ReceiptInclusion {
  readonly batch: ReceiptLogBatch;
  /** base64url Ed25519 signature over "kletia.receipt-log.v1:" + batchDigest. */
  readonly batchSignature: string;
  readonly leafIndex: number;
  readonly path: readonly string[];
  readonly anchor: { readonly chain: CaipChainId; readonly contract: string; readonly timestamp: number; readonly tx: string } | null;
}

export interface ReceiptSignature {
  readonly alg: "Ed25519";
  readonly kid: string;
  /** base64url, 64 bytes. */
  readonly value: string;
}

/** The receipt document (`{ receipt }` in API responses). Only `payload` is signed. */
export interface ReceiptDocument {
  readonly payload: ReceiptPayload;
  readonly digest: string;
  readonly signature: ReceiptSignature;
  readonly disclosures?: Readonly<Record<string, ReceiptDisclosure>>;
  readonly inclusion?: ReceiptInclusion;
  readonly attestations?: { readonly eas?: unknown };
}

/** Output of the engine's `collectReceiptInputs(graph)` (receipts design §16.2, R2 → R3). */
export interface ReceiptCollection {
  readonly state: "ready" | "waiting_finality" | "retry" | "reorged";
  /** By step id: origin anchors in reference order, then fills. */
  readonly anchors: Readonly<Record<string, readonly ReceiptAnchor[]>>;
  /** By step id: the prepared binding the landed EVM transactions reproduce (null elsewhere). */
  readonly landedBindings: Readonly<Record<string, string | null>>;
  readonly finalityHeads: TimingGroup["finalityHeads"];
  readonly finalityMode: TimingGroup["finalityMode"];
  readonly expectedBy: string | null;
  readonly detail?: string;
}

/* ================================================================== digests */

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** hex sha256("kletia.intent-ref.v1:" + intentId). */
export function intentRef(intentId: string): string {
  return sha256Hex(`${RECEIPT_INTENT_REF_PREFIX}${intentId}`);
}

/** hex sha256(JCS(request)): hash what you receive, never re-project. */
export function receiptRequestDigest(request: ReceiptRequest): string {
  return sha256Hex(receiptJcs(request));
}

/** hex sha256(JCS(record)). */
export function planRecordDigest(record: PlanRecord): string {
  return sha256Hex(receiptJcs(record));
}

/** hex sha256(UTF8("kletia.disclosure.v1:") || JCS({ path, salt, value })). */
export function receiptCommitment(path: string, disclosure: { readonly salt: string; readonly value: unknown }): string {
  return sha256Hex(`${RECEIPT_DISCLOSURE_PREFIX}${receiptJcs({ path, salt: disclosure.salt, value: disclosure.value })}`);
}

/** hex sha256(JCS(payload)). Throws ReceiptProfileError outside the profile. */
export async function receiptDigest(payload: ReceiptPayload): Promise<string> {
  return sha256Hex(receiptJcs(payload));
}

/** The ASCII string the receipt key signs: "kletia.receipt.v1:" + digest (82 bytes). */
export function receiptSigningInput(digest: string): string {
  return `${RECEIPT_SIGNING_PREFIX}${digest}`;
}

/** hex sha256(JCS(batch)). */
export function receiptLogBatchDigest(batch: ReceiptLogBatch): string {
  return sha256Hex(receiptJcs(batch));
}

/** "kletia.receipt-log.v1:" + batchDigest. */
export function receiptLogSigningInput(batchDigest: string): string {
  return `${RECEIPT_LOG_SIGNING_PREFIX}${batchDigest}`;
}

/** RFC 7638 thumbprint of an Ed25519 public key `x` (base64url): the receipt `kid`. */
export function receiptKeyId(x: string): string {
  return base64UrlEncode(sha256(receiptJcs({ crv: "Ed25519", kty: "OKP", x })));
}

/** A fresh 128-bit salt (base64url) from the platform CSPRNG. */
export function randomReceiptSalt(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.getRandomValues) throw new Error("No CSPRNG is available in this runtime.");
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Dedupe digest of an intent's receiptable state (design §5.7; stored with
 * the receipt row, never inside the receipt): status and, per step, status,
 * references and fill references.
 */
export function receiptStateDigest(graph: IntentGraph, fills: Readonly<Record<string, readonly string[]>> = {}): string {
  return sha256Hex(
    receiptJcs({
      status: graph.status,
      steps: graph.steps.map((step) => ({
        id: step.id,
        status: step.status,
        references: [...(step.references ?? [])].map(toWellFormedString),
        fills: [...(fills[step.id] ?? [])].map(toWellFormedString),
      })),
    }),
  );
}

/* ============================================================== projections */

/** Plain decimal text of a finite number (no exponent); null otherwise. */
function decimalText(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(Object.is(value, -0) ? 0 : value);
  if (!/e/iu.test(text)) return text;
  const negative = value < 0;
  const [mantissa = "0", exponentText = "0"] = text.replace(/^-/u, "").toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const digits = whole + fraction;
  const point = whole.length + exponent;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/u, "");
  if (out.includes(".")) out = out.replace(/0+$/u, "").replace(/\.$/u, "");
  return `${negative ? "-" : ""}${out}`;
}

/** Safe integers stay numbers; anything else becomes decimal text (the profile has no floats). */
function profileNumber(value: number): number | string {
  return Number.isSafeInteger(value) && !Object.is(value, -0) ? value : decimalText(value) ?? "0";
}

/** USD as a decimal string with 4 decimals, or null when absent or not finite. */
export function receiptUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) >= 1e15) return null;
  const text = value.toFixed(4);
  return text === "-0.0000" ? "0.0000" : text;
}

const text = (value: string): string => toWellFormedString(value);

function receiptAmount(amount: AssetAmount | undefined): ReceiptAmount | null {
  if (!amount) return null;
  return { asset: amount.asset, symbol: text(amount.symbol), decimals: amount.decimals, amount: amount.amount };
}

function nonNegativeSeconds(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/** The request as the receipt profile carries it (receipts design §4.5). */
export function projectRequest(request: IntentRequest): ReceiptRequest {
  const actions = request.actions?.map((action): ReceiptRequestAction => {
    const params = action.params
      ? Object.entries(action.params)
          .map(([key, value]) => {
            const type = typeof value as "string" | "number" | "boolean";
            const shown = typeof value === "number" ? decimalText(value) ?? "0" : String(value);
            return [text(key), type, text(shown)] as const;
          })
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      : undefined;
    return {
      kind: action.kind,
      network: action.network,
      ...(action.from !== undefined ? { from: text(action.from) } : {}),
      ...(action.to !== undefined ? { to: text(action.to) } : {}),
      ...(action.amount !== undefined ? { amount: text(action.amount) } : {}),
      ...(action.toNetwork !== undefined ? { toNetwork: action.toNetwork } : {}),
      ...(action.recipient !== undefined ? { recipient: text(action.recipient) } : {}),
      ...(action.protocol !== undefined ? { protocol: action.protocol } : {}),
      ...(params ? { params } : {}),
      ...(action.contract !== undefined ? { contract: text(action.contract) } : {}),
      ...(action.entry !== undefined ? { entry: text(action.entry) } : {}),
    };
  });
  const constraints = request.constraints;
  const projectedConstraints = constraints
    ? {
        ...(constraints.maxSlippageBps !== undefined ? { maxSlippageBps: profileNumber(constraints.maxSlippageBps) } : {}),
        ...(constraints.deadline !== undefined ? { deadline: profileNumber(constraints.deadline) } : {}),
        ...(constraints.maxFeeUsd !== undefined && decimalText(constraints.maxFeeUsd) !== null ? { maxFeeUsd: decimalText(constraints.maxFeeUsd) as string } : {}),
        ...(constraints.maxSeconds !== undefined ? { maxSeconds: profileNumber(constraints.maxSeconds) } : {}),
        ...(constraints.preferProtocols ? { preferProtocols: [...constraints.preferProtocols] } : {}),
        ...(constraints.avoidProtocols ? { avoidProtocols: [...constraints.avoidProtocols] } : {}),
        ...(constraints.allowTestnets !== undefined ? { allowTestnets: constraints.allowTestnets } : {}),
      }
    : undefined;
  const metadata = request.metadata
    ? Object.entries(request.metadata)
        .map(([key, value]) => [text(key), text(value)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : undefined;
  return {
    ...(request.text !== undefined ? { text: text(request.text) } : {}),
    ...(actions ? { actions } : {}),
    accounts: request.accounts.map((account) => text(account)),
    ...(request.defaultNetwork !== undefined ? { defaultNetwork: request.defaultNetwork } : {}),
    ...(projectedConstraints ? { constraints: projectedConstraints } : {}),
    ...(metadata ? { metadata } : {}),
    ...(request.clientReference !== undefined ? { clientReference: text(request.clientReference) } : {}),
  };
}

/**
 * The immutable plan record (receipts design §4.5), captured once at
 * planning (also for dry runs). Its digest is `planRecordDigest(record)`.
 */
export function buildPlanRecord(graph: IntentGraph): PlanRecord {
  return {
    spec: PLAN_RECORD_SPEC_VERSION,
    createdAt: graph.createdAt,
    expiresAt: graph.expiresAt,
    interpretation: {
      source: graph.interpretation.source,
      normalizedText: graph.interpretation.normalizedText !== undefined ? text(graph.interpretation.normalizedText) : null,
      confidenceBps: Math.max(0, Math.min(10_000, Math.round((Number.isFinite(graph.interpretation.confidence) ? graph.interpretation.confidence : 0) * 10_000))),
      optimizations: (graph.interpretation.optimizations ?? []).map(text),
    },
    steps: graph.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      network: step.network,
      account: step.account,
      recipient: step.recipient ?? null,
      recipientName: step.recipientName !== undefined ? text(step.recipientName) : null,
      protocol: step.protocol,
      venue: step.venue ?? null,
      mode: step.mode,
      dependsOn: [...step.dependsOn],
      input: receiptAmount(step.input),
      expectedOutput: receiptAmount(step.expectedOutput),
      minimumOutput: receiptAmount(step.minimumOutput),
      extraCosts: (step.extraCosts ?? []).map((cost) => receiptAmount(cost) as ReceiptAmount),
      feesUsd: receiptUsd(step.feesUsd),
      estimatedSeconds: nonNegativeSeconds(step.estimatedSeconds),
      settlement: step.settlement
        ? {
            kind: step.settlement.kind,
            destinationNetwork: step.settlement.destinationNetwork ?? null,
            expectedSeconds: nonNegativeSeconds(step.settlement.expectedSeconds),
          }
        : null,
      call: step.call
        ? { contract: step.call.contract, revision: step.call.revision, definitionHash: step.call.definitionHash, entry: step.call.entry, target: step.call.target }
        : null,
    })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    warnings: graph.warnings.map(text),
  };
}

/* ================================================================ building */

export interface BuildReceiptInput {
  readonly graph: IntentGraph;
  readonly collection: ReceiptCollection;
  readonly receiptId: string;
  readonly sequence: number;
  readonly supersedes: string | null;
  /** ISO time of issuance; `issuedOn` is its UTC day. */
  readonly issuedAt: string;
  readonly issuer: ReceiptIssuer;
  /** Salt per group path; must return fresh base64url 16-byte salts (`randomReceiptSalt`). */
  readonly salts: (path: string) => string;
}

export interface BuiltReceipt {
  readonly payload: ReceiptPayload;
  readonly disclosures: Readonly<Record<string, ReceiptDisclosure>>;
}

const PROVIDERS: Partial<Record<ProtocolId, { readonly name: "relay" | "lifi" | "debridge"; readonly kind: string }>> = {
  relay: { name: "relay", kind: "request" },
  lifi: { name: "lifi", kind: "transfer" },
  "debridge-dln": { name: "debridge", kind: "order" },
};

const SUBMITTED_NOTE = "References submitted.";

function minIso(values: readonly string[]): string | null {
  let best: string | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const time = Date.parse(value);
    if (Number.isFinite(time) && time < bestTime) {
      best = new Date(time).toISOString();
      bestTime = time;
    }
  }
  return best;
}

function firstSubmittedAt(graph: IntentGraph): string | null {
  const submitted = graph.steps.filter((step) => (step.references ?? []).length > 0);
  if (submitted.length === 0) return null;
  const notes = submitted.flatMap((step) => step.evidence.filter((entry) => entry.kind === "note" && entry.detail === SUBMITTED_NOTE).map((entry) => entry.observedAt));
  return (
    minIso(notes) ??
    minIso(submitted.flatMap((step) => step.evidence.filter((entry) => entry.kind === "transaction" || entry.kind === "receipt").map((entry) => entry.observedAt)))
  );
}

/** Profile-safe copy of an arbitrary JSON-like value (pins): floats/bigints → strings, undefined dropped, odd keys → pairs. */
function profileValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return profileNumber(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : profileValue(entry)));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined && typeof entry !== "function");
    if (entries.every(([key]) => /^[A-Za-z0-9_.:-]{1,64}$/u.test(key))) {
      return Object.fromEntries(entries.map(([key, entry]) => [key, profileValue(entry)]));
    }
    return entries.map(([key, entry]) => [text(key), profileValue(entry)]).sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  }
  return null;
}

function laneOf(networks: readonly NetworkKey[]): "production" | "testnet" {
  return networks.some((network) => CHAINS[network].environment === "testnet") ? "testnet" : "production";
}

function stepChains(step: IntentStep): Set<string> {
  const chains = new Set<string>([step.chain]);
  const destination = step.settlement?.destinationNetwork;
  if (destination && isNetworkKey(destination)) chains.add(CHAINS[destination].id);
  return chains;
}

function assertSalt(path: string, salt: unknown): string {
  if (typeof salt !== "string" || !RECEIPT_SALT_PATTERN.test(salt) || base64UrlDecode(salt)?.length !== 16) {
    throw new Error(`Receipt salt for ${path} must be base64url of 16 random bytes.`);
  }
  return salt;
}

/**
 * Builds the signed payload and every disclosure of one receipt (pure; the
 * caller signs `receiptSigningInput(await receiptDigest(payload))`). Throws
 * when the intent is not receiptable, the collection is not `ready`, an
 * anchor sits on a chain the step does not touch, salts are malformed or
 * repeated, or the result falls outside the receipt profile.
 */
export function buildReceipt(input: BuildReceiptInput): BuiltReceipt {
  const { graph, collection, issuer } = input;
  if (!RECEIPT_ID_PATTERN.test(input.receiptId)) throw new Error("receiptId must be rcpt_ + 32 hex characters.");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("sequence must be a positive integer.");
  if (input.sequence === 1 ? input.supersedes !== null : !(typeof input.supersedes === "string" && RECEIPT_DIGEST_PATTERN.test(input.supersedes))) {
    throw new Error("supersedes must be null for sequence 1 and the previous receipt's digest otherwise.");
  }
  if (!ISO_TIME.test(input.issuedAt)) throw new Error("issuedAt must be an ISO 8601 UTC time.");
  if (issuer.name !== "Kletia" || !issuer.kid) throw new Error("issuer must name Kletia and carry the signing key id.");
  if (!isReceiptableStatus(graph.status)) throw new Error(`Intents in status ${graph.status} get no receipt.`);
  if (collection.state !== "ready") throw new Error(`Receipt inputs are not ready (${collection.state}); never issue on unfinalized data.`);
  if (graph.plan && planRecordDigest(graph.plan.record) !== graph.plan.digest) throw new Error("graph.plan.digest does not match its record.");

  const status = graph.status;
  const usedSalts = new Set<string>();
  const disclosures: Record<string, ReceiptDisclosure> = {};
  const commit = (path: string, value: ReceiptGroupValue): string => {
    const salt = assertSalt(path, input.salts(path));
    if (usedSalts.has(salt)) throw new Error(`Receipt salt for ${path} repeats another group's salt; salts must be fresh.`);
    usedSalts.add(salt);
    const disclosure = { salt, value };
    disclosures[path] = disclosure;
    return receiptCommitment(path, disclosure);
  };

  const networks: NetworkKey[] = [];
  const addNetwork = (network: NetworkKey | undefined) => {
    if (network && !networks.includes(network)) networks.push(network);
  };
  for (const step of graph.steps) {
    addNetwork(step.network);
    addNetwork(step.settlement?.destinationNetwork);
  }

  const anchorsOf = (step: IntentStep): readonly ReceiptAnchor[] => collection.anchors[step.id] ?? [];
  let anchorCount = 0;
  for (const step of graph.steps) {
    const chains = stepChains(step);
    for (const anchor of anchorsOf(step)) {
      const issues = receiptAnchorIssues(anchor);
      if (issues.length > 0) throw new Error(`Anchor of step ${step.id} is malformed (${issues.join(", ")}).`);
      if (!chains.has(anchor.chain)) throw new Error(`Anchor ${anchor.vm === "evm" ? anchor.tx : anchor.signature} of step ${step.id} is on ${anchor.chain}, which the step does not touch.`);
      anchorCount += 1;
    }
  }
  if (status === "cancelled" && anchorCount > 0) throw new Error("A cancelled intent cannot carry anchors.");

  const finishedAt = new Date(Date.parse(graph.updatedAt)).toISOString();
  const submittedAt = firstSubmittedAt(graph);
  const plannedSteps = new Map((graph.plan?.record.steps ?? []).map((step) => [step.id, step]));
  const fundedTargets = new Set(graph.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  const fundingSources = new Set(graph.edges.filter((edge) => edge.kind === "funds").map((edge) => edge.from));

  const request = projectRequest(graph.request);
  const intentCommitments = {
    request: commit("intent.request", { requestDigest: receiptRequestDigest(request), request }),
    plan: commit(
      "intent.plan",
      graph.plan ? { planDigest: graph.plan.digest, plan: graph.plan.record } : { planDigest: null, plan: null, reason: "intent created before plan records" },
    ),
    timing: commit("intent.timing", {
      createdAt: graph.createdAt,
      firstSubmittedAt: submittedAt,
      finishedAt,
      issuedAt: input.issuedAt,
      finalityHeads: collection.finalityHeads.map((head) => ({ ...head })),
      finalityMode: collection.finalityMode.map((mode) => ({ ...mode })),
    }),
    outcome: commit("intent.outcome", {
      title: text(graph.summary.title),
      inputs: graph.steps
        .filter((step) => !fundedTargets.has(step.id) && (step.references ?? []).length > 0 && step.input)
        .map((step) => receiptAmount(step.input) as ReceiptAmount),
      outputs: graph.steps
        .filter((step) => !fundingSources.has(step.id) && step.actualOutput)
        .map((step) => receiptAmount(step.actualOutput) as ReceiptAmount),
      totalFeesUsd: receiptUsd(graph.summary.totalFeesUsd),
      warnings: graph.warnings.map(text),
    }),
  };

  const steps = graph.steps.map((step): ReceiptStepSkeleton => {
    const anchors = anchorsOf(step);
    const provider = step.settlement?.trackingId && PROVIDERS[step.protocol]
      ? { ...(PROVIDERS[step.protocol] as { name: "relay" | "lifi" | "debridge"; kind: string }), trackingId: text(step.settlement.trackingId) }
      : null;
    const crossNetwork = step.settlement?.kind === "cross-network";
    const planned = plannedSteps.get(step.id);
    const quotes = step.evidence
      .filter((entry) => entry.kind === "quote" && typeof entry.reference === "string" && RECEIPT_DIGEST_PATTERN.test(entry.reference))
      .map((entry) => ({ binding: entry.reference as string, preparedAt: entry.observedAt }));
    if (step.prepared && !quotes.some((quote) => quote.binding === step.prepared?.quoteBinding)) {
      quotes.push({ binding: step.prepared.quoteBinding, preparedAt: step.prepared.preparedAt });
    }
    const landedBinding = collection.landedBindings[step.id] ?? null;
    if (landedBinding !== null && !quotes.some((quote) => quote.binding === landedBinding)) {
      throw new Error(`Step ${step.id}: the landed binding is not one of the step's prepared payloads.`);
    }
    const call = step.call;
    const commitments = {
      parties: commit(`steps.${step.id}.parties`, {
        account: step.account,
        recipient: step.recipient ?? null,
        recipientName: step.recipientName !== undefined ? text(step.recipientName) : null,
        destinationAccount: crossNetwork ? step.recipient ?? null : null,
      }),
      amounts: commit(`steps.${step.id}.amounts`, {
        input: receiptAmount(step.input),
        expectedOutput: receiptAmount(step.expectedOutput),
        minimumOutput: receiptAmount(step.minimumOutput),
        actualOutput: receiptAmount(step.actualOutput),
        plannedInput: planned?.input?.amount ?? null,
        plannedMinimum: planned?.minimumOutput?.amount ?? null,
        extraCosts: (step.extraCosts ?? []).map((cost) => receiptAmount(cost) as ReceiptAmount),
        feesUsd: receiptUsd(step.feesUsd),
      }),
      evidence: commit(`steps.${step.id}.evidence`, {
        quotes,
        landedBinding,
        anchors: anchors.map((anchor) => ({ ...anchor })),
        provider,
        contract: call
          ? {
              contractId: call.contract,
              pins: profileValue(call.pins ?? call.programs ?? null),
              reviewDigest: sha256Hex(receiptJcs(profileValue(call.review))),
            }
          : null,
        failure: step.failure ? { code: step.failure.code, message: text(step.failure.message) } : null,
        notes: step.evidence
          .filter((entry) => typeof entry.detail === "string" && entry.detail.length > 0)
          .map((entry) => ({ kind: entry.kind, observedAt: entry.observedAt, detail: text(entry.detail as string) })),
      }),
    };
    return {
      id: step.id,
      index: step.index,
      kind: step.kind,
      network: step.network,
      chain: step.chain,
      protocol: step.protocol,
      mode: step.mode,
      status: step.status,
      dependsOn: [...step.dependsOn],
      settlement: step.settlement ? { kind: step.settlement.kind, destinationNetwork: step.settlement.destinationNetwork ?? null } : null,
      assets: { input: step.input?.asset ?? null, output: (step.expectedOutput ?? step.minimumOutput ?? step.actualOutput)?.asset ?? null },
      venue: step.venue ?? null,
      contract: call
        ? {
            integrator: text(call.integrator.name),
            domainVerified: call.integrator.domainVerified,
            vm: call.vm,
            target: call.target,
            function: call.function ?? null,
            definitionHash: call.definitionHash,
            revision: call.revision,
          }
        : null,
      failure: step.failure ? { code: step.failure.code } : null,
      evidenceClass: anchors.length === 0 ? "none" : provider ? "onchain+provider" : "onchain",
      commitments,
    };
  });

  const durationSeconds = submittedAt === null ? null : Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(submittedAt)) / 1000));
  const payload: ReceiptPayload = {
    spec: RECEIPT_SPEC_VERSION,
    receiptId: input.receiptId,
    sequence: input.sequence,
    supersedes: input.supersedes,
    issuedOn: input.issuedAt.slice(0, 10),
    issuer: { name: "Kletia", origin: text(issuer.origin), apiVersion: text(issuer.apiVersion), kid: issuer.kid },
    intent: {
      ref: intentRef(graph.id),
      spec: graph.spec,
      status,
      terminal: (TERMINAL_RECEIPT_STATUSES as readonly string[]).includes(status),
      lane: laneOf(networks),
      source: graph.interpretation.source,
      networks,
      finishedOn: finishedAt.slice(0, 10),
      durationSeconds,
      finality: anchorCount > 0 ? "finalized" : "none",
      commitments: intentCommitments,
    },
    steps,
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
  };
  // Throws ReceiptProfileError (with a path) if anything slipped outside the profile.
  receiptJcs(payload);
  return { payload, disclosures };
}

/** Every commitment slot of a payload (`intent.request`, …, `steps.<id>.evidence`). */
export function receiptGroupSlots(payload: Pick<ReceiptPayload, "steps">): string[] {
  return [
    ...RECEIPT_INTENT_GROUPS.map((group) => `intent.${group}`),
    ...payload.steps.flatMap((step) => RECEIPT_STEP_GROUPS.map((group) => `steps.${step.id}.${group}`)),
  ];
}

/** Expands group patterns (`steps.*.evidence`) or a profile name into the concrete slots of a payload. */
export function receiptGroupPaths(patterns: ReceiptProfile | readonly string[], payload: Pick<ReceiptPayload, "steps">): string[] {
  const list = typeof patterns === "string" ? RECEIPT_PROFILES[patterns] : patterns;
  const slots = receiptGroupSlots(payload);
  const out: string[] = [];
  for (const pattern of list) {
    const matches = pattern.includes("*") ? slots.filter((slot) => matchesPattern(pattern, slot)) : slots.filter((slot) => slot === pattern);
    for (const match of matches) if (!out.includes(match)) out.push(match);
  }
  return out;
}

function matchesPattern(pattern: string, slot: string): boolean {
  const parts = pattern.split(".");
  const target = slot.split(".");
  return parts.length === target.length && parts.every((part, index) => part === "*" || part === target[index]);
}

/** The subset of disclosures for the given paths (holders share any subset; the signature still verifies). */
export function selectReceiptDisclosures(
  disclosures: Readonly<Record<string, ReceiptDisclosure>>,
  paths: readonly string[],
): Record<string, ReceiptDisclosure> {
  const out: Record<string, ReceiptDisclosure> = {};
  for (const path of paths) {
    const disclosure = disclosures[path];
    if (disclosure) out[path] = disclosure;
  }
  return out;
}

/* ============================================================== verification */

export interface ReceiptKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  /** base64url public key (32 bytes). */
  readonly x: string;
  /** RFC 7638 thumbprint of `x` (`receiptKeyId`). */
  readonly kid: string;
  readonly alg: "Ed25519";
  readonly use: "sig";
  readonly status: "active" | "next" | "retired" | "revoked" | "development";
  /** YYYY-MM-DD: first day the key may sign. */
  readonly notBefore: string;
  /** YYYY-MM-DD: receipts with issuedOn >= revokedOn are invalid. */
  readonly revokedOn?: string;
}

/**
 * Production receipt keys pinned at release time. Empty until the operator
 * generates the production key: every receipt then needs a supplied key
 * (`provenance: "supplied"`), fetched from two origins by the SDK.
 */
export const KLETIA_RECEIPT_KEY_PINS: readonly ReceiptKey[] = Object.freeze([]);

export interface VerifyReceiptOptions {
  /** Extra keys (e.g. GET /v1/receipts/keys cross-checked with the web origin's mirror). Pins are always consulted first. */
  readonly keys?: readonly ReceiptKey[];
  /** Checks `intent.ref`. */
  readonly intentId?: string;
  /** Group paths or patterns that must be disclosed, e.g. ["steps.*.evidence"]. */
  readonly requireGroups?: readonly string[];
  /** Evaluation time for inclusion warnings (default: now). */
  readonly now?: number | Date;
  /** Replaces KLETIA_RECEIPT_KEY_PINS (tests and private deployments). */
  readonly pins?: readonly ReceiptKey[];
}

export interface ReceiptProblem {
  readonly code: ReceiptProblemCode;
  readonly path?: string;
  readonly message: string;
}

export interface ReceiptWarning {
  readonly code: ReceiptWarningCode;
  readonly message: string;
}

export interface ReceiptVerification {
  readonly valid: boolean;
  /** Recomputed digest ("" when the payload is not even well formed). */
  readonly digest: string;
  readonly kid: string;
  /** `none`: no key matched (KEY_UNKNOWN). */
  readonly key: { readonly status: ReceiptKey["status"] | "unknown"; readonly provenance: "pinned" | "supplied" | "none" };
  readonly disclosed: readonly string[];
  readonly sealed: readonly string[];
  readonly inclusion: { readonly valid: boolean; readonly batch: number } | null;
  readonly intentMatches: boolean | null;
  readonly problems: readonly ReceiptProblem[];
  readonly warnings: readonly ReceiptWarning[];
}

/* ------------------------------------------------------------ schema helpers */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const HEX64 = RECEIPT_DIGEST_PATTERN;
const USD4 = /^-?(?:0|[1-9]\d*)\.\d{4}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const STEP_ID = /^[A-Za-z0-9_-]{1,32}$/u;
const NETWORK_TEXT = /^[a-z0-9-]{1,32}$/u;
const CAIP2_TEXT = /^(?:eip155|solana):[-_a-zA-Z0-9]{1,32}$/u;
const CAIP10_TEXT = /^(?:eip155|solana):[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/u;
const CAIP19_TEXT = /^(?:eip155|solana):[-_a-zA-Z0-9]{1,32}\/[-a-z0-9]{3,8}:[-.%a-zA-Z0-9]{1,128}$/u;
const KINDS = new Set(["swap", "transfer", "bridge", "stake", "unstake", "deposit", "withdraw", "borrow", "repay", "approve", "claim", "read", "call", "action"]);
const STEP_STATUSES = new Set(["pending", "ready", "awaiting_signature", "submitted", "confirmed", "settling", "settled", "failed", "skipped", "indeterminate"]);
const MODES = new Set(["wallet", "settlement", "read"]);

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
const isString = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const isNullable = <T>(value: unknown, test: (entry: unknown) => entry is T): boolean => value === null || test(value);
const isUint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIsoTime = (value: unknown): value is string => typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
const isDay = (value: unknown): value is string => typeof value === "string" && DAY.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const isHex64 = (value: unknown): value is string => typeof value === "string" && HEX64.test(value);
const isUsd = (value: unknown): boolean => value === null || (typeof value === "string" && USD4.test(value));
const isCaip10 = (value: unknown): value is string => typeof value === "string" && CAIP10_TEXT.test(value);

function isReceiptAmount(value: unknown): value is ReceiptAmount {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["asset", "symbol", "decimals", "amount"]) &&
    typeof value.asset === "string" &&
    CAIP19_TEXT.test(value.asset) &&
    isString(value.symbol, 64) &&
    isUint(value.decimals) &&
    value.decimals <= 36 &&
    typeof value.amount === "string" &&
    DECIMAL.test(value.amount)
  );
}
const isAmountOrNull = (value: unknown): boolean => value === null || isReceiptAmount(value);
const isAmountList = (value: unknown): boolean => Array.isArray(value) && value.every(isReceiptAmount);
const isStringList = (value: unknown, max = 4096): boolean => Array.isArray(value) && value.every((entry) => isString(entry, max));

function payloadSchemaIssues(payload: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const check = (ok: boolean, path: string) => {
    if (!ok) issues.push(path);
  };
  if (!hasExactKeys(payload, ["spec", "receiptId", "sequence", "supersedes", "issuedOn", "issuer", "intent", "steps", "edges"])) return ["payload"];
  check(typeof payload.receiptId === "string" && RECEIPT_ID_PATTERN.test(payload.receiptId), "payload.receiptId");
  check(isUint(payload.sequence) && payload.sequence >= 1, "payload.sequence");
  check(payload.sequence === 1 ? payload.supersedes === null : isHex64(payload.supersedes), "payload.supersedes");
  check(isDay(payload.issuedOn), "payload.issuedOn");
  const issuer = payload.issuer;
  check(
    isRecord(issuer) &&
      hasExactKeys(issuer, ["name", "origin", "apiVersion", "kid"]) &&
      issuer.name === "Kletia" &&
      isString(issuer.origin, 256) &&
      isString(issuer.apiVersion, 32) &&
      isString(issuer.kid, 128),
    "payload.issuer",
  );
  const intent = payload.intent;
  if (
    !isRecord(intent) ||
    !hasExactKeys(intent, ["ref", "spec", "status", "terminal", "lane", "source", "networks", "finishedOn", "durationSeconds", "finality", "commitments"])
  ) {
    issues.push("payload.intent");
  } else {
    check(isHex64(intent.ref), "payload.intent.ref");
    check(intent.spec === "kletia.intent/v1", "payload.intent.spec");
    const status = intent.status;
    check(typeof status === "string" && (RECEIPTABLE_STATUSES as readonly string[]).includes(status), "payload.intent.status");
    check(intent.terminal === (status === "completed" || status === "cancelled"), "payload.intent.terminal");
    check(intent.lane === "production" || intent.lane === "testnet", "payload.intent.lane");
    check(intent.source === "structured" || intent.source === "grammar" || intent.source === "assistant", "payload.intent.source");
    check(Array.isArray(intent.networks) && intent.networks.length > 0 && intent.networks.every((network) => typeof network === "string" && NETWORK_TEXT.test(network)), "payload.intent.networks");
    check(isDay(intent.finishedOn), "payload.intent.finishedOn");
    check(intent.durationSeconds === null || isUint(intent.durationSeconds), "payload.intent.durationSeconds");
    check(intent.finality === "finalized" || intent.finality === "none", "payload.intent.finality");
    const commitments = intent.commitments;
    check(
      isRecord(commitments) && hasExactKeys(commitments, ["request", "plan", "timing", "outcome"]) && Object.values(commitments).every(isHex64),
      "payload.intent.commitments",
    );
  }
  if (!Array.isArray(payload.steps) || payload.steps.length === 0 || payload.steps.length > 16) {
    issues.push("payload.steps");
  } else {
    const ids = new Set<string>();
    payload.steps.forEach((step, index) => {
      const path = `payload.steps[${index}]`;
      if (
        !isRecord(step) ||
        !hasExactKeys(step, ["id", "index", "kind", "network", "chain", "protocol", "mode", "status", "dependsOn", "settlement", "assets", "venue", "contract", "failure", "evidenceClass", "commitments"])
      ) {
        issues.push(path);
        return;
      }
      check(typeof step.id === "string" && STEP_ID.test(step.id) && !ids.has(step.id), `${path}.id`);
      if (typeof step.id === "string") ids.add(step.id);
      check(isUint(step.index), `${path}.index`);
      check(typeof step.kind === "string" && KINDS.has(step.kind), `${path}.kind`);
      check(typeof step.network === "string" && NETWORK_TEXT.test(step.network), `${path}.network`);
      check(typeof step.chain === "string" && CAIP2_TEXT.test(step.chain) && (!isNetworkKey(step.network) || CHAINS[step.network].id === step.chain), `${path}.chain`);
      check(isString(step.protocol, 64), `${path}.protocol`);
      check(typeof step.mode === "string" && MODES.has(step.mode), `${path}.mode`);
      check(typeof step.status === "string" && STEP_STATUSES.has(step.status), `${path}.status`);
      check(isStringList(step.dependsOn, 32), `${path}.dependsOn`);
      const settlement = step.settlement;
      check(
        settlement === null ||
          (isRecord(settlement) &&
            hasExactKeys(settlement, ["kind", "destinationNetwork"]) &&
            (settlement.kind === "same-network" || settlement.kind === "cross-network") &&
            (settlement.destinationNetwork === null || (typeof settlement.destinationNetwork === "string" && NETWORK_TEXT.test(settlement.destinationNetwork)))),
        `${path}.settlement`,
      );
      const assets = step.assets;
      check(
        isRecord(assets) &&
          hasExactKeys(assets, ["input", "output"]) &&
          [assets.input, assets.output].every((asset) => asset === null || (typeof asset === "string" && CAIP19_TEXT.test(asset))),
        `${path}.assets`,
      );
      check(step.venue === null || isString(step.venue, 128), `${path}.venue`);
      const contract = step.contract;
      check(
        contract === null ||
          (isRecord(contract) &&
            hasExactKeys(contract, ["integrator", "domainVerified", "vm", "target", "function", "definitionHash", "revision"]) &&
            isString(contract.integrator, 64) &&
            typeof contract.domainVerified === "boolean" &&
            (contract.vm === "evm" || contract.vm === "svm") &&
            isString(contract.target, 256) &&
            (contract.function === null || isString(contract.function, 512)) &&
            isHex64(contract.definitionHash) &&
            isUint(contract.revision)),
        `${path}.contract`,
      );
      check(step.failure === null || (isRecord(step.failure) && hasExactKeys(step.failure, ["code"]) && isString(step.failure.code, 64)), `${path}.failure`);
      check(step.evidenceClass === "onchain" || step.evidenceClass === "onchain+provider" || step.evidenceClass === "none", `${path}.evidenceClass`);
      const commitments = step.commitments;
      check(
        isRecord(commitments) && hasExactKeys(commitments, ["parties", "amounts", "evidence"]) && Object.values(commitments).every(isHex64),
        `${path}.commitments`,
      );
    });
  }
  check(
    Array.isArray(payload.edges) &&
      payload.edges.every(
        (edge) =>
          isRecord(edge) && hasExactKeys(edge, ["from", "to", "kind"]) && isString(edge.from, 32) && isString(edge.to, 32) && (edge.kind === "funds" || edge.kind === "orders"),
      ),
    "payload.edges",
  );
  return issues;
}

function groupSchemaIssues(path: string, value: unknown): string[] {
  if (!isRecord(value)) return ["value must be an object"];
  const group = path.split(".").pop();
  const issues: string[] = [];
  const check = (ok: boolean, field: string) => {
    if (!ok) issues.push(field);
  };
  switch (path.startsWith("intent.") ? `intent.${group}` : `step.${group}`) {
    case "intent.request":
      if (!hasExactKeys(value, ["requestDigest", "request"])) return ["fields"];
      check(isHex64(value.requestDigest), "requestDigest");
      check(isRecord(value.request) && isStringList(value.request.accounts, 256), "request");
      return issues;
    case "intent.plan":
      if (!hasExactKeys(value, ["planDigest", "plan"], ["reason"])) return ["fields"];
      check(value.planDigest === null || isHex64(value.planDigest), "planDigest");
      check(value.plan === null || (isRecord(value.plan) && value.plan.spec === PLAN_RECORD_SPEC_VERSION), "plan");
      check(value.reason === undefined || value.reason === "intent created before plan records", "reason");
      return issues;
    case "intent.timing":
      if (!hasExactKeys(value, ["createdAt", "firstSubmittedAt", "finishedAt", "issuedAt", "finalityHeads", "finalityMode"])) return ["fields"];
      check(isIsoTime(value.createdAt), "createdAt");
      check(value.firstSubmittedAt === null || isIsoTime(value.firstSubmittedAt), "firstSubmittedAt");
      check(isIsoTime(value.finishedAt), "finishedAt");
      check(isIsoTime(value.issuedAt), "issuedAt");
      check(
        Array.isArray(value.finalityHeads) &&
          value.finalityHeads.every(
            (head) =>
              isRecord(head) &&
              typeof head.chain === "string" &&
              CAIP2_TEXT.test(head.chain) &&
              ((hasExactKeys(head, ["chain", "block"]) && typeof head.block === "string" && DECIMAL.test(head.block)) ||
                (hasExactKeys(head, ["chain", "slot"]) && typeof head.slot === "string" && DECIMAL.test(head.slot))),
          ),
        "finalityHeads",
      );
      check(
        Array.isArray(value.finalityMode) &&
          value.finalityMode.every(
            (mode) =>
              isRecord(mode) &&
              hasExactKeys(mode, ["chain", "mode"]) &&
              typeof mode.chain === "string" &&
              CAIP2_TEXT.test(mode.chain) &&
              typeof mode.mode === "string" &&
              /^(?:finalized|depth:[1-9]\d{0,5})$/u.test(mode.mode),
          ),
        "finalityMode",
      );
      return issues;
    case "intent.outcome":
      if (!hasExactKeys(value, ["title", "inputs", "outputs", "totalFeesUsd", "warnings"])) return ["fields"];
      check(isString(value.title, 1000), "title");
      check(isAmountList(value.inputs), "inputs");
      check(isAmountList(value.outputs), "outputs");
      check(isUsd(value.totalFeesUsd), "totalFeesUsd");
      check(isStringList(value.warnings), "warnings");
      return issues;
    case "step.parties":
      if (!hasExactKeys(value, ["account", "recipient", "recipientName", "destinationAccount"])) return ["fields"];
      check(isCaip10(value.account), "account");
      check(isNullable(value.recipient, isCaip10), "recipient");
      check(value.recipientName === null || isString(value.recipientName, 253), "recipientName");
      check(isNullable(value.destinationAccount, isCaip10), "destinationAccount");
      return issues;
    case "step.amounts":
      if (!hasExactKeys(value, ["input", "expectedOutput", "minimumOutput", "actualOutput", "plannedInput", "plannedMinimum", "extraCosts", "feesUsd"])) return ["fields"];
      for (const field of ["input", "expectedOutput", "minimumOutput", "actualOutput"]) check(isAmountOrNull(value[field]), field);
      for (const field of ["plannedInput", "plannedMinimum"]) check(value[field] === null || (typeof value[field] === "string" && DECIMAL.test(value[field] as string)), field);
      check(isAmountList(value.extraCosts), "extraCosts");
      check(isUsd(value.feesUsd), "feesUsd");
      return issues;
    case "step.evidence": {
      if (!hasExactKeys(value, ["quotes", "landedBinding", "anchors", "provider", "contract", "failure", "notes"])) return ["fields"];
      check(
        Array.isArray(value.quotes) && value.quotes.every((quote) => isRecord(quote) && hasExactKeys(quote, ["binding", "preparedAt"]) && isHex64(quote.binding) && isIsoTime(quote.preparedAt)),
        "quotes",
      );
      check(value.landedBinding === null || isHex64(value.landedBinding), "landedBinding");
      if (
        isHex64(value.landedBinding) &&
        Array.isArray(value.quotes) &&
        !value.quotes.some((quote) => isRecord(quote) && quote.binding === value.landedBinding)
      ) {
        issues.push("landedBinding is not one of the quotes");
      }
      if (!Array.isArray(value.anchors)) issues.push("anchors");
      else value.anchors.forEach((anchor, index) => issues.push(...receiptAnchorIssues(anchor).map((field) => `anchors[${index}].${field}`)));
      const provider = value.provider;
      check(
        provider === null ||
          (isRecord(provider) &&
            hasExactKeys(provider, ["name", "trackingId", "kind"]) &&
            (provider.name === "relay" || provider.name === "lifi" || provider.name === "debridge") &&
            isString(provider.trackingId, 256) &&
            isString(provider.kind, 32)),
        "provider",
      );
      const contract = value.contract;
      check(
        contract === null ||
          (isRecord(contract) && hasExactKeys(contract, ["contractId", "pins", "reviewDigest"]) && isString(contract.contractId, 64) && isHex64(contract.reviewDigest)),
        "contract",
      );
      check(value.failure === null || (isRecord(value.failure) && hasExactKeys(value.failure, ["code", "message"]) && isString(value.failure.code, 64) && isString(value.failure.message)), "failure");
      check(
        Array.isArray(value.notes) &&
          value.notes.every((note) => isRecord(note) && hasExactKeys(note, ["kind", "observedAt", "detail"]) && isString(note.kind, 32) && isIsoTime(note.observedAt) && isString(note.detail)),
        "notes",
      );
      return issues;
    }
    default:
      return ["unknown group"];
  }
}

/* ------------------------------------------------------------ Ed25519 */

/** RFC 8032 verification through Web Crypto (Node 20+, Chrome 137+, Firefox 129+, Safari 17+). Never throws. */
export async function verifyEd25519(x: string, message: string, signature: string): Promise<boolean> {
  const publicKey = base64UrlDecode(x);
  const signatureBytes = base64UrlDecode(signature);
  if (!publicKey || publicKey.length !== 32 || !signatureBytes || signatureBytes.length !== 64) return false;
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) return false;
  try {
    const key = await subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signatureBytes), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

function isReceiptKey(value: unknown): value is ReceiptKey {
  return (
    isRecord(value) &&
    value.kty === "OKP" &&
    value.crv === "Ed25519" &&
    typeof value.x === "string" &&
    typeof value.kid === "string" &&
    (value.alg === undefined || value.alg === "Ed25519") &&
    typeof value.status === "string" &&
    ["active", "next", "retired", "revoked", "development"].includes(value.status) &&
    isDay(value.notBefore) &&
    (value.revokedOn === undefined || isDay(value.revokedOn))
  );
}

/** A key usable for `kid`: well formed and its kid is the thumbprint of its x. */
function findKey(kid: string, pins: readonly ReceiptKey[], supplied: readonly ReceiptKey[]): { key: ReceiptKey; provenance: "pinned" | "supplied" } | null {
  for (const [list, provenance] of [[pins, "pinned"], [supplied, "supplied"]] as const) {
    for (const key of list) {
      if (isReceiptKey(key) && key.kid === kid && receiptKeyId(key.x) === kid) return { key, provenance };
    }
  }
  return null;
}

function keyUsableOn(key: ReceiptKey, day: string): "ok" | "not_yet" | "revoked" {
  if (day < key.notBefore) return "not_yet";
  if (key.revokedOn !== undefined ? day >= key.revokedOn : key.status === "revoked") return "revoked";
  return "ok";
}

/** Verifies a log batch signature with any known key valid on the batch's day. */
export async function verifyReceiptLogBatch(
  batch: ReceiptLogBatch,
  signature: string,
  keys: readonly ReceiptKey[],
): Promise<{ readonly valid: boolean; readonly kid: string | null; readonly batchDigest: string }> {
  const batchDigest = receiptLogBatchDigest(batch);
  for (const key of keys) {
    if (!isReceiptKey(key) || receiptKeyId(key.x) !== key.kid || keyUsableOn(key, batch.closedOn) !== "ok") continue;
    if (await verifyEd25519(key.x, receiptLogSigningInput(batchDigest), signature)) return { valid: true, kid: key.kid, batchDigest };
  }
  return { valid: false, kid: null, batchDigest };
}

function isLogBatch(value: unknown): value is ReceiptLogBatch {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["spec", "seq", "size", "root", "previous", "closedOn"]) &&
    value.spec === RECEIPT_LOG_SPEC_VERSION &&
    isUint(value.seq) &&
    value.seq >= 1 &&
    isUint(value.size) &&
    value.size >= 1 &&
    isHex64(value.root) &&
    (value.previous === null || isHex64(value.previous)) &&
    isDay(value.closedOn)
  );
}

/**
 * Offline verification (receipts design §6.1): profile, digest, key status,
 * Ed25519 signature, every present disclosure (commitment, schema and
 * internal consistency), required groups, the optional inclusion proof and
 * the optional intent id. Stops at the first fatal problem (shape, digest,
 * key, signature); collects the rest. Never throws.
 */
export async function verifyReceipt(document: unknown, options: VerifyReceiptOptions = {}): Promise<ReceiptVerification> {
  const problems: ReceiptProblem[] = [];
  const warnings: ReceiptWarning[] = [];
  let digest = "";
  let kid = "";
  let keyView: ReceiptVerification["key"] = { status: "unknown", provenance: "none" };
  const finish = (extra: Partial<ReceiptVerification> = {}): ReceiptVerification => ({
    valid: problems.length === 0,
    digest,
    kid,
    key: keyView,
    disclosed: [],
    sealed: [],
    inclusion: null,
    intentMatches: null,
    problems,
    warnings,
    ...extra,
  });

  // 1. Shape.
  const root = isRecord(document) && !("payload" in document) && isRecord(document.receipt) ? document.receipt : document;
  if (!isRecord(root) || !isRecord(root.payload)) {
    problems.push({ code: "SCHEMA_INVALID", path: "payload", message: "The document has no receipt payload." });
    return finish();
  }
  const payload = root.payload;
  if (payload.spec !== RECEIPT_SPEC_VERSION) {
    problems.push({ code: "SPEC_UNSUPPORTED", path: "payload.spec", message: `Unsupported receipt spec ${String(payload.spec).slice(0, 40)}.` });
    return finish();
  }
  const signature = root.signature;
  kid = isRecord(signature) && typeof signature.kid === "string" ? signature.kid.slice(0, 128) : "";
  let jcs: string;
  try {
    jcs = receiptJcs(payload);
  } catch (error) {
    problems.push({ code: "PROFILE_VIOLATION", path: error instanceof ReceiptProfileError ? error.path : "payload", message: error instanceof Error ? error.message : "Outside the receipt profile." });
    return finish();
  }
  const schemaIssues = payloadSchemaIssues(payload);
  if (!isRecord(signature) || !hasExactKeys(signature, ["alg", "kid", "value"]) || signature.alg !== "Ed25519" || typeof signature.value !== "string") {
    schemaIssues.push("signature");
  }
  if (schemaIssues.length > 0) {
    problems.push({ code: "SCHEMA_INVALID", path: schemaIssues[0], message: `Malformed receipt fields: ${schemaIssues.slice(0, 8).join(", ")}.` });
    return finish();
  }
  const typed = payload as unknown as ReceiptPayload;
  const sig = signature as unknown as ReceiptSignature;

  // 2. Digest.
  digest = sha256Hex(jcs);
  if (typeof root.digest !== "string" || !timingSafeEqualString(root.digest, digest)) {
    problems.push({ code: "DIGEST_MISMATCH", path: "digest", message: "The digest does not match the payload." });
    return finish();
  }

  // 3. Key.
  if (sig.kid !== typed.issuer.kid) {
    problems.push({ code: "KEY_UNKNOWN", path: "signature.kid", message: "signature.kid differs from payload.issuer.kid." });
    return finish();
  }
  const found = findKey(sig.kid, options.pins ?? KLETIA_RECEIPT_KEY_PINS, options.keys ?? []);
  if (!found) {
    problems.push({ code: "KEY_UNKNOWN", path: "signature.kid", message: `No pinned or supplied key ${sig.kid}.` });
    return finish();
  }
  keyView = { status: found.key.status, provenance: found.provenance };
  const usable = keyUsableOn(found.key, typed.issuedOn);
  if (usable === "not_yet") {
    problems.push({ code: "KEY_NOT_YET_VALID", path: "payload.issuedOn", message: `The key may sign from ${found.key.notBefore}.` });
    return finish();
  }
  if (usable === "revoked") {
    problems.push({ code: "KEY_REVOKED", path: "signature.kid", message: found.key.revokedOn ? `The key was revoked on ${found.key.revokedOn}.` : "The key is revoked." });
    return finish();
  }

  // 4. Signature.
  if (!(await verifyEd25519(found.key.x, receiptSigningInput(digest), sig.value))) {
    problems.push({ code: "SIGNATURE_INVALID", path: "signature.value", message: "The Ed25519 signature does not verify (or this runtime cannot verify Ed25519)." });
    return finish();
  }

  // 5. Disclosures.
  const slots = new Map<string, string>();
  slots.set("intent.request", typed.intent.commitments.request);
  slots.set("intent.plan", typed.intent.commitments.plan);
  slots.set("intent.timing", typed.intent.commitments.timing);
  slots.set("intent.outcome", typed.intent.commitments.outcome);
  for (const step of typed.steps) {
    slots.set(`steps.${step.id}.parties`, step.commitments.parties);
    slots.set(`steps.${step.id}.amounts`, step.commitments.amounts);
    slots.set(`steps.${step.id}.evidence`, step.commitments.evidence);
  }
  const disclosed: string[] = [];
  const rawDisclosures = root.disclosures;
  if (rawDisclosures !== undefined && !isRecord(rawDisclosures)) {
    problems.push({ code: "DISCLOSURE_INVALID", path: "disclosures", message: "disclosures must be an object keyed by group path." });
  } else if (rawDisclosures) {
    for (const [path, disclosure] of Object.entries(rawDisclosures)) {
      const slot = slots.get(path);
      if (slot === undefined) {
        problems.push({ code: "DISCLOSURE_PATH_UNKNOWN", path: `disclosures.${path.slice(0, 80)}`, message: "No commitment slot has this path." });
        continue;
      }
      if (!isRecord(disclosure) || !hasExactKeys(disclosure, ["salt", "value"]) || typeof disclosure.salt !== "string" || !RECEIPT_SALT_PATTERN.test(disclosure.salt)) {
        problems.push({ code: "DISCLOSURE_INVALID", path: `disclosures.${path}`, message: "A disclosure is { salt (base64url, 16 bytes), value }." });
        continue;
      }
      let commitment: string;
      try {
        commitment = receiptCommitment(path, { salt: disclosure.salt, value: disclosure.value });
      } catch (error) {
        problems.push({ code: "DISCLOSURE_INVALID", path: `disclosures.${path}`, message: error instanceof Error ? error.message : "Outside the receipt profile." });
        continue;
      }
      if (!timingSafeEqualString(commitment, slot)) {
        problems.push({ code: "DISCLOSURE_MISMATCH", path: `disclosures.${path}`, message: "The disclosure does not match its commitment." });
        continue;
      }
      const issues = groupSchemaIssues(path, disclosure.value);
      const consistency = consistencyIssues(path, disclosure.value, typed);
      if (issues.length > 0 || consistency.length > 0) {
        problems.push({ code: "DISCLOSURE_INVALID", path: `disclosures.${path}`, message: [...issues, ...consistency].slice(0, 6).join("; ") });
        continue;
      }
      disclosed.push(path);
    }
  }
  const order = [...slots.keys()];
  disclosed.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const sealed = order.filter((slot) => !disclosed.includes(slot));

  // 6. Required groups.
  if (options.requireGroups && options.requireGroups.length > 0) {
    for (const path of receiptGroupPaths(options.requireGroups, typed)) {
      if (!disclosed.includes(path)) problems.push({ code: "DISCLOSURE_MISSING", path: `disclosures.${path}`, message: `${path} is required but not disclosed.` });
    }
    for (const pattern of options.requireGroups) {
      if (receiptGroupPaths([pattern], typed).length === 0 && !pattern.includes("*")) {
        problems.push({ code: "DISCLOSURE_MISSING", path: `disclosures.${pattern.slice(0, 80)}`, message: `${pattern.slice(0, 80)} is not a group of this receipt.` });
      }
    }
  }

  // 7. Inclusion.
  let inclusion: ReceiptVerification["inclusion"] = null;
  const nowMs = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  if (root.inclusion !== undefined && root.inclusion !== null) {
    const proof = root.inclusion;
    let valid = false;
    let seq = 0;
    if (isRecord(proof) && isLogBatch(proof.batch) && typeof proof.batchSignature === "string" && isUint(proof.leafIndex) && Array.isArray(proof.path)) {
      seq = proof.batch.seq;
      const known = [...(options.pins ?? KLETIA_RECEIPT_KEY_PINS), ...(options.keys ?? [])];
      const signed = await verifyReceiptLogBatch(proof.batch, proof.batchSignature, known);
      valid =
        signed.valid &&
        verifyMerkleInclusion({ leaf: digest, leafIndex: proof.leafIndex, treeSize: proof.batch.size, path: proof.path as string[], root: proof.batch.root });
    }
    inclusion = { valid, batch: seq };
    if (!valid) problems.push({ code: "INCLUSION_INVALID", path: "inclusion", message: "The batch signature or the inclusion path does not verify." });
  } else {
    const ageDays = (nowMs - Date.parse(`${typed.issuedOn}T00:00:00Z`)) / 86_400_000;
    warnings.push(
      ageDays > RECEIPT_INCLUSION_GRACE_DAYS
        ? { code: "INCLUSION_OVERDUE", message: `Not in a log batch ${Math.floor(ageDays)} days after issuance; ask GET /v1/receipts/log/inclusion with the digest.` }
        : { code: "INCLUSION_PENDING", message: "Not in a log batch yet (batches close hourly)." },
    );
  }

  // 8. Intent id.
  let intentMatches: boolean | null = null;
  if (options.intentId !== undefined) {
    intentMatches = timingSafeEqualString(intentRef(options.intentId), typed.intent.ref);
    if (!intentMatches) problems.push({ code: "INTENT_REF_MISMATCH", path: "payload.intent.ref", message: "This receipt is about another intent." });
  }

  // 9. Warnings.
  if (!typed.intent.terminal) warnings.push({ code: "NOT_TERMINAL", message: `Status ${typed.intent.status} can still change; a newer receipt may supersede this one.` });
  if (sealed.length > 0) warnings.push({ code: "SEALED_GROUPS", message: `${sealed.length} group(s) are sealed by the holder.` });
  if (found.key.status === "retired") warnings.push({ code: "KEY_RETIRED", message: "Signed by a retired key (still valid for receipts it signed)." });
  if (found.key.status === "development") warnings.push({ code: "KEY_DEVELOPMENT", message: "Signed by a development key: not a production receipt." });

  return finish({ disclosed, sealed, inclusion, intentMatches });
}

function consistencyIssues(path: string, value: unknown, payload: ReceiptPayload): string[] {
  if (!isRecord(value)) return [];
  if (path === "intent.request") {
    try {
      return receiptRequestDigest(value.request as ReceiptRequest) === value.requestDigest ? [] : ["requestDigest does not match the request"];
    } catch {
      return ["request is outside the receipt profile"];
    }
  }
  if (path === "intent.plan") {
    if (value.plan === null || value.plan === undefined) return [];
    try {
      return planRecordDigest(value.plan as PlanRecord) === value.planDigest ? [] : ["planDigest does not match the plan record"];
    } catch {
      return ["plan is outside the receipt profile"];
    }
  }
  if (path.startsWith("steps.") && path.endsWith(".evidence") && Array.isArray(value.anchors)) {
    const stepId = path.slice("steps.".length, -".evidence".length);
    const step = payload.steps.find((entry) => entry.id === stepId);
    if (!step) return ["unknown step"];
    const chains = new Set<string>([step.chain]);
    const destination = step.settlement?.destinationNetwork;
    if (destination && isNetworkKey(destination)) chains.add(CHAINS[destination].id);
    const outside = value.anchors.filter((anchor) => isRecord(anchor) && typeof anchor.chain === "string" && !chains.has(anchor.chain));
    return outside.length > 0 ? ["an anchor is on a chain the step does not touch"] : [];
  }
  return [];
}
