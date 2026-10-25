/**
 * Contract definition, pin, verification and view types.
 */
import type { NetworkKey } from "../chains.js";

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
  /**
   * The output token's balance is index-scaled (Aave aTokens and similar
   * rebasing tokens): simulation and landing accept a Transfer-log amount
   * that differs from the balance delta (or the declared event) by at most
   * `REBASING_TOLERANCE_UNITS` base units either way and count the smaller
   * amount. Part of `definitionHash`. Absent (or false): exact equality, as before.
   */
  readonly rebasing?: boolean;
}

/** Base units a rebasing output's Transfer-log amount may differ from its balance delta by (`output.rebasing`). */
export const REBASING_TOLERANCE_UNITS = 2n;

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
