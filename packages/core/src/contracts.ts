/**
 * Bring your own contract (BYOC): the specification an integrator registers
 * to plug its own EVM contract (ABI actions) or Solana program (through a
 * Solana Actions endpoint) into Kletia intents.
 *
 * Fund safety rules this module encodes, so the API, the SDK, the CLI and the
 * developer portal report identical issues before anything touches a network:
 *
 * - Kletia never builds arbitrary calldata. Every argument of a registered
 *   function is bound to a declared source (`$amount`, `$account`, ...) or a
 *   literal fixed at registration, and the engine encodes the call itself.
 * - Approvals, permits, transfers, ownership, upgrades, multicall and execute
 *   functions are refused by selector and by name, whatever the ABI claims.
 * - `bytes` arguments only accept the empty literal `0x`; `bytes[]` and
 *   `function` arguments are refused, so no calldata can be smuggled.
 * - Receiver-like address arguments must bind to the user (`$account` or
 *   `$recipient`), so a deposit can never be credited to the integrator.
 * - Tokens, routers, Permit2, Multicall3, precompiles and system contracts can
 *   never be a target (`deniedTargetReason`).
 *
 * On-chain checks (code-hash and proxy pins, simulation, verification of
 * landed transactions) live in the API engine; this module only holds the
 * static rules and the shared types.
 */
import { CHAINS, NETWORK_KEYS, isNetworkKey, resolveChain, type NetworkKey } from "./chains.js";
import { isEvmAddress, isSolanaAddress, type AccountId, type AssetId } from "./caip.js";
import { isBaseUnitAmount, isDecimalAmount, toBaseUnits } from "./amounts.js";
import { ASSETS, findAssetBySymbol, getAsset, type AssetDescriptor } from "./assets.js";
import { PROTOCOLS, VENUE_CONTRACTS, type ProtocolId } from "./protocols.js";
import type { AssetAmount, AssetRef, IntentActionSpec, IntentConstraints } from "./intent.js";
import type { ValidationIssue } from "./validation.js";

/* ================================================================ identifiers */

/** Contract registration ids: `ct_` + 24 lower-case hex. */
export const CONTRACT_ID_PATTERN = /^ct_[0-9a-f]{24}$/u;
/** Session ids: `cs_` + 32 lower-case hex (128-bit capabilities). */
export const SESSION_ID_PATTERN = /^cs_[0-9a-f]{32}$/u;
/** Entry (action) ids inside one registration, e.g. `deposit`. */
export const CONTRACT_ENTRY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/u;
/** Natural-language aliases (`acme vault`). */
export const CONTRACT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9 .-]{1,39}$/u;
/** Natural-language verbs (`deposit`, `stake`). */
export const CONTRACT_VERB_PATTERN = /^[a-z]{2,16}$/u;
/** Labels of extra pinned addresses (`vault`, `router-v2`). */
export const CONTRACT_ADDRESS_LABEL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
/** User parameter names (`lockDays`). */
export const CONTRACT_PARAM_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/u;
/** `IntentActionSpec.contract`: a registration id or an alias (any case; the planner lower-cases it). */
export const CONTRACT_REFERENCE_PATTERN = /^(?:ct_[0-9a-f]{24}|[A-Za-z0-9][A-Za-z0-9 .-]{1,63})$/u;

export function isContractId(value: unknown): value is string {
  return typeof value === "string" && CONTRACT_ID_PATTERN.test(value);
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/* ===================================================================== limits */

/**
 * Limits of the BYOC surface. Values prefixed `default` are defaults of
 * operator settings (environment variables in the API).
 */
export const CONTRACT_LIMITS = Object.freeze({
  /** Registrations (not deleted) one API key may hold. */
  registrationsPerKey: 25,
  actionsPerRegistration: 10,
  abiItems: 40,
  /** Canonical JSON of a normalised definition, in UTF-8 bytes. */
  definitionBytes: 49_152,
  eventsPerAction: 3,
  paramsPerAction: 6,
  aliasesPerAction: 4,
  verbsPerAction: 4,
  /** Extra pinned EVM addresses (approval spenders, event emitters). */
  extraAddresses: 4,
  /** Allowlisted Solana programs. */
  programs: 6,
  payees: 2,
  /** Elements of a literal array argument. */
  arrayElements: 8,
  /** Inputs of one ABI item, and components of one tuple. */
  abiParameters: 32,
  /** Tuple nesting depth inside one ABI parameter. */
  abiNesting: 4,
  stringLiteralLength: 64,
  labelLength: 80,
  hrefLength: 512,
  /** `IntentActionSpec.contract` length. */
  referenceLength: 64,
  maxToleranceBps: 100,
  defaultToleranceBps: 10,
  /** Registrations, PATCH and reverify calls per key per hour. */
  registrationsPerHour: 20,
  /** `test` and `inspect` calls per key per minute (on top of the tier limit). */
  testsPerMinute: 20,
  activeSessionsPerKey: 1_000,
  sessionMinTtlSeconds: 60,
  sessionMaxTtlSeconds: 3_600,
  sessionDefaultTtlSeconds: 900,
  sessionMaxIntents: 100,
  sessionAllowedOrigins: 10,
  /** KLETIA_CONTRACT_STEP_MAX_USD. */
  defaultStepMaxUsd: 10_000,
  /** KLETIA_CONTRACT_UNVERIFIED_STEP_MAX_USD (integrator domain not verified). */
  defaultUnverifiedStepMaxUsd: 1_000,
  /** KLETIA_CONTRACT_KEY_DAILY_MAX_USD (priced notional counted at prepare). */
  defaultKeyDailyMaxUsd: 100_000,
  /** KLETIA_CONTRACT_ACTIVATION_DELAY_SECONDS (mainnet; testnets activate at once). */
  defaultActivationDelaySeconds: 900,
  /** `$deadline` = payload `expiresAt` + this many seconds. */
  deadlineSecondsAfterExpiry: 900,
  /** Simulated gas → transaction gas: `gasUsed × 1.25 + 25,000`. */
  gasMultiplierBps: 12_500,
  gasOverhead: 25_000,
  actionResponseBytes: 65_536,
  actionTimeoutMs: 8_000,
  /** `/.well-known/kletia.json` body cap. */
  domainFileBytes: 16_384,
  solanaMaxTransactionBytes: 1_232,
  solanaMaxComputeUnits: 1_400_000,
  /** Compute-unit limit × price cap (0.005 SOL). */
  solanaMaxPriorityFeeLamports: 5_000_000,
  solanaMaxHeapBytes: 262_144,
});

/** First notice of every ContractReview. */
export const CONTRACT_REVIEW_NOTICE =
  "Not audited by Kletia. Kletia checked the contract's code identity and simulated this transaction; it did not review the contract's logic.";

/** Intent warning added when a plan contains call or action steps. */
export const CUSTOM_CONTRACT_WARNING = "Custom contract steps run integrator code that Kletia has not audited.";

/** Domain verification file, served by the integrator's website. */
export const KLETIA_WELL_KNOWN_PATH = "/.well-known/kletia.json";

/* ====================================================================== types */

export type ContractVm = "evm" | "svm";
export type ContractVisibility = "private" | "project";
export type ContractStatus = "pending" | "active" | "suspended";
export type ContractAnomalyReason = "pins_changed" | "outcome_mismatch" | "program_changed";

export interface ContractIntegrator {
  /** 2-40 characters of `[A-Za-z0-9 .,&'()-]`. */
  readonly name: string;
  /** HTTPS origin; required on mainnet networks. */
  readonly website?: string;
}

/* ---------------------------------------------------------------- ABI items */

export interface AbiParameter {
  /** Empty or absent for unnamed parameters. */
  readonly name?: string;
  /** Canonical Solidity ABI type (`uint256`, `address[]`, `tuple`, `tuple[2]`). */
  readonly type: string;
  readonly internalType?: string;
  /** Events only. */
  readonly indexed?: boolean;
  /** Tuple members. */
  readonly components?: readonly AbiParameter[];
}

export type AbiStateMutability = "nonpayable" | "payable" | "view" | "pure";

export interface AbiFunctionItem {
  readonly type: "function";
  readonly name: string;
  readonly stateMutability: AbiStateMutability;
  readonly inputs: readonly AbiParameter[];
  readonly outputs?: readonly AbiParameter[];
}

export interface AbiEventItem {
  readonly type: "event";
  readonly name: string;
  readonly anonymous?: boolean;
  readonly inputs: readonly AbiParameter[];
}

export interface AbiErrorItem {
  readonly type: "error";
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
}

export type ContractAbiItem = AbiFunctionItem | AbiEventItem | AbiErrorItem;

/* ------------------------------------------------------------------ bindings */

/**
 * Declared value sources:
 *
 * | Binding | ABI type | Value |
 * |---|---|---|
 * | `$amount` | `uint*` | Base units of the step input |
 * | `$account` | `address` | The step account (signer) |
 * | `$recipient` | `address` | The step recipient (defaults to `$account`) |
 * | `$token` | `address` | The ERC-20 input token |
 * | `$self` | `address` | The registered contract |
 * | `$minimumOutput` | `uint*` | Guaranteed minimum of the declared output |
 * | `$deadline` | `uint*` | Payload `expiresAt` + 900 s |
 * | `$previous.output.amount` | `uint*` | Full output of the previous step on the same network |
 * | `$previous.output.asset` | `address` | Output token of the previous step |
 * | `$param.<name>` | per param type | Validated user parameter |
 */
export type ArgSourceBinding =
  | "$amount"
  | "$account"
  | "$recipient"
  | "$token"
  | "$self"
  | "$minimumOutput"
  | "$deadline"
  | "$previous.output.amount"
  | "$previous.output.asset"
  | `$param.${string}`;

/**
 * A value fixed at registration: decimal string for `uint*`/`int*`, boolean
 * for `bool`, 0x hex for `bytesN`, `"0x"` (only) for `bytes`, an address for
 * `address`, up to 64 characters for `string`.
 */
export interface LiteralBinding {
  readonly literal: string | boolean;
}

export interface TupleBinding {
  readonly tuple: readonly ArgBinding[];
}

/** Literal-only elements, at most 8; exactly `k` for `T[k]`. */
export interface ArrayBinding {
  readonly array: readonly ArgBinding[];
}

export type ArgBinding = ArgSourceBinding | LiteralBinding | TupleBinding | ArrayBinding;

/** Bindings an event's `where` may use. */
export type EventWhereBinding = "$account" | "$recipient" | "$amount" | "$token" | "$self" | LiteralBinding;

/** Where an argument's value comes from, as the review shows it. */
export type ContractReviewArgSource =
  | "amount"
  | "account"
  | "recipient"
  | "token"
  | "self"
  | "minimumOutput"
  | "deadline"
  | "previousOutput"
  | "param"
  | "literal";

/* ------------------------------------------------------------ action pieces */

export type ContractParamType = "uint" | "int" | "bool" | "enum";

/**
 * A user parameter. `uint`/`int` bounds and defaults are normalised to decimal
 * integer strings; `enum` binds to `string` (the value) or `uint*` (its index).
 */
export interface ActionParam {
  readonly name: string;
  readonly type: ContractParamType;
  readonly min?: string;
  readonly max?: string;
  readonly enum?: readonly string[];
  readonly default?: string | boolean;
  readonly required?: boolean;
}

export interface ContractActionPhrases {
  readonly verbs: readonly string[];
  readonly aliases: readonly string[];
}

/** Decimal amounts in input-token units. */
export interface ContractActionLimits {
  readonly minAmount?: string;
  readonly maxAmount?: string;
}

export interface EvmActionInput {
  /** Registry symbol on the network, CAIP-19 id, or `"native"`. Registry assets only in v1. */
  readonly token: string;
  /** ERC-20 only: exact `approve(spender, $amount)` to `$self` or an `addresses` label. */
  readonly approval?: { readonly spender: string };
}

export interface EvmActionValue {
  /** `"$amount"` (native input only) or a wei literal. */
  readonly bind: string;
  /** Wei cap; the value is refused above it. */
  readonly max: string;
}

export interface EvmActionOutput {
  /** `"$self"`, an `addresses` label, or an ERC-20 address. ERC-20 outputs only in v1. */
  readonly token: string;
  /** 0-100, default 10. */
  readonly toleranceBps?: number;
}

/** Success proof for an EVM action. */
export interface EventBinding {
  /** Name or full signature of an `event` item of the ABI. */
  readonly event: string;
  /** `"$self"` or an `addresses` label: the log address must equal the pinned address. */
  readonly emitter: string;
  /** Event input name → binding; at least one must bind `$account` or `$recipient`. */
  readonly where: Readonly<Record<string, EventWhereBinding>>;
  /** Event input that reports the output amount (requires the action's `output`). */
  readonly output?: string;
}

export interface EvmContractAction {
  readonly id: string;
  readonly label: string;
  /** Canonical signature, e.g. `deposit(uint256,address)`. */
  readonly function: string;
  /** One binding per ABI input, in order. */
  readonly args: readonly ArgBinding[];
  readonly input?: EvmActionInput;
  readonly value?: EvmActionValue;
  readonly output?: EvmActionOutput;
  readonly events: readonly EventBinding[];
  readonly params?: readonly ActionParam[];
  /** `account` (default): `$recipient` must be the acting account. `any`: third-party recipients allowed (flagged). */
  readonly recipient?: "account" | "any";
  readonly phrases?: ContractActionPhrases;
  readonly limits?: ContractActionLimits;
}

export interface ContractAddressEntry {
  readonly label: string;
  readonly address: string;
}

export interface EvmContractDefinition {
  readonly vm: "evm";
  readonly network: NetworkKey;
  readonly address: string;
  readonly integrator: ContractIntegrator;
  readonly visibility?: ContractVisibility;
  /** The allowlist: every function item must be used by an action. */
  readonly abi: readonly ContractAbiItem[];
  readonly addresses?: readonly ContractAddressEntry[];
  readonly actions: readonly EvmContractAction[];
}

export interface SolanaActionInput {
  /** Registry symbol on the network, CAIP-19 id, or `"native"` (SOL). */
  readonly token: string;
}

export interface SolanaActionOutput {
  readonly mint: string;
  readonly toleranceBps?: number;
}

export interface SolanaActionPayee {
  readonly label: string;
  readonly address: string;
  /** Lamport cap per transaction. */
  readonly maxLamports: string;
}

export interface SolanaActionEndpoint {
  readonly id: string;
  readonly label: string;
  /**
   * Action URL on the registered origin. `{amount}` (decimal human amount),
   * `{amountBaseUnits}` and `{<param>}` are the only placeholders.
   */
  readonly href: string;
  /** Must be in `programs`; verification requires its invocation. */
  readonly primaryProgram: string;
  readonly input?: SolanaActionInput;
  readonly output?: SolanaActionOutput;
  readonly params?: readonly ActionParam[];
  readonly phrases?: ContractActionPhrases;
  readonly limits?: ContractActionLimits;
}

export interface SolanaActionDefinition {
  readonly vm: "svm";
  readonly network: NetworkKey;
  readonly integrator: ContractIntegrator;
  readonly visibility?: ContractVisibility;
  /** HTTPS origin every `href` must be on. */
  readonly origin: string;
  /** Allowlisted top-level programs (pinned). */
  readonly programs: readonly string[];
  /** The only third parties a top-level System transfer may pay. */
  readonly payees?: readonly SolanaActionPayee[];
  readonly actions: readonly SolanaActionEndpoint[];
}

export type ContractDefinition = EvmContractDefinition | SolanaActionDefinition;

/* ---------------------------------------------------------------------- pins */

export type EvmProxyKind = "eip1967" | "eip1967-beacon" | "eip1822" | "zeppelinos" | "eip1167";

export interface EvmProxyPin {
  readonly kind: EvmProxyKind;
  readonly implementation: string;
  readonly implementationCodeHash: string;
  /** Admin read from an admin slot, when one holds it. */
  readonly admin: string | null;
  readonly beacon: string | null;
  readonly beaconCodeHash: string | null;
}

export interface EvmCodePin {
  readonly address: string;
  /** keccak256 of the runtime code (eth_getProof codeHash or keccak256(eth_getCode)). */
  readonly codeHash: string;
  readonly codeSize: number;
  readonly proxy: EvmProxyPin | null;
}

export interface EvmContractPins {
  readonly codeHash: string;
  readonly codeSize: number;
  readonly proxy: EvmProxyPin | null;
  /** Pins of every `addresses` entry. */
  readonly addresses: readonly (EvmCodePin & { readonly label: string })[];
  /** Block the pins were read at (decimal). */
  readonly blockNumber: string;
  readonly checkedAt: string;
}

export interface SolanaProgramPin {
  readonly program: string;
  /** Owner loader (`BPFLoaderUpgradeab1e11111111111111111111111` for upgradeable programs). */
  readonly loader: string;
  /** Program data account (upgradeable loader); null otherwise. */
  readonly programData: string | null;
  /** u64 slot of the last deployment (decimal); null for non-upgradeable loaders. */
  readonly lastDeploySlot: string | null;
  /** Null when the program is immutable. */
  readonly upgradeAuthority: string | null;
  /** Non-upgradeable loaders: sha256 hex of the program account data. */
  readonly dataHash?: string | null;
}

export type ContractPins = EvmContractPins | readonly SolanaProgramPin[];

/* -------------------------------------------------------------- verification */

export type SourceVerificationStatus = "exact_match" | "match" | "unverified" | "unknown";

export interface SourceVerification {
  readonly status: SourceVerificationStatus;
  readonly provider: "sourcify";
  readonly checkedAt: string | null;
  readonly url?: string;
  /** Sourcify `proxyResolution.proxyType`, recorded as a cross-check. */
  readonly proxyType?: string | null;
}

export interface ProgramVerification {
  readonly program: string;
  /** OtterSec status: true/false, null when unknown. */
  readonly verified: boolean | null;
  readonly provider: "ottersec";
  readonly checkedAt: string | null;
  readonly repository?: string;
  readonly commit?: string;
}

export interface DomainVerification {
  readonly verified: boolean;
  readonly checkedAt: string | null;
}

export interface RiskScreening {
  readonly provider: "webacy";
  readonly score: number | null;
  readonly level?: string;
  readonly checkedAt: string;
}

export interface ContractVerification {
  readonly source?: SourceVerification | null;
  readonly implementationSource?: SourceVerification | null;
  readonly programs?: readonly ProgramVerification[];
  readonly domain: DomainVerification;
  readonly risk?: RiskScreening | null;
}

/* ---------------------------------------------------------------------- views */

export type EvmContractActionView = EvmContractAction & { readonly selector: string };

export interface SolanaActionMetadata {
  /** The `href` fetched (placeholders removed). */
  readonly url: string;
  readonly title: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly disabled: boolean;
  /** `X-Action-Version` response header. */
  readonly actionVersion?: string;
  /** `X-Blockchain-Ids` response header entries. */
  readonly blockchainIds?: readonly string[];
  readonly fetchedAt: string;
}

export type SolanaActionEndpointView = SolanaActionEndpoint & { readonly metadata?: SolanaActionMetadata | null };

export type ContractActionView = EvmContractActionView | SolanaActionEndpointView;

/** `GET /v1/contracts/{id}`. */
export interface ContractView {
  readonly id: string;
  readonly vm: ContractVm;
  readonly network: NetworkKey;
  /** EVM: checksummed contract address. */
  readonly address?: string;
  /** Solana Actions: the registered origin. */
  readonly origin?: string;
  readonly integrator: ContractIntegrator & { readonly domainVerified: boolean };
  readonly visibility: ContractVisibility;
  readonly status: ContractStatus;
  /** Latest revision number. */
  readonly revision: number;
  /** Null while the first revision waits for activation. */
  readonly activeRevision: number | null;
  readonly pendingRevision: number | null;
  readonly activatesAt: string | null;
  /** sha256 hex of the canonical security-relevant fields (`contractDefinitionHash`). */
  readonly definitionHash: string;
  readonly pins: ContractPins;
  readonly verification: ContractVerification;
  readonly actions: readonly ContractActionView[];
  /** Owner views only (never in MCP output). */
  readonly abi?: readonly ContractAbiItem[];
  readonly addresses?: readonly ContractAddressEntry[];
  readonly programs?: readonly string[];
  readonly payees?: readonly SolanaActionPayee[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly suspendedReason: string | null;
}

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
}

/** `POST /v1/sessions/{id}/intents` (public, the session id is the capability). */
export interface SessionIntentRequest {
  readonly accounts: readonly AccountId[];
  /** Within the session's amount bounds. */
  readonly amount?: string;
  /** Origin of the page hosting the frame; must be in `allowedOrigins`. */
  readonly hostOrigin: string;
}

/* ============================================================ keccak-256 (EVM) */

const MASK64 = (1n << 64n) - 1n;
const KECCAK_ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets r[x][y], indexed x + 5y. */
const KECCAK_ROTATIONS: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(value: bigint, shift: number): bigint {
  if (shift === 0) return value;
  const bits = BigInt(shift);
  return ((value << bits) | (value >> (64n - bits))) & MASK64;
}

function keccakPermute(state: bigint[]): void {
  const c: bigint[] = [0n, 0n, 0n, 0n, 0n];
  const b: bigint[] = new Array<bigint>(25).fill(0n);
  for (let round = 0; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      c[x] = (state[x] as bigint) ^ (state[x + 5] as bigint) ^ (state[x + 10] as bigint) ^ (state[x + 15] as bigint) ^ (state[x + 20] as bigint);
    }
    for (let x = 0; x < 5; x += 1) {
      const d = (c[(x + 4) % 5] as bigint) ^ rotl64(c[(x + 1) % 5] as bigint, 1);
      for (let y = 0; y < 25; y += 5) state[y + x] = (state[y + x] as bigint) ^ d;
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y] as bigint, KECCAK_ROTATIONS[x + 5 * y] as number);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        state[y + x] = (b[y + x] as bigint) ^ (~(b[y + ((x + 1) % 5)] as bigint) & MASK64 & (b[y + ((x + 2) % 5)] as bigint));
      }
    }
    state[0] = (state[0] as bigint) ^ (KECCAK_ROUND_CONSTANTS[round] as bigint);
  }
}

