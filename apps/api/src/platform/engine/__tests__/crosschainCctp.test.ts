/**
 * Circle CCTP V2 with the Forwarding Service (protocols design 3.5, P6b)
 * against the recorded Iris fee tables and attested message: the fee cap
 * comes from the Fast Transfer row (protocol bps rounded up plus
 * forwardFee.high), Kletia encodes the exact depositForBurnWithHook call with
 * the static forward hook, a Solana destination needs the recipient's USDC
 * account, and a leg settles only when the forward completed and credited the
 * recipient at least amount - maxFee.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { address, getAddressEncoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import type { IntentGraph, IntentStep, TransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  CCTP_FORWARD_HOOK,
  CCTP_STANDARD_PROVIDER,
  CCTP_STANDARD_SECONDS,
  cctpClaimTransaction,
  cctpV2Adapter,
  decodeCctpMessage,
  MESSAGE_TRANSMITTER_V2_ABI,
  preferStandard,
  resetCctpBurnLimitCache,
} from "../adapters/cctpV2.js";
import { cctpProtocolFee } from "../adapters/cctpClient.js";
import type { AdapterAction, SettlementResult, VerificationResult } from "../adapters/types.js";
import {
  bridgeAction,
  bridgeFixture,
  CCTP_MESSAGE_TRANSMITTER,
  CCTP_TOKEN_MESSENGER,
  cctpMessage,
  depositForBurnLog,
  evmBridgeStep,
  installCrossChainMock,
  irisFeeTable,
  landPrepared,
  messageSentLog,
  PREPARED_AT,
  seconds,
  tokenAccountInfo,
  transferLog,
  USDC_SOL,
  type CrossChainMock,
} from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, randomEvmHash, randomSolanaSignature, SOL_ADDRESS } from "./helpers.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
/** Recorded Base -> Arbitrum Fast row: 1.3 bps, forwardFee.high 77,357; on 100 USDC: 13,000 + 77,357. */
const MAX_FEE_ARBITRUM = 90_357n;
/** Recorded Base -> Solana Fast row: 1.3 bps, forwardFee.high 149,524. */
const MAX_FEE_SOLANA = 162_524n;
const AMOUNT = 100_000_000n;

let mock: CrossChainMock;

beforeEach(() => {
  mock = installCrossChainMock();
  resetCctpBurnLimitCache();
  mock.irisFees.set("6/3", irisFeeTable("arbitrum"));
  mock.irisFees.set("6/5", irisFeeTable("solana"));
});

afterEach(() => {
  mock.restore();
});

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return `${error.code}: ${error.message}`;
  }
  return "OK";
}

function code(result: VerificationResult | SettlementResult | undefined): string | undefined {
  return result?.status === "failed" ? result.failure.code : result?.status;
}

const toArbitrum = (options: { recipient?: string; amount?: string } = {}) => bridgeAction("base", "arbitrum", { amount: AMOUNT.toString(), ...options });
const toSolana = (options: { recipient?: string } = {}) => bridgeAction("base", "solana", { amount: AMOUNT.toString(), ...options });

const prepareContext = (action: AdapterAction, step: IntentStep = evmBridgeStep(action, "cctp-v2", [])) => ({
  graph: {} as IntentGraph,
  step,
  action,
  now: Date.now(),
});

async function usdcAccount(owner: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(USDC_SOL), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return String(ata);
}

const word = (value: string) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const svmWord = (value: string) => `0x${Buffer.from(getAddressEncoder().encode(address(value))).toString("hex")}` as Hex;

/** depositForBurnWithHook encoded independently of the adapter. */
function expectedBurn(destinationDomain: number, mintRecipient: Hex, maxFee: bigint): Hex {
  return encodeFunctionData({
    abi: parseAbi(["function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)"]),
    functionName: "depositForBurnWithHook",
    args: [AMOUNT, destinationDomain, mintRecipient, USDC_BASE, `0x${"00".repeat(32)}`, maxFee, 1000, "0x636374702d666f72776172640000000000000000000000000000000000000000"],
  });
}

