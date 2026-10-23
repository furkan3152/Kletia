/**
 * The capability graph: where value can go, built offline from the
 * registry and the live adapter set.
 *
 * - Nodes are `network|assetId|custody`. Wallet nodes are the listed assets
 *   of every network (`assetsForNetwork`); venue nodes are the yield venues
 *   (`YIELD_VENUES`, custody `venue:<protocol>:<slug>`). Liquid staking
 *   lands in the wallet, so staking targets are the LST wallet nodes.
 * - An edge exists only when an active adapter's own offline predicate
 *   (`supports(route)`) accepts the route. The registry's capability index
 *   (`capabilityIndex`) narrows which adapters are asked: a protocol the
 *   index lists is asked only for the kinds, networks and spent assets its
 *   rows name; an adapter none of whose protocols the index lists (an
 *   embedder or test adapter) is asked everywhere, so it still counts. Adding an
 *   adapter or a registry row therefore adds edges with no change here.
 * - Route shapes asked: swap (same network, input != output), bridge (every
 *   ordered pair of networks on the same lane, any asset pair), transfer
 *   (same asset, same network: an edge from a node to itself that changes
 *   the holder), stake (same network), deposit / withdraw (a wallet node to
 *   a venue node and back, one edge per venue the registry lets the
 *   protocol execute that kind at).
 * - Production and testnet capital never mix: networks of different lanes
 *   are never paired, so the lanes are disjoint graphs.
 * - Fail closed: a predicate that throws is "no edge"; a listed
 *   transfer-only asset (USDbC) has transfer edges only; integrator call /
 *   action adapters are never edges.
 *
 * The graph is memoised per adapter set (`capabilityGraph`): a new
 * `configureAdapters` call bumps `adapterGeneration()` and the next read
 * rebuilds. Everything here is offline and synchronous.
 */
import {
  CHAINS,
  NETWORK_KEYS,
  YIELD_VENUES,
  venueExecutes,
  assetsForNetwork,
  capabilityIndex,
  findAssetBySymbol,
  protocolExecutesKind,
  type AssetCategory,
  type AssetClass,
  type AssetDescriptor,
  type AssetId,
  type AssetSel,
  type Custody,
  type ExposureAssetClass,
  type NetworkKey,
  type NetworkLane,
  type ProtocolId,
  type YieldVenue,
} from "@kletia/core";
import { activeProtocolAdapters, adapterGeneration, effectiveProtocol, isContractAdapter } from "../adapters/registry.js";
import type { AdapterRoute, ProtocolAdapter } from "../adapters/types.js";
import { isUsdStablecoin, resolvedFromDescriptor, type ResolvedAsset } from "../assets.js";
import { evmOperationsFor, type EvmFeeOperation } from "../journey/fees.js";
import { EDGE_KINDS, edgeCost, type EdgeKind } from "./costs.js";
import { riskTier, type RiskTier } from "./risk.js";

export type NodeId = string;

export type NodeCustody =
  | { readonly kind: "wallet" }
  | {
      readonly kind: "venue";
      readonly protocol: ProtocolId;
      /** YIELD_VENUES id. */
      readonly venueId: string;
      readonly slug: string;
      readonly category: "lending";
    };

export interface GraphNode {
  readonly id: NodeId;
  readonly network: NetworkKey;
  readonly lane: NetworkLane;
  /** The asset held: the wallet asset, or a venue's underlying. */
  readonly asset: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  readonly isNative: boolean;
  readonly category: AssetCategory;
  readonly group?: AssetDescriptor["group"];
  /** Listed for balances and transfers only (no venue route spends or delivers it). */
  readonly transferOnly: boolean;
  readonly custody: NodeCustody;
}

