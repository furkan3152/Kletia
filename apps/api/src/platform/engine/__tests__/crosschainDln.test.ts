import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import type { Hex } from "viem";
import { applySlippage, CHAINS, type IntentGraph, type IntentStep, type TransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { debridgeDlnAdapter, resetDlnFixFeeCache } from "../adapters/debridge.js";
import type { AdapterAction, SettlementResult, VerificationResult } from "../adapters/types.js";
import { accountBytes } from "../adapters/lifi.js";
import {
  account,
  asset,
  bridgeAction,
  createdOrderLog,
  DLN_DESTINATION,
  DLN_EVM_FIX_FEE,
  DLN_SOLANA_FIX_FEE,
  DLN_SOLANA_SOURCE,
  DLN_SOURCE,
  dlnAuthority,
  dlnEventOrder,
  dlnEvmCall,
  dlnOrderBody,
  dlnSolanaArgs,
  dlnSolanaTransaction,
  dlnStateInfo,
  DLN_SOLANA_STATE,
  ETH_PROXY_MINT,
  evmBridgeStep,
  fulfilledOrderLog,
  installCrossChainMock,
  landPrepared,
  PREPARED_AT,
  seconds,
  USDC_SOL,
  type CrossChainMock,
  type DlnOrderOptions,
} from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, randomEvmHash, randomSolanaSignature, SOL_ADDRESS } from "./helpers.js";
import { preparedStep } from "./rpcMock.js";

let mock: CrossChainMock;

