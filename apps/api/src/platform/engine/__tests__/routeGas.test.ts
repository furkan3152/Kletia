/**
 * Gas on every network that signs later (design C.3, red-team C1, D3): the
 * gas plan per network after earlier legs, top-ups that cover it, the
 * GAS_TOPUP_UNAVAILABLE refusal with seam S7 details, Solana destinations
 * without a top-up, the gas asset itself arriving (F6 reserve), unreadable
 * balances (a warning, never a refusal), and deBridge DLN legs that need gas
 * on the destination for a possible cancel.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { NetworkKey } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configureGasReserveReader, planIntent, type GasReserveFacts } from "../planner.js";
import { arrivalGasState, planGas, stepGasUnits, type GasPlanFacts, type GasPlanStep } from "../routing/gasPlan.js";
import { ACCOUNTS, FUNDED_GAS_FACTS, resetEngine } from "./helpers.js";
import { resetVenueEngine, venueScripts } from "./venueStubs.js";

async function failure(promise: Promise<unknown>): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

/** Gas facts per network: funded everywhere except the listed networks. */
function gasOn(overrides: Partial<Record<NetworkKey, Partial<GasReserveFacts> | "fail">>): void {
  configureGasReserveReader(async (network) => {
    const entry = overrides[network];
    if (entry === "fail") throw new Error("rpc down");
    return { ...FUNDED_GAS_FACTS, ...(entry ?? {}) };
  });
}

const EMPTY_CHEAP: Partial<GasReserveFacts> = { balance: 0n, gasPriceWei: 10_000_000n };

describe("planGas (pure)", () => {
  const facts = (balance: bigint | null): GasPlanFacts => ({ balance, gasPriceWei: 1_000_000_000n, tokenAccountRentLamports: 2_039_280n });
  const bridge: GasPlanStep = { index: 0, network: "base", kind: "bridge", protocol: "relay", transactions: 1, arrives: { network: "arbitrum", native: false } };
  const deposit: GasPlanStep = { index: 1, network: "arbitrum", kind: "deposit", protocol: "aave-v3", transactions: 2 };

  it("checks only networks a crossing arrives on before the person signs there", async () => {
    const reads: NetworkKey[] = [];
    const none = await planGas([{ ...bridge, arrives: undefined }, deposit], async (network) => {
      reads.push(network);
      return facts(0n);
    });
    assert.deepEqual(none.shortfalls, []);
    assert.deepEqual(reads, [], "no arrival: nothing to check");
    const short = await planGas([bridge, deposit], async () => facts(0n));
    assert.equal(short.shortfalls.length, 1);
    assert.equal(short.shortfalls[0]?.network, "arbitrum");
    assert.deepEqual(short.shortfalls[0]?.steps, [1]);
    assert.equal(short.shortfalls[0]?.needUnits, stepGasUnits(deposit, facts(0n)));
    assert.equal(short.shortfalls[0]?.haveUnits, 0n);
  });

  it("counts a planned top-up and the gas asset arriving, and reports unreadable balances", async () => {
    const need = stepGasUnits(deposit, facts(0n));
    const topped = await planGas([{ ...bridge, arrives: { network: "arbitrum", native: false, topupUnits: need } }, deposit], async () => facts(0n));
    assert.deepEqual(topped.shortfalls, []);
    const native = await planGas([{ ...bridge, arrives: { network: "arbitrum", native: true } }, deposit], async () => facts(0n));
    assert.deepEqual(native.shortfalls, [], "the funded step keeps its F6 reserve from what arrives");
    const unread = await planGas([bridge, deposit], async () => facts(null));
    assert.deepEqual(unread.shortfalls, []);
    assert.equal(unread.unknown[0]?.network, "arbitrum");
  });

  it("states arrival gas for the composer: ok, short, unknown, or ok with a top-up", async () => {
    assert.equal(await arrivalGasState("solana", async () => facts(10n ** 12n), false), "ok");
    assert.equal(await arrivalGasState("solana", async () => facts(0n), false), "short");
    assert.equal(await arrivalGasState("solana", async () => facts(null), false), "unknown");
    assert.equal(await arrivalGasState("base", async () => facts(0n), true), "ok");
  });
});