describe("CCTP V2 routes it serves", () => {
  it("serves registry USDC from an EVM production network to another one or to Solana, never from Solana yet", () => {
    assert.equal(cctpV2Adapter.supports(toArbitrum()), true);
    assert.equal(cctpV2Adapter.supports(toSolana()), true);
    assert.equal(cctpV2Adapter.supports(bridgeAction("ethereum", "polygon")), true);
    assert.equal(cctpV2Adapter.supports(bridgeAction("solana", "base")), false, "Solana origins come later");
    assert.equal(cctpV2Adapter.supports(bridgeAction("base", "optimism", { symbol: "ETH" })), false);
    assert.equal(cctpV2Adapter.supports({ ...toArbitrum(), destinationNetwork: "arbitrum-sepolia", output: bridgeAction("base", "arbitrum-sepolia").output }), false);
  });
});

describe("CCTP V2 fees, refusals and the encoded burn", () => {
  it("takes maxFee from the Iris Fast row (1.3 bps rounded up plus forwardFee.high); amount - maxFee is expected and minimum", async () => {
    assert.equal(cctpProtocolFee(AMOUNT, 130), 13_000n);
    assert.equal(cctpProtocolFee(1n, 130), 1n, "rounded up");
    const planned = await cctpV2Adapter.plan(toArbitrum());
    assert.equal(planned.protocol, "cctp-v2");
    assert.equal(planned.expectedOutput.amount, (AMOUNT - MAX_FEE_ARBITRUM).toString());
    assert.equal(planned.minimumOutput.amount, (AMOUNT - MAX_FEE_ARBITRUM).toString());
    assert.equal(planned.floor, "onchain");
    assert.equal(planned.estimatedSeconds, 20);
    assert.equal(planned.transactionCount, 2);
    assert.equal(planned.preview?.approvalSpender, CCTP_TOKEN_MESSENGER.toLowerCase());
    assert.deepEqual(planned.preview?.venueFees?.map((fee) => fee.amount), ["13000", "77357"]);
    assert.ok(planned.warnings.some((warning) => /not refunded/u.test(warning)), planned.warnings.join(" | "));
    assert.ok(mock.calls.some((url) => url.pathname === "/v2/burn/USDC/fees/6/3" && url.searchParams.get("forward") === "true"));
  });

  it("encodes the exact depositForBurnWithHook call with the static forward hook and an exact approval", async () => {
    const prepared = await cctpV2Adapter.prepare(prepareContext(toArbitrum()));
    const [approve, burn] = prepared.transactions as [TransactionRequest, TransactionRequest];
    assert.ok(approve.vm === "evm" && burn.vm === "evm");
    assert.equal(approve.to, USDC_BASE);
    assert.equal(approve.data, `0x095ea7b3${CCTP_TOKEN_MESSENGER.slice(2).toLowerCase().padStart(64, "0")}${AMOUNT.toString(16).padStart(64, "0")}`);
    assert.equal(burn.to, CCTP_TOKEN_MESSENGER);
    assert.equal(burn.value, "0");
    assert.equal(burn.data, expectedBurn(3, word(EVM_ADDRESS), MAX_FEE_ARBITRUM));
    assert.equal(CCTP_FORWARD_HOOK, "0x636374702d666f72776172640000000000000000000000000000000000000000");
  });

  it("mints to a third-party recipient when asked", async () => {
    const planned = await cctpV2Adapter.plan(toArbitrum({ recipient: OTHER_EVM_ADDRESS }));
    assert.ok(planned.warnings.some((warning) => warning.includes(`Circle mints to ${OTHER_EVM_ADDRESS} on Arbitrum One, not to your own account`)), planned.warnings.join(" | "));
    assert.ok(!(await cctpV2Adapter.plan(toArbitrum())).warnings.some((warning) => warning.includes("not to your own account")));
    const prepared = await cctpV2Adapter.prepare(prepareContext(toArbitrum({ recipient: OTHER_EVM_ADDRESS })));
    const burn = prepared.transactions[1];
    assert.ok(burn?.vm === "evm");
    assert.equal(burn.data, expectedBurn(3, word(OTHER_EVM_ADDRESS), MAX_FEE_ARBITRUM));
  });

  it("refuses a maxFee at or above the amount and amounts above the on-chain burn limit", async () => {
    // 77,368 base units: ceil(77,368 x 1.3 bps) = 11, plus 77,357 forwarding = 77,368, the whole amount.
    assert.match(await errorOf(() => cctpV2Adapter.plan(toArbitrum({ amount: "77368" }))), /^AMOUNT_TOO_SMALL/u);
    assert.match(await errorOf(() => cctpV2Adapter.plan(toArbitrum({ amount: "50000" }))), /^AMOUNT_TOO_SMALL/u);
    assert.equal((await cctpV2Adapter.plan(toArbitrum({ amount: "77369" }))).minimumOutput.amount, "1");
    assert.equal((await cctpV2Adapter.plan(toArbitrum({ amount: "100000" }))).expectedOutput.amount, (100_000n - 13n - 77_357n).toString());
    mock.cctpBurnLimit = AMOUNT - 1n;
    resetCctpBurnLimitCache();
    assert.match(await errorOf(() => cctpV2Adapter.plan(toArbitrum())), /^ROUTE_UNAVAILABLE.*burns at most 99\.999999 USDC/u);
    assert.match(await errorOf(() => cctpV2Adapter.prepare(prepareContext(toArbitrum()))), /^ROUTE_UNAVAILABLE/u);
  });

  it("refuses an Iris table without a Fast forwarding row or with an implausible fee", async () => {
    mock.irisFees.set("6/3", [{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: 2, high: 3 } }]);
    assert.match(await errorOf(() => cctpV2Adapter.plan(toArbitrum())), /^PROVIDER_TRANSACTION_INVALID.*Fast Transfer row/u);
    mock.irisFees.set("6/3", [{ finalityThreshold: 1000, minimumFee: 1.3 }]);
    assert.match(await errorOf(() => cctpV2Adapter.plan(toArbitrum())), /^PROVIDER_TRANSACTION_INVALID.*forwardFee/u);
    mock.irisFees.set("6/3", [{ finalityThreshold: 1000, minimumFee: 250, forwardFee: { low: 1, med: 2, high: 3 } }]);
    assert.match(await errorOf(() => cctpV2Adapter.plan(toArbitrum())), /^PROVIDER_TRANSACTION_INVALID.*minimumFee/u);
  });

  it("mints into the recipient's existing USDC account on Solana, else RECIPIENT_TOKEN_ACCOUNT_MISSING", async () => {
    assert.match(await errorOf(() => cctpV2Adapter.plan(toSolana())), /^RECIPIENT_TOKEN_ACCOUNT_MISSING/u);
    const ata = await usdcAccount(SOL_ADDRESS);
    mock.solanaAccounts.set(ata, tokenAccountInfo(OTHER_SOL_ADDRESS, USDC_SOL));
    assert.match(await errorOf(() => cctpV2Adapter.plan(toSolana())), /^ROUTE_UNAVAILABLE.*not a standard USDC account/u);
    mock.solanaAccounts.set(ata, tokenAccountInfo(SOL_ADDRESS, USDC_SOL));
    const own = toSolana();
    const planned = await cctpV2Adapter.plan({ ...own, destinationAccount: own.recipient });
    assert.equal(planned.expectedOutput.amount, (AMOUNT - MAX_FEE_SOLANA).toString());
    assert.ok(!planned.warnings.some((warning) => warning.includes("not to your own account")), "the user's own Solana account is no third party");
    assert.ok(planned.warnings.some((warning) => warning.includes(ata)));
    const prepared = await cctpV2Adapter.prepare(prepareContext(toSolana()));
    const burn = prepared.transactions[1];
    assert.ok(burn?.vm === "evm");
    assert.equal(burn.data, expectedBurn(5, svmWord(ata), MAX_FEE_SOLANA));
  });
});

