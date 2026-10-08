import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applySlippage, CHAINS, type EvmTransactionRequest, type IntentStep } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { jupiterAdapter } from "../adapters/jupiter.js";
import { relayAdapter, relayRequestIds } from "../adapters/relay.js";
import { fetchRelayQuote } from "../adapters/relayClient.js";
import type { VerificationResult } from "../adapters/types.js";
import {
  effectiveSolDelta,
  isReferenceRejection,
  preparedBindings,
  referenceKey,
  verifyEvmReferences,
} from "../adapters/verification.js";
import { sameAsset } from "../assets.js";
import { confirmSimulation, rpcErrorText } from "../chains/solana.js";
import { quoteBindingFor } from "../binding.js";
import { decodeStepRef, encodeStepRef } from "../stepRef.js";
import {
  EVM_ADDRESS,
  JUPITER_PROGRAM,
  OTHER_EVM_ADDRESS,
  OTHER_SOL_ADDRESS,
  randomEvmHash,
  randomRequestId,
  randomSolanaSignature,
  RELAY_EVM_TARGET,
  SOL_ADDRESS,
  unsignedSolanaTransaction,
} from "./helpers.js";
import { installRpcMock, preparedStep, type RpcMock } from "./rpcMock.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RELAY_PROGRAM = "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SOL_CHAIN = CHAINS.solana.id;

let mock: RpcMock;

beforeEach(() => {
  mock = installRpcMock();
});

afterEach(() => {
  mock.restore();
});

function code(result: VerificationResult): string {
  return result.status === "failed" ? result.failure.code : result.status;
}

/* ----------------------------------------------------------------- EVM */

const PREPARED_AT = Date.parse("2026-10-08T12:00:00.000Z");
const seconds = (ms: number) => Math.floor(ms / 1000);

function evmTransfer(value = "1000000000000000", to = OTHER_EVM_ADDRESS): EvmTransactionRequest {
  return { vm: "evm", network: "arbitrum", chainId: 42161, from: EVM_ADDRESS, to, data: "0x", value, description: "send" };
}

function evmStep(transactions: EvmTransactionRequest[], preparedAt = PREPARED_AT, earlier: { binding: string; at: number }[] = []): IntentStep {
  const binding = quoteBindingFor(transactions);
  const at = new Date(preparedAt).toISOString();
  return preparedStep({
    network: "arbitrum",
    chain: "eip155:42161",
    account: `eip155:42161:${EVM_ADDRESS}`,
    prepared: {
      quoteBinding: binding,
      preparedAt: at,
      expiresAt: seconds(preparedAt) + 90,
      transactions: transactions.map((transaction) => ({ vm: "evm", network: "arbitrum", to: transaction.to, description: "send" })),
    },
    evidence: [
      ...earlier.map((entry) => ({ kind: "quote" as const, network: "arbitrum" as const, reference: entry.binding, observedAt: new Date(entry.at).toISOString() })),
      { kind: "quote", network: "arbitrum", reference: binding, observedAt: at },
    ],
  });
}

function landEvm(hash: string, overrides: Partial<Parameters<RpcMock["evm"]["set"]>[1]> = {}): void {
  mock.evm.set(hash.toLowerCase(), {
    hash,
    from: EVM_ADDRESS,
    to: OTHER_EVM_ADDRESS,
    input: "0x",
    value: 1_000_000_000_000_000n,
    chainId: 42161,
    status: "success",
    blockNumber: 1000n + BigInt(mock.evm.size),
    timestamp: seconds(PREPARED_AT) + 30,
    ...overrides,
  });
}

async function verifyEvm(step: IntentStep, references: string[], now = PREPARED_AT + 60_000, submittedAt = PREPARED_AT + 40_000): Promise<VerificationResult> {
  return verifyEvmReferences({ step, references, submittedAt, now });
}