describe("gas plan in the planner", () => {
  beforeEach(() => resetEngine());

  it("refuses a later step on an EVM network without gas, with S7 details", async () => {
    gasOn({ arbitrum: EMPTY_CHEAP });
    const error = await failure(planIntent({ text: "bridge 100 USDC from base to arbitrum then deposit it into aave", accounts: ACCOUNTS }));
    assert.equal(error.code, "GAS_TOPUP_UNAVAILABLE");
    assert.equal(error.issues?.[0]?.path, "constraints.gasOnArrival.arbitrum");
    const details = error.details as { network: string; needUnits: string; haveUnits: string };
    assert.equal(details.network, "arbitrum");
    assert.ok(BigInt(details.needUnits) > 0n);
    assert.equal(details.haveUnits, "0");
    assert.match(error.message, /Step 2 must be signed on Arbitrum One/u);
    assert.match(error.message, /constraints\.gasOnArrival\.arbitrum/u);
  });

  it("plans it when the arriving leg carries a gas top-up", async () => {
    gasOn({ arbitrum: EMPTY_CHEAP });
    const graph = await planIntent({ text: "bridge 100 USDC from base to arbitrum then deposit it into aave", accounts: ACCOUNTS, constraints: { gasOnArrival: { arbitrum: "0.50" } } });
    assert.ok(graph.steps[0]?.gasTopup, "the bridge delivers gas");
    assert.equal(graph.steps.length, 2);
  });

  it("refuses a Solana destination without SOL: no venue delivers gas there", async () => {
    gasOn({ solana: { balance: 0n } });
    const error = await failure(planIntent({ text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS }));
    assert.equal(error.code, "GAS_TOPUP_UNAVAILABLE");
    assert.equal((error.details as { network: string }).network, "solana");
    assert.match(error.message, /No venue delivers gas there/u);
  });

  it("plans when the gas asset itself arrives (the funded step keeps its reserve)", async () => {
    gasOn({ arbitrum: { balance: 0n, gasPriceWei: 1_000_000_000n } });
    const graph = await planIntent({ text: "bridge 0.1 ETH from base to arbitrum then swap half to USDC", accounts: ACCOUNTS });
    assert.equal(graph.steps.length, 2);
    assert.ok(graph.steps[1]?.funding?.gasReserve, "F6 keeps gas from what arrives");
  });

  it("warns, never refuses, when the balance cannot be read", async () => {
    gasOn({ arbitrum: "fail" });
    const graph = await planIntent({ text: "bridge 100 USDC from base to arbitrum then deposit it into aave", accounts: ACCOUNTS });
    assert.ok(graph.warnings.some((warning) => /^Could not read your ETH on Arbitrum One: step 2 needs about/u.test(warning)), JSON.stringify(graph.warnings));
  });

  it("does not check a payment to someone else's account on arrival", async () => {
    gasOn({ arbitrum: { balance: 0n } });
    const graph = await planIntent({
      actions: [{ kind: "bridge", network: "base", toNetwork: "arbitrum", from: "USDC", amount: "10", recipient: "0x1111111111111111111111111111111111111111" }],
      accounts: ACCOUNTS,
    });
    assert.equal(graph.steps.length, 1);
  });
});

describe("deBridge DLN needs gas on the destination for a cancel (D3)", () => {
  beforeEach(() => {
    resetVenueEngine({ bridges: true });
    // DLN quotes the best route.
    venueScripts["debridge-dln"] = { minimumBps: 9_990, seconds: 10 };
    venueScripts.relay = { minimumBps: 9_950, seconds: 10 };
    venueScripts.lifi = { minimumBps: 9_900, seconds: 10 };
  });

  const BRIDGE = { actions: [{ kind: "bridge" as const, network: "base" as const, toNetwork: "arbitrum" as const, from: "USDC", amount: "100" }], accounts: ACCOUNTS };

  it("wins with gas there", async () => {
    gasOn({});
    const graph = await planIntent(BRIDGE);
    assert.equal(graph.steps[0]?.protocol, "debridge-dln");
  });

  it("is excluded when the destination balance is known to be short", async () => {
    gasOn({ arbitrum: { balance: 0n } });
    const graph = await planIntent(BRIDGE);
    assert.notEqual(graph.steps[0]?.protocol, "debridge-dln");
  });

  it("refuses when DLN was the only venue", async () => {
    gasOn({ arbitrum: { balance: 0n } });
    const error = await failure(planIntent({ ...BRIDGE, constraints: { avoidProtocols: ["relay", "lifi"] } }));
    assert.equal(error.code, "GAS_TOPUP_UNAVAILABLE");
    assert.equal((error.details as { network: string }).network, "arbitrum");
  });
});
