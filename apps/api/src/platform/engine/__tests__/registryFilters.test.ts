/**
 * Adapter registry wiring: the final ADAPTERS order with null
 * placeholders skipped, and the three candidate filters of candidateAdapters
 * (avoided protocol, avoided protocol a venue is routed through, named-only
 * venues). Also the step ref's gas top-up, which prepare must ask again.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { findAssetBySymbol, PROTOCOLS, type ProtocolId } from "@kletia/core";
import { protocolRegistry } from "../../http/catalog.js";
import {
  ADAPTERS,
  avoidedDependency,
  candidateAdapters,
  configureAdapters,
  EXECUTABLE_PROTOCOLS,
} from "../adapters/registry.js";
import type { AdapterRoute, ProtocolAdapter } from "../adapters/types.js";
import { decodeStepRef, encodeStepRef } from "../stepRef.js";
import type { ResolvedAsset } from "../assets.js";

/** The final order, newer venues within their families; ids of venues not wired yet are skipped. */
const FINAL_ORDER: readonly ProtocolId[] = [
  "jupiter", "raydium", "orca", "meteora", "jito", "sanctum", "blazestake", "marinade", "solana-stake", "spl-token", "solana-pay", "erc20-transfer", "wrap",
  "uniswap-v3", "aerodrome", "velodrome", "pancakeswap-v3", "camelot", "curve", "kyberswap", "relay", "across", "cctp-v2", "lifi",
  "debridge-dln", "aave-v3", "sparklend", "compound-v3", "morpho", "spark-savings", "fluid", "yearn-v3", "moonwell", "sky", "ethena",
  "jupiter-lend", "kamino", "save", "lido", "rocket-pool", "etherfi", "stader", "mantle-lsp", "frax-ether", "kelp", "renzo", "custom-call", "solana-actions",
];

function solanaAsset(symbol: string): ResolvedAsset {
  const descriptor = findAssetBySymbol("solana", symbol);
  assert.ok(descriptor, symbol);
  return {
    network: "solana", id: descriptor.id, symbol: descriptor.symbol, name: descriptor.name, decimals: descriptor.decimals,
    address: descriptor.address, isNative: descriptor.address === null, canonical: true, verified: true, category: descriptor.category,
  };
}

const SWAP: AdapterRoute = { kind: "swap", network: "solana", destinationNetwork: "solana", input: solanaAsset("SOL"), output: solanaAsset("USDC") };

function stub(id: ProtocolId, options: { explicitOnly?: boolean } = {}): ProtocolAdapter {
  const refuse = async (): Promise<never> => assert.fail(`${id} must not be called`);
  return {
    id,
    protocols: [id],
    label: id,
    ...(options.explicitOnly ? { explicitOnly: true } : {}),
    supports: (route) => route.kind === "swap" && route.network === "solana",
    plan: refuse,
    prepare: refuse,
    verify: refuse,
  };
}

const ids = (adapters: readonly ProtocolAdapter[]): ProtocolId[] => adapters.map((adapter) => adapter.id);

afterEach(() => configureAdapters(null));