describe("CCTP V2 messages", () => {
  it("decodes the recorded attested message (forwarded Base -> Arbitrum burn)", () => {
    const recorded = bridgeFixture<{ messages: { message: string; decodedMessage: { decodedMessageBody: Record<string, string> } }[] }>("iris-message-forwarded.json");
    const entry = recorded.messages[0];
    assert.ok(entry);
    const fields = decodeCctpMessage(entry.message);
    assert.ok(fields);
    assert.equal(fields.sourceDomain, 6);
    assert.equal(fields.destinationDomain, 3);
    assert.equal(fields.amount, 100_000n);
    assert.equal(fields.maxFee, 78_139n);
    assert.equal(fields.feeExecuted, 78_139n);
    assert.equal(fields.minFinalityThreshold, 1000);
    assert.equal(fields.hookData, CCTP_FORWARD_HOOK);
    assert.equal(fields.mintRecipient, word(entry.decodedMessage.decodedMessageBody.mintRecipient as string));
    assert.equal(fields.sender, word(CCTP_TOKEN_MESSENGER));
    assert.equal(decodeCctpMessage("0x00"), null);
  });
});

describe("CCTP V2 verification and settlement", () => {
  async function landedBurn(action: AdapterAction) {
    const prepared = await cctpV2Adapter.prepare(prepareContext(action));
    const burn = prepared.transactions[1];
    assert.ok(burn?.vm === "evm");
    return { transactions: prepared.transactions, data: burn.data as Hex };
  }

  const sent = (mintRecipient: Hex, maxFee: bigint, overrides: Partial<Parameters<typeof cctpMessage>[0]> = {}) => cctpMessage({
    sourceDomain: 6, destinationDomain: 3, amount: AMOUNT, mintRecipient, messageSender: EVM_ADDRESS, maxFee, burnToken: USDC_BASE, ...overrides,
  });

  it("confirms only with the pinned DepositForBurn and MessageSent matching the burn", async () => {
    const action = toArbitrum();
    const { transactions, data } = await landedBurn(action);
    const step = evmBridgeStep(action, "cctp-v2", transactions, { minimum: (AMOUNT - MAX_FEE_ARBITRUM).toString() });
    const verify = (references: string[]) => cctpV2Adapter.verify({ step, references, submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 });
    const message = sent(word(EVM_ADDRESS), MAX_FEE_ARBITRUM);
    const confirmed = await verify(landPrepared(mock.rpc, transactions, [depositForBurnLog(data, EVM_ADDRESS), messageSentLog(message)]));
    assert.equal(code(confirmed), "confirmed");
    assert.ok(confirmed.evidence.some((entry) => entry.reference === keccak256(message)), "the burn message hash is kept as evidence");
    const cases: [ReturnType<typeof depositForBurnLog>[] | { address: string; topics: string[]; data: string }[], string][] = [
      [[depositForBurnLog(data, OTHER_EVM_ADDRESS), messageSentLog(message)], "another depositor"],
      [[depositForBurnLog(data, EVM_ADDRESS, { amount: AMOUNT - 1n }), messageSentLog(message)], "another amount"],
      [[depositForBurnLog(data, EVM_ADDRESS, { mintRecipient: word(OTHER_EVM_ADDRESS) }), messageSentLog(message)], "another mint recipient"],
      [[depositForBurnLog(data, EVM_ADDRESS, { maxFee: MAX_FEE_ARBITRUM + 1n }), messageSentLog(message)], "another maxFee"],
      [[depositForBurnLog(data, EVM_ADDRESS, { hookData: "0x" }), messageSentLog(message)], "no forward hook"],
      [[depositForBurnLog(data, EVM_ADDRESS)], "no MessageSent"],
      [[depositForBurnLog(data, EVM_ADDRESS), messageSentLog(sent(word(OTHER_EVM_ADDRESS), MAX_FEE_ARBITRUM))], "a message for another recipient"],
      [[depositForBurnLog(data, EVM_ADDRESS), messageSentLog(sent(word(EVM_ADDRESS), MAX_FEE_ARBITRUM, { messageSender: OTHER_EVM_ADDRESS }))], "a message from another sender"],
      [[depositForBurnLog(data, EVM_ADDRESS), messageSentLog(message, OTHER_EVM_ADDRESS)], "an unpinned transmitter"],
      [[{ ...depositForBurnLog(data, EVM_ADDRESS), address: OTHER_EVM_ADDRESS }, messageSentLog(message)], "an unpinned messenger"],
    ];
    for (const [logs, label] of cases) {
      assert.equal(code(await verify(landPrepared(mock.rpc, transactions, logs))), "OUTCOME_NOT_PROVEN", label);
    }
  });

  it("settles only on an attested message with forwardState COMPLETE crediting at least amount - maxFee", async () => {
    const action = toArbitrum({ recipient: OTHER_EVM_ADDRESS });
    const { transactions, data } = await landedBurn(action);
    const mintRecipient = word(OTHER_EVM_ADDRESS);
    const references = landPrepared(mock.rpc, transactions, [depositForBurnLog(data, EVM_ADDRESS), messageSentLog(sent(mintRecipient, MAX_FEE_ARBITRUM))]);
    const burnHash = (references[references.length - 1] as string).toLowerCase();
    const step = evmBridgeStep(action, "cctp-v2", transactions, { minimum: (AMOUNT - MAX_FEE_ARBITRUM).toString(), references });
    const poll = () => cctpV2Adapter.poll?.(step, Date.now());
    const nonce = `0x${"5a".repeat(32)}` as Hex;
    const attested = sent(mintRecipient, MAX_FEE_ARBITRUM, { nonce, feeExecuted: MAX_FEE_ARBITRUM });
    const forward = randomEvmHash();
    const iris = (overrides: Record<string, unknown>, message: Hex = attested) =>
      mock.irisMessages.set(burnHash, { messages: [{ attestation: "0x01", message, eventNonce: nonce, cctpVersion: 2, status: "complete", delayReason: null, forwardState: "COMPLETE", forwardTxHash: forward, ...overrides }] });
    assert.equal(code(await poll()), "settling", "not indexed");
    iris({ status: "pending_confirmations", attestation: "PENDING", forwardState: null, forwardTxHash: null });
    assert.equal(code(await poll()), "settling");
    iris({}, sent(word(EVM_ADDRESS), MAX_FEE_ARBITRUM, { nonce }));
    const foreign = await poll();
    assert.equal(code(foreign), "settling", "a message for another recipient is never this leg's");
    assert.equal(foreign?.status === "settling" ? foreign.trackingId : "x", undefined);
    iris({ forwardState: "FAILED", forwardTxHash: null });
    const failedForward = await poll();
    assert.equal(code(failedForward), "settling", "a failed forward stays with Circle until manual review (indeterminate after the timeout)");
    assert.equal(failedForward?.status === "settling" ? failedForward.trackingId : null, keccak256(attested), "the attested message hash is the reference");
    iris({});
    const landForward = (credit: bigint) => mock.rpc.evm.set(forward, {
      hash: forward, from: "0x3333333333333333333333333333333333333333", to: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", input: "0x", value: 0n, chainId: 42161,
      status: "success", blockNumber: 9_300n, timestamp: seconds(PREPARED_AT) + 40, logs: [transferLog(USDC_ARBITRUM, OTHER_EVM_ADDRESS, credit)],
    });
    landForward(AMOUNT - MAX_FEE_ARBITRUM - 1n);
    const short = await poll();
    assert.equal(code(short), "SETTLEMENT_MISMATCH");
    assert.equal(short?.status === "failed" ? short.credited?.amount : null, (AMOUNT - MAX_FEE_ARBITRUM - 1n).toString());
    landForward(AMOUNT - MAX_FEE_ARBITRUM);
    const settled = await poll();
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, (AMOUNT - MAX_FEE_ARBITRUM).toString());
    assert.equal(settled?.evidence[0]?.reference, forward);
  });

  it("settles a Solana destination on the forward's credit to the recipient's USDC account", async () => {
    const action = toSolana();
    const ata = await usdcAccount(SOL_ADDRESS);
    mock.solanaAccounts.set(ata, tokenAccountInfo(SOL_ADDRESS, USDC_SOL));
    const { transactions, data } = await landedBurn(action);
    const ataWord = svmWord(ata);
    const message = (nonce?: Hex) => cctpMessage({ sourceDomain: 6, destinationDomain: 5, amount: AMOUNT, mintRecipient: ataWord, messageSender: EVM_ADDRESS, maxFee: MAX_FEE_SOLANA, burnToken: USDC_BASE, ...(nonce ? { nonce, feeExecuted: MAX_FEE_SOLANA } : {}) });
    const references = landPrepared(mock.rpc, transactions, [depositForBurnLog(data, EVM_ADDRESS), messageSentLog(message())]);
    const step = evmBridgeStep(action, "cctp-v2", transactions, { minimum: (AMOUNT - MAX_FEE_SOLANA).toString(), references });
    assert.equal(code(await cctpV2Adapter.verify({ step: { ...step, status: "submitted" }, references, submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 })), "confirmed");
    const signature = randomSolanaSignature();
    mock.rpc.solana.set(signature, {
      signature, confirmationStatus: "finalized",
      body: {
        accountKeys: [OTHER_SOL_ADDRESS, ata], programIndexes: [], blockTime: seconds(PREPARED_AT) + 60, fee: 5_000,
        preBalances: [1_000_000, 2_039_280], postBalances: [995_000, 2_039_280],
        preTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: SOL_ADDRESS, amount: "0" }],
        postTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: SOL_ADDRESS, amount: (AMOUNT - MAX_FEE_SOLANA).toString() }],
      },
    });
    mock.irisMessages.set((references[references.length - 1] as string).toLowerCase(), {
      messages: [{ message: message(`0x${"77".repeat(32)}`), eventNonce: `0x${"77".repeat(32)}`, status: "complete", forwardState: "COMPLETE", forwardTxHash: signature }],
    });
    const settled = await cctpV2Adapter.poll?.(step, Date.now());
    assert.equal(settled?.status, "settled", JSON.stringify(settled));
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, (AMOUNT - MAX_FEE_SOLANA).toString());
  });
});

