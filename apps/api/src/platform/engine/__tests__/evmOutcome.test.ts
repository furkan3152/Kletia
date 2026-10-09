/**
 * verifyEvmReceipts: the landed receipts (with logs) are handed to an adapter
 * check only after the binding matched and every transaction succeeded; a
 * missing event fails the step (never rejects the references).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeAbiParameters, erc20Abi, pad, parseAbi } from "viem";
import { formatAssetId, type EvmTransactionRequest, type IntentStep } from "@kletia/core";
import { evmEvents, isReferenceRejection, verifyEvmReceipts, verifyEvmReferences } from "../adapters/verification.js";
import { quoteBindingFor } from "../binding.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, randomEvmHash } from "./helpers.js";
import { installRpcMock, preparedStep, type RpcMock } from "./rpcMock.js";

const PREPARED_AT = Date.parse("2026-10-08T12:00:00.000Z");
const COMET = "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const COMET_ABI = parseAbi(["event Supply(address indexed from, address indexed dst, uint256 amount)"]);
const SUPPLY_TOPIC = "0xd1cf3d156d5f8f0d50f6c122ed609cec09d35c9b9fb3fff6ea0959134dae424e";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

let mock: RpcMock;
beforeEach(() => {
  mock = installRpcMock();
});
afterEach(() => mock.restore());

function supplyTransaction(): EvmTransactionRequest {
  return { vm: "evm", network: "arbitrum", chainId: 42161, from: EVM_ADDRESS, to: COMET, data: "0xf2b9fdb8", value: "0", description: "supply" };
}

function step(): IntentStep {
  const transactions = [supplyTransaction()];
  const binding = quoteBindingFor(transactions);
  const at = new Date(PREPARED_AT).toISOString();
  return preparedStep({
    network: "arbitrum",
    chain: "eip155:42161",
    account: `eip155:42161:${EVM_ADDRESS}`,
    prepared: { quoteBinding: binding, preparedAt: at, expiresAt: Math.floor(PREPARED_AT / 1000) + 90, transactions: [{ vm: "evm", network: "arbitrum", to: COMET, description: "supply" }] },
    evidence: [{ kind: "quote", network: "arbitrum", reference: binding, observedAt: at }],
  });
}

const topic = (address: string) => pad(address.toLowerCase() as `0x${string}`, { size: 32 });

function land(hash: string, logs: { address: string; topics: string[]; data: string }[], overrides: Record<string, unknown> = {}): void {
  mock.evm.set(hash.toLowerCase(), {
    hash,
    from: EVM_ADDRESS,
    to: COMET,
    input: "0xf2b9fdb8",
    value: 0n,
    chainId: 42161,
    status: "success",
    blockNumber: 1000n,
    timestamp: Math.floor(PREPARED_AT / 1000) + 30,
    logs,
    ...overrides,
  });
}

const supplyLog = (amount: bigint, from = EVM_ADDRESS) => ({
  address: COMET.toLowerCase(),
  topics: [SUPPLY_TOPIC, topic(from), topic(from)],
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
});

const context = (references: string[]) => ({ step: step(), references, submittedAt: PREPARED_AT + 40_000, now: PREPARED_AT + 60_000 });

describe("verifyEvmReceipts", () => {
  it("hands the receipts with logs to the check and keeps its measured output", async () => {
    const hash = randomEvmHash();
    land(hash, [
      { address: USDC.toLowerCase(), topics: [TRANSFER_TOPIC, topic(EVM_ADDRESS), topic(COMET)], data: encodeAbiParameters([{ type: "uint256" }], [12_200_000n]) },
      supplyLog(12_200_000n),
    ]);
    let seen = 0;
    const { result, receipts } = await verifyEvmReceipts(context([hash]), (landed) => {
      seen = landed.length;
      const [supply] = evmEvents(landed, { address: COMET, abi: COMET_ABI, eventName: "Supply" });
      assert.equal(supply?.args.amount, 12_200_000n);
      assert.equal(supply?.args.from.toLowerCase(), EVM_ADDRESS.toLowerCase());
      const transfers = evmEvents(landed, { address: USDC, abi: erc20Abi, eventName: "Transfer" });
      assert.equal(transfers.length, 1);
      return {
        actualOutput: { asset: formatAssetId("arbitrum", "erc20", COMET), symbol: "cUSDCv3", decimals: 6, amount: "12200000", formatted: "12.2" },
        evidence: [{ kind: "receipt", network: "arbitrum", reference: hash, observedAt: new Date().toISOString(), detail: "Supply event" }],
      };
    });
    assert.equal(seen, 1);
    assert.equal(receipts[0]?.reference, hash);
    assert.equal(receipts[0]?.logs.length, 2);
    assert.equal(result.status, "confirmed");
    assert.equal(result.status === "confirmed" ? result.actualOutput?.amount : null, "12200000");
    assert.equal(result.evidence.length, 2, "receipt evidence plus the check's evidence");
  });

  it("fails the step when the check finds no proof, rewriting rejection codes", async () => {
    const hash = randomEvmHash();
    land(hash, []);
    const missing = await verifyEvmReceipts(context([hash]), (landed) =>
      evmEvents(landed, { address: COMET, abi: COMET_ABI, eventName: "Supply" }).length === 0
        ? { failure: { code: "SUPPLY_REPAID_DEBT", message: "No Supply event." } }
        : undefined);
    assert.equal(missing.result.status === "failed" ? missing.result.failure.code : null, "SUPPLY_REPAID_DEBT");
    assert.equal(missing.result.evidence[0]?.kind, "receipt");
    const rewritten = await verifyEvmReceipts(context([hash]), () => ({ failure: { code: "REFERENCE_MISMATCH", message: "No event." } }));
    assert.equal(rewritten.result.status === "failed" ? rewritten.result.failure.code : null, "OUTCOME_NOT_PROVEN");
    assert.ok(!isReferenceRejection(rewritten.result), "the step's own transactions are never rejected after the binding matched");
  });

  it("does not run the check for foreign, reverted or pending references", async () => {
    let calls = 0;
    const check = () => {
      calls += 1;
    };
    const foreign = randomEvmHash();
    land(foreign, [supplyLog(1n)], { to: OTHER_EVM_ADDRESS });
    assert.equal((await verifyEvmReceipts(context([foreign]), check)).result.status === "failed" ? "failed" : "other", "failed");
    const reverted = randomEvmHash();
    land(reverted, [], { status: "reverted" });
    const revertedResult = await verifyEvmReceipts(context([reverted]), check);
    assert.equal(revertedResult.result.status === "failed" ? revertedResult.result.failure.code : null, "TRANSACTION_REVERTED");
    const pending = await verifyEvmReceipts(context([randomEvmHash()]), check);
    assert.equal(pending.result.status, "pending");
    assert.deepEqual(pending.receipts, []);
    assert.equal(calls, 0);
  });

  it("keeps verifyEvmReferences' behaviour for existing callers", async () => {
    const hash = randomEvmHash();
    land(hash, [supplyLog(5n)]);
    const result = await verifyEvmReferences(context([hash]));
    assert.equal(result.status, "confirmed");
    assert.equal(result.evidence.length, 1);
  });

  it("decodes only logs of the given address and event", () => {
    const logs = [supplyLog(7n), { ...supplyLog(9n), address: USDC.toLowerCase() }, { address: COMET.toLowerCase(), topics: [TRANSFER_TOPIC], data: "0x" }];
    const events = evmEvents([{ logs: logs as never }], { address: COMET.toUpperCase().replace("0X", "0x"), abi: COMET_ABI, eventName: "Supply" });
    assert.deepEqual(events.map((event) => event.args.amount), [7n]);
  });
});
