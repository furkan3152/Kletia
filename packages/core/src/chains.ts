/**
 * Chain registry.
 *
 * Every network Kletia can plan against is described once here and addressed
 * by its CAIP-2 identifier. Network modules, the public API, the SDK and the
 * web app all read from this table so a chain is never described twice.
 */

export type ChainNamespace = "eip155" | "solana";
export type VirtualMachine = "evm" | "svm";
export type CaipChainId = `${ChainNamespace}:${string}`;

export type NetworkKey =
  | "base"
  | "arbitrum"
  | "ethereum"
  | "optimism"
  | "polygon"
  | "arc"
  | "arbitrum-sepolia"
  | "solana"
  | "solana-devnet";

export type NetworkEnvironment = "mainnet" | "testnet";

/** Product lane the network belongs to. Production and testnet capital never mix. */
export type NetworkLane = "production" | "beta" | "testnet";

export interface NativeAssetDescriptor {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export interface ExplorerDescriptor {
  readonly name: string;
  /** Template containing `{hash}`. */
  readonly tx: string;
  /** Template containing `{address}`. */
  readonly address: string;
}

export interface ChainDescriptor {
  readonly key: NetworkKey;
  readonly id: CaipChainId;
  readonly namespace: ChainNamespace;
  readonly reference: string;
  readonly vm: VirtualMachine;
  readonly name: string;
  readonly shortName: string;
  readonly environment: NetworkEnvironment;
  readonly lane: NetworkLane;
  readonly nativeAsset: NativeAssetDescriptor;
  readonly explorer: ExplorerDescriptor;
  /** Brand colour used by first-party surfaces. */
  readonly color: string;
  /** Numeric EIP-155 chain id for EVM networks. */
  readonly evmChainId?: number;
  /** Chain identifier used by Wallet Standard wallets (e.g. `solana:mainnet`). */
  readonly walletChain?: string;
  /** Identifiers used by external settlement networks. */
  readonly settlement: {
    readonly cctpDomain?: number;
    readonly relayChainId?: number;
    readonly debridgeChainId?: number;
    readonly acrossChainId?: number;
    /** LI.FI chain id (`/v1/chains`); EVM networks use their EIP-155 id, Solana is 1151111081099710. */
    readonly lifiChainId?: number;
  };
  /** Mainnet/testnet counterpart, used to keep capital lanes separate. */
  readonly counterpart?: NetworkKey;
}

export const SOLANA_MAINNET_REFERENCE = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET_REFERENCE = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export const CHAINS: Readonly<Record<NetworkKey, ChainDescriptor>> = Object.freeze({
  base: {
    key: "base",
    id: "eip155:8453",
    namespace: "eip155",
    reference: "8453",
    vm: "evm",
    name: "Base",
    shortName: "Base",
    environment: "mainnet",
    lane: "production",
    nativeAsset: { symbol: "ETH", name: "Ether", decimals: 18 },
    explorer: {
      name: "BaseScan",
      tx: "https://basescan.org/tx/{hash}",
      address: "https://basescan.org/address/{address}",
    },
    color: "#0052FF",
    evmChainId: 8453,
    settlement: {
      cctpDomain: 6,
      relayChainId: 8453,
      debridgeChainId: 8453,
      acrossChainId: 8453,
      lifiChainId: 8453,
    },
  },
  arbitrum: {
    key: "arbitrum",
    id: "eip155:42161",
    namespace: "eip155",
    reference: "42161",
    vm: "evm",
    name: "Arbitrum One",
    shortName: "Arbitrum",
    environment: "mainnet",
    lane: "production",
    nativeAsset: { symbol: "ETH", name: "Ether", decimals: 18 },
    explorer: {
      name: "Arbiscan",
      tx: "https://arbiscan.io/tx/{hash}",
      address: "https://arbiscan.io/address/{address}",
    },
    color: "#28A0F0",
    evmChainId: 42161,
    settlement: {
      cctpDomain: 3,
      relayChainId: 42161,
      debridgeChainId: 42161,
      acrossChainId: 42161,
      lifiChainId: 42161,
    },
    counterpart: "arbitrum-sepolia",
  },
  ethereum: {
    key: "ethereum",
    id: "eip155:1",
    namespace: "eip155",
    reference: "1",
    vm: "evm",
    name: "Ethereum",
    shortName: "Ethereum",
    environment: "mainnet",
    lane: "production",
    nativeAsset: { symbol: "ETH", name: "Ether", decimals: 18 },
    explorer: {
      name: "Etherscan",
      tx: "https://etherscan.io/tx/{hash}",
      address: "https://etherscan.io/address/{address}",
    },
    color: "#627EEA",
    evmChainId: 1,
    settlement: {
      cctpDomain: 0,
      relayChainId: 1,
      debridgeChainId: 1,
      acrossChainId: 1,
      lifiChainId: 1,
    },
  },
  optimism: {
    key: "optimism",
    id: "eip155:10",
    namespace: "eip155",
    reference: "10",
    vm: "evm",
    name: "OP Mainnet",
    shortName: "Optimism",
    environment: "mainnet",
    lane: "production",
    nativeAsset: { symbol: "ETH", name: "Ether", decimals: 18 },
    explorer: {
      name: "Optimistic Etherscan",
      tx: "https://optimistic.etherscan.io/tx/{hash}",
      address: "https://optimistic.etherscan.io/address/{address}",
    },
    color: "#FF0420",
    evmChainId: 10,
    settlement: {
      cctpDomain: 2,
      relayChainId: 10,
      debridgeChainId: 10,
      acrossChainId: 10,
      lifiChainId: 10,
    },
  },
  polygon: {
    key: "polygon",
    id: "eip155:137",
    namespace: "eip155",
    reference: "137",
    vm: "evm",
    name: "Polygon PoS",
    shortName: "Polygon",
    environment: "mainnet",
    lane: "production",
    nativeAsset: { symbol: "POL", name: "Polygon Ecosystem Token", decimals: 18 },
    explorer: {
      name: "PolygonScan",
      tx: "https://polygonscan.com/tx/{hash}",
      address: "https://polygonscan.com/address/{address}",
    },
    color: "#8247E5",
    evmChainId: 137,
    settlement: {
      cctpDomain: 7,
      relayChainId: 137,
      debridgeChainId: 137,
      acrossChainId: 137,
      lifiChainId: 137,
    },
  },
  arc: {
    key: "arc",
    id: "eip155:5042002",
    namespace: "eip155",
    reference: "5042002",
    vm: "evm",
    name: "Arc Testnet",
    shortName: "Arc",
    environment: "testnet",
    lane: "testnet",
    nativeAsset: { symbol: "USDC", name: "USD Coin", decimals: 18 },
    explorer: {
      name: "ArcScan",
      tx: "https://testnet.arcscan.app/tx/{hash}",
      address: "https://testnet.arcscan.app/address/{address}",
    },
    color: "#7C3AED",
    evmChainId: 5042002,
    settlement: { cctpDomain: 26 },
  },
  "arbitrum-sepolia": {
    key: "arbitrum-sepolia",
    id: "eip155:421614",
    namespace: "eip155",
    reference: "421614",
    vm: "evm",
    name: "Arbitrum Sepolia",
    shortName: "Arb Sepolia",
    environment: "testnet",
    lane: "testnet",
    nativeAsset: { symbol: "ETH", name: "Ether", decimals: 18 },
    explorer: {
      name: "Arbiscan Sepolia",
      tx: "https://sepolia.arbiscan.io/tx/{hash}",
      address: "https://sepolia.arbiscan.io/address/{address}",
    },
    color: "#5B8DEF",
    evmChainId: 421614,
    settlement: { cctpDomain: 3 },
    counterpart: "arbitrum",
  },
  solana: {
    key: "solana",
    id: `solana:${SOLANA_MAINNET_REFERENCE}`,
    namespace: "solana",
    reference: SOLANA_MAINNET_REFERENCE,
    vm: "svm",
    name: "Solana",
    shortName: "Solana",
    environment: "mainnet",
    lane: "production",
    nativeAsset: { symbol: "SOL", name: "Solana", decimals: 9 },
    explorer: {
      name: "Solscan",
      tx: "https://solscan.io/tx/{hash}",
      address: "https://solscan.io/account/{address}",
    },
    color: "#14F195",
    walletChain: "solana:mainnet",
    settlement: {
      cctpDomain: 5,
      relayChainId: 792703809,
      debridgeChainId: 7565164,
      acrossChainId: 34268394551451,
      lifiChainId: 1151111081099710,
    },
    counterpart: "solana-devnet",
  },
  "solana-devnet": {
    key: "solana-devnet",
    id: `solana:${SOLANA_DEVNET_REFERENCE}`,
    namespace: "solana",
    reference: SOLANA_DEVNET_REFERENCE,
    vm: "svm",
    name: "Solana Devnet",
    shortName: "Solana Dev",
    environment: "testnet",
    lane: "testnet",
    nativeAsset: { symbol: "SOL", name: "Solana", decimals: 9 },
    explorer: {
      name: "Solscan Devnet",
      tx: "https://solscan.io/tx/{hash}?cluster=devnet",
      address: "https://solscan.io/account/{address}?cluster=devnet",
    },
    color: "#9945FF",
    walletChain: "solana:devnet",
    settlement: { cctpDomain: 5 },
    counterpart: "solana",
  },
} satisfies Record<NetworkKey, ChainDescriptor>);

export const NETWORK_KEYS = Object.freeze(Object.keys(CHAINS) as NetworkKey[]);

const CHAIN_BY_ID = new Map<string, ChainDescriptor>(
  Object.values(CHAINS).map((chain) => [chain.id, chain]),
);
const CHAIN_BY_EVM_ID = new Map<number, ChainDescriptor>(
  Object.values(CHAINS)
    .filter((chain) => chain.evmChainId !== undefined)
    .map((chain) => [chain.evmChainId as number, chain]),
);

export function isNetworkKey(value: unknown): value is NetworkKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHAINS, value);
}

