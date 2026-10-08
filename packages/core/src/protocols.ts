/**
 * Protocol registry. A protocol is an execution or settlement venue that an
 * intent step can be bound to. `status` states what Kletia can actually do
 * with it today; a registry entry is never a promise of execution.
 */
import type { NetworkKey } from "./chains.js";

export type ProtocolCategory =
  | "dex-aggregator"
  | "dex"
  | "bridge"
  | "intent-network"
  | "lending"
  | "liquid-staking"
  | "yield"
  | "naming"
  | "payments"
  | "security"
  | "data"
  | "token-program";

/**
 * - `execute`: Kletia builds wallet-ready transactions.
 * - `quote`: Kletia returns live quotes and routes, execution handled elsewhere.
 * - `discover`: Read-only market/yield discovery.
 */
export type ProtocolCapability = "execute" | "quote" | "discover";

export type ProtocolId =
  | "kletia-router-v2"
  | "uniswap-v3"
  | "aerodrome"
  | "aave-v3"
  | "compound-v3"
  | "moonwell"
  | "morpho"
  | "basenames"
  | "x402"
  | "across"
  | "cctp-v2"
  | "relay"
  | "jupiter"
  | "kamino"
  | "jito"
  | "marinade"
  | "sanctum"
  | "spl-token"
  | "system-transfer"
  | "erc20-transfer"
  | "arc-native"
  | "circle-app-kit"
  | "webacy"
  | "allora";

export interface ProtocolDescriptor {
  readonly id: ProtocolId;
  readonly name: string;
  readonly category: ProtocolCategory;
  readonly networks: readonly NetworkKey[];
  readonly capabilities: readonly ProtocolCapability[];
  readonly website: string;
  readonly summary: string;
  /** Cross-network venue that can move value between networks. */
  readonly crossChain?: boolean;
}