describe("EVM reference verification", () => {
  it("confirms the prepared transaction from the step account", async () => {
    const hash = randomEvmHash();
    landEvm(hash);
    const result = await verifyEvm(evmStep([evmTransfer()]), [hash]);
    assert.equal(code(result), "confirmed");
    assert.equal(result.evidence[0]?.kind, "receipt");
    assert.equal(result.evidence[0]?.reference, hash);
    assert.deepEqual(mock.unknown, []);
  });

  it("rejects another sender, another payload, another chain and pre-prepare transactions", async () => {
    const cases: [Partial<Parameters<RpcMock["evm"]["set"]>[1]>, string][] = [
      [{ from: OTHER_EVM_ADDRESS }, "REFERENCE_WRONG_SENDER"],
      [{ value: 2_000_000_000_000_000n }, "REFERENCE_MISMATCH"],
      [{ to: RELAY_EVM_TARGET }, "REFERENCE_MISMATCH"],
      [{ input: "0xdeadbeef" }, "REFERENCE_MISMATCH"],
      [{ chainId: 8453 }, "REFERENCE_WRONG_CHAIN"],
      [{ timestamp: seconds(PREPARED_AT) - 3_600 }, "REFERENCE_STALE"],
    ];
    for (const [overrides, expected] of cases) {
      const hash = randomEvmHash();
      landEvm(hash, overrides);
      const result = await verifyEvm(evmStep([evmTransfer()]), [hash]);
      assert.equal(code(result), expected, JSON.stringify(overrides, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
      assert.ok(isReferenceRejection(result));
    }
  });

  it("accepts a transaction of an earlier payload mined before a re-prepare", async () => {
    const first = [evmTransfer("1000000000000000")];
    const reprepared = evmStep([evmTransfer("1000000000000000", RELAY_EVM_TARGET)], PREPARED_AT + 20 * 60_000, [
      { binding: quoteBindingFor(first), at: PREPARED_AT },
    ]);
    assert.equal(preparedBindings(reprepared).get(quoteBindingFor(first)), PREPARED_AT);
    const hash = randomEvmHash();
    landEvm(hash, { timestamp: seconds(PREPARED_AT) + 60 });
    assert.equal(code(await verifyEvm(reprepared, [hash], PREPARED_AT + 30 * 60_000)), "confirmed");
  });

  it("fails a matching but reverted transaction without treating it as a rejection", async () => {
    const hash = randomEvmHash();
    landEvm(hash, { status: "reverted" });
    const result = await verifyEvm(evmStep([evmTransfer()]), [hash]);
    assert.equal(code(result), "TRANSACTION_REVERTED");
    assert.ok(!isReferenceRejection(result));
    assert.match(result.evidence[0]?.detail ?? "", /Reverted/u);
  });

  it("stays pending while unseen, turns stale after an hour, and fails closed without a block time", async () => {
    const step = evmStep([evmTransfer()]);
    const missing = randomEvmHash();
    const fresh = await verifyEvm(step, [missing]);
    assert.deepEqual([fresh.status, fresh.status === "pending" && fresh.stale], ["pending", false]);
    const stale = await verifyEvm(step, [missing], PREPARED_AT + 3 * 3_600_000, PREPARED_AT);
    assert.deepEqual([stale.status, stale.status === "pending" && stale.stale], ["pending", true]);
    const noBlock = randomEvmHash();
    landEvm(noBlock, { timestamp: null });
    assert.equal(code(await verifyEvm(step, [noBlock])), "pending");
  });

  it("binds multi-transaction payloads in order", async () => {
    const approve: EvmTransactionRequest = { ...evmTransfer("0", USDC_BASE), data: "0x095ea7b3" };
    const deposit: EvmTransactionRequest = { ...evmTransfer("0", RELAY_EVM_TARGET), data: "0x1234" };
    const step = evmStep([approve, deposit]);
    const [a, b] = [randomEvmHash(), randomEvmHash()];
    landEvm(a, { to: USDC_BASE, input: "0x095ea7b3", value: 0n });
    landEvm(b, { to: RELAY_EVM_TARGET, input: "0x1234", value: 0n });
    assert.equal(code(await verifyEvm(step, [a, b])), "confirmed");
    assert.equal(code(await verifyEvm(step, [b, a])), "REFERENCE_MISMATCH", "order matters");
  });
});

/* -------------------------------------------------------------- Solana */

interface SolanaLanding {
  readonly payer?: string;
  readonly programs?: readonly string[];
  readonly blockTime?: number;
  readonly lamports?: bigint;
  readonly usdcBefore?: string;
  readonly usdcAfter?: string;
  readonly err?: unknown;
  readonly readable?: boolean;
  readonly confirmation?: "processed" | "confirmed" | "finalized";
}

function landSolana(signature: string, landing: SolanaLanding = {}): void {
  const payer = landing.payer ?? SOL_ADDRESS;
  const programs = landing.programs ?? [JUPITER_PROGRAM];
  const tokenAccount = "Gg2wXJ5nU2eNBgcUsBDnWPLxZJzcsWkD2vPRfkzCSBbY";
  const before = 1_000_000_000;
  mock.solana.set(signature, {
    signature,
    confirmationStatus: landing.confirmation ?? "confirmed",
    ...(landing.err ? { err: landing.err } : {}),
    ...(landing.readable === false
      ? {}
      : {
          body: {
            accountKeys: [payer, tokenAccount, ...programs],
            programIndexes: programs.map((_, index) => index + 2),
            blockTime: landing.blockTime ?? seconds(PREPARED_AT) + 20,
            fee: 5_000,
            preBalances: [before, 2_039_280, ...programs.map(() => 1)],
            postBalances: [before + Number(landing.lamports ?? 0n) - 5_000, 2_039_280, ...programs.map(() => 1)],
            preTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: payer, amount: landing.usdcBefore ?? "20000000" }],
            postTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: payer, amount: landing.usdcAfter ?? "10000000" }],
          },
        }),
  });
}