describe("CCTP destination claim (B.1, red-team D4)", () => {
  const sent = (mintRecipient: Hex, maxFee: bigint, overrides: Partial<Parameters<typeof cctpMessage>[0]> = {}) => cctpMessage({
    sourceDomain: 6, destinationDomain: 3, amount: AMOUNT, mintRecipient, messageSender: EVM_ADDRESS, maxFee, burnToken: USDC_BASE, ...overrides,
  });
  const ATTESTATION = `0x${"ab".repeat(65)}` as Hex;

  async function settlingLeg(recipient = OTHER_EVM_ADDRESS) {
    const action = toArbitrum({ recipient });
    const prepared = await cctpV2Adapter.prepare(prepareContext(action));
    const data = (prepared.transactions[1] as { data: Hex }).data;
    const mintRecipient = word(recipient);
    const references = landPrepared(mock.rpc, prepared.transactions, [depositForBurnLog(data, EVM_ADDRESS), messageSentLog(sent(mintRecipient, MAX_FEE_ARBITRUM))]);
    const burnHash = (references[references.length - 1] as string).toLowerCase();
    const step = { ...evmBridgeStep(action, "cctp-v2", prepared.transactions, { minimum: (AMOUNT - MAX_FEE_ARBITRUM).toString(), references }), protocol: "cctp-v2" as const };
    const nonce = `0x${"5a".repeat(32)}` as Hex;
    const attested = sent(mintRecipient, MAX_FEE_ARBITRUM, { nonce });
    const iris = (overrides: Record<string, unknown> = {}, message: Hex = attested) =>
      mock.irisMessages.set(burnHash, { messages: [{ attestation: ATTESTATION, message, eventNonce: nonce, cctpVersion: 2, status: "complete", forwardState: "FAILED", forwardTxHash: null, ...overrides }] });
    return { step, attested, iris, nonce };
  }

  it("builds receiveMessage(message, attestation) on the destination's pinned transmitter for an attested, unforwarded burn", async () => {
    const { step, attested, iris } = await settlingLeg();
    iris();
    const claim = await cctpClaimTransaction(step, EVM_ADDRESS);
    const tx = claim.transaction;
    assert.ok(tx.vm === "evm");
    assert.equal(tx.network, "arbitrum");
    assert.equal(tx.to, CCTP_MESSAGE_TRANSMITTER);
    assert.equal(tx.value, "0");
    assert.equal(tx.from.toLowerCase(), EVM_ADDRESS.toLowerCase());
    const decoded = decodeFunctionData({ abi: MESSAGE_TRANSMITTER_V2_ABI, data: tx.data as Hex });
    assert.equal(decoded.functionName, "receiveMessage");
    assert.deepEqual(decoded.args, [attested, ATTESTATION]);
    assert.equal(claim.messageHash, keccak256(attested));
    assert.equal(claim.minimum, AMOUNT - MAX_FEE_ARBITRUM);
  });

  it("refuses before attestation, after the forward minted, when already received, for another recipient's message and for other venues", async () => {
    const { step, iris } = await settlingLeg();
    assert.match(await errorOf(() => cctpClaimTransaction(step, EVM_ADDRESS)), /^STEP_NOT_READY.*not published/u);
    iris({ status: "pending_confirmations", attestation: "PENDING" });
    assert.match(await errorOf(() => cctpClaimTransaction(step, EVM_ADDRESS)), /^STEP_NOT_READY.*not attested/u);
    iris({ forwardState: "COMPLETE", forwardTxHash: randomEvmHash() });
    assert.match(await errorOf(() => cctpClaimTransaction(step, EVM_ADDRESS)), /^STEP_NOT_PREPARABLE.*already minted/u);
    iris({}, sent(word(EVM_ADDRESS), MAX_FEE_ARBITRUM, { nonce: `0x${"5a".repeat(32)}` }));
    assert.match(await errorOf(() => cctpClaimTransaction(step, EVM_ADDRESS)), /^STEP_NOT_READY/u, "a message for another recipient is never this leg's");
    iris();
    mock.cctpUsedNonce = 1n;
    assert.match(await errorOf(() => cctpClaimTransaction(step, EVM_ADDRESS)), /^STEP_NOT_PREPARABLE.*already received/u);
    mock.cctpUsedNonce = 0n;
    assert.match(await errorOf(() => cctpClaimTransaction({ ...step, protocol: "across" }, EVM_ADDRESS)), /^STEP_NOT_PREPARABLE.*Only a Circle CCTP/u);
    assert.match(await errorOf(() => cctpClaimTransaction({ ...step, references: [] }, EVM_ADDRESS)), /^STEP_NOT_READY/u);
  });

  it("settles the leg once the claim received the message (nonce used) although the forward never minted", async () => {
    const { step, iris } = await settlingLeg();
    iris();
    assert.equal(code(await cctpV2Adapter.poll?.(step, Date.now())), "settling", "forward failed, not received yet");
    mock.cctpUsedNonce = 1n;
    const settled = await cctpV2Adapter.poll?.(step, Date.now());
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, (AMOUNT - MAX_FEE_ARBITRUM).toString(), "the guaranteed floor");
  });
});