export const PROTOCOLS: readonly ProtocolDescriptor[] = Object.freeze([
  {
    id: "kletia-router-v2",
    name: "Kletia Intent Router V2",
    category: "dex-aggregator",
    networks: ["base"],
    capabilities: ["execute", "quote"],
    website: "https://basescan.org",
    summary: "Identity-pinned router that executes reviewed Base swap routes with exact output floors.",
  },
  {
    id: "uniswap-v3",
    name: "Uniswap V3",
    category: "dex",
    networks: ["base", "arbitrum"],
    capabilities: ["execute", "quote"],
    website: "https://uniswap.org",
    summary: "Concentrated-liquidity AMM used for quoted single-hop and multi-hop swaps.",
  },
  {
    id: "aerodrome",
    name: "Aerodrome",
    category: "dex",
    networks: ["base"],
    capabilities: ["quote", "discover"],
    website: "https://aerodrome.finance",
    summary: "Base liquidity hub; volatile, stable and Slipstream pools.",
  },
  {
    id: "aave-v3",
    name: "Aave V3",
    category: "lending",
    networks: ["base", "arbitrum", "arbitrum-sepolia"],
    capabilities: ["execute", "discover"],
    website: "https://aave.com",
    summary: "Supply, borrow and health-factor aware lending markets.",
  },
  {
    id: "compound-v3",
    name: "Compound V3",
    category: "lending",
    networks: ["base", "arbitrum"],
    capabilities: ["discover"],
    website: "https://compound.finance",
    summary: "Single-borrowable-asset Comet markets.",
  },
  {
    id: "moonwell",
    name: "Moonwell",
    category: "lending",
    networks: ["base"],
    capabilities: ["discover"],
    website: "https://moonwell.fi",
    summary: "Base-native lending markets.",
  },
  {
    id: "morpho",
    name: "Morpho / ERC-4626 vaults",
    category: "yield",
    networks: ["base"],
    capabilities: ["discover"],
    website: "https://morpho.org",
    summary: "Curated ERC-4626 lending vaults.",
  },
  {
    id: "basenames",
    name: "Basenames",
    category: "naming",
    networks: ["base"],
    capabilities: ["execute", "discover"],
    website: "https://www.base.org/names",
    summary: "Onchain names on Base; resolution and registration.",
  },
  {
    id: "x402",
    name: "x402 payments",
    category: "payments",
    networks: ["base"],
    capabilities: ["execute", "discover"],
    website: "https://x402.org",
    summary: "HTTP-native USDC payments for paid APIs and agents.",
  },
  {
    id: "across",
    name: "Across",
    category: "bridge",
    networks: ["base", "arbitrum"],
    capabilities: ["execute", "quote"],
    website: "https://across.to",
    summary: "Intent-based bridge for fast EVM-to-EVM transfers.",
    crossChain: true,
  },
  {
    id: "cctp-v2",
    name: "Circle CCTP V2",
    category: "bridge",
    networks: ["base", "arbitrum", "arc", "arbitrum-sepolia", "solana", "solana-devnet"],
    capabilities: ["execute", "quote"],
    website: "https://www.circle.com/cross-chain-transfer-protocol",
    summary: "Native USDC burn-and-mint with attested messages.",
    crossChain: true,
  },
  {
    id: "relay",
    name: "Relay",
    category: "intent-network",
    networks: ["base", "arbitrum", "solana"],
    capabilities: ["execute", "quote"],
    website: "https://relay.link",
    summary: "Solver-filled cross-chain intents between EVM networks and Solana, including swap-and-bridge.",
    crossChain: true,
  },
  {
    id: "jupiter",
    name: "Jupiter",
    category: "dex-aggregator",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://jup.ag",
    summary: "Solana liquidity aggregator across Meteora, Raydium, Orca, Phoenix and more.",
  },
  {
    id: "kamino",
    name: "Kamino Lend",
    category: "lending",
    networks: ["solana"],
    capabilities: ["discover"],
    website: "https://kamino.finance",
    summary: "Solana lending market supply and borrow rates.",
  },
  {
    id: "jito",
    name: "Jito",
    category: "liquid-staking",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://www.jito.network",
    summary: "MEV-boosted liquid staking (JitoSOL), entered through Jupiter routes.",
  },
  {
    id: "marinade",
    name: "Marinade",
    category: "liquid-staking",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://marinade.finance",
    summary: "Liquid staking (mSOL), entered through Jupiter routes.",
  },
  {
    id: "sanctum",
    name: "Jupiter / Sanctum LSTs",
    category: "liquid-staking",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://sanctum.so",
    summary: "JupSOL and the Sanctum LST family, entered through Jupiter routes.",
  },
  {
    id: "spl-token",
    name: "SPL Token",
    category: "token-program",
    networks: ["solana", "solana-devnet"],
    capabilities: ["execute"],
    website: "https://spl.solana.com/token",
    summary: "Checked SPL transfers with idempotent associated token account creation.",
  },
  {
    id: "system-transfer",
    name: "Native transfer",
    category: "token-program",
    networks: ["base", "arbitrum", "arc", "arbitrum-sepolia", "solana", "solana-devnet"],
    capabilities: ["execute"],
    website: "https://kletiaai.xyz",
    summary: "Native asset transfers (ETH, USDC on Arc, SOL).",
  },
  {
    id: "erc20-transfer",
    name: "ERC-20 transfer",
    category: "token-program",
    networks: ["base", "arbitrum", "arc", "arbitrum-sepolia"],
    capabilities: ["execute"],
    website: "https://eips.ethereum.org/EIPS/eip-20",
    summary: "Standard ERC-20 transfers.",
  },
  {
    id: "arc-native",
    name: "Kletia Arc suite",
    category: "payments",
    networks: ["arc"],
    capabilities: ["execute", "discover"],
    website: "https://testnet.arcscan.app",
    summary: "Arc Testnet swap, lending, vault, staking, batch and memo payments.",
  },
  {
    id: "circle-app-kit",
    name: "Circle App Kit",
    category: "bridge",
    networks: ["arc", "arbitrum-sepolia"],
    capabilities: ["execute", "quote"],
    website: "https://developers.circle.com",
    summary: "Circle-managed USDC transfer and unified balance planning on Arc.",
    crossChain: true,
  },
  {
    id: "webacy",
    name: "Webacy",
    category: "security",
    networks: ["base", "arbitrum", "solana"],
    capabilities: ["discover"],
    website: "https://webacy.com",
    summary: "Address and token risk screening before value moves.",
  },
  {
    id: "allora",
    name: "Allora",
    category: "data",
    networks: ["base"],
    capabilities: ["discover"],
    website: "https://allora.network",
    summary: "Decentralised price inference used as advisory market context.",
  },
] satisfies readonly ProtocolDescriptor[]);

export function getProtocol(id: string): ProtocolDescriptor | null {
  return PROTOCOLS.find((protocol) => protocol.id === id) ?? null;
}

export function protocolsForNetwork(network: NetworkKey): ProtocolDescriptor[] {
  return PROTOCOLS.filter((protocol) => protocol.networks.includes(network));
}