function solanaStep(overrides: Partial<IntentStep> = {}): IntentStep {
  const at = new Date(PREPARED_AT).toISOString();
  return preparedStep({
    network: "solana",
    chain: SOL_CHAIN,
    account: `${SOL_CHAIN}:${SOL_ADDRESS}`,
    kind: "swap",
    protocol: "jupiter",
    input: { asset: `${SOL_CHAIN}/token:${USDC_SOL}`, symbol: "USDC", decimals: 6, amount: "10000000", formatted: "10" },
    minimumOutput: { asset: `${SOL_CHAIN}/slip44:501`, symbol: "SOL", decimals: 9, amount: "66000000", formatted: "0.066" },
    prepared: {
      quoteBinding: "a".repeat(64),
      preparedAt: at,
      expiresAt: seconds(PREPARED_AT) + 90,
      transactions: [{ vm: "svm", network: "solana", feePayer: SOL_ADDRESS, to: JUPITER_PROGRAM, description: "swap" }],
    },
    evidence: [{ kind: "quote", network: "solana", reference: "a".repeat(64), observedAt: at }],
    ...overrides,
  });
}

async function verifyJupiter(step: IntentStep, signature: string, now = PREPARED_AT + 60_000): Promise<VerificationResult> {
  return jupiterAdapter.verify({ step, references: [signature], submittedAt: PREPARED_AT + 30_000, now });
}

