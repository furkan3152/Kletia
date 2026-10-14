/**
 * Amount flow in the planner (journey design 4.4 and 6.1): funded steps
 * record `funding` (share and F6 gas reserve), prepare spends what landed
 * minus the reserve, the summary no longer lists the expected-minus-minimum
 * gap as money received, and `constraints.gasOnArrival` routes the first
 * eligible leg to a venue that delivers gas with the fill.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { gasReserveUnits, type IntentGraph, type IntentStep } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { runVenueAuction } from "../auction.js";
import { estimateStepFee } from "../journey/fees.js";
import { actionForStep, configureGasReserveReader, planIntent, type GasReserveFacts } from "../planner.js";
import { decodeStepRef } from "../stepRef.js";
import { ACCOUNTS, FUNDED_GAS_FACTS, OTHER_EVM_ADDRESS, resetEngine, STUB_ADAPTERS, STUB_GAS_TOPUP_UNITS, stubRelay } from "./helpers.js";

/** An account with no gas anywhere (empty wallet, 1 gwei). */
const EMPTY: GasReserveFacts = { ...FUNDED_GAS_FACTS, balance: 0n };

const SEND_IT = `bridge 0.01 ETH from base to arbitrum then send it to ${OTHER_EVM_ADDRESS}`;

/** A cross-network venue that never delivers gas (LI.FI- or deBridge-like). */
const stubBridgeNoGas: ProtocolAdapter = {
  ...stubRelay,
  id: "lifi",
  protocols: ["lifi"],
  label: "Stub LI.FI",
  supportsGasTopup: undefined,
  plan: async (action) => ({ ...(await stubRelay.plan({ ...action, gasTopupUsd: undefined } as typeof action)), protocol: "lifi" }),
};

