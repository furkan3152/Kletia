import {
  erc20Abi,
  getAddress,
  isAddress,
  keccak256,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import type { ParsedIntent } from "../ai/parser.js";
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  BASE_STAKING_CONTRACTS,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
  normalizeBaseProtocolId,
} from "../../networks/base/protocols.js";
import {
  NETWORKS,
  arbitrumPublicClient,
  basePublicClient,
  type NetworkId,
} from "../config/networks.js";
import { ARBITRUM_TOKENS } from "../../networks/arbitrum/contracts.js";
import { checkTokenSecurity } from "../../networks/base/security/tokenSecurity.js";
import {
  resolveBasenameEvidence,
  type BasenameResolutionEvidence,
} from "../../networks/base/intent/basenameResolver.js";
import {
  ASSET_CATALOG,
  ASSET_CATALOG_REVISION,
  UnsafeAssetReferenceError,
  closestCatalogAssets,
  compareAssetReferenceSimilarity,
  assetReferenceIdentityKey,
  findCatalogAssetsByReference,
  foldAssetReference,
  normalizeAssetReference,
  type AssetCatalogEntry,
  type AssetTrustTier,
} from "./catalog.js";

export type AssetField =
  "tokenIn" | "tokenOut" | "collateralToken" | "borrowToken";

export type EntityResolutionDecision =
  "eligible" | "clarification_required" | "blocked";

export interface ResolvedAssetEvidence {
  readonly role: AssetField;
  readonly originalReference: string;
  readonly canonicalSymbol: string;
  readonly displayName: string;
  readonly address?: Address;
  readonly decimals: number;
  readonly representation:
    "native" | "erc20" | "native_with_erc20_interface" | "app_kit_symbol";
  readonly matchedBy:
    | "canonical_symbol"
    | "curated_alias"
    | "exact_address"
    | "portfolio_verified_address"
    | "protocol_fixed_asset";
  readonly identityConfidence: number;
  readonly trustScore: number;
  readonly trustTier: AssetTrustTier;
  readonly trustLabel:
    | "canonical"
    | "reviewed"
    | "elevated_risk"
    | "project_contract"
    | "unlisted_verified";
  readonly security: {
    readonly status:
      "manifest_verified" | "registry_reviewed" | "provider_passed";
    readonly provider: "Kletia reviewed registry" | "GoPlus";
    readonly observedAt: string;
    readonly catalogRevision?: string;
    readonly primarySource?: string;
  };
  readonly onchain?: {
    readonly observedAtBlock: string;
    readonly codeHash: `0x${string}`;
    readonly metadataBounded: true;
    readonly balanceAtomic: string;
    readonly balanceVerified: true;
  };
  readonly actionCompatibility: {
    readonly action: string;
    readonly allowed: true;
    readonly executionDecimals: number;
  };
  readonly warnings: readonly string[];
}

export interface RecipientResolutionEvidence {
  readonly role: "recipient";
  readonly originalReference: string;
  readonly resolvedAddress: Address;
  readonly matchedBy: "exact_address" | "basename";
  readonly basename?: string;
  readonly resolver?: Address;
  readonly observedAtBlock?: string;
  readonly observedAt: string;
  readonly expiresAt: number;
  readonly crossNetworkIdentity: boolean;
  readonly warning?: string;
  readonly transferIndex?: number;
}

export interface IntentEntityResolutionEvidence {
  readonly policyVersion: "kletia_entity_resolution_v1";
  readonly requestId: string;
  readonly network: NetworkId;
  readonly chainId: number;
  readonly userAddress: Address;
  readonly action: string;
  readonly decision: "eligible";
  readonly observedAt: string;
  readonly assets: readonly ResolvedAssetEvidence[];
  readonly recipients: readonly RecipientResolutionEvidence[];
  readonly protocol?: {
    readonly original: string;
    readonly canonical: string;
    readonly matchedBy: "curated_alias" | "canonical_id";
  };
  readonly warnings: readonly string[];
  readonly scorePolicy: "informational_only_hard_gates_take_precedence";
}

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly symbol: string;
  readonly address?: Address;
  readonly trustLabel: string;
}

export type WorkflowClarificationField = `workflowSteps.${number}.${AssetField}`;

export interface EntityClarification {
  readonly kind: "asset" | "recipient" | "protocol" | "workflow";
  readonly code: string;
  readonly field?: AssetField | "recipient" | "protocol" | WorkflowClarificationField;
  readonly reference?: string;
  readonly question: string;
  readonly options: readonly ClarificationOption[];
}

export type IntentEntityResolutionResult =
  | {
      readonly status: "resolved";
      readonly intent: ParsedIntent;
      readonly evidence: IntentEntityResolutionEvidence;
    }
  | {
      readonly status: "clarification";
      readonly clarification: EntityClarification;
    };

export class EntityResolutionError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "EntityResolutionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface VerifiedPortfolioAsset {
  readonly symbol: string;
  readonly name: string;
  readonly address: Address;
  readonly decimals: number;
  readonly balance: bigint;
  readonly observedAtBlock: bigint;
  readonly codeHash: `0x${string}`;
  readonly similarity: number;
  readonly exactMatch: boolean;
}

type ResolvableAsset =
  AssetCatalogEntry | Omit<VerifiedPortfolioAsset, "similarity" | "exactMatch">;

export interface AssetResolverDependencies {
  readonly baseClient?: PublicClient;
  readonly discoverPortfolioAssets?: (
    reference: string,
    user: Address,
  ) => Promise<readonly VerifiedPortfolioAsset[]>;
  readonly checkBaseTokenSecurity?: (address: Address) => Promise<boolean>;
  readonly resolveBasename?: (
    name: string,
  ) => Promise<BasenameResolutionEvidence | null>;
  readonly now?: () => number;
}

const BASE_DYNAMIC_ASSET_ACTIONS = new Set([
  "swap",
  "add_liquidity",
  "remove_liquidity",
]);

const BASE_SWAP_PROTOCOLS = new Set([
  "aerodrome",
  "uniswap",
  "pancakeswap",
  "sushiswap",
  "alienbase",
  "baseswap",
  "swapbased",
]);

const BASE_LENDING_PROTOCOLS = new Set([
  "aave-v3",
  "moonwell",
  "compound-v3",
  "moonwell-vault",
  "seamless-vault",
  "spark-vault",
  "fluid-vault",
]);