describe("Solana reference verification (Jupiter swap USDC -> SOL)", () => {
  it("confirms and measures the SOL received (fee added back)", async () => {
    const signature = randomSolanaSignature();
    landSolana(signature, { lamports: 66_500_000n });
    const result = await verifyJupiter(solanaStep(), signature);
    assert.equal(code(result), "confirmed");
    assert.equal(result.status === "confirmed" ? result.actualOutput?.amount : null, "66500000");
    assert.deepEqual(mock.unknown, []);
  });

  it("rejects transactions that did not deliver the minimum or spend the input", async () => {
    const short = randomSolanaSignature();
    landSolana(short, { lamports: 60_000_000n });
    assert.equal(code(await verifyJupiter(solanaStep(), short)), "REFERENCE_MISMATCH");
    const unspent = randomSolanaSignature();
    landSolana(unspent, { lamports: 66_500_000n, usdcAfter: "20000000" });
    assert.equal(code(await verifyJupiter(solanaStep(), unspent)), "REFERENCE_MISMATCH");
  });

  it("rejects another fee payer, another program and pre-prepare transactions", async () => {
    const payer = randomSolanaSignature();
    landSolana(payer, { payer: OTHER_SOL_ADDRESS, lamports: 66_500_000n });
    assert.equal(code(await verifyJupiter(solanaStep(), payer)), "REFERENCE_WRONG_SENDER");
    const program = randomSolanaSignature();
    landSolana(program, { programs: [RELAY_PROGRAM], lamports: 66_500_000n });
    assert.equal(code(await verifyJupiter(solanaStep(), program)), "REFERENCE_MISMATCH");
    const old = randomSolanaSignature();
    landSolana(old, { blockTime: seconds(PREPARED_AT) - 3_600, lamports: 66_500_000n });
    assert.equal(code(await verifyJupiter(solanaStep(), old)), "REFERENCE_STALE");
  });

  it("fails an on-chain error of the step's own transaction (not a rejection)", async () => {
    const signature = randomSolanaSignature();
    landSolana(signature, { err: { InstructionError: [2, { Custom: 6001 }] } });
    const result = await verifyJupiter(solanaStep(), signature);
    assert.equal(code(result), "TRANSACTION_FAILED");
    assert.ok(!isReferenceRejection(result));
  });

  it("stays pending without a readable body, and expires never-landed signatures", async () => {
    const unreadable = randomSolanaSignature();
    landSolana(unreadable, { err: { InstructionError: [0, "Custom"] }, readable: false });
    assert.equal(code(await verifyJupiter(solanaStep(), unreadable)), "pending");
    const processed = randomSolanaSignature();
    landSolana(processed, { confirmation: "processed", readable: false });
    assert.equal(code(await verifyJupiter(solanaStep(), processed)), "pending");
    const missing = randomSolanaSignature();
    assert.equal(code(await verifyJupiter(solanaStep(), missing)), "pending");
    assert.equal(code(await verifyJupiter(solanaStep(), missing, PREPARED_AT + 10 * 60_000)), "TRANSACTION_EXPIRED");
  });

  it("folds fee and wrapped SOL into the native SOL delta", () => {
    const delta = effectiveSolDelta(
      [
        {
          network: "solana",
          signature: "x",
          status: "confirmed",
          error: null,
          feePayer: SOL_ADDRESS,
          programs: [],
          blockTime: 1,
          slot: "1",
          explorerUrl: "",
          tokenDeltas: new Map([[`${SOL_ADDRESS}:So11111111111111111111111111111111111111112`, -400n]]),
          lamportDeltas: new Map([[SOL_ADDRESS, 1_000n]]),
          fee: 5_000n,
          detailsAvailable: true,
        },
      ],
      SOL_ADDRESS,
    );
    assert.equal(delta, 5_600n);
  });
});

/* --------------------------------------------------------------- Relay */

function relayDepositStep(requestId: string, overrides: Partial<IntentStep> = {}): IntentStep {
  return solanaStep({
    kind: "bridge",
    protocol: "relay",
    recipient: `eip155:8453:${EVM_ADDRESS}`,
    minimumOutput: { asset: `eip155:8453/erc20:${USDC_BASE}`, symbol: "USDC", decimals: 6, amount: "9900000", formatted: "9.9" },
    settlement: { kind: "cross-network", destinationNetwork: "base", trackingId: requestId },
    prepared: {
      quoteBinding: "b".repeat(64),
      preparedAt: new Date(PREPARED_AT).toISOString(),
      expiresAt: seconds(PREPARED_AT) + 90,
      transactions: [{ vm: "svm", network: "solana", feePayer: SOL_ADDRESS, to: RELAY_PROGRAM, description: "deposit" }],
    },
    evidence: [
      { kind: "quote", network: "solana", reference: "b".repeat(64), observedAt: new Date(PREPARED_AT).toISOString() },
      { kind: "quote", network: "solana", reference: requestId, observedAt: new Date(PREPARED_AT).toISOString() },
    ],
    ...overrides,
  });
}

function relayRequest(id: string, overrides: Record<string, unknown> = {}, outTx?: string): Record<string, unknown> {
  return {
    id,
    status: "success",
    recipient: EVM_ADDRESS.toLowerCase(),
    data: {
      outTxs: outTx ? [{ hash: outTx, chainId: 8453 }] : [],
      inTxs: [],
      metadata: { currencyOut: { currency: { chainId: 8453, address: USDC_BASE.toLowerCase() }, amount: "9950000" } },
    },
    ...overrides,
  };
}

