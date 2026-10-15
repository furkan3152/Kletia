/**
 * Kletia admin panel: the shared contract between the API (`/api/admin`) and
 * the web panel (`/admin`). Pure data and types: the contract catalog, the
 * per-network deploy targets, the pinned live deployments and the wire types
 * of every admin route.
 *
 * Owner: the admin API package. The web reads it and never edits it.
 */
import type { NetworkKey } from "./chains.js";

export const ADMIN_SCHEMA_VERSION = "kletia_admin_v1" as const;
export const ADMIN_EXPORT_SCHEMA = "kletia_admin_deployments_export_v1" as const;

export type AdminEvmNetwork = "base" | "arbitrum" | "ethereum" | "optimism" | "polygon" | "arc" | "arbitrum-sepolia";
export const ADMIN_EVM_NETWORKS: readonly AdminEvmNetwork[] = ["base", "arbitrum", "ethereum", "optimism", "polygon", "arc", "arbitrum-sepolia"];
export const ADMIN_NO_PROGRAM_NETWORKS: readonly NetworkKey[] = ["solana", "solana-devnet"];

export type AdminContractId =
  | "intent-router-v2" | "uniswap-v2-adapter" | "uniswap-v3-adapter" | "launch-factory-v2"
  | "x402-attestation-registry-v1" | "x402-factory" | "x402-gateway"
  | "legacy-smart-router" | "legacy-token-factory" | "legacy-timelock"
  | "arc-forwarder" | "arc-klet-token" | "arc-swap" | "arc-lending" | "arc-staking"
  | "arc-vault-v2" | "arc-vault-v1" | "arc-batch-pay" | "arc-memo-transfer"
  | "arc-agent-registry" | "arc-otc";

export type AdminLifecycle = "current" | "supporting" | "legacy" | "quarantined";
export type AdminOwnerModel = "ownable2step" | "ownable" | "custom-single-step" | "none";
export type AdminRole = "owner" | "guardian" | "treasury";
export type AdminNetworkConstant = "wrappedNative" | "uniswapV2Router" | "uniswapV2Factory" | "arcForwarder" | "arcKlet" | "arcSwap";

export type AdminArgSource =
  | { readonly kind: "role"; readonly role: AdminRole }
  | { readonly kind: "network-constant"; readonly key: AdminNetworkConstant }
  | { readonly kind: "dependency"; readonly contractId: AdminContractId; readonly instance?: string }
  | { readonly kind: "literal"; readonly value: string; readonly editable: boolean; readonly min?: string; readonly max?: string }
  | { readonly kind: "session-address" };

export interface AdminConstructorInput {
  /** Exact ABI input name from the artifact (checked by a core test against the export). */
  readonly name: string;
  readonly type: "address" | "uint16" | "uint256" | "string";
  readonly source: AdminArgSource;
  readonly label: string;
}

export type AdminFeeModel =
  | { readonly kind: "none" }
  | { readonly kind: "pushed"; readonly event: string; readonly amountField: string; readonly tokenField: string | null; readonly recipient: "treasury" }
  | { readonly kind: "accrued"; readonly token: "usdc" | "native" | "any-erc20"; readonly claimFunction: string }
  | { readonly kind: "lp-only" }
  | { readonly kind: "owner-funded"; readonly fundFunction: string };

export type AdminActionRisk = "routine" | "sensitive" | "dangerous";

export interface AdminActionSpec {
  readonly id: string;                 // e.g. "router.setFeeBps"
  readonly fn: string;                 // ABI function name
  readonly label: string;              // "Set fee"
  readonly caller: "owner" | "guardian-or-owner" | "pending-treasury" | "pending-owner" | "anyone";
  readonly risk: AdminActionRisk;
  readonly requires?: "paused" | "not-paused";
  readonly warning?: string;
  readonly payable?: true;
}

export interface AdminContractSpec {
  readonly id: AdminContractId;
  readonly name: string;               // Solidity contract name
  /** Key into the API artifact export, e.g. "base/KletiaIntentRouterV2". Empty when no artifact is exported (legacy timelock). */
  readonly artifactId: string;
  readonly lifecycle: AdminLifecycle;
  readonly ownerModel: AdminOwnerModel;
  /** Where the owner comes from at deploy time. */
  readonly ownerSource: "constructor-role" | "deployer" | "none";
  readonly constructorInputs: readonly AdminConstructorInput[];
  readonly feeModel: AdminFeeModel;
  /** View functions read by GET contracts/:id/state (no arguments). */
  readonly reads: readonly string[];
  readonly actions: readonly AdminActionSpec[];
  readonly notes: string;
}

export type AdminTargetStatus = "deployable" | "pinned" | "quarantined" | "legacy" | "not-applicable";

export interface AdminPostDeployStep {
  readonly id: string;                 // "configure-adapter"
  readonly label: string;
  readonly contractId: AdminContractId;  // contract whose function is called
  readonly fn: string;
  readonly args: readonly AdminArgSource[];
  readonly caller: "owner";
}

export interface AdminDeployTarget {
  /** `${network}:${contractId}` or `${network}:${contractId}:${instance}`. */
  readonly id: string;
  readonly network: AdminEvmNetwork;
  readonly contractId: AdminContractId;
  readonly instance?: string;          // "uniswap" for adapters
  readonly status: AdminTargetStatus;
  readonly reason: string;             // why not-applicable / quarantined, or a short note
  readonly order: number;              // checklist order within the network
  readonly dependsOn: readonly string[];  // target ids that must have a verified or pinned record
  readonly postDeploy: readonly AdminPostDeployStep[];
  readonly testnet: boolean;
}

export interface AdminPinnedDeployment {
  readonly network: AdminEvmNetwork;
  readonly contractId: AdminContractId;
  readonly instance?: string;
  readonly address: string;            // checksummed
  readonly txHash?: string;
  readonly block?: string;             // decimal
  readonly runtimeCodehash?: string;   // extcodehash as recorded in the manifest
  readonly owner?: string;
  readonly lifecycle: AdminLifecycle;
  readonly source: string;             // repo path of the manifest or code constant
}

export interface AdminNetworkConstants {
  readonly network: AdminEvmNetwork;
  readonly wrappedNative?: string;
  readonly uniswapV2Router?: string;
  readonly uniswapV2Factory?: string;
  readonly arcForwarder?: string;
  readonly arcKlet?: string;
  readonly arcSwap?: string;
  /** Default role addresses (Base: the three Safes). Editable per network in the panel. */
  readonly defaultRoles?: Partial<Readonly<Record<AdminRole, string>>>;
  /** Safe owners known from manifests (Base Governance Safe). */
  readonly safeOwners?: Readonly<Record<string, readonly string[]>>;
}

/* ---------------- Catalog data ---------------- */

