/**
 * Edges of the shared reference verification (adapters/verification.ts) the
 * adapter suites do not reach: unprepared steps, how outcome checks are
 * reported, which prepared bindings count, the landed-payload record the
 * Rule Book reconciles with, and the small helpers verify relies on.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AssetAmount, EvmTransactionRequest, IntentStep } from "@kletia/core";
import type { VerificationResult } from "../adapters/types.js";
import {
  fillNotBefore,
  firstPreparedAt,
  landedPayload,
  lowestPreparedFloor,
  preparedBindings,
  referenceFormatValid,
  referenceKey,
  stepOwner,
  verifyEvmReceipts,
  verifySolanaReferences,
} from "../adapters/verification.js";
import { solanaTransferAdapter } from "../adapters/solanaTransfer.js";
import { quoteBindingFor } from "../binding.js";
import { encodeStepRef } from "../stepRef.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, randomEvmHash, randomSolanaSignature, SOL_ADDRESS } from "./helpers.js";
import { installRpcMock, preparedStep, type RpcMock } from "./rpcMock.js";

const PREPARED_AT = Date.parse("2026-10-08T12:00:00.000Z");
const seconds = (ms: number) => Math.floor(ms / 1000);
const BINDING_A = "a".repeat(64);
const BINDING_B = "b".repeat(64);

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

const transfer: EvmTransactionRequest = { vm: "evm", network: "arbitrum", chainId: 42161, from: EVM_ADDRESS, to: OTHER_EVM_ADDRESS, data: "0x", value: "1000", description: "send" };

function evmStep(overrides: Partial<IntentStep> = {}): IntentStep {
  const binding = quoteBindingFor([transfer]);
  const at = new Date(PREPARED_AT).toISOString();
  return preparedStep({
    network: "arbitrum",
    chain: "eip155:42161",
    account: `eip155:42161:${EVM_ADDRESS}`,
    prepared: { quoteBinding: binding, preparedAt: at, expiresAt: seconds(PREPARED_AT) + 90, transactions: [{ vm: "evm", network: "arbitrum", to: OTHER_EVM_ADDRESS, description: "send" }] },
    evidence: [{ kind: "quote", network: "arbitrum", reference: binding, observedAt: at }],
    ...overrides,
  });
}

function land(status: "success" | "reverted" = "success"): string {
  const hash = randomEvmHash();
  mock.evm.set(hash.toLowerCase(), {
    hash,
    from: EVM_ADDRESS,
    to: OTHER_EVM_ADDRESS,
    input: "0x",
    value: 1000n,
    chainId: 42161,
    status,
    blockNumber: 1000n + BigInt(mock.evm.size),
    timestamp: seconds(PREPARED_AT) + 30,
  });
  return hash;
}

const context = (step: IntentStep, references: string[]) => ({ step, references, submittedAt: PREPARED_AT + 10_000, now: PREPARED_AT + 60_000 });

describe("unprepared steps", () => {
  it("fails EVM and Solana verification with STEP_NOT_PREPARED instead of guessing", async () => {
    const { prepared: _prepared, ...unprepared } = evmStep();
    assert.equal(code((await verifyEvmReceipts(context(unprepared, [randomEvmHash()]))).result), "STEP_NOT_PREPARED");
    assert.equal(code((await verifyEvmReceipts(context(evmStep({ account: "eip155:42161:not-an-address" }), [randomEvmHash()]))).result), "STEP_NOT_PREPARED");
    const solana = preparedStep({ network: "solana", chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", account: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL_ADDRESS}` });
    assert.equal(code((await verifySolanaReferences(context(solana, [randomSolanaSignature()]))).result), "STEP_NOT_PREPARED");
    // An EVM payload on a Solana step (or the reverse) is never verified.
    assert.equal(code((await verifySolanaReferences(context(evmStep(), [randomSolanaSignature()]))).result), "STEP_NOT_PREPARED");
  });
});

describe("EVM outcome checks", () => {
  it("rewrites a rejection code from an outcome check to OUTCOME_NOT_PROVEN and keeps other codes", async () => {
    const step = evmStep();
    const rejected = await verifyEvmReceipts(context(step, [land()]), () => ({ failure: { code: "REFERENCE_MISMATCH", message: "no event" } }));
    assert.equal(code(rejected.result), "OUTCOME_NOT_PROVEN");
    const own = await verifyEvmReceipts(context(step, [land()]), () => ({ failure: { code: "TRANSACTION_FAILED", message: "short" } }));
    assert.equal(code(own.result), "TRANSACTION_FAILED");
  });

  it("runs the check only after the binding matched and every transaction succeeded", async () => {
    let calls = 0;
    const check = () => {
      calls += 1;
    };
    assert.equal(code((await verifyEvmReceipts(context(evmStep(), [land("reverted")]), check)).result), "TRANSACTION_REVERTED");
    const wrong = randomEvmHash();
    mock.evm.set(wrong.toLowerCase(), { hash: wrong, from: EVM_ADDRESS, to: OTHER_EVM_ADDRESS, input: "0x01", value: 1000n, chainId: 42161, status: "success", blockNumber: 2000n, timestamp: seconds(PREPARED_AT) + 30 });
    assert.equal(code((await verifyEvmReceipts(context(evmStep(), [wrong]), check)).result), "REFERENCE_MISMATCH");
    assert.equal(calls, 0);
  });

  it("returns the measured output and appends the check's evidence", async () => {
    const actualOutput: AssetAmount = { asset: "eip155:42161/slip44:60", symbol: "ETH", decimals: 18, amount: "999", formatted: "0.000000000000000999" };
    const { result, receipts } = await verifyEvmReceipts(context(evmStep(), [land()]), (landed) => ({
      actualOutput,
      evidence: [{ kind: "receipt", network: "arbitrum", reference: landed[0]?.reference ?? "", observedAt: new Date(PREPARED_AT).toISOString(), detail: "Measured." }],
    }));
    assert.equal(result.status, "confirmed");
    assert.deepEqual(result.status === "confirmed" ? result.actualOutput : null, actualOutput);
    assert.equal(result.evidence.at(-1)?.detail, "Measured.");
    assert.equal(receipts.length, 1);
  });

  it("records which payload landed (binding and nonce) for the Rule Book", async () => {
    const step = evmStep();
    const hash = land();
    assert.equal(landedPayload({ network: "arbitrum", references: [hash] }), null);
    await verifyEvmReceipts(context(step, [hash]));
    const landed = landedPayload({ network: "arbitrum", references: [hash.toUpperCase().replace("0X", "0x")] });
    assert.equal(landed?.quoteBinding, step.prepared?.quoteBinding);
    assert.equal(landed?.nonces.length, 1);
    assert.equal(landedPayload({ network: "arbitrum", references: [] }), null);
  });
});

describe("prepared bindings and floors", () => {
  it("keeps the earliest time per binding and drops malformed bindings and times", () => {
    const step = evmStep({
      prepared: { quoteBinding: BINDING_A, preparedAt: new Date(PREPARED_AT + 60_000).toISOString(), expiresAt: 0, transactions: [] },
      evidence: [
        { kind: "quote", network: "arbitrum", reference: BINDING_A, observedAt: new Date(PREPARED_AT).toISOString() },
        { kind: "quote", network: "arbitrum", reference: BINDING_B, observedAt: "not a time" },
        { kind: "quote", network: "arbitrum", reference: "XYZ", observedAt: new Date(PREPARED_AT).toISOString() },
        { kind: "receipt", network: "arbitrum", reference: BINDING_B, observedAt: new Date(PREPARED_AT).toISOString() },
      ],
    });
    assert.deepEqual([...preparedBindings(step)], [[BINDING_A, PREPARED_AT]]);
    assert.equal(firstPreparedAt(step), PREPARED_AT);
    assert.equal(fillNotBefore(step), seconds(PREPARED_AT) - 300);
    const { prepared: _prepared, ...never } = step;
    assert.equal(firstPreparedAt({ ...never, evidence: [] }), null);
    assert.equal(fillNotBefore({ ...never, evidence: [] }), null);
  });

  it("takes the lowest floor among the current minimum and every prepared payload", () => {
    const minimumOutput: AssetAmount = { asset: "eip155:42161/slip44:60", symbol: "ETH", decimals: 18, amount: "500", formatted: "x" };
    const quoteRef = encodeStepRef({ v: 1, slippageBps: 50, floors: [{ at: 1, min: "700" }, { at: 2, min: "450" }] });
    assert.equal(lowestPreparedFloor(evmStep({ minimumOutput, quoteRef })), 450n);
    assert.equal(lowestPreparedFloor(evmStep({ minimumOutput })), 500n);
    assert.equal(lowestPreparedFloor(evmStep({ minimumOutput: { ...minimumOutput, amount: "1.5" } })), null);
    assert.equal(lowestPreparedFloor(evmStep()), null);
  });
});

describe("reference helpers", () => {
  it("checks the reference format of the step's VM", () => {
    const evm = evmStep();
    const solana = preparedStep({ network: "solana", chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", account: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOL_ADDRESS}` });
    assert.equal(referenceFormatValid(evm, randomEvmHash()), true);
    assert.equal(referenceFormatValid(evm, randomSolanaSignature()), false);
    assert.equal(referenceFormatValid(evm, `0x${"a".repeat(63)}`), false);
    assert.equal(referenceFormatValid(solana, randomSolanaSignature()), true);
    assert.equal(referenceFormatValid(solana, randomEvmHash()), false);
    assert.equal(referenceKey(evm, "0xABC"), "eip155:42161:0xabc");
    assert.equal(referenceKey(solana, "AbC"), "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:AbC");
    assert.equal(stepOwner(evm), EVM_ADDRESS);
    assert.equal(stepOwner(solana), SOL_ADDRESS);
  });
});

describe("Solana transfer verification", () => {
  const SOL_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SYSTEM = "11111111111111111111111111111111";
  const TOKEN = "TokenkegQfeYyiNwAyNSnUiQq3oiJaVTEiP6Q4F5KAZw";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const RECIPIENT = OTHER_SOL_ADDRESS;

  function transferStep(native: boolean): IntentStep {
    const at = new Date(PREPARED_AT).toISOString();
    return preparedStep({
      network: "solana",
      chain: SOL_CHAIN,
      account: `${SOL_CHAIN}:${SOL_ADDRESS}`,
      protocol: native ? "system-transfer" : "spl-token",
      recipient: `${SOL_CHAIN}:${RECIPIENT}`,
      input: native
        ? { asset: `${SOL_CHAIN}/slip44:501`, symbol: "SOL", decimals: 9, amount: "250000000", formatted: "0.25" }
        : { asset: `${SOL_CHAIN}/token:${USDC}`, symbol: "USDC", decimals: 6, amount: "5000000", formatted: "5" },
      prepared: { quoteBinding: BINDING_A, preparedAt: at, expiresAt: seconds(PREPARED_AT) + 90, transactions: [{ vm: "svm", network: "solana", feePayer: SOL_ADDRESS, to: native ? SYSTEM : TOKEN, description: "send" }] },
      evidence: [{ kind: "quote", network: "solana", reference: BINDING_A, observedAt: at }],
    });
  }

  /** A landed transfer from the step account crediting `to` with `credit` lamports (native) or USDC base units. */
  function landTransfer(native: boolean, to: string, credit: bigint): string {
    const signature = randomSolanaSignature();
    const lamports = native ? Number(credit) : 0;
    const tokens = native ? 0n : credit;
    mock.solana.set(signature, {
      signature,
      confirmationStatus: "finalized",
      body: {
        accountKeys: [SOL_ADDRESS, to, "Gg2wXJ5nU2eNBgcUsBDnWPLxZJzcsWkD2vPRfkzCSBbY", "3Lz6rCrXdLybFiuJGJnEjv6Z2XtCh5n4proPGP2aBkA1", native ? SYSTEM : TOKEN],
        programIndexes: [4],
        blockTime: seconds(PREPARED_AT) + 20,
        fee: 5_000,
        preBalances: [1_000_000_000, 1_000_000, 2_039_280, 2_039_280, 1],
        postBalances: [1_000_000_000 - lamports - 5_000, 1_000_000 + lamports, 2_039_280, 2_039_280, 1],
        preTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: SOL_ADDRESS, amount: "9000000" },
          { accountIndex: 3, mint: USDC, owner: to, amount: "0" },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: SOL_ADDRESS, amount: String(9_000_000n - tokens) },
          { accountIndex: 3, mint: USDC, owner: to, amount: String(tokens) },
        ],
      },
    });
    return signature;
  }

  const verify = (step: IntentStep, signature: string) => solanaTransferAdapter.verify(context(step, [signature]));

  it("confirms SOL and SPL transfers only when the recipient is credited the full amount", async () => {
    assert.equal(code(await verify(transferStep(true), landTransfer(true, RECIPIENT, 250_000_000n))), "confirmed");
    assert.equal(code(await verify(transferStep(true), landTransfer(true, RECIPIENT, 249_999_999n))), "REFERENCE_MISMATCH");
    assert.equal(code(await verify(transferStep(false), landTransfer(false, RECIPIENT, 5_000_000n))), "confirmed");
    assert.equal(code(await verify(transferStep(false), landTransfer(false, RECIPIENT, 4_999_999n))), "REFERENCE_MISMATCH");
  });

  it("refuses a transfer that credited someone else, sent another asset or invoked another program", async () => {
    const elsewhere = "HXtBm8XZbxaTt41uqaKhwUAa6Z1aPyvJdsZVENiWsetg";
    assert.equal(code(await verify(transferStep(true), landTransfer(true, elsewhere, 250_000_000n))), "REFERENCE_MISMATCH");
    assert.equal(code(await verify(transferStep(false), landTransfer(false, elsewhere, 5_000_000n))), "REFERENCE_MISMATCH");
    assert.equal(code(await verify(transferStep(false), landTransfer(true, RECIPIENT, 5_000_000n))), "REFERENCE_MISMATCH", "SOL sent for a USDC step");
  });

  it("fails a step without a recipient as invalid", async () => {
    const { recipient: _recipient, ...noRecipient } = transferStep(true);
    assert.equal(code(await verify(noRecipient, randomSolanaSignature())), "STEP_INVALID");
  });
});