export interface GraphEdge {
  readonly id: string;
  readonly from: NodeId;
  /** Equal to `from` for a transfer (same asset and place, another holder). */
  readonly to: NodeId;
  readonly kind: EdgeKind;
  readonly adapterId: ProtocolId;
  /** The protocol the step executes under (`effectiveProtocol`: native transfers are `system-transfer`). */
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly destinationNetwork: NetworkKey;
  /** Deposit / withdraw: the YIELD_VENUES id. */
  readonly venueId?: string;
  readonly estSeconds: number;
  readonly feeBps: number;
  readonly fixedUsd: number;
  readonly minimumUsd: number;
  /** EVM transactions the step sends (priced with live gas by the search); empty on Solana. */
  readonly gasOps: readonly EvmFeeOperation[];
  readonly risk: RiskTier;
  /** Served only when the person names the protocol (route search must not pick it alone). */
  readonly explicitOnly: boolean;
  /** The adapter can deliver destination gas with this leg (`supportsGasTopup`). */
  readonly gasTopup: boolean;
}

export interface CapabilityGraph {
  /** `adapterGeneration()` the graph was built at (memo identity). */
  readonly generation: number;
  readonly nodes: ReadonlyMap<NodeId, GraphNode>;
  /** Outgoing edges of a node, in adapter preference order; empty for an unknown node. */
  edgesFrom(node: NodeId): readonly GraphEdge[];
  /** Incoming edges of a node (back-solving target amounts). */
  edgesTo(node: NodeId): readonly GraphEdge[];
  readonly edgeCount: number;
  /** Edges per kind. */
  readonly counts: Readonly<Record<EdgeKind, number>>;
  /** Edges per adapter id. */
  readonly byAdapter: Readonly<Record<string, number>>;
  /** `supports()` predicate calls made by the build. */
  readonly checks: number;
  readonly buildMs: number;
}

/* ------------------------------------------------------------- node ids */

export function walletNodeId(network: NetworkKey, asset: AssetId): NodeId {
  return `${network}|${asset}|wallet`;
}

export function venueNodeId(venue: Pick<YieldVenue, "network" | "protocol" | "slug">, asset: AssetId): NodeId {
  return `${venue.network}|${asset}|venue:${venue.protocol}:${venue.slug}`;
}

/* ------------------------------------------------------------- matching */

/** True when a node's asset is the selected symbol (aliases resolve per network) or in the selected class. */
export function nodeMatchesAsset(node: GraphNode, selection: AssetSel): boolean {
  if ("symbol" in selection) {
    const wanted = selection.symbol.trim().toUpperCase();
    if (node.symbol.toUpperCase() === wanted || node.asset.toLowerCase() === selection.symbol.trim().toLowerCase()) return true;
    const listed = findAssetBySymbol(node.network, selection.symbol);
    return listed !== null && listed.id === node.asset;
  }
  // The exposure classes are read here before core lists them (`EXPOSURE_ASSET_CLASSES`): a liquid
  // staking token of ETH or of SOL, or a wrapped bitcoin; never the staked asset itself.
  const cls = selection.class as AssetClass | ExposureAssetClass;
  switch (cls) {
    case "usd-stable":
      return isUsdStablecoin({ symbol: node.symbol, canonical: true, category: node.category });
    case "any-stable":
      return node.category === "stablecoin";
    case "eth":
      return node.group === "ETH";
    case "sol":
      return node.group === "SOL" || (node.isNative && node.symbol.toUpperCase() === "SOL");
    case "gas":
      return node.isNative;
    case "eth-lst":
      return node.category === "liquid-staking" && node.group !== "SOL";
    case "sol-lst":
      return node.category === "liquid-staking" && node.group === "SOL";
    case "btc":
      return node.group === "BTC";
  }
}

/** True when a node sits in the custody a Goal place names (unset venue fields match any venue). */
export function nodeMatchesCustody(node: GraphNode, custody: Custody): boolean {
  if (custody.kind === "wallet") return node.custody.kind === "wallet";
  if (node.custody.kind !== "venue") return false;
  if (custody.protocol && custody.protocol !== node.custody.protocol) return false;
  if (custody.kind === "venue") {
    if (custody.category === "staking") return false;
    if (custody.vault) {
      const vault = custody.vault.trim().toLowerCase();
      if (vault !== node.custody.slug.toLowerCase() && vault !== node.custody.venueId.toLowerCase()) return false;
    }
  }
  return true;
}

