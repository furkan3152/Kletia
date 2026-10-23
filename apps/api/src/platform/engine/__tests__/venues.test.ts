/**
 * Planner: deposit / withdraw routed to the adapter of the named protocol,
 * registry venues (AdapterAction.venue), close-position withdrawals and the
 * new production networks.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateIntentGraph, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { evmLendingVenues } from "../adapters/lending/metrics.js";
import { actionForStep, planIntent } from "../planner.js";
import { configureSnapshotReaders } from "../solver/snapshot.js";
import { decodeStepRef } from "../stepRef.js";
import { ACCOUNTS, EVM_ADDRESS, OTHER_EVM_ADDRESS } from "./helpers.js";
import { lending, resetVenueEngine } from "./venueStubs.js";

async function planError(input: unknown): Promise<PlatformError> {
  try {
    await planIntent(input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("planning succeeded but should have failed");
}

function shape(graph: IntentGraph): string[] {
  return graph.steps.map((step) => `${step.id}:${step.kind}/${step.protocol}@${step.network}${step.venue ? `#${step.venue}` : ""}`);
}

describe("planner: lending venues", () => {
  beforeEach(() => {
    resetVenueEngine();
  });

  it("routes a deposit to the named protocol's adapter with its default registry venue", async () => {
    const graph = await planIntent({ text: "deposit 100 USDC into morpho on base", accounts: ACCOUNTS });
    assert.deepEqual(shape(graph), ["s1:deposit/morpho@base#base:morpho:steakhouse-prime-usdc"]);
    assert.equal(lending.calls[0]?.venue, "base:morpho:steakhouse-prime-usdc");
    assert.equal(graph.steps[0]?.input?.amount, "100000000");
    assert.match(graph.steps[0]?.warnings?.[0] ?? "", /Using Steakhouse Prime USDC; name another Morpho Vaults venue with params.venue \(gauntlet-usdc-prime, gauntlet-usdc-prime-v1, spark-usdc\)/u);
    assert.deepEqual(validateIntentGraph(graph), []);
  });

  it("deposits into Compound, Moonwell, Jupiter Lend and Kamino (no Aave-only gate)", async () => {
    const compound = await planIntent({ text: "supply 0.5 WETH to compound on arbitrum", accounts: ACCOUNTS });
    assert.deepEqual(shape(compound), ["s1:deposit/compound-v3@arbitrum#arbitrum:compound-v3:weth"]);
    const moonwell = await planIntent({ text: "lend 50 USDC on moonwell", accounts: ACCOUNTS });
    assert.deepEqual(shape(moonwell), ["s1:deposit/moonwell@base#base:moonwell:usdc"]);
    const jupiter = await planIntent({ text: "deposit 10 USDC into jupiter lend", accounts: ACCOUNTS });
    assert.deepEqual(shape(jupiter), ["s1:deposit/jupiter-lend@solana#solana:jupiter-lend:usdc"]);
    assert.equal(jupiter.steps[0]?.minimumOutput?.symbol, "rUSDC", "receipt comes from the registry venue");
    const kamino = await planIntent({ text: "deposit 5 USDC into kamino", accounts: ACCOUNTS });
    assert.deepEqual(shape(kamino), ["s1:deposit/kamino@solana#solana:kamino:usdc"]);
  });

  it("resolves params.venue by slug, vault address or receipt and validates it", async () => {
    const base = { kind: "deposit", network: "base", from: "USDC", amount: "10", protocol: "morpho" } as const;
    const bySlug = await planIntent({ actions: [{ ...base, params: { venue: "spark-usdc" } }], accounts: ACCOUNTS });
    assert.equal(bySlug.steps[0]?.venue, "base:morpho:spark-usdc");
    assert.equal(bySlug.steps[0]?.warnings, undefined, "a named venue needs no default warning");
    const byAddress = await planIntent({ actions: [{ ...base, params: { venue: "0x7bfa7c4f149e7415b73bdedfe609237e29cbf34a" } }], accounts: ACCOUNTS });
    assert.equal(byAddress.steps[0]?.venue, "base:morpho:spark-usdc");
    const withoutProtocol = await planIntent({ actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "10", params: { venue: "base:compound-v3:usdc" } }], accounts: ACCOUNTS });
    assert.equal(withoutProtocol.steps[0]?.protocol, "compound-v3", "the venue determines the protocol");

    const unknown = await planError({ actions: [{ ...base, params: { venue: "not-gauntlet" } }], accounts: ACCOUNTS });
    assert.equal(unknown.code, "VENUE_UNKNOWN");
    assert.match(unknown.message, /Known: steakhouse-prime-usdc/u);
    const elsewhere = await planError({ actions: [{ ...base, network: "arbitrum", params: { venue: "spark-usdc" } }], accounts: ACCOUNTS });
    assert.equal(elsewhere.code, "VENUE_UNKNOWN", "venues never match across networks");
    const asset = await planError({ actions: [{ ...base, params: { venue: "steakhouse-prime-eth" } }], accounts: ACCOUNTS });
    assert.equal(asset.code, "VENUE_ASSET_MISMATCH");
    const discovery = await planError({ actions: [{ kind: "deposit", network: "solana", from: "SOL", amount: "1", protocol: "jupiter-lend", params: { venue: "sol" } }], accounts: ACCOUNTS });
    assert.equal(discovery.code, "VENUE_UNSUPPORTED");
    const mismatch = await planError({ actions: [{ ...base, protocol: "aave-v3", params: { venue: "spark-usdc" } }], accounts: ACCOUNTS });
    assert.equal(mismatch.code, "VENUE_UNKNOWN", "a venue of another protocol is not found under the named protocol");
  });

  it("picks the first lending protocol with a live adapter, honouring prefer / avoid", async () => {
    const action = { kind: "deposit", network: "base", from: "USDC", amount: "10" } as const;
    const plain = await planIntent({ actions: [action], accounts: ACCOUNTS });
    assert.deepEqual(shape(plain), ["s1:deposit/aave-v3@base#base:aave-v3:usdc"]);
    const preferred = await planIntent({ actions: [action], accounts: ACCOUNTS, constraints: { preferProtocols: ["morpho"] } });
    assert.equal(preferred.steps[0]?.protocol, "morpho");
    const avoided = await planIntent({ actions: [action], accounts: ACCOUNTS, constraints: { avoidProtocols: ["aave-v3"] } });
    assert.equal(avoided.steps[0]?.protocol, "compound-v3");
    const named = await planError({ actions: [{ ...action, params: { venue: "spark-usdc" } }], accounts: ACCOUNTS, constraints: { avoidProtocols: ["morpho"] } });
    assert.equal(named.code, "INTENT_UNSUPPORTED");
  });

  it("refuses non-lending protocols, venue params on other kinds and venues without a live adapter", async () => {
    const jupiter = await planError({ actions: [{ kind: "deposit", network: "solana", from: "USDC", amount: "1", protocol: "jupiter" }], accounts: ACCOUNTS });
    assert.equal(jupiter.code, "INTENT_UNSUPPORTED");
    assert.match(jupiter.message, /does not take deposits/u);
    const swap = await planError({ actions: [{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1", params: { venue: "usdc" } }], accounts: ACCOUNTS });
    assert.match(swap.message, /params.venue applies to deposit and withdraw/u);
    const asset = await planError({ text: "deposit 1 ARB into aave on arbitrum", accounts: ACCOUNTS });
    assert.equal(asset.code, "INTENT_UNSUPPORTED");
    assert.match(asset.message, /Aave V3 on Arbitrum One takes USDC, WETH, USDT0, wstETH; ARB is not available/u);
    // Aave on Ethereum is in the registry, but the stub Aave adapter only serves Base and Arbitrum: fail closed.
    const noAdapter = await planError({ actions: [{ kind: "deposit", network: "ethereum", from: "USDC", amount: "1", protocol: "aave-v3" }], accounts: ACCOUNTS });
    assert.equal(noAdapter.code, "INTENT_UNSUPPORTED");
  });

  it("plans an exact withdraw with the underlying as output and no wallet input", async () => {
    const graph = await planIntent({ text: "withdraw 50 USDC from compound on base", accounts: ACCOUNTS });
    assert.deepEqual(shape(graph), ["s1:withdraw/compound-v3@base#base:compound-v3:usdc"]);
    const [step] = graph.steps;
    assert.equal(step?.input?.amount, "50000000");
    assert.equal(step?.minimumOutput?.symbol, "USDC");
    assert.equal(step?.recipient, undefined, "a withdraw pays the acting account");
    assert.deepEqual(graph.summary.inputs, [], "nothing leaves the wallet");
    assert.equal(graph.summary.outputs[0]?.amount, "50000000");
    assert.equal(lending.calls[0]?.closePosition, undefined);
  });

  it("closes a whole position with \"withdraw all\" and lets it fund the next step", async () => {
    const graph = await planIntent({ text: "withdraw all USDC from compound on arbitrum then bridge it to solana", accounts: ACCOUNTS });
    assert.deepEqual(shape(graph), [
      "s1:withdraw/compound-v3@arbitrum#arbitrum:compound-v3:usdc",
      "s2:bridge/relay@arbitrum",
    ]);
    const [withdraw, bridge] = graph.steps;
    assert.equal(lending.calls[0]?.closePosition, true);
    assert.equal(lending.calls[0]?.amount, "0", "the adapter sizes the position");
    assert.equal(withdraw?.input?.amount, "123450000");
    assert.equal(decodeStepRef(withdraw?.quoteRef)?.closePosition, true);
    assert.deepEqual(graph.edges, [{ from: "s1", to: "s2", kind: "funds" }]);
    assert.equal(bridge?.input?.amount, "123450000");
    assert.ok(withdraw);
    const action = actionForStep(graph, withdraw);
    assert.equal(action.closePosition, true);
    assert.equal(action.venue, "arbitrum:compound-v3:usdc");
    assert.equal(action.output.symbol, "USDC");
  });

  it("refuses an empty position, a partial \"max\" withdraw and a tampered venue at prepare", async () => {
    lending.position = "0";
    const empty = await planError({ text: "withdraw all USDC from compound on base", accounts: ACCOUNTS });
    assert.equal(empty.code, "POSITION_EMPTY");
    const partial = await planError({
      actions: [{ kind: "withdraw", network: "base", from: "USDC", amount: "max", protocol: "compound-v3", params: { portionBps: 5000 } }],
      accounts: ACCOUNTS,
    });
    assert.equal(partial.code, "INTENT_UNSUPPORTED");
    lending.position = "1";
    const graph = await planIntent({ text: "deposit 1 USDC into morpho on base", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.ok(step);
    assert.throws(() => actionForStep(graph, { ...step, venue: "arbitrum:morpho:steakhouse-high-yield-usdc" }), /venue is not in the registry/u);
    assert.throws(() => actionForStep(graph, { ...step, venue: "base:aave-v3:usdc" }), /venue is not in the registry/u);
  });

  it("keeps the bridge-then-deposit flow on the venue's network", async () => {
    const graph = await planIntent({ text: "bridge 20 USDC from solana to base and deposit it into compound", accounts: ACCOUNTS });
    assert.deepEqual(shape(graph), ["s1:bridge/relay@solana", "s2:deposit/compound-v3@base#base:compound-v3:usdc"]);
    assert.equal(graph.steps[1]?.account, `eip155:8453:${EVM_ADDRESS}`);
  });
});

describe("venue listing order (/v1/venues)", () => {
  it("lists the existing Ethereum venues first and the round-6 venues after them", () => {
    const protocols = [...new Set(evmLendingVenues({ network: "ethereum" }).map((venue) => venue.protocol))];
    assert.deepEqual(protocols, ["aave-v3", "compound-v3", "morpho", "sparklend", "spark-savings", "fluid", "yearn-v3"]);
    const savings = evmLendingVenues({ network: "ethereum", protocol: "spark-savings" }).map((venue) => venue.slug);
    assert.deepEqual(savings, ["usdc", "spusdc", "speth"], "sUSDC first: Ethereum's default USDC savings venue");
    assert.deepEqual(evmLendingVenues({ network: "base", protocol: "fluid" }).map((venue) => venue.id), ["base:fluid:usdc", "base:fluid:weth"]);
  });
});

describe("planner: new production networks", () => {
  beforeEach(() => {
    resetVenueEngine();
  });

  for (const network of ["ethereum", "optimism", "polygon"] as const) {
    it(`plans USDC and native transfers on ${network}`, async () => {
      const usdc = await planIntent({ actions: [{ kind: "transfer", network, from: "USDC", amount: "5", recipient: OTHER_EVM_ADDRESS }], accounts: ACCOUNTS });
      assert.deepEqual(shape(usdc), [`s1:transfer/erc20-transfer@${network}`]);
      assert.equal(usdc.steps[0]?.account, `eip155:${{ ethereum: 1, optimism: 10, polygon: 137 }[network]}:${EVM_ADDRESS}`);
      const native = await planIntent({ actions: [{ kind: "transfer", network, from: network === "polygon" ? "POL" : "ETH", amount: "0.1", recipient: OTHER_EVM_ADDRESS }], accounts: ACCOUNTS });
      assert.equal(native.steps[0]?.protocol, "system-transfer");
    });
  }

  it("keeps mainnet networks in one capital lane", async () => {
    const error = await planError({
      actions: [
        { kind: "transfer", network: "polygon", from: "USDC", amount: "1", recipient: OTHER_EVM_ADDRESS },
        { kind: "transfer", network: "arbitrum-sepolia", from: "USDC", amount: "1", recipient: OTHER_EVM_ADDRESS },
      ],
      accounts: ACCOUNTS,
    });
    assert.equal(error.code, "CAPITAL_LANE_MIXED");
  });
});

describe("planner: deposit venue by rate (design B.3, seam S3, RC10)", () => {
  const RATES: Record<string, { apy: number; smoothed: number; tvl: number }> = {
    "base:aave-v3:usdc": { apy: 0.031, smoothed: 0.03, tvl: 400_000_000 },
    "base:compound-v3:usdc": { apy: 0.061, smoothed: 0.06, tvl: 200_000_000 },
    "base:morpho:steakhouse-prime-usdc": { apy: 0.05, smoothed: 0.049, tvl: 60_000_000 },
    "base:morpho:spark-usdc": { apy: 0.063, smoothed: 0.062, tvl: 40_000_000 },
  };

  beforeEach(() => {
    resetVenueEngine();
    configureSnapshotReaders({
      venue: async (venue) => {
        const rate = RATES[venue.id];
        if (!rate) throw new Error("offline");
        return { name: venue.name, apy: rate.apy, utilization: null, exitLiquidity: null, capRemaining: null, paused: false, frozen: false, shareRate: null, at: new Date().toISOString() } as never;
      },
      metrics: async (venue) => {
        const rate = RATES[venue.id];
        return rate ? { smoothedApy: rate.smoothed, apyWindowSeconds: 604_800, tvlUsd: rate.tvl } : { smoothedApy: null, apyWindowSeconds: null, tvlUsd: null };
      },
    });
  });

  afterEach(() => configureSnapshotReaders(null));

  const deposit = { kind: "deposit", network: "base", from: "USDC", amount: "10" } as const;

  it("deposits where the 7-day rate is best among executable venues, and says why", async () => {
    const graph = await planIntent({ actions: [deposit], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.venue, "base:compound-v3:usdc", "6% beats Aave's 3% (both core)");
    const warnings = graph.steps[0]?.warnings ?? [];
    assert.ok(warnings.some((warning) => /^Chose .+ by rate: 7-day rate 6\.00%/u.test(warning)), warnings.join(" | "));
  });

  it("ranks a named protocol's vaults the same way (Q8), keeps preferred protocols first and never ranks withdraws", async () => {
    const morpho = await planIntent({ actions: [{ ...deposit, protocol: "morpho" }], accounts: ACCOUNTS });
    assert.equal(morpho.steps[0]?.venue, "base:morpho:spark-usdc", "6.2% beats 4.9% among Morpho vaults");
    const preferred = await planIntent({ actions: [deposit], accounts: ACCOUNTS, constraints: { preferProtocols: ["morpho"] } });
    assert.equal(preferred.steps[0]?.protocol, "morpho", "a preferred protocol wins before the rate (B.1)");
    const avoided = await planIntent({ actions: [deposit], accounts: ACCOUNTS, constraints: { avoidProtocols: ["compound-v3"] } });
    assert.notEqual(avoided.steps[0]?.protocol, "compound-v3", "an avoided protocol is never ranked in");
    const named = await planIntent({ actions: [{ ...deposit, params: { venue: "base:aave-v3:usdc" } }], accounts: ACCOUNTS });
    assert.equal(named.steps[0]?.venue, "base:aave-v3:usdc", "a named venue is honoured");
  });

  it("keeps the registry default when rates cannot be compared", async () => {
    configureSnapshotReaders({ venue: async () => { throw new Error("offline"); } });
    const graph = await planIntent({ actions: [deposit], accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.venue, "base:aave-v3:usdc");
    assert.ok(!(graph.steps[0]?.warnings ?? []).some((warning) => /by rate/u.test(warning)));
  });
});
