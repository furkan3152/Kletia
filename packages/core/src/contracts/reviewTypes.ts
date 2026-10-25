/**
 * Review, step, test, inspection and session types.
 */
import type { NetworkKey } from "../chains.js";
import type { AccountId } from "../caip.js";
import type {
  AssetAmount,
  AssetRef,
  IntentActionSpec,
  IntentConstraints,
} from "../intent.js";
import type {
  AbiEventItem,
  AbiFunctionItem,
  AbiStateMutability,
  ArgBinding,
  ContractAbiItem,
  ContractReviewArgSource,
  ContractVm,
  EvmContractPins,
  EvmProxyKind,
  ProgramVerification,
  SolanaProgramPin,
  SourceVerification,
  SourceVerificationStatus,
} from "./types.js";

/* --------------------------------------------------------------------- review */

export interface AssetChange {
  /** CAIP-19 id. */
  readonly asset: string;
  readonly symbol: string;
  readonly decimals: number;
  /** True when the asset is in the registry (`ASSETS`). */
  readonly listed: boolean;
  /** Signed base units (negative: debit). */
  readonly delta: string;
  /** Signed human amount. */
  readonly formatted: string;
}

export interface ContractReviewArg {
  readonly name: string;
  readonly type: string;
  readonly display: string;
  readonly source: ContractReviewArgSource;
}

export interface ContractReviewApproval {
  readonly token: AssetRef;
  readonly spender: string;
  readonly amount: AssetAmount;
  readonly existingAllowance?: AssetAmount;
}

export interface ContractReviewProgram {
  readonly id: string;
  readonly verified: boolean | null;
  readonly upgradeable: boolean;
  readonly upgradeAuthority: string | null;
}

/**
 * What the user reviews before signing a call or action step. Attached to the
 * step at plan (`step.call.review`) and refreshed at prepare (stored on the
 * step and returned as `payload.review`). Render order: who, what,
 * permissions, result, provenance, notice.
 */
export interface ContractReview {
  readonly kind: "evm-call" | "solana-action";
  readonly integrator: { readonly name: string; readonly website?: string; readonly domainVerified: boolean };
  /** Always starts with CONTRACT_REVIEW_NOTICE ("Not audited by Kletia. ..."). */
  readonly notices: readonly string[];
  readonly contract?: {
    readonly network: NetworkKey;
    readonly address: string;
    readonly explorerUrl: string;
    readonly source: SourceVerificationStatus;
    readonly proxy?: {
      readonly kind: EvmProxyKind;
      readonly implementation: string;
      readonly implementationSource: SourceVerificationStatus;
    };
    readonly registeredAt: string;
    readonly revision: number;
  };
  readonly call?: {
    readonly label: string;
    /** Signature with argument names, e.g. `deposit(uint256 assets, address receiver)`. */
    readonly function: string;
    readonly args: readonly ContractReviewArg[];
    readonly value?: AssetAmount;
  };
  readonly approvals: readonly ContractReviewApproval[];
  readonly action?: {
    readonly url: string;
    readonly domain: string;
    readonly title?: string;
    readonly programs: readonly ContractReviewProgram[];
    readonly instructionCount: number;
  };
  readonly simulation: {
    readonly status: "ok" | "unavailable";
    readonly at: string;
    readonly block?: string;
    readonly slot?: string;
    readonly assetChanges: readonly AssetChange[];
    readonly networkFee?: AssetAmount;
    readonly warnings: readonly string[];
  };
}

/* ------------------------------------------------------------------ step call */

export interface ContractStepEvent {
  readonly fragment: AbiEventItem;
  /** Pinned emitter address. */
  readonly emitter: string;
  readonly where: Readonly<Record<string, ArgBinding>>;
  readonly output?: string;
}

/**
 * Self-contained snapshot carried by a call/action step (`IntentStep.call`),
 * so preparing and verifying never need the registry. Bounded to ~4 KB.
 */
