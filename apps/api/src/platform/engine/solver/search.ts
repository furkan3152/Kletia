/**
 * Route search over the capability graph (intent engine v2 §4.3): a
 * best-first beam search from the person's holdings to the nodes a Goal
 * wants, at most `GOAL_LIMITS.maxRouteSteps` edges, ranked by
 *
 *   score = yieldUsd − feesUsd − λt·seconds − λr·riskTier − λs·(steps − 1)
 *
 * with λt = $0.002/s, λr = {core 0, curated $0.25, extended $1}, λs = $0.10;
 * `prefer` multiplies the matching weight by 5 ("cheapest" the fees).
 * Ties break deterministically: registry (edge) order, then node id.
 *
 * The search only orders candidates; it never admits a route an adapter
 * does not serve, and it never emits a step the grammar cannot say:
 *
 * - swaps only on `SWAP_NETWORKS`, bridges only between `BRIDGE_NETWORKS`,
 *   every network of a step needs one of the person's accounts;
 * - stake edges only into a staking provider the clarify vocabulary names
 *   (`STAKE_PROVIDERS`), from the native asset;
 * - deposit / withdraw only at a venue the grammar can name (the protocol's
 *   default venue for the asset, or a vault slug of a vault protocol);
 * - a transfer is only the last step of a delivery; withdraw only leaves the
 *   position the route starts from; deposit and stake only enter a target;
 * - `explicitOnly` edges only when their protocol is named (`via`), avoided
 *   protocols never; a named protocol of a step's kind is required for it.
 *
 * Parallel edges (several bridges or DEXs between the same two nodes) are
 * one hop: the cheapest allowed edge stands for the lane, and the planner's
 * auction picks the venue (D8). A token-changing crossing (X on A -> Y on B)
 * is one abstract leg whose shape the planner's composer picks on live
 * quotes (RC1, `collapseCrossings`), and no route returns to a network it
 * left (A.4.10). Pure and synchronous; reads nothing.
 */
import {
  CHAINS,
  GOAL_LIMITS,
  YIELD_VENUES,
  protocolExecutesKind,
  riskAdjustedApy,
  type AssetId,
  type GoalPreference,
  type NetworkKey,
  type Place,
  type ProtocolId,
  type YieldVenue,
} from "@kletia/core";
import { BRIDGE_NETWORKS, hasAccount, lendingProtocols, STAKE_PROVIDERS, SWAP_NETWORKS, VAULT_PROTOCOLS, venuesOn, type StakeProvider } from "../clarify/catalog.js";
import { evmGasUnits, SOLANA_PRIORITY_LAMPORTS, SOLANA_SIGNATURE_LAMPORTS } from "../journey/fees.js";
import { venueFeeUsd, type EdgeKind } from "./costs.js";
import type { CapabilityGraph, GraphEdge, GraphNode, NodeId } from "./graph.js";
import { RISK_ORDER, riskPenaltyUsd, worstTier, type RiskTier } from "./risk.js";

/* ----------------------------------------------------------------- limits */

export const SEARCH_LIMITS = Object.freeze({
  /** PartialRoute routes kept per depth. */
  beam: 64,
  /** Complete routes returned (before candidate picking). */
  maxRoutes: 32,
});

/** Ranking weights (design §4.3). */
export const RANKING = Object.freeze({
  /** λt: USD per second of expected time. */
  timeUsdPerSecond: 0.002,
  /** λs: USD per step after the first. */
  stepUsd: 0.1,
  /** `prefer` multiplies the matching weight by this. */
  preferFactor: 5,
  /** Earn routes count this many days of the venue's APY as value. */
  yieldDays: 30,
  /** Value assumed for fee shares when a holding has no price (ranking only, never shown). */
  nominalUsd: 100,
});

/**
 * Typical gas prices (wei) for ranking when the caller has no live reading.
 * Ranking only: the planner prices gas with live facts.
 */
const TYPICAL_GAS_PRICE_WEI: Readonly<Partial<Record<NetworkKey, bigint>>> = Object.freeze({
  ethereum: 2_000_000_000n,
  base: 10_000_000n,
  optimism: 10_000_000n,
  arbitrum: 20_000_000n,
  polygon: 40_000_000_000n,
});