describe("Relay deposits from Solana are bound through Relay's request record", () => {
  it("confirms a deposit Relay attributes to a request quoted for the step", async () => {
    const requestId = randomRequestId();
    const signature = randomSolanaSignature();
    landSolana(signature, { programs: [RELAY_PROGRAM] });
    mock.relayRequests.set(signature, [relayRequest(requestId, { status: "pending" })]);
    const step = relayDepositStep(requestId);
    assert.deepEqual(relayRequestIds(step), [requestId.toLowerCase()]);
    assert.equal(code(await relayAdapter.verify({ step, references: [signature], submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 })), "confirmed");
  });

  it("rejects a deposit Relay attributes to another request, and waits while unindexed", async () => {
    const requestId = randomRequestId();
    const foreign = randomSolanaSignature();
    landSolana(foreign, { programs: [RELAY_PROGRAM] });
    mock.relayRequests.set(foreign, [relayRequest(randomRequestId())]);
    const step = relayDepositStep(requestId);
    const rejected = await relayAdapter.verify({ step, references: [foreign], submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 });
    assert.equal(code(rejected), "REFERENCE_MISMATCH");
    assert.ok(isReferenceRejection(rejected));

    const unindexed = randomSolanaSignature();
    landSolana(unindexed, { programs: [RELAY_PROGRAM] });
    assert.equal(code(await relayAdapter.verify({ step, references: [unindexed], submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 })), "pending");
    mock.relayStatus.set(requestId.toLowerCase(), { status: "pending", inTxHashes: [unindexed], txHashes: [] });
    assert.equal(code(await relayAdapter.verify({ step, references: [unindexed], submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 })), "confirmed");
  });

  it("rejects a Relay deposit that did not debit the step amount", async () => {
    const requestId = randomRequestId();
    const signature = randomSolanaSignature();
    landSolana(signature, { programs: [RELAY_PROGRAM], usdcAfter: "15000000" });
    mock.relayRequests.set(signature, [relayRequest(requestId)]);
    assert.equal(code(await relayAdapter.verify({ step: relayDepositStep(requestId), references: [signature], submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 })), "REFERENCE_MISMATCH");
  });
});

describe("Relay settlement requires destination evidence", () => {
  function settlingStep(requestId: string, deposit: string): IntentStep {
    return relayDepositStep(requestId, { status: "settling", references: [deposit] });
  }

  function creditLog(to: string, amount: bigint) {
    return {
      address: USDC_BASE,
      topics: [TRANSFER_TOPIC, `0x${"0".repeat(24)}${OTHER_EVM_ADDRESS.slice(2).toLowerCase()}`, `0x${"0".repeat(24)}${to.slice(2).toLowerCase()}`],
      data: `0x${amount.toString(16).padStart(64, "0")}`,
    };
  }

  it("settles with the amount credited to the recipient on the destination network", async () => {
    const requestId = randomRequestId();
    const deposit = randomSolanaSignature();
    const fill = randomEvmHash();
    mock.relayRequests.set(deposit, [relayRequest(requestId, {}, fill)]);
    landEvm(fill, { to: USDC_BASE, chainId: 8453, logs: [creditLog(EVM_ADDRESS, 9_950_000n)] });
    const result = await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now());
    assert.equal(result?.status, "settled");
    assert.equal(result?.status === "settled" ? result.actualOutput?.amount : null, "9950000");
    assert.equal(result?.evidence[0]?.reference, fill);
  });

  it("keeps settling when the fill credits nobody we know", async () => {
    const requestId = randomRequestId();
    const deposit = randomSolanaSignature();
    const fill = randomEvmHash();
    mock.relayRequests.set(deposit, [relayRequest(requestId, {}, fill)]);
    landEvm(fill, { to: USDC_BASE, chainId: 8453, logs: [creditLog(OTHER_EVM_ADDRESS, 9_950_000n)] });
    assert.equal((await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now()))?.status, "settling");
  });

  it("fails on recipient / asset mismatch and refunds; ignores foreign requests", async () => {
    const requestId = randomRequestId();
    const cases: [Record<string, unknown>, string][] = [
      [{ recipient: OTHER_EVM_ADDRESS }, "SETTLEMENT_MISMATCH"],
      [{ data: { outTxs: [], inTxs: [], metadata: { currencyOut: { currency: { chainId: 8453, address: OTHER_EVM_ADDRESS } } } } }, "SETTLEMENT_MISMATCH"],
      [{ data: { outTxs: [], inTxs: [], metadata: { currencyOut: { currency: { chainId: 42161, address: USDC_BASE } } } } }, "SETTLEMENT_MISMATCH"],
      [{ status: "refund" }, "SETTLEMENT_REFUNDED"],
      [{ status: "failure" }, "SETTLEMENT_FAILED"],
    ];
    for (const [overrides, expected] of cases) {
      const deposit = randomSolanaSignature();
      mock.relayRequests.set(deposit, [relayRequest(requestId, overrides)]);
      const result = await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now());
      assert.equal(result?.status === "failed" ? result.failure.code : result?.status, expected);
    }
    const deposit = randomSolanaSignature();
    mock.relayRequests.set(deposit, [relayRequest(randomRequestId(), { recipient: OTHER_EVM_ADDRESS })]);
    assert.equal((await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now()))?.status, "settling");
  });
});