const BASE_STAKING_PROTOCOLS = new Set([
  "aerodrome",
  "moonwell-safety-module",
  "seamless-staking",
]);
const BASE_BRIDGE_PROTOCOLS = new Set(["across"]);

const BASE_LENDING_ASSETS = new Set([
  ...AAVE_V3_BASE.reserves.map(({ token }) => token),
  ...MOONWELL_BASE.markets.map(({ token }) => token),
  ...COMPOUND_V3_BASE.markets.map(({ token }) => token),
  ...BASE_ERC4626_VAULTS.map(({ token }) => token),
]);

const BASE_STAKING_ASSETS = new Set(["AERO", "WELL", "SEAM"]);
const BASE_LST_ASSETS = new Set([
  "WSTETH",
  "CBETH",
  "RETH",
  "WEETH",
  "EZETH",
  "WRSETH",
]);

const ARC_ACTION_ASSETS: Readonly<
  Record<string, Partial<Record<AssetField, readonly string[]>>>
> = Object.freeze({
  swap: { tokenIn: ["USDC", "KLET"], tokenOut: ["USDC", "KLET"] },
  stable_swap: {
    tokenIn: ["USDC", "EURC", "CIRBTC"],
    tokenOut: ["USDC", "EURC", "CIRBTC"],
  },
  appkit_send: { tokenIn: ["USDC", "EURC"] },
  appkit_bridge: { tokenIn: ["USDC"] },
  stake: { tokenIn: ["USDC"] },
  unstake: { tokenIn: ["USDC"] },
  vault_deposit: { tokenIn: ["USDC"] },
  vault_withdraw: { tokenIn: ["USDC"] },
  vault_legacy_withdraw: { tokenIn: ["USDC"] },
  lending_deposit: {
    tokenIn: ["KLET"],
    collateralToken: ["KLET"],
  },
  lending_withdraw: { tokenIn: ["KLET", "USDC"] },
  lending_borrow: {
    tokenIn: ["USDC"],
    borrowToken: ["USDC"],
    collateralToken: ["KLET"],
  },
  lending_repay: { tokenIn: ["USDC"], borrowToken: ["USDC"] },
  memo_send: { tokenIn: ["USDC"] },
  official_memo_send: { tokenIn: ["USDC"] },
  atomic_payout: { tokenIn: ["USDC"] },
  add_liquidity: { tokenIn: ["USDC"], tokenOut: ["KLET"] },
});

const FIXED_ARC_FIELDS: Readonly<
  Record<string, Partial<Record<AssetField, string>>>
> = Object.freeze({
  appkit_bridge: { tokenIn: "USDC" },
  stake: { tokenIn: "USDC" },
  unstake: { tokenIn: "USDC" },
  vault_deposit: { tokenIn: "USDC" },
  vault_withdraw: { tokenIn: "USDC" },
  vault_legacy_withdraw: { tokenIn: "USDC" },
  lending_deposit: { tokenIn: "KLET", collateralToken: "KLET" },
  lending_borrow: {
    tokenIn: "USDC",
    borrowToken: "USDC",
    collateralToken: "KLET",
  },
  lending_repay: { tokenIn: "USDC", borrowToken: "USDC" },
  memo_send: { tokenIn: "USDC" },
  official_memo_send: { tokenIn: "USDC" },
  atomic_payout: { tokenIn: "USDC" },
  add_liquidity: { tokenIn: "USDC", tokenOut: "KLET" },
});

const ARBITRUM_ACTION_ASSETS: Readonly<
  Record<string, Partial<Record<AssetField, readonly string[]>>>
> = Object.freeze({
  transfer: { tokenIn: ["ETH", "WETH", "USDC", "ARB"] },
  swap: {
    tokenIn: ["WETH", "USDC", "ARB"],
    tokenOut: ["WETH", "USDC", "ARB"],
  },
  lend: { tokenIn: ["WETH", "USDC", "ARB"] },
  withdraw: { tokenIn: ["WETH", "USDC", "ARB"] },
  borrow: { tokenIn: ["WETH", "USDC", "ARB"] },
  borrow_capacity: { tokenIn: ["WETH", "USDC", "ARB"] },
  repay: { tokenIn: ["WETH", "USDC", "ARB"] },
  yield_compare: { tokenIn: ["WETH", "USDC", "ARB"] },
  bridge: { tokenIn: ["ETH", "WETH", "USDC"] },
});

const BASE_ASSET_FIELD_POLICY: Readonly<
  Record<
    string,
    {
      readonly required: readonly AssetField[];
      readonly allowed: readonly AssetField[];
    }
  >
> = Object.freeze({
  swap: { required: ["tokenIn", "tokenOut"], allowed: ["tokenIn", "tokenOut"] },
  add_liquidity: {
    required: ["tokenIn", "tokenOut"],
    allowed: ["tokenIn", "tokenOut"],
  },
  remove_liquidity: {
    required: ["tokenIn", "tokenOut"],
    allowed: ["tokenIn", "tokenOut"],
  },
  stake: { required: ["tokenIn"], allowed: ["tokenIn"] },
  liquid_stake: {
    required: ["tokenIn", "tokenOut"],
    allowed: ["tokenIn", "tokenOut"],
  },
  liquid_unstake: {
    required: ["tokenIn", "tokenOut"],
    allowed: ["tokenIn", "tokenOut"],
  },
  borrow: { required: ["tokenIn"], allowed: ["tokenIn"] },
  lend: { required: ["tokenIn"], allowed: ["tokenIn"] },
  repay: { required: ["tokenIn"], allowed: ["tokenIn"] },
  withdraw: { required: ["tokenIn"], allowed: ["tokenIn"] },
  yield_compare: { required: ["tokenIn"], allowed: ["tokenIn"] },
  bridge: { required: ["tokenIn"], allowed: ["tokenIn"] },
  workflow: { required: ["tokenIn"], allowed: ["tokenIn"] },
  allora_prediction: { required: ["tokenIn"], allowed: ["tokenIn"] },
});

const NON_ASSET_ACTIONS: Readonly<Record<NetworkId, ReadonlySet<string>>> = {
  base: new Set([
    "chat",
    "portfolio",
    "open_widget",
    "basename_register",
    "basename_renew",
    "deploy_token",
    "mint_nft",
    "agent_action",
    "x402_discover",
    "x402_request",
    "policy_agent",
  ]),
  arc: new Set([
    "chat",
    "portfolio",
    "open_widget",
    "claim_rewards",
    "claim_unstaked",
    "workflow",
  ]),
  arbitrum: new Set([
    "chat",
    "portfolio",
    "open_widget",
    "workflow",
    "policy_agent",
  ]),
};

