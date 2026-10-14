import { defineChain, type Address, type Chain } from "viem";
import { arbitrum, arbitrumSepolia, base, mainnet, optimism, polygon } from "viem/chains";
import { ARC_CONTRACTS } from "../../networks/arc/config";

/** Wallet-switchable EVM networks of the console. */
export type NetworkMode = "base" | "arc" | "arbitrum";

export interface NetworkDefinition {
  readonly key: NetworkMode;
  readonly name: string;
  readonly shortName: string;
  readonly chainId: number;
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly explorer: {
    readonly name: string;
    readonly url: string;
  };
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly displayDecimals: number;
  };
  readonly tokens: {
    readonly usdc: {
      readonly address: Address;
      readonly decimals: number;
      readonly isNative: boolean;
    };
    readonly klet?: {
      readonly address: Address;
      readonly decimals: number;
    };
  };
  readonly usdc: Address;
  readonly klet?: Address;
  readonly contracts: Partial<Record<keyof typeof ARC_CONTRACTS, Address>>;
  readonly color: string;
  readonly isTestnet: boolean;
  readonly beta?: boolean;
  readonly enabled: boolean;
  readonly apiPrefix: string;
}

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
});

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;
export const BASE_CONTRACTS = {
  basenameRegistrarController: "0xa7d2607c6BD39Ae9521e514026CBB078405Ab322",
  basenameL2Resolver: "0x426fA03fB86E510d0Dd9F70335Cf102a98b10875",
} as const satisfies Record<string, Address>;
export const OFFICIAL_BASE_PUBLIC_RPC_URL = "https://mainnet.base.org";
const configuredBaseRpcUrl = import.meta.env.VITE_BASE_RPC_URL?.trim();
const BASE_RPC_URL = configuredBaseRpcUrl || OFFICIAL_BASE_PUBLIC_RPC_URL;
export const ALLOW_PUBLIC_BASE_RPC_FALLBACK =
  import.meta.env.DEV ||
  import.meta.env.VITE_ALLOW_PUBLIC_BASE_RPC_FALLBACK === "true";
const ARC_RPC_URL =
  import.meta.env.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network";
const ARBITRUM_RPC_URL =
  import.meta.env.VITE_ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
export const ARBITRUM_SEPOLIA_RPC_URL =
  import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC_URL ||
  "https://sepolia-rollup.arbitrum.io/rpc";
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

export const NETWORKS = {
  base: {
    key: "base",
    name: "Base Mainnet",
    shortName: "Base",
    chainId: base.id,
    chain: base,
    rpcUrl: BASE_RPC_URL,
    explorer: {
      name: "BaseScan",
      url: "https://basescan.org",
    },
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
      displayDecimals: 18,
    },
    tokens: {
      usdc: {
        address: BASE_USDC,
        decimals: 6,
        isNative: false,
      },
    },
    usdc: BASE_USDC,
    contracts: {},
    color: "#0052FF",
    isTestnet: false,
    enabled: true,
    apiPrefix: "/api",
  },
  arc: {
    key: "arc",
    name: "Arc Testnet",
    shortName: "Arc",
    chainId: arcTestnet.id,
    chain: arcTestnet,
    rpcUrl: ARC_RPC_URL,
    explorer: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
    nativeCurrency: {
      name: "USDC",
      symbol: "USDC",
      decimals: 18,
      displayDecimals: 6,
    },
    tokens: {
      usdc: {
        address: ARC_USDC,
        decimals: 6,
        isNative: true,
      },
      klet: {
        address: ARC_CONTRACTS.Token,
        decimals: 18,
      },
    },
    usdc: ARC_USDC,
    klet: ARC_CONTRACTS.Token,
    contracts: ARC_CONTRACTS,
    color: "#8B5CF6",
    isTestnet: true,
    enabled: true,
    apiPrefix: "/api/arc",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    shortName: "Arbitrum",
    chainId: arbitrum.id,
    chain: arbitrum,
    rpcUrl: ARBITRUM_RPC_URL,
    explorer: { name: "Arbiscan", url: "https://arbiscan.io" },
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
      displayDecimals: 18,
    },
    tokens: {
      usdc: { address: ARBITRUM_USDC, decimals: 6, isNative: false },
    },
    usdc: ARBITRUM_USDC,
    contracts: {},
    color: "#28A0F0",
    beta: true,
    enabled:
      import.meta.env.VITE_ARBITRUM_MVP_ENABLED === "true" ||
      (import.meta.env.DEV && import.meta.env.VITE_ARBITRUM_MVP_ENABLED !== "false"),
    isTestnet: false,
    apiPrefix: "/api",
  },
} as const satisfies Record<NetworkMode, NetworkDefinition>;