/** USD per transaction when the gas asset has no price (ranking only). */
const TYPICAL_TX_USD: Readonly<Partial<Record<NetworkKey, number>>> = Object.freeze({
  ethereum: 0.5,
  base: 0.01,
  optimism: 0.01,
  arbitrum: 0.02,
  polygon: 0.01,
  solana: 0.001,
});

/** USD of one ordinary transaction on `network` for ranking (gas of switching venues, design B.3); never a quote. */
export function typicalTxUsd(network: NetworkKey): number {
  return CHAINS[network].environment === "testnet" ? 0 : TYPICAL_TX_USD[network] ?? 0.01;
}

/* ------------------------------------------------------------------ types */

/** Where value sits after a step. */
export interface Landing {
  readonly network: NetworkKey;
  readonly asset: AssetId;
  readonly symbol: string;
  readonly place: Place;
}

/** A holding a route may start from. */
export interface SearchSource {
  readonly node: GraphNode;
  /** Advisory USD value of what the route moves; null when unpriced or unknown. */
  readonly valueUsd: number | null;
  /** Decimal amount held (or supplied, for a position); null when unknown. */
  readonly amount: string | null;
  readonly status: "known" | "unknown";
  /** The source is a venue position (routes leave it with a withdraw). */
  readonly position: boolean;
}

export interface RouteHop {
  readonly edge: GraphEdge;
  readonly from: GraphNode;
  readonly to: GraphNode;
  readonly landing: Landing;
  readonly feesUsd: number;
  readonly gasUsd: number;
  readonly seconds: number;
  /** Stake hops: the staking provider (clarify vocabulary). */
  readonly provider?: StakeProvider;
  /** Deposit / withdraw hops: the yield venue. */
  readonly venue?: YieldVenue;
}

export type RouteCategory = "wallet" | "lending" | "staking";

/** A difference between routes: purpose dimensions are asked, means dimensions are chips. */
export type Dimension = "asset" | "network" | "earnKind" | "venue" | "bridge" | "provider" | "steps";

export interface Route {
  readonly id: string;
  readonly source: SearchSource;
  readonly hops: readonly RouteHop[];
  /** Where the money ends up (the source itself for a zero-hop delivery). */
  readonly landing: Landing;
  readonly valueInUsd: number | null;
  readonly valueOutUsd: number | null;
  /** Venue fees plus estimated gas, USD. */
  readonly feesUsd: number;
  readonly gasUsd: number;
  readonly seconds: number;
  readonly risk: RiskTier;
  readonly score: number;
  /** Earn routes: the venue's APY (fraction) or null when unknown. */
  readonly apy: number | null;
  readonly venueId?: string;
  readonly category: RouteCategory;
  /** Dimensions where this route differs from the best candidate (set by `pickCandidates`). */
  readonly differsOn: readonly Dimension[];
  /** Registry order of the hops (tie-break). */
  readonly order: readonly number[];
}

export interface SearchSpec {
  readonly graph: CapabilityGraph;
  readonly sources: readonly SearchSource[];
  readonly isTarget: (node: GraphNode, source: SearchSource) => boolean;
  /** Edge kinds the goal may use (a transfer only as the final delivery hop). */
  readonly kinds: ReadonlySet<EdgeKind>;
  /** The verb said: the route must contain one edge of this kind. */
  readonly op?: EdgeKind;
  /** False: no bridge edge ("swap" with one network said). */
  readonly allowBridge?: boolean;
  /** Deliveries end with a transfer hop on the target node. */
  readonly finalTransfer?: boolean;
  /** Accounts of the request (a step needs one of its network's family). */
  readonly accounts: readonly string[];
  readonly via?: readonly ProtocolId[];
  readonly avoid?: readonly ProtocolId[];
  readonly prefer?: GoalPreference;
  readonly maxSteps?: number;
  readonly beam?: number;
  /** APY of a venue (fraction), null when unknown. */
  readonly apy?: (venueId: string) => number | null;
  /** USD price of a network's gas asset, null when unknown. */
  readonly gasAssetUsd?: (network: NetworkKey) => number | null;
  /** Live gas prices (wei) per EVM network, when the caller has them. */
  readonly gasPriceWei?: Readonly<Partial<Record<NetworkKey, bigint>>>;
}

