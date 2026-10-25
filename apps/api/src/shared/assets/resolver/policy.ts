/**
 * Per-network asset field policy, trust labels and action compatibility.
 */
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
} from "../../../networks/base/protocols.js";
import { NETWORKS, type NetworkId } from "../../config/networks.js";
import type { AssetTrustTier } from "../catalog.js";
import {
  type AssetField,
  EntityResolutionError,
  type ResolvableAsset,
  type ResolvedAssetEvidence,
  type VerifiedPortfolioAsset,
} from "./types.js";

const BASE_DYNAMIC_ASSET_ACTIONS = new Set([
  "swap",
  "add_liquidity",
  "remove_liquidity",
]);

export const BASE_SWAP_PROTOCOLS = new Set([
  "aerodrome",
  "uniswap",
  "pancakeswap",
  "sushiswap",
  "alienbase",
  "baseswap",
  "swapbased",
]);

export const BASE_LENDING_PROTOCOLS = new Set([
  "aave-v3",
  "moonwell",
  "compound-v3",
  "moonwell-vault",
  "seamless-vault",
  "spark-vault",
  "fluid-vault",
]);

export const BASE_STAKING_PROTOCOLS = new Set([
  "aerodrome",
  "moonwell-safety-module",
  "seamless-staking",
]);
export const BASE_BRIDGE_PROTOCOLS = new Set(["across"]);

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

export const FIXED_ARC_FIELDS: Readonly<
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

export function assetFieldPolicy(
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

export function trustScore(
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

export function trustLabel(tier: AssetTrustTier): ResolvedAssetEvidence["trustLabel"] {
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

export function executionDecimals(
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

export function assertActionCompatibility(
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