export interface ContractStepCall {
  /** `ct_…`. */
  readonly contract: string;
  readonly revision: number;
  readonly definitionHash: string;
  readonly entry: string;
  readonly vm: ContractVm;
  /** EVM address | Solana primary program. */
  readonly target: string;
  readonly integrator: { readonly name: string; readonly website?: string; readonly domainVerified: boolean };
  /** Entry label. */
  readonly label?: string;
  // EVM
  /** Canonical signature. */
  readonly function?: string;
  readonly selector?: string;
  /** The function ABI item (decode / re-encode). */
  readonly fragment?: AbiFunctionItem;
  readonly bindings?: readonly ArgBinding[];
  readonly approvalSpender?: string;
  readonly value?: { readonly bind: string; readonly max: string };
  readonly events?: readonly ContractStepEvent[];
  readonly pins?: EvmContractPins;
  readonly recipientMode?: "account" | "any";
  readonly toleranceBps?: number;
  /** The entry declares `output.rebasing` (set by the call adapter when it plans the step; absent: strict output checks). */
  readonly rebasingOutput?: boolean;
  // SVM
  readonly origin?: string;
  /** Template with params resolved, `{amount}` / `{amountBaseUnits}` kept. */
  readonly href?: string;
  readonly programs?: readonly SolanaProgramPin[];
  readonly payees?: readonly { readonly address: string; readonly maxLamports: string }[];
  // both
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  readonly output?: AssetRef;
  readonly review: ContractReview;
}

/* ----------------------------------------------------------- test and inspect */

/** `POST /v1/contracts/{id}/test`. */
export interface ContractTestRequest {
  readonly entry: string;
  /** CAIP-10 account on the registration's network. */
  readonly account: AccountId;
  /** Decimal amount of the entry input (required for spending entries). */
  readonly amount?: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  /** Third-party recipient (entries with `recipient: "any"` only). */
  readonly recipient?: string;
}

export interface ContractTestTransaction {
  readonly description: string;
  readonly to?: string;
  readonly selector?: string;
  /** Wei (EVM). */
  readonly value?: string;
  /** Top-level programs (Solana). */
  readonly programs?: readonly string[];
}

/** Dry run of the plan + prepare pipeline. Never stored; never carries calldata to persist. */
export interface ContractTestResult {
  readonly contract: string;
  readonly revision: number;
  readonly entry: string;
  readonly network: NetworkKey;
  readonly account: AccountId;
  readonly input?: AssetAmount;
  readonly expectedOutput?: AssetAmount;
  readonly minimumOutput?: AssetAmount;
  readonly transactions: readonly ContractTestTransaction[];
  /** Simulated transaction gas (EVM). */
  readonly gas?: string;
  readonly feesUsd?: number;
  readonly review: ContractReview;
  readonly warnings: readonly string[];
}

export interface AbiFunctionClassification {
  readonly name: string;
  readonly signature: string;
  readonly selector: string;
  readonly stateMutability: AbiStateMutability;
  /** False when the function can never be registered. */
  readonly allowed: boolean;
  readonly code: "CONTRACT_FUNCTION_FORBIDDEN" | "CONTRACT_ARGUMENT_FORBIDDEN" | null;
  readonly reason: string | null;
  /** Restrictions that still allow registration (e.g. bytes arguments accept only 0x). */
  readonly notes: readonly string[];
}

/** `GET /v1/contracts/inspect?network=&address=`. */
export interface EvmContractInspectionView {
  readonly vm: "evm";
  readonly network: NetworkKey;
  readonly address: string;
  readonly deployed: boolean;
  readonly codeSize: number;
  /** EIP-7702 delegated EOA (refused). */
  readonly eip7702: boolean;
  /** `deniedTargetReason`, null when allowed. */
  readonly denied: string | null;
  readonly pins: EvmContractPins | null;
  readonly verification: { readonly source: SourceVerification; readonly implementationSource: SourceVerification | null };
  /** ABI from Sourcify when verified. */
  readonly abi: readonly ContractAbiItem[] | null;
  readonly functions: readonly AbiFunctionClassification[];
  /** Registration hints derived from the verified ABI (absent when none applies). */
  readonly hints?: ContractInspectionHints;
}