/* ---------------------------------------------------------------- helpers */

/** The staking provider whose token is `node` (the clarify vocabulary), or undefined. */
export function stakeProviderFor(node: GraphNode): StakeProvider | undefined {
  return STAKE_PROVIDERS.find((provider) => provider.network === node.network && provider.symbol.toUpperCase() === node.symbol.toUpperCase());
}

/** The yield venue of a venue node, or undefined. */
export function venueOfNode(node: GraphNode): YieldVenue | undefined {
  if (node.custody.kind !== "venue") return undefined;
  const id = node.custody.venueId;
  return YIELD_VENUES.find((venue) => venue.id === id);
}

/** True when two nodes hold the same asset (same symbol, or the same group in the same form: native ETH and native ETH, USDT and USDT0). */
export function sameAsset(a: Pick<GraphNode, "symbol" | "group" | "isNative" | "category">, b: Pick<GraphNode, "symbol" | "group" | "isNative" | "category">): boolean {
  if (a.symbol.toUpperCase() === b.symbol.toUpperCase()) return true;
  return a.group !== undefined && a.group === b.group && a.isNative === b.isNative && a.category === b.category;
}

/** An asset routes pass through on the way to a target (stablecoins, gas assets, wrapped ether). */
function isCarrier(node: GraphNode): boolean {
  return node.custody.kind === "wallet" && (node.isNative || node.category === "stablecoin" || node.group === "ETH" || node.group === "SOL");
}

export function landingOf(node: GraphNode): Landing {
  const place: Place = node.custody.kind === "venue"
    ? { network: node.network, custody: { kind: "venue", protocol: node.custody.protocol, vault: node.custody.slug, category: "lending" } }
    : { network: node.network, custody: { kind: "wallet" } };
  return { network: node.network, asset: node.asset, symbol: node.symbol, place };
}

/** A venue the grammar can name for this step: the protocol's default venue for the asset, or a vault of a vault protocol. */
function expressibleVenue(venue: YieldVenue, kind: "deposit" | "withdraw", walletSymbol: string): boolean {
  const venues = venuesOn(venue.network, kind, venue.protocol, walletSymbol);
  if (!venues.some((entry) => entry.id === venue.id)) return false;
  return VAULT_PROTOCOLS.includes(venue.protocol) || venues[0]?.id === venue.id;
}

/** A named protocol (`via`) that executes this kind: the step must use one of them. */
function viaFor(kind: EdgeKind, via: readonly ProtocolId[] | undefined): readonly ProtocolId[] {
  return (via ?? []).filter((protocol) => protocolExecutesKind(protocol, kind));
}

/* --------------------------------------------------------------- the cost */

function gasUsdOf(edge: GraphEdge, spec: SearchSpec): number {
  const network = edge.network;
  const chain = CHAINS[network];
  if (chain.environment === "testnet") return 0;
  const price = spec.gasAssetUsd?.(network) ?? null;
  if (chain.vm === "svm") {
    const lamports = SOLANA_SIGNATURE_LAMPORTS + (edge.kind === "transfer" ? 0n : SOLANA_PRIORITY_LAMPORTS);
    return price === null ? TYPICAL_TX_USD[network] ?? 0 : (Number(lamports) / 1e9) * price;
  }
  const { gas, transactions } = evmGasUnits(network, { operations: edge.gasOps });
  const gasPrice = spec.gasPriceWei?.[network] ?? TYPICAL_GAS_PRICE_WEI[network] ?? null;
  if (price === null || gasPrice === null) return transactions * (TYPICAL_TX_USD[network] ?? 0.01);
  return (Number(gas * gasPrice) / 1e18) * price;
}

interface Weights {
  readonly fees: number;
  readonly time: number;
  readonly risk: number;
}

function weights(prefer: GoalPreference | undefined): Weights {
  const factor = RANKING.preferFactor;
  return {
    fees: prefer === "cheapest" ? factor : 1,
    time: prefer === "fastest" ? factor : 1,
    risk: prefer === "safest" ? factor : 1,
  };
}