/* -------------------------------------------------------- Relay quotes */

describe("Relay quote validation", () => {
  const request = {
    user: EVM_ADDRESS,
    recipient: SOL_ADDRESS,
    originChainId: 8453,
    destinationChainId: 792703809,
    originCurrency: USDC_BASE,
    destinationCurrency: USDC_SOL,
    amount: "25000000",
    slippageBps: 50,
  };

  function quoteBody(overrides: { out?: Record<string, unknown>; inAmount?: string; kind?: string; recipient?: string } = {}) {
    return {
      steps: [{
        id: "deposit",
        kind: overrides.kind ?? "transaction",
        requestId: `0x${"12".repeat(32)}`,
        items: [{ status: "incomplete", data: { from: EVM_ADDRESS, to: RELAY_EVM_TARGET, data: "0x1234", value: "0", chainId: 8453 } }],
      }],
      fees: { gas: { amountUsd: "0.01" }, relayer: { amountUsd: "0.02" } },
      details: {
        ...(overrides.recipient ? { recipient: overrides.recipient } : {}),
        currencyIn: { currency: { chainId: 8453, address: USDC_BASE, decimals: 6, symbol: "USDC" }, amount: overrides.inAmount ?? "25000000" },
        currencyOut: { currency: { chainId: 792703809, address: USDC_SOL, decimals: 6, symbol: "USDC" }, amount: "24900000", minimumAmount: "24775500", ...overrides.out },
        timeEstimate: 12,
      },
    };
  }

  async function quoteError(body: unknown): Promise<string> {
    mock.relayQuote = () => body;
    try {
      await fetchRelayQuote(request);
    } catch (error) {
      assert.ok(error instanceof PlatformError);
      return error.code;
    }
    return "OK";
  }

  it("parses a valid quote", async () => {
    mock.relayQuote = () => quoteBody();
    const quote = await fetchRelayQuote(request);
    assert.equal(quote.currencyOut.minimumAmount, "24775500");
    assert.equal(quote.calls.length, 1);
    assert.ok(Math.abs((quote.feesUsd ?? 0) - 0.03) < 1e-9);
    assert.equal(quote.requestId, `0x${"12".repeat(32)}`);
  });

  it("derives the floor from the requested slippage when Relay omits minimumAmount", async () => {
    mock.relayQuote = () => {
      const body = quoteBody();
      const { minimumAmount: _dropped, ...out } = body.details.currencyOut;
      return { ...body, details: { ...body.details, currencyOut: out } };
    };
    const quote = await fetchRelayQuote(request);
    assert.equal(quote.currencyOut.minimumAmount, applySlippage("24900000", 50));
  });

  it("refuses floors below the slippage limit, mismatched inputs, recipients and signature steps", async () => {
    assert.equal(await quoteError(quoteBody({ out: { minimumAmount: "24000000" } })), "RELAY_QUOTE_INVALID");
    assert.equal(await quoteError(quoteBody({ inAmount: "26000000" })), "RELAY_QUOTE_INVALID");
    assert.equal(await quoteError(quoteBody({ recipient: OTHER_SOL_ADDRESS })), "RELAY_QUOTE_INVALID");
    assert.equal(await quoteError(quoteBody({ out: { currency: { chainId: 792703809, address: OTHER_SOL_ADDRESS, decimals: 6, symbol: "USDC" } } })), "RELAY_QUOTE_INVALID");
    assert.equal(await quoteError(quoteBody({ out: { currency: { chainId: 8453, address: USDC_SOL, decimals: 6, symbol: "USDC" } } })), "RELAY_QUOTE_INVALID");
    assert.equal(await quoteError(quoteBody({ kind: "signature" })), "RELAY_SIGNATURE_STEP_UNSUPPORTED");
    assert.equal(await quoteError({ steps: [] }), "RELAY_QUOTE_INVALID");
  });
});

