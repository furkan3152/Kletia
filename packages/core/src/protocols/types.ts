/**
 * Protocol descriptor and venue contract types.
 */
import type { NetworkKey } from "../chains.js";
import type { IntentActionKind } from "../intent.js";

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
  | "token-program"
  /** Perpetual futures venues, executed through /v1/perps (not the intent engine). */
  | "perps"
  /** Prediction-market venues, traded through /v1/predictions (not the intent engine). */
  | "prediction"
  /** Integrator-registered contracts and Solana Actions (bring your own contract). */
  | "custom";

/**
 * - `execute`: Kletia builds wallet-ready transactions.
 * - `quote`: Kletia returns live quotes and routes, execution handled elsewhere.
 * - `discover`: Read-only market/yield discovery (and, for naming, resolution).
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
  | "ens"
  | "sns"
  | "x402"
  | "across"
  | "cctp-v2"
  | "relay"
  | "lifi"
  | "debridge-dln"
  | "jupiter"
  | "jupiter-lend"
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
  | "allora"
  | "custom-call"
  | "solana-actions"
  | "velodrome"
  | "sparklend"
  | "spark-savings"
  | "fluid"
  | "yearn-v3"
  | "lido"
  | "rocket-pool"
  | "etherfi"
  | "raydium"
  | "orca"
  | "meteora"
  | "chainlink"
  | "pyth"
  // added 2026-10-15
  | "pancakeswap-v3"
  | "camelot"
  | "curve"
  | "stader"
  | "mantle-lsp"
  | "frax-ether"
  | "solana-stake"
  // EVM savings and restaking
  | "sky"
  | "ethena"
  | "kelp"
  | "renzo"
  // more Solana venues
  | "blazestake"
  | "save"
  | "solana-pay"
  // native protocol orders (/v1/orders)
  | "jupiter-trigger"
  | "jupiter-recurring"
  | "cow-protocol"
  // perpetual futures (/v1/perps)
  | "gmx-v2"
  | "hyperliquid"
  | "drift-v2"
  // prediction markets (/v1/predictions)
  | "polymarket"
  // native-token wrapping inside intent engine routes
  | "wrap"
  // optional EVM aggregator venue (off unless the operator enables it)
  | "kyberswap";

/**
 * Intent-engine risk tier of a protocol: `core` venues are
 * preferred, `curated` carry a small risk cost, `extended` a larger
 * one. Capability rows on a testnet network report `testnet`
 * whatever the protocol's tier.
 */
export type ProtocolTier = "core" | "curated" | "extended" | "testnet";

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
  /**
   * Intent action kinds Kletia executes through this protocol (when
   * `capabilities` includes `execute`). Whether an adapter is live on a given
   * deployment is reported by GET /v1/protocols (`executable`).
   */
  readonly kinds?: readonly IntentActionKind[];
  /**
   * Executed outside the intent engine: "console" (the legacy console
   * routes), "service" (the API's own paid routes) or "orders" (native
   * protocol orders built by /v1/orders and filled by the protocol's own
   * keepers or solvers). Such entries never count as executable through the
   * intent engine.
   */
  readonly execution?: "console" | "service" | "orders";
  /**
   * Protocols whose programs or APIs every transaction of this protocol also
   * uses (Raydium, Orca and Meteora swaps run through the Jupiter program).
   * Rule Books and avoidProtocols apply to the whole chain: see
   * `protocolDependencies`.
   */
  readonly routedVia?: readonly ProtocolId[];
  /**
   * Venue vocabulary (lower-case words and phrases) users name this protocol
   * by. The grammar's generated venue lists, clarify's vocabulary and the
   * solver's risk table read it; every word is a reserved contract phrase.
   */
  readonly words?: readonly string[];
  /** Risk tier (absent: `extended`). See `protocolTier`. */
  readonly tier?: Exclude<ProtocolTier, "testnet">;
  /** The adapter serves a route only when the protocol is named ("via raydium"); route search never picks it alone. */
  readonly explicitOnly?: true;
}

/* --------------------------------------------------------- venue contracts */

export type VenueContractRole =
  /** Relay: deposit target, ERC-20 router and approval proxy. */
  | "depository"
  | "erc20-router"
  | "approval-proxy"
  /** LI.FI: the diamond (call target and approval address) and the fee forwarder used in swapData. */
  | "diamond"
  | "fee-forwarder"
  /** deBridge DLN: order source (call target, spender) and destination contracts. */
  | "dln-source"
  | "dln-destination"
  /**
   * deBridge DLN source swaps: the forwarder the API routes non-reserve inputs through (call target and spender),
   * the swap routers it may call (allowlist) and the address the API names for swap surplus above the order.
   */
  | "dln-forwarder"
  | "dln-swap-router"
  | "dln-surplus-recipient"
  /** Aggregator: the pinned router a decoded swap call must target (also the approval spender). */
  | "aggregator-router"
  /** Solana programs a venue's transactions invoke. */
  | "program"
  | "liquidity-program"
  | "farms-program"
  /** Name services. */
  | "registry"
  | "universal-resolver"
  | "resolver"
  | "name-program"
  | "tld-parent"
  /** DEX deployments (generated from DEX_DEPLOYMENTS). */
  | "pool-factory"
  | "swap-router"
  | "quoter"
  | "factory-registry"
  /** Lending and savings. */
  | "addresses-provider"
  | "psm"
  | "lending-factory"
  | "liquidity"
  | "vault-original"
  /** EVM liquid staking. */
  | "deposit-target"
  | "lst-token"
  | "underlying-token"
  | "locator"
  | "storage"
  | "liquidity-pool"
  /** The network's canonical wrapped gas asset (WETH, WPOL): the wrap venue's only contract. */
  | "wrapped-native"
  /** Bridges. */
  | "spoke-pool"
  | "spoke-program"
  | "token-messenger"
  | "message-transmitter"
  | "token-minter"
  | "token-messenger-minter"
  /** Data: Pyth's push-oracle receiver. */
  | "receiver"
  // ---- added 2026-10-15
  /** DEX: the pool deployer routers and quoters report (PancakeSwap `deployer()`, Algebra `poolDeployer()`). */
  | "pool-deployer"
  /** Curve: a pinned pool (call target and approval spender). */
  | "curve-pool"
  /** EVM liquid staking: a config contract the deposit target must report, and a pause switch. */
  | "config"
  | "pauser"
  /** Solana stake pools: the pool account, its LST mint, reserve stake, manager fee account and validator list. */
  | "stake-pool"
  | "pool-mint"
  | "reserve-stake"
  | "fee-account"
  | "validator-list"
  /** Marinade: the program state account and its liquidity pool's mSOL leg. */
  | "program-state"
  | "liquidity-leg"
  /** Native staking: default vote accounts (the user may name another active one). */
  | "vote-account"
  // ---- round 9
  /** EVM restaking: the oracle that prices the token (Kelp LRTOracle, Renzo `renzoOracle()`). */
  | "rate-oracle";

export interface VenueContract {
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly role: VenueContractRole;
  readonly address: string;
  /**
   * Venue label, unique across VENUE_CONTRACTS when set. Solana DEX programs
   * carry their Jupiter route label ("Raydium CLMM", "Whirlpool"), so a
   * Jupiter route plan maps back to exactly one named venue.
   */
  readonly label?: string;
}