function assetFieldPolicy(
  network: NetworkId,
  action: string,
): {
  readonly required: readonly AssetField[];
  readonly allowed: readonly AssetField[];
} | null {
  if (network === "base") {
    const policy = BASE_ASSET_FIELD_POLICY[action];
    if (policy) return policy;
  } else if (network === "arc") {
    const configured = ARC_ACTION_ASSETS[action];
    if (configured || action === "remove_liquidity") {
      const allowed =
        action === "remove_liquidity"
          ? (["tokenIn", "tokenOut"] as const)
          : (Object.keys(configured || {}) as AssetField[]);
      const required = action === "remove_liquidity" ? [] : allowed;
      return { required, allowed };
    }
  } else {
    const configured = ARBITRUM_ACTION_ASSETS[action];
    if (configured) {
      const allowed = Object.keys(configured) as AssetField[];
      return { required: allowed, allowed };
    }
  }
  if (NON_ASSET_ACTIONS[network].has(action)) return null;
  throw new EntityResolutionError(
    "ENTITY_POLICY_ACTION_UNSUPPORTED",
    `${NETWORKS[network].displayName} ${action} operation is not covered by the centralized asset policy.`,
  );
}

function fieldRequirements(
  network: NetworkId,
  action: string,
): readonly AssetField[] {
  return assetFieldPolicy(network, action)?.required || [];
}

function trustScore(
  tier: AssetTrustTier,
  verification: "manifest_verified" | "registry_reviewed" = "manifest_verified",
): number {
  const provenanceAdjustment = verification === "registry_reviewed" ? -8 : 0;
  switch (tier) {
    case "core":
      return 98 + provenanceAdjustment;
    case "established":
      return 90 + provenanceAdjustment;
    case "project":
      return 92 + provenanceAdjustment;
    case "elevated":
      return 72 + provenanceAdjustment;
    case "portfolio":
      return 55;
  }
}

function trustLabel(tier: AssetTrustTier): ResolvedAssetEvidence["trustLabel"] {
  switch (tier) {
    case "core":
      return "canonical";
    case "established":
      return "reviewed";
    case "project":
      return "project_contract";
    case "elevated":
      return "elevated_risk";
    case "portfolio":
      return "unlisted_verified";
  }
}

function normalizedSymbol(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

type AssetExecutionShape = Pick<
  VerifiedPortfolioAsset,
  "symbol" | "decimals"
> & {
  readonly executionUnits?: Readonly<Record<string, number>>;
};

function executionDecimals(
  network: NetworkId,
  action: string,
  asset: AssetExecutionShape,
): number {
  if (network === "arc" && "executionUnits" in asset) {
    if (
      action === "stable_swap" ||
      action === "appkit_send" ||
      action === "appkit_bridge" ||
      action === "official_memo_send" ||
      action === "atomic_payout"
    ) {
      return asset.executionUnits?.app_kit ?? asset.decimals;
    }
    if (normalizedSymbol(asset.symbol) === "USDC") {
      return asset.executionUnits?.kletia_native_value ?? 18;
    }
  }
  return asset.decimals;
}

function assertActionCompatibility(
  network: NetworkId,
  action: string,
  role: AssetField,
  asset: ResolvableAsset,
) {
  const symbol = normalizedSymbol(asset.symbol);
  if (network === "arc") {
    const allowed = ARC_ACTION_ASSETS[action]?.[role];
    if (!allowed || !allowed.includes(symbol)) {
      throw new EntityResolutionError(
        "ASSET_ACTION_UNSUPPORTED",
        `${asset.symbol} recognized but not supported in Arc ${action} operation as ${role} role.`,
      );
    }
    return;
  }

  if (network === "arbitrum") {
    const allowed = ARBITRUM_ACTION_ASSETS[action]?.[role];
    if (!allowed || !allowed.includes(symbol)) {
      throw new EntityResolutionError(
        "ASSET_ACTION_UNSUPPORTED",
        `${asset.symbol} is recognized but is not supported as ${role} for the Arbitrum ${action} beta route.`,
      );
    }
    return;
  }

  if (!("network" in asset) && !BASE_DYNAMIC_ASSET_ACTIONS.has(action)) {
    throw new EntityResolutionError(
      "DYNAMIC_ASSET_ACTION_UNSUPPORTED",
      `${asset.symbol} contract verified, but dynamic tokens are not supported in Base ${action} operation.`,
    );
  }

  if (
    ["lend", "borrow", "repay", "withdraw", "yield_compare"].includes(action) &&
    !BASE_LENDING_ASSETS.has(symbol as never)
  ) {
    throw new EntityResolutionError(
      "ASSET_MARKET_UNSUPPORTED",
      `${asset.symbol} recognized, but no suitable market exists for this asset in verified Base lending/vault records.`,
    );
  }
  if (action === "stake" && !BASE_STAKING_ASSETS.has(symbol)) {
    throw new EntityResolutionError(
      "ASSET_STAKING_UNSUPPORTED",
      `${asset.symbol} recognized, but Base staking can only be prepared for AERO, WELL, or SEAM.`,
    );
  }
  if (action === "liquid_stake" && role === "tokenIn" && symbol !== "ETH") {
    throw new EntityResolutionError(
      "LST_INPUT_UNSUPPORTED",
      "The input asset for the Base liquid staking purchase route must be native ETH.",
    );
  }
  if (
    action === "liquid_stake" &&
    role === "tokenOut" &&
    !BASE_LST_ASSETS.has(symbol)
  ) {
    throw new EntityResolutionError(
      "LST_OUTPUT_UNSUPPORTED",
      `${asset.symbol} is not a verified Base LST/LRT purchase target.`,
    );
  }
  if (
    action === "liquid_unstake" &&
    role === "tokenIn" &&
    !BASE_LST_ASSETS.has(symbol)
  ) {
    throw new EntityResolutionError(
      "LST_ASSET_UNSUPPORTED",
      `${asset.symbol} is not included in the verified Base LST/LRT exit set.`,
    );
  }
  if (action === "liquid_unstake" && role === "tokenOut" && symbol !== "ETH") {
    throw new EntityResolutionError(
      "LST_EXIT_OUTPUT_UNSUPPORTED",
      "The target of the Base LST/LRT exit route must be native ETH.",
    );
  }
  if (action === "bridge" && !["ETH", "WETH", "USDC"].includes(symbol)) {
    throw new EntityResolutionError(
      "BRIDGE_ASSET_UNSUPPORTED",
      "Across Base routes are only validated for ETH, WETH, or USDC.",
    );
  }
}

function protocolPolicy(action: string): ReadonlySet<string> | null {
  if (["swap", "add_liquidity", "remove_liquidity"].includes(action)) {
    return BASE_SWAP_PROTOCOLS;
  }
  if (
    ["lend", "borrow", "repay", "withdraw", "yield_compare"].includes(action)
  ) {
    return BASE_LENDING_PROTOCOLS;
  }
  if (action === "stake") return BASE_STAKING_PROTOCOLS;
  if (action === "bridge") return BASE_BRIDGE_PROTOCOLS;
  return null;
}

function resolveProtocol(
  network: NetworkId,
  action: string,
  protocol: string | undefined,
): IntentEntityResolutionEvidence["protocol"] | undefined {
  if (!protocol || protocol.trim().toLowerCase() === "unknown")
    return undefined;
  if (network === "arc") {
    const folded = foldAssetReference(protocol);
    const appKitAction = [
      "stable_swap",
      "appkit_send",
      "appkit_bridge",
    ].includes(action);
    const accepted = appKitAction
      ? new Set(["circleappkit", "appkit", "circle"])
      : new Set(["kletia", "arc", "kletiaarc"]);
    if (!accepted.has(folded)) {
      throw new EntityResolutionError(
        "PROTOCOL_ACTION_UNSUPPORTED",
        `${protocol} protocol does not match Arc ${action} execution pipeline.`,
      );
    }
    return {
      original: protocol,
      canonical: appKitAction ? "circle-app-kit" : "kletia-arc",
      matchedBy: "curated_alias",
    };
  }

  if (network === "arbitrum") {
    const folded = foldAssetReference(protocol);
    const canonical =
      ["uniswap", "uniswapv3", "univ3"].includes(folded) && action === "swap"
        ? "uniswap-v3"
        : ["aave", "aavev3"].includes(folded) &&
            ["lend", "withdraw", "borrow", "borrow_capacity", "repay", "yield_compare"].includes(action)
          ? "aave-v3"
          : ["across", "acrossv3"].includes(folded) && action === "bridge"
            ? "across"
            : null;
    if (!canonical) {
      throw new EntityResolutionError(
        "PROTOCOL_ACTION_UNSUPPORTED",
        `${protocol} is not a verified protocol for the Arbitrum ${action} beta route.`,
      );
    }
    return {
      original: protocol,
      canonical,
      matchedBy: foldAssetReference(protocol) === foldAssetReference(canonical)
        ? "canonical_id"
        : "curated_alias",
    };
  }

  const canonical = normalizeBaseProtocolId(protocol);
  const policy = protocolPolicy(action);
  if (!policy || !canonical || !policy.has(canonical)) {
    throw new EntityResolutionError(
      "PROTOCOL_ACTION_UNSUPPORTED",
      `${protocol} protocol recognized but no verified execution record in Base ${action} feature.`,
    );
  }
  return {
    original: protocol,
    canonical,
    matchedBy:
      foldAssetReference(protocol) === foldAssetReference(canonical)
        ? "canonical_id"
        : "curated_alias",
  };
}

function boundedMetadata(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new EntityResolutionError(
      "ERC20_METADATA_INVALID",
      `Token ${field} data is not in standard string format.`,
    );
  }
  let normalized: string;
  try {
    normalized = normalizeAssetReference(value);
  } catch {
    throw new EntityResolutionError(
      "ERC20_METADATA_UNSAFE",
      `Token ${field} data contains invisible or control characters.`,
    );
  }
  if (normalized.length > maxLength) {
    throw new EntityResolutionError(
      "ERC20_METADATA_TOO_LONG",
      `Token ${field} data exceeds secure display limit.`,
    );
  }
  return normalized;
}