describe("adapter registry order", () => {
  it("keeps the final order and skips the null placeholders", () => {
    assert.ok(ADAPTERS.every((adapter) => adapter !== null && typeof adapter.supports === "function"));
    const order = ids(ADAPTERS);
    const positions = order.map((id) => FINAL_ORDER.indexOf(id));
    assert.ok(positions.every((position) => position >= 0), `unknown adapter in ${order.join(", ")}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "ADAPTERS follows the final order");
    // The named Solana DEX venues are executable.
    for (const landed of ["raydium", "orca", "meteora"] as const) {
      assert.ok(EXECUTABLE_PROTOCOLS.includes(landed), landed);
    }
  });

  it("GET /v1/protocols reports 46 executable real protocols", () => {
    const executable = protocolRegistry().filter((entry) => entry.executable && entry.category !== "custom").map((entry) => entry.id);
    assert.deepEqual(executable.sort(), [
      "aave-v3", "across", "aerodrome", "blazestake", "camelot", "cctp-v2", "compound-v3", "curve", "debridge-dln", "erc20-transfer", "ethena", "etherfi", "fluid",
      "frax-ether", "jito", "jupiter", "jupiter-lend", "kamino", "kelp", "lido", "lifi", "mantle-lsp", "marinade", "meteora", "moonwell", "morpho", "orca",
      "pancakeswap-v3", "raydium", "relay", "renzo", "rocket-pool", "sanctum", "save", "sky", "solana-pay", "solana-stake", "spark-savings", "sparklend",
      "spl-token", "stader", "system-transfer", "uniswap-v3", "velodrome", "wrap", "yearn-v3",
    ]);
    // with a live adapter, plus three native-order protocols and three perps venues (no adapter).
    assert.equal(PROTOCOLS.length, 66);
  });
});

describe("candidateAdapters filters", () => {
  it("drops an avoided protocol", () => {
    configureAdapters([stub("jupiter"), stub("relay")]);
    assert.deepEqual(ids(candidateAdapters(SWAP, undefined)), ["jupiter", "relay"]);
    assert.deepEqual(ids(candidateAdapters(SWAP, { avoidProtocols: ["jupiter"] })), ["relay"]);
  });

  it("drops a venue whose routedVia protocol is avoided, even when it is named", () => {
    configureAdapters([stub("jupiter"), stub("raydium"), stub("relay")]);
    assert.deepEqual(ids(candidateAdapters(SWAP, undefined)), ["jupiter", "raydium", "relay"]);
    assert.deepEqual(ids(candidateAdapters(SWAP, { avoidProtocols: ["jupiter"] })), ["relay"], "avoiding jupiter drops raydium");
    assert.deepEqual(ids(candidateAdapters(SWAP, { avoidProtocols: ["jupiter"] }, "raydium")), []);
    assert.equal(avoidedDependency("raydium", { avoidProtocols: ["jupiter"] }), "jupiter");
    assert.equal(avoidedDependency("raydium", { avoidProtocols: ["raydium"] }), null, "only dependencies, not the protocol itself");
    assert.equal(avoidedDependency("jupiter", { avoidProtocols: ["jupiter"] }), null);
    // Avoiding the venue itself leaves its transport alone.
    assert.deepEqual(ids(candidateAdapters(SWAP, { avoidProtocols: ["raydium"] })), ["jupiter", "relay"]);
  });

  it("keeps a named-only venue only when it is requested or preferred", () => {
    configureAdapters([stub("jupiter"), stub("orca", { explicitOnly: true })]);
    assert.deepEqual(ids(candidateAdapters(SWAP, undefined)), ["jupiter"], "route search never picks it");
    assert.deepEqual(ids(candidateAdapters(SWAP, undefined, "orca")), ["orca"]);
    assert.deepEqual(ids(candidateAdapters(SWAP, { preferProtocols: ["orca"] })), ["orca", "jupiter"]);
    assert.deepEqual(ids(candidateAdapters(SWAP, { preferProtocols: ["orca"], avoidProtocols: ["jupiter"] })), [], "still routed via jupiter");
  });
});

describe("step ref gas top-up", () => {
  it("round-trips the planned top-up and refuses a malformed one", () => {
    const ref = decodeStepRef(encodeStepRef({ v: 1, slippageBps: 50, gasTopupUsd: "0.50" }));
    assert.equal(ref?.gasTopupUsd, "0.50");
    assert.equal(decodeStepRef(encodeStepRef({ v: 1, slippageBps: 50 }))?.gasTopupUsd, undefined);
    for (const bad of ["0.01", "5.01", "1e2", "-1", "0.505"]) {
      assert.equal(decodeStepRef(encodeStepRef({ v: 1, slippageBps: 50, gasTopupUsd: bad })), null, bad);
    }
  });
});
