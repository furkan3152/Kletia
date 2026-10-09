/**
 * Prepare-time invariants I1-I7 (asset-preview design §5.8): each rule
 * refuses with its catalogued code and status; pinned spenders come from the
 * registry, never from the payload. Pure.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregatePreview, CHAINS, type IntentGraph, type IntentStep, type StepPreview } from "@kletia/core";
import { materialPreviewChanges } from "../preview/index.js";
import { PlatformError } from "../../errors.js";
import {
  assertInvariants,
  evmViolations,
  pinnedSpenders,
  solanaViolations,
  spenderLabel,
  type EvmEffect,
  type EvmRules,
  type InvariantViolation,
  type SolanaEffect,
} from "../preview/invariants.js";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const OTHER = "0x2222222222222222222222222222222222222222";
const DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const USER = "0x4f183e308f24c81c05303821ad025812fbfd807d";

function step(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
    id: "s1",
    index: 0,
    kind: "bridge",
    title: "Bridge",
    network: "base",
    chain: CHAINS.base.id,
    account: `eip155:8453:${USER}`,
    protocol: "relay",
    mode: "wallet",
    dependsOn: [],
    status: "awaiting_signature",
    evidence: [],
    ...overrides,
  };
}

function effect(overrides: Partial<EvmEffect> = {}): EvmEffect {
  return {
    reverted: null,
    debits: new Map([[USDC, 100_000_000n]]),
    credits: new Map(),
    net: new Map([[USDC, -100_000_000n]]),
    nativeOut: 0n,
    nativeIn: 0n,
    nftOut: [],
    approvals: [{ token: USDC, spender: DEPOSITORY, value: 100_000_000n }],
    approvalsForAll: [],
    valueTotal: 0n,
    balanceBefore: 100_000_000n,
    ...overrides,
  };
}

const rules = (overrides: Partial<EvmRules> = {}): EvmRules => ({
  step: step(),
  input: { token: USDC, amount: 100_000_000n },
  extraNative: 0n,
  minimumOutput: null,
  ready: true,
  ...overrides,
});

function refusal(violations: readonly InvariantViolation[]): PlatformError {
  try {
    assertInvariants(violations, "s1");
  } catch (error) {
    assert.ok(error instanceof PlatformError);
    return error;
  }
  assert.fail("expected a refusal");
}

describe("EVM invariants", () => {
  it("passes the probed Relay deposit (exact approval to the pinned depository, exact debit)", () => {
    assert.deepEqual(evmViolations(effect(), rules()), []);
  });

  it("I1: a reverted transaction is SIMULATION_FAILED (422)", () => {
    const found = evmViolations(effect({ reverted: "execution reverted: paused" }), rules());
    const error = refusal(found);
    assert.deepEqual([error.code, error.status], ["SIMULATION_FAILED", 422]);
    assert.match(error.message, /paused/u);
  });

  it("I2: a debit other than the step amount, or value beyond the declared costs", () => {
    assert.equal(evmViolations(effect({ debits: new Map([[USDC, 100_000_001n]]) }), rules())[0]?.rule, "I2");
    const native = rules({ input: { token: null, amount: 10n ** 16n }, extraNative: 10n ** 15n });
    const funded = { debits: new Map(), net: new Map(), approvals: [], balanceBefore: 10n ** 17n };
    assert.deepEqual(evmViolations(effect({ ...funded, valueTotal: 11n * 10n ** 15n, nativeOut: 11n * 10n ** 15n }), native), []);
    assert.equal(evmViolations(effect({ ...funded, valueTotal: 12n * 10n ** 15n, nativeOut: 12n * 10n ** 15n }), native)[0]?.rule, "I2");
    assert.equal(refusal(evmViolations(effect({ debits: new Map([[USDC, 1n]]) }), rules())).code, "SIMULATION_ASSET_CHANGE_REFUSED");
  });

  it("I3: another token, an NFT or native value leaving the user", () => {
    assert.equal(evmViolations(effect({ net: new Map([[USDC, -100_000_000n], [OTHER, -1n]]) }), rules())[0]?.rule, "I3");
    assert.equal(evmViolations(effect({ nftOut: [OTHER] }), rules())[0]?.rule, "I3");
    assert.equal(evmViolations(effect({ nativeOut: 1n }), rules())[0]?.rule, "I3");
    // A withdraw may burn the venue's position token.
    const withdraw = step({ kind: "withdraw", protocol: "aave-v3", venue: "base:aave-v3:usdc" });
    const position = "0x4e65fe4dba92790696d040ac24aa414708f5c0ab"; // aBasUSDC, the venue's receipt token
    assert.deepEqual(evmViolations(effect({ debits: new Map(), approvals: [], net: new Map([[position, -100_000_000n], [USDC, 100_000_000n]]) }), rules({ step: withdraw, input: { token: USDC, amount: 100_000_000n } })), []);
  });

  it("I4: approvals on another token, to an unpinned spender, above the amount, or for all", () => {
    assert.equal(evmViolations(effect({ approvals: [{ token: OTHER, spender: DEPOSITORY, value: 1n }] }), rules())[0]?.rule, "I4");
    assert.match(evmViolations(effect({ approvals: [{ token: USDC, spender: OTHER, value: 1n }] }), rules())[0]?.message ?? "", /not the pinned spender of Relay/u);
    assert.equal(evmViolations(effect({ approvals: [{ token: USDC, spender: DEPOSITORY, value: 100_000_001n }] }), rules())[0]?.rule, "I4");
    assert.equal(evmViolations(effect({ approvalsForAll: [{ token: OTHER }] }), rules())[0]?.rule, "I4");
  });

  it("I5: a same-network output below the guaranteed minimum is QUOTE_MOVED (409)", () => {
    const swap = rules({ step: step({ kind: "swap" }), minimumOutput: { token: OTHER, amount: 1_000n } });
    const found = evmViolations(effect({ net: new Map([[USDC, -100_000_000n], [OTHER, 999n]]) }), swap);
    const error = refusal(found);
    assert.deepEqual([error.code, error.status], ["QUOTE_MOVED", 409]);
    assert.deepEqual(evmViolations(effect({ net: new Map([[USDC, -100_000_000n], [OTHER, 1_000n]]) }), swap), []);
  });

  it("I6: an input balance short of the step is INSUFFICIENT_BALANCE (422), first", () => {
    const found = evmViolations(effect({ balanceBefore: 99n, reverted: "execution reverted: ERC20: transfer amount exceeds balance" }), rules());
    assert.deepEqual(found.map((entry) => entry.rule), ["I6", "I1"]);
    assert.deepEqual([refusal(found).code, refusal(found).status], ["INSUFFICIENT_BALANCE", 422]);
    // Funds assumed in flight are not a shortfall.
    assert.deepEqual(evmViolations(effect({ balanceBefore: 0n }), rules({ ready: false })), []);
  });

  it("leaves custom contract steps to BYOC's own rules (I1 still applies)", () => {
    const call = rules({ step: step({ kind: "call", protocol: "custom-call" }) });
    assert.deepEqual(evmViolations(effect({ approvals: [{ token: USDC, spender: OTHER, value: 10n ** 30n }] }), call), []);
    assert.equal(evmViolations(effect({ reverted: "boom" }), call)[0]?.rule, "I1");
  });

  it("labels spenders from the registry, never from the payload", () => {
    assert.equal(pinnedSpenders(step({ kind: "deposit", protocol: "aave-v3", venue: "base:aave-v3:usdc" })).get("0xa238dd80c259a72e81d7e4664a9801593f98d1c5"), "Aave V3 USDC");
    assert.equal(spenderLabel(step(), DEPOSITORY), "Relay depository");
    assert.equal(spenderLabel(step(), OTHER), "Unrecognised spender");
    assert.equal(spenderLabel(step({ protocol: "lifi" }), "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"), "LI.FI diamond");
  });
});

describe("Solana invariants", () => {
  const USER_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const solStep = step({ network: "solana", chain: CHAINS.solana.id, account: `${CHAINS.solana.id}:${USER_SOL}`, kind: "swap", protocol: "jupiter" });
  const base: SolanaEffect = { error: null, tokenDeltas: new Map([[MINT, 149_000_000n]]), solSpent: 1_000_000_000n, balanceBefore: 2_000_000_000n, tokenAccounts: [], user: USER_SOL };
  const solRules = { step: solStep, input: { mint: null, amount: 1_000_000_000n }, extraLamports: 0n, minimumOutput: { mint: MINT, amount: 148_000_000n }, ready: true };

  it("passes an exact swap", () => {
    assert.deepEqual(solanaViolations(base, solRules), []);
  });

  it("I7: a token account changing owner or gaining a delegate", () => {
    const owner = solanaViolations({ ...base, tokenAccounts: [{ account: "Acct1111111111111111111111111111111111111111", owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", delegate: null }] }, solRules);
    assert.equal(owner[0]?.rule, "I7");
    const delegate = solanaViolations({ ...base, tokenAccounts: [{ account: "Acct1111111111111111111111111111111111111111", owner: USER_SOL, delegate: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" }] }, solRules);
    assert.equal(delegate[0]?.rule, "I7");
    assert.equal(refusal(delegate).code, "SIMULATION_ASSET_CHANGE_REFUSED");
  });

  it("I1, I2, I3, I5 and I6 on Solana", () => {
    assert.equal(solanaViolations({ ...base, error: "{\"InstructionError\":[0,\"Custom\"]}" }, solRules).at(-1)?.rule, "I1");
    assert.equal(solanaViolations({ ...base, solSpent: 1_100_000_000n }, solRules)[0]?.rule, "I2");
    assert.equal(solanaViolations({ ...base, tokenDeltas: new Map([[MINT, 149_000_000n], ["So1other1111111111111111111111111111111111", -5n]]) }, solRules)[0]?.rule, "I3");
    assert.equal(solanaViolations({ ...base, tokenDeltas: new Map([[MINT, 1n]]) }, solRules)[0]?.rule, "I5");
    assert.equal(solanaViolations({ ...base, balanceBefore: 1n }, solRules)[0]?.rule, "I6");
  });
});

describe("material change at prepare", () => {
  const USER_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const account = `${CHAINS.solana.id}:${USER_SOL}`;
  const SOL = `${CHAINS.solana.id}/slip44:501`;
  const graph = {
    id: "int_0123456789abcdef0123456789abcdef",
    request: { accounts: [account] },
    steps: [{ id: "s1", account, settlement: { kind: "same-network" } }],
  } as unknown as IntentGraph;
  const amount = (value: bigint) => ({ amount: value.toString(), formatted: value.toString() });
  const step = (sol: bigint, fees: StepPreview["fees"]): StepPreview => ({
    stepId: "s1",
    network: "solana",
    kind: "swap",
    status: "simulated",
    at: "2026-10-09T00:00:00.000Z",
    deltas: [{ network: "solana", account: account as never, asset: SOL as never, symbol: "SOL", decimals: 9, listed: true, expected: amount(sol), worst: amount(sol), certainty: "simulated", steps: ["s1"], role: "you" }],
    payments: [],
    fees,
    approvals: [],
    issues: [],
  });
  const native = { asset: SOL as never, symbol: "SOL", decimals: 9 };

  it("judges network fees and account rent apart from the amounts (a quoted plan knew neither)", () => {
    const before = aggregatePreview(graph, [step(-1_000_000_000n, [])], {}, 0);
    const after = aggregatePreview(graph, [step(-1_000_000_000n - 5_000n - 2_039_280n, [
      { stepId: "s1", network: "solana", kind: "network", label: "fee", asset: native, amount: "5000", paid: "on-top", certainty: "simulated" },
      { stepId: "s1", network: "solana", kind: "rent", label: "rent", asset: native, amount: "2039280", paid: "refundable", certainty: "simulated" },
    ])], {}, 0);
    assert.deepEqual(materialPreviewChanges(before, after, graph), []);
    const worse = aggregatePreview(graph, [step(-1_100_000_000n - 5_000n, [
      { stepId: "s1", network: "solana", kind: "network", label: "fee", asset: native, amount: "5000", paid: "on-top", certainty: "simulated" },
    ])], {}, 0);
    assert.deepEqual(materialPreviewChanges(before, worse, graph).map((change) => change.code), ["PREVIEW_WORSE_AMOUNT"]);
  });
});
