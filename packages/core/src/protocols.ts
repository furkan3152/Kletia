/**
 * Protocol registry. A protocol is an execution or settlement venue that an
 * intent step can be bound to. `status` states what Kletia can actually do
 * with it today; a registry entry is never a promise of execution.
 *
 * Two pinned tables sit next to it and are the only place execution adapters
 * read venue addresses from (adapters never hard-code them and never take an
 * address from a provider at runtime):
 *
 * - `YIELD_VENUES`: lending markets and vaults (deposit / withdraw), keyed by
 *   `(network, address)` because the same address can be a different market on
 *   another network.
 * - `VENUE_CONTRACTS`: contracts and programs a settlement venue, aggregator or
 *   name service may be called through, per network.
 *
 * Every address below was read back on-chain (eth_call / getAccountInfo) on
 * 2026-10-09; see docs/networks/*.md for the evidence. The later additions
 * (DEX deployments, SparkLend, Spark Savings, Fluid, Yearn V3, Lido, Rocket
 * Pool, ether.fi, Raydium, Orca, Meteora, Across, CCTP V2 and Pyth) were read
 * back on 2026-10-14: docs/networks/evidence/protocols-2026-10-14.json.
 *
 * The modules live in ./protocols/.
 */
export * from "./protocols/types.js";
export {
  PROTOCOLS,
  getProtocol,
  normalizeVenueWord,
  protocolByWord,
  protocolDependencies,
  protocolExecutesKind,
  protocolTier,
  protocolsForNetwork,
} from "./protocols/registry.js";
export * from "./protocols/yieldVenueTypes.js";
export { MORPHO_FACTORIES, YIELD_VENUES, findYieldVenue, getYieldVenue, yieldVenuesFor } from "./protocols/yieldVenues.js";
export {
  CCTP_V2_TESTNET_CONTRACTS,
  CURVE_POOLS,
  DEX_DEPLOYMENTS,
  curvePoolsFor,
  dexContracts,
  dexDeploymentsFor,
  wrappedNativeAddress,
} from "./protocols/dex.js";
export type { CurvePool, DexDeployment, DexDialect, DexProtocolId } from "./protocols/dex.js";
export { SOLANA_STAKE_POOLS, stakePoolsFor } from "./protocols/stakePools.js";
export type { SolanaStakePool, StakePoolProtocolId } from "./protocols/stakePools.js";
export * from "./protocols/venueContracts.js";
