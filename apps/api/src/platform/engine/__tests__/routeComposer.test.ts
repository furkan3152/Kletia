/**
 * Route shapes and the composer: carriers by exact token address, shape
 * enumeration, the KLETIA_ROUTE_SHAPES flag (single by default), composites
 * chosen by the route score with the multi-signature margin, chained floors, the full-output
 * merge rule, the runner-up re-plan, route explanations, the prepare-time
 * LEG_BELOW_PLANNED_MINIMUM refusal, the strict-path safety net with the
 * recipient guard first, and structured actions that cross only with
 * `constraints.allowCrossings`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findAssetBySymbol, type IntentGraph, type IntentStep } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resolvedFromDescriptor, type ResolvedAsset } from "../assets.js";
import { configureGasReserveReader, planIntent } from "../planner.js";
import { carriersFor } from "../routing/carriers.js";
import { configureRouteShapes, enumerateShapes, routeShapesMode } from "../routing/shapes.js";
import { createIntent, prepareStep, refreshIntent, submitStep } from "../service.js";
import { ACCOUNTS, EVM_ACCOUNT, FUNDED_GAS_FACTS, OTHER_EVM_ADDRESS, randomEvmHash, resetEngine, SOL_ADDRESS } from "./helpers.js";
import { resetRouteEngine, routeCalls, routeScripts, stubRouteVenue } from "./venueStubs.js";

function asset(network: Parameters<typeof findAssetBySymbol>[0], symbol: string): ResolvedAsset {
  const descriptor = findAssetBySymbol(network, symbol);
  assert.ok(descriptor, `${symbol} on ${network}`);
  return resolvedFromDescriptor(descriptor);
}

const NETWORKS = ["base", "arbitrum", "ethereum", "optimism", "solana"] as const;

/** One-shot solver venue, a same-token bridge, and DEXes on each side. */
function venues() {
  return [
    stubRouteVenue("relay", { kind: "bridge", networks: NETWORKS, label: "Stub Relay" }),
    stubRouteVenue("cctp-v2", { kind: "bridge", networks: NETWORKS, sameFamilyOnly: true, label: "Stub CCTP" }),
    stubRouteVenue("jupiter", { kind: "swap", networks: ["solana"], label: "Stub Jupiter" }),
    stubRouteVenue("uniswap-v3", { kind: "swap", networks: ["base", "arbitrum", "ethereum", "optimism"], label: "Stub Uniswap" }),
  ];
}

/** 1,000 USDC on Base to SOL on Solana, as one structured action. */
const USDC_TO_SOL = { actions: [{ kind: "swap" as const, network: "base" as const, toNetwork: "solana" as const, from: "USDC", to: "SOL", amount: "1000" }], accounts: ACCOUNTS };

function shape(graph: IntentGraph): string {
  return graph.steps.map((entry) => `${entry.kind}@${entry.network}${entry.settlement?.destinationNetwork && entry.settlement.destinationNetwork !== entry.network ? `>${entry.settlement.destinationNetwork}` : ""}:${entry.protocol}`).join(" | ");
}

