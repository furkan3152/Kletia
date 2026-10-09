/**
 * Custom contract calls end to end against the offline EVM world: plan,
 * prepare (payload shape, approvals only when short, USDT reset, ratio
 * check), the engine payload guard, simulation refusals, and verification
 * (happy path, missing event, wrong where binding, extra debit, code change
 * at the receipt block), with the registration suspended on anomalies.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import { CONTRACT_REVIEW_NOTICE, CUSTOM_CONTRACT_WARNING, parseAccountId, type EvmContractAction, type EvmTransactionRequest, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { testEvmCall } from "../adapters/contractCall.js";
import { assetFromRef } from "../assets.js";
import { evmSnapshot } from "../contracts/snapshot.js";
import { assertCallPayload, configurePlatform, createIntent, getIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { STUB_ADAPTERS } from "./helpers.js";
import {
  allow,
  balance,
  fund,
  installDirectory,
  installEvmHarness,
  OTHER,
  OTHER_TOKEN,
  OWNER_KEY,
  registrationOf,
  SIM_URLS,
  USDC_BASE,
  USER,
  VAULT,
  vaultDefinitionBody,
  type EvmHarness,
  type MemoryDirectory,
  type Registration,
} from "./contractHarness.js";

const ACCOUNT = `eip155:8453:${USER}`;
const SHARES_PER_USDC = 906_050_000_000n;

let harness: EvmHarness;
let directory: MemoryDirectory;
let registration: Registration;

async function registerVault(body = vaultDefinitionBody(), options: Partial<Registration> = {}): Promise<Registration> {
  registration = directory.add(await registrationOf(body, options));
  return registration;
}

function callAction(amount = "100", extra: Record<string, unknown> = {}) {
  return { kind: "call", network: "base", contract: registration.id, entry: "deposit", amount, ...extra };
}

async function plan(amount = "100"): Promise<IntentGraph> {
  return createIntent({ accounts: [ACCOUNT], actions: [callAction(amount)] }, { ownerKeyId: OWNER_KEY });
}

function rejects(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof PlatformError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  };
}

beforeEach(async () => {
  harness = installEvmHarness();
  directory = installDirectory();
  configurePlatform({ store: new MemoryIntentStore(), adapters: STUB_ADAPTERS, contracts: directory });
  fund(harness.world, USDC_BASE, USER, 1_000_000_000n);
  await registerVault();
});

afterEach(() => {
  harness.restore();
  configurePlatform({ contracts: null });
});

describe("custom call: plan", () => {
  it("plans a simulated call step with the snapshot, review and custom-contract warning", async () => {
    const graph = await plan();
    const step = graph.steps[0]!;
    assert.equal(step.kind, "call");
    assert.equal(step.protocol, "custom-call");
    assert.equal(step.title, "Deposit into Acme USDC vault · Acme Yield");
    assert.equal(step.input?.amount, "100000000");
    assert.equal(step.expectedOutput?.amount, (100_000_000n * SHARES_PER_USDC).toString());
    assert.equal(step.minimumOutput?.amount, ((100_000_000n * SHARES_PER_USDC * 9_990n) / 10_000n).toString());
    assert.equal(step.expectedOutput?.symbol, "steakUSDC");
    assert.ok(graph.warnings.includes(CUSTOM_CONTRACT_WARNING));
    const call = step.call!;
    assert.equal(call.contract, registration.id);
    assert.equal(call.selector, "0x6e553f65");
    assert.equal(call.approvalSpender, VAULT);
    assert.equal(call.events?.[0]?.emitter, VAULT);
    assert.deepEqual(call.pins, registration.pins);
    assert.equal(call.review.simulation.status, "ok");
    assert.equal(call.review.notices[0], CONTRACT_REVIEW_NOTICE);
    assert.deepEqual(call.review.simulation.assetChanges.map((change) => [change.symbol, change.delta]), [
      ["USDC", "-100000000"],
      ["steakUSDC", (100_000_000n * SHARES_PER_USDC).toString()],
    ]);
    assert.equal(call.review.approvals[0]?.amount.formatted, "100");
    assert.ok(JSON.stringify(call).length < 6_000, `snapshot is ${JSON.stringify(call).length} bytes`);
  });

  it("simulates an unfunded plan with a balance override (slot 9) and says so", async () => {
    fund(harness.world, USDC_BASE, USER, 0n);
    const graph = await plan();
    const review = graph.steps[0]!.call!.review;
    assert.equal(review.simulation.status, "ok");
    assert.ok(review.simulation.warnings.some((warning) => /credited to the account/u.test(warning)));
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("INSUFFICIENT_BALANCE"));
  });

  it("plans with a warning when no endpoint can simulate, and prepare then refuses", async () => {
    harness.world.simulateErrors.add(SIM_URLS[0] as string);
    harness.world.simulateErrors.add(SIM_URLS[1] as string);
    const graph = await plan();
    const step = graph.steps[0]!;
    assert.equal(step.call?.review.simulation.status, "unavailable");
    assert.equal(step.expectedOutput, undefined);
    assert.ok(step.warnings?.some((warning) => /Simulation was unavailable/u.test(warning)));
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("SIMULATION_UNAVAILABLE"));
  });

  it("refuses simulated outcomes that break the asset rules", async () => {
    harness.world.vault.stealOther = 5n;
    fund(harness.world, OTHER_TOKEN, USER, 10n);
    await assert.rejects(plan(), rejects("SIMULATION_ASSET_CHANGE_REFUSED"));
    harness.world.vault.stealOther = 0n;
    harness.world.vault.extraPull = -1n;
    await assert.rejects(plan(), (error: unknown) => rejects("SIMULATION_ASSET_CHANGE_REFUSED")(error) && /allowance|not exactly/u.test((error as Error).message));
    harness.world.vault.extraPull = 1n;
    await assert.rejects(plan(), (error: unknown) => rejects("SIMULATION_FAILED")(error) && /exceeds allowance/u.test((error as Error).message));
    harness.world.vault.extraPull = 0n;
    harness.world.vault.noShares = true;
    await assert.rejects(plan(), (error: unknown) => rejects("SIMULATION_ASSET_CHANGE_REFUSED")(error) && /not credited/u.test((error as Error).message));
    harness.world.vault.noShares = false;
    harness.world.vault.silentMint = true;
    await assert.rejects(plan(), (error: unknown) => rejects("SIMULATION_ASSET_CHANGE_REFUSED")(error) && /Transfer events/u.test((error as Error).message));
    harness.world.vault.silentMint = false;
    harness.world.vault.revert = "Paused";
    await assert.rejects(plan(), (error: unknown) => rejects("SIMULATION_FAILED")(error) && /Paused/u.test((error as Error).message));
  });

  it("refuses a contract whose code changed since registration and suspends it", async () => {
    harness.world.code.set(VAULT.toLowerCase(), "0x60806040520000");
    await assert.rejects(plan(), rejects("CONTRACT_CHANGED"));
    assert.equal(directory.anomalies[0]?.reason, "pins_changed");
    assert.equal(registration.status, "suspended");
    await assert.rejects(plan(), rejects("CONTRACT_SUSPENDED"));
  });
});

describe("custom call: prepare", () => {
  it("prepares an exact approval and the call, with simulated gas and the fresh review", async () => {
    const graph = await plan();
    const { intent, payload } = await prepareStep(graph.id, "s1");
    assert.equal(payload.transactions.length, 2);
    const [approve, call] = payload.transactions as EvmTransactionRequest[];
    assert.equal(approve?.to, USDC_BASE);
    assert.equal(approve?.data, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, 100_000_000n] }));
    assert.equal(call?.to, VAULT);
    assert.equal(call?.data.slice(0, 10), "0x6e553f65");
    assert.equal(call?.value, "0");
    assert.equal(call?.gas, ((379_971n * 12_500n) / 10_000n + 25_000n).toString());
    assert.equal(payload.review?.simulation.status, "ok");
    assert.deepEqual(intent.steps[0]?.call?.review, payload.review);
    assert.equal(intent.steps[0]?.status, "awaiting_signature");
    assert.equal(directory.spends.length, 1);
    assert.equal(directory.spends[0]?.usd, 100);
    await prepareStep(graph.id, "s1");
    assert.equal(directory.spends.length, 1, "re-prepares do not count the daily notional again");
  });

  it("skips the approval only for an allowance of exactly the amount, and lowers a larger one", async () => {
    allow(harness.world, USDC_BASE, USER, VAULT, 100_000_000n);
    const exact = await prepareStep((await plan()).id, "s1");
    assert.equal(exact.payload.transactions.length, 1);
    assert.deepEqual(exact.payload.review?.approvals, []);
    allow(harness.world, USDC_BASE, USER, VAULT, 2n ** 256n - 1n);
    const lowered = await prepareStep((await plan()).id, "s1");
    const [approve] = lowered.payload.transactions as EvmTransactionRequest[];
    assert.equal(approve?.data, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, 100_000_000n] }));
    assert.equal(lowered.payload.review?.approvals[0]?.existingAllowance?.amount, (2n ** 256n - 1n).toString());
  });

  it("resets a USDT-style allowance to 0 before the exact approval", async () => {
    // Ethereum USDT (APPROVAL_RESET_TOKENS) is not a registry input in v1, so the adapter is driven directly.
    const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    harness.world.tokens.set(USDT.toLowerCase(), { symbol: "USDT", decimals: 6, slot: 2, layout: "solidity" });
    harness.world.vaultAsset = USDT;
    fund(harness.world, USDT, USER, 1_000_000_000n);
    allow(harness.world, USDT, USER, VAULT, 5n);
    const entry = registration.definition.actions[0] as EvmContractAction;
    const input = assetFromRef({ asset: `eip155:1/erc20:${USDT}`, symbol: "USDT", decimals: 6 });
    const output = assetFromRef({ asset: `eip155:1/erc20:${VAULT}`, symbol: "steakUSDT", decimals: 18 });
    const snapshot = evmSnapshot(registration, entry, {}, output);
    const account = parseAccountId(`eip155:1:${USER}`)!;
    const run = await testEvmCall({
      kind: "call", network: "ethereum", destinationNetwork: "ethereum", input, output, amount: "100000000", account, recipient: account, slippageBps: 50,
      call: { snapshot, input, output, registration, funded: false, stage: "prepare" },
    }, Date.now());
    const datas = run.transactions.map((transaction) => transaction.data);
    assert.equal(datas.length, 3);
    assert.equal(datas[0], encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, 0n] }));
    assert.equal(datas[1], encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, 100_000_000n] }));
    assert.equal(run.review.approvals[0]?.existingAllowance?.amount, "5");
    assert.equal(run.review.simulation.status, "ok");
  });

  it("refuses a prepare whose rate fell below the planned guarantee (QUOTE_MOVED)", async () => {
    const graph = await plan();
    harness.world.vault.sharesPerAsset = (SHARES_PER_USDC * 9_980n) / 10_000n;
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("QUOTE_MOVED"));
    harness.world.vault.sharesPerAsset = (SHARES_PER_USDC * 9_995n) / 10_000n;
    const { payload } = await prepareStep(graph.id, "s1");
    assert.equal(payload.transactions.length, 2, "within tolerance it prepares");
  });

  it("re-reads pins fresh at prepare and refuses a change", async () => {
    const graph = await plan();
    harness.world.code.set(VAULT.toLowerCase(), "0x60806040520000");
    await assert.rejects(prepareStep(graph.id, "s1"), rejects("CONTRACT_CHANGED"));
    assert.equal(registration.status, "suspended");
  });
});

describe("engine payload guard (assertCallPayload)", () => {
  it("accepts the prepared payload and refuses any tampering", async () => {
    const graph = await plan();
    const { intent, payload } = await prepareStep(graph.id, "s1");
    const step = intent.steps[0]!;
    const transactions = payload.transactions as EvmTransactionRequest[];
    const input = step.input;
    const guard = (list: EvmTransactionRequest[], amount = input) => assertCallPayload(step, { transactions: list, ...(amount ? { input: amount } : {}) });
    guard(transactions);
    const [approve, call] = transactions as [EvmTransactionRequest, EvmTransactionRequest];
    const bad: [string, EvmTransactionRequest[]][] = [
      ["target", [approve, { ...call, to: OTHER }]],
      ["selector", [approve, { ...call, data: `0x095ea7b3${call.data.slice(10)}` }]],
      ["trailing data", [approve, { ...call, data: `${call.data}00` }]],
      ["amount", [approve, { ...call, data: encodeFunctionData({ abi: [{ type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "a", type: "uint256" }, { name: "r", type: "address" }], outputs: [] }], functionName: "deposit", args: [200_000_000n, getAddress(USER)] }) }]],
      ["value", [approve, { ...call, value: "1" }]],
      ["extra transaction", [approve, approve, approve, call]],
      ["spender", [{ ...approve, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(OTHER), 100_000_000n] }) }, call]],
      ["approval amount", [{ ...approve, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [VAULT, 2n ** 256n - 1n] }) }, call]],
      ["approval token", [{ ...approve, to: OTHER_TOKEN }, call]],
      ["approval value", [{ ...approve, value: "1" }, call]],
    ];
    for (const [what, list] of bad) {
      assert.throws(() => guard(list), (error: unknown) => error instanceof PlatformError && error.code === "PAYLOAD_INVALID", what);
    }
  });
});

describe("custom call: verify", () => {
  async function prepared() {
    const graph = await plan();
    const result = await prepareStep(graph.id, "s1");
    return { graph, transactions: result.payload.transactions as EvmTransactionRequest[] };
  }

  it("confirms the landed deposit from its event, deltas and pins at the receipt block", async () => {
    const { graph, transactions } = await prepared();
    const hashes = harness.land(transactions);
    const intent = await submitStep(graph.id, "s1", hashes);
    const step = intent.steps[0]!;
    assert.equal(step.status, "settled", JSON.stringify(step.failure ?? step.evidence.slice(-2)));
    assert.equal(step.actualOutput?.amount, (100_000_000n * SHARES_PER_USDC).toString());
    assert.ok(step.evidence.some((entry) => /declared event observed/u.test(entry.detail ?? "")));
    assert.ok(step.evidence.some((entry) => /matched its pins at block/u.test(entry.detail ?? "")));
    assert.equal(balance(harness.world, VAULT, USER), 100_000_000n * SHARES_PER_USDC);
    assert.equal(directory.anomalies.length, 0);
  });

  it("fails without the declared event and suspends the registration", async () => {
    const { graph, transactions } = await prepared();
    const hashes = harness.land(transactions, { logs: (index, logs) => (index === 1 ? logs.filter((log) => log.address !== VAULT.toLowerCase() || log.topics.length !== 3 || !log.topics[0]?.startsWith("0xdcbc")) : logs) });
    const step = (await submitStep(graph.id, "s1", hashes)).steps[0]!;
    assert.equal(step.status, "failed");
    assert.equal(step.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.equal(directory.anomalies[0]?.reason, "outcome_mismatch");
    assert.equal(registration.status, "suspended");
  });

  it("fails when the event names someone else (where binding)", async () => {
    const { graph, transactions } = await prepared();
    harness.world.vault.depositOwner = OTHER;
    const step = (await submitStep(graph.id, "s1", harness.land(transactions))).steps[0]!;
    assert.equal(step.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(step.failure?.message ?? "", /event/u);
  });

  it("fails on an extra debit of the user that simulation did not show", async () => {
    const { graph, transactions } = await prepared();
    fund(harness.world, OTHER_TOKEN, USER, 10n);
    harness.world.vault.stealOther = 3n;
    const step = (await submitStep(graph.id, "s1", harness.land(transactions))).steps[0]!;
    assert.equal(step.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(step.failure?.message ?? "", /another token/u);
    assert.equal(directory.anomalies[0]?.reason, "outcome_mismatch");
  });

  it("fails when the output is below the guaranteed minimum", async () => {
    const { graph, transactions } = await prepared();
    harness.world.vault.sharesPerAsset = SHARES_PER_USDC / 2n;
    const step = (await submitStep(graph.id, "s1", harness.land(transactions))).steps[0]!;
    assert.equal(step.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(step.failure?.message ?? "", /below the guaranteed/u);
  });

  it("moves the step to indeterminate when the code differed at the receipt block", async () => {
    const { graph, transactions } = await prepared();
    const hashes = harness.land(transactions);
    const block = harness.world.blockNumber + 11n;
    harness.world.codeAt.set(`${block}:${VAULT.toLowerCase()}`, "0x60806040529999");
    const intent = await submitStep(graph.id, "s1", hashes);
    const step = intent.steps[0]!;
    assert.equal(step.status, "indeterminate");
    assert.equal(step.failure?.code, "CONTRACT_CHANGED_DURING_EXECUTION");
    assert.equal(directory.anomalies[0]?.reason, "pins_changed");
    const again = (await getIntent(graph.id)).steps[0]!;
    assert.equal(again.status, "indeterminate");
  });

  it("rejects references that are not the prepared transactions", async () => {
    const { graph, transactions } = await prepared();
    const other = harness.land([transactions[0]!, { ...transactions[1]!, to: USDC_BASE, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(OTHER), 1n] }) }]);
    await assert.rejects(submitStep(graph.id, "s1", other), rejects("REFERENCE_MISMATCH"));
    assert.equal(directory.anomalies.length, 0);
  });
});