export function isCaipChainId(value: unknown): value is CaipChainId {
  return typeof value === "string" && CHAIN_BY_ID.has(value);
}

/** Resolve a network key, CAIP-2 id or numeric EVM chain id to a known chain. */
export function resolveChain(input: unknown): ChainDescriptor | null {
  if (typeof input === "number" && Number.isSafeInteger(input)) {
    return CHAIN_BY_EVM_ID.get(input) ?? null;
  }
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (isNetworkKey(lower)) return CHAINS[lower];
  const byId = CHAIN_BY_ID.get(value);
  if (byId) return byId;
  if (/^\d+$/u.test(value)) return CHAIN_BY_EVM_ID.get(Number(value)) ?? null;
  return CHAIN_ALIASES[lower] ? CHAINS[CHAIN_ALIASES[lower]] : null;
}

export function requireChain(input: unknown): ChainDescriptor {
  const chain = resolveChain(input);
  if (!chain) throw new Error(`Unknown network: ${String(input)}`);
  return chain;
}

const CHAIN_ALIASES: Readonly<Record<string, NetworkKey>> = Object.freeze({
  "base mainnet": "base",
  "base-mainnet": "base",
  arb: "arbitrum",
  "arbitrum one": "arbitrum",
  "arbitrum-one": "arbitrum",
  "ethereum mainnet": "ethereum",
  "ethereum-mainnet": "ethereum",
  op: "optimism",
  "op mainnet": "optimism",
  "op-mainnet": "optimism",
  "optimism mainnet": "optimism",
  "optimism-mainnet": "optimism",
  "polygon pos": "polygon",
  "polygon-pos": "polygon",
  "polygon mainnet": "polygon",
  "polygon-mainnet": "polygon",
  matic: "polygon",
  "arc testnet": "arc",
  "arc-testnet": "arc",
  "arb sepolia": "arbitrum-sepolia",
  sol: "solana",
  "solana mainnet": "solana",
  "solana-mainnet": "solana",
  "mainnet-beta": "solana",
  devnet: "solana-devnet",
  "solana devnet": "solana-devnet",
});

export function explorerTxUrl(chain: NetworkKey | ChainDescriptor, hash: string): string {
  const descriptor = typeof chain === "string" ? CHAINS[chain] : chain;
  return descriptor.explorer.tx.replace("{hash}", encodeURIComponent(hash));
}

export function explorerAddressUrl(
  chain: NetworkKey | ChainDescriptor,
  address: string,
): string {
  const descriptor = typeof chain === "string" ? CHAINS[chain] : chain;
  return descriptor.explorer.address.replace("{address}", encodeURIComponent(address));
}

/** True when two networks may participate in the same workflow. */
export function sameCapitalLane(a: NetworkKey, b: NetworkKey): boolean {
  return CHAINS[a].environment === CHAINS[b].environment;
}