async function verifyBaseErc20(
  addressInput: string,
  user: Address,
  client: PublicClient,
): Promise<Omit<VerifiedPortfolioAsset, "similarity" | "exactMatch">> {
  let address: Address;
  try {
    address = getAddress(addressInput);
  } catch {
    throw new EntityResolutionError(
      "INVALID_TOKEN_ADDRESS",
      "Token contract address is not a valid EVM address.",
    );
  }
  if (address === zeroAddress) {
    throw new EntityResolutionError(
      "ZERO_TOKEN_ADDRESS",
      "Zero address cannot be used as a token contract.",
    );
  }

  const observedAtBlock = await client.getBlockNumber();
  const bytecode = await client.getBytecode({
    address,
    blockNumber: observedAtBlock,
  });
  if (!bytecode || bytecode === "0x") {
    throw new EntityResolutionError(
      "TOKEN_CODE_MISSING",
      "The entered address does not contain contract bytecode on this Base block.",
    );
  }

  let symbolRaw: string;
  let nameRaw: string;
  let decimals: number;
  let balance: bigint;
  let totalSupply: bigint;
  try {
    [symbolRaw, nameRaw, decimals, balance, totalSupply] = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "name",
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "totalSupply",
        blockNumber: observedAtBlock,
      }),
    ]);
  } catch {
    throw new EntityResolutionError(
      "ERC20_INTERFACE_UNVERIFIED",
      "The address's standard ERC-20 metadata, balance, and supply interface could not be verified at the same block.",
    );
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new EntityResolutionError(
      "ERC20_DECIMALS_UNSAFE",
      "Token decimals value is not within the safe range of 0-36.",
    );
  }
  if (totalSupply <= 0n) {
    throw new EntityResolutionError(
      "ERC20_SUPPLY_INVALID",
      "Token total supply is not positive.",
    );
  }

  return {
    symbol: boundedMetadata(symbolRaw, "symbol", 24),
    name: boundedMetadata(nameRaw, "name", 64),
    address,
    decimals,
    balance,
    observedAtBlock,
    codeHash: keccak256(bytecode),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  code: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new EntityResolutionError(
      code,
      "Onchain token verification time exceeded the safe request budget.",
      503,
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new EntityResolutionError(
                code,
                "Onchain token verification time exceeded the safe request budget.",
                503,
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function alchemyRpc(
  url: string,
  method: string,
  params: readonly unknown[],
  timeoutMs = 4_000,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
  });
  if (!response.ok) throw new Error(`alchemy_http_${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error("alchemy_provider_error");
  return body?.result;
}

async function discoverBasePortfolioAssets(
  reference: string,
  user: Address,
  client: PublicClient,
): Promise<readonly VerifiedPortfolioAsset[]> {
  const deadline = Date.now() + 6_000;
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) return [];
  const url = `https://base-mainnet.g.alchemy.com/v2/${key}`;

  let balanceResult: unknown;
  try {
    balanceResult = await alchemyRpc(
      url,
      "alchemy_getTokenBalances",
      [user, "erc20"],
      4_000,
    );
  } catch {
    return [];
  }
  const records =
    balanceResult &&
    typeof balanceResult === "object" &&
    Array.isArray(
      (balanceResult as { tokenBalances?: unknown[] }).tokenBalances,
    )
      ? (balanceResult as { tokenBalances: unknown[] }).tokenBalances
      : [];

  const allAddresses = [
    ...new Set(
      records
        .flatMap((record): Address[] => {
          if (!record || typeof record !== "object") return [];
          const raw = record as {
            contractAddress?: unknown;
            tokenBalance?: unknown;
          };
          try {
            if (BigInt(String(raw.tokenBalance)) <= 0n) return [];
            return [getAddress(String(raw.contractAddress))];
          } catch {
            return [];
          }
        })
        .map((address) => address.toLowerCase()),
    ),
  ].map((address) => getAddress(address));

  const addresses =
    allAddresses.length <= 32
      ? allAddresses
      : Array.from(
          { length: 32 },
          (_value, index) =>
            allAddresses[Math.floor((index * (allAddresses.length - 1)) / 31)],
        );

  const hints = await mapWithConcurrency(addresses, 8, async (address) => {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 250) return null;
      const metadata = await alchemyRpc(
        url,
        "alchemy_getTokenMetadata",
        [address],
        Math.min(2_000, remaining),
      );
      if (!metadata || typeof metadata !== "object") return null;
      const raw = metadata as { symbol?: unknown; name?: unknown };
      const symbol = typeof raw.symbol === "string" ? raw.symbol : "";
      const name = typeof raw.name === "string" ? raw.name : "";
      const similarity = Math.max(
        symbol ? compareAssetReferenceSimilarity(reference, symbol) : 0,
        name ? compareAssetReferenceSimilarity(reference, name) : 0,
      );
      const exactMatch = [symbol, name].some((value) => {
        try {
          return (
            value &&
            assetReferenceIdentityKey(value) ===
              assetReferenceIdentityKey(reference)
          );
        } catch {
          return false;
        }
      });
      return similarity >= 0.68 || exactMatch
        ? { address, similarity, exactMatch }
        : null;
    } catch {
      return null;
    }
  });

  const shortlist = hints
    .filter((hint): hint is NonNullable<typeof hint> => hint !== null)
    .sort(
      (left, right) =>
        Number(right.exactMatch) - Number(left.exactMatch) ||
        right.similarity - left.similarity,
    )
    .slice(0, 6);

  const verified = await mapWithConcurrency(shortlist, 4, async (hint) => {
    try {
      if (Date.now() >= deadline) return null;
      const asset = await withinDeadline(
        verifyBaseErc20(hint.address, user, client),
        deadline,
        "PORTFOLIO_ASSET_VERIFICATION_TIMEOUT",
      );
      const exactMatch = [asset.symbol, asset.name].some(
        (value) =>
          assetReferenceIdentityKey(value) ===
          assetReferenceIdentityKey(reference),
      );
      const similarity = Math.max(
        compareAssetReferenceSimilarity(reference, asset.symbol),
        compareAssetReferenceSimilarity(reference, asset.name),
      );
      if (asset.balance <= 0n || (!exactMatch && similarity < 0.68))
        return null;
      return { ...asset, exactMatch, similarity };
    } catch {
      return null;
    }
  });
  return verified
    .filter((asset): asset is VerifiedPortfolioAsset => asset !== null)
    .sort(
      (left, right) =>
        Number(right.exactMatch) - Number(left.exactMatch) ||
        right.similarity - left.similarity ||
        left.address.localeCompare(right.address),
    );
}

