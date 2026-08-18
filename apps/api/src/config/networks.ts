import * as dotenv from "dotenv";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { arbitrum, arcTestnet, base } from "viem/chains";
import {
  ARBITRUM_CONTRACTS,
  ARBITRUM_TOKENS,
} from "../networks/arbitrum/contracts.js";
import { ROUTERS, TOKENS } from "../networks/base/contracts.js";
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  BASE_STAKING_CONTRACTS,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
} from "../networks/base/protocols.js";
import { configuredBaseIntentV2AddressManifest } from "../networks/base/config/intentRouterV2Environment.js";
import { configuredBaseTokenDeploymentTarget } from "../networks/base/config/launchFactoryV2Environment.js";

dotenv.config();

export type NetworkId = "base" | "arc" | "arbitrum";

export const ARC_NATIVE_USDC_ADDRESS = getAddress(
  "0x3600000000000000000000000000000000000000",
);

export const ARC_LEGACY_VAULT_ADDRESS = getAddress(
  "0xe2810DB53998f8A51bBf5Bf94c21208b174da174",
);
export type ArcVaultExecutionMode = "legacy_v1" | "vault_v2";
const configuredArcVaultMode =
  process.env.ARC_VAULT_EXECUTION_MODE?.trim() || "legacy_v1";
if (
  configuredArcVaultMode !== "legacy_v1" &&
  configuredArcVaultMode !== "vault_v2"
) {
  throw new Error(
    "ARC_VAULT_EXECUTION_MODE must be exactly legacy_v1 or vault_v2.",
  );
}
export const ARC_VAULT_EXECUTION_MODE =
  configuredArcVaultMode as ArcVaultExecutionMode;
const configuredArcVaultV2Address =
  process.env.ARC_VAULT_V2_ADDRESS?.trim();
const configuredArcVaultV2RuntimeCodehash =
  process.env.ARC_VAULT_V2_RUNTIME_CODEHASH?.trim().toLowerCase();
if (
  ARC_VAULT_EXECUTION_MODE === "vault_v2" &&
  (!configuredArcVaultV2Address ||
    !configuredArcVaultV2RuntimeCodehash ||
    !/^0x[0-9a-f]{64}$/.test(configuredArcVaultV2RuntimeCodehash))
) {
  throw new Error(
    "ARC_VAULT_V2_ADDRESS and ARC_VAULT_V2_RUNTIME_CODEHASH are required for vault_v2.",
  );
}
if (
  ARC_VAULT_EXECUTION_MODE === "vault_v2" &&
  getAddress(configuredArcVaultV2Address!) === ARC_LEGACY_VAULT_ADDRESS
) {
  throw new Error("ARC_VAULT_V2_ADDRESS cannot be the legacy Vault address.");
}
export const ARC_VAULT_V2_RUNTIME_CODEHASH =
  ARC_VAULT_EXECUTION_MODE === "vault_v2"
    ? configuredArcVaultV2RuntimeCodehash!
    : null;
const activeArcVaultAddress =
  ARC_VAULT_EXECUTION_MODE === "vault_v2"
    ? getAddress(configuredArcVaultV2Address!)
    : ARC_LEGACY_VAULT_ADDRESS;

