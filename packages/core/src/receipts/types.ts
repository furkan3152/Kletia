/**
 * Receipt payload, request, plan record, disclosure group, log and
 * document types.
 */
import type { CaipChainId, NetworkKey } from "../chains.js";
import type { AccountId, AssetId } from "../caip.js";
import type { ProtocolId } from "../protocols.js";
import type { ReceiptAnchor } from "../receiptAnchors.js";
import type { ExecutionMode, IntentActionKind, StepStatus } from "../intent.js";
import type {
  PLAN_RECORD_SPEC_VERSION,
  RECEIPT_LOG_SPEC_VERSION,
  RECEIPT_SPEC_VERSION,
  ReceiptIntentStatus,
} from "./constants.js";

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
  /** `sourceNetwork` as requested (a network key or "auto"), projected like defaultNetwork. */
  readonly sourceNetwork?: string;
  readonly constraints?: {
    readonly maxSlippageBps?: number | string;
    readonly deadline?: number | string;
    readonly maxFeeUsd?: string;
    readonly maxSeconds?: number | string;
    readonly preferProtocols?: readonly string[];
    readonly avoidProtocols?: readonly string[];
    readonly allowTestnets?: boolean;
    /** `[network, usd]` pairs sorted by network (a user-keyed map). */
    readonly gasOnArrival?: readonly (readonly [string, string])[];
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

/** Output of the engine's `collectReceiptInputs(graph)`. */
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