/* ---------------------------------------------------------- simulation */

describe("Solana simulation", () => {
  it("re-simulates results the Solana module reported as unavailable and surfaces instruction errors", async () => {
    const transaction = unsignedSolanaTransaction(SOL_ADDRESS, JUPITER_PROGRAM);
    mock.simulationError = { InstructionError: [2, { Custom: 1 }] };
    const failed = await confirmSimulation("solana", transaction, { ok: false, error: "Simulation unavailable" });
    assert.deepEqual(failed, { ok: false, error: '{"InstructionError":[2,{"Custom":1}]}' });
    mock.simulationError = null;
    assert.deepEqual(await confirmSimulation("solana", transaction, { ok: false, error: "Simulation unavailable" }), { ok: true });
    assert.deepEqual(await confirmSimulation("solana", transaction, { ok: false, error: "AccountNotFound" }), { ok: false, error: "AccountNotFound" });
    assert.deepEqual(await confirmSimulation("solana", transaction, { ok: true, error: null }), { ok: true });
  });

  it("serialises bigint-bearing RPC errors", () => {
    assert.equal(rpcErrorText({ InstructionError: [2n, { Custom: 6001n }] }), '{"InstructionError":[2,{"Custom":6001}]}');
    assert.equal(rpcErrorText({ big: 2n ** 70n }), `{"big":"${(2n ** 70n).toString()}"}`);
  });
});

/* -------------------------------------------------------------- helpers */

describe("identity helpers", () => {
  it("compares EVM asset ids case-insensitively and Solana mints exactly", () => {
    assert.ok(sameAsset({ id: `eip155:8453/erc20:${USDC_BASE}` }, { asset: `eip155:8453/erc20:${USDC_BASE.toLowerCase()}` }));
    assert.ok(!sameAsset({ id: `${SOL_CHAIN}/token:${USDC_SOL}` }, { id: `${SOL_CHAIN}/token:${USDC_SOL.toLowerCase()}` }));
  });

  it("namespaces reference keys per chain", () => {
    const evm = evmStep([evmTransfer()]);
    const hash = randomEvmHash();
    assert.equal(referenceKey(evm, hash.toUpperCase().replace("0X", "0x")), `eip155:42161:${hash.toLowerCase()}`);
    const signature = randomSolanaSignature();
    assert.equal(referenceKey(solanaStep(), signature), `${SOL_CHAIN}:${signature}`);
  });

  it("round-trips step refs and rejects tampered ones", () => {
    const encoded = encodeStepRef({ v: 1, slippageBps: 50, portionBps: 5_000, provider: "Jito", quote: "q" });
    assert.deepEqual(decodeStepRef(encoded), { v: 1, slippageBps: 50, portionBps: 5_000, provider: "Jito", quote: "q" });
    assert.equal(decodeStepRef("kq1.!!!"), null);
    assert.equal(decodeStepRef(encodeStepRef({ v: 1, slippageBps: 5_000 })), null);
    assert.equal(decodeStepRef(undefined), null);
  });
});