/** Nodes of a graph matching an optional network, asset selection and custody, in build order. */
export function nodesMatching(
  graph: CapabilityGraph,
  filter: { readonly network?: NetworkKey; readonly asset?: AssetSel; readonly custody?: Custody },
): GraphNode[] {
  const out: GraphNode[] = [];
  for (const node of graph.nodes.values()) {
    if (filter.network && node.network !== filter.network) continue;
    if (filter.asset && !nodeMatchesAsset(node, filter.asset)) continue;
    if (filter.custody && !nodeMatchesCustody(node, filter.custody)) continue;
    out.push(node);
  }
  return out;
}

/* ---------------------------------------------------------------- build */

interface NodeAsset {
  readonly node: GraphNode;
  readonly resolved: ResolvedAsset;
}

function walletNode(descriptor: AssetDescriptor): NodeAsset {
  const resolved = resolvedFromDescriptor(descriptor);
  const node: GraphNode = Object.freeze({
    id: walletNodeId(descriptor.network, descriptor.id),
    network: descriptor.network,
    lane: CHAINS[descriptor.network].lane,
    asset: descriptor.id,
    symbol: descriptor.symbol,
    decimals: descriptor.decimals,
    isNative: descriptor.address === null,
    category: descriptor.category,
    ...(descriptor.group ? { group: descriptor.group } : {}),
    transferOnly: descriptor.transferOnly === true,
    custody: Object.freeze({ kind: "wallet" as const }),
  });
  return { node, resolved };
}

/** The listed asset a venue holds (its network's gas asset when the venue names it). */
function venueAsset(venue: YieldVenue, wallets: readonly NodeAsset[]): NodeAsset | null {
  const listed = findAssetBySymbol(venue.network, venue.asset);
  if (!listed) return null;
  return wallets.find((entry) => entry.node.asset === listed.id) ?? null;
}

/**
 * Which protocols the registry's capability index lists per network and kind,
 * with the assets each takes (null: any asset).
 */
type IndexMap = Map<string, Map<ProtocolId, { readonly any: boolean; readonly assets: Set<string>; readonly explicitOnly: boolean }>>;

function indexMap(): { readonly map: IndexMap; readonly indexed: ReadonlySet<ProtocolId> } {
  const map: IndexMap = new Map();
  const indexed = new Set<ProtocolId>();
  for (const row of capabilityIndex()) {
    indexed.add(row.protocol);
    if (!(EDGE_KINDS as readonly string[]).includes(row.kind)) continue;
    const kind = row.kind as EdgeKind;
    const key = `${row.network}|${kind}`;
    const protocols = map.get(key) ?? new Map();
    map.set(key, protocols);
    const entry = protocols.get(row.protocol) ?? { any: false, assets: new Set<string>(), explicitOnly: false };
    protocols.set(row.protocol, {
      any: entry.any || row.asset === null,
      assets: row.asset === null ? entry.assets : entry.assets.add(row.asset.toUpperCase()),
      explicitOnly: entry.explicitOnly || row.explicitOnly,
    });
  }
  return { map, indexed };
}

/**
 * Builds the graph over `adapters` (the active set by default). Synchronous
 * and offline: only the adapters' `supports` / `supportsGasTopup` predicates
 * and the registry tables are read.
 */