export interface NativeAssetConfig {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface NetworkConfig {
  readonly id: NetworkId;
  readonly chainId: 8453 | 5042002 | 42161;
  readonly displayName: string;
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly nativeAsset: NativeAssetConfig;
  readonly tokens: readonly string[];
  readonly widgets: readonly string[];
  readonly intentActions: readonly string[];
  readonly beta?: boolean;
  readonly enabled: boolean;
}

export const ARC_CONTRACTS = {
  Swap: getAddress("0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8"),
  Lending: getAddress("0x2748a478Ec0f6D90FfdE89b27721f469126835F7"),
  Token: getAddress("0xAe77D247c26258397653a020995E957Bc88E039A"),
  BatchPay: getAddress("0x09B6d2987EcAF021533A2727d2967696595Fa6dd"),
  Vault: activeArcVaultAddress,
  MemoTransfer: getAddress("0x1633f12f31195B34feE6eDC250e1D543DAB72698"),
  AgentRegistry: getAddress("0xDEb07309c1689fEeCa44ac70939ce0297d511596"),
  Staking: getAddress("0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07"),
} as const;

const cdpNodeKey = process.env.CDP_NODE_API_KEY;
const configuredBaseRpcUrl = process.env.BASE_RPC_URL?.trim();
if (
  process.env.NODE_ENV === "production" &&
  !configuredBaseRpcUrl &&
  !cdpNodeKey
) {
  throw new Error(
    "BASE_RPC_URL or CDP_NODE_API_KEY is required in production; the public Base RPC is rate-limited.",
  );
}
const baseRpcUrl =
  configuredBaseRpcUrl ||
  (cdpNodeKey
    ? `https://api.developer.coinbase.com/rpc/v1/base/${cdpNodeKey}`
    : "https://mainnet.base.org");

const arcRpcUrl = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const configuredArbitrumRpcUrl = process.env.ARBITRUM_RPC_URL?.trim();
export const ARBITRUM_MVP_ENABLED =
  process.env.ARBITRUM_MVP_ENABLED?.trim() === "true" ||
  (process.env.NODE_ENV !== "production" &&
    process.env.ARBITRUM_MVP_ENABLED?.trim() !== "false");
if (
  process.env.NODE_ENV === "production" &&
  ARBITRUM_MVP_ENABLED &&
  !configuredArbitrumRpcUrl
) {
  throw new Error(
    "ARBITRUM_RPC_URL is required when the Arbitrum Mainnet beta is enabled in production.",
  );
}
const arbitrumRpcUrl =
  configuredArbitrumRpcUrl || "https://arb1.arbitrum.io/rpc";

const BASE_ACTIONS = [
  "chat",
  "allora_prediction",
  "portfolio",
  "open_widget",
  "swap",
  "add_liquidity",
  "remove_liquidity",
  "stake",
  "liquid_stake",
  "liquid_unstake",
  "borrow",
  "lend",
  "repay",
  "withdraw",
  "yield_compare",
  "bridge",
  "basename_register",
  "basename_renew",
  "deploy_token",
  "agent_action",
  "x402_discover",
  "x402_request",
  "workflow",
  "policy_agent",
] as const;

const ARC_ACTIONS = [
  "chat",
  "portfolio",
  "open_widget",
  "swap",
  "stake",
  "unstake",
  "claim_rewards",
  "claim_unstaked",
  "vault_deposit",
  "vault_withdraw",
  "vault_legacy_withdraw",
  "lending_deposit",
  "lending_withdraw",
  "lending_borrow",
  "lending_repay",
  "memo_send",
  "official_memo_send",
  "atomic_payout",
  "stable_swap",
  "appkit_send",
  "appkit_bridge",
  "add_liquidity",
  "remove_liquidity",
] as const;

const ARBITRUM_ACTIONS = [
  "chat",
  "portfolio",
  "open_widget",
  "transfer",
  "swap",
  "lend",
  "withdraw",
  "borrow",
  "repay",
  "yield_compare",
  "policy_agent",
] as const;

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  base: {
    id: "base",
    chainId: 8453,
    displayName: "Base Mainnet",
    chain: base,
    rpcUrl: baseRpcUrl,
    explorerUrl: "https://basescan.org",
    nativeAsset: { name: "Ether", symbol: "ETH", decimals: 18 },
    tokens: Object.freeze(Object.keys(TOKENS)),
    widgets: Object.freeze(["webacy", "allora", "airdrop", "x402", "basename"]),
    intentActions: BASE_ACTIONS,
    enabled: true,
  },
  arc: {
    id: "arc",
    chainId: 5042002,
    displayName: "Arc Testnet",
    chain: arcTestnet,
    rpcUrl: arcRpcUrl,
    explorerUrl: "https://testnet.arcscan.app",
    nativeAsset: { name: "USDC", symbol: "USDC", decimals: 18 },
    tokens: Object.freeze(["USDC", "EURC", "cirBTC", "KLET"]),
    widgets: Object.freeze([
      "arc",
      "swap",
      "vault",
      "memo",
      "batch",
      "staking",
      "liquidity",
      "lending",
    ]),
    intentActions: ARC_ACTIONS,
    enabled: true,
  },
  arbitrum: {
    id: "arbitrum",
    chainId: 42161,
    displayName: "Arbitrum One",
    chain: arbitrum,
    rpcUrl: arbitrumRpcUrl,
    explorerUrl: "https://arbiscan.io",
    nativeAsset: { name: "Ether", symbol: "ETH", decimals: 18 },
    tokens: Object.freeze(["ETH", "WETH", "USDC", "ARB"]),
    widgets: Object.freeze(["arbitrum", "swap", "lending"]),
    intentActions: ARBITRUM_ACTIONS,
    beta: true,
    enabled: ARBITRUM_MVP_ENABLED,
  },
};