const portfolioDiscoveryCache = new Map<
  string,
  {
    readonly expiresAt: number;
    readonly promise: Promise<readonly VerifiedPortfolioAsset[]>;
  }
>();

function discoverBasePortfolioAssetsCached(
  reference: string,
  user: Address,
  client: PublicClient,
): Promise<readonly VerifiedPortfolioAsset[]> {
  const cacheKey = `${user.toLowerCase()}:${assetReferenceIdentityKey(reference)}`;
  const cached = portfolioDiscoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (portfolioDiscoveryCache.size >= 200) {
    const oldest = portfolioDiscoveryCache.keys().next().value;
    if (oldest) portfolioDiscoveryCache.delete(oldest);
  }
  const promise = discoverBasePortfolioAssets(reference, user, client);
  portfolioDiscoveryCache.set(cacheKey, {
    expiresAt: Date.now() + 30_000,
    promise,
  });
  promise.catch(() => {
    if (portfolioDiscoveryCache.get(cacheKey)?.promise === promise) {
      portfolioDiscoveryCache.delete(cacheKey);
    }
  });
  return promise;
}

function catalogOptions(
  _originalPrompt: string,
  role: AssetField,
  candidates: readonly { asset: AssetCatalogEntry; similarity: number }[],
): readonly ClarificationOption[] {
  return candidates.map(({ asset }) => ({
    id: `${role}:${asset.network}:${asset.symbol}`,
    label: `${asset.name} (${asset.symbol})`,
    symbol: asset.symbol,
    address: asset.address,
    trustLabel: trustLabel(asset.trustTier),
  }));
}

function portfolioOptions(
  _originalPrompt: string,
  role: AssetField,
  candidates: readonly VerifiedPortfolioAsset[],
): readonly ClarificationOption[] {
  return candidates.slice(0, 4).map((asset) => ({
    id: `${role}:base:${asset.address.toLowerCase()}`,
    label: `${asset.name} (${asset.symbol}) · ${asset.address.slice(0, 6)}…${asset.address.slice(-4)}`,
    symbol: asset.symbol,
    address: asset.address,
    trustLabel: "unlisted_verified",
  }));
}

function requiredAssetQuestion(
  network: NetworkId,
  role: AssetField,
): EntityClarification {
  return {
    kind: "asset",
    code: "ASSET_REQUIRED",
    field: role,
    question:
      `${role} presence missing on ${NETWORKS[network].displayName}.` +
      "You must enter the name, symbol, or contract address of the token you want to use.",
    options: [],
  };
}