const ADMIN_WALLET = "0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A";
const SAFE_COSIGNER = "0x8c5281055B197443fF01dbBDFBf29fD63946cA1E";
const BASE_GOVERNANCE_SAFE = "0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D";
const BASE_GUARDIAN_SAFE = "0xCae3520A4348BEB2b74Ef52E8be2dE06f57fC0Bc";
const BASE_TREASURY_SAFE = "0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC";
const ARC_FORWARDER = "0x7dE7A249673F2235A91E484CfCE49D00867B67Ec";
const ARC_KLET = "0xAe77D247c26258397653a020995E957Bc88E039A";
const ARC_SWAP = "0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8";

const BASE_MANIFEST = "contracts/base/deployments/base-mainnet-v2.json";
const ARC_MANIFEST = "contracts/arc/deployments/arc-testnet.json";

const forwarderInput: AdminConstructorInput = {
  name: "trustedForwarder", type: "address", source: { kind: "dependency", contractId: "arc-forwarder" }, label: "Trusted forwarder (ERC-2771)",
};

const transferOwnership2Step: AdminActionSpec = {
  id: "ownership.transfer", fn: "transferOwnership", label: "Start ownership transfer", caller: "owner", risk: "dangerous",
  warning: "The new owner must accept. Until then the current owner stays in control.",
};
const acceptOwnership: AdminActionSpec = { id: "ownership.accept", fn: "acceptOwnership", label: "Accept ownership", caller: "pending-owner", risk: "sensitive" };
const transferOwnershipSingle: AdminActionSpec = {
  id: "ownership.transfer", fn: "transferOwnership", label: "Transfer ownership", caller: "owner", risk: "dangerous",
  warning: "This transfer takes effect immediately and cannot be undone by you.",
};

function freezeRecord<K extends string, V>(value: Record<K, V>): Readonly<Record<K, V>> {
  return Object.freeze(value);
}