describe("CCTP Standard Transfer (B.1, red-team D4): forwarding only, explicit time budget, server flag", () => {
  const fast = { protocolFeeCentiBps: 130, forwardFeeHigh: 77_357n };
  const standard = { protocolFeeCentiBps: 0, forwardFeeHigh: 77_357n };
  const big = (timeBudget?: { maxSeconds: number; fastest: boolean }) => ({ ...toArbitrum({ amount: "100000000000" }), ...(timeBudget ? { timeBudget } : {}) });

  it("prefers Standard only when enabled, forwarded, inside an explicit budget, not 'fastest', and worth the wait", () => {
    const budget = { maxSeconds: 3_600, fastest: false };
    assert.equal(preferStandard(big(budget), fast, standard, 20, true), true, "100,000 USDC saves $13, about $2.36 of waiting");
    assert.equal(preferStandard(big(budget), fast, standard, 20, false), false, "off unless the server enables it");
    assert.equal(preferStandard(big(), fast, standard, 20, true), false, "no explicit time budget");
    assert.equal(preferStandard(big({ maxSeconds: CCTP_STANDARD_SECONDS - 1, fastest: false }), fast, standard, 20, true), false, "budget too short");
    assert.equal(preferStandard(big({ maxSeconds: 3_600, fastest: true }), fast, standard, 20, true), false, "the fastest route was asked for");
    assert.equal(preferStandard(big(budget), fast, null, 20, true), false, "no forwarding for Standard: never offered");
    assert.equal(preferStandard({ ...toArbitrum(), timeBudget: budget }, fast, standard, 20, true), false, "100 USDC saves 1.3 cents: not worth 20 minutes");
  });

  it("plans and prepares a Standard burn (finality 2000, no Fast fee) and records the choice for prepare", async () => {
    const flag = process.env.KLETIA_CCTP_STANDARD;
    process.env.KLETIA_CCTP_STANDARD = "on";
    try {
      const action = big({ maxSeconds: 3_600, fastest: false });
      const planned = await cctpV2Adapter.plan(action);
      assert.equal(planned.provider, CCTP_STANDARD_PROVIDER);
      assert.equal(planned.estimatedSeconds, CCTP_STANDARD_SECONDS);
      assert.equal(planned.minimumOutput.amount, (100_000_000_000n - 77_357n).toString(), "forwarding gas only");
      assert.ok(planned.warnings.some((warning) => /Standard Transfer/u.test(warning)));
      const burn = planned.preview?.transactions.at(-1);
      assert.ok(burn?.vm === "evm");
      assert.equal(decodeFunctionData({ abi: parseAbi(["function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"]), data: burn.data as Hex }).args[6], 2000);
      const prepared = await cctpV2Adapter.prepare(prepareContext({ ...toArbitrum({ amount: "100000000000" }), provider: CCTP_STANDARD_PROVIDER }));
      const preparedBurn = prepared.transactions.at(-1);
      assert.ok(preparedBurn?.vm === "evm");
      assert.equal(decodeFunctionData({ abi: parseAbi(["function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"]), data: preparedBurn.data as Hex }).args[6], 2000, "prepare keeps the planned finality");
      const fastPlan = await cctpV2Adapter.plan(toArbitrum({ amount: "100000000000" }));
      assert.equal(fastPlan.provider, undefined, "no time budget: Fast Transfer as today");
    } finally {
      if (flag === undefined) delete process.env.KLETIA_CCTP_STANDARD;
      else process.env.KLETIA_CCTP_STANDARD = flag;
    }
  });
});