function workflowAssetClarification(
  intent: ParsedIntent,
): EntityClarification | null {
  if (intent.action !== "workflow" || !intent.workflowSteps) return null;
  const stepIndex = intent.workflowSteps.findIndex((step) => {
    const network = step.network ||
      (step.action === "bridge" || step.action === "gas_acquire"
        ? "base"
        : "arbitrum");
    return network === "arbitrum" &&
      ["lend", "withdraw", "borrow", "borrow_capacity", "repay", "yield_compare"]
        .includes(step.action) &&
      String(step.tokenIn || "").trim().toUpperCase() === "ETH";
  });
  if (stepIndex < 0) return null;
  return {
    kind: "workflow",
    code: "WORKFLOW_ASSET_REPRESENTATION_REQUIRED",
    field: `workflowSteps.${stepIndex}.tokenIn`,
    reference: "ETH",
    question:
      "Aave V3 uses ERC-20 reserves rather than native ETH. Which reviewed Arbitrum asset should the workflow supply? Kletia will propagate the selection through the preceding swap and bridge steps instead of guessing.",
    options: [
      {
        id: `workflow:${stepIndex}:WETH`,
        label: "WETH — keep ETH exposure (recommended)",
        symbol: "WETH",
        address: ARBITRUM_TOKENS.WETH.address,
        trustLabel: "canonical",
      },
      {
        id: `workflow:${stepIndex}:USDC`,
        label: "USDC — stablecoin lending",
        symbol: "USDC",
        address: ARBITRUM_TOKENS.USDC.address,
        trustLabel: "canonical",
      },
      {
        id: `workflow:${stepIndex}:ARB`,
        label: "ARB — governance asset lending",
        symbol: "ARB",
        address: ARBITRUM_TOKENS.ARB.address,
        trustLabel: "reviewed",
      },
    ],
  };
}

function evidenceFromCatalog(
  role: AssetField,
  originalReference: string,
  asset: AssetCatalogEntry,
  action: string,
  matchedBy: ResolvedAssetEvidence["matchedBy"],
  observedAt: string,
): ResolvedAssetEvidence {
  const warnings: string[] = [];
  if (asset.trustTier === "elevated") {
    warnings.push(
      "This asset carries elevated market/liquidity risk; route simulation is not a security guarantee.",
    );
  }
  if (asset.verification === "registry_reviewed") {
    warnings.push(
      "This token was reviewed in Kletia execution records; however, the asset-specific primary publisher source is not linked in the manifest for the address.",
    );
  }
  if (asset.network === "arc" && asset.symbol === "USDC") {
    warnings.push(
      "Arc USDC atomic precision differs by execution lane: Kletia native-value 18, ERC-20/App Kit 6.",
    );
  }
  return {
    role,
    originalReference,
    canonicalSymbol: asset.symbol,
    displayName: asset.name,
    address: asset.address,
    decimals: asset.decimals,
    representation: asset.representation,
    matchedBy,
    identityConfidence: matchedBy === "curated_alias" ? 98 : 100,
    trustScore: trustScore(asset.trustTier, asset.verification),
    trustTier: asset.trustTier,
    trustLabel: trustLabel(asset.trustTier),
    security: {
      status: asset.verification,
      provider: "Kletia reviewed registry",
      observedAt,
      catalogRevision: ASSET_CATALOG_REVISION,
      primarySource: asset.officialSource,
    },
    actionCompatibility: {
      action,
      allowed: true,
      executionDecimals: executionDecimals(asset.network, action, asset),
    },
    warnings,
  };
}

async function evidenceFromDynamicAddress(
  role: AssetField,
  originalReference: string,
  asset: Omit<VerifiedPortfolioAsset, "similarity" | "exactMatch">,
  action: string,
  observedAt: string,
  securityCheck: (address: Address) => Promise<boolean>,
): Promise<ResolvedAssetEvidence> {
  if ((await securityCheck(asset.address)) !== true) {
    throw new EntityResolutionError(
      "TOKEN_SECURITY_REJECTED",
      "Dynamic token independent security check failed.",
    );
  }
  return {
    role,
    originalReference,
    canonicalSymbol: asset.symbol,
    displayName: asset.name,
    address: asset.address,
    decimals: asset.decimals,
    representation: "erc20",
    matchedBy: "exact_address",
    identityConfidence: 100,
    trustScore: trustScore("portfolio"),
    trustTier: "portfolio",
    trustLabel: trustLabel("portfolio"),
    security: {
      status: "provider_passed",
      provider: "GoPlus",
      observedAt,
    },
    onchain: {
      observedAtBlock: asset.observedAtBlock.toString(),
      codeHash: asset.codeHash,
      metadataBounded: true,
      balanceAtomic: asset.balance.toString(),
      balanceVerified: true,
    },
    actionCompatibility: {
      action,
      allowed: true,
      executionDecimals: asset.decimals,
    },
    warnings: [
      "This contract is not in the Kletia canonical token registry. Identity, ERC-20 interface, wallet balance, and risk provider verified; behavioral/proxy risks may still vary.",
    ],
  };
}

function actionUsesRecipient(action: string): boolean {
  return new Set([
    "appkit_send",
    "appkit_bridge",
    "memo_send",
    "official_memo_send",
    "transfer",
  ]).has(action);
}

async function resolveRecipient(
  reference: unknown,
  network: NetworkId,
  now: number,
  basenameResolver: (
    name: string,
  ) => Promise<BasenameResolutionEvidence | null>,
): Promise<RecipientResolutionEvidence> {
  const raw = normalizeAssetReference(reference);
  if (isAddress(raw)) {
    const address = getAddress(raw);
    if (address === zeroAddress) {
      throw new EntityResolutionError(
        "RECIPIENT_ZERO_ADDRESS",
        "Recipient cannot be the zero address.",
      );
    }
    return {
      role: "recipient",
      originalReference: raw,
      resolvedAddress: address,
      matchedBy: "exact_address",
      observedAt: new Date(now).toISOString(),
      expiresAt: now + 60_000,
      crossNetworkIdentity: false,
    };
  }
  if (!/^[^\s.]+\.base(?:\.eth)?$/iu.test(raw)) {
    throw new EntityResolutionError(
      "RECIPIENT_UNRESOLVED",
      "Recipient must be a full EVM address or a resolvable .base.eth name.",
    );
  }
  const result = await basenameResolver(raw);
  if (!result) {
    throw new EntityResolutionError(
      "BASENAME_UNRESOLVED",
      `No verified Basename address record found for ${raw}.`,
    );
  }
  return {
    role: "recipient",
    originalReference: raw,
    resolvedAddress: result.address,
    matchedBy: "basename",
    basename: result.name,
    resolver: result.resolver,
    observedAtBlock: result.observedAtBlock,
    observedAt: result.observedAt,
    expiresAt: Math.min(result.expiresAt, now + 60_000),
    crossNetworkIdentity: network !== "base",
    warning:
      network !== "base"
        ? "Basename resolved on Base; Arc transaction will go to the same EVM address. Verify network and 0x recipient before signing."
        : undefined,
  };
}