export const ADMIN_CONTRACTS: Readonly<Record<AdminContractId, AdminContractSpec>> = freezeRecord<AdminContractId, AdminContractSpec>({
  "intent-router-v2": {
    id: "intent-router-v2", name: "KletiaIntentRouterV2", artifactId: "base/KletiaIntentRouterV2", lifecycle: "current",
    ownerModel: "ownable2step", ownerSource: "constructor-role",
    constructorInputs: [
      { name: "initialOwner", type: "address", source: { kind: "role", role: "owner" }, label: "Owner" },
      { name: "initialGuardian", type: "address", source: { kind: "role", role: "guardian" }, label: "Guardian" },
      { name: "wrappedNative_", type: "address", source: { kind: "network-constant", key: "wrappedNative" }, label: "Wrapped native token" },
      { name: "initialTreasury", type: "address", source: { kind: "role", role: "treasury" }, label: "Treasury" },
      { name: "initialFeeBps", type: "uint16", source: { kind: "literal", value: "10", editable: true, min: "0", max: "100" }, label: "Fee (basis points)" },
    ],
    feeModel: { kind: "pushed", event: "SwapExecuted", amountField: "feeAmount", tokenField: "tokenOut", recipient: "treasury" },
    reads: ["guardian", "treasury", "pendingTreasury", "feeBps", "paused", "wrappedNative", "MAX_FEE_BPS"],
    actions: [
      { id: "router.pause", fn: "pause", label: "Pause", caller: "guardian-or-owner", risk: "routine", requires: "not-paused" },
      { id: "router.unpause", fn: "unpause", label: "Unpause", caller: "owner", risk: "sensitive", requires: "paused" },
      { id: "router.setFeeBps", fn: "setFeeBps", label: "Set fee", caller: "owner", risk: "sensitive", warning: "At most 100 basis points (1 %)." },
      { id: "router.proposeTreasury", fn: "proposeTreasury", label: "Propose treasury", caller: "owner", risk: "sensitive", warning: "The new treasury must accept." },
      { id: "router.acceptTreasury", fn: "acceptTreasury", label: "Accept treasury", caller: "pending-treasury", risk: "sensitive" },
      { id: "router.setGuardian", fn: "setGuardian", label: "Set guardian", caller: "owner", risk: "sensitive" },
      { id: "router.configureAdapter", fn: "configureAdapter", label: "Configure adapter", caller: "owner", risk: "sensitive" },
      { id: "router.enableAdapter", fn: "enableAdapter", label: "Enable adapter", caller: "owner", risk: "sensitive" },
      { id: "router.disableAdapter", fn: "disableAdapter", label: "Disable adapter", caller: "guardian-or-owner", risk: "routine" },
      { id: "router.rescueToken", fn: "rescueToken", label: "Rescue token", caller: "owner", risk: "dangerous", requires: "paused", warning: "Only while paused." },
      { id: "router.rescueNative", fn: "rescueNative", label: "Rescue native", caller: "owner", risk: "dangerous", requires: "paused", warning: "Only while paused." },
      transferOwnership2Step,
      acceptOwnership,
    ],
    notes: "Fees are pushed to the treasury inside each swap. Nothing accrues on the router.",
  },
  "uniswap-v2-adapter": {
    id: "uniswap-v2-adapter", name: "UniswapV2CompatibleAdapter", artifactId: "base/UniswapV2CompatibleAdapter", lifecycle: "current",
    ownerModel: "none", ownerSource: "none",
    constructorInputs: [
      { name: "router_", type: "address", source: { kind: "network-constant", key: "uniswapV2Router" }, label: "Uniswap V2 Router02" },
      { name: "factory_", type: "address", source: { kind: "network-constant", key: "uniswapV2Factory" }, label: "Uniswap V2 factory" },
      { name: "wrappedNative_", type: "address", source: { kind: "network-constant", key: "wrappedNative" }, label: "Wrapped native token" },
    ],
    feeModel: { kind: "none" },
    reads: ["target", "factory", "wrappedNative", "spender", "configurationHash"],
    actions: [],
    notes: "Immutable. The constructor reverts when the router's factory or WETH does not match.",
  },
  "uniswap-v3-adapter": {
    id: "uniswap-v3-adapter", name: "UniswapV3SwapRouter02Adapter", artifactId: "base/UniswapV3SwapRouter02Adapter", lifecycle: "quarantined",
    ownerModel: "none", ownerSource: "none",
    constructorInputs: [],
    feeModel: { kind: "none" },
    reads: ["target", "factory", "wrappedNative"],
    actions: [],
    notes: "EXPERIMENTAL_NOT_RELEASED in DEPLOYMENT.md: production deploy and enable are forbidden.",
  },
  "launch-factory-v2": {
    id: "launch-factory-v2", name: "KletiaLaunchFactoryV2", artifactId: "base/KletiaLaunchFactoryV2", lifecycle: "current",
    ownerModel: "ownable2step", ownerSource: "constructor-role",
    constructorInputs: [
      { name: "initialOwner", type: "address", source: { kind: "role", role: "owner" }, label: "Owner" },
      { name: "initialTreasury", type: "address", source: { kind: "role", role: "treasury" }, label: "Treasury" },
    ],
    feeModel: { kind: "pushed", event: "TokenDeployed", amountField: "deploymentFee", tokenField: null, recipient: "treasury" },
    reads: ["treasury", "pendingTreasury", "deploymentFee", "MAX_DEPLOYMENT_FEE"],
    actions: [
      { id: "factory.setDeploymentFee", fn: "setDeploymentFee", label: "Set deployment fee", caller: "owner", risk: "sensitive", warning: "At most 0.01 of the native asset." },
      { id: "factory.proposeTreasury", fn: "proposeTreasury", label: "Propose treasury", caller: "owner", risk: "sensitive", warning: "The new treasury must accept." },
      { id: "factory.acceptTreasury", fn: "acceptTreasury", label: "Accept treasury", caller: "pending-treasury", risk: "sensitive" },
      transferOwnership2Step,
      acceptOwnership,
    ],
    notes: "The deployment fee is forwarded to the treasury in each deployToken call. Nothing accrues.",
  },
  "x402-attestation-registry-v1": {
    id: "x402-attestation-registry-v1", name: "KletiaX402ServiceAttestationRegistryV1", artifactId: "base/KletiaX402ServiceAttestationRegistryV1", lifecycle: "current",
    ownerModel: "ownable2step", ownerSource: "constructor-role",
    constructorInputs: [
      { name: "initialOwner", type: "address", source: { kind: "role", role: "owner" }, label: "Owner" },
      { name: "initialGuardian", type: "address", source: { kind: "role", role: "guardian" }, label: "Guardian" },
    ],
    feeModel: { kind: "none" },
    reads: ["guardian"],
    actions: [
      { id: "registry.setCurator", fn: "setCurator", label: "Set curator", caller: "owner", risk: "sensitive" },
      { id: "registry.disableCurator", fn: "disableCurator", label: "Disable curator", caller: "guardian-or-owner", risk: "routine" },
      { id: "registry.setGuardian", fn: "setGuardian", label: "Set guardian", caller: "owner", risk: "sensitive" },
      transferOwnership2Step,
      acceptOwnership,
    ],
    notes: "Base-only supplemental x402 claim verifier.",
  },
  "x402-factory": {
    id: "x402-factory", name: "X402Factory", artifactId: "base/X402Factory", lifecycle: "supporting",
    ownerModel: "none", ownerSource: "none", constructorInputs: [], feeModel: { kind: "none" },
    reads: ["allGatewaysLength"], actions: [],
    notes: "Not redeployable from the panel: the live bytecode was built from a separate standard-input file.",
  },
  "x402-gateway": {
    id: "x402-gateway", name: "X402Gateway", artifactId: "base/X402Gateway", lifecycle: "supporting",
    ownerModel: "ownable", ownerSource: "deployer", constructorInputs: [],
    feeModel: { kind: "accrued", token: "usdc", claimFunction: "withdraw" },
    reads: ["usdc", "pricePerCall"],
    actions: [
      { id: "gateway.setPrice", fn: "setPrice", label: "Set price", caller: "owner", risk: "sensitive", warning: "USDC with 6 decimals." },
      { id: "gateway.withdraw", fn: "withdraw", label: "Withdraw USDC", caller: "owner", risk: "routine" },
      transferOwnershipSingle,
    ],
    notes: "Accrues USDC from pay and payExact. withdraw(to) sends the whole balance.",
  },
  "legacy-smart-router": {
    id: "legacy-smart-router", name: "KletiaSmartRouter", artifactId: "base/KletiaSmartRouter", lifecycle: "legacy",
    ownerModel: "ownable", ownerSource: "constructor-role", constructorInputs: [],
    feeModel: { kind: "accrued", token: "any-erc20", claimFunction: "rescueTokens" },
    reads: ["feeBasisPoints", "feeTreasury", "paused"],
    actions: [
      { id: "legacyRouter.pause", fn: "pause", label: "Pause", caller: "owner", risk: "routine" },
      { id: "legacyRouter.unpause", fn: "unpause", label: "Unpause", caller: "owner", risk: "sensitive" },
      { id: "legacyRouter.setApprovedTarget", fn: "setApprovedTarget", label: "Set approved target", caller: "owner", risk: "sensitive", warning: "Only revoking (false) is offered by default." },
      { id: "legacyRouter.setFeeBasisPoints", fn: "setFeeBasisPoints", label: "Set fee", caller: "owner", risk: "sensitive", warning: "At most 500 basis points." },
      { id: "legacyRouter.setFeeTreasury", fn: "setFeeTreasury", label: "Set fee treasury", caller: "owner", risk: "sensitive" },
      { id: "legacyRouter.rescueTokens", fn: "rescueTokens", label: "Rescue tokens", caller: "owner", risk: "dangerous" },
      transferOwnershipSingle,
    ],
    notes: "Legacy fee router. Fees were pushed to the fee treasury per call; stray balances are rescuable.",
  },
  "legacy-token-factory": {
    id: "legacy-token-factory", name: "KletiaTokenFactory", artifactId: "base/KletiaTokenFactory", lifecycle: "legacy",
    ownerModel: "ownable", ownerSource: "deployer", constructorInputs: [],
    feeModel: { kind: "none" },
    reads: ["treasury"],
    actions: [{ id: "legacyFactory.setTreasury", fn: "setTreasury", label: "Set treasury", caller: "owner", risk: "sensitive" }],
    notes: "10 % of each created token was minted to the treasury at creation. Nothing to claim.",
  },
  "legacy-timelock": {
    id: "legacy-timelock", name: "TimelockController", artifactId: "", lifecycle: "legacy",
    ownerModel: "none", ownerSource: "none", constructorInputs: [], feeModel: { kind: "none" },
    reads: [], actions: [],
    notes: "Historical timelock of the superseded V2 set. Read only.",
  },
  "arc-forwarder": {
    id: "arc-forwarder", name: "KletiaArcForwarder", artifactId: "arc/KletiaArcForwarder", lifecycle: "current",
    ownerModel: "none", ownerSource: "none",
    constructorInputs: [{ name: "name", type: "string", source: { kind: "literal", value: "KletiaArcForwarder", editable: true }, label: "Forwarder name" }],
    feeModel: { kind: "none" }, reads: [], actions: [],
    notes: "ERC-2771 trust root of every Arc application contract.",
  },
  "arc-klet-token": {
    id: "arc-klet-token", name: "KletiaToken", artifactId: "arc/KletiaToken", lifecycle: "current",
    ownerModel: "ownable", ownerSource: "none",
    constructorInputs: [
      { name: "name", type: "string", source: { kind: "literal", value: "Kletia", editable: true }, label: "Token name" },
      { name: "symbol", type: "string", source: { kind: "literal", value: "KLET", editable: true }, label: "Token symbol" },
      { name: "totalSupply", type: "uint256", source: { kind: "literal", value: "1000000000", editable: true, min: "1" }, label: "Total supply (whole tokens)" },
      { name: "creator", type: "address", source: { kind: "session-address" }, label: "Creator" },
      { name: "treasury", type: "address", source: { kind: "role", role: "treasury" }, label: "Treasury" },
    ],
    feeModel: { kind: "none" }, reads: ["name", "symbol", "totalSupply"], actions: [],
    notes: "KLET trust root. 10 % of the supply is minted to the treasury.",
  },
  "arc-swap": {
    id: "arc-swap", name: "KletiaArcSwap", artifactId: "arc/KletiaArcSwap", lifecycle: "current",
    ownerModel: "none", ownerSource: "none",
    constructorInputs: [forwarderInput, { name: "_token", type: "address", source: { kind: "dependency", contractId: "arc-klet-token" }, label: "KLET token" }],
    feeModel: { kind: "lp-only" }, reads: ["token", "reserveToken", "reserveUSDC", "totalSupply"], actions: [],
    notes: "0.3 % of each swap stays in the pool for liquidity providers. No protocol fee.",
  },
  "arc-lending": {
    id: "arc-lending", name: "KletiaArcLending", artifactId: "arc/KletiaArcLending", lifecycle: "current",
    ownerModel: "none", ownerSource: "none",
    constructorInputs: [
      forwarderInput,
      { name: "_kletToken", type: "address", source: { kind: "dependency", contractId: "arc-klet-token" }, label: "KLET token" },
      { name: "_swapPool", type: "address", source: { kind: "dependency", contractId: "arc-swap" }, label: "Swap pool (price oracle)" },
    ],
    feeModel: { kind: "none" }, reads: ["kletToken", "swapPool", "currentBorrowRate", "currentLiquidityRate"], actions: [],
    notes: "Interest goes to suppliers. No reserve factor, no owner.",
  },
  "arc-staking": {
    id: "arc-staking", name: "KletiaArcStaking", artifactId: "arc/KletiaArcStaking", lifecycle: "current",
    ownerModel: "custom-single-step", ownerSource: "deployer",
    constructorInputs: [
      forwarderInput,
      { name: "_aprBps", type: "uint256", source: { kind: "literal", value: "500", editable: true, min: "0", max: "10000" }, label: "APR (basis points)" },
      { name: "_cooldownPeriod", type: "uint256", source: { kind: "literal", value: "86400", editable: true, min: "0" }, label: "Cooldown (seconds)" },
    ],
    feeModel: { kind: "owner-funded", fundFunction: "fundRewards" },
    reads: ["aprBps", "cooldownPeriod", "contractBalance", "rewardPoolBalance", "totalStaked"],
    actions: [
      { id: "staking.setAPR", fn: "setAPR", label: "Set APR", caller: "owner", risk: "sensitive" },
      { id: "staking.setCooldownPeriod", fn: "setCooldownPeriod", label: "Set cooldown", caller: "owner", risk: "sensitive" },
      { id: "staking.fundRewards", fn: "fundRewards", label: "Fund rewards", caller: "owner", risk: "routine", payable: true },
      transferOwnershipSingle,
    ],
    notes: "The owner funds rewards (a cost, not revenue).",
  },
  "arc-vault-v2": {
    id: "arc-vault-v2", name: "KletiaArcVaultV2", artifactId: "arc/KletiaArcVaultV2", lifecycle: "current",
    ownerModel: "ownable2step", ownerSource: "constructor-role",
    constructorInputs: [
      forwarderInput,
      { name: "initialOwner", type: "address", source: { kind: "role", role: "owner" }, label: "Owner" },
      { name: "initialGuardian", type: "address", source: { kind: "role", role: "guardian" }, label: "Guardian" },
      { name: "initialApyBps", type: "uint256", source: { kind: "literal", value: "500", editable: true, min: "0", max: "5000" }, label: "APY (basis points)" },
    ],
    feeModel: { kind: "owner-funded", fundFunction: "fundVault" },
    reads: ["guardian", "apyBps", "paused", "totalDeposited", "totalInterestLiability", "requiredReserve", "vaultBalance"],
    actions: [
      { id: "vault.setAPY", fn: "setAPY", label: "Set APY", caller: "owner", risk: "sensitive", warning: "At most 5000 basis points." },
      { id: "vault.setGuardian", fn: "setGuardian", label: "Set guardian", caller: "owner", risk: "sensitive" },
      { id: "vault.pause", fn: "pause", label: "Pause", caller: "guardian-or-owner", risk: "routine", requires: "not-paused" },
      { id: "vault.unpause", fn: "unpause", label: "Unpause", caller: "owner", risk: "sensitive", requires: "paused" },
      { id: "vault.fundVault", fn: "fundVault", label: "Fund vault", caller: "anyone", risk: "routine", payable: true },
      transferOwnership2Step,
      acceptOwnership,
    ],
    notes: "The owner funds interest. reserveStatus() reports coverage.",
  },
  "arc-vault-v1": {
    id: "arc-vault-v1", name: "KletiaArcVault", artifactId: "arc/KletiaArcVault", lifecycle: "legacy",
    ownerModel: "custom-single-step", ownerSource: "deployer", constructorInputs: [],
    feeModel: { kind: "owner-funded", fundFunction: "fundVault" },
    reads: ["apyBps", "totalDeposited", "vaultBalance"],
    actions: [
      { id: "vaultV1.setAPY", fn: "setAPY", label: "Set APY", caller: "owner", risk: "sensitive" },
      { id: "vaultV1.fundVault", fn: "fundVault", label: "Fund vault", caller: "anyone", risk: "routine", payable: true },
      transferOwnershipSingle,
    ],
    notes: "Legacy vault kept for self-custodial migration withdrawals only.",
  },
  "arc-batch-pay": {
    id: "arc-batch-pay", name: "KletiaArcBatchPay", artifactId: "arc/KletiaArcBatchPay", lifecycle: "current",
    ownerModel: "custom-single-step", ownerSource: "deployer",
    constructorInputs: [
      forwarderInput,
      { name: "_maxRecipients", type: "uint256", source: { kind: "literal", value: "50", editable: true, min: "1", max: "500" }, label: "Max recipients per batch" },
    ],
    feeModel: { kind: "none" }, reads: ["maxRecipientsPerBatch", "totalBatches"],
    actions: [
      { id: "batchPay.setMaxRecipients", fn: "setMaxRecipients", label: "Set max recipients", caller: "owner", risk: "sensitive" },
      transferOwnershipSingle,
    ],
    notes: "No fee.",
  },
  "arc-memo-transfer": {
    id: "arc-memo-transfer", name: "KletiaArcMemoTransfer", artifactId: "arc/KletiaArcMemoTransfer", lifecycle: "current",
    ownerModel: "custom-single-step", ownerSource: "deployer",
    constructorInputs: [forwarderInput],
    feeModel: { kind: "none" }, reads: ["totalTransfers"],
    actions: [transferOwnershipSingle],
    notes: "No fee.",
  },
  "arc-agent-registry": {
    id: "arc-agent-registry", name: "KletiaArcAgentRegistry", artifactId: "arc/KletiaArcAgentRegistry", lifecycle: "current",
    ownerModel: "custom-single-step", ownerSource: "deployer",
    constructorInputs: [forwarderInput],
    feeModel: { kind: "none" }, reads: ["totalAgents", "nextAgentId"],
    actions: [
      { id: "agents.authorizeScorer", fn: "authorizeScorer", label: "Authorize scorer", caller: "owner", risk: "sensitive" },
      { id: "agents.revokeScorer", fn: "revokeScorer", label: "Revoke scorer", caller: "owner", risk: "routine" },
      transferOwnershipSingle,
    ],
    notes: "No fee.",
  },
  "arc-otc": {
    id: "arc-otc", name: "KletiaArcOTC", artifactId: "arc/KletiaArcOTC", lifecycle: "legacy",
    ownerModel: "none", ownerSource: "none", constructorInputs: [], feeModel: { kind: "none" },
    reads: ["orderCount"], actions: [],
    notes: "Legacy, disabled in the application.",
  },
});

