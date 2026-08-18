import { defineChain, type Address, type Chain } from "viem";
import { base } from "viem/chains";
import { ARC_CONTRACTS } from "../networks/arc/config";
import { ACTIVE_WALLET_ADDRESS } from "./intentExamples";
import { BASE_PAYMASTER_ENABLED } from "./runtime";

export type NetworkMode = "base" | "arc";

export type AppTab =
  | "chat"
  | "basename"
  | "allora"
  | "airdrop"
  | "x402"
  | "webacy"
  | "arc"
  | "lending";

export type NetworkFeature =
  | "baseMcpHandoff"
  | "paymaster"
  | "basename"
  | "allora"
  | "airdrop"
  | "x402"
  | "webacy"
  | "arcDashboard"
  | "arcLending"
  | "arcContracts";

export type NavigationIcon =
  | "chat"
  | "shield"
  | "allora"
  | "basename"
  | "airdrop"
  | "x402"
  | "dashboard"
  | "lending"
  | "swap"
  | "vault"
  | "staking"
  | "batch"
  | "memo"
  | "liquidity";

export type NavigationAction =
  | { readonly type: "tab"; readonly tab: AppTab }
  | { readonly type: "prompt"; readonly prompt: string };

export interface NetworkNavigationItem {
  readonly id: string;
  readonly label: string;
  readonly icon: NavigationIcon;
  readonly feature?: NetworkFeature;
  readonly action: NavigationAction;
}

export interface NetworkNavigationSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NetworkNavigationItem[];
}