/**
 * Keyless public RPCs for the intent-only EVM networks, each verified to
 * answer `eth_chainId` with the right id and to accept browser (CORS) calls.
 * polygon-rpc.com is not used: it now requires a key.
 */
const INTENT_NETWORK_PUBLIC_RPCS = {
  [mainnet.id]: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.drpc.org",
    "https://cloudflare-eth.com",
  ],
  [optimism.id]: [
    "https://mainnet.optimism.io",
    "https://optimism-rpc.publicnode.com",
    "https://optimism.drpc.org",
  ],
  [polygon.id]: [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
  ],
} as const satisfies Record<number, readonly [string, ...string[]]>;

/**
 * The chain as the wallet should see it: the default RPCs are the public
 * list, so a wallet that does not know the network yet is offered a public
 * endpoint by `wallet_addEthereumChain` (never a configured, possibly keyed,
 * one).
 */
function withPublicRpcs<T extends Chain>(chain: T, urls: readonly [string, ...string[]]): T {
  return { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: urls } } } as T;
}

const configuredRpcUrl = (value: string | undefined) => value?.trim() || undefined;

export interface IntentWalletNetwork<T extends Chain = Chain> {
  readonly chain: T;
  /** Endpoints for the wallet transport: the configured RPC (if any), then the public list. */
  readonly rpcUrls: readonly [string, ...string[]];
}

function intentWalletNetwork<T extends Chain>(
  chain: T,
  publicRpcs: readonly [string, ...string[]],
  configured: string | undefined,
): IntentWalletNetwork<T> {
  const configuredUrl = configuredRpcUrl(configured);
  return {
    chain: withPublicRpcs(chain, publicRpcs),
    rpcUrls: configuredUrl
      ? [configuredUrl, ...publicRpcs.filter((url) => url !== configuredUrl)]
      : publicRpcs,
  };
}

/**
 * EVM networks that Intent Studio and /embed execute Platform API v1 plans on
 * but that are not console workspaces (so they have no NetworkDefinition).
 * The wallet is switched to them per step; every step is still bound to its
 * own chain id before signing (see `transactionBindingProblem`).
 */
export const INTENT_WALLET_NETWORKS = {
  ethereum: intentWalletNetwork(
    mainnet,
    INTENT_NETWORK_PUBLIC_RPCS[mainnet.id],
    import.meta.env.VITE_ETHEREUM_RPC_URL,
  ),
  optimism: intentWalletNetwork(
    optimism,
    INTENT_NETWORK_PUBLIC_RPCS[optimism.id],
    import.meta.env.VITE_OPTIMISM_RPC_URL,
  ),
  polygon: intentWalletNetwork(
    polygon,
    INTENT_NETWORK_PUBLIC_RPCS[polygon.id],
    import.meta.env.VITE_POLYGON_RPC_URL,
  ),
} as const;

/**
 * Every chain the EVM wallet may be on or be switched to. Base stays first
 * (RainbowKit's initial chain); the console workspaces follow, then the
 * intent-only networks.
 */
export const SUPPORTED_CHAINS = [
  NETWORKS.base.chain,
  NETWORKS.arc.chain,
  NETWORKS.arbitrum.chain,
  arbitrumSepolia,
  INTENT_WALLET_NETWORKS.ethereum.chain,
  INTENT_WALLET_NETWORKS.optimism.chain,
  INTENT_WALLET_NETWORKS.polygon.chain,
] as const;

export const getNetwork = (mode: NetworkMode): NetworkDefinition =>
  NETWORKS[mode];

export const getNetworkByChainId = (
  chainId: number,
): NetworkDefinition | undefined =>
  Object.values(NETWORKS).find((network) => network.chainId === chainId);

export const isNetworkMode = (value: unknown): value is NetworkMode =>
  value === "base" || value === "arc" || value === "arbitrum";

export const getApiPrefix = (mode: NetworkMode): string =>
  NETWORKS[mode].apiPrefix;