async function planError(input: unknown): Promise<PlatformError> {
  try {
    await planIntent(input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error;
  }
  assert.fail("planning succeeded but should have failed");
}

function step(graph: IntentGraph, id: string): IntentStep {
  const found = graph.steps.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

beforeEach(() => {
  resetEngine();
});

describe("funded steps: funding record and the F6 gas reserve", () => {
  it("E1: keeps a gas reserve from bridged ETH that a third-party send would otherwise spend entirely", async () => {
    configureGasReserveReader(async () => EMPTY);
    const graph = await planIntent({ text: SEND_IT, accounts: ACCOUNTS });
    const [s1, s2] = [step(graph, "s1"), step(graph, "s2")];
    const fee = estimateStepFee({ kind: "transfer", network: "arbitrum", protocol: s2.protocol, input: { asset: "eip155:42161/slip44:60" } }, { gasPriceWei: 1_000_000_000n });
    const reserve = gasReserveUnits(BigInt(fee.amount as string));
    assert.equal(reserve, 65_000_000_000_000n, "2 x 32,500 gas (native transfer x 1.5 + Arbitrum L1 part) at 1 gwei");
    assert.deepEqual(s2.funding, {
      from: "s1",
      portionBps: 10_000,
      gasReserve: { asset: "eip155:42161/slip44:60", symbol: "ETH", decimals: 18, amount: reserve.toString(), formatted: "0.000065" },
    });
    // Planned on the floor minus the reserve; the quote, preview and Rule Book see that amount.
    assert.equal(BigInt(s2.input?.amount ?? "0"), BigInt(s1.minimumOutput?.amount ?? "0") - reserve);
    assert.equal(decodeStepRef(s2.quoteRef)?.plannedInput, s2.input?.amount);
    const line = "Keeps 0.000065 ETH of what arrives for network fees on Arbitrum One.";
    assert.ok(s2.warnings?.includes(line), "step warning");
    assert.ok(graph.warnings.includes(line), "committed in the plan record");
    assert.ok(graph.plan?.record.warnings.includes(line));

    // Prepare spends what landed minus the reserve (the third-party cap is the planned input plus slippage).
    const landed = BigInt(s1.minimumOutput?.amount ?? "0") + 1_000n;
    const settled: IntentGraph = { ...graph, steps: [{ ...s1, status: "settled", actualOutput: { ...(s1.minimumOutput as NonNullable<IntentStep["minimumOutput"]>), amount: landed.toString() } }, s2] };
    assert.equal(actionForStep(settled, s2).amount, (landed - reserve).toString());
    // A fill that covers only the reserve leaves nothing to send.
    const tiny: IntentGraph = { ...settled, steps: [{ ...(settled.steps[0] as IntentStep), actualOutput: { ...(s1.minimumOutput as NonNullable<IntentStep["minimumOutput"]>), amount: reserve.toString() } }, s2] };
    assert.throws(() => actionForStep(tiny, s2), (error: unknown) => error instanceof PlatformError && error.code === "AMOUNT_TOO_SMALL" && /0\.000065 ETH for network fees/u.test(error.message));
  });

  it("keeps no reserve when the account already holds enough gas there, and counts an unreadable balance as zero", async () => {
    configureGasReserveReader(async () => FUNDED_GAS_FACTS);
    const funded = await planIntent({ text: SEND_IT, accounts: ACCOUNTS });
    assert.deepEqual(step(funded, "s2").funding, { from: "s1", portionBps: 10_000 });
    assert.equal(step(funded, "s2").input?.amount, step(funded, "s1").minimumOutput?.amount);
    configureGasReserveReader(async () => { throw new Error("rpc down"); });
    const unread = await planIntent({ text: SEND_IT, accounts: ACCOUNTS });
    assert.ok(step(unread, "s2").funding?.gasReserve, "fail closed: a failed read keeps the reserve");
  });

  it("refuses a plan whose reserve would take a quarter or more of what arrives", async () => {
    configureGasReserveReader(async () => EMPTY);
    const error = await planError({ text: `bridge 0.0002 ETH from base to arbitrum then send it to ${OTHER_EVM_ADDRESS}`, accounts: ACCOUNTS });
    assert.equal(error.code, "AMOUNT_TOO_SMALL");
    assert.match(error.message, /would mostly pay network fees on Arbitrum One/u);
  });

  it("E2: records the share of a split ('half') and keeps no reserve for a token input", async () => {
    configureGasReserveReader(async () => EMPTY);
    const graph = await planIntent({ text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS });
    const s2 = step(graph, "s2");
    assert.deepEqual(s2.funding, { from: "s1", portionBps: 5_000 });
    assert.equal(s2.input?.amount, (BigInt(step(graph, "s1").minimumOutput?.amount ?? "0") / 2n).toString());
    assert.equal(step(graph, "s1").funding, undefined, "the first step is funded by the wallet");
  });
});

describe("summary", () => {
  it("does not list the gap between expected and minimum as money left at a stop spent in full", async () => {
    const graph = await planIntent({ text: "bridge 100 USDC from base to arbitrum and deposit it into aave", accounts: ACCOUNTS });
    const s1 = step(graph, "s1");
    assert.notEqual(s1.expectedOutput?.amount, s1.minimumOutput?.amount, "the stub quotes a floor below the expected output");
    assert.equal(graph.summary.outputs.some((output) => output.asset === s1.expectedOutput?.asset), false, JSON.stringify(graph.summary.outputs));
    assert.ok(graph.summary.outputs.some((output) => output.symbol === "aUSDC"));
  });

  it("lists the kept half of a split and the reserve as what stays", async () => {
    const half = await planIntent({ text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS });
    const expected = BigInt(step(half, "s1").expectedOutput?.amount ?? "0");
    const kept = half.summary.outputs.find((output) => output.asset === step(half, "s1").expectedOutput?.asset);
    assert.equal(kept?.amount, (expected - expected / 2n).toString());
    configureGasReserveReader(async () => EMPTY);
    const reserved = await planIntent({ text: SEND_IT, accounts: ACCOUNTS });
    // What stays on Arbitrum: the reserve plus what the third-party cap (planned input + slippage) leaves of the expected output.
    const s2 = step(reserved, "s2");
    const arriving = BigInt(step(reserved, "s1").expectedOutput?.amount ?? "0");
    const cap = (BigInt(s2.input?.amount ?? "0") * 10_050n) / 10_000n;
    const stays = reserved.summary.outputs.find((output) => output.asset === "eip155:42161/slip44:60" && output.amount !== s2.expectedOutput?.amount);
    assert.equal(stays?.amount, (arriving - cap).toString(), JSON.stringify(reserved.summary.outputs));
    assert.ok(BigInt(stays?.amount ?? "0") >= 65_000_000_000_000n, "the reserve stays with the user");
  });
});

describe("gas on arrival (constraints.gasOnArrival)", () => {
  it("asks the first eligible leg for a top-up, records it and re-asks it at prepare", async () => {
    const graph = await planIntent({ text: "bridge 100 USDC from base to arbitrum", accounts: ACCOUNTS, constraints: { gasOnArrival: { arbitrum: "0.50" } } });
    const s1 = step(graph, "s1");
    assert.deepEqual(s1.gasTopup, { asset: "eip155:42161/slip44:60", symbol: "ETH", decimals: 18, amount: STUB_GAS_TOPUP_UNITS, formatted: "0.0002", usd: 0.5 });
    assert.equal(decodeStepRef(s1.quoteRef)?.gasTopupUsd, "0.50");
    assert.equal(actionForStep(graph, s1).gasTopupUsd, "0.50", "prepare asks the same top-up");
    const line = "Includes a gas top-up of 0.0002 ETH (about $0.50) on Arbitrum One, delivered with the Relay fill.";
    assert.ok(graph.warnings.includes(line), JSON.stringify(graph.warnings));
    // Opt-in: without the constraint nothing is asked.
    const plain = await planIntent({ text: "bridge 100 USDC from base to arbitrum", accounts: ACCOUNTS });
    assert.equal(step(plain, "s1").gasTopup, undefined);
    assert.equal(actionForStep(plain, step(plain, "s1")).gasTopupUsd, undefined);
  });

  it("keeps only venues that deliver gas for that leg: the auction drops the others, and none left is GAS_TOPUP_UNAVAILABLE", async () => {
    configureAdapters([...STUB_ADAPTERS, stubBridgeNoGas]);
    const graph = await planIntent({ text: "bridge 100 USDC from base to arbitrum", accounts: ACCOUNTS, constraints: { gasOnArrival: { arbitrum: "0.50" } } });
    assert.equal(step(graph, "s1").protocol, "relay");
    assert.equal(step(graph, "s1").evidence.some((entry) => /LI\.FI/u.test(entry.detail ?? "")), false, "LI.FI never competed");
    const avoided = await planError({ text: "bridge 100 USDC from base to arbitrum", accounts: ACCOUNTS, constraints: { gasOnArrival: { arbitrum: "0.50" }, avoidProtocols: ["relay"] } });
    assert.equal(avoided.code, "GAS_TOPUP_UNAVAILABLE");
    assert.match(avoided.message, /Arbitrum One.*avoidProtocols excludes Relay/u);
    // The auction itself refuses a top-up leg without an eligible venue.
    const action = actionForStep(graph, step(graph, "s1"));
    await assert.rejects(runVenueAuction([stubBridgeNoGas], action, { maxSeconds: 600, explicitMaxSeconds: false, prefer: [] }), (error: unknown) => error instanceof PlatformError && error.code === "GAS_TOPUP_UNAVAILABLE");
    // A venue that ignores the top-up it was asked for is never kept.
    const silent: ProtocolAdapter = { ...stubRelay, plan: async (input) => stubRelay.plan({ ...input, gasTopupUsd: undefined } as typeof input) };
    await assert.rejects(runVenueAuction([silent], action, { maxSeconds: 600, explicitMaxSeconds: false, prefer: [] }), (error: unknown) => error instanceof PlatformError && error.code === "PROVIDER_TRANSACTION_INVALID");
  });

  it("refuses a named network no leg arrives on, and a leg that pays another account", async () => {
    const none = await planError({ text: "bridge 50 USDC from arbitrum to solana", accounts: ACCOUNTS, constraints: { gasOnArrival: { base: "0.50" } } });
    assert.equal(none.code, "INVALID_REQUEST");
    assert.match(none.message, /No leg of this intent arrives on Base/u);
    assert.equal(none.issues?.[0]?.path, "constraints.gasOnArrival.base");
    const third = await planError({
      actions: [{ kind: "bridge", network: "base", from: "USDC", amount: "25", toNetwork: "arbitrum", recipient: OTHER_EVM_ADDRESS }],
      accounts: ACCOUNTS,
      constraints: { gasOnArrival: { arbitrum: "0.50" } },
    });
    assert.equal(third.code, "INVALID_REQUEST");
    assert.match(third.message, /pays another account/u);
    // A Solana key never reaches the planner (EVM networks only).
    assert.equal((await planError({ text: "bridge 50 USDC from base to solana", accounts: ACCOUNTS, constraints: { gasOnArrival: { solana: "0.50" } } })).code, "INVALID_REQUEST");
  });

  it("adds no top-up to a leg that delivers the gas asset itself (with a warning)", async () => {
    const graph = await planIntent({ text: "bridge 0.01 ETH from base to arbitrum", accounts: ACCOUNTS, constraints: { gasOnArrival: { arbitrum: "0.50" } } });
    assert.equal(step(graph, "s1").gasTopup, undefined);
    assert.ok(graph.warnings.includes("No gas top-up on Arbitrum One: the leg arriving there delivers ETH itself."), JSON.stringify(graph.warnings));
  });
});