export const ADMIN_NETWORK_CONSTANTS: Readonly<Record<AdminEvmNetwork, AdminNetworkConstants>> = freezeRecord<AdminEvmNetwork, AdminNetworkConstants>({
  base: {
    network: "base",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    uniswapV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    defaultRoles: { owner: BASE_GOVERNANCE_SAFE, guardian: BASE_GUARDIAN_SAFE, treasury: BASE_TREASURY_SAFE },
    safeOwners: { [BASE_GOVERNANCE_SAFE]: [ADMIN_WALLET, SAFE_COSIGNER] },
  },
  arbitrum: {
    network: "arbitrum",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    uniswapV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    uniswapV2Factory: "0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9",
  },
  ethereum: {
    network: "ethereum",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    uniswapV2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    uniswapV2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  },
  optimism: {
    network: "optimism",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    uniswapV2Router: "0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2",
    uniswapV2Factory: "0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf",
  },
  polygon: {
    network: "polygon",
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    uniswapV2Router: "0xedf6066a2b290C185783862C7F4776A2C8077AD1",
    uniswapV2Factory: "0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C",
  },
  arc: { network: "arc", arcForwarder: ARC_FORWARDER, arcKlet: ARC_KLET, arcSwap: ARC_SWAP },
  "arbitrum-sepolia": { network: "arbitrum-sepolia", wrappedNative: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73" },
});

export function adminTargetId(network: AdminEvmNetwork, contractId: AdminContractId, instance?: string): string {
  return instance ? `${network}:${contractId}:${instance}` : `${network}:${contractId}`;
}

const ROUTER_ADAPTER_STEPS = (network: AdminEvmNetwork, testnet: boolean): readonly AdminPostDeployStep[] => {
  const adapter: AdminArgSource = { kind: "dependency", contractId: "uniswap-v2-adapter", instance: "uniswap" };
  return testnet
    ? [{ id: "configure-adapter", label: "Configure and enable the Uniswap V2 adapter", contractId: "intent-router-v2", fn: "configureAdapter", args: [adapter, { kind: "literal", value: "true", editable: false }], caller: "owner" }]
    : [
      { id: "configure-adapter", label: `Configure the Uniswap V2 adapter on ${network}`, contractId: "intent-router-v2", fn: "configureAdapter", args: [adapter, { kind: "literal", value: "false", editable: false }], caller: "owner" },
      { id: "enable-adapter", label: "Enable the Uniswap V2 adapter", contractId: "intent-router-v2", fn: "enableAdapter", args: [adapter], caller: "owner" },
    ];
};

function target(
  network: AdminEvmNetwork, contractId: AdminContractId, status: AdminTargetStatus, order: number, reason: string,
  extra: { readonly instance?: string; readonly dependsOn?: readonly string[]; readonly postDeploy?: readonly AdminPostDeployStep[]; readonly testnet?: boolean } = {},
): AdminDeployTarget {
  const base: AdminDeployTarget = {
    id: adminTargetId(network, contractId, extra.instance), network, contractId, status, reason, order,
    dependsOn: extra.dependsOn ?? [], postDeploy: extra.postDeploy ?? [],
    testnet: extra.testnet ?? (network === "arc" || network === "arbitrum-sepolia"),
  };
  return extra.instance ? { ...base, instance: extra.instance } : base;
}

const V3_QUARANTINE = "Quarantined: DEPLOYMENT.md marks the Uniswap V3 adapter EXPERIMENTAL_NOT_RELEASED (production deploy and enable forbidden).";
const REGISTRY_BASE_ONLY = "The attestation registry is the Base-only supplemental x402 claim verifier.";
const ARC_NO_WETH = "Arc's native gas asset is USDC; the router needs a wrapped-native contract and Arc has no canonical WETH9 or Uniswap V2.";
const ARC_APP_ONLY = "Arc application contracts are testnet primitives; they are not offered on other networks.";
const NOT_WIRED = "A new deployment is prepared only: the product uses it after the lead pins it in a release.";

function evmMainnetTargets(network: "arbitrum" | "ethereum" | "optimism" | "polygon"): AdminDeployTarget[] {
  return [
    target(network, "uniswap-v2-adapter", "deployable", 1, `Uniswap V2 Router02 adapter. ${NOT_WIRED}`, { instance: "uniswap", testnet: false }),
    target(network, "intent-router-v2", "deployable", 2, NOT_WIRED, { postDeploy: ROUTER_ADAPTER_STEPS(network, false), testnet: false }),
    target(network, "launch-factory-v2", "deployable", 3, NOT_WIRED, { testnet: false }),
    target(network, "uniswap-v3-adapter", "quarantined", 4, V3_QUARANTINE, { testnet: false }),
    target(network, "x402-attestation-registry-v1", "not-applicable", 5, REGISTRY_BASE_ONLY, { testnet: false }),
  ];
}

export const ADMIN_DEPLOY_TARGETS: readonly AdminDeployTarget[] = Object.freeze([
  // Base: the live V2 set is pinned; a replacement deploy stays possible (wired: false).
  target("base", "uniswap-v2-adapter", "pinned", 1, "Live Base adapter (pinned). A replacement is recorded as not wired.", { instance: "uniswap", testnet: false }),
  target("base", "intent-router-v2", "pinned", 2, "Live Base router (pinned). A replacement is recorded as not wired.", { postDeploy: ROUTER_ADAPTER_STEPS("base", false), testnet: false }),
  target("base", "launch-factory-v2", "pinned", 3, "Live Base launch factory (pinned). A replacement is recorded as not wired.", { testnet: false }),
  target("base", "x402-attestation-registry-v1", "pinned", 4, "Live Base attestation registry (pinned). A replacement is recorded as not wired.", { testnet: false }),
  target("base", "uniswap-v3-adapter", "quarantined", 5, V3_QUARANTINE, { testnet: false }),
  target("base", "x402-factory", "legacy", 6, "Supporting contract, not redeployable from the panel.", { testnet: false }),
  target("base", "x402-gateway", "legacy", 7, "Supporting contract created by the x402 factory.", { testnet: false }),
  target("base", "legacy-smart-router", "legacy", 8, "Legacy fee router. Read only, owner actions where the contract allows.", { testnet: false }),
  target("base", "legacy-token-factory", "legacy", 9, "Legacy token factory.", { testnet: false }),
  target("base", "legacy-timelock", "legacy", 10, "Historical timelock of the superseded V2 set.", { testnet: false }),
  ...evmMainnetTargets("arbitrum"),
  ...evmMainnetTargets("ethereum"),
  ...evmMainnetTargets("optimism"),
  ...evmMainnetTargets("polygon"),
  // Arbitrum Sepolia: testnet canary; no pinned Uniswap V2 there.
  target("arbitrum-sepolia", "uniswap-v2-adapter", "not-applicable", 1, "No pinned Uniswap V2 Router02 on Arbitrum Sepolia.", { instance: "uniswap" }),
  target("arbitrum-sepolia", "intent-router-v2", "deployable", 2, `Testnet canary. No adapter to configure until one is pinned. ${NOT_WIRED}`),
  target("arbitrum-sepolia", "launch-factory-v2", "deployable", 3, NOT_WIRED),
  target("arbitrum-sepolia", "uniswap-v3-adapter", "quarantined", 4, V3_QUARANTINE),
  target("arbitrum-sepolia", "x402-attestation-registry-v1", "not-applicable", 5, REGISTRY_BASE_ONLY),
  // Arc Testnet: trust roots pinned, application contracts pinned and redeployable.
  target("arc", "arc-forwarder", "pinned", 1, "Arc trust root (pinned). A fresh suite starts here."),
  target("arc", "arc-klet-token", "pinned", 2, "Arc KLET trust root (pinned)."),
  target("arc", "arc-swap", "pinned", 3, `Testnet redeploy creates a new record. ${NOT_WIRED}`, { dependsOn: ["arc:arc-forwarder", "arc:arc-klet-token"] }),
  target("arc", "arc-lending", "pinned", 4, `Testnet redeploy creates a new record. ${NOT_WIRED}`, { dependsOn: ["arc:arc-forwarder", "arc:arc-klet-token", "arc:arc-swap"] }),
  target("arc", "arc-staking", "pinned", 5, `Testnet redeploy creates a new record. ${NOT_WIRED}`, { dependsOn: ["arc:arc-forwarder"] }),
  target("arc", "arc-vault-v2", "pinned", 6, `Testnet redeploy creates a new record. ${NOT_WIRED}`, { dependsOn: ["arc:arc-forwarder"] }),
  target("arc", "arc-batch-pay", "pinned", 7, `Testnet redeploy creates a new record. ${NOT_WIRED}`, { dependsOn: ["arc:arc-forwarder"] }),
  target("arc", "arc-memo-transfer", "pinned", 8, `Testnet redeploy creates a new record. ${NOT_WIRED}`, { dependsOn: ["arc:arc-forwarder"] }),
  target("arc", "arc-agent-registry", "pinned", 9, `Testnet redeploy creates a new record. ${NOT_WIRED}`, { dependsOn: ["arc:arc-forwarder"] }),
  target("arc", "launch-factory-v2", "deployable", 10, `Deployment fee in Arc's native USDC. ${NOT_WIRED}`),
  target("arc", "arc-vault-v1", "legacy", 11, "Legacy vault, migration withdrawals only."),
  target("arc", "arc-otc", "legacy", 12, "Legacy OTC, disabled."),
  target("arc", "intent-router-v2", "not-applicable", 13, ARC_NO_WETH),
  target("arc", "uniswap-v2-adapter", "not-applicable", 14, ARC_NO_WETH, { instance: "uniswap" }),
  target("arc", "uniswap-v3-adapter", "not-applicable", 15, ARC_NO_WETH),
  target("arc", "x402-attestation-registry-v1", "not-applicable", 16, REGISTRY_BASE_ONLY),
]);

export const ADMIN_PINNED_DEPLOYMENTS: readonly AdminPinnedDeployment[] = Object.freeze([
  // Base V2 (current).
  { network: "base", contractId: "intent-router-v2", address: "0xf9BaA05c71c2078A43f6831Eca88220b42932413", txHash: "0xf69ca039f8b8033c87567bb159e0e0c8e0a1b285c5d4e7bcecfc26c45b46fbb6", block: "49936328", runtimeCodehash: "0x9341d0e8f68d7de4273a47b6f495f4b99335fa9d851bafa3204a91dc3ae2fb52", owner: BASE_GOVERNANCE_SAFE, lifecycle: "current", source: BASE_MANIFEST },
  { network: "base", contractId: "uniswap-v2-adapter", instance: "uniswap", address: "0xb21C455ceE9ECb4BD0cf19A88d771065db45592b", txHash: "0x053fbf8f220ec40e5ed533aed98e008d55290b7f44163ea7e1d24d88038e09ae", runtimeCodehash: "0x0fb7c899f3f97856ee6a83f8e7eb5ede10c341f52e64e92658b35471d3a1dbd7", lifecycle: "current", source: BASE_MANIFEST },
  { network: "base", contractId: "launch-factory-v2", address: "0x1D62Ac5e19af7688EbC57f262bbB9959dd78e043", txHash: "0x1120c5976aac64e4379b558a2d4faa0f978d9b29c2593e48104e19144db6c5ea", block: "49936329", runtimeCodehash: "0xa28d7ef44ecff154d4b24a2f362868bf29e8a9ca7f172d8b0e3cad2b5fc80e81", owner: BASE_GOVERNANCE_SAFE, lifecycle: "current", source: BASE_MANIFEST },
  { network: "base", contractId: "x402-attestation-registry-v1", address: "0xE69DE5A5E92F4a52b15C651C1C1fc0fE36143889", txHash: "0x86391daf12b2d6257ab316567914085d5c5bfa9291f362a774040f9b51e1d908", block: "49936330", runtimeCodehash: "0xc186d25e78cd9fa8752a79aa7fbe33337201b6c36b7c49aace6b470583750041", owner: BASE_GOVERNANCE_SAFE, lifecycle: "current", source: BASE_MANIFEST },
  // Base supporting x402 contracts.
  { network: "base", contractId: "x402-factory", address: "0xD6e7bAc04a9969f75AEA3f17b5b82db1C988DD46", txHash: "0x31f0adc226bc928d798518f592cda77096f6b059533bf575e3adf556786ab26a", block: "48037476", runtimeCodehash: "0xb3a4928dbc77e27cf23f7d98f61207344f2c4e0f6c30e24d0db838f00c28a3f0", lifecycle: "supporting", source: BASE_MANIFEST },
  { network: "base", contractId: "x402-gateway", instance: "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B", address: "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B", runtimeCodehash: "0x3479dc8065404d6adf3478a11516e6c6d4a9fa99f7df9949be8f0fa988903e9a", owner: ADMIN_WALLET, lifecycle: "supporting", source: BASE_MANIFEST },
  { network: "base", contractId: "x402-gateway", instance: "0x0B6df3ddC99A4215AcbF4Ab840671e73577A387e", address: "0x0B6df3ddC99A4215AcbF4Ab840671e73577A387e", runtimeCodehash: "0x3479dc8065404d6adf3478a11516e6c6d4a9fa99f7df9949be8f0fa988903e9a", owner: ADMIN_WALLET, lifecycle: "supporting", source: BASE_MANIFEST },
  // Base legacy.
  { network: "base", contractId: "legacy-smart-router", address: "0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf", owner: ADMIN_WALLET, lifecycle: "legacy", source: "apps/api/src/networks/base/security/feeRouterPolicy.ts" },
  { network: "base", contractId: "legacy-token-factory", address: "0x69d1CFCa1916A310EdbA69A6BecD1702c7AC8d64", lifecycle: "legacy", source: "apps/api/src/networks/base/config/launchFactoryV2Environment.ts" },
  { network: "base", contractId: "legacy-timelock", address: "0x1B0D1720a9b67Bac0a72E671A69f2772C0BaA47F", txHash: "0x4da732b46fe5372c0daf3e18db4e87e29f89bc1cf1e4f5243dbe10c56273c781", runtimeCodehash: "0x55ecc21176f23ff90b7f884bfd572cecf431538bc89ab5ee5aed3fa59b9dec82", lifecycle: "legacy", source: BASE_MANIFEST },
  // Arc Testnet trust roots.
  { network: "arc", contractId: "arc-forwarder", address: ARC_FORWARDER, txHash: "0x416d7a0845c495e15e06780cabba808dfd53b47bfd0e09e57d4573a20491cd4b", block: "52436104", lifecycle: "current", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-klet-token", address: ARC_KLET, txHash: "0x9176fc0ec7cc2a1167b120a2ae22eac855cd2358328ceb25c13b07d01e90e63f", block: "52436119", lifecycle: "current", source: ARC_MANIFEST },
  // Arc Testnet application contracts.
  { network: "arc", contractId: "arc-swap", address: ARC_SWAP, lifecycle: "current", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-lending", address: "0x2748a478Ec0f6D90FfdE89b27721f469126835F7", lifecycle: "current", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-batch-pay", address: "0x09B6d2987EcAF021533A2727d2967696595Fa6dd", owner: SAFE_COSIGNER, lifecycle: "current", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-vault-v2", address: "0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d", txHash: "0x9494347ea1e07a8214cb923f2a244c9ec5280c9853e0e204a26d3e13093fdef2", block: "56838393", runtimeCodehash: "0xa6cb476a1243a6d9bc71909a5774d1340061e91bcb47cd8aea3df1f5444bec1f", owner: SAFE_COSIGNER, lifecycle: "current", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-memo-transfer", address: "0x1633f12f31195B34feE6eDC250e1D543DAB72698", owner: SAFE_COSIGNER, lifecycle: "current", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-agent-registry", address: "0xDEb07309c1689fEeCa44ac70939ce0297d511596", owner: SAFE_COSIGNER, lifecycle: "current", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-staking", address: "0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07", owner: SAFE_COSIGNER, lifecycle: "current", source: ARC_MANIFEST },
  // Arc Testnet legacy.
  { network: "arc", contractId: "arc-vault-v1", address: "0xe2810DB53998f8A51bBf5Bf94c21208b174da174", owner: SAFE_COSIGNER, lifecycle: "legacy", source: ARC_MANIFEST },
  { network: "arc", contractId: "arc-otc", address: "0xf4c1F168491F22222145cff88414fE489BF8c39d", lifecycle: "legacy", source: ARC_MANIFEST },
] satisfies AdminPinnedDeployment[]);

export function adminTargetsFor(network: AdminEvmNetwork): AdminDeployTarget[] {
  return ADMIN_DEPLOY_TARGETS.filter((entry) => entry.network === network).sort((a, b) => a.order - b.order);
}

/* ---------------- Admin wallets (EVM and Solana sign-in) ---------------- */

/** Which wallet family signed the admin session in. */
export type AdminWalletKind = "evm" | "solana";

/** Statement shown in both sign-in messages. */
export const ADMIN_SIGN_IN_STATEMENT = "Sign in to the Kletia admin panel. This signature does not move funds or approve a transaction.";

/** Request id carried by both sign-in messages. */
export const ADMIN_SIGN_IN_REQUEST_ID = "adm_login";

/* ---------------- API wire types (requests and responses) ---------------- */

export interface AdminSessionView {
  /** Checksummed EVM address, or the base58 Solana address. */
  readonly address: string;
  readonly walletKind: AdminWalletKind;
  /** EIP-155 chain id the EVM message named; null for a Solana session. */
  readonly chainId: number | null;
  readonly expiresAt: string; readonly idleExpiresAt: string;
  /**
   * EVM addresses that may send on-chain admin transactions for this session:
   * the session address for an EVM session, the EVM allowlist for a Solana
   * session (on-chain EVM actions always need an EVM wallet to sign).
   */
  readonly evmActors: readonly string[];
}

/** POST /api/admin/auth/nonce. EVM needs `chainId`; Solana ignores it. */
export interface AdminNonceRequest {
  readonly walletKind?: AdminWalletKind;   // default "evm"
  readonly address: string;
  readonly chainId?: number;
  readonly purpose?: "login" | "confirm";
  readonly action?: string;
  readonly network?: string;
  readonly payloadSha256?: string;
}
export interface AdminNonceResponse { readonly message: string; readonly nonce: string; readonly expiresAt: string; readonly walletKind: AdminWalletKind }

/**
 * POST /api/admin/auth/verify. EVM: `signature` is 0x hex (personal_sign of
 * the exact message). Solana: `signature` is the 64-byte ed25519 signature of
 * the UTF-8 message bytes (wallet `signMessage`), base58 or base64.
 */
export interface AdminVerifyRequest { readonly message: string; readonly signature: string }

export type AdminRecordStatus = "pending" | "verified" | "verification_failed" | "superseded" | "archived";

export interface AdminVerificationCheck {
  readonly id: "chain" | "tx_success" | "creation" | "deployer" | "init_code" | "constructor_args"
    | "runtime_code" | "owner" | "role_reads" | "confirmations";
  readonly ok: boolean; readonly detail: string;
}

export interface AdminDeploymentRecord {
  readonly id: string;                 // "dep_" + 24 hex
  readonly targetId: string;
  readonly network: AdminEvmNetwork; readonly chainId: number;
  readonly contractId: AdminContractId; readonly instance?: string;
  readonly address: string; readonly txHash: string; readonly block: string;
  readonly deployer: string;
  readonly constructorArgs: Readonly<Record<string, string>>;   // by input name, decimal / checksummed
  readonly ownerKind: "eoa" | "safe" | "contract" | "none";
  readonly expectedOwner: string | null;
  readonly artifactId: string;
  readonly artifactMaskedRuntimeHash: string;
  readonly onchainCodehash: string;
  readonly checks: readonly AdminVerificationCheck[];
  readonly status: AdminRecordStatus;
  readonly wired: boolean;             // true only for pinned addresses the product uses
  readonly notes: string;
  readonly createdBy: string; readonly createdAt: string; readonly updatedAt: string;
}

export interface AdminRecordRequest {
  readonly targetId: string;
  readonly txHash: string;
  readonly constructorArgs: Readonly<Record<string, string>>;
  readonly notes?: string;
}

export interface AdminNetworkProfile {
  readonly network: AdminEvmNetwork;
  readonly owner: string | null; readonly guardian: string | null; readonly treasury: string | null;
  readonly eoaOwnerAcknowledged: boolean;
  readonly updatedBy: string | null; readonly updatedAt: string | null;
}

export interface AdminConfirmation { readonly message: string; readonly signature: string }

export interface AdminContractState {
  readonly recordKey: string;          // "pinned:<network>:<address>" or record id
  readonly network: AdminEvmNetwork; readonly address: string; readonly contractId: AdminContractId;
  readonly block: string;
  readonly codeMatches: boolean | null;
  readonly owner: string | null; readonly pendingOwner: string | null;
  readonly ownerKind: "eoa" | "safe" | "contract" | "none";
  readonly safe?: { readonly threshold: number; readonly owners: readonly string[]; readonly nonce: string };
  readonly adminCanAct: "direct" | "via-safe" | "no";
  /** Why adminCanAct is "no", or a note for a Solana session ("Connect 0x… to sign."). */
  readonly adminCanActReason: string | null;
  readonly values: Readonly<Record<string, string | boolean | null>>;  // reads by fn name
  readonly balances: readonly AdminTokenAmount[];
}

export interface AdminTokenAmount {
  readonly token: string;              // address or "native"
  readonly symbol: string; readonly decimals: number;
  readonly amount: string;             // base units, decimal
  readonly usd: number | null;
}

export interface AdminActionVerifyRequest {
  readonly network: AdminEvmNetwork; readonly txHash: string;
  readonly contract: string; readonly actionId: string | null;
}

export interface AdminSafeProposal {
  readonly id: string;                 // "sfp_" + 24 hex
  readonly network: AdminEvmNetwork; readonly safe: string;
  readonly to: string; readonly value: string; readonly data: string; readonly operation: 0;
  readonly nonce: string; readonly safeTxHash: string;
  readonly description: string; readonly actionId: string | null;
  readonly decoded: { readonly fn: string; readonly args: Readonly<Record<string, string>> } | null;
  readonly threshold: number; readonly owners: readonly string[];
  readonly signatures: readonly { readonly signer: string; readonly signature: string; readonly at: string }[];
  readonly status: "collecting" | "ready" | "executed" | "stale" | "cancelled";
  readonly executedTxHash: string | null;
  readonly createdBy: string; readonly createdAt: string;
}

export interface AdminFeeRow {
  readonly network: AdminEvmNetwork; readonly contractId: AdminContractId;
  readonly address: string;
  readonly kind: "pushed" | "accrued" | "treasury-holding" | "lp-only" | "owner-funded" | "none";
  readonly amounts: readonly AdminTokenAmount[];
  readonly recipient: string | null;
  readonly claim: { readonly fn: string; readonly via: "direct" | "safe"; readonly caller: string; readonly blockedReason: string | null } | null;
  readonly scannedThroughBlock: string | null;
  /** Scan cursor key for POST fees/rescan (pushed rows), else null. */
  readonly scanKey: string | null;
  /** Blocks left to scan (pushed rows), else null. */
  readonly blocksLeft: string | null;
  readonly testnet: boolean;
  readonly note: string | null;
}

export interface AdminFeesView {
  readonly rows: readonly AdminFeeRow[];
  readonly totals: { readonly pushedUsd: number; readonly accruedUsd: number; readonly unpricedTokens: number };
  readonly asOf: string;
  /** Networks whose reads failed (shown per card; the rest of the view stays). */
  readonly errors: readonly { readonly network: AdminEvmNetwork; readonly message: string }[];
}

export type AdminRenderServiceKey = "api" | "site";
export interface AdminRenderDeploy {
  readonly id: string; readonly status: string; readonly trigger: string | null;
  readonly commit: { readonly id: string; readonly message: string } | null;
  readonly createdAt: string; readonly finishedAt: string | null;
}
export interface AdminRenderService {
  readonly key: AdminRenderServiceKey; readonly serviceId: string; readonly name: string | null;
  readonly url: string | null; readonly suspended: boolean | null;
  readonly deploys: readonly AdminRenderDeploy[];
}
export interface AdminServicesView {
  readonly configured: boolean;        // RENDER_API_KEY present
  readonly services: readonly AdminRenderService[];
  readonly runningCommit: string | null;   // RENDER_GIT_COMMIT of this API process
}

export interface AdminEnvItem { readonly name: string; readonly group: string; readonly required: boolean; readonly set: boolean }
export interface AdminEnvView { readonly items: readonly AdminEnvItem[]; readonly adminOrigins: readonly string[]; readonly store: "postgres" | "memory" }

export interface AdminAuditEntry {
  readonly id: string; readonly at: string; readonly address: string | null;
  readonly action: string; readonly outcome: "ok" | "denied" | "error";
  readonly target: Readonly<Record<string, string>>; readonly requestId: string;
}

export interface AdminExport {
  readonly schemaVersion: typeof ADMIN_EXPORT_SCHEMA;
  readonly exportedAt: string; readonly exportedBy: string; readonly apiCommit: string | null;
  readonly networks: Readonly<Partial<Record<AdminEvmNetwork, readonly AdminExportEntry[]>>>;
}
export interface AdminExportEntry {
  readonly contractId: AdminContractId; readonly instance?: string; readonly contractName: string;
  readonly address: string; readonly txHash: string; readonly block: string; readonly deployer: string;
  readonly constructorArgs: Readonly<Record<string, string>>;
  readonly onchainCodehash: string; readonly artifactMaskedRuntimeHash: string;
  readonly compiler: { readonly solc: string; readonly optimizer: boolean; readonly runs: number; readonly evmVersion: string };
  readonly explorerUrl: string; readonly status: "verified";
}

export interface AdminErrorBody { readonly error: { readonly code: string; readonly message: string; readonly requestId: string; readonly details?: Readonly<Record<string, unknown>> } }