function step(graph: IntentGraph, id: string): IntentStep {
  const found = graph.steps.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

afterEach(() => configureRouteShapes(null));

describe("carriers by exact token address", () => {
  it("carries USDC between networks that list it, by each network's own address", () => {
    const carriers = carriersFor(asset("base", "USDC"), asset("solana", "SOL"));
    assert.deepEqual(carriers.map((carrier) => carrier.id), ["USDC"]);
    assert.equal(carriers[0]?.source.address, findAssetBySymbol("base", "USDC")?.address);
    assert.equal(carriers[0]?.destination.address, findAssetBySymbol("solana", "USDC")?.address);
  });

  it("adds ETH only between ETH networks and only when the crossing's own token is ETH or WETH", () => {
    assert.deepEqual(carriersFor(asset("arbitrum", "ETH"), asset("optimism", "USDC")).map((carrier) => carrier.id), ["USDC", "ETH"]);
    assert.deepEqual(carriersFor(asset("base", "USDC"), asset("optimism", "USDT")).map((carrier) => carrier.id), ["USDC"], "no price exposure added");
    assert.deepEqual(carriersFor(asset("solana", "SOL"), asset("base", "ETH")).map((carrier) => carrier.id), ["USDC"], "Solana is no ETH network");
  });

  it("never carries a bridged look-alike or across capital lanes", () => {
    const carriers = carriersFor(asset("base", "ETH"), asset("arbitrum", "WETH"));
    assert.ok(carriers.every((carrier) => carrier.source.symbol !== "USDbC"));
    assert.deepEqual(carriersFor(asset("arbitrum", "USDC"), asset("arbitrum-sepolia", "USDC")), [], "mainnet and testnet never share a carrier");
  });
});

describe("shapes", () => {
  it("is a plain bridge for the same token family and the one-shot alone without composites", () => {
    assert.deepEqual(enumerateShapes(asset("base", "USDC"), asset("arbitrum", "USDC")).map((candidate) => candidate.shape), ["bridge"]);
    assert.deepEqual(enumerateShapes(asset("base", "USDC"), asset("solana", "SOL")).map((candidate) => candidate.shape), ["one-shot"]);
  });

  it("adds carrier composites when allowed, legs by exact asset", () => {
    const toSol = enumerateShapes(asset("base", "USDC"), asset("solana", "SOL"), { composites: true });
    assert.deepEqual(toSol.map((candidate) => candidate.shape), ["one-shot", "bridge-swap"]);
    assert.deepEqual(toSol[1]?.legs.map((leg) => `${leg.kind}:${leg.input.symbol}@${leg.input.network}>${leg.output.symbol}@${leg.output.network}`), [
      "bridge:USDC@base>USDC@solana",
      "swap:USDC@solana>SOL@solana",
    ]);
    const toEth = enumerateShapes(asset("solana", "SOL"), asset("base", "ETH"), { composites: true });
    assert.deepEqual(toEth.map((candidate) => candidate.shape), ["one-shot", "swap-bridge-swap"]);
    const toUsdc = enumerateShapes(asset("solana", "SOL"), asset("base", "USDC"), { composites: true });
    assert.deepEqual(toUsdc.map((candidate) => candidate.shape), ["one-shot", "swap-bridge"]);
  });

  it("is single unless KLETIA_ROUTE_SHAPES=compare", () => {
    const saved = process.env.KLETIA_ROUTE_SHAPES;
    try {
      delete process.env.KLETIA_ROUTE_SHAPES;
      assert.equal(routeShapesMode(), "single");
      process.env.KLETIA_ROUTE_SHAPES = "Compare";
      assert.equal(routeShapesMode(), "compare");
      process.env.KLETIA_ROUTE_SHAPES = "everything";
      assert.equal(routeShapesMode(), "single", "anything else is the safe default");
    } finally {
      if (saved === undefined) delete process.env.KLETIA_ROUTE_SHAPES;
      else process.env.KLETIA_ROUTE_SHAPES = saved;
    }
  });
});

describe("composer in the planner", () => {
  beforeEach(() => {
    resetRouteEngine(venues());
    // The one-shot quotes 1 % below fair value; the bridge and the Solana DEX 0.1 % each.
    routeScripts.relay = { bps: 9_900 };
    routeScripts["cctp-v2"] = { bps: 9_990 };
    routeScripts.jupiter = { bps: 9_990 };
  });

  it("keeps one cross-network step under the default flag (single)", async () => {
    const graph = await planIntent(USDC_TO_SOL);
    assert.equal(shape(graph), "bridge@base>solana:relay");
    assert.equal(graph.interpretation.routes?.[0]?.shape, "one-shot");
  });

  it("plans the cheaper composite in compare mode, with chained floors and the explanation", async () => {
    configureRouteShapes("compare");
    const graph = await planIntent(USDC_TO_SOL);
    assert.equal(shape(graph), "bridge@base>solana:cctp-v2 | swap@solana:jupiter");
    const [bridge, swap] = graph.steps as [IntentStep, IntentStep];
    // The swap spends the bridge's guaranteed minimum, so the composite's "at least" chains through both legs.
    assert.deepEqual(swap.funding, { from: bridge.id, portionBps: 10_000 });
    assert.equal(swap.input?.amount, bridge.minimumOutput?.amount);
    assert.equal(bridge.input?.symbol, "USDC");
    assert.equal(bridge.minimumOutput?.asset, findAssetBySymbol("solana", "USDC")?.id, "the carrier by its exact Solana address");
    const route = graph.interpretation.routes?.[0];
    assert.ok(route, JSON.stringify(graph.interpretation.routes));
    assert.equal(graph.interpretation.routes?.length, 1, "one entry for the whole crossing");
    assert.equal(route.shape, "bridge-swap");
    assert.equal(route.carrier, "USDC");
    assert.deepEqual(route.steps, [bridge.id, swap.id]);
    assert.deepEqual(route.venues, ["cctp-v2", "jupiter"]);
    assert.equal(route.score.signatures, 2);
    assert.equal(route.score.estimate, undefined, "the planned route is scored fresh");
    assert.ok(route.reason.length <= 200 && /more than Stub Relay|more than Relay/u.test(route.reason), route.reason);
    assert.ok(route.compared.some((entry) => entry.score !== undefined), JSON.stringify(route.compared));
    assert.ok(route.alternatives.some((alternative) => alternative.constraints.routeShapes === "single"), "one step is always offered");
    assert.ok(route.snapshot.quotes.length >= 2);
    assert.ok(graph.interpretation.optimizations?.some((note) => /via USDC in 2 steps/u.test(note)), JSON.stringify(graph.interpretation.optimizations));
  });

  it("keeps the one-shot when the composite does not beat it by the multi-signature margin", async () => {
    configureRouteShapes("compare");
    routeScripts.relay = { bps: 9_982 };
    const graph = await planIntent(USDC_TO_SOL);
    assert.equal(shape(graph), "bridge@base>solana:relay");
    assert.equal(graph.interpretation.routes?.[0]?.shape, "one-shot");
  });

  it("restricts to single-signature shapes for routeShapes 'single' and 'fewest-signatures'", async () => {
    configureRouteShapes("compare");
    for (const constraints of [{ routeShapes: "single" }, { routePreference: "fewest-signatures" }]) {
      const graph = await planIntent({ ...USDC_TO_SOL, constraints });
      assert.equal(shape(graph), "bridge@base>solana:relay", JSON.stringify(constraints));
    }
  });

  it("never picks a shape that swaps on arrival where the person holds no gas", async () => {
    configureRouteShapes("compare");
    configureGasReserveReader(async (network) => (network === "solana" ? { ...FUNDED_GAS_FACTS, balance: 0n } : FUNDED_GAS_FACTS));
    const graph = await planIntent(USDC_TO_SOL);
    assert.equal(shape(graph), "bridge@base>solana:relay", "the one-shot delivers SOL itself");
    assert.ok(graph.interpretation.routes?.[0]?.compared.some((entry) => entry.excluded === "needs gas on solana"), JSON.stringify(graph.interpretation.routes?.[0]?.compared));
  });

  it("plans the runner-up when the winner's real quote falls more than 10 bps below it", async () => {
    configureRouteShapes("compare");
    // Pre-screen: Jupiter quotes 0.1 % below fair; the real plan of the swap leg then quotes 5 % below.
    routeScripts.jupiter = { bps: 9_990, sequence: [9_990, 9_500] };
    const graph = await planIntent(USDC_TO_SOL);
    assert.equal(shape(graph), "bridge@base>solana:relay");
    assert.equal(graph.interpretation.optimizations?.some((note) => /via USDC/u.test(note)) ?? false, false);
  });

  it("chooses between the merged one-shot and the steps as written (full-output merge rule)", async () => {
    configureRouteShapes("compare");
    const written = await planIntent({ text: "bridge 1000 usdc from base to solana then swap it to sol", accounts: ACCOUNTS });
    assert.equal(shape(written), "bridge@base>solana:cctp-v2 | swap@solana:jupiter", "as written beats the 1 % one-shot");
    assert.equal(written.interpretation.routes?.[0]?.shape, "bridge-swap");
    assert.equal(written.interpretation.optimizations?.some((note) => note.startsWith("Merged")) ?? false, false);
    routeScripts.relay = { bps: 10_000 };
    const merged = await planIntent({ text: "bridge 1000 usdc from base to solana then swap it to sol", accounts: ACCOUNTS });
    assert.equal(shape(merged), "bridge@base>solana:relay");
    assert.ok(merged.interpretation.optimizations?.some((note) => /^Merged the bridge \(action 1\) and the swap \(action 2\)/u.test(note)), JSON.stringify(merged.interpretation.optimizations));
  });

  it("never merges a partial consumer", async () => {
    configureRouteShapes("compare");
    routeScripts.relay = { bps: 10_000 };
    const graph = await planIntent({ text: "bridge 1000 usdc from base to solana then swap half to sol", accounts: ACCOUNTS });
    assert.equal(shape(graph), "bridge@base>solana:relay | swap@solana:jupiter", "two steps; the bridge auction picks its venue");
    assert.deepEqual(step(graph, "s2").funding, { from: "s1", portionBps: 5_000 });
  });

  it("refuses a later leg whose fresh quote is below its planned minimum at prepare (LEG_BELOW_PLANNED_MINIMUM)", async () => {
    configureRouteShapes("compare");
    const created = await createIntent(USDC_TO_SOL);
    assert.equal(shape(created), "bridge@base>solana:cctp-v2 | swap@solana:jupiter");
    await prepareStep(created.id, "s1");
    await submitStep(created.id, "s1", [randomEvmHash()]);
    const settled = await refreshIntent(created.id);
    assert.equal(step(settled, "s1").status, "settled");
    routeScripts.jupiter = { bps: 9_990, preparedBps: 9_700 };
    const error = await failure(prepareStep(created.id, "s2"));
    assert.equal(error.code, "LEG_BELOW_PLANNED_MINIMUM");
    assert.equal(error.status, 409);
    const details = error.details as { choices: { id: string; label: string }[]; plannedMinimum: string; quotedMinimum: string };
    assert.deepEqual(details.choices.map((choice) => choice.id), ["stop", "accept"]);
    assert.match(details.choices[0]?.label ?? "", /^Keep .* USDC on Solana/u);
    const accepted = await prepareStep(created.id, "s2", { acceptBelowPlannedMinimum: true });
    assert.equal(step(accepted.intent, "s2").status, "awaiting_signature");
  });

  it("prepares a later leg that still meets its planned minimum", async () => {
    configureRouteShapes("compare");
    const created = await createIntent(USDC_TO_SOL);
    await prepareStep(created.id, "s1");
    await submitStep(created.id, "s1", [randomEvmHash()]);
    await refreshIntent(created.id);
    const prepared = await prepareStep(created.id, "s2");
    assert.equal(step(prepared.intent, "s2").status, "awaiting_signature");
  });

  it("asks every leg with the person's account and every pre-screen request leaves the plan's contacts", async () => {
    configureRouteShapes("compare");
    const graph = await planIntent(USDC_TO_SOL);
    const planned = routeCalls.filter((call) => call.stage === "plan");
    assert.ok(planned.length >= 3, "one-shot, bridge and swap pre-screened");
    assert.ok(graph.interpretation.providersContacted?.some((contact) => contact.provider === "relay"), JSON.stringify(graph.interpretation.providersContacted));
  });
});

describe("strict-path safety net", () => {
  beforeEach(() => resetEngine());

  it("adds a crossing between dependent steps on different networks, with a note", async () => {
    const graph = await planIntent({ text: "swap 1 SOL to USDC then deposit it into aave on base", accounts: ACCOUNTS });
    assert.equal(shape(graph), "swap@solana:jupiter | bridge@solana>base:relay | deposit@base:aave-v3");
    assert.deepEqual(step(graph, "s2").funding, { from: "s1", portionBps: 10_000 });
    assert.deepEqual(step(graph, "s3").funding, { from: "s2", portionBps: 10_000 });
    assert.ok(graph.interpretation.optimizations?.includes("Added a bridge from Solana to Base between steps 1 and 2: step 2 runs on Base."), JSON.stringify(graph.interpretation.optimizations));
  });

  it("carries the step's share, not the whole output", async () => {
    const graph = await planIntent({ text: "swap 1 SOL to USDC then deposit half of it into aave on base", accounts: ACCOUNTS });
    assert.deepEqual(step(graph, "s2").funding, { from: "s1", portionBps: 5_000 });
    assert.deepEqual(step(graph, "s3").funding, { from: "s2", portionBps: 10_000 });
  });

  it("refuses, never bridges, a step that contradicts the previous bridge's destination", async () => {
    const error = await failure(planIntent({ text: "bridge 100 usdc from base to arbitrum then deposit it into aave on base", accounts: ACCOUNTS }));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.match(error.message, /Step 2 runs on Base, but step 1 bridges the funds to Arbitrum One/u);
  });

  it("runs the recipient guard before any crossing", async () => {
    const error = await failure(planIntent({
      actions: [
        { kind: "transfer", network: "base", from: "USDC", amount: "10", recipient: OTHER_EVM_ADDRESS },
        { kind: "swap", network: "solana", from: "USDC", to: "SOL", amount: "max" },
      ],
      accounts: ACCOUNTS,
      constraints: { allowCrossings: true },
    }));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    assert.match(error.message, /paid to/u);
    const text = await failure(planIntent({ text: `send 10 usdc to ${OTHER_EVM_ADDRESS} on base and swap it to eth on arbitrum`, accounts: ACCOUNTS }));
    assert.equal(text.code, "INTENT_UNSUPPORTED", "a third party's output is never replaced by the person's own funds");
  });

  it("keeps structured actions refusing a network mismatch unless allowCrossings is set", async () => {
    const actions = [
      { kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" },
      { kind: "deposit", network: "base", from: "USDC", amount: "max", protocol: "aave-v3" },
    ];
    const refused = await failure(planIntent({ actions, accounts: ACCOUNTS }));
    assert.equal(refused.code, "INTENT_UNSUPPORTED");
    assert.match(refused.message, /constraints\.allowCrossings/u);
    const crossed = await planIntent({ actions, accounts: ACCOUNTS, constraints: { allowCrossings: true } });
    assert.equal(shape(crossed), "swap@solana:jupiter | bridge@solana>base:relay | deposit@base:aave-v3");
    assert.equal(step(crossed, "s2").recipient?.endsWith(EVM_ACCOUNT.split(":")[2] as string), true, "the crossing pays the person's own account");
  });

  it("refuses a crossing back to a network the funds already left", async () => {
    const error = await failure(planIntent({
      actions: [
        { kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" },
        { kind: "swap", network: "base", toNetwork: "solana", from: "USDC", to: "USDC", amount: "max" },
      ],
      accounts: ACCOUNTS,
      constraints: { allowCrossings: true },
    }));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
  });

  it("leaves a same-network chain untouched", async () => {
    const graph = await planIntent({ text: `swap 1 SOL to USDC then send it to ${SOL_ADDRESS.slice(0, 0)}5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1`, accounts: ACCOUNTS });
    assert.equal(graph.steps.length, 2);
    assert.equal(graph.interpretation.optimizations?.some((note) => note.startsWith("Added a bridge")) ?? false, false);
  });
});