const utf8 = new TextEncoder();

/** Keccak-256 (Ethereum's hash, not SHA3-256) of bytes or a UTF-8 string, as 0x hex. */
export function keccak256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? utf8.encode(input) : input;
  const rate = 136;
  const length = (Math.floor(bytes.length / rate) + 1) * rate;
  const message = new Uint8Array(length);
  message.set(bytes);
  message[bytes.length] = (message[bytes.length] as number) ^ 0x01;
  message[length - 1] = (message[length - 1] as number) ^ 0x80;
  const state: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) value = (value << 8n) | BigInt(message[offset + lane * 8 + byte] as number);
      state[lane] = (state[lane] as bigint) ^ value;
    }
    keccakPermute(state);
  }
  let out = "0x";
  for (let lane = 0; lane < 4; lane += 1) {
    let value = state[lane] as bigint;
    for (let byte = 0; byte < 8; byte += 1) {
      out += Number(value & 0xffn).toString(16).padStart(2, "0");
      value >>= 8n;
    }
  }
  return out;
}

/** 4-byte selector of a canonical function signature (`deposit(uint256,address)` → `0x6e553f65`). */
export function functionSelector(signature: string): string {
  return keccak256Hex(signature).slice(0, 10);
}

/** topic0 of a canonical event signature. */
export function eventTopic(signature: string): string {
  return keccak256Hex(signature);
}