beforeEach(() => {
  mock = installCrossChainMock();
  resetDlnFixFeeCache();
  mock.solanaAccounts.set(DLN_SOLANA_STATE, dlnStateInfo());
  mock.prices.set(ETH_PROXY_MINT, 2_500);
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

/** Answers create-tx with an EVM order for `action` (overridable per field). */
function evmOrder(action: AdapterAction, options: DlnOrderOptions = {}, tx: { to?: string; value?: string } = {}) {
  const { data } = dlnEvmCall(action, options);
  const orderId = options.orderId ?? randomEvmHash();
  mock.dlnOrder = () => dlnOrderBody(action, { data, ...tx }, { ...options, orderId });
  return { data, orderId };
}

const prepareContext = (action: AdapterAction, step: IntentStep = evmBridgeStep(action, "debridge-dln", [])) => ({
  graph: {} as IntentGraph,
  step,
  action,
  now: Date.now(),
});

describe("deBridge DLN routes it serves", () => {
  it("serves canonical cross-network pairs from networks with a pinned source", () => {
    assert.equal(debridgeDlnAdapter.supports(bridgeAction("base", "arbitrum")), true);
    assert.equal(debridgeDlnAdapter.supports(bridgeAction("solana", "base")), true);
    assert.equal(debridgeDlnAdapter.supports(bridgeAction("polygon", "solana")), true);
    assert.equal(debridgeDlnAdapter.supports(bridgeAction("base", "optimism", { symbol: "ETH" })), true);
    assert.equal(debridgeDlnAdapter.supports(bridgeAction("base", "solana", { out: "SOL" })), true);
    assert.equal(debridgeDlnAdapter.supports({ ...bridgeAction("base", "arbitrum"), destinationNetwork: "base", output: asset("base", "USDC") }), false);
    assert.equal(debridgeDlnAdapter.supports({ ...bridgeAction("base", "arbitrum"), output: { ...asset("arbitrum", "USDC"), canonical: false } }), false);
    assert.equal(debridgeDlnAdapter.supports({ ...bridgeAction("base", "arbitrum"), destinationNetwork: "arc", output: asset("arc", "USDC") }), false);
  });
});

describe("deBridge DLN EVM orders", () => {
  it("plans an exact order with the fixed fee as an extra cost and asks for the user's authorities", async () => {
    const action = bridgeAction("base", "arbitrum");
    let query: URLSearchParams | null = null;
    const { data } = dlnEvmCall(action);
    mock.dlnOrder = (params) => {
      query = params;
      return dlnOrderBody(action, { data });
    };
    const planned = await debridgeDlnAdapter.plan(action);
    assert.equal(planned.protocol, "debridge-dln");
    // The order takes exactly 24.669417 USDC; the step minimum keeps a 5 bps re-quote cushion below it.
    assert.equal(planned.expectedOutput.amount, "24669417");
    assert.equal(planned.minimumOutput.amount, applySlippage("24669417", 5));
    assert.equal(planned.extraCosts?.length, 1);
    assert.equal(planned.extraCosts?.[0]?.amount, DLN_EVM_FIX_FEE.toString());
    assert.equal(planned.extraCosts?.[0]?.symbol, "ETH");
    assert.equal(planned.extraCosts?.[0]?.usd, 2.5);
    assert.ok(Math.abs((planned.feesUsd ?? 0) - 2.51) < 1e-9);
    assert.equal(planned.transactionCount, 2);
    const sent = query as unknown as URLSearchParams;
    assert.equal(sent.get("prependOperatingExpenses"), "false");
    assert.equal(sent.get("srcChainTokenInAmount"), "25000000");
    assert.equal(sent.get("dstChainOrderAuthorityAddress"), EVM_ADDRESS);
    assert.equal(sent.get("srcAllowedCancelBeneficiary"), EVM_ADDRESS);
    assert.equal(sent.get("dstChainTokenOutRecipient"), EVM_ADDRESS);
  });

  it("refuses orders that do not match the step, the pinned DlnSource or the on-chain fee", async () => {
    const action = bridgeAction("base", "arbitrum");
    const other = OTHER_EVM_ADDRESS.toLowerCase() as Hex;
    const cases: [DlnOrderOptions, { to?: string; value?: string }, RegExp][] = [
      [{}, { to: OTHER_EVM_ADDRESS }, /does not target the pinned DlnSource/u],
      [{}, { value: (DLN_EVM_FIX_FEE * 2n).toString() }, /not exactly the fixed fee/u],
      [{ order: { giveAmount: 25_978_554n } }, {}, /gives another amount/u],
      [{ order: { giveTokenAddress: OTHER_EVM_ADDRESS } }, {}, /gives another token/u],
      [{ order: { takeAmount: 25_000_000n } }, {}, /takes another amount than quoted/u],
      [{ order: { takeChainId: 10n } }, {}, /takes on another chain/u],
      [{ order: { takeTokenAddress: other } }, {}, /takes another token/u],
      [{ order: { receiverDst: other } }, {}, /pays another recipient/u],
      [{ order: { givePatchAuthoritySrc: OTHER_EVM_ADDRESS } }, {}, /another account may patch/u],
      [{ authority: OTHER_EVM_ADDRESS }, {}, /another account controls the order/u],
      [{ order: { allowedCancelBeneficiarySrc: other } }, {}, /cancellation would refund another account/u],
      [{ order: { externalCall: "0x1234" } }, {}, /external call/u],
      [{ affiliateFee: "0x1234" }, {}, /affiliate fee/u],
      [{ permit: "0x1234" }, {}, /carries a permit/u],
    ];
    // An unfillable same-asset order (takes more than it gives) would only win the auction and then sit unfilled.
    cases.push([{ takeAmount: 25_000_001n }, {}, /takes more than it gives/u]);
    for (const [options, tx, reason] of cases) {
      evmOrder(action, options, tx);
      const error = await errorOf(() => debridgeDlnAdapter.plan(action));
      assert.match(error, /^PROVIDER_TRANSACTION_INVALID/u, reason.source);
      assert.match(error, reason);
    }
    // The fee is capped by the pinned contract's own globalFixedNativeFee(), never by the API.
    resetDlnFixFeeCache();
    mock.dlnFixFee = DLN_EVM_FIX_FEE / 2n;
    evmOrder(action);
    assert.match(await errorOf(() => debridgeDlnAdapter.plan(action)), /differs from the on-chain fee/u);
  });

  it("keeps the re-quote cushion within the step's slippage, so a small drift at prepare still prepares", async () => {
    const tight = bridgeAction("base", "arbitrum", { slippageBps: 2 });
    evmOrder(tight);
    assert.equal((await debridgeDlnAdapter.plan(tight)).minimumOutput.amount, applySlippage("24669417", 2));
    const action = bridgeAction("base", "arbitrum");
    evmOrder(action);
    const planned = await debridgeDlnAdapter.plan(action);
    // Live, DLN's auto take moved by 11 base units within a second; the service refuses a prepare
    // whose fresh expected output is below the planned minimum, so the cushion must absorb that.
    evmOrder(action, { takeAmount: 24_669_406n });
    const prepared = await debridgeDlnAdapter.prepare(prepareContext(action));
    assert.ok(BigInt(prepared.expectedOutput.amount) >= BigInt(planned.minimumOutput.amount));
  });

  it("requires the native amount plus the fixed fee as value for a native input", async () => {
    const action = bridgeAction("base", "optimism", { symbol: "ETH", amount: "10000000000000000" });
    evmOrder(action, { takeAmount: 9_000_000_000_000_000n }, { value: (DLN_EVM_FIX_FEE + 10_000_000_000_000_000n).toString() });
    const planned = await debridgeDlnAdapter.plan(action);
    assert.equal(planned.transactionCount, 1);
    evmOrder(action, { takeAmount: 9_000_000_000_000_000n }, { value: DLN_EVM_FIX_FEE.toString() });
    assert.match(await errorOf(() => debridgeDlnAdapter.plan(action)), /not exactly the fixed fee/u);
  });

  it("uses the recipient as destination authority across VMs, with a warning", async () => {
    const action = bridgeAction("base", "solana");
    let query: URLSearchParams | null = null;
    const { data } = dlnEvmCall(action, { takeAmount: 24_002_368n });
    mock.dlnOrder = (params) => {
      query = params;
      return dlnOrderBody(action, { data }, { takeAmount: 24_002_368n });
    };
    const planned = await debridgeDlnAdapter.plan(action);
    assert.equal((query as unknown as URLSearchParams).get("dstChainOrderAuthorityAddress"), SOL_ADDRESS);
    assert.ok(planned.warnings.some((warning) => warning.includes(`cancelled only from ${SOL_ADDRESS}`)));
    assert.equal(dlnAuthority(action), SOL_ADDRESS);
  });

  it("gives the cancel right to the user's own destination account, not a third-party recipient", async () => {
    const third = OTHER_SOL_ADDRESS;
    const action: AdapterAction = { ...bridgeAction("base", "solana", { recipient: third }), destinationAccount: account("solana") };
    assert.notEqual(action.destinationAccount?.address, third);
    let query: URLSearchParams | null = null;
    const { data } = dlnEvmCall(action, { takeAmount: 24_002_368n });
    mock.dlnOrder = (params) => {
      query = params;
      return dlnOrderBody(action, { data }, { takeAmount: 24_002_368n });
    };
    const planned = await debridgeDlnAdapter.plan(action);
    const sent = query as unknown as URLSearchParams;
    assert.equal(sent.get("dstChainOrderAuthorityAddress"), action.destinationAccount?.address);
    assert.equal(sent.get("dstChainTokenOutRecipient"), third);
    assert.ok(!planned.warnings.some((warning) => warning.includes("cancelled only from")), planned.warnings.join(" | "));
  });

  it("prepares an exact approval of DlnSource and the order with exactly the fee as value", async () => {
    const action = bridgeAction("base", "arbitrum");
    const { data, orderId } = evmOrder(action);
    const prepared = await debridgeDlnAdapter.prepare(prepareContext(action));
    const [approve, order] = prepared.transactions as [TransactionRequest, TransactionRequest];
    assert.ok(approve.vm === "evm" && order.vm === "evm");
    assert.equal(approve.data, `0x095ea7b3${DLN_SOURCE.slice(2).toLowerCase().padStart(64, "0")}${(25_000_000n).toString(16).padStart(64, "0")}`);
    assert.equal(order.to, DLN_SOURCE);
    assert.equal(order.data, data);
    assert.equal(order.value, DLN_EVM_FIX_FEE.toString());
    assert.equal(prepared.trackingId, orderId);
    assert.equal(prepared.extraCosts?.[0]?.amount, DLN_EVM_FIX_FEE.toString());
  });
});

describe("deBridge DLN Solana orders", () => {
  function solanaOrder(action: AdapterAction, args: Parameters<typeof dlnSolanaArgs>[1] = {}, tx: Parameters<typeof dlnSolanaTransaction>[2] = {}) {
    const data = dlnSolanaTransaction(action, dlnSolanaArgs(action, args), tx);
    const orderId = randomEvmHash();
    mock.dlnOrder = () => dlnOrderBody(action, { data }, { takeAmount: args.takeAmount ?? 23_990_823n, orderId });
    return orderId;
  }

  it("decodes create_order_with_nonce and plans with the program state's fixed fee", async () => {
    const action = bridgeAction("solana", "base");
    solanaOrder(action);
    const planned = await debridgeDlnAdapter.plan(action);
    assert.equal(planned.expectedOutput.amount, "23990823");
    assert.equal(planned.minimumOutput.amount, applySlippage("23990823", 5));
    assert.equal(planned.extraCosts?.[0]?.amount, DLN_SOLANA_FIX_FEE.toString());
    assert.equal(planned.extraCosts?.[0]?.symbol, "SOL");
    assert.equal(planned.transactionCount, 1);
  });

  it("refuses unpinned programs, foreign accounts and arguments that differ from the step", async () => {
    const action = bridgeAction("solana", "base");
    const cases: [Parameters<typeof dlnSolanaArgs>[1], Parameters<typeof dlnSolanaTransaction>[2], RegExp][] = [
      [{}, { extraProgram: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }, /invokes JUP6/u],
      [{}, { maker: OTHER_SOL_ADDRESS }, /not signed solely by the step account/u],
      [{}, { state: OTHER_SOL_ADDRESS }, /another DLN state account/u],
      [{}, { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }, /gives another token/u],
      [{ giveAmount: 26_000_000n }, {}, /gives another amount/u],
      [{ takeAmount: 24_500_000n }, {}, /takes another amount than quoted/u],
      [{ receiver: OTHER_EVM_ADDRESS }, {}, /pays another recipient/u],
      [{ patchAuthority: OTHER_SOL_ADDRESS }, {}, /another account may patch/u],
      [{ authority: OTHER_EVM_ADDRESS }, {}, /another account controls the order/u],
      [{ affiliate: true }, {}, /affiliate fee/u],
      [{ externalCall: true }, {}, /external call/u],
    ];
    for (const [args, tx, reason] of cases) {
      const data = dlnSolanaTransaction(action, dlnSolanaArgs(action, args), tx);
      // The quote echoes the step's take amount; mismatched instruction arguments must be caught from the calldata.
      mock.dlnOrder = () => dlnOrderBody(action, { data }, { takeAmount: 23_990_823n });
      const error = await errorOf(() => debridgeDlnAdapter.plan(action));
      assert.match(error, /^PROVIDER_TRANSACTION_INVALID/u, reason.source);
      assert.match(error, reason);
    }
    // A program other than the pinned DLN source as the order program.
    const foreign = dlnSolanaTransaction(action, dlnSolanaArgs(action), { program: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" });
    mock.dlnOrder = () => dlnOrderBody(action, { data: foreign }, { takeAmount: 23_990_823n });
    assert.match(await errorOf(() => debridgeDlnAdapter.plan(action)), /invokes JUP6/u);
    // The fee must equal the program state's fixed fee.
    resetDlnFixFeeCache();
    mock.solanaAccounts.set(DLN_SOLANA_STATE, dlnStateInfo(DLN_SOLANA_FIX_FEE / 3n));
    solanaOrder(action);
    assert.match(await errorOf(() => debridgeDlnAdapter.plan(action)), /differs from the on-chain fee/u);
    // A state account not owned by the DLN program is not read as the fee.
    resetDlnFixFeeCache();
    mock.solanaAccounts.set(DLN_SOLANA_STATE, dlnStateInfo(DLN_SOLANA_FIX_FEE, OTHER_SOL_ADDRESS));
    solanaOrder(action);
    assert.match(await errorOf(() => debridgeDlnAdapter.plan(action)), /^RPC_UNAVAILABLE/u);
  });

  it("re-assembles the validated instructions into a fresh transaction at prepare", async () => {
    const action = bridgeAction("solana", "base");
    const orderId = solanaOrder(action);
    const prepared = await debridgeDlnAdapter.prepare(prepareContext(action, preparedStep({ network: "solana", chain: CHAINS.solana.id, account: action.account.id })));
    const [transaction] = prepared.transactions;
    assert.ok(transaction?.vm === "svm");
    const message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(getBase64Encoder().encode(transaction.transaction)).messageBytes,
    );
    assert.ok(message.version === 0, "a v0 transaction");
    const programs = message.instructions.map((instruction) => String(message.staticAccounts[instruction.programAddressIndex]));
    assert.deepEqual([...new Set(programs)].sort(), ["ComputeBudget111111111111111111111111111111", DLN_SOLANA_SOURCE].sort());
    assert.equal(String(message.staticAccounts[0]), SOL_ADDRESS);
    assert.equal(prepared.records[0]?.to, DLN_SOLANA_SOURCE);
    assert.equal(prepared.trackingId, orderId);
    assert.equal(transaction.lastValidBlockHeight, 1_000);
  });

  it("binds a Solana deposit through the order index to an order quoted for the step", async () => {
    const action = bridgeAction("solana", "base");
    const orderId = randomEvmHash();
    const step = preparedStep({
      kind: "bridge",
      protocol: "debridge-dln",
      network: "solana",
      chain: CHAINS.solana.id,
      account: action.account.id,
      recipient: action.recipient.id,
      input: { asset: action.input.id, symbol: "USDC", decimals: 6, amount: "25000000", formatted: "25" },
      minimumOutput: { asset: action.output.id, symbol: "USDC", decimals: 6, amount: "23990823", formatted: "23.990823" },
      settlement: { kind: "cross-network", destinationNetwork: "base", trackingId: orderId },
      prepared: {
        quoteBinding: "c".repeat(64),
        preparedAt: new Date(PREPARED_AT).toISOString(),
        expiresAt: seconds(PREPARED_AT) + 90,
        transactions: [{ vm: "svm", network: "solana", feePayer: SOL_ADDRESS, to: DLN_SOLANA_SOURCE, description: "order" }],
      },
      evidence: [
        { kind: "quote", network: "solana", reference: "c".repeat(64), observedAt: new Date(PREPARED_AT).toISOString() },
        { kind: "quote", network: "solana", reference: orderId, observedAt: new Date(PREPARED_AT).toISOString() },
      ],
    });
    const land = (usdcAfter = "0") => {
      const signature = randomSolanaSignature();
      mock.rpc.solana.set(signature, {
        signature,
        confirmationStatus: "confirmed",
        body: {
          accountKeys: [SOL_ADDRESS, "Gg2wXJ5nU2eNBgcUsBDnWPLxZJzcsWkD2vPRfkzCSBbY", DLN_SOLANA_SOURCE],
          programIndexes: [2],
          blockTime: seconds(PREPARED_AT) + 20,
          fee: 5_000,
          preBalances: [1_000_000_000, 2_039_280, 1],
          postBalances: [985_000_000, 2_039_280, 1],
          preTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: SOL_ADDRESS, amount: "25000000" }],
          postTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: SOL_ADDRESS, amount: usdcAfter }],
        },
      });
      return signature;
    };
    const verify = (signature: string) => debridgeDlnAdapter.verify({ step, references: [signature], submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 });
    const unindexed = land();
    assert.equal(code(await verify(unindexed)), "pending");
    mock.dlnOrderIds.set(unindexed, [orderId]);
    assert.equal(code(await verify(unindexed)), "confirmed");
    const foreign = land();
    mock.dlnOrderIds.set(foreign, [randomEvmHash()]);
    assert.equal(code(await verify(foreign)), "REFERENCE_MISMATCH");
    const short = land("1000000");
    mock.dlnOrderIds.set(short, [orderId]);
    assert.equal(code(await verify(short)), "REFERENCE_MISMATCH");
  });
});