export const basePublicClient = createPublicClient({
  chain: base,
  transport: http(baseRpcUrl),
  batch: { multicall: true },
});

export const arcPublicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(arcRpcUrl),
  batch: { multicall: true },
});

export const arbitrumPublicClient = createPublicClient({
  chain: arbitrum,
  transport: http(arbitrumRpcUrl),
  batch: { multicall: true },
});

export const NETWORK_CLIENTS: Record<NetworkId, PublicClient> = {
  base: basePublicClient as PublicClient,
  arc: arcPublicClient as PublicClient,
  arbitrum: arbitrumPublicClient as PublicClient,
};

const NETWORK_ALIASES: Record<string, NetworkId> = {
  base: "base",
  "base-mainnet": "base",
  base_mainnet: "base",
  "eip155:8453": "base",
  "8453": "base",
  arc: "arc",
  "arc-testnet": "arc",
  arc_testnet: "arc",
  "eip155:5042002": "arc",
  "5042002": "arc",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  "arbitrum-one": "arbitrum",
  arbitrum_one: "arbitrum",
  "eip155:42161": "arbitrum",
  "42161": "arbitrum",
};

export class NetworkValidationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "NetworkValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function normalizeNetworkId(input: unknown): NetworkId | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  return NETWORK_ALIASES[String(input).trim().toLowerCase()] || null;
}