/** EIP-55 checksum form of a 0x address. Throws on a malformed address. */
export function toChecksumAddress(address: string): string {
  if (!isEvmAddress(address)) throw new Error(`Invalid EVM address: ${address}`);
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(lower).slice(2);
  let out = "0x";
  for (let index = 0; index < lower.length; index += 1) {
    const char = lower[index] as string;
    out += Number.parseInt(hash[index] as string, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/** False only for a mixed-case address whose EIP-55 checksum is wrong (a typo). */
export function isChecksumAddressValid(address: string): boolean {
  if (!isEvmAddress(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/* ====================================================== forbidden functions */

export interface ForbiddenSelector {
  readonly selector: string;
  readonly signature: string;
  readonly reason: string;
}

/** Functions that can never be registered, by selector, whatever name the ABI gives them. */
export const FORBIDDEN_SELECTORS: readonly ForbiddenSelector[] = Object.freeze([
  { selector: "0x095ea7b3", signature: "approve(address,uint256)", reason: "approves the contract's own token to anyone" },
  { selector: "0x39509351", signature: "increaseAllowance(address,uint256)", reason: "raises a token allowance" },
  { selector: "0xa457c2d7", signature: "decreaseAllowance(address,uint256)", reason: "changes a token allowance" },
  { selector: "0xa22cb465", signature: "setApprovalForAll(address,bool)", reason: "approves every NFT of the caller (drain)" },
  { selector: "0xd505accf", signature: "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", reason: "signature approval (EIP-2612)" },
  { selector: "0x8fcbaf0c", signature: "permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)", reason: "signature approval (DAI permit)" },
  { selector: "0xa9059cbb", signature: "transfer(address,uint256)", reason: "moves tokens" },
  { selector: "0x23b872dd", signature: "transferFrom(address,address,uint256)", reason: "moves tokens" },
  { selector: "0x42842e0e", signature: "safeTransferFrom(address,address,uint256)", reason: "moves NFTs" },
  { selector: "0xb88d4fde", signature: "safeTransferFrom(address,address,uint256,bytes)", reason: "moves NFTs" },
  { selector: "0xf242432a", signature: "safeTransferFrom(address,address,uint256,uint256,bytes)", reason: "moves ERC-1155 tokens" },
  { selector: "0x2eb2c2d6", signature: "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)", reason: "moves ERC-1155 tokens" },
  { selector: "0xe3ee160e", signature: "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)", reason: "signature transfer (EIP-3009)" },
  { selector: "0xef55bec6", signature: "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)", reason: "signature transfer (EIP-3009)" },
  { selector: "0x3659cfe6", signature: "upgradeTo(address)", reason: "upgrades the contract" },
  { selector: "0x4f1ef286", signature: "upgradeToAndCall(address,bytes)", reason: "upgrades the contract" },
  { selector: "0x8f283970", signature: "changeAdmin(address)", reason: "changes the proxy admin" },
  { selector: "0xf2fde38b", signature: "transferOwnership(address)", reason: "changes the owner" },
  { selector: "0x715018a6", signature: "renounceOwnership()", reason: "changes the owner" },
  { selector: "0x8129fc1c", signature: "initialize()", reason: "initialises the contract (admin)" },
  { selector: "0xac9650d8", signature: "multicall(bytes[])", reason: "executes arbitrary calls" },
  { selector: "0x5ae401dc", signature: "multicall(uint256,bytes[])", reason: "executes arbitrary calls" },
  { selector: "0x252dba42", signature: "aggregate((address,bytes)[])", reason: "executes arbitrary calls (Multicall)" },
  { selector: "0x82ad56cb", signature: "aggregate3((address,bool,bytes)[])", reason: "executes arbitrary calls (Multicall3)" },
  { selector: "0x174dea71", signature: "aggregate3Value((address,bool,uint256,bytes)[])", reason: "executes arbitrary calls (Multicall3)" },
  { selector: "0xbce38bd7", signature: "tryAggregate(bool,(address,bytes)[])", reason: "executes arbitrary calls (Multicall)" },
  { selector: "0xb61d27f6", signature: "execute(address,uint256,bytes)", reason: "executes arbitrary calls" },
  { selector: "0x6a761202", signature: "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", reason: "executes arbitrary calls (Safe)" },
  { selector: "0x5c19a95c", signature: "delegate(address)", reason: "delegates voting power" },
  { selector: "0xc04a8a10", signature: "approveDelegation(address,uint256)", reason: "delegates credit" },
]);

/**
 * Name prefixes refused (case-insensitive, leading underscores ignored),
 * whatever the selector.
 */
export const FORBIDDEN_NAME_PREFIXES: readonly string[] = Object.freeze([
  "approve",
  "increaseallowance",
  "decreaseallowance",
  "setapprovalforall",
  "permit",
  "receivewithauthorization",
  "upgrade",
  "initialize",
  "reinitialize",
  "changeadmin",
  "transferownership",
  "renounceownership",
  "acceptownership",
  "setowner",
  "setimplementation",
  "multicall",
  "aggregate",
  "tryaggregate",
  "execute",
  "exec",
  "delegate",
  "selfdestruct",
  "kill",
]);

/** Exact names refused (the `transfer` family is matched exactly, not as a prefix). */
export const FORBIDDEN_FUNCTION_NAMES: readonly string[] = Object.freeze([
  "transfer",
  "transferfrom",
  "safetransferfrom",
  "safebatchtransferfrom",
  "transferwithauthorization",
]);

const FORBIDDEN_BY_SELECTOR = new Map(FORBIDDEN_SELECTORS.map((entry) => [entry.selector, entry]));

/** Why a function (by name and canonical signature) can never be registered; null when allowed. */
export function forbiddenFunctionReason(name: string, signature: string): string | null {
  const selector = functionSelector(signature);
  const bySelector = FORBIDDEN_BY_SELECTOR.get(selector);
  if (bySelector) return `${signature} has the selector ${selector} of ${bySelector.signature}, which ${bySelector.reason}.`;
  const normalized = name.replace(/^_+/u, "").toLowerCase();
  if (FORBIDDEN_FUNCTION_NAMES.includes(normalized)) return `${name} is a token transfer function.`;
  const prefix = FORBIDDEN_NAME_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  if (prefix) return `${name} starts with "${prefix}": approvals, permits, transfers, ownership, upgrades, multicall and execute functions cannot be registered.`;
  return null;
}

/* ========================================================= beneficiary names */

/**
 * Address arguments with these names must bind to `$account` or `$recipient`
 * (a deposit can never be credited to anyone but the user).
 */
export const BENEFICIARY_ARG_PATTERN = /^_?(?:receiver|recipient|to|owner|beneficiary|onBehalfOf|account|user|for|dst|destination)$/iu;

export function isBeneficiaryArgName(name: string | undefined): boolean {
  return typeof name === "string" && BENEFICIARY_ARG_PATTERN.test(name);
}

/* =========================================================== reserved words */

const VENUE_WORDS: readonly string[] = [
  "aave", "compound", "comet", "morpho", "moonwell", "jupiter", "jup", "kamino", "lifi", "li.fi", "debridge", "dln",
  "relay", "jito", "marinade", "sanctum", "msol", "jitosol", "jupsol",
];
const VENUE_PHRASES: readonly string[] = [
  "aave v3", "aavev3", "compound v3", "compoundv3", "morpho vault", "morpho vaults", "jupiter lend", "jupiter earn",
  "jup lend", "jup earn", "kamino lend", "debridge dln", "cctp", "across", "uniswap", "aerodrome",
];
const NETWORK_WORDS: readonly string[] = [
  "base", "arbitrum", "arb", "ethereum", "optimism", "op", "polygon", "matic", "arc", "solana", "sol", "devnet",
  "mainnet-beta", "sepolia", "mainnet", "testnet",
];
/** Grammar connectors and articles: refused anywhere in an alias. */
const CONNECTOR_WORDS: readonly string[] = [
  "to", "for", "into", "onto", "with", "using", "from", "on", "as", "via", "in", "at", "then", "and", "after", "the", "my", "of",
];
/** Grammar amount and target words: refused as a whole alias. */
const KEYWORD_PHRASES: readonly string[] = [
  "all", "max", "everything", "it", "them", "that", "half", "quarter", "a quarter", "a", "vault", "vaults", "pool", "contract",
  "program", "position", "output", "proceeds",
];

function phraseVariants(value: string): string[] {
  const lower = value.trim().toLowerCase().replace(/\s+/gu, " ");
  return [...new Set([lower, lower.replace(/ /gu, "-"), lower.replace(/-/gu, " ")])];
}

const RESERVED_WHOLE = new Set<string>(
  [
    "kletia",
    ...VENUE_WORDS,
    ...VENUE_PHRASES,
    ...NETWORK_WORDS,
    ...CONNECTOR_WORDS,
    ...KEYWORD_PHRASES,
    ...NETWORK_KEYS,
    ...Object.values(CHAINS).flatMap((chain) => [chain.name, chain.shortName]),
    ...ASSETS.map((asset) => asset.symbol),
    ...PROTOCOLS.flatMap((protocol) => [protocol.id, protocol.name]),
    "solana mainnet", "solana devnet", "arbitrum one", "arbitrum sepolia", "arb sepolia", "arc testnet", "base mainnet",
    "ethereum mainnet", "op mainnet", "optimism mainnet", "polygon pos", "polygon mainnet",
  ].flatMap(phraseVariants),
);
const RESERVED_TOKENS = new Set<string>(["kletia", ...VENUE_WORDS, ...NETWORK_WORDS, ...CONNECTOR_WORDS]);

/**
 * Words and phrases an alias may not be (lower-case): network names and
 * aliases, registry asset symbols, built-in venue words, protocol ids and
 * names, `kletia` and grammar keywords. The grammar's venue words must stay a
 * subset of this list (drift test in the engine).
 */
export const RESERVED_CONTRACT_PHRASES: readonly string[] = Object.freeze([...RESERVED_WHOLE].sort());

/**
 * The reserved word or phrase an alias collides with, or null. An alias may
 * not equal a reserved phrase (or name a network), and may not contain a
 * venue word, a network word, `kletia` or a grammar connector as one of its
 * space- or hyphen-separated words.
 */
export function reservedContractPhrase(alias: string): string | null {
  const lower = alias.trim().toLowerCase().replace(/\s+/gu, " ");
  for (const variant of phraseVariants(lower)) if (RESERVED_WHOLE.has(variant)) return variant;
  if (resolveChain(lower) !== null) return lower;
  for (const token of lower.split(/[\s-]+/u)) if (RESERVED_TOKENS.has(token)) return token;
  return null;
}

/**
 * Reserved integrator brand words and the website hosts allowed to use them.
 * `substring`: anywhere in the name ("TheKletiaFund"); `prefix`: at the start
 * of a word ("AaveYield", not "Polymorphic"); `word`: a whole word only (common
 * English words such as "Relay" or "Across").
 */
export const RESERVED_INTEGRATOR_NAMES: readonly {
  readonly word: string;
  readonly hosts: readonly string[];
  readonly match: "substring" | "prefix" | "word";
}[] = Object.freeze([
  { word: "kletia", hosts: ["kletiaai.xyz"], match: "substring" },
  { word: "uniswap", hosts: ["uniswap.org"], match: "substring" },
  { word: "aerodrome", hosts: ["aerodrome.finance"], match: "prefix" },
  { word: "aave", hosts: ["aave.com"], match: "prefix" },
  { word: "compound", hosts: ["compound.finance"], match: "word" },
  { word: "moonwell", hosts: ["moonwell.fi"], match: "substring" },
  { word: "morpho", hosts: ["morpho.org"], match: "prefix" },
  { word: "basenames", hosts: ["base.org"], match: "substring" },
  { word: "ens", hosts: ["ens.domains"], match: "word" },
  { word: "x402", hosts: ["x402.org"], match: "prefix" },
  { word: "across", hosts: ["across.to"], match: "word" },
  { word: "cctp", hosts: ["circle.com"], match: "prefix" },
  { word: "circle", hosts: ["circle.com"], match: "word" },
  { word: "relay", hosts: ["relay.link"], match: "word" },
  { word: "lifi", hosts: ["li.fi"], match: "word" },
  { word: "debridge", hosts: ["debridge.finance"], match: "substring" },
  { word: "jupiter", hosts: ["jup.ag"], match: "substring" },
  { word: "kamino", hosts: ["kamino.finance"], match: "substring" },
  { word: "jito", hosts: ["jito.network"], match: "prefix" },
  { word: "marinade", hosts: ["marinade.finance"], match: "prefix" },
  { word: "sanctum", hosts: ["sanctum.so"], match: "prefix" },
  { word: "webacy", hosts: ["webacy.com"], match: "substring" },
  { word: "allora", hosts: ["allora.network"], match: "prefix" },
]);

/** The reserved brand an integrator name uses (see RESERVED_INTEGRATOR_NAMES), or null. */
export function reservedIntegratorName(name: string): { readonly word: string; readonly hosts: readonly string[] } | null {
  const lower = name.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/gu, "");
  const words = lower.split(/[^a-z0-9.]+/u).filter(Boolean).map((word) => word.replace(/\./gu, ""));
  for (const entry of RESERVED_INTEGRATOR_NAMES) {
    const hit =
      entry.match === "substring"
        ? compact.includes(entry.word)
        : entry.match === "prefix"
          ? words.some((word) => word.startsWith(entry.word))
          : words.includes(entry.word);
    if (hit) return { word: entry.word, hosts: entry.hosts };
  }
  return null;
}

/** True when `host` is one of `hosts` or a subdomain of one. */
export function hostMatches(host: string, hosts: readonly string[]): boolean {
  const lower = host.toLowerCase().replace(/^www\./u, "");
  return hosts.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
}

/* ===================================================== approval reset tokens */

/** Tokens whose `approve` reverts unless the allowance is 0 first (USDT-style). */
export const APPROVAL_RESET_TOKENS: readonly { readonly network: NetworkKey; readonly address: string; readonly symbol: string }[] = Object.freeze([
  { network: "ethereum", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT" },
]);

export function needsApprovalReset(network: NetworkKey, token: string): boolean {
  const wanted = token.toLowerCase();
  return APPROVAL_RESET_TOKENS.some((entry) => entry.network === network && entry.address.toLowerCase() === wanted);
}

/* ================================================================= deny list */

/**
 * Solana programs a Solana Action transaction may use without being
 * allowlisted; they are handled by fixed instruction rules and can never be
 * registered as integrator programs.
 */
export const SOLANA_ACTION_BUILTIN_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse",
});

/** Native and loader programs that can never be allowlisted. */
const SOLANA_NATIVE_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  BPFLoaderUpgradeab1e11111111111111111111111: "the upgradeable BPF loader",
  BPFLoader2111111111111111111111111111111111: "the BPF loader",
  BPFLoader1111111111111111111111111111111111: "the deprecated BPF loader",
  LoaderV411111111111111111111111111111111111: "loader v4",
  NativeLoader1111111111111111111111111111111: "the native loader",
  Stake11111111111111111111111111111111111111: "the Stake program",
  Vote111111111111111111111111111111111111111: "the Vote program",
  Config1111111111111111111111111111111111111: "the Config program",
  Ed25519SigVerify111111111111111111111111111: "the Ed25519 precompile",
  KeccakSecp256k11111111111111111111111111111: "the secp256k1 precompile",
  Secp256r1SigVerify1111111111111111111111111: "the secp256r1 precompile",
});

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const EVM_DENIED_ADDRESSES: readonly { readonly address: string; readonly reason: string }[] = [
  { address: "0x0000000000000000000000000000000000000000", reason: "the zero address" },
  { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", reason: "the native-asset placeholder address" },
  { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", reason: "Permit2 (signature approvals of every token)" },
  { address: "0xcA11bde05977b3631167028862bE2a173976CA11", reason: "Multicall3 (executes arbitrary calls)" },
  { address: "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02", reason: "a system contract (EIP-4788 beacon roots)" },
  { address: "0x0000F90827F1C53a10cb7A02335B175320002935", reason: "a system contract (EIP-2935 block hashes)" },
  { address: "0x00000961Ef480Eb55e80D19ad83579A64c007002", reason: "a system contract (EIP-7002 withdrawals)" },
  { address: "0x0000BBdDc7CE488642fb579F8B00f3a590007251", reason: "a system contract (EIP-7251 consolidations)" },
  { address: "0x4e59b44847b379578588920cA78FbF26c0B4956C", reason: "the deterministic deployment proxy (deploys arbitrary code)" },
  { address: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", reason: "the ERC-4337 EntryPoint v0.6 (executes arbitrary calls)" },
  { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", reason: "the ERC-4337 EntryPoint v0.7 (executes arbitrary calls)" },
];
const EVM_DENIED_BY_ADDRESS = new Map(EVM_DENIED_ADDRESSES.map((entry) => [entry.address.toLowerCase(), entry.reason]));
const OP_STACK: readonly NetworkKey[] = ["base", "optimism"];
const ARBITRUM_STACK: readonly NetworkKey[] = ["arbitrum", "arbitrum-sepolia"];

function lowAddressReason(network: NetworkKey, value: bigint): string {
  if (value >= 0x01n && value <= 0x11n) return "an EVM precompile";
  if (value === 0x100n) return "the P-256 precompile (RIP-7212)";
  if (ARBITRUM_STACK.includes(network) && ((value >= 0x64n && value <= 0x6fn) || value === 0xc8n)) return "an Arbitrum precompile";
  if (network === "polygon" && value === 0x1010n) return "Polygon's native POL token contract";
  return "a reserved system address";
}

/**
 * Why `address` can never be registered or called on `network`, or null.
 * EVM: zero / placeholder addresses, registry tokens (`ASSETS`), venue
 * contracts (`VENUE_CONTRACTS`: routers and aggregators accept arbitrary
 * calldata), Permit2, Multicall3, ERC-4337 EntryPoints, the deterministic
 * deployer, system contracts, precompiles and every address up to 0xffff,
 * OP-stack predeploys (Base, OP) and Arbitrum precompiles. Solana: built-in,
 * native and loader programs and venue programs. `extra` adds configured
 * entries as `network:address` (e.g. `KLETIA_CONTRACT_DENYLIST`).
 * `YIELD_VENUES` are not denied.
 */
export function deniedTargetReason(network: NetworkKey, address: string, extra?: Iterable<string>): string | null {
  const chain = CHAINS[network];
  if (!chain) return "an unknown network";
  if (chain.vm === "svm") {
    if (hasOwn(SOLANA_ACTION_BUILTIN_PROGRAMS, address)) return `${SOLANA_ACTION_BUILTIN_PROGRAMS[address]} is a built-in program handled by fixed rules`;
    if (hasOwn(SOLANA_NATIVE_PROGRAMS, address)) return `${SOLANA_NATIVE_PROGRAMS[address]} cannot be allowlisted`;
    const venue = VENUE_CONTRACTS.find((entry) => entry.network === network && entry.address === address);
    if (venue) return `a ${venue.protocol} venue program`;
    const asset = ASSETS.find((entry) => entry.network === network && entry.address === address);
    if (asset) return `the ${asset.symbol} mint`;
  } else {
    if (!isEvmAddress(address)) return "not an EVM address";
    const lower = address.toLowerCase();
    const fixed = EVM_DENIED_BY_ADDRESS.get(lower);
    if (fixed) return fixed;
    const value = BigInt(lower);
    if (value <= 0xffffn) return lowAddressReason(network, value);
    const asset = ASSETS.find((entry) => entry.network === network && entry.address?.toLowerCase() === lower);
    if (asset) return `the ${asset.symbol} token (tokens are never called directly)`;
    const venue = VENUE_CONTRACTS.find((entry) => entry.network === network && entry.address.toLowerCase() === lower);
    if (venue) return `a ${venue.protocol} ${venue.role} contract (routers and aggregators accept arbitrary calldata)`;
    if (OP_STACK.includes(network) && lower.startsWith("0x42000000000000000000000000000000000000")) return "an OP-stack predeploy";
  }
  if (extra) {
    for (const entry of extra) {
      const colon = entry.indexOf(":");
      if (colon <= 0) continue;
      const entryNetwork = entry.slice(0, colon).trim();
      const entryAddress = entry.slice(colon + 1).trim();
      if (entryNetwork !== network) continue;
      const same = chain.vm === "evm" ? entryAddress.toLowerCase() === address.toLowerCase() : entryAddress === address;
      if (same) return "on this deployment's deny list";
    }
  }
  return null;
}

/* ================================================================ ABI helpers */

const INT_WIDTHS = new Set(Array.from({ length: 32 }, (_, index) => String((index + 1) * 8)));
const TYPE_SHAPE = /^(tuple|[a-z]+[0-9]*)((?:\[[0-9]*\])*)$/u;
const ABI_NAME = /^(?!__proto__$)[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

interface TypeShape {
  readonly base: string;
  /** Array dimensions in declaration order; null for dynamic. */
  readonly dims: readonly (number | null)[];
}

function typeShape(type: string): TypeShape | null {
  const match = TYPE_SHAPE.exec(type);
  if (!match) return null;
  const dims: (number | null)[] = [];
  for (const dim of (match[2] ?? "").match(/\[[0-9]*\]/gu) ?? []) {
    const inner = dim.slice(1, -1);
    if (inner === "") dims.push(null);
    else {
      if (!/^[1-9][0-9]{0,3}$/u.test(inner)) return null;
      dims.push(Number(inner));
    }
  }
  return { base: match[1] as string, dims };
}

function isElementaryBase(base: string): boolean {
  if (base === "address" || base === "bool" || base === "string" || base === "bytes" || base === "function") return true;
  const bytes = /^bytes([0-9]+)$/u.exec(base);
  if (bytes) return Number(bytes[1]) >= 1 && Number(bytes[1]) <= 32 && String(Number(bytes[1])) === bytes[1];
  const int = /^u?int([0-9]+)$/u.exec(base);
  return int !== null && INT_WIDTHS.has(int[1] as string);
}

/** Canonical ABI type of a parameter (tuples expanded): `(uint256,address)[]`. */
export function canonicalAbiType(param: AbiParameter): string {
  const shape = typeShape(param.type);
  if (shape?.base === "tuple") {
    const suffix = param.type.slice("tuple".length);
    return `(${(param.components ?? []).map(canonicalAbiType).join(",")})${suffix}`;
  }
  return param.type;
}

/** Canonical signature of an ABI function, event or error: `deposit(uint256,address)`. */
export function abiItemSignature(item: { readonly name: string; readonly inputs: readonly AbiParameter[] }): string {
  return `${item.name}(${item.inputs.map(canonicalAbiType).join(",")})`;
}

/** Signature with argument names, for reviews: `deposit(uint256 assets, address receiver)`. */
export function abiItemDisplaySignature(item: { readonly name: string; readonly inputs: readonly AbiParameter[] }): string {
  return `${item.name}(${item.inputs.map((input) => (input.name ? `${canonicalAbiType(input)} ${input.name}` : canonicalAbiType(input))).join(", ")})`;
}

function containsType(param: AbiParameter, predicate: (base: string, dims: readonly (number | null)[]) => boolean): boolean {
  const shape = typeShape(param.type);
  if (!shape) return false;
  if (predicate(shape.base, shape.dims)) return true;
  return (param.components ?? []).some((component) => containsType(component, predicate));
}

/** A reason the argument types make the function unregistrable, or null. */
function forbiddenArgumentReason(inputs: readonly AbiParameter[]): string | null {
  for (const input of inputs) {
    if (containsType(input, (base) => base === "function")) return `${input.name || "an argument"} has a function type`;
    if (containsType(input, (base, dims) => base === "bytes" && dims.length > 0)) return `${input.name || "an argument"} is a bytes array (arbitrary calldata)`;
  }
  return null;
}

/** Whether (and why not) a function item can be registered; used by inspect and the portal. */
export function classifyAbiFunction(item: AbiFunctionItem): AbiFunctionClassification {
  const signature = abiItemSignature(item);
  const selector = functionSelector(signature);
  const base = { name: item.name, signature, selector, stateMutability: item.stateMutability };
  const forbidden = forbiddenFunctionReason(item.name, signature);
  if (forbidden) return { ...base, allowed: false, code: "CONTRACT_FUNCTION_FORBIDDEN", reason: forbidden, notes: [] };
  if (item.stateMutability === "view" || item.stateMutability === "pure") {
    return { ...base, allowed: false, code: "CONTRACT_FUNCTION_FORBIDDEN", reason: `${item.name} is read-only (${item.stateMutability}); only state-changing functions can be registered.`, notes: [] };
  }
  const argument = forbiddenArgumentReason(item.inputs);
  if (argument) return { ...base, allowed: false, code: "CONTRACT_ARGUMENT_FORBIDDEN", reason: `${signature}: ${argument}.`, notes: [] };
  const notes: string[] = [];
  if (item.inputs.some((input) => containsType(input, (b, dims) => b === "bytes" && dims.length === 0))) {
    notes.push("bytes arguments only accept the empty literal 0x.");
  }
  if (item.stateMutability === "payable") notes.push("payable: needs a value binding with a cap.");
  return { ...base, allowed: true, code: null, reason: null, notes };
}

/* ============================================================ binding sources */

const SOURCE_TYPES: Readonly<Record<string, "uint" | "address">> = Object.freeze({
  $amount: "uint",
  $minimumOutput: "uint",
  $deadline: "uint",
  "$previous.output.amount": "uint",
  $account: "address",
  $recipient: "address",
  $token: "address",
  $self: "address",
  "$previous.output.asset": "address",
});

/** The review label of a binding (`$previous.*` → `previousOutput`, objects → `literal`). */
export function bindingReviewSource(binding: ArgBinding): ContractReviewArgSource {
  if (typeof binding !== "string") return "literal";
  if (binding.startsWith("$param.")) return "param";
  if (binding.startsWith("$previous.")) return "previousOutput";
  switch (binding) {
    case "$amount":
      return "amount";
    case "$account":
      return "account";
    case "$recipient":
      return "recipient";
    case "$token":
      return "token";
    case "$self":
      return "self";
    case "$minimumOutput":
      return "minimumOutput";
    case "$deadline":
      return "deadline";
    default:
      return "literal";
  }
}

/* ============================================================ helpers (shared) */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function isPlainText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && value.length <= max && !CONTROL_CHARS.test(value);
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".test", ".invalid"];

function isPublicHostName(host: string): boolean {
  if (!host || host.startsWith("[") || IPV4.test(host) || !host.includes(".")) return false;
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(host);
}

/**
 * Normalises a web origin (`https://Acme.example/` → `https://acme.example`).
 * HTTPS with a public DNS name (no credentials, path, query or fragment);
 * `allowPort` admits 443 and 1024-65535; `allowLocalhost` admits
 * `http://localhost[:port]` and `http://127.0.0.1[:port]` for development.
 * Returns null when refused. Static only: DNS resolution is checked by the API.
 */
export function normalizeWebOrigin(value: unknown, options: { readonly allowPort?: boolean; readonly allowLocalhost?: boolean } = {}): string | null {
  if (typeof value !== "string" || value.length > 256 || CONTROL_CHARS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (value.includes("?") || value.includes("#") || value.includes("@")) return null;
  if (url.protocol === "http:" && options.allowLocalhost && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return url.origin;
  }
  if (url.protocol !== "https:" || !isPublicHostName(url.hostname)) return null;
  if (url.port) {
    const port = Number(url.port);
    if (!options.allowPort || !(port === 443 || (port >= 1024 && port <= 65_535))) return null;
  }
  return url.origin;
}

/** True when a `/.well-known/kletia.json` body lists `contractId`. */
export function domainFileListsContract(body: unknown, contractId: string): boolean {
  return isRecord(body) && Array.isArray(body.contracts) && body.contracts.some((entry) => entry === contractId);
}

/**
 * True when a `/.well-known/kletia.json` body authorizes an intent link:
 * `"links": ["lk_…"]` lists it, or `"keys": ["key_…"]` lists its owner key
 * (every link of that key; key ids are public and stable across rotations).
 */
export function domainFileListsLink(body: unknown, linkId: string, keyId: string): boolean {
  if (!isRecord(body)) return false;
  const lists = (field: unknown, value: string) => Array.isArray(field) && field.some((entry) => entry === value);
  return lists(body.links, linkId) || lists(body.keys, keyId);
}

/** Resolves a registry asset for a definition: `native`, a symbol on `network`, or a CAIP-19 id on `network`. */
export function resolveContractAsset(network: NetworkKey, token: string): AssetDescriptor | null {
  if (typeof token !== "string" || !token.trim()) return null;
  if (token === "native") return ASSETS.find((asset) => asset.network === network && asset.address === null) ?? null;
  if (token.includes("/")) {
    const asset = getAsset(token);
    return asset && asset.network === network ? asset : null;
  }
  return findAssetBySymbol(network, token);
}

/* ======================================================== definition schema */

export type ContractIssueCode =
  | "CONTRACT_DEFINITION_INVALID"
  | "CONTRACT_FUNCTION_FORBIDDEN"
  | "CONTRACT_ARGUMENT_FORBIDDEN"
  | "CONTRACT_BINDING_INVALID"
  | "CONTRACT_DENIED"
  | "ACTION_URL_FORBIDDEN"
  | "PROGRAM_NOT_ALLOWED";

export interface ContractValidationIssue extends ValidationIssue {
  readonly code: ContractIssueCode;
}

export type ContractValidationResult =
  | { readonly ok: true; readonly value: ContractDefinition }
  | {
      readonly ok: false;
      /** The error code to return: the most specific issue code by `CONTRACT_ISSUE_PRECEDENCE`. */
      readonly code: ContractIssueCode;
      readonly issues: readonly ContractValidationIssue[];
    };

/** Most specific first: the API returns the first code present among the issues. */
export const CONTRACT_ISSUE_PRECEDENCE: readonly ContractIssueCode[] = Object.freeze([
  "CONTRACT_DENIED",
  "CONTRACT_FUNCTION_FORBIDDEN",
  "CONTRACT_ARGUMENT_FORBIDDEN",
  "PROGRAM_NOT_ALLOWED",
  "ACTION_URL_FORBIDDEN",
  "CONTRACT_BINDING_INVALID",
  "CONTRACT_DEFINITION_INVALID",
]);

export function primaryContractIssueCode(issues: readonly { readonly code: ContractIssueCode }[]): ContractIssueCode {
  for (const code of CONTRACT_ISSUE_PRECEDENCE) if (issues.some((issue) => issue.code === code)) return code;
  return "CONTRACT_DEFINITION_INVALID";
}

export interface ContractValidationOptions {
  /** Configured deny entries (`network:address`), e.g. KLETIA_CONTRACT_DENYLIST. */
  readonly denylist?: Iterable<string>;
}

class IssueList {
  readonly list: ContractValidationIssue[] = [];
  add(code: ContractIssueCode, path: string, message: string): void {
    if (this.list.length < 100) this.list.push({ code, path, message });
  }
  invalid(path: string, message: string): void {
    this.add("CONTRACT_DEFINITION_INVALID", path, message);
  }
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: IssueList): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.invalid(path ? `${path}.${key}` : key, `Unknown field. Allowed: ${allowed.join(", ")}.`);
  }
}

/* --------------------------------------------------------------- ABI parsing */

function parseAbiParameter(value: unknown, path: string, depth: number, issues: IssueList, event: boolean): AbiParameter | null {
  if (!isRecord(value)) {
    issues.invalid(path, "ABI parameter must be an object.");
    return null;
  }
  const { name, type, internalType, indexed, components } = value;
  if (name !== undefined && name !== "" && (typeof name !== "string" || !ABI_NAME.test(name))) {
    issues.invalid(`${path}.name`, "Must be a Solidity identifier up to 64 characters.");
    return null;
  }
  if (typeof type !== "string") {
    issues.invalid(`${path}.type`, "Must be a canonical ABI type.");
    return null;
  }
  const shape = typeShape(type);
  if (!shape || (shape.base !== "tuple" && !isElementaryBase(shape.base))) {
    issues.invalid(`${path}.type`, `Unsupported or non-canonical ABI type "${type}" (use uint256, not uint; fixed-point types are not supported).`);
    return null;
  }
  if (internalType !== undefined && (typeof internalType !== "string" || internalType.length > 128)) {
    issues.invalid(`${path}.internalType`, "Must be a string up to 128 characters.");
    return null;
  }
  if (indexed !== undefined && (typeof indexed !== "boolean" || !event)) {
    issues.invalid(`${path}.indexed`, "Only event inputs carry a boolean indexed flag.");
    return null;
  }
  let parsedComponents: AbiParameter[] | undefined;
  if (shape.base === "tuple") {
    if (depth >= CONTRACT_LIMITS.abiNesting) {
      issues.invalid(path, `Tuples nest at most ${CONTRACT_LIMITS.abiNesting} levels.`);
      return null;
    }
    if (!Array.isArray(components) || components.length === 0 || components.length > CONTRACT_LIMITS.abiParameters) {
      issues.invalid(`${path}.components`, `A tuple needs 1-${CONTRACT_LIMITS.abiParameters} components.`);
      return null;
    }
    parsedComponents = [];
    for (const [index, component] of components.entries()) {
      const parsed = parseAbiParameter(component, `${path}.components[${index}]`, depth + 1, issues, false);
      if (!parsed) return null;
      parsedComponents.push(parsed);
    }
  } else if (components !== undefined) {
    issues.invalid(`${path}.components`, "Only tuple types have components.");
    return null;
  }
  return {
    ...(typeof name === "string" && name ? { name } : {}),
    type,
    ...(typeof internalType === "string" ? { internalType } : {}),
    ...(event ? { indexed: indexed === true } : {}),
    ...(parsedComponents ? { components: parsedComponents } : {}),
  };
}

function parseAbiItem(value: unknown, path: string, issues: IssueList): ContractAbiItem | null {
  if (!isRecord(value)) {
    issues.invalid(path, "ABI item must be an object.");
    return null;
  }
  const { type, name } = value;
  if (type !== "function" && type !== "event" && type !== "error") {
    issues.invalid(`${path}.type`, "Only function, event and error items are accepted (no constructor, fallback or receive).");
    return null;
  }
  if (typeof name !== "string" || !ABI_NAME.test(name)) {
    issues.invalid(`${path}.name`, "Must be a Solidity identifier up to 64 characters.");
    return null;
  }
  const rawInputs = value.inputs ?? [];
  if (!Array.isArray(rawInputs) || rawInputs.length > CONTRACT_LIMITS.abiParameters) {
    issues.invalid(`${path}.inputs`, `Must be a list of at most ${CONTRACT_LIMITS.abiParameters} parameters.`);
    return null;
  }
  const inputs: AbiParameter[] = [];
  for (const [index, input] of rawInputs.entries()) {
    const parsed = parseAbiParameter(input, `${path}.inputs[${index}]`, 0, issues, type === "event");
    if (!parsed) return null;
    inputs.push(parsed);
  }
  if (type === "event") {
    if (value.anonymous !== undefined && typeof value.anonymous !== "boolean") {
      issues.invalid(`${path}.anonymous`, "Must be a boolean.");
      return null;
    }
    const anonymous = value.anonymous === true;
    if (inputs.filter((input) => input.indexed).length > (anonymous ? 4 : 3)) {
      issues.invalid(`${path}.inputs`, "Too many indexed inputs.");
      return null;
    }
    return { type, name, anonymous, inputs };
  }
  if (type === "error") return { type, name, inputs };
  const mutability = value.stateMutability;
  if (mutability !== "nonpayable" && mutability !== "payable" && mutability !== "view" && mutability !== "pure") {
    issues.invalid(`${path}.stateMutability`, "Must be nonpayable, payable, view or pure.");
    return null;
  }
  const rawOutputs = value.outputs ?? [];
  if (!Array.isArray(rawOutputs) || rawOutputs.length > CONTRACT_LIMITS.abiParameters) {
    issues.invalid(`${path}.outputs`, `Must be a list of at most ${CONTRACT_LIMITS.abiParameters} parameters.`);
    return null;
  }
  const outputs: AbiParameter[] = [];
  for (const [index, output] of rawOutputs.entries()) {
    const parsed = parseAbiParameter(output, `${path}.outputs[${index}]`, 0, issues, false);
    if (!parsed) return null;
    outputs.push(parsed);
  }
  return { type, name, stateMutability: mutability, inputs, outputs };
}

/* ------------------------------------------------------------ literal values */

function intRange(base: string): { readonly signed: boolean; readonly bits: number } | null {
  const match = /^(u?)int([0-9]+)$/u.exec(base);
  return match ? { signed: match[1] === "", bits: Number(match[2]) } : null;
}

/** Problem with a literal for an elementary type, or null when it is valid. */
function literalProblem(base: string, literal: unknown): string | null {
  const range = intRange(base);
  if (range) {
    if (typeof literal !== "string" || !(range.signed ? /^-?(?:0|[1-9]\d{0,77})$/u : /^(?:0|[1-9]\d{0,77})$/u).test(literal) || literal === "-0") {
      return `${base} literals are decimal integer strings.`;
    }
    const value = BigInt(literal);
    const limit = 1n << BigInt(range.signed ? range.bits - 1 : range.bits);
    if (range.signed ? value < -limit || value >= limit : value >= limit) return `Out of range for ${base}.`;
    return null;
  }
  if (base === "bool") return typeof literal === "boolean" ? null : "bool literals are true or false.";
  if (base === "address") {
    if (typeof literal !== "string" || !isEvmAddress(literal)) return "address literals are 0x addresses.";
    return isChecksumAddressValid(literal) ? null : "The address checksum is wrong (mixed case must be EIP-55).";
  }
  if (base === "string") {
    return typeof literal === "string" && literal.length <= CONTRACT_LIMITS.stringLiteralLength && !CONTROL_CHARS.test(literal)
      ? null
      : `string literals are up to ${CONTRACT_LIMITS.stringLiteralLength} printable characters.`;
  }
  const fixedBytes = /^bytes([0-9]+)$/u.exec(base);
  if (fixedBytes) {
    const size = Number(fixedBytes[1]);
    return typeof literal === "string" && new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`, "u").test(literal) ? null : `${base} literals are 0x hex of exactly ${size} bytes.`;
  }
  return `No literal is accepted for ${base}.`;
}

/* ---------------------------------------------------------- binding checking */

interface ActionContext {
  readonly issues: IssueList;
  readonly inputKind: "erc20" | "native" | null;
  readonly hasOutput: boolean;
  readonly params: ReadonlyMap<string, ActionParam>;
  readonly usedParams: Set<string>;
  usesAmount: boolean;
}

function paramCompatible(param: ActionParam, base: string): boolean {
  const range = intRange(base);
  switch (param.type) {
    case "uint":
      return range !== null && !range.signed;
    case "int":
      return range !== null && range.signed;
    case "bool":
      return base === "bool";
    case "enum":
      return base === "string" || (range !== null && !range.signed);
    default:
      return false;
  }
}

function isLiteralBinding(value: unknown): value is LiteralBinding {
  return isRecord(value) && Object.keys(value).length === 1 && "literal" in value;
}

function checkSourceBinding(binding: string, base: string, name: string | undefined, path: string, ctx: ActionContext): void {
  const { issues } = ctx;
  if (base === "bytes") {
    issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "bytes arguments only accept the empty literal { \"literal\": \"0x\" }.");
    return;
  }
  if (binding.startsWith("$param.")) {
    const paramName = binding.slice("$param.".length);
    const param = ctx.params.get(paramName);
    if (!param) {
      issues.add("CONTRACT_BINDING_INVALID", path, `Unknown parameter "${paramName}": declare it in params.`);
      return;
    }
    ctx.usedParams.add(paramName);
    if (!paramCompatible(param, base)) issues.add("CONTRACT_BINDING_INVALID", path, `A ${param.type} parameter cannot bind to ${base}.`);
    return;
  }
  const kind = hasOwn(SOURCE_TYPES, binding) ? SOURCE_TYPES[binding] : undefined;
  if (!kind) {
    issues.add("CONTRACT_BINDING_INVALID", path, `Unknown binding "${binding}". Use ${Object.keys(SOURCE_TYPES).join(", ")}, $param.<name> or { "literal": ... }.`);
    return;
  }
  const range = intRange(base);
  const compatible = kind === "uint" ? range !== null && !range.signed : base === "address";
  if (!compatible) {
    issues.add("CONTRACT_BINDING_INVALID", path, `${binding} binds to ${kind === "uint" ? "uint" : "address"} arguments, not ${base}.`);
    return;
  }
  if (base === "address" && isBeneficiaryArgName(name) && binding !== "$account" && binding !== "$recipient") {
    issues.add("CONTRACT_BINDING_INVALID", path, `${name} receives the result: it must bind to $account or $recipient.`);
  }
  if (binding === "$amount") {
    ctx.usesAmount = true;
    if (!ctx.inputKind) issues.add("CONTRACT_BINDING_INVALID", path, "$amount needs an input token.");
  }
  if (binding === "$token" && ctx.inputKind !== "erc20") issues.add("CONTRACT_BINDING_INVALID", path, "$token needs an ERC-20 input token.");
  if (binding === "$minimumOutput" && !ctx.hasOutput) issues.add("CONTRACT_BINDING_INVALID", path, "$minimumOutput needs a declared output.");
}

function checkBinding(binding: unknown, param: AbiParameter, path: string, ctx: ActionContext, insideArray: boolean): void {
  const { issues } = ctx;
  const shape = typeShape(param.type);
  if (!shape) {
    issues.invalid(path, "Unsupported ABI type.");
    return;
  }
  if (shape.base === "function") {
    issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "function-typed arguments are not allowed.");
    return;
  }
  if (shape.dims.length > 0) {
    if (shape.base === "bytes") {
      issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "bytes[] arguments are not allowed (arbitrary calldata).");
      return;
    }
    const length = shape.dims[shape.dims.length - 1];
    const elementType = param.type.slice(0, param.type.lastIndexOf("["));
    if (!isRecord(binding) || Object.keys(binding).length !== 1 || !Array.isArray(binding.array)) {
      issues.add("CONTRACT_BINDING_INVALID", path, `${param.type} arguments bind to { "array": [literals] }.`);
      return;
    }
    const elements = binding.array as unknown[];
    if (elements.length > CONTRACT_LIMITS.arrayElements || (length !== null && length !== undefined && elements.length !== length)) {
      issues.add(
        "CONTRACT_BINDING_INVALID",
        path,
        length ? `${param.type} needs exactly ${length} elements (at most ${CONTRACT_LIMITS.arrayElements}).` : `At most ${CONTRACT_LIMITS.arrayElements} elements.`,
      );
      return;
    }
    const element: AbiParameter = { ...param, type: elementType };
    elements.forEach((entry, index) => checkBinding(entry, element, `${path}.array[${index}]`, ctx, true));
    return;
  }
  if (shape.base === "tuple") {
    const components = param.components ?? [];
    if (!isRecord(binding) || Object.keys(binding).length !== 1 || !Array.isArray(binding.tuple)) {
      issues.add("CONTRACT_BINDING_INVALID", path, `Tuple arguments bind to { "tuple": [one binding per member] }.`);
      return;
    }
    const members = binding.tuple as unknown[];
    if (members.length !== components.length) {
      issues.add("CONTRACT_BINDING_INVALID", path, `The tuple has ${components.length} members; got ${members.length} bindings.`);
      return;
    }
    members.forEach((member, index) => checkBinding(member, components[index] as AbiParameter, `${path}.tuple[${index}]`, ctx, insideArray));
    return;
  }
  if (typeof binding === "string") {
    if (!binding.startsWith("$")) {
      issues.add("CONTRACT_BINDING_INVALID", path, `Bind to a $source or { "literal": ... } (got a bare string).`);
      return;
    }
    if (insideArray) {
      issues.add("CONTRACT_BINDING_INVALID", path, "Array elements must be literals.");
      return;
    }
    checkSourceBinding(binding, shape.base, param.name, path, ctx);
    return;
  }
  if (isLiteralBinding(binding)) {
    if (shape.base === "bytes") {
      if (binding.literal !== "0x") issues.add("CONTRACT_ARGUMENT_FORBIDDEN", path, "bytes arguments only accept the empty literal 0x.");
      return;
    }
    if (shape.base === "address" && isBeneficiaryArgName(param.name)) {
      issues.add("CONTRACT_BINDING_INVALID", path, `${param.name} receives the result: it must bind to $account or $recipient, never a fixed address.`);
      return;
    }
    const problem = literalProblem(shape.base, binding.literal);
    if (problem) issues.add("CONTRACT_BINDING_INVALID", path, problem);
    return;
  }
  issues.add("CONTRACT_BINDING_INVALID", path, `Bind ${param.type} to a $source or { "literal": ... }.`);
}

/* ------------------------------------------------------------ shared pieces */

function parseIntegrator(value: unknown, mainnet: boolean, issues: IssueList): ContractIntegrator | null {
  if (!isRecord(value)) {
    issues.invalid("integrator", "Must be { name, website }.");
    return null;
  }
  checkKeys(value, ["name", "website"], "integrator", issues);
  const { name, website } = value;
  let ok = true;
  if (typeof name !== "string" || name.length < 2 || name.length > 40 || !/^[A-Za-z0-9 .,&'()-]+$/u.test(name) || name !== name.trim() || /\s{2}/u.test(name) || !/[A-Za-z]/u.test(name)) {
    issues.invalid("integrator.name", "Must be 2-40 characters of A-Z a-z 0-9 space . , & ' ( ) -, with a letter and single spaces.");
    ok = false;
  }
  let normalizedWebsite: string | undefined;
  if (website !== undefined) {
    const origin = normalizeWebOrigin(website);
    if (!origin) {
      issues.invalid("integrator.website", "Must be an https origin with a public host name and no path (e.g. https://acme.example).");
      ok = false;
    } else normalizedWebsite = origin;
  } else if (mainnet) {
    issues.invalid("integrator.website", "Required on mainnet networks (domain verification uses it).");
    ok = false;
  }
  if (typeof name === "string") {
    const reserved = reservedIntegratorName(name);
    if (reserved) {
      const host = normalizedWebsite ? new URL(normalizedWebsite).hostname : "";
      if (!host || !hostMatches(host, reserved.hosts)) {
        issues.invalid("integrator.name", `"${reserved.word}" is a reserved name; only ${reserved.hosts.join(", ")} (with a verified domain) may use it.`);
        ok = false;
      }
    }
  }
  if (!ok || typeof name !== "string") return null;
  return { name, ...(normalizedWebsite ? { website: normalizedWebsite } : {}) };
}

function parseVisibility(value: unknown, issues: IssueList): ContractVisibility {
  if (value === undefined || value === "private") return "private";
  if (value === "project") return "project";
  issues.invalid("visibility", value === "public" ? "public visibility is reserved." : "Must be private or project.");
  return "private";
}

function parseIntegerBound(value: unknown, signed: boolean): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || (!signed && value < 0)) return null;
    return String(value);
  }
  if (typeof value === "string" && (signed ? /^-?(?:0|[1-9]\d{0,76})$/u : /^(?:0|[1-9]\d{0,76})$/u).test(value) && value !== "-0") return value;
  return null;
}

const RESERVED_PARAM_NAMES = new Set(["amount", "amountBaseUnits", "account", "recipient", "venue", "portionBps", "provider"]);

function parseParams(value: unknown, path: string, issues: IssueList): ActionParam[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONTRACT_LIMITS.paramsPerAction) {
    issues.invalid(path, `Must be a list of at most ${CONTRACT_LIMITS.paramsPerAction} parameters.`);
    return [];
  }
  const out: ActionParam[] = [];
  const names = new Set<string>();
  value.forEach((raw, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.invalid(at, "Must be an object.");
      return;
    }
    checkKeys(raw, ["name", "type", "min", "max", "enum", "default", "required"], at, issues);
    const { name, type } = raw;
    if (typeof name !== "string" || !CONTRACT_PARAM_NAME_PATTERN.test(name) || RESERVED_PARAM_NAMES.has(name)) {
      issues.invalid(`${at}.name`, `Must match ${CONTRACT_PARAM_NAME_PATTERN.source} and not be one of ${[...RESERVED_PARAM_NAMES].join(", ")}.`);
      return;
    }
    if (names.has(name)) {
      issues.invalid(`${at}.name`, "Duplicate parameter name.");
      return;
    }
    names.add(name);
    if (type !== "uint" && type !== "int" && type !== "bool" && type !== "enum") {
      issues.invalid(`${at}.type`, "Must be uint, int, bool or enum (never addresses or bytes).");
      return;
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") issues.invalid(`${at}.required`, "Must be a boolean.");
    const required = raw.required === true;
    if (type === "uint" || type === "int") {
      const signed = type === "int";
      const min = raw.min === undefined ? undefined : parseIntegerBound(raw.min, signed);
      const max = raw.max === undefined ? undefined : parseIntegerBound(raw.max, signed);
      if (min === null) issues.invalid(`${at}.min`, `Must be an ${signed ? "" : "unsigned "}integer (number or decimal string).`);
      if (max === null) issues.invalid(`${at}.max`, `Must be an ${signed ? "" : "unsigned "}integer (number or decimal string).`);
      if (min && max && BigInt(min) > BigInt(max)) issues.invalid(`${at}.max`, "Must be at least min.");
      if (raw.enum !== undefined) issues.invalid(`${at}.enum`, "Only enum parameters list values.");
      let defaultValue: string | undefined;
      if (raw.default !== undefined) {
        const parsed = parseIntegerBound(raw.default, signed);
        if (parsed === null || (min && BigInt(parsed) < BigInt(min)) || (max && BigInt(parsed) > BigInt(max))) {
          issues.invalid(`${at}.default`, "Must be an integer within min and max.");
        } else defaultValue = parsed;
      }
      out.push({ name, type, ...(min ? { min } : {}), ...(max ? { max } : {}), ...(defaultValue !== undefined ? { default: defaultValue } : {}), ...(required ? { required } : {}) });
      return;
    }
    if (raw.min !== undefined || raw.max !== undefined) issues.invalid(at, "Only uint and int parameters take min and max.");
    if (type === "bool") {
      if (raw.enum !== undefined) issues.invalid(`${at}.enum`, "Only enum parameters list values.");
      if (raw.default !== undefined && typeof raw.default !== "boolean") issues.invalid(`${at}.default`, "Must be a boolean.");
      out.push({ name, type, ...(typeof raw.default === "boolean" ? { default: raw.default } : {}), ...(required ? { required } : {}) });
      return;
    }
    const values = raw.enum;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 16 ||
      values.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_.-]{1,32}$/u.test(entry) || !/[A-Za-z0-9]/u.test(entry)) ||
      new Set(values).size !== values.length
    ) {
      issues.invalid(`${at}.enum`, "Must list 1-16 unique values of [A-Za-z0-9_.-]{1,32} (with a letter or digit).");
      return;
    }
    if (raw.default !== undefined && (typeof raw.default !== "string" || !values.includes(raw.default))) {
      issues.invalid(`${at}.default`, "Must be one of the enum values.");
    }
    out.push({ name, type, enum: values as string[], ...(typeof raw.default === "string" && values.includes(raw.default) ? { default: raw.default } : {}), ...(required ? { required } : {}) });
  });
  return out;
}

const VERB_KEYWORDS = new Set([...CONNECTOR_WORDS, ...KEYWORD_PHRASES]);

function parsePhrases(value: unknown, path: string, issues: IssueList): ContractActionPhrases | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.invalid(path, "Must be { verbs, aliases }.");
    return undefined;
  }
  checkKeys(value, ["verbs", "aliases"], path, issues);
  const { verbs, aliases } = value;
  let ok = true;
  if (!Array.isArray(verbs) || verbs.length === 0 || verbs.length > CONTRACT_LIMITS.verbsPerAction) {
    issues.invalid(`${path}.verbs`, `List 1-${CONTRACT_LIMITS.verbsPerAction} verbs (with aliases).`);
    ok = false;
  } else {
    verbs.forEach((verb, index) => {
      if (typeof verb !== "string" || !CONTRACT_VERB_PATTERN.test(verb) || VERB_KEYWORDS.has(verb)) {
        issues.invalid(`${path}.verbs[${index}]`, `Must match ${CONTRACT_VERB_PATTERN.source} and not be a grammar keyword.`);
        ok = false;
      }
    });
    if (new Set(verbs).size !== verbs.length) {
      issues.invalid(`${path}.verbs`, "Duplicate verb.");
      ok = false;
    }
  }
  if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > CONTRACT_LIMITS.aliasesPerAction) {
    issues.invalid(`${path}.aliases`, `List 1-${CONTRACT_LIMITS.aliasesPerAction} aliases (with verbs).`);
    ok = false;
  } else {
    aliases.forEach((alias, index) => {
      if (typeof alias !== "string" || !CONTRACT_ALIAS_PATTERN.test(alias) || /\s{2}|\s$/u.test(alias)) {
        issues.invalid(`${path}.aliases[${index}]`, `Must match ${CONTRACT_ALIAS_PATTERN.source} with single spaces.`);
        ok = false;
        return;
      }
      const reserved = reservedContractPhrase(alias);
      if (reserved) {
        issues.invalid(`${path}.aliases[${index}]`, `"${alias}" uses the reserved word "${reserved}" (networks, assets, built-in venues, kletia and grammar keywords are reserved).`);
        ok = false;
      }
    });
    if (new Set(aliases).size !== aliases.length) {
      issues.invalid(`${path}.aliases`, "Duplicate alias.");
      ok = false;
    }
  }
  return ok ? { verbs: verbs as string[], aliases: aliases as string[] } : undefined;
}

function parseLimits(
  value: unknown,
  path: string,
  input: AssetDescriptor | null,
  mainnet: boolean,
  issues: IssueList,
): ContractActionLimits | undefined {
  if (value === undefined) {
    if (mainnet && input) issues.invalid(`${path}.maxAmount`, "limits.maxAmount is required for spending actions on mainnet.");
    return undefined;
  }
  if (!isRecord(value)) {
    issues.invalid(path, "Must be { minAmount, maxAmount }.");
    return undefined;
  }
  checkKeys(value, ["minAmount", "maxAmount"], path, issues);
  if (!input) {
    issues.invalid(path, "Limits apply to the input token: declare input first.");
    return undefined;
  }
  const out: { minAmount?: string; maxAmount?: string } = {};
  for (const key of ["minAmount", "maxAmount"] as const) {
    const amount = value[key];
    if (amount === undefined) continue;
    if (!isDecimalAmount(amount) || /^0(?:\.0*)?$/u.test(amount)) {
      issues.invalid(`${path}.${key}`, "Must be a positive decimal string in input-token units.");
      continue;
    }
    try {
      toBaseUnits(amount, input.decimals);
      out[key] = amount;
    } catch {
      issues.invalid(`${path}.${key}`, `At most ${input.decimals} decimals for ${input.symbol}.`);
    }
  }
  if (mainnet && !out.maxAmount) issues.invalid(`${path}.maxAmount`, "Required for spending actions on mainnet.");
  if (out.minAmount && out.maxAmount && BigInt(toBaseUnits(out.minAmount, input.decimals)) > BigInt(toBaseUnits(out.maxAmount, input.decimals))) {
    issues.invalid(`${path}.minAmount`, "Must not exceed maxAmount.");
  }
  return out;
}

function parseTolerance(value: unknown, path: string, issues: IssueList): number {
  if (value === undefined) return CONTRACT_LIMITS.defaultToleranceBps;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > CONTRACT_LIMITS.maxToleranceBps) {
    issues.invalid(path, `Must be an integer between 0 and ${CONTRACT_LIMITS.maxToleranceBps}.`);
    return CONTRACT_LIMITS.defaultToleranceBps;
  }
  return value;
}

function parseCommonAction(raw: Record<string, unknown>, at: string, ids: Set<string>, issues: IssueList): { id: string; label: string } | null {
  const { id, label } = raw;
  let ok = true;
  if (typeof id !== "string" || !CONTRACT_ENTRY_ID_PATTERN.test(id)) {
    issues.invalid(`${at}.id`, `Must match ${CONTRACT_ENTRY_ID_PATTERN.source}.`);
    ok = false;
  } else if (ids.has(id)) {
    issues.invalid(`${at}.id`, "Duplicate action id.");
    ok = false;
  } else ids.add(id);
  if (!isPlainText(label, CONTRACT_LIMITS.labelLength)) {
    issues.invalid(`${at}.label`, `Must be 1-${CONTRACT_LIMITS.labelLength} printable characters.`);
    ok = false;
  }
  return ok ? { id: id as string, label: label as string } : null;
}

function checkPhraseCollisions(actions: readonly { readonly phrases?: ContractActionPhrases }[], issues: IssueList): void {
  const seen = new Map<string, number>();
  actions.forEach((action, index) => {
    for (const alias of action.phrases?.aliases ?? []) {
      for (const verb of action.phrases?.verbs ?? []) {
        const key = `${verb} ${alias}`;
        const other = seen.get(key);
        if (other !== undefined && other !== index) {
          issues.invalid(`actions[${index}].phrases`, `"${verb} … ${alias}" already selects actions[${other}]; each (verb, alias) pair must select one action.`);
        } else seen.set(key, index);
      }
    }
  });
}

/* ------------------------------------------------------------------- EVM */

function parseEvmDefinition(input: Record<string, unknown>, network: NetworkKey, issues: IssueList, options: ContractValidationOptions): EvmContractDefinition | null {
  checkKeys(input, ["vm", "network", "address", "integrator", "visibility", "abi", "addresses", "actions"], "", issues);
  const mainnet = CHAINS[network].environment === "mainnet";
  const integrator = parseIntegrator(input.integrator, mainnet, issues);
  const visibility = parseVisibility(input.visibility, issues);

  let address: string | null = null;
  if (typeof input.address !== "string" || !isEvmAddress(input.address)) {
    issues.invalid("address", "Must be a 0x address.");
  } else if (!isChecksumAddressValid(input.address)) {
    issues.invalid("address", "The address checksum is wrong (mixed case must be EIP-55).");
  } else {
    const denied = deniedTargetReason(network, input.address, options.denylist);
    if (denied) issues.add("CONTRACT_DENIED", "address", `This address is ${denied}.`);
    address = toChecksumAddress(input.address);
  }

  const addresses: ContractAddressEntry[] = [];
  const labels = new Map<string, string>();
  if (input.addresses !== undefined) {
    if (!Array.isArray(input.addresses) || input.addresses.length > CONTRACT_LIMITS.extraAddresses) {
      issues.invalid("addresses", `Must be a list of at most ${CONTRACT_LIMITS.extraAddresses} { label, address } entries.`);
    } else {
      input.addresses.forEach((entry, index) => {
        const at = `addresses[${index}]`;
        if (!isRecord(entry)) {
          issues.invalid(at, "Must be { label, address }.");
          return;
        }
        checkKeys(entry, ["label", "address"], at, issues);
        const { label, address: entryAddress } = entry;
        if (typeof label !== "string" || !CONTRACT_ADDRESS_LABEL_PATTERN.test(label) || label === "self") {
          issues.invalid(`${at}.label`, `Must match ${CONTRACT_ADDRESS_LABEL_PATTERN.source} (not "self").`);
          return;
        }
        if (labels.has(label)) {
          issues.invalid(`${at}.label`, "Duplicate label.");
          return;
        }
        if (typeof entryAddress !== "string" || !isEvmAddress(entryAddress) || !isChecksumAddressValid(entryAddress)) {
          issues.invalid(`${at}.address`, "Must be a 0x address (EIP-55 when mixed case).");
          return;
        }
        if ((address && entryAddress.toLowerCase() === address.toLowerCase()) || [...labels.values()].includes(entryAddress.toLowerCase())) {
          issues.invalid(`${at}.address`, "Duplicate address (the target is $self).");
          return;
        }
        const denied = deniedTargetReason(network, entryAddress, options.denylist);
        if (denied) issues.add("CONTRACT_DENIED", `${at}.address`, `This address is ${denied}.`);
        labels.set(label, entryAddress.toLowerCase());
        addresses.push({ label, address: toChecksumAddress(entryAddress) });
      });
    }
  }

  const abi: ContractAbiItem[] = [];
  if (!Array.isArray(input.abi) || input.abi.length === 0 || input.abi.length > CONTRACT_LIMITS.abiItems) {
    issues.invalid("abi", `Must be a list of 1-${CONTRACT_LIMITS.abiItems} ABI items.`);
  } else {
    input.abi.forEach((item, index) => {
      const parsed = parseAbiItem(item, `abi[${index}]`, issues);
      if (parsed) abi.push(parsed);
    });
  }
  const functions = new Map<string, { item: AbiFunctionItem; index: number }>();
  const eventsByName = new Map<string, AbiEventItem[]>();
  const eventsBySignature = new Map<string, AbiEventItem>();
  abi.forEach((item, index) => {
    const signature = abiItemSignature(item);
    if (item.type === "function") {
      if (functions.has(signature)) {
        issues.invalid(`abi[${index}]`, `Duplicate function ${signature}.`);
        return;
      }
      functions.set(signature, { item, index });
      const forbidden = forbiddenFunctionReason(item.name, signature);
      if (forbidden) issues.add("CONTRACT_FUNCTION_FORBIDDEN", `abi[${index}]`, forbidden);
    } else if (item.type === "event") {
      if (eventsBySignature.has(signature)) {
        issues.invalid(`abi[${index}]`, `Duplicate event ${signature}.`);
        return;
      }
      eventsBySignature.set(signature, item);
      eventsByName.set(item.name, [...(eventsByName.get(item.name) ?? []), item]);
    }
  });

  const actions: EvmContractAction[] = [];
  const usedFunctions = new Set<string>();
  const ids = new Set<string>();
  const knownLabel = (reference: unknown): reference is string => reference === "$self" || (typeof reference === "string" && labels.has(reference));
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > CONTRACT_LIMITS.actionsPerRegistration) {
    issues.invalid("actions", `Must be a list of 1-${CONTRACT_LIMITS.actionsPerRegistration} actions.`);
  } else {
    input.actions.forEach((raw, actionIndex) => {
      const at = `actions[${actionIndex}]`;
      if (!isRecord(raw)) {
        issues.invalid(at, "Action must be an object.");
        return;
      }
      checkKeys(raw, ["id", "label", "function", "args", "input", "value", "output", "events", "params", "recipient", "phrases", "limits"], at, issues);
      const common = parseCommonAction(raw, at, ids, issues);

      // function
      const signature = raw.function;
      const resolved = typeof signature === "string" ? functions.get(signature) : undefined;
      if (!resolved) {
        issues.invalid(`${at}.function`, "Must be the canonical signature (name(type,...)) of a function item in abi.");
      } else {
        usedFunctions.add(signature as string);
        const mutability = resolved.item.stateMutability;
        if (mutability === "view" || mutability === "pure") {
          issues.add("CONTRACT_FUNCTION_FORBIDDEN", `${at}.function`, `${resolved.item.name} is read-only (${mutability}); only state-changing functions can be registered.`);
        }
      }

      // input
      let inputAsset: AssetDescriptor | null = null;
      let parsedInput: EvmActionInput | undefined;
      if (raw.input !== undefined) {
        if (!isRecord(raw.input)) issues.invalid(`${at}.input`, "Must be { token, approval }.");
        else {
          checkKeys(raw.input, ["token", "approval"], `${at}.input`, issues);
          inputAsset = typeof raw.input.token === "string" ? resolveContractAsset(network, raw.input.token) : null;
          if (!inputAsset) {
            issues.invalid(`${at}.input.token`, "Use a registry asset on this network (GET /v1/assets): a symbol, a CAIP-19 id, or native.");
          }
          let approval: { spender: string } | undefined;
          if (raw.input.approval !== undefined) {
            const spender = isRecord(raw.input.approval) ? raw.input.approval.spender : undefined;
            if (isRecord(raw.input.approval)) checkKeys(raw.input.approval, ["spender"], `${at}.input.approval`, issues);
            if (!knownLabel(spender)) issues.add("CONTRACT_BINDING_INVALID", `${at}.input.approval.spender`, "Must be $self or a label from addresses.");
            else approval = { spender };
            if (inputAsset && inputAsset.address === null) issues.add("CONTRACT_BINDING_INVALID", `${at}.input.approval`, "Native input needs no approval.");
          }
          if (inputAsset) parsedInput = { token: raw.input.token as string, ...(approval ? { approval } : {}) };
        }
      }
      const inputKind = inputAsset ? (inputAsset.address === null ? "native" : "erc20") : null;

      // output
      let parsedOutput: EvmActionOutput | undefined;
      if (raw.output !== undefined) {
        if (!isRecord(raw.output)) issues.invalid(`${at}.output`, "Must be { token, toleranceBps }.");
        else {
          checkKeys(raw.output, ["token", "toleranceBps"], `${at}.output`, issues);
          const token = raw.output.token;
          const toleranceBps = parseTolerance(raw.output.toleranceBps, `${at}.output.toleranceBps`, issues);
          if (knownLabel(token)) parsedOutput = { token, toleranceBps };
          else if (typeof token === "string" && isEvmAddress(token) && isChecksumAddressValid(token) && BigInt(token) > 0xffffn) {
            if (inputAsset?.address && inputAsset.address.toLowerCase() === token.toLowerCase()) {
              issues.invalid(`${at}.output.token`, "The output must differ from the input token (deltas would cancel out).");
            } else parsedOutput = { token: toChecksumAddress(token), toleranceBps };
          } else {
            issues.invalid(`${at}.output.token`, "Must be $self, a label from addresses, or an ERC-20 address (native outputs cannot be proven from logs).");
          }
        }
      }

      // params
      const params = parseParams(raw.params, `${at}.params`, issues);
      const ctx: ActionContext = {
        issues,
        inputKind,
        hasOutput: parsedOutput !== undefined,
        params: new Map(params.map((param) => [param.name, param])),
        usedParams: new Set(),
        usesAmount: false,
      };

      // args
      const args: ArgBinding[] = [];
      if (!Array.isArray(raw.args)) issues.add("CONTRACT_BINDING_INVALID", `${at}.args`, "Must list one binding per ABI input.");
      else if (resolved) {
        const inputs = resolved.item.inputs;
        if (raw.args.length !== inputs.length) {
          issues.add("CONTRACT_BINDING_INVALID", `${at}.args`, `${resolved.item.name} takes ${inputs.length} arguments; got ${raw.args.length} bindings.`);
        } else {
          raw.args.forEach((binding, index) => {
            checkBinding(binding, inputs[index] as AbiParameter, `${at}.args[${index}]`, ctx, false);
            args.push(binding as ArgBinding);
          });
        }
      }

      // value
      let parsedValue: EvmActionValue | undefined;
      const payable = resolved?.item.stateMutability === "payable";
      if (raw.value !== undefined) {
        if (!isRecord(raw.value)) issues.add("CONTRACT_BINDING_INVALID", `${at}.value`, "Must be { bind, max }.");
        else {
          checkKeys(raw.value, ["bind", "max"], `${at}.value`, issues);
          const { bind, max } = raw.value;
          const maxOk = isBaseUnitAmount(max) && BigInt(max) < 1n << 256n;
          if (!maxOk) issues.add("CONTRACT_BINDING_INVALID", `${at}.value.max`, "Required: the wei cap as a decimal integer string.");
          if (bind === "$amount") {
            if (inputKind !== "native") issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "$amount as value needs input.token native.");
            else ctx.usesAmount = true;
          } else if (isBaseUnitAmount(bind)) {
            if (maxOk && BigInt(bind) > BigInt(max as string)) issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "Exceeds value.max.");
            if (inputKind === "native") issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "A native input is sent as value: bind $amount.");
          } else {
            issues.add("CONTRACT_BINDING_INVALID", `${at}.value.bind`, "Must be $amount or a wei literal.");
          }
          if (resolved && !payable) issues.add("CONTRACT_BINDING_INVALID", `${at}.value`, `${resolved.item.name} is not payable.`);
          if (typeof bind === "string" && maxOk) parsedValue = { bind, max: max as string };
          if (inputAsset && inputKind === "native" && maxOk && isRecord(raw.limits) && isDecimalAmount(raw.limits.maxAmount)) {
            try {
              if (BigInt(toBaseUnits(raw.limits.maxAmount, inputAsset.decimals)) > BigInt(max as string)) {
                issues.add("CONTRACT_BINDING_INVALID", `${at}.limits.maxAmount`, "Exceeds value.max.");
              }
            } catch {
              // reported by parseLimits
            }
          }
        }
      } else if (payable) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.value`, `${resolved?.item.name} is payable: declare value { bind, max }.`);
      }
      if (inputKind === "native" && (!payable || raw.value === undefined)) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.input.token`, "A native input needs a payable function with value { bind: \"$amount\", max }.");
      }
      if (inputKind === "erc20" && !ctx.usesAmount && resolved) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.args`, "An action with an ERC-20 input must bind $amount to an argument (verification decodes the amount from the call).");
      }

      // events
      const events: EventBinding[] = [];
      if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > CONTRACT_LIMITS.eventsPerAction) {
        issues.add("CONTRACT_BINDING_INVALID", `${at}.events`, `Declare 1-${CONTRACT_LIMITS.eventsPerAction} success events.`);
      } else {
        raw.events.forEach((rawEvent, eventIndex) => {
          const eventAt = `${at}.events[${eventIndex}]`;
          if (!isRecord(rawEvent)) {
            issues.add("CONTRACT_BINDING_INVALID", eventAt, "Must be { event, emitter, where, output }.");
            return;
          }
          checkKeys(rawEvent, ["event", "emitter", "where", "output"], eventAt, issues);
          const reference = rawEvent.event;
          let item: AbiEventItem | undefined;
          if (typeof reference === "string" && reference.includes("(")) item = eventsBySignature.get(reference);
          else if (typeof reference === "string") {
            const candidates = eventsByName.get(reference) ?? [];
            if (candidates.length > 1) {
              issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.event`, `Several events are named ${reference}: use the full signature.`);
              return;
            }
            item = candidates[0];
          }
          if (!item) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.event`, "Must be the name or canonical signature of an event item in abi.");
            return;
          }
          if (item.anonymous) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.event`, "Anonymous events cannot prove success.");
            return;
          }
          if (!knownLabel(rawEvent.emitter)) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.emitter`, "Must be $self or a label from addresses.");
            return;
          }
          if (!isRecord(rawEvent.where) || Object.keys(rawEvent.where).length === 0) {
            issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.where`, "Bind at least one event input to $account or $recipient.");
            return;
          }
          const where = new Map<string, EventWhereBinding>();
          let bindsUser = false;
          for (const [field, binding] of Object.entries(rawEvent.where)) {
            const whereAt = `${eventAt}.where.${field}`;
            const matches = item.inputs.filter((entry) => entry.name === field);
            if (matches.length !== 1) {
              issues.add("CONTRACT_BINDING_INVALID", whereAt, `Not a (unique) input of ${item.name}.`);
              continue;
            }
            const eventInput = matches[0] as AbiParameter;
            const shape = typeShape(eventInput.type);
            if (!shape || shape.dims.length > 0 || shape.base === "tuple" || shape.base === "string" || shape.base === "bytes" || shape.base === "function") {
              issues.add("CONTRACT_BINDING_INVALID", whereAt, `Only address, bool, uint, int and bytesN inputs can be matched (not ${eventInput.type}).`);
              continue;
            }
            if (typeof binding === "string") {
              if (!["$account", "$recipient", "$amount", "$token", "$self"].includes(binding)) {
                issues.add("CONTRACT_BINDING_INVALID", whereAt, "Use $account, $recipient, $amount, $token, $self or { \"literal\": ... }.");
                continue;
              }
              const range = intRange(shape.base);
              const expectsUint = binding === "$amount";
              if (expectsUint ? !(range && !range.signed) : shape.base !== "address") {
                issues.add("CONTRACT_BINDING_INVALID", whereAt, `${binding} cannot match a ${eventInput.type} input.`);
                continue;
              }
              if (binding === "$amount" && !inputKind) issues.add("CONTRACT_BINDING_INVALID", whereAt, "$amount needs an input token.");
              if (binding === "$token" && inputKind !== "erc20") issues.add("CONTRACT_BINDING_INVALID", whereAt, "$token needs an ERC-20 input token.");
              if (binding === "$account" || binding === "$recipient") bindsUser = true;
              where.set(field, binding as EventWhereBinding);
            } else if (isLiteralBinding(binding)) {
              const problem = literalProblem(shape.base, binding.literal);
              if (problem) {
                issues.add("CONTRACT_BINDING_INVALID", whereAt, problem);
                continue;
              }
              where.set(field, { literal: binding.literal });
            } else {
              issues.add("CONTRACT_BINDING_INVALID", whereAt, "Use $account, $recipient, $amount, $token, $self or { \"literal\": ... }.");
            }
          }
          if (!bindsUser) issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.where`, "At least one input must bind $account or $recipient, so an unrelated emission cannot prove success.");
          let output: string | undefined;
          if (rawEvent.output !== undefined) {
            const outputInput = typeof rawEvent.output === "string" ? item.inputs.filter((entry) => entry.name === rawEvent.output) : [];
            const range = outputInput.length === 1 ? intRange((outputInput[0] as AbiParameter).type) : null;
            if (!range || range.signed) issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.output`, "Must name a uint input of the event.");
            else if (!parsedOutput) issues.add("CONTRACT_BINDING_INVALID", `${eventAt}.output`, "Declare the action's output token first.");
            else output = rawEvent.output as string;
          }
          events.push({ event: abiItemSignature(item), emitter: rawEvent.emitter, where: Object.fromEntries(where), ...(output ? { output } : {}) });
        });
      }

      for (const param of params) {
        if (!ctx.usedParams.has(param.name)) issues.invalid(`${at}.params`, `Parameter ${param.name} is never bound.`);
      }
      let recipient: "account" | "any" = "account";
      if (raw.recipient !== undefined) {
        if (raw.recipient !== "account" && raw.recipient !== "any") issues.invalid(`${at}.recipient`, "Must be account or any.");
        else recipient = raw.recipient;
      }
      const phrases = parsePhrases(raw.phrases, `${at}.phrases`, issues);
      const limits = parseLimits(raw.limits, `${at}.limits`, inputAsset, mainnet, issues);
      if (!common || !resolved) return;
      actions.push({
        id: common.id,
        label: common.label,
        function: signature as string,
        args,
        ...(parsedInput ? { input: parsedInput } : {}),
        ...(parsedValue ? { value: parsedValue } : {}),
        ...(parsedOutput ? { output: parsedOutput } : {}),
        events,
        ...(params.length ? { params } : {}),
        recipient,
        ...(phrases ? { phrases } : {}),
        ...(limits && (limits.minAmount || limits.maxAmount) ? { limits } : {}),
      });
    });
  }
  for (const [signature, { index }] of functions) {
    if (!usedFunctions.has(signature)) issues.invalid(`abi[${index}]`, `${signature} is not used by any action: remove it (the ABI is an allowlist).`);
  }
  checkPhraseCollisions(actions, issues);
  if (!integrator || !address) return null;
  return {
    vm: "evm",
    network,
    address,
    integrator,
    visibility,
    abi,
    ...(addresses.length ? { addresses } : {}),
    actions,
  };
}

/* ------------------------------------------------------------------- Solana */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu;

function parseSolanaDefinition(input: Record<string, unknown>, network: NetworkKey, issues: IssueList, options: ContractValidationOptions): SolanaActionDefinition | null {
  checkKeys(input, ["vm", "network", "integrator", "visibility", "origin", "programs", "payees", "actions"], "", issues);
  const mainnet = CHAINS[network].environment === "mainnet";
  const integrator = parseIntegrator(input.integrator, mainnet, issues);
  const visibility = parseVisibility(input.visibility, issues);
  const origin = normalizeWebOrigin(input.origin, { allowPort: true });
  if (!origin) issues.add("ACTION_URL_FORBIDDEN", "origin", "Must be an https origin with a public host name (port 443 or 1024+), without credentials, path, query or fragment.");

  const programs: string[] = [];
  if (!Array.isArray(input.programs) || input.programs.length === 0 || input.programs.length > CONTRACT_LIMITS.programs) {
    issues.add("PROGRAM_NOT_ALLOWED", "programs", `List 1-${CONTRACT_LIMITS.programs} program ids.`);
  } else {
    input.programs.forEach((program, index) => {
      if (typeof program !== "string" || !isSolanaAddress(program)) {
        issues.add("PROGRAM_NOT_ALLOWED", `programs[${index}]`, "Must be a base58 program id.");
        return;
      }
      if (programs.includes(program)) {
        issues.add("PROGRAM_NOT_ALLOWED", `programs[${index}]`, "Duplicate program.");
        return;
      }
      const denied = deniedTargetReason(network, program, options.denylist);
      if (denied) issues.add("PROGRAM_NOT_ALLOWED", `programs[${index}]`, `${program}: ${denied}.`);
      programs.push(program);
    });
  }

  const payees: SolanaActionPayee[] = [];
  if (input.payees !== undefined) {
    if (!Array.isArray(input.payees) || input.payees.length > CONTRACT_LIMITS.payees) {
      issues.invalid("payees", `Must be a list of at most ${CONTRACT_LIMITS.payees} { label, address, maxLamports } entries.`);
    } else {
      input.payees.forEach((payee, index) => {
        const at = `payees[${index}]`;
        if (!isRecord(payee)) {
          issues.invalid(at, "Must be { label, address, maxLamports }.");
          return;
        }
        checkKeys(payee, ["label", "address", "maxLamports"], at, issues);
        const { label, address, maxLamports } = payee;
        if (!isPlainText(label, 32)) {
          issues.invalid(`${at}.label`, "Must be 1-32 printable characters.");
          return;
        }
        if (typeof address !== "string" || !isSolanaAddress(address) || programs.includes(address) || payees.some((entry) => entry.address === address)) {
          issues.invalid(`${at}.address`, "Must be a base58 address, not an allowlisted program, listed once.");
          return;
        }
        if (!isBaseUnitAmount(maxLamports) || BigInt(maxLamports) <= 0n || BigInt(maxLamports) >= 1n << 64n) {
          issues.invalid(`${at}.maxLamports`, "Must be a positive integer string (lamports).");
          return;
        }
        payees.push({ label, address, maxLamports });
      });
    }
  }

  const actions: SolanaActionEndpoint[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > CONTRACT_LIMITS.actionsPerRegistration) {
    issues.invalid("actions", `Must be a list of 1-${CONTRACT_LIMITS.actionsPerRegistration} actions.`);
  } else {
    input.actions.forEach((raw, actionIndex) => {
      const at = `actions[${actionIndex}]`;
      if (!isRecord(raw)) {
        issues.invalid(at, "Action must be an object.");
        return;
      }
      checkKeys(raw, ["id", "label", "href", "primaryProgram", "input", "output", "params", "phrases", "limits"], at, issues);
      const common = parseCommonAction(raw, at, ids, issues);
      const params = parseParams(raw.params, `${at}.params`, issues);

      let inputAsset: AssetDescriptor | null = null;
      if (raw.input !== undefined) {
        if (!isRecord(raw.input)) issues.invalid(`${at}.input`, "Must be { token }.");
        else {
          checkKeys(raw.input, ["token"], `${at}.input`, issues);
          inputAsset = typeof raw.input.token === "string" ? resolveContractAsset(network, raw.input.token) : null;
          if (!inputAsset) issues.invalid(`${at}.input.token`, "Use a registry asset on this network (GET /v1/assets): a symbol, a CAIP-19 id, or native.");
        }
      }

      let href: string | null = null;
      const rawHref = raw.href;
      if (typeof rawHref !== "string" || rawHref.length > CONTRACT_LIMITS.hrefLength || CONTROL_CHARS.test(rawHref) || /\s/u.test(rawHref)) {
        issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, `Must be a URL up to ${CONTRACT_LIMITS.hrefLength} characters on the registered origin.`);
      } else if (origin) {
        const placeholders = [...rawHref.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
        const stripped = rawHref.replace(PLACEHOLDER, "x");
        let url: URL | null = null;
        try {
          url = new URL(stripped);
        } catch {
          url = null;
        }
        const allowed = new Set(["amount", "amountBaseUnits", ...params.map((param) => param.name)]);
        if (!rawHref.startsWith(`${origin}/`) || !url || url.origin !== origin || url.username || url.password || url.hash || stripped.includes("#")) {
          issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, `Must start with ${origin}/ (no credentials or fragment).`);
        } else if (/[{}]/u.test(stripped)) {
          issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, "Placeholders are {amount}, {amountBaseUnits} or {<param>} only.");
        } else if (/\\|%2e/iu.test(stripped) || (stripped.slice(origin.length).split("?")[0] ?? "").split("/").some((segment) => segment === ".." || segment === ".")) {
          issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, "Backslashes and dot segments are not allowed.");
        } else {
          const unknown = placeholders.filter((name) => !allowed.has(name));
          const amountPlaceholder = placeholders.some((name) => name === "amount" || name === "amountBaseUnits");
          if (unknown.length) issues.add("ACTION_URL_FORBIDDEN", `${at}.href`, `Unknown placeholders: ${unknown.join(", ")} (declare params).`);
          else if (inputAsset && !amountPlaceholder) issues.invalid(`${at}.href`, "A spending action must carry {amount} or {amountBaseUnits}.");
          else if (!inputAsset && amountPlaceholder) issues.invalid(`${at}.href`, "{amount} needs an input token.");
          else href = rawHref;
        }
      }

      const primaryProgram = raw.primaryProgram;
      if (typeof primaryProgram !== "string" || !programs.includes(primaryProgram)) {
        issues.add("PROGRAM_NOT_ALLOWED", `${at}.primaryProgram`, "Must be one of programs.");
      }

      let output: SolanaActionOutput | undefined;
      if (raw.output !== undefined) {
        if (!isRecord(raw.output)) issues.invalid(`${at}.output`, "Must be { mint, toleranceBps }.");
        else {
          checkKeys(raw.output, ["mint", "toleranceBps"], `${at}.output`, issues);
          const toleranceBps = parseTolerance(raw.output.toleranceBps, `${at}.output.toleranceBps`, issues);
          if (typeof raw.output.mint !== "string" || !isSolanaAddress(raw.output.mint) || programs.includes(raw.output.mint)) {
            issues.invalid(`${at}.output.mint`, "Must be an SPL mint address.");
          } else if (inputAsset?.address === raw.output.mint) {
            issues.invalid(`${at}.output.mint`, "The output must differ from the input token (deltas would cancel out).");
          } else output = { mint: raw.output.mint, toleranceBps };
        }
      }
      const phrases = parsePhrases(raw.phrases, `${at}.phrases`, issues);
      const limits = parseLimits(raw.limits, `${at}.limits`, inputAsset, mainnet, issues);
      if (!common || !href || typeof primaryProgram !== "string" || !programs.includes(primaryProgram)) return;
      actions.push({
        id: common.id,
        label: common.label,
        href,
        primaryProgram,
        ...(inputAsset ? { input: { token: (raw.input as Record<string, unknown>).token as string } } : {}),
        ...(output ? { output } : {}),
        ...(params.length ? { params } : {}),
        ...(phrases ? { phrases } : {}),
        ...(limits && (limits.minAmount || limits.maxAmount) ? { limits } : {}),
      });
    });
  }
  checkPhraseCollisions(actions, issues);
  if (!integrator || !origin) return null;
  return {
    vm: "svm",
    network,
    integrator,
    visibility,
    origin,
    programs,
    ...(payees.length ? { payees } : {}),
    actions,
  };
}

/**
 * Static validation of a registration body (no network access). Returns the
 * normalised definition (checksummed addresses, normalised origins, defaults
 * filled in: `visibility`, `recipient`, `toleranceBps`; ABI items reduced to
 * their meaningful keys) or every issue with its error code.
 */
export function validateContractDefinition(input: unknown, options: ContractValidationOptions = {}): ContractValidationResult {
  const issues = new IssueList();
  if (!isRecord(input)) {
    issues.invalid("", "The definition must be an object.");
    return { ok: false, code: "CONTRACT_DEFINITION_INVALID", issues: issues.list };
  }
  const { vm, network } = input;
  if (vm !== "evm" && vm !== "svm") issues.invalid("vm", "Must be evm or svm.");
  const chain = isNetworkKey(network) ? CHAINS[network] : undefined;
  if (!chain) issues.invalid("network", "Unknown network.");
  else if ((vm === "evm" || vm === "svm") && chain.vm !== vm) {
    issues.invalid("network", vm === "evm" ? "Use an EVM network for vm evm." : "Use a Solana network for vm svm.");
  }
  if (issues.list.length > 0 || !chain) return { ok: false, code: primaryContractIssueCode(issues.list), issues: issues.list };
  const value =
    vm === "evm"
      ? parseEvmDefinition(input, chain.key, issues, options)
      : parseSolanaDefinition(input, chain.key, issues, options);
  if (value && issues.list.length === 0) {
    const size = utf8.encode(canonicalJson(value)).length;
    if (size > CONTRACT_LIMITS.definitionBytes) issues.invalid("", `The definition is ${size} bytes; the limit is ${CONTRACT_LIMITS.definitionBytes}.`);
  }
  if (!value || issues.list.length > 0) {
    if (issues.list.length === 0) issues.invalid("", "Invalid definition.");
    return { ok: false, code: primaryContractIssueCode(issues.list), issues: issues.list };
  }
  return { ok: true, value };
}

/* ====================================================== params at plan time */

export type ContractParamValues = Readonly<Record<string, string | boolean>>;

/**
 * Validates user parameter values against an entry's declared params and
 * fills defaults. `uint`/`int` values become decimal strings, `bool` stays a
 * boolean, `enum` a string. Keys that are not declared are refused, except the
 * planner's own `portionBps`.
 */
export function resolveContractParams(
  declared: readonly ActionParam[] | undefined,
  values: Readonly<Record<string, string | number | boolean>> | undefined,
): { readonly ok: true; readonly values: ContractParamValues } | { readonly ok: false; readonly issues: readonly ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const out: Record<string, string | boolean> = {};
  const byName = new Map((declared ?? []).map((param) => [param.name, param]));
  for (const key of Object.keys(values ?? {})) {
    if (!byName.has(key) && key !== "portionBps") issues.push({ path: `params.${key}`, message: "Not a parameter of this action." });
  }
  for (const param of declared ?? []) {
    const raw = values && hasOwn(values, param.name) ? values[param.name] : undefined;
    const path = `params.${param.name}`;
    if (raw === undefined) {
      if (param.default !== undefined) out[param.name] = param.default;
      else if (param.required) issues.push({ path, message: "Required." });
      continue;
    }
    if (param.type === "bool") {
      if (typeof raw === "boolean") out[param.name] = raw;
      else if (raw === "true" || raw === "false") out[param.name] = raw === "true";
      else issues.push({ path, message: "Must be true or false." });
      continue;
    }
    if (param.type === "enum") {
      if (typeof raw === "string" && (param.enum ?? []).includes(raw)) out[param.name] = raw;
      else issues.push({ path, message: `Must be one of ${(param.enum ?? []).join(", ")}.` });
      continue;
    }
    const parsed = parseIntegerBound(raw, param.type === "int");
    if (parsed === null) {
      issues.push({ path, message: `Must be an ${param.type === "int" ? "" : "unsigned "}integer.` });
      continue;
    }
    if ((param.min !== undefined && BigInt(parsed) < BigInt(param.min)) || (param.max !== undefined && BigInt(parsed) > BigInt(param.max))) {
      issues.push({ path, message: `Must be between ${param.min ?? "-∞"} and ${param.max ?? "∞"}.` });
      continue;
    }
    out[param.name] = parsed;
  }
  return issues.length ? { ok: false, issues } : { ok: true, values: out };
}

/* ========================================================= canonical hashing */

/** Deterministic JSON: object keys sorted, no whitespace, `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite numbers have no canonical JSON form.");
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * The security-relevant part of a definition: everything except each
 * action's `label` and `phrases` (editable without a new revision delay).
 */
export function contractSecurityFields(definition: ContractDefinition): unknown {
  return {
    ...definition,
    actions: definition.actions.map((action) => {
      const { label: _label, phrases: _phrases, ...rest } = action;
      return rest;
    }),
  };
}

/** True when the change between two definitions touches a security-relevant field. */
export function isSecurityRelevantChange(before: ContractDefinition, after: ContractDefinition): boolean {
  return canonicalJson(contractSecurityFields(before)) !== canonicalJson(contractSecurityFields(after));
}

/**
 * `definitionHash`: sha256 hex of `canonicalJson(contractSecurityFields(d))`
 * (Web Crypto; Node can equally hash the same string with createHash).
 */
export async function contractDefinitionHash(definition: ContractDefinition): Promise<string> {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto is not available in this runtime.");
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(canonicalJson(contractSecurityFields(definition))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The store's `target`: lower-case contract address (EVM) or the origin (Solana Actions). */
export function contractTarget(definition: ContractDefinition): string {
  return definition.vm === "evm" ? definition.address.toLowerCase() : definition.origin;
}

/** The function item an EVM action calls (definitions from `validateContractDefinition` always resolve). */
export function contractActionFunction(definition: EvmContractDefinition, action: EvmContractAction): AbiFunctionItem | null {
  return (
    definition.abi.find((item): item is AbiFunctionItem => item.type === "function" && abiItemSignature(item) === action.function) ?? null
  );
}

/** The input asset an action spends, or null for non-spending actions. */
export function contractActionInput(network: NetworkKey, action: EvmContractAction | SolanaActionEndpoint): AssetDescriptor | null {
  return action.input ? resolveContractAsset(network, action.input.token) : null;
}

/** A reference to a registry asset as carried by intents. */
export function contractAssetRef(asset: AssetDescriptor): AssetRef {
  return { asset: asset.id as AssetId, symbol: asset.symbol, decimals: asset.decimals };
}

/** Protocol id executing a step of this VM. */
export function contractProtocol(vm: ContractVm): ProtocolId {
  return vm === "evm" ? "custom-call" : "solana-actions";
}
