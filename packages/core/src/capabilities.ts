/**
 * Capability index (protocols design 3.0): the single, pure answer to "where
 * can this go". Every row says that `protocol` executes `kind` on `network`
 * for `asset` (the asset the step spends: the deposit / withdraw asset, the
 * staked native asset, a Curve coin, a CCTP USDC; null when the venue takes
 * any registry asset the adapter accepts, e.g. a DEX or an aggregator).
 *
 * Built only from the registry tables (`PROTOCOLS`, `YIELD_VENUES`,
 * `DEX_DEPLOYMENTS`, `CURVE_POOLS`, `VENUE_CONTRACTS`, `ASSETS`). It states
 * what the registry pins, not what is live: whether an adapter is wired on a
 * deployment is GET /v1/protocols' `executable` (and the engine's own
 * adapter list), so readers that act on a row still go through the adapters.
 *
 * Rules:
 * - Only protocols whose registry entry executes the kind (`execute`
 *   capability, `kinds`), never console or service surfaces, never
 *   integrator call / action kinds.
 * - deposit / withdraw: one row per yield venue and action (`venueId` set).
 * - swap: DEX protocols on the networks of their pinned deployments; Curve
 *   one row per pinned pool coin; other swap protocols on every network they
 *   list.
 * - Any other kind: a protocol with pinned contracts (VENUE_CONTRACTS)
 *   counts only on the networks it has pins on (CCTP on the testnets only
 *   once pinned); one without pins on every network it lists.
 * - stake: `asset` is the network's native asset (ETH, SOL).
 * - bridge: CCTP V2 moves USDC only; other bridges take any asset (null).
 * - `tier`: `testnet` on a testnet network, else the protocol's tier.
 */
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "./chains.js";
import type { IntentActionKind } from "./intent.js";
import {
  CURVE_POOLS,
  DEX_DEPLOYMENTS,
  PROTOCOLS,
  VENUE_CONTRACTS,
  YIELD_VENUES,
  venueExecutes,
  protocolTier,
  type ProtocolDescriptor,
  type ProtocolId,
  type ProtocolTier,
} from "./protocols.js";

export interface CapabilityRow {
  readonly network: NetworkKey;
  readonly kind: IntentActionKind;
  /** Registry symbol on `network` the step spends; null: any asset the venue's adapter accepts. */
  readonly asset: string | null;
  readonly protocol: ProtocolId;
  /** YIELD_VENUES id (deposit / withdraw rows only). */
  readonly venueId?: string;
  readonly tier: ProtocolTier;
  /** The venue serves only when named (route search never picks it alone). */
  readonly explicitOnly: boolean;
}

/**
 * Networks a bridge reaches but does not start from: CCTP burns start on an
 * EVM network only (Solana-origin burns are deferred, protocols design 2.2).
 */
const DESTINATION_ONLY: Readonly<Partial<Record<ProtocolId, readonly NetworkKey[]>>> = Object.freeze({
  "cctp-v2": ["solana", "solana-devnet"],
});

/** Kinds the index covers (integrator `call` / `action` steps are not venue capabilities). */
const INDEXED_KINDS: readonly IntentActionKind[] = ["swap", "bridge", "transfer", "deposit", "withdraw", "stake"];

function executes(protocol: ProtocolDescriptor, kind: IntentActionKind): boolean {
  return protocol.execution === undefined && protocol.capabilities.includes("execute") && (protocol.kinds ?? []).includes(kind);
}

function pinnedNetworks(protocol: ProtocolDescriptor): readonly NetworkKey[] | null {
  const networks = new Set(VENUE_CONTRACTS.filter((entry) => entry.protocol === protocol.id).map((entry) => entry.network));
  return networks.size === 0 ? null : protocol.networks.filter((network) => networks.has(network));
}

function swapNetworks(protocol: ProtocolDescriptor): readonly NetworkKey[] {
  const deployments = DEX_DEPLOYMENTS.filter((entry) => entry.protocol === protocol.id && entry.dialect !== "solidly-v2");
  if (deployments.length > 0) return protocol.networks.filter((network) => deployments.some((entry) => entry.network === network));
  return pinnedNetworks(protocol) ?? protocol.networks;
}

function nativeSymbol(network: NetworkKey): string {
  return CHAINS[network].nativeAsset.symbol;
}

function buildIndex(): readonly CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  const push = (protocol: ProtocolDescriptor, network: NetworkKey, kind: IntentActionKind, asset: string | null, venueId?: string): void => {
    rows.push(Object.freeze({
      network,
      kind,
      asset,
      protocol: protocol.id,
      ...(venueId ? { venueId } : {}),
      tier: protocolTier(protocol.id, network),
      explicitOnly: protocol.explicitOnly === true,
    }));
  };
  for (const protocol of PROTOCOLS) {
    for (const kind of INDEXED_KINDS) {
      if (!executes(protocol, kind)) continue;
      if (kind === "deposit" || kind === "withdraw") {
        for (const venue of YIELD_VENUES) {
          // A named-only venue is no capability of the protocol: it runs only when a request names it.
          if (venue.protocol === protocol.id && venueExecutes(venue, kind) && protocol.networks.includes(venue.network)) {
            push(protocol, venue.network, kind, venue.asset, venue.id);
          }
        }
        continue;
      }
      if (kind === "swap" && protocol.id === "curve") {
        for (const pool of CURVE_POOLS) {
          if (!protocol.networks.includes(pool.network)) continue;
          for (const coin of pool.coins) {
            if (!rows.some((row) => row.protocol === "curve" && row.network === pool.network && row.asset === coin)) push(protocol, pool.network, kind, coin);
          }
        }
        continue;
      }
      const networks = kind === "swap" ? swapNetworks(protocol) : (pinnedNetworks(protocol) ?? protocol.networks);
      for (const network of networks) {
        if (kind === "bridge" && (DESTINATION_ONLY[protocol.id] ?? []).includes(network)) continue;
        const asset = kind === "stake" ? nativeSymbol(network) : kind === "bridge" && protocol.id === "cctp-v2" ? "USDC" : null;
        push(protocol, network, kind, asset);
      }
    }
  }
  // Registry order of networks, then protocols (stable for readers that show the first rows).
  const order = (network: NetworkKey) => NETWORK_KEYS.indexOf(network);
  return Object.freeze(rows.map((row, index) => ({ row, index }))
    .sort((a, b) => order(a.row.network) - order(b.row.network) || a.index - b.index)
    .map(({ row }) => row));
}

let cached: readonly CapabilityRow[] | null = null;

/**
 * Capability rows, optionally narrowed to one network, kind and asset. An
 * asset filter keeps rows for that symbol (case-insensitive) and the
 * any-asset rows (`asset: null`).
 */
export function capabilityIndex(network?: NetworkKey, kind?: IntentActionKind, asset?: string): readonly CapabilityRow[] {
  cached ??= buildIndex();
  const wanted = asset?.trim().toUpperCase();
  return cached.filter((row) =>
    (!network || row.network === network) &&
    (!kind || row.kind === kind) &&
    (!wanted || row.asset === null || row.asset.toUpperCase() === wanted));
}

/** Protocols with at least one capability row for `kind` (optionally on `network`), in registry order. */
export function capableProtocols(kind: IntentActionKind, network?: NetworkKey): readonly ProtocolId[] {
  const found = new Set(capabilityIndex(network, kind).map((row) => row.protocol));
  return PROTOCOLS.filter((protocol) => found.has(protocol.id)).map((protocol) => protocol.id);
}