interface PartialRoute {
  readonly node: GraphNode;
  readonly hops: RouteHop[];
  readonly visited: ReadonlySet<NodeId>;
  readonly valueUsd: number;
  readonly feesUsd: number;
  readonly gasUsd: number;
  readonly seconds: number;
  readonly tiers: RiskTier[];
  readonly order: number[];
  readonly source: SearchSource;
}

function partialScore(partial: Pick<PartialRoute, "feesUsd" | "gasUsd" | "seconds" | "tiers" | "hops">, w: Weights, yieldUsd = 0): number {
  const risk = partial.tiers.length > 0 ? riskPenaltyUsd(worstTier(partial.tiers)) : 0;
  return yieldUsd -
    w.fees * (partial.feesUsd + partial.gasUsd) -
    w.time * RANKING.timeUsdPerSecond * partial.seconds -
    w.risk * risk -
    RANKING.stepUsd * Math.max(0, partial.hops.length - 1);
}

/** Orders by score (descending), then registry order of the hops, then landing node id. */
function compareRoutes(a: Pick<Route, "score" | "order" | "landing" | "id">, b: Pick<Route, "score" | "order" | "landing" | "id">): number {
  const delta = b.score - a.score;
  if (Math.abs(delta) > 1e-9) return delta;
  const length = Math.max(a.order.length, b.order.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.order[index] ?? -1;
    const right = b.order[index] ?? -1;
    if (left !== right) return left - right;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/* ------------------------------------------------------------- the search */

interface Hop {
  readonly edge: GraphEdge;
  readonly to: GraphNode;
  readonly order: number;
  readonly provider?: StakeProvider;
  readonly venue?: YieldVenue;
}

/**
 * The hops a partial route may take from `node`: built-in expressibility,
 * the goal's kinds and constraints, parallel edges collapsed to the
 * cheapest allowed one per (kind, target node).
 */
/** Per-search memo of the checks that do not depend on the partial route. */
interface SearchMemo {
  readonly accounts: Map<NetworkKey, boolean>;
  readonly gas: Map<string, number>;
  readonly venues: Map<string, boolean>;
  readonly lending: ReadonlySet<string>;
}

function memoFor(spec: SearchSpec): SearchMemo {
  return { accounts: new Map(), gas: new Map(), venues: new Map(), lending: new Set(lendingProtocols()) };
}

function accountOn(memo: SearchMemo, spec: SearchSpec, network: NetworkKey): boolean {
  let known = memo.accounts.get(network);
  if (known === undefined) {
    known = hasAccount(spec.accounts, network);
    memo.accounts.set(network, known);
  }
  return known;
}

function gasOf(memo: SearchMemo, spec: SearchSpec, edge: GraphEdge): number {
  let gas = memo.gas.get(edge.id);
  if (gas === undefined) {
    gas = gasUsdOf(edge, spec);
    memo.gas.set(edge.id, gas);
  }
  return gas;
}

function venueOk(memo: SearchMemo, venue: YieldVenue | undefined, kind: "deposit" | "withdraw", walletSymbol: string): boolean {
  if (!venue) return false;
  const key = `${venue.id}|${kind}|${walletSymbol}`;
  let ok = memo.venues.get(key);
  if (ok === undefined) {
    ok = memo.lending.has(venue.protocol) && expressibleVenue(venue, kind, walletSymbol);
    memo.venues.set(key, ok);
  }
  return ok;
}

function hopsFrom(partial: PartialRoute, spec: SearchSpec, depth: number, valueUsd: number, memo: SearchMemo): Hop[] {
  const node = partial.node;
  const lanes = new Map<string, Hop & { cost: number }>();
  const edges = spec.graph.edgesFrom(node.id);
  edges.forEach((edge, order) => {
    if (!spec.kinds.has(edge.kind) || edge.kind === "transfer") return;
    const to = spec.graph.nodes.get(edge.to);
    if (!to || partial.visited.has(to.id)) return;
    if (!accountOn(memo, spec, edge.network) || !accountOn(memo, spec, edge.destinationNetwork)) return;
    if (spec.avoid?.includes(edge.protocol) || spec.avoid?.includes(edge.adapterId)) return;
    const named = viaFor(edge.kind, spec.via);
    if (named.length > 0 && !named.includes(edge.protocol) && !named.includes(edge.adapterId)) return;
    if (edge.explicitOnly && !named.includes(edge.protocol) && !named.includes(edge.adapterId)) return;
    const target = spec.isTarget(to, partial.source);
    let provider: StakeProvider | undefined;
    let venue: YieldVenue | undefined;
    switch (edge.kind) {
      case "swap":
        if (!SWAP_NETWORKS.includes(edge.network) || to.transferOnly || node.transferOnly) return;
        if (!target && !isCarrier(to)) return;
        break;
      case "bridge":
        if (spec.allowBridge === false) return;
        if (!BRIDGE_NETWORKS.includes(edge.network) || !BRIDGE_NETWORKS.includes(edge.destinationNetwork)) return;
        // A.4.10: a route never returns money to a network it already left (a round trip is never the cheapest way).
        if (partial.source.node.network === edge.destinationNetwork || partial.hops.some((hop) => hop.from.network === edge.destinationNetwork)) return;
        if (!target && !sameAsset(node, to)) return;
        break;
      case "stake":
        if (!target || !node.isNative) return;
        provider = stakeProviderFor(to);
        if (!provider) return;
        break;
      case "deposit":
        if (!target) return;
        venue = venueOfNode(to);
        if (!venueOk(memo, venue, "deposit", node.symbol)) return;
        break;
      case "withdraw":
        if (depth !== 0 || !partial.source.position) return;
        venue = venueOfNode(node);
        if (!venueOk(memo, venue, "withdraw", to.symbol)) return;
        break;
    }
    const cost = venueFeeUsd(edge, valueUsd) + gasOf(memo, spec, edge);
    const key = `${edge.kind}|${to.id}`;
    const existing = lanes.get(key);
    if (!existing || cost < existing.cost - 1e-12) {
      lanes.set(key, { edge, to, order, cost, ...(provider ? { provider } : {}), ...(venue ? { venue } : {}) });
    }
  });
  return [...lanes.values()].sort((a, b) => a.order - b.order);
}

function extend(partial: PartialRoute, hop: Hop, spec: SearchSpec, memo: SearchMemo): PartialRoute {
  const feesUsd = venueFeeUsd(hop.edge, partial.valueUsd);
  const gasUsd = gasOf(memo, spec, hop.edge);
  const routeHop: RouteHop = {
    edge: hop.edge,
    from: partial.node,
    to: hop.to,
    landing: landingOf(hop.to),
    feesUsd,
    gasUsd,
    seconds: hop.edge.estSeconds,
    ...(hop.provider ? { provider: hop.provider } : {}),
    ...(hop.venue ? { venue: hop.venue } : {}),
  };
  return {
    node: hop.to,
    hops: [...partial.hops, routeHop],
    visited: new Set([...partial.visited, hop.to.id]),
    valueUsd: Math.max(0, partial.valueUsd - feesUsd),
    feesUsd: partial.feesUsd + feesUsd,
    gasUsd: partial.gasUsd + gasUsd,
    seconds: partial.seconds + hop.edge.estSeconds,
    tiers: [...partial.tiers, hop.edge.risk],
    order: [...partial.order, hop.order],
    source: partial.source,
  };
}

/** The final transfer of a delivery from `node` (its self-loop transfer edge), or null. */
function transferHop(partial: PartialRoute, spec: SearchSpec): Hop | null {
  if (!hasAccount(spec.accounts, partial.node.network)) return null;
  const edges = spec.graph.edgesFrom(partial.node.id);
  const index = edges.findIndex((edge) => edge.kind === "transfer" && !spec.avoid?.includes(edge.protocol) && !edge.explicitOnly);
  if (index < 0) return null;
  return { edge: edges[index] as GraphEdge, to: partial.node, order: index };
}

function finish(partial: PartialRoute, spec: SearchSpec, w: Weights): Route | null {
  if (spec.op && !partial.hops.some((hop) => hop.edge.kind === spec.op)) return null;
  const last = partial.hops[partial.hops.length - 1];
  const category: RouteCategory = partial.hops.some((hop) => hop.edge.kind === "stake")
    ? "staking"
    : last?.edge.kind === "deposit" ? "lending" : "wallet";
  const venueId = last?.edge.kind === "deposit" ? last.edge.venueId : undefined;
  const apy = venueId ? spec.apy?.(venueId) ?? null : null;
  const known = partial.source.valueUsd !== null;
  const value = known ? (partial.source.valueUsd as number) : RANKING.nominalUsd;
  // Design B.3: a venue's rate counts net of its tier's holding penalty (core 0, curated 0.5, extended 1.5 points).
  const adjusted = apy !== null && last ? riskAdjustedApy(last.edge.risk, apy) : null;
  const yieldUsd = adjusted !== null ? (value * adjusted * RANKING.yieldDays) / 365 : 0;
  const score = partialScore(partial, w, yieldUsd);
  const id = partial.hops.length > 0 ? partial.hops.map((hop) => hop.edge.id).join(" > ") : `hold:${partial.node.id}`;
  return {
    id,
    source: partial.source,
    hops: partial.hops,
    landing: landingOf(partial.node),
    valueInUsd: known ? value : null,
    valueOutUsd: known ? partial.valueUsd : null,
    feesUsd: partial.feesUsd + partial.gasUsd,
    gasUsd: partial.gasUsd,
    seconds: partial.seconds,
    risk: partial.tiers.length > 0 ? worstTier(partial.tiers) : "core",
    score,
    apy,
    ...(venueId ? { venueId } : {}),
    category,
    differsOn: [],
    order: partial.order,
  };
}

/* ------------------------------------------------ abstract crossing (RC1) */

/** A swap or bridge between wallet nodes: a hop a crossing leg may stand for. */
const crossingPart = (hop: RouteHop) => (hop.edge.kind === "swap" || hop.edge.kind === "bridge") && hop.from.custody.kind === "wallet" && hop.to.custody.kind === "wallet";

/** The one-shot edge X on A -> Y on B a crossing leg is planned as, when the goal allows it (accounts, avoid, named venues). */
function oneShotEdge(spec: SearchSpec, memo: SearchMemo, from: GraphNode, to: GraphNode): { edge: GraphEdge; order: number } | null {
  const named = viaFor("bridge", spec.via);
  const edges = spec.graph.edgesFrom(from.id);
  for (const [order, edge] of edges.entries()) {
    if (edge.kind !== "bridge" || edge.to !== to.id) continue;
    if (!accountOn(memo, spec, edge.network) || !accountOn(memo, spec, edge.destinationNetwork)) continue;
    if (!BRIDGE_NETWORKS.includes(edge.network) || !BRIDGE_NETWORKS.includes(edge.destinationNetwork)) continue;
    if (spec.avoid?.includes(edge.protocol) || spec.avoid?.includes(edge.adapterId)) continue;
    if (named.length > 0 && !named.includes(edge.protocol) && !named.includes(edge.adapterId)) continue;
    if (edge.explicitOnly && !named.includes(edge.protocol) && !named.includes(edge.adapterId)) continue;
    return { edge, order };
  }
  return null;
}

/**
 * RC1 (design B.4, C.2): a run of swaps and bridges that changes the token
 * and the network (X on A -> Y on B) is one abstract crossing leg, never a
 * shape the search picked by static costs: the planner's composer compares
 * the one-shot route with the carrier composites on live quotes. The leg is
 * the one-shot edge between the run's ends (so the strict planner can also
 * serve it with one venue); its estimate is the run's when that is the
 * cheaper shape. A run whose swap uses a DEX the person named, or with no
 * one-shot edge between its ends, stays as it is.
 */
function collapseCrossings(route: Route, spec: SearchSpec, memo: SearchMemo): Route {
  if (route.hops.length < 2) return route;
  const namedDex = viaFor("swap", spec.via).length > 0;
  const hops: RouteHop[] = [];
  const order: number[] = [];
  let changed = false;
  for (let start = 0; start < route.hops.length;) {
    let end = start;
    while (end < route.hops.length && crossingPart(route.hops[end] as RouteHop)) end += 1;
    const run = route.hops.slice(start, end);
    const first = run[0];
    const last = run[run.length - 1];
    const crosses = run.some((hop) => hop.edge.kind === "bridge");
    if (first && last && run.length >= 2 && crosses && !namedDex && first.from.network !== last.to.network && !sameAsset(first.from, last.to)) {
      const direct = oneShotEdge(spec, memo, first.from, last.to);
      if (direct) {
        const feesUsd = run.reduce((sum, hop) => sum + hop.feesUsd, 0);
        const gasUsd = run.reduce((sum, hop) => sum + hop.gasUsd, 0);
        const seconds = run.reduce((sum, hop) => sum + hop.seconds, 0);
        hops.push({ edge: direct.edge, from: first.from, to: last.to, landing: last.landing, feesUsd, gasUsd, seconds });
        order.push(direct.order);
        changed = true;
        start = end;
        continue;
      }
    }
    if (end === start) {
      hops.push(route.hops[start] as RouteHop);
      order.push(route.order[start] ?? 0);
      start += 1;
      continue;
    }
    hops.push(...run);
    order.push(...route.order.slice(start, end));
    start = end;
  }
  if (!changed) return route;
  return { ...route, id: hops.map((hop) => hop.edge.id).join(" > "), hops, order };
}

/**
 * Every route (up to `SEARCH_LIMITS.maxRoutes`) from the sources to a
 * target, best first. Deterministic for the same graph, sources and spec.
 */
export function searchRoutes(input: SearchSpec): Route[] {
  // Target checks resolve symbols against the registry: memoised per (source, node) for this search.
  const targets = new Map<string, boolean>();
  const spec: SearchSpec = {
    ...input,
    isTarget: (node, source) => {
      const key = `${source.node.id}>${node.id}`;
      let hit = targets.get(key);
      if (hit === undefined) {
        hit = input.isTarget(node, source);
        targets.set(key, hit);
      }
      return hit;
    },
  };
  const w = weights(spec.prefer);
  const memo = memoFor(spec);
  const maxSteps = Math.max(1, Math.min(GOAL_LIMITS.maxRouteSteps, spec.maxSteps ?? GOAL_LIMITS.maxRouteSteps));
  const beam = Math.max(1, spec.beam ?? SEARCH_LIMITS.beam);
  const complete = new Map<string, Route>();
  const record = (found: Route | null) => {
    if (!found) return;
    const route = collapseCrossings(found, spec, memo);
    const existing = complete.get(route.id);
    if (!existing || compareRoutes(route, existing) < 0) complete.set(route.id, route);
  };
  const done = (partial: PartialRoute) => {
    if (!spec.finalTransfer) {
      record(finish(partial, spec, w));
      return;
    }
    if (partial.hops.length >= maxSteps) return;
    const hop = transferHop(partial, spec);
    if (hop) record(finish(extend(partial, hop, spec, memo), spec, w));
  };
  let frontier: PartialRoute[] = spec.sources.map((source) => ({
    node: source.node,
    hops: [],
    visited: new Set([source.node.id]),
    valueUsd: source.valueUsd ?? RANKING.nominalUsd,
    feesUsd: 0,
    gasUsd: 0,
    seconds: 0,
    tiers: [],
    order: [],
    source,
  }));
  // A delivery from a holding already on a valid network is one transfer.
  if (spec.finalTransfer) for (const partial of frontier) if (spec.isTarget(partial.node, partial.source)) done(partial);
  const sourceCount = Math.max(1, new Set(spec.sources.map((source) => source.node.id)).size);
  // Every source keeps a few slots per depth, so a costly holding never drops out of the candidates.
  const perSource = Math.max(4, Math.floor(beam / sourceCount));
  for (let depth = 0; depth < maxSteps && frontier.length > 0; depth += 1) {
    const candidates: { partial: PartialRoute; hop: Hop; score: number }[] = [];
    for (const partial of frontier) {
      for (const hop of hopsFrom(partial, spec, depth, partial.valueUsd, memo)) {
        if (spec.isTarget(hop.to, partial.source)) {
          done(extend(partial, hop, spec, memo));
          continue;
        }
        if (depth + 1 >= maxSteps) continue;
        // Scored before it is built: only the partial routes the beam keeps are materialised.
        const fees = venueFeeUsd(hop.edge, partial.valueUsd);
        const score = partialScore({
          feesUsd: partial.feesUsd + fees,
          gasUsd: partial.gasUsd + gasOf(memo, spec, hop.edge),
          seconds: partial.seconds + hop.edge.estSeconds,
          tiers: [...partial.tiers, hop.edge.risk],
          hops: { length: partial.hops.length + 1 } as RouteHop[],
        }, w);
        candidates.push({ partial, hop, score });
      }
    }
    candidates.sort((a, b) => {
      const delta = b.score - a.score;
      if (Math.abs(delta) > 1e-9) return delta;
      const left = [...a.partial.order, a.hop.order];
      const right = [...b.partial.order, b.hop.order];
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const l = left[index] ?? -1;
        const r = right[index] ?? -1;
        if (l !== r) return l - r;
      }
      const ids = [a.partial.source.node.id + a.hop.to.id, b.partial.source.node.id + b.hop.to.id];
      return ids[0]! < ids[1]! ? -1 : ids[0]! > ids[1]! ? 1 : 0;
    });
    const kept = new Set<number>();
    const perSourceCount = new Map<NodeId, number>();
    candidates.forEach((candidate, index) => {
      const id = candidate.partial.source.node.id;
      const count = perSourceCount.get(id) ?? 0;
      if (count < perSource) {
        kept.add(index);
        perSourceCount.set(id, count + 1);
      }
    });
    for (let index = 0; index < candidates.length && kept.size < Math.max(beam, perSource * sourceCount); index += 1) kept.add(index);
    frontier = candidates.filter((_, index) => kept.has(index)).map(({ partial, hop }) => extend(partial, hop, spec, memo));
  }
  // The best route of every source first (so no holding drops out of the decision table), then the rest by score.
  const sorted = [...complete.values()].sort(compareRoutes);
  const bestPerSource = new Map<NodeId, Route>();
  for (const route of sorted) if (!bestPerSource.has(route.source.node.id)) bestPerSource.set(route.source.node.id, route);
  const kept = new Set<Route>([...bestPerSource.values()].slice(0, SEARCH_LIMITS.maxRoutes));
  for (const route of sorted) {
    if (kept.size >= SEARCH_LIMITS.maxRoutes) break;
    kept.add(route);
  }
  return sorted.filter((route) => kept.has(route));
}

/* ------------------------------------------------------------- candidates */

const bridgePath = (route: Route) => route.hops.filter((hop) => hop.edge.kind === "bridge").map((hop) => `${hop.edge.network}>${hop.edge.destinationNetwork}`).join(",");
const providerOf = (route: Route) => route.hops.find((hop) => hop.provider)?.provider?.id ?? "";

/** The dimensions where `route` differs from `best`. */
export function differences(best: Route, route: Route): Dimension[] {
  const out: Dimension[] = [];
  if (route.category !== best.category) out.push("earnKind");
  if (!sameAsset(route.source.node, best.source.node)) out.push("asset");
  if (route.source.node.network !== best.source.node.network) out.push("network");
  if ((route.venueId ?? "") !== (best.venueId ?? "")) out.push("venue");
  if (providerOf(route) !== providerOf(best)) out.push("provider");
  if (bridgePath(route) !== bridgePath(best)) out.push("bridge");
  if (route.hops.length !== best.hops.length) out.push("steps");
  return out;
}

/**
 * The top `count` candidates (default `GOAL_LIMITS.candidates`): the best
 * route, then the best route differing on each purpose dimension (earn
 * kind, spent asset, source network, venue), then by score. Each carries
 * `differsOn` against the best.
 */
export function pickCandidates(routes: readonly Route[], count: number = GOAL_LIMITS.candidates): Route[] {
  const [best] = routes;
  if (!best) return [];
  const picked: Route[] = [best];
  const add = (route: Route | undefined) => {
    if (route && picked.length < count && !picked.includes(route)) picked.push(route);
  };
  for (const dimension of ["earnKind", "asset", "network", "venue"] as const) {
    add(routes.find((route) => differences(best, route).includes(dimension) && !picked.some((chosen) => !differences(chosen, route).includes(dimension))));
  }
  for (const route of routes) add(route);
  return picked.map((route, index) => (index === 0 ? route : { ...route, differsOn: differences(best, route) }));
}

/** Risk tiers from safest (exported for ties and the "safest" preference). */
export { RISK_ORDER };