/** Hints `GET /v1/contracts/inspect` derives for `kletia contracts init` and the portal wizard. */
export interface ContractInspectionHints {
  /**
   * The ABI has `asset()`, `deposit(uint256,address)` and the ERC-4626
   * `Deposit` event: the vault's underlying token, read with one `eth_call`,
   * and its registry symbol when Kletia lists it on this network (null otherwise).
   */
  readonly erc4626?: { readonly asset: string; readonly registrySymbol: string | null };
}

/** `GET /v1/contracts/inspect?network=solana&programs=a,b`. */
export interface SolanaProgramInspectionView {
  readonly vm: "svm";
  readonly network: NetworkKey;
  readonly programs: readonly {
    readonly program: string;
    readonly pin: SolanaProgramPin | null;
    readonly denied: string | null;
    readonly verification: ProgramVerification;
  }[];
}

export type ContractInspection = EvmContractInspectionView | SolanaProgramInspectionView;

/* ------------------------------------------------------------------- sessions */

export interface SessionAmountBounds {
  /** Index of the action whose amount the visitor may choose. */
  readonly action: number;
  readonly min: string;
  readonly max: string;
}

/** `POST /v1/sessions` (API key). Structured actions only. */
export interface SessionCreateRequest {
  readonly actions: readonly IntentActionSpec[];
  readonly amount?: SessionAmountBounds;
  /** Origins the embedding page may have (https, or http://localhost for development). */
  readonly allowedOrigins: readonly string[];
  /** 60-3600, default 900. */
  readonly expiresInSeconds?: number;
  /** 1-100, default 1. */
  readonly maxIntents?: number;
  readonly constraints?: IntentConstraints;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly clientReference?: string;
}

export type SessionStatus = "active" | "expired" | "used";

export interface SessionActionView {
  readonly kind: IntentActionSpec["kind"];
  readonly network: NetworkKey;
  readonly toNetwork?: NetworkKey;
  readonly from?: string;
  readonly to?: string;
  readonly amount?: string;
  readonly contract?: string;
  readonly entry?: string;
  /** Human description (e.g. the entry label). */
  readonly label: string;
}

/** `GET /v1/sessions/{id}` (public). Never the key or project id. */
export interface SessionView {
  readonly id: string;
  readonly status: SessionStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly integrator: { readonly name: string; readonly website?: string; readonly domainVerified: boolean };
  readonly allowedOrigins: readonly string[];
  readonly actions: readonly SessionActionView[];
  readonly amount?: SessionAmountBounds & { readonly default?: string; readonly symbol?: string };
  readonly maxIntents: number;
  readonly used: number;
  /** `https://kletiaai.xyz/embed#session=cs_…` (creation response). */
  readonly embedUrl?: string;
  /** Conditions the integrator should know about, such as a registration that is not active yet. */
  readonly warnings?: readonly SessionWarning[];
}

/**
 * A session warning: `CONTRACT_PENDING` names a registration of the template
 * that activates at `activatesAt` (mainnet delay); intents of the session are
 * refused until then.
 */
export interface SessionWarning {
  readonly code: "CONTRACT_PENDING";
  readonly contract: string;
  readonly activatesAt: string;
}

/** `POST /v1/sessions/{id}/intents` (public, the session id is the capability). */
export interface SessionIntentRequest {
  readonly accounts: readonly AccountId[];
  /** Within the session's amount bounds. */
  readonly amount?: string;
  /** Origin of the page hosting the frame; must be in `allowedOrigins`. */
  readonly hostOrigin: string;
}