export function parseChainId(input: unknown): number | null {
  if (typeof input === "number" && Number.isSafeInteger(input)) return input;
  if (typeof input === "string" && /^\d+$/.test(input.trim())) {
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function resolveNetworkRequest(
  networkInput: unknown,
  chainIdInput: unknown,
  options: { required?: boolean; defaultNetwork?: NetworkId } = {},
): NetworkConfig {
  let network = normalizeNetworkId(networkInput);
  let chainId = parseChainId(chainIdInput);

  if (!network && options.defaultNetwork) network = options.defaultNetwork;
  if (chainId === null && network && options.defaultNetwork) {
    chainId = NETWORKS[network].chainId;
  }

  if (!network) {
    throw new NetworkValidationError(
      "NETWORK_REQUIRED",
      "The network field is required. Supported values: base, arc, arbitrum.",
    );
  }
  if (chainId === null) {
    throw new NetworkValidationError(
      "CHAIN_ID_REQUIRED",
      "The chainId field is required.",
    );
  }

  const config = NETWORKS[network];
  if (chainId !== config.chainId) {
    throw new NetworkValidationError(
      "NETWORK_CHAIN_MISMATCH",
      `The ${network} network requires chainId ${config.chainId}; ${chainId} was not accepted.`,
    );
  }
  if (!config.enabled) {
    throw new NetworkValidationError(
      "NETWORK_DISABLED",
      `${config.displayName} beta is not enabled on this deployment.`,
      503,
    );
  }
  return config;
}

const targetSet = (...addresses: string[]) =>
  new Set(addresses.map((address) => address.toLowerCase()));

const KLETIA_ROUTER = "0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf";
const BASE_INTENT_V2_ADDRESS_MANIFEST = configuredBaseIntentV2AddressManifest(
  process.env,
);
export const ACROSS_SPOKE_POOL = "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64";
export const BASE_CONTRACTS = Object.freeze({
  basenameRegistrarController: getAddress(
    "0xa7d2607c6BD39Ae9521e514026CBB078405Ab322",
  ),
  basenameL2Resolver: getAddress("0x426fA03fB86E510d0Dd9F70335Cf102a98b10875"),
  x402Factory: getAddress("0xD6e7bAc04a9969f75AEA3f17b5b82db1C988DD46"),
});
const BASE_SWAP_TARGETS = targetSet(
  ROUTERS.AERO_V1,
  ROUTERS.AERO_SLIPSTREAM,
  ROUTERS.UNI_V3,
  ROUTERS.UNI_V2,
  ROUTERS.ALIEN_BASE,
  ROUTERS.PANCAKE_V2,
  ROUTERS.SUSHI_V2,
  ROUTERS.PANCAKE_SMART_ROUTER,
  ROUTERS.BASESWAP,
  ROUTERS.SWAPBASED,
  TOKENS.WETH,
  KLETIA_ROUTER,
  ...(BASE_INTENT_V2_ADDRESS_MANIFEST
    ? [BASE_INTENT_V2_ADDRESS_MANIFEST.router]
    : []),
);
const BASE_LIQUIDITY_TARGETS = targetSet(
  ROUTERS.AERO_V1,
  ROUTERS.UNI_V2,
  ROUTERS.ALIEN_BASE,
  ROUTERS.PANCAKE_V2,
  ROUTERS.SUSHI_V2,
  ROUTERS.BASESWAP,
  ROUTERS.SWAPBASED,
);
const BASE_CORE_LENDING_TARGETS = targetSet(
  AAVE_V3_BASE.pool,
  ...MOONWELL_BASE.markets.map(({ market }) => market),
  ...COMPOUND_V3_BASE.markets.map(({ comet }) => comet),
);
const BASE_YIELD_VAULT_TARGETS = targetSet(
  ...BASE_ERC4626_VAULTS.map(({ vault }) => vault),
);
const BASE_SUPPLY_WITHDRAW_TARGETS = targetSet(
  ...BASE_CORE_LENDING_TARGETS,
  ...BASE_YIELD_VAULT_TARGETS,
);
const BASE_ACTION_TARGETS: Readonly<Record<string, ReadonlySet<string>>> = {
  swap: BASE_SWAP_TARGETS,
  liquid_stake: BASE_SWAP_TARGETS,
  liquid_unstake: BASE_SWAP_TARGETS,
  add_liquidity: BASE_LIQUIDITY_TARGETS,
  remove_liquidity: BASE_LIQUIDITY_TARGETS,

  lend: BASE_SUPPLY_WITHDRAW_TARGETS,
  borrow: BASE_CORE_LENDING_TARGETS,
  repay: BASE_CORE_LENDING_TARGETS,
  withdraw: BASE_SUPPLY_WITHDRAW_TARGETS,
  stake: targetSet(
    BASE_STAKING_CONTRACTS.veAero,
    BASE_STAKING_CONTRACTS.stkWell,
    BASE_STAKING_CONTRACTS.stkSeam,
  ),
  bridge: targetSet(ACROSS_SPOKE_POOL, KLETIA_ROUTER),
  workflow: targetSet(ACROSS_SPOKE_POOL),
  basename_register: targetSet(BASE_CONTRACTS.basenameRegistrarController),
  basename_renew: targetSet(BASE_CONTRACTS.basenameRegistrarController),
  x402_factory_create: targetSet(BASE_CONTRACTS.x402Factory),
};
const BASE_STATIC_TARGETS = new Set(
  [
    ...Object.values(BASE_ACTION_TARGETS).flatMap((targets) => [...targets]),
    ...(BASE_INTENT_V2_ADDRESS_MANIFEST?.policyDependencies || []),
  ].map((address) => address.toLowerCase()),
);

const ARC_OFFICIAL_MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const ARC_OFFICIAL_MULTICALL3_FROM =
  "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
const ARC_ACTION_TARGETS: Readonly<Record<string, ReadonlySet<string>>> = {
  swap: targetSet(ARC_CONTRACTS.Swap),
  add_liquidity: targetSet(ARC_CONTRACTS.Swap),
  remove_liquidity: targetSet(ARC_CONTRACTS.Swap),
  stake: targetSet(ARC_CONTRACTS.Staking),
  unstake: targetSet(ARC_CONTRACTS.Staking),
  claim_rewards: targetSet(ARC_CONTRACTS.Staking),
  claim_unstaked: targetSet(ARC_CONTRACTS.Staking),
  vault_deposit: targetSet(ARC_CONTRACTS.Vault),
  vault_withdraw: targetSet(ARC_CONTRACTS.Vault),
  vault_legacy_withdraw: targetSet(ARC_LEGACY_VAULT_ADDRESS),
  lending_deposit: targetSet(ARC_CONTRACTS.Lending),
  lending_withdraw: targetSet(ARC_CONTRACTS.Lending),
  lending_borrow: targetSet(ARC_CONTRACTS.Lending),
  lending_repay: targetSet(ARC_CONTRACTS.Lending),
  memo_send: targetSet(ARC_CONTRACTS.MemoTransfer),
  official_memo_send: targetSet(ARC_OFFICIAL_MEMO),
  arc_official_memo_payment: targetSet(ARC_OFFICIAL_MEMO),
  atomic_payout: targetSet(ARC_OFFICIAL_MULTICALL3_FROM),
  arc_atomic_usdc_payout: targetSet(ARC_OFFICIAL_MULTICALL3_FROM),
};
const ARC_STATIC_TARGETS = new Set(
  [
    ...Object.values(ARC_CONTRACTS),
    ...(ARC_VAULT_EXECUTION_MODE === "vault_v2"
      ? [ARC_LEGACY_VAULT_ADDRESS]
      : []),
    ARC_NATIVE_USDC_ADDRESS,
    ARC_OFFICIAL_MEMO,
    ARC_OFFICIAL_MULTICALL3_FROM,
  ].map((address) => address.toLowerCase()),
);

const ARBITRUM_ACTION_TARGETS: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  swap: targetSet(ARBITRUM_CONTRACTS.uniswapV3SwapRouter),
  lend: targetSet(ARBITRUM_CONTRACTS.aaveV3Pool),
  withdraw: targetSet(ARBITRUM_CONTRACTS.aaveV3Pool),
  borrow: targetSet(ARBITRUM_CONTRACTS.aaveV3Pool),
  repay: targetSet(ARBITRUM_CONTRACTS.aaveV3Pool),
  bridge: targetSet(ARBITRUM_CONTRACTS.acrossSpokePool),
  transfer: targetSet(
    ARBITRUM_TOKENS.USDC.address,
    ARBITRUM_TOKENS.WETH.address,
    ARBITRUM_TOKENS.ARB.address,
  ),
};
const ARBITRUM_STATIC_TARGETS = targetSet(
  ...Object.values(ARBITRUM_CONTRACTS),
  ARBITRUM_TOKENS.USDC.address,
  ARBITRUM_TOKENS.WETH.address,
  ARBITRUM_TOKENS.ARB.address,
);

export function isNetworkTargetAllowed(
  network: NetworkId,
  target: string,
  action?: string,
): boolean {
  let normalized: Address;
  try {
    normalized = getAddress(target);
  } catch {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (network === "arbitrum") {
    if (action?.trim().toLowerCase() === "transfer") return true;
    if (!action) return ARBITRUM_STATIC_TARGETS.has(lower);
    const actionTargets =
      ARBITRUM_ACTION_TARGETS[action.trim().toLowerCase()];
    return actionTargets?.has(lower) === true;
  }
  if (network === "arc") {
    if (!action) return ARC_STATIC_TARGETS.has(lower);
    const actionTargets = ARC_ACTION_TARGETS[action.trim().toLowerCase()];
    return actionTargets?.has(lower) === true;
  }

  if (ARC_STATIC_TARGETS.has(lower)) return false;
  const normalizedAction = action?.trim().toLowerCase();
  if (normalizedAction === "deploy_token") {
    const selectedFactory = configuredBaseTokenDeploymentTarget(process.env);
    return selectedFactory !== null && selectedFactory.toLowerCase() === lower;
  }
  if (!action) {
    const selectedFactory = configuredBaseTokenDeploymentTarget(process.env);
    if (selectedFactory?.toLowerCase() === lower) return true;
  }
  if (!action) return BASE_STATIC_TARGETS.has(lower);
  const actionTargets = BASE_ACTION_TARGETS[normalizedAction!];
  if (actionTargets?.has(lower)) return true;

  return false;
}

export function isNetworkPolicyTargetAllowed(
  network: NetworkId,
  target: string,
): boolean {
  let normalized: Address;
  try {
    normalized = getAddress(target);
  } catch {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (network === "arbitrum") return ARBITRUM_STATIC_TARGETS.has(lower);
  if (network === "arc") return ARC_STATIC_TARGETS.has(lower);
  if (ARC_STATIC_TARGETS.has(lower)) return false;
  const selectedFactory = configuredBaseTokenDeploymentTarget(process.env);
  if (selectedFactory?.toLowerCase() === lower) return true;
  return BASE_STATIC_TARGETS.has(lower);
}

export function getPublicNetworkDescriptor(config: NetworkConfig) {
  return {
    id: config.id,
    chainId: config.chainId,
    name: config.displayName,
    nativeAsset: config.nativeAsset,

    rpcUrl:
      config.id === "base"
        ? "https://mainnet.base.org"
        : config.id === "arc"
          ? "https://rpc.testnet.arc.network"
          : "https://arb1.arbitrum.io/rpc",
    explorerUrl: config.explorerUrl,
    tokens: config.tokens,
    widgets: config.widgets,
    intentActions: config.intentActions,
    contracts: config.id === "arc" ? ARC_CONTRACTS : undefined,
    nativeTokenAddress:
      config.id === "arc" ? ARC_NATIVE_USDC_ADDRESS : undefined,
    beta: config.beta === true,
    enabled: config.enabled,
  };
}