describe("deBridge DLN verification and settlement (EVM)", () => {
  async function landedOrder(action: AdapterAction, percentFee = 10_000n) {
    mock.allowance = 25_000_000n;
    const { data, orderId } = evmOrder(action);
    const prepared = await debridgeDlnAdapter.prepare(prepareContext(action));
    const { creation, salt } = dlnEvmCall(action);
    const order = dlnEventOrder(action, creation, salt, percentFee);
    return { data, orderId, transactions: prepared.transactions, order };
  }

  it("confirms only with the pinned DlnSource's CreatedOrder for a quoted order matching the calldata", async () => {
    const action = bridgeAction("arbitrum", "base");
    const { orderId, transactions, order } = await landedOrder(action);
    const step = evmBridgeStep(action, "debridge-dln", transactions, { trackingIds: [orderId] });
    const verify = (references: string[]) => debridgeDlnAdapter.verify({ step, references, submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 });
    const confirmed = await verify(landPrepared(mock.rpc, transactions, [createdOrderLog(order, orderId, 10_000n)]));
    assert.equal(code(confirmed), "confirmed");
    assert.ok(confirmed.evidence.some((entry) => entry.reference === orderId));
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [createdOrderLog(order, randomEvmHash(), 10_000n)]))), "OUTCOME_NOT_PROVEN");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [createdOrderLog({ ...order, receiverDst: OTHER_EVM_ADDRESS.toLowerCase() }, orderId, 10_000n)]))), "OUTCOME_NOT_PROVEN");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [{ ...createdOrderLog(order, orderId, 10_000n), address: OTHER_EVM_ADDRESS }]))), "OUTCOME_NOT_PROVEN");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, []))), "OUTCOME_NOT_PROVEN");
  });

  it("settles only on a fulfilled order with the pinned DlnDestination's FulfilledOrder paying the recipient", async () => {
    const action = bridgeAction("arbitrum", "base");
    const { orderId, transactions, order } = await landedOrder(action);
    const [deposit] = landPrepared(mock.rpc, transactions, [createdOrderLog(order, orderId, 10_000n)]);
    const step = evmBridgeStep(action, "debridge-dln", transactions, { trackingIds: [orderId], references: [deposit as string] });
    const fill = randomEvmHash();
    const landFill = (logs: ReturnType<typeof fulfilledOrderLog>[]) => mock.rpc.evm.set(fill, {
      hash: fill, from: OTHER_EVM_ADDRESS, to: DLN_DESTINATION, input: "0x", value: 0n, chainId: 8453, status: "success",
      blockNumber: 9_100n, timestamp: seconds(PREPARED_AT) + 60, logs,
    });
    const poll = async () => code(await debridgeDlnAdapter.poll?.(step, Date.now()));
    assert.equal(await poll(), "settling", "unknown order");
    mock.dlnOrders.set(orderId, { orderId: { stringValue: orderId }, state: "Created" });
    assert.equal(await poll(), "settling");
    mock.dlnOrders.set(orderId, { orderId: { stringValue: orderId }, state: "Fulfilled", fulfilledDstEventMetadata: { transactionHash: { stringValue: fill } } });
    landFill([]);
    assert.equal(await poll(), "settling", "no FulfilledOrder event for the order");
    landFill([{ ...fulfilledOrderLog(order, orderId), address: OTHER_EVM_ADDRESS }]);
    assert.equal(await poll(), "settling", "event from an unpinned contract");
    landFill([fulfilledOrderLog({ ...order, receiverDst: OTHER_EVM_ADDRESS.toLowerCase() }, orderId)]);
    assert.equal(await poll(), "SETTLEMENT_MISMATCH");
    landFill([fulfilledOrderLog(order, orderId)]);
    const settled = await debridgeDlnAdapter.poll?.(step, Date.now());
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, "24669417");
    assert.equal(settled?.evidence[0]?.reference, fill);
    mock.dlnOrders.set(orderId, { orderId: { stringValue: orderId }, state: "ClaimedOrderCancel" });
    assert.equal(await poll(), "SETTLEMENT_REFUNDED");
    assert.equal(accountBytes("base", EVM_ADDRESS), EVM_ADDRESS.toLowerCase());
  });
});
