/**
 * Capability graph (intent engine v2 §4.2, package P3): nodes and edges
 * built from the registry and the live adapters' offline predicates.
 *
 * The default registry keeps growing (the protocols task adds adapters), so
 * counts are checked against the design's measured baseline as lower bounds
 * (`round7/engine/eval/graph-probe.txt`: 99 nodes (wallet plus venue), 692 swap, 2,158
 * bridge, 41 transfer edges, 58 venue rows) and against an independent
 * brute-force enumeration for soundness: every edge is one its adapter
 * accepts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { assetsForNetwork, CHAINS, findAssetBySymbol, NETWORK_KEYS, YIELD_VENUES, type NetworkKey, type ProtocolId } from "@kletia/core";
import { ADAPTERS, adapterGeneration, configureAdapters, isContractAdapter } from "../adapters/registry.js";
import type { AdapterRoute, ProtocolAdapter } from "../adapters/types.js";
import { resolvedFromDescriptor } from "../assets.js";
import {
  buildGraph,
  capabilityGraph,
  nodeMatchesAsset,
  nodeMatchesCustody,
  nodesMatching,
  resetCapabilityGraph,
  walletNodeId,
  type CapabilityGraph,
  type GraphEdge,
} from "../solver/graph.js";
import { edgeCost, venueFeeUsd } from "../solver/costs.js";
import { RISK_PENALTY_USD, riskTier, worstTier } from "../solver/risk.js";

const BASELINE = { nodes: 99, swap: 692, bridge: 2158, transfer: 41, venues: 58 } as const;

function asset(network: NetworkKey, symbol: string) {
  const descriptor = findAssetBySymbol(network, symbol);
  assert.ok(descriptor, `${symbol} on ${network}`);
  return resolvedFromDescriptor(descriptor);
}

function stub(id: ProtocolId, supports: (route: AdapterRoute) => boolean, options: { explicitOnly?: boolean } = {}): ProtocolAdapter {
  const refuse = async (): Promise<never> => assert.fail(`${id} must not be called`);
  return { id, protocols: [id], label: id, ...(options.explicitOnly ? { explicitOnly: true } : {}), supports, plan: refuse, prepare: refuse, verify: refuse };
}

function allEdges(graph: CapabilityGraph): GraphEdge[] {
  return [...graph.nodes.keys()].flatMap((id) => [...graph.edgesFrom(id)]);
}

let defaultGraph: CapabilityGraph | null = null;
function graphOfDefaults(): CapabilityGraph {
  defaultGraph ??= buildGraph(ADAPTERS);
  return defaultGraph;
}

afterEach(() => {
  configureAdapters(null);
  resetCapabilityGraph();
});

describe("capability graph: default registry", () => {
  it("has a wallet node per listed asset and a venue node per yield venue with a listed underlying", () => {
    const graph = graphOfDefaults();
    const wallets = [...graph.nodes.values()].filter((node) => node.custody.kind === "wallet");
    const venues = [...graph.nodes.values()].filter((node) => node.custody.kind === "venue");
    const listed = NETWORK_KEYS.reduce((total, network) => total + assetsForNetwork(network).length, 0);
    assert.equal(wallets.length, listed);
    assert.ok(graph.nodes.size >= BASELINE.nodes, `nodes ${graph.nodes.size} >= ${BASELINE.nodes}`);
    const venueRows = YIELD_VENUES.filter((venue) => findAssetBySymbol(venue.network, venue.asset) !== null);
    assert.equal(venues.length, venueRows.length);
    assert.ok(venues.length >= BASELINE.venues);
    for (const node of graph.nodes.values()) assert.equal(graph.nodes.get(node.id), node);
  });

  it("covers at least the measured baseline edges", () => {
    const graph = graphOfDefaults();
    assert.ok(graph.counts.swap >= BASELINE.swap, `swap ${graph.counts.swap}`);
    assert.ok(graph.counts.bridge >= BASELINE.bridge, `bridge ${graph.counts.bridge}`);
    assert.ok(graph.counts.transfer >= BASELINE.transfer, `transfer ${graph.counts.transfer}`);
    assert.ok(graph.counts.deposit >= BASELINE.venues, `deposit ${graph.counts.deposit}`);
    assert.ok(graph.counts.withdraw > 0 && graph.counts.stake > 0);
    assert.equal(graph.edgeCount, allEdges(graph).length);
    console.log(`capability graph: ${graph.nodes.size} nodes, ${graph.edgeCount} edges ${JSON.stringify(graph.counts)}, ${graph.checks} checks`);
  });

  it("is sound: every edge is a route its adapter accepts, with consistent endpoints", () => {
    const graph = graphOfDefaults();
    const byId = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));
    for (const edge of allEdges(graph)) {
      const from = graph.nodes.get(edge.from);
      const to = graph.nodes.get(edge.to);
      assert.ok(from && to, edge.id);
      const adapter = byId.get(edge.adapterId);
      assert.ok(adapter && !isContractAdapter(adapter), edge.id);
      const input = graph.nodes.get(edge.kind === "withdraw" ? edge.to : edge.from);
      const output = graph.nodes.get(edge.kind === "deposit" ? edge.from : edge.to);
      assert.ok(input && output);
      const route: AdapterRoute = {
        kind: edge.kind,
        network: edge.network,
        destinationNetwork: edge.destinationNetwork,
        input: asset(input.network, input.symbol),
        output: asset(output.network, output.symbol),
      };
      assert.ok(adapter.supports(route), `${edge.id} is accepted by ${adapter.id}`);
      assert.equal(from.network, edge.network, edge.id);
      assert.equal(to.network, edge.destinationNetwork, edge.id);
      if (edge.kind === "bridge") assert.notEqual(edge.network, edge.destinationNetwork);
      else assert.equal(edge.network, edge.destinationNetwork, edge.id);
      if (edge.kind === "transfer") assert.equal(edge.from, edge.to);
      if (edge.kind === "swap") assert.notEqual(from.asset, to.asset);
      if (edge.kind === "deposit") assert.ok(from.custody.kind === "wallet" && to.custody.kind === "venue" && edge.venueId === to.custody.venueId);
      if (edge.kind === "withdraw") assert.ok(from.custody.kind === "venue" && to.custody.kind === "wallet" && edge.venueId === from.custody.venueId);
      if (edge.kind === "stake") assert.ok(from.isNative, `${edge.id} stakes the gas asset`);
      if (edge.kind !== "transfer") assert.ok(!from.transferOnly && !to.transferOnly, `${edge.id} spends a transfer-only asset`);
      assert.equal(edge.risk, riskTier(edge.protocol, edge.network));
      assert.ok(edge.estSeconds > 0 && edge.feeBps >= 0 && edge.minimumUsd >= 0);
      assert.equal(edge.gasOps.length > 0, CHAINS[edge.network].vm === "evm", edge.id);
    }
  });

  it("never connects the testnet and production lanes", () => {
    const graph = graphOfDefaults();
    for (const edge of allEdges(graph)) {
      const from = graph.nodes.get(edge.from);
      const to = graph.nodes.get(edge.to);
      assert.equal(from?.lane, to?.lane, edge.id);
      assert.equal(CHAINS[edge.network].environment, CHAINS[edge.destinationNetwork].environment, edge.id);
    }
  });

  it("flags named-only venues and keeps their edges", () => {
    const graph = graphOfDefaults();
    const edges = allEdges(graph);
    const explicit = edges.filter((edge) => edge.explicitOnly);
    // Every edge of a named-only adapter is flagged (a native-stake adapter lands in a stake account, not a listed node, so it may have none).
    for (const protocol of ADAPTERS.filter((adapter) => adapter.explicitOnly).map((adapter) => adapter.id)) {
      const own = edges.filter((edge) => edge.adapterId === protocol);
      assert.ok(own.every((edge) => edge.explicitOnly), `${protocol} edges are explicitOnly`);
    }
    assert.ok(edges.some((edge) => edge.adapterId === "raydium") && explicit.length > 0);
    assert.ok(edges.filter((edge) => edge.adapterId === "jupiter").every((edge) => !edge.explicitOnly));
  });

  it("keeps USDbC to transfers and marks gas top-up legs", () => {
    const graph = graphOfDefaults();
    const usdbc = findAssetBySymbol("base", "USDbC");
    if (usdbc) {
      const edges = graph.edgesFrom(walletNodeId("base", usdbc.id));
      assert.ok(edges.length > 0 && edges.every((edge) => edge.kind === "transfer"));
      assert.ok(graph.edgesTo(walletNodeId("base", usdbc.id)).every((edge) => edge.kind === "transfer"));
    }
    const usdc = asset("base", "USDC");
    const topups = graph.edgesFrom(walletNodeId("base", usdc.id)).filter((edge) => edge.gasTopup);
    assert.ok(topups.length > 0 && topups.every((edge) => edge.kind === "bridge"));
  });

  it("builds well under the latency budget", () => {
    buildGraph(ADAPTERS);
    // The fastest of five builds: one build can be slowed by a busy machine, a regression slows them all.
    const fastest = Math.min(...Array.from({ length: 5 }, () => buildGraph(ADAPTERS).buildMs));
    assert.ok(fastest < 300, `build took ${fastest.toFixed(0)} ms`);
  });
});

describe("capability graph: memo and stubbed adapters", () => {
  it("memoises per adapter set and rebuilds after configureAdapters", () => {
    const first = capabilityGraph();
    assert.equal(capabilityGraph(), first, "memoised");
    const before = adapterGeneration();
    const usdc = asset("base", "USDC");
    const eth = asset("base", "ETH");
    configureAdapters([stub("uniswap-v3", (route) => route.kind === "swap" && route.network === "base" && route.input.id === usdc.id && route.output.id === eth.id)]);
    assert.equal(adapterGeneration(), before + 1);
    const stubbed = capabilityGraph();
    assert.notEqual(stubbed, first);
    assert.equal(stubbed.generation, adapterGeneration());
    assert.equal(stubbed.edgeCount, 1);
    const [edge] = stubbed.edgesFrom(walletNodeId("base", usdc.id));
    assert.equal(edge?.to, walletNodeId("base", eth.id));
    assert.equal(edge?.kind, "swap");
    assert.deepEqual(stubbed.edgesTo(walletNodeId("base", eth.id)), [edge]);
    configureAdapters(null);
    const restored = capabilityGraph();
    assert.notEqual(restored, stubbed);
    assert.deepEqual(restored.counts, first.counts);
  });

  it("asks an adapter the registry does not index everywhere, and never across lanes", () => {
    // A protocol id the capability index has no rows for (a name service): its predicate decides alone.
    const everything = stub("ens", () => true, { explicitOnly: true });
    configureAdapters([everything]);
    const graph = capabilityGraph();
    const edges = allEdges(graph);
    assert.ok(graph.counts.bridge > 0 && graph.counts.swap > 0);
    for (const edge of edges) {
      assert.equal(CHAINS[edge.network].lane, CHAINS[edge.destinationNetwork].lane, edge.id);
      assert.ok(edge.explicitOnly);
    }
    assert.ok(edges.some((edge) => edge.kind === "bridge" && edge.network === "arc"), "testnet lane has its own bridges");
  });

  it("drops edges whose predicate throws", () => {
    configureAdapters([stub("uniswap-v3", () => {
      throw new Error("boom");
    })]);
    assert.equal(capabilityGraph().edgeCount, 0);
  });
});

describe("capability graph: matching, costs and risk", () => {
  it("matches symbols, aliases and classes", () => {
    const graph = graphOfDefaults();
    const usdc = graph.nodes.get(walletNodeId("base", asset("base", "USDC").id));
    const eth = graph.nodes.get(walletNodeId("base", asset("base", "ETH").id));
    assert.ok(usdc && eth);
    assert.ok(nodeMatchesAsset(usdc, { symbol: "usdc" }));
    assert.ok(nodeMatchesAsset(usdc, { class: "usd-stable" }) && nodeMatchesAsset(usdc, { class: "any-stable" }));
    assert.ok(!nodeMatchesAsset(usdc, { class: "eth" }) && nodeMatchesAsset(eth, { class: "eth" }) && nodeMatchesAsset(eth, { class: "gas" }));
    assert.ok(nodeMatchesCustody(usdc, { kind: "wallet" }) && !nodeMatchesCustody(usdc, { kind: "venue" }));
    const aave = nodesMatching(graph, { network: "base", asset: { symbol: "USDC" }, custody: { kind: "venue", protocol: "aave-v3" } });
    assert.ok(aave.length >= 1 && aave.every((node) => node.custody.kind === "venue" && node.custody.protocol === "aave-v3"));
    assert.equal(nodesMatching(graph, { network: "base", custody: { kind: "venue", category: "staking" } }).length, 0);
    const solanaStables = nodesMatching(graph, { network: "solana", asset: { class: "usd-stable" }, custody: { kind: "wallet" } });
    assert.ok(solanaStables.some((node) => node.symbol === "USDC"));
  });

  it("prices edges from the static tables and ranks risk by registry tier", () => {
    const across = edgeCost("bridge", "across", "base");
    const unlisted = edgeCost("bridge", "ens", "ethereum");
    assert.ok(across.estSeconds < unlisted.estSeconds);
    assert.equal(venueFeeUsd({ feeBps: 10, fixedUsd: 2 }, 1000), 3);
    assert.equal(riskTier("aave-v3", "base"), "core");
    assert.equal(riskTier("aave-v3", "arbitrum-sepolia"), "testnet");
    assert.equal(worstTier(["core", "extended", "curated"]), "extended");
    assert.ok(RISK_PENALTY_USD.core < RISK_PENALTY_USD.curated && RISK_PENALTY_USD.curated < RISK_PENALTY_USD.extended);
  });
});