export interface NetworkFeatures {
  readonly baseMcpHandoff: boolean;
  readonly paymaster: boolean;
  readonly basename: boolean;
  readonly allora: boolean;
  readonly airdrop: boolean;
  readonly x402: boolean;
  readonly webacy: boolean;
  readonly arcDashboard: boolean;
  readonly arcLending: boolean;
  readonly arcContracts: boolean;
}

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
  readonly features: NetworkFeatures;
  readonly funding: {
    readonly kind: "onramp" | "faucet";
    readonly label: string;
    readonly url: string;
  };
  readonly color: string;
  readonly icon: string;
  readonly badge: string;
  readonly isTestnet: boolean;
  readonly apiPrefix: string;
  readonly navigation: readonly NetworkNavigationSection[];
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
    features: {
      baseMcpHandoff: true,
      paymaster: BASE_PAYMASTER_ENABLED,
      basename: true,
      allora: true,
      airdrop: true,
      x402: true,
      webacy: true,
      arcDashboard: false,
      arcLending: false,
      arcContracts: false,
    },
    funding: {
      kind: "onramp",
      label: "Fund Wallet",
      url: "https://pay.coinbase.com",
    },
    color: "#0052FF",
    icon: "🔵",
    badge: "OMNI-ENGINE",
    isTestnet: false,
    apiPrefix: "/api",
    navigation: [
      {
        id: "command-center",
        label: "Command Center",
        items: [
          {
            id: "chat",
            label: "Omni-Engine",
            icon: "chat",
            action: { type: "tab", tab: "chat" },
          },
        ],
      },
      {
        id: "base-apps",
        label: "Base Apps",
        items: [
          {
            id: "webacy",
            label: "Webacy Security",
            icon: "shield",
            feature: "webacy",
            action: { type: "tab", tab: "webacy" },
          },
          {
            id: "allora",
            label: "Allora AI Hub",
            icon: "allora",
            feature: "allora",
            action: { type: "tab", tab: "allora" },
          },
          {
            id: "basename",
            label: "Basename Claim",
            icon: "basename",
            feature: "basename",
            action: { type: "tab", tab: "basename" },
          },
          {
            id: "airdrop",
            label: "Airdrop Simulator",
            icon: "airdrop",
            feature: "airdrop",
            action: { type: "tab", tab: "airdrop" },
          },
          {
            id: "x402",
            label: "x402 Console",
            icon: "x402",
            feature: "x402",
            action: { type: "tab", tab: "x402" },
          },
        ],
      },
      {
        id: "base-defi",
        label: "Intent DeFi",
        items: [
          {
            id: "base-best-yield",
            label: "Compare Live Yield",
            icon: "lending",
            action: {
              type: "prompt",
              prompt:
                "Compare best yield for USDC among Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
            },
          },
          {
            id: "base-lowest-borrow",
            label: "Compare Borrow Cost",
            icon: "vault",
            action: {
              type: "prompt",
              prompt:
                "Compare USDC borrow rates and available liquidity across Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
            },
          },
          {
            id: "base-smart-swap",
            label: "Scan Swap Routes",
            icon: "swap",
            action: {
              type: "prompt",
              prompt:
                "Buy AERO with 10 USDC on Base Mainnet using the most efficient verified route and show the expected output before execution",
            },
          },
          {
            id: "base-stake-well",
            label: "Stake WELL",
            icon: "staking",
            action: {
              type: "prompt",
              prompt:
                "Stake 100 WELL in the Moonwell Safety Module on Base Mainnet and show the expected stkWELL output and risks before execution",
            },
          },
        ],
      },
    ],
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
    features: {
      baseMcpHandoff: false,
      paymaster: false,
      basename: false,
      allora: false,
      airdrop: false,
      x402: false,
      webacy: false,
      arcDashboard: true,
      arcLending: true,
      arcContracts: true,
    },
    funding: {
      kind: "faucet",
      label: "USDC Faucet",
      url: "https://faucet.circle.com",
    },
    color: "#8B5CF6",
    icon: "🌀",
    badge: "BUILT ON ARC",
    isTestnet: true,
    apiPrefix: "/api/arc",
    navigation: [
      {
        id: "command-center",
        label: "Command Center",
        items: [
          {
            id: "chat",
            label: "Omni-Engine",
            icon: "chat",
            action: { type: "tab", tab: "chat" },
          },
          {
            id: "arc-dashboard",
            label: "Arc Dashboard",
            icon: "dashboard",
            feature: "arcDashboard",
            action: { type: "tab", tab: "arc" },
          },
          {
            id: "arc-lending",
            label: "Lending & Borrow",
            icon: "lending",
            feature: "arcLending",
            action: { type: "tab", tab: "lending" },
          },
        ],
      },
      {
        id: "arc-contracts",
        label: "Arc Contracts",
        items: [
          {
            id: "arc-swap",
            label: "Swap",
            icon: "swap",
            feature: "arcContracts",
            action: {
              type: "prompt",
              prompt:
                "Swap 1 native USDC to KLET on Arc Testnet using the live on-chain Kletia route; simulate it before wallet approval",
            },
          },
          {
            id: "arc-vault",
            label: "Vault",
            icon: "vault",
            feature: "arcContracts",
            action: {
              type: "prompt",
              prompt:
                "Deposit 1 native USDC into the Kletia Vault on Arc Testnet; prepare the time-locked vault route and simulate it before wallet approval",
            },
          },
          {
            id: "arc-staking",
            label: "Staking",
            icon: "staking",
            feature: "arcContracts",
            action: {
              type: "prompt",
              prompt:
                "Stake 1 native USDC in Kletia Staking on Arc Testnet; prepare the route and simulate it before wallet approval",
            },
          },
          {
            id: "arc-batch",
            label: "Batch Pay",
            icon: "batch",
            feature: "arcContracts",
            action: {
              type: "prompt",
              prompt:
                `Atomically pay 0.1 native USDC to ${ACTIVE_WALLET_ADDRESS} on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval`,
            },
          },
          {
            id: "arc-memo",
            label: "Memo Transfer",
            icon: "memo",
            feature: "arcContracts",
            action: {
              type: "prompt",
              prompt:
                `Send 0.1 native USDC to ${ACTIVE_WALLET_ADDRESS} through Kletia Memo Pay on Arc Testnet with the permanent public on-chain memo "KLETIA-DEMO-001"; simulate it before wallet approval`,
            },
          },
          {
            id: "arc-liquidity",
            label: "Liquidity Pool",
            icon: "liquidity",
            feature: "arcContracts",
            action: {
              type: "prompt",
              prompt:
                "Add 1 native USDC liquidity to the KLET/USDC pool on Arc Testnet and spend at most 10 KLET; calculate and show the live requirement and enforce that hard cap before wallet approval",
            },
          },
        ],
      },
    ],
  },
} as const satisfies Record<NetworkMode, NetworkDefinition>;

export const SUPPORTED_CHAINS = [
  NETWORKS.base.chain,
  NETWORKS.arc.chain,
] as const;

export const getNetwork = (mode: NetworkMode): NetworkDefinition =>
  NETWORKS[mode];

export const getNetworkByChainId = (
  chainId: number,
): NetworkDefinition | undefined =>
  Object.values(NETWORKS).find((network) => network.chainId === chainId);

export const isNetworkMode = (value: unknown): value is NetworkMode =>
  value === "base" || value === "arc";

export const getApiPrefix = (mode: NetworkMode): string =>
  NETWORKS[mode].apiPrefix;