export async function resolveIntentEntities(
  intent: ParsedIntent,
  context: {
    readonly network: NetworkId;
    readonly userAddress: string;
    readonly originalPrompt: string;
    readonly requestId: string;
  },
  dependencies: AssetResolverDependencies = {},
): Promise<IntentEntityResolutionResult> {
  const { network, originalPrompt } = context;
  const action = String(intent.action || "")
    .trim()
    .toLowerCase();
  const now = (dependencies.now || Date.now)();
  const observedAt = new Date(now).toISOString();
  let user: Address;
  try {
    user = getAddress(context.userAddress);
  } catch {
    throw new EntityResolutionError(
      "INVALID_RESOLUTION_WALLET",
      "Asset resolution wallet is invalid.",
    );
  }

  const client: PublicClient = (dependencies.baseClient ||
    (network === "arbitrum" ? arbitrumPublicClient : basePublicClient)) as PublicClient;
  const portfolioDiscovery =
    dependencies.discoverPortfolioAssets ||
    ((reference: string, owner: Address) =>
      discoverBasePortfolioAssetsCached(reference, owner, client));
  const securityCheck =
    dependencies.checkBaseTokenSecurity ||
    ((address: Address) => checkTokenSecurity(address, "dynamic_execution"));
  const basenameResolver =
    dependencies.resolveBasename || resolveBasenameEvidence;

  const workingIntent: ParsedIntent = { ...intent };
  const workflowClarification = workflowAssetClarification(workingIntent);
  if (workflowClarification) {
    return { status: "clarification", clarification: workflowClarification };
  }
  if (
    action === "liquid_stake" &&
    workingIntent.tokenIn &&
    !workingIntent.tokenOut
  ) {
    workingIntent.tokenOut = workingIntent.tokenIn;
    workingIntent.tokenIn = "ETH";
  }
  if (
    action === "liquid_unstake" &&
    workingIntent.tokenIn &&
    !workingIntent.tokenOut
  ) {
    workingIntent.tokenOut = "ETH";
  }
  if (
    action === "memo_send" &&
    !workingIntent.recipient &&
    workingIntent.tokenOut
  ) {
    workingIntent.recipient = workingIntent.tokenOut;
    workingIntent.tokenOut = undefined;
  }
  const fixedFields = network === "arc" ? FIXED_ARC_FIELDS[action] || {} : {};
  for (const [field, value] of Object.entries(fixedFields)) {
    const role = field as AssetField;
    if (!workingIntent[role]) workingIntent[role] = value;
  }

  const policy = assetFieldPolicy(network, action);
  const allAssetFields: readonly AssetField[] = [
    "tokenIn",
    "tokenOut",
    "collateralToken",
    "borrowToken",
  ];
  const fieldsToResolve = policy
    ? [
        ...new Set([
          ...policy.required,
          ...allAssetFields.filter((field) => {
            if (!workingIntent[field]) return false;
            if (!policy.allowed.includes(field)) {
              throw new EntityResolutionError(
                "ENTITY_ROLE_ACTION_UNSUPPORTED",
                `The ${field} field is not used in the ${NETWORKS[network].displayName} ${action} execution plan; it cannot be silently ignored.`,
              );
            }
            return true;
          }),
        ]),
      ]
    : [];
  const assets: ResolvedAssetEvidence[] = [];
  for (const role of fieldsToResolve) {
    const rawValue = workingIntent[role];
    if (!rawValue) {
      return {
        status: "clarification",
        clarification: requiredAssetQuestion(network, role),
      };
    }

    let reference: string;
    try {
      reference = normalizeAssetReference(rawValue);
    } catch (error) {
      if (error instanceof UnsafeAssetReferenceError) {
        throw new EntityResolutionError(error.code, error.message);
      }
      throw error;
    }
    if (/^0x/iu.test(reference) && !isAddress(reference)) {
      throw new EntityResolutionError(
        "INVALID_TOKEN_ADDRESS",
        "Token reference starting with 0x must be a full and valid EVM contract address.",
      );
    }

    const catalogMatches = findCatalogAssetsByReference(network, reference);
    if (catalogMatches.length === 1) {
      const asset = catalogMatches[0];
      assertActionCompatibility(network, action, role, asset);
      const exactSymbol =
        assetReferenceIdentityKey(reference) ===
        assetReferenceIdentityKey(asset.symbol);
      const addressMatch = isAddress(reference);
      const fixed =
        fixedFields[role] !== undefined &&
        assetReferenceIdentityKey(reference) ===
          assetReferenceIdentityKey(fixedFields[role]);
      const matchedBy: ResolvedAssetEvidence["matchedBy"] = fixed
        ? "protocol_fixed_asset"
        : addressMatch
          ? "exact_address"
          : exactSymbol
            ? "canonical_symbol"
            : "curated_alias";
      workingIntent[role] = asset.symbol;
      assets.push(
        evidenceFromCatalog(
          role,
          reference,
          asset,
          action,
          matchedBy,
          observedAt,
        ),
      );
      continue;
    }

    if (catalogMatches.length > 1) {
      return {
        status: "clarification",
        clarification: {
          kind: "asset",
          code: "ASSET_REFERENCE_AMBIGUOUS",
          field: role,
          reference,
          question: `${reference} matches multiple canonical entities; which one did you mean?`,
          options: catalogOptions(
            originalPrompt,
            role,
            catalogMatches.map((asset) => ({ asset, similarity: 1 })),
          ),
        },
      };
    }

    if (isAddress(reference)) {
      if (network !== "base") {
        throw new EntityResolutionError(
          "NETWORK_ASSET_ADDRESS_UNLISTED",
          network === "arc"
            ? "Arc token contract address does not match USDC, EURC, or KLET identity in the official/Kletia manifest."
            : `Arbitrum token address is not one of the reviewed beta assets: ${ARBITRUM_TOKENS.USDC.address}, ${ARBITRUM_TOKENS.WETH.address}, or ${ARBITRUM_TOKENS.ARB.address}.`,
        );
      }
      const verified = await withinDeadline(
        verifyBaseErc20(reference, user, client),
        Date.now() + 8_000,
        "TOKEN_VERIFICATION_TIMEOUT",
      );
      assertActionCompatibility(network, action, role, verified);
      workingIntent[role] = verified.address;
      assets.push(
        await evidenceFromDynamicAddress(
          role,
          reference,
          verified,
          action,
          observedAt,
          securityCheck,
        ),
      );
      continue;
    }

    if (network === "base") {
      const portfolioCandidates = await portfolioDiscovery(reference, user);
      const exactCandidates = portfolioCandidates.filter(
        ({ exactMatch }) => exactMatch,
      );
      const candidates =
        exactCandidates.length > 0 ? exactCandidates : portfolioCandidates;
      if (candidates.length > 0) {
        return {
          status: "clarification",
          clarification: {
            kind: "asset",
            code:
              candidates.length === 1
                ? "PORTFOLIO_ASSET_CONFIRMATION_REQUIRED"
                : "PORTFOLIO_ASSET_AMBIGUOUS",
            field: role,
            reference,
            question:
              candidates.length === 1
                ? `Did you mean the ${candidates[0].name} (${candidates[0].symbol}) contract? The transaction will not be prepared without address verification.`
                : `${reference} matches multiple tokens in the wallet; you must select by contract address.`,
            options: portfolioOptions(originalPrompt, role, candidates),
          },
        };
      }
    }

    const suggestions = closestCatalogAssets(network, reference);
    return {
      status: "clarification",
      clarification: {
        kind: "asset",
        code:
          suggestions.length > 0
            ? "ASSET_SUGGESTION_CONFIRMATION_REQUIRED"
            : "ASSET_UNKNOWN",
        field: role,
        reference,
        question:
          suggestions.length === 1
            ? `Did you mean the ${suggestions[0].asset.name} (${suggestions[0].asset.symbol}) token?`
            : suggestions.length > 1
              ? `${reference} could not be definitively identified; did you mean one of the following entities?`
              : `${reference} could not be securely resolved on ${NETWORKS[network].displayName}. You must enter the symbol or full contract address.`,
        options: catalogOptions(originalPrompt, role, suggestions),
      },
    };
  }

  const protocol = resolveProtocol(network, action, workingIntent.protocol);
  if (protocol) workingIntent.protocol = protocol.canonical;

  const recipientAction = actionUsesRecipient(action);
  if (workingIntent.recipient && !recipientAction) {
    throw new EntityResolutionError(
      "ENTITY_RECIPIENT_ACTION_UNSUPPORTED",
      `The recipient field is not used in the ${NETWORKS[network].displayName} ${action} execution schema; it cannot be silently ignored.`,
    );
  }
  if (workingIntent.transfers !== undefined && action !== "atomic_payout") {
    throw new EntityResolutionError(
      "ENTITY_TRANSFERS_ACTION_UNSUPPORTED",
      `The transfers field is not used in the ${NETWORKS[network].displayName} ${action} execution schema; it cannot be silently ignored.`,
    );
  }

  const recipients: RecipientResolutionEvidence[] = [];
  if (recipientAction) {
    if (!workingIntent.recipient) {
      return {
        status: "clarification",
        clarification: {
          kind: "recipient",
          code: "RECIPIENT_REQUIRED",
          field: "recipient",
          question:
            "Recipient must be specified as a full EVM address or .base.eth name.",
          options: [],
        },
      };
    }
    const recipient = await resolveRecipient(
      workingIntent.recipient,
      network,
      now,
      basenameResolver,
    );
    workingIntent.recipient = recipient.resolvedAddress;
    if (action === "memo_send") {
      workingIntent.tokenOut = recipient.resolvedAddress;
    }
    recipients.push(recipient);
  }
  if (action === "atomic_payout") {
    if (!workingIntent.transfers?.length) {
      throw new EntityResolutionError(
        "ATOMIC_PAYOUT_RECIPIENTS_REQUIRED",
        "At least one address+amount pair is required for atomic payout.",
      );
    }
    const resolvedTransfers = [];
    const uniqueRecipients = new Set<string>();
    for (const [transferIndex, transfer] of workingIntent.transfers.entries()) {
      const rawRecipient = normalizeAssetReference(transfer.recipient);
      if (!isAddress(rawRecipient)) {
        throw new EntityResolutionError(
          "ATOMIC_PAYOUT_ADDRESS_REQUIRED",
          "Each recipient in atomic batch payout must be a full EVM address; Basename is not supported for batch payouts.",
        );
      }
      const recipient = await resolveRecipient(
        rawRecipient,
        network,
        now,
        basenameResolver,
      );
      const recipientKey = recipient.resolvedAddress.toLowerCase();
      if (uniqueRecipients.has(recipientKey)) {
        throw new EntityResolutionError(
          "ATOMIC_PAYOUT_DUPLICATE_RECIPIENT",
          "The same resolved recipient cannot be used multiple times in atomic payout.",
        );
      }
      uniqueRecipients.add(recipientKey);
      recipients.push({ ...recipient, transferIndex });
      resolvedTransfers.push({
        ...transfer,
        recipient: recipient.resolvedAddress,
      });
    }
    workingIntent.transfers = resolvedTransfers;
  }

  const allWarnings = [
    ...assets.flatMap(({ warnings }) => warnings),
    ...recipients.flatMap(({ warning }) => (warning ? [warning] : [])),
  ];
  return {
    status: "resolved",
    intent: workingIntent,
    evidence: {
      policyVersion: "kletia_entity_resolution_v1",
      requestId: context.requestId,
      network,
      chainId: NETWORKS[network].chainId,
      userAddress: user,
      action,
      decision: "eligible",
      observedAt,
      assets,
      recipients,
      protocol,
      warnings: [...new Set(allWarnings)],
      scorePolicy: "informational_only_hard_gates_take_precedence",
    },
  };
}

export const assetResolverInternals = {
  verifyBaseErc20,
  assertActionCompatibility,
  fieldRequirements,
  resolveProtocol,

  baseStakingManifest: BASE_STAKING_CONTRACTS,
  catalog: ASSET_CATALOG,
};