export function buildGraph(adapters: readonly ProtocolAdapter[] = activeProtocolAdapters(), options: { readonly generation?: number } = {}): CapabilityGraph {
  const started = performance.now();
  const routeAdapters = adapters.filter((adapter) => !isContractAdapter(adapter));
  const { map, indexed } = indexMap();
  const nodes = new Map<NodeId, GraphNode>();
  const outgoing = new Map<NodeId, GraphEdge[]>();
  const incoming = new Map<NodeId, GraphEdge[]>();
  const counts: Record<EdgeKind, number> = { swap: 0, bridge: 0, transfer: 0, stake: 0, deposit: 0, withdraw: 0 };
  const byAdapter: Record<string, number> = {};
  let checks = 0;

  const walletsByNetwork = new Map<NetworkKey, NodeAsset[]>();
  for (const network of NETWORK_KEYS) {
    const wallets = assetsForNetwork(network).map(walletNode);
    walletsByNetwork.set(network, wallets);
    for (const { node } of wallets) nodes.set(node.id, node);
  }

  /**
   * Adapters the index lets serve `kind` on `network` for `inputSymbol`
   * (null: skip the asset filter), with whether the index marks the
   * protocol named-only there.
   */
  const askable = (kind: EdgeKind, network: NetworkKey, inputSymbol: string | null): { adapter: ProtocolAdapter; indexExplicit: boolean }[] => {
    const protocols = map.get(`${network}|${kind}`);
    const out: { adapter: ProtocolAdapter; indexExplicit: boolean }[] = [];
    for (const adapter of routeAdapters) {
      if (!adapter.protocols.some((protocol) => indexed.has(protocol))) {
        // The index lists none of the adapter's protocols (an embedder or test adapter): its predicate decides alone.
        out.push({ adapter, indexExplicit: false });
        continue;
      }
      let admitted = false;
      let indexExplicit = false;
      for (const protocol of adapter.protocols) {
        const entry = protocols?.get(protocol);
        if (!entry) continue;
        if (inputSymbol === null || entry.any || entry.assets.has(inputSymbol.toUpperCase())) {
          admitted = true;
          indexExplicit ||= entry.explicitOnly;
        }
      }
      if (admitted) out.push({ adapter, indexExplicit });
    }
    return out;
  };

  const supports = (adapter: ProtocolAdapter, route: AdapterRoute): boolean => {
    checks += 1;
    try {
      return adapter.supports(route) === true;
    } catch {
      return false;
    }
  };

  const gasTopup = (adapter: ProtocolAdapter, route: AdapterRoute): boolean => {
    try {
      return adapter.supportsGasTopup?.(route) === true;
    } catch {
      return false;
    }
  };

  const addEdge = (
    kind: EdgeKind,
    adapter: ProtocolAdapter,
    route: AdapterRoute,
    from: GraphNode,
    to: GraphNode,
    indexExplicit: boolean,
    venueId?: string,
  ): void => {
    // Fail closed: a transfer-only asset is never spent or delivered through a venue.
    if (kind !== "transfer" && (from.transferOnly || to.transferOnly)) return;
    const protocol = effectiveProtocol(adapter, route);
    const cost = edgeCost(kind, protocol, route.network);
    const evm = CHAINS[route.network].vm === "evm";
    const edge: GraphEdge = Object.freeze({
      id: `${kind}:${adapter.id}:${from.id}>${to.id}`,
      from: from.id,
      to: to.id,
      kind,
      adapterId: adapter.id,
      protocol,
      network: route.network,
      destinationNetwork: route.destinationNetwork,
      ...(venueId ? { venueId } : {}),
      estSeconds: cost.estSeconds,
      feeBps: cost.feeBps,
      fixedUsd: cost.fixedUsd,
      minimumUsd: cost.minimumUsd,
      gasOps: Object.freeze(evm ? evmOperationsFor(kind, protocol, { nativeInput: route.input.isNative }) : []),
      risk: riskTier(protocol, route.network),
      explicitOnly: adapter.explicitOnly === true || indexExplicit,
      gasTopup: kind === "bridge" && gasTopup(adapter, route),
    });
    const out = outgoing.get(from.id) ?? [];
    out.push(edge);
    outgoing.set(from.id, out);
    const into = incoming.get(to.id) ?? [];
    into.push(edge);
    incoming.set(to.id, into);
    counts[kind] += 1;
    byAdapter[adapter.id] = (byAdapter[adapter.id] ?? 0) + 1;
  };

  const route = (kind: EdgeKind, network: NetworkKey, destinationNetwork: NetworkKey, input: ResolvedAsset, output: ResolvedAsset): AdapterRoute =>
    ({ kind, network, destinationNetwork, input, output });

  for (const network of NETWORK_KEYS) {
    const wallets = walletsByNetwork.get(network) ?? [];
    // swap, stake, transfer: same network
    for (const kind of ["swap", "stake", "transfer"] as const) {
      for (const input of wallets) {
        const candidates = askable(kind, network, input.node.symbol);
        if (candidates.length === 0) continue;
        for (const output of wallets) {
          const same = input.node.asset === output.node.asset;
          if (kind === "transfer" ? !same : same) continue;
          const shape = route(kind, network, network, input.resolved, output.resolved);
          for (const { adapter, indexExplicit } of candidates) {
            if (supports(adapter, shape)) addEdge(kind, adapter, shape, input.node, output.node, indexExplicit);
          }
        }
      }
    }
    // bridge: every other network on the same lane
    const lane = CHAINS[network].lane;
    for (const destination of NETWORK_KEYS) {
      if (destination === network || CHAINS[destination].lane !== lane) continue;
      const targets = walletsByNetwork.get(destination) ?? [];
      for (const input of wallets) {
        const candidates = askable("bridge", network, input.node.symbol);
        if (candidates.length === 0) continue;
        for (const output of targets) {
          const shape = route("bridge", network, destination, input.resolved, output.resolved);
          for (const { adapter, indexExplicit } of candidates) {
            if (supports(adapter, shape)) addEdge("bridge", adapter, shape, input.node, output.node, indexExplicit);
          }
        }
      }
    }
  }

  // deposit / withdraw: one venue node per yield venue whose underlying is listed
  for (const venue of YIELD_VENUES) {
    const wallets = walletsByNetwork.get(venue.network) ?? [];
    const underlying = venueAsset(venue, wallets);
    if (!underlying) continue;
    const venueNode: GraphNode = Object.freeze({
      ...underlying.node,
      id: venueNodeId(venue, underlying.node.asset),
      custody: Object.freeze({ kind: "venue" as const, protocol: venue.protocol, venueId: venue.id, slug: venue.slug, category: "lending" as const }),
    });
    nodes.set(venueNode.id, venueNode);
    // The gas asset may enter (or leave) a wrapped-asset venue directly when the adapter says so (ETH into a WETH reserve).
    const native = wallets.find((entry) => entry.node.isNative && entry.node.asset !== underlying.node.asset);
    for (const kind of ["deposit", "withdraw"] as const) {
      // A named-only venue (Kamino JLP) is never a route the search may pick: only a sentence naming it reaches it.
      if (!venueExecutes(venue, kind) || !protocolExecutesKind(venue.protocol, kind)) continue;
      const candidates = askable(kind, venue.network, null).filter(({ adapter }) => adapter.protocols.includes(venue.protocol));
      for (const wallet of native ? [underlying, native] : [underlying]) {
        const shape = route(kind, venue.network, venue.network, wallet.resolved, wallet.resolved);
        for (const { adapter, indexExplicit } of candidates) {
          if (!supports(adapter, shape)) continue;
          if (kind === "deposit") addEdge(kind, adapter, shape, wallet.node, venueNode, indexExplicit, venue.id);
          else addEdge(kind, adapter, shape, venueNode, wallet.node, indexExplicit, venue.id);
        }
      }
    }
  }

  const empty: readonly GraphEdge[] = Object.freeze([]);
  const frozenOut = new Map([...outgoing].map(([id, edges]) => [id, Object.freeze(edges)] as const));
  const frozenIn = new Map([...incoming].map(([id, edges]) => [id, Object.freeze(edges)] as const));
  const edgeCount = Object.values(counts).reduce((total, count) => total + count, 0);
  return Object.freeze({
    generation: options.generation ?? adapterGeneration(),
    nodes,
    edgesFrom: (node: NodeId) => frozenOut.get(node) ?? empty,
    edgesTo: (node: NodeId) => frozenIn.get(node) ?? empty,
    edgeCount,
    counts: Object.freeze(counts),
    byAdapter: Object.freeze(byAdapter),
    checks,
    buildMs: performance.now() - started,
  });
}

/* ----------------------------------------------------------------- memo */

let memo: { readonly adapters: readonly ProtocolAdapter[]; readonly generation: number; readonly graph: CapabilityGraph } | null = null;

/** The graph of the active adapter set, built lazily and rebuilt after `configureAdapters`. */
export function capabilityGraph(): CapabilityGraph {
  const adapters = activeProtocolAdapters();
  const generation = adapterGeneration();
  if (memo && memo.adapters === adapters && memo.generation === generation) return memo.graph;
  const graph = buildGraph(adapters, { generation });
  memo = { adapters, generation, graph };
  return graph;
}

/** Forgets the memoised graph (tests). */
export function resetCapabilityGraph(): void {
  memo = null;
}
