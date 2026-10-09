import assert from "node:assert/strict";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import { applySlippage, type IntentGraph, type IntentStep, type TransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { lifiAdapter } from "../adapters/lifi.js";
import { actionForStep, planIntent } from "../planner.js";
import { configurePlatform } from "../service.js";
import { decodeStepRef } from "../stepRef.js";
import { resetLifiClient } from "../adapters/lifiClient.js";
import type { AdapterAction, VerificationResult } from "../adapters/types.js";
import {
  asset,
  bridgeAction,
  evmBridgeStep,
  FEE_FORWARDER,
  installCrossChainMock,
  landPrepared,
  LIFI_DIAMOND,
  lifiQuoteBody,
  lifiStartedLog,
  PREPARED_AT,
  tokenAccountInfo,
  transferLog,
  USDC_SOL,
  type CrossChainMock,
  type LifiQuoteOptions,
} from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, OTHER_SOL_ADDRESS, randomEvmHash, randomSolanaSignature, SOL_ADDRESS } from "./helpers.js";

let mock: CrossChainMock;
/** The recipient's USDC associated token account (derived; Polymer CCTP mints there). */
let SOL_USDC_ATA = "";

before(async () => {
  const [ata] = await findAssociatedTokenPda({ owner: address(SOL_ADDRESS), mint: address(USDC_SOL), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  SOL_USDC_ATA = String(ata);
});

beforeEach(() => {
  mock = installCrossChainMock();
  resetLifiClient();
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

function quoteWith(action: AdapterAction, options: LifiQuoteOptions = {}) {
  mock.lifiQuote = () => lifiQuoteBody(action, options);
}

const prepareContext = (action: AdapterAction) => ({
  graph: {} as IntentGraph,
  step: evmBridgeStep(action, "lifi", []),
  action,
  now: Date.now(),
});

describe("LI.FI routes it serves", () => {
  it("serves same-asset ERC-20 bridges from pinned-diamond EVM networks only", () => {
    assert.equal(lifiAdapter.supports(bridgeAction("base", "arbitrum")), true);
    assert.equal(lifiAdapter.supports(bridgeAction("ethereum", "solana")), true);
    assert.equal(lifiAdapter.supports(bridgeAction("base", "arbitrum", { symbol: "WETH" })), true);
    // Native input, Solana origin, cross-asset routes and same-network moves are not decoded.
    assert.equal(lifiAdapter.supports(bridgeAction("base", "arbitrum", { symbol: "ETH" })), false);
    assert.equal(lifiAdapter.supports(bridgeAction("solana", "base")), false);
    assert.equal(lifiAdapter.supports(bridgeAction("base", "arbitrum", { out: "WETH" })), false);
    assert.equal(lifiAdapter.supports({ ...bridgeAction("base", "arbitrum"), destinationNetwork: "base", output: asset("base", "USDC") }), false);
    // WETH to Solana has no decoded bridge (Across to Solana is not decoded).
    assert.equal(lifiAdapter.supports({ ...bridgeAction("base", "arbitrum", { symbol: "WETH" }), destinationNetwork: "solana", output: asset("solana", "USDC") }), false);
  });

  it("asks only for decodable bridges, no exchanges and no destination calls", async () => {
    const action = bridgeAction("base", "arbitrum");
    let query: URLSearchParams | null = null;
    mock.lifiQuote = (params) => {
      query = params;
      return lifiQuoteBody(action);
    };
    await lifiAdapter.plan(action);
    const sent = query as unknown as URLSearchParams;
    assert.equal(sent.get("allowBridges"), "across,polymerStandard");
    assert.equal(sent.get("allowExchanges"), "none");
    assert.equal(sent.get("allowDestinationCall"), "false");
    assert.equal(sent.get("fromAmount"), "25000000");
    assert.equal(sent.get("slippage"), "0.005");
    const toSolana = bridgeAction("base", "solana");
    mock.solanaAccounts.set(SOL_USDC_ATA, tokenAccountInfo(SOL_ADDRESS, USDC_SOL));
    mock.lifiQuote = (params) => {
      query = params;
      return lifiQuoteBody(toSolana, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA });
    };
    await lifiAdapter.plan(toSolana);
    // Never `near` or other undecoded Solana tools: only Polymer CCTP (USDC minted to the recipient's token account).
    assert.equal((query as unknown as URLSearchParams).get("allowBridges"), "polymerStandard");
  });
});

describe("LI.FI quote checks (plan and prepare)", () => {
  it("plans an Across route whose calldata matches the step", async () => {
    const action = bridgeAction("base", "arbitrum");
    quoteWith(action);
    const planned = await lifiAdapter.plan(action);
    assert.equal(planned.protocol, "lifi");
    // Across fills exactly the decoded output; the step minimum keeps a 5 bps re-quote cushion below it.
    const exact = ((24_937_500n * 999_600_000_000_000_000n) / 10n ** 18n).toString();
    assert.equal(planned.expectedOutput.amount, exact);
    assert.equal(planned.minimumOutput.amount, applySlippage(exact, 5));
    assert.equal(planned.transactionCount, 2);
    assert.equal(planned.estimatedSeconds, 20);
    assert.equal(planned.settlement.kind, "cross-network");
    assert.match(planned.warnings[0] ?? "", /^Route: LI\.FI via Across/u);
    mock.allowance = 25_000_000n;
    assert.equal((await lifiAdapter.plan(action)).transactionCount, 1);
  });

  it("refuses targets, ids, recipients, tokens, fees and floors that do not match", async () => {
    const action = bridgeAction("base", "arbitrum");
    const other32 = `0x${OTHER_EVM_ADDRESS.slice(2).padStart(64, "0").toLowerCase()}`;
    const cases: [LifiQuoteOptions, RegExp][] = [
      [{ to: OTHER_EVM_ADDRESS }, /not the pinned LiFiDiamond/u],
      [{ value: "0x1" }, /must not carry value/u],
      [{ bridge: { transactionId: randomEvmHash() } }, /transactionId differs from the quote/u],
      [{ bridge: { receiver: OTHER_EVM_ADDRESS } }, /receiver is not the step recipient/u],
      [{ bridge: { destinationChainId: 10n } }, /destination chain differs/u],
      [{ bridge: { hasDestinationCall: true } }, /carries a destination call/u],
      [{ bridge: { sendingAssetId: OTHER_EVM_ADDRESS } }, /bridged token is not the step input/u],
      [{ swap: { callTo: OTHER_EVM_ADDRESS, approveTo: OTHER_EVM_ADDRESS } }, /other than the pinned FeeForwarder/u],
      [{ swap: { receivingAssetId: OTHER_EVM_ADDRESS } }, /source swap changes the token/u],
      [{ swap: { fromAmount: 26_000_000n } }, /pulled from the wallet differs/u],
      [{ fee: 500_000n }, /fees exceed 1%/u],
      [{ across: { refundAddress: other32 } }, /Across refunds would go to another account/u],
      [{ across: { receivingAssetId: other32 } }, /Across output token is not the step output/u],
      [{ across: { receiverAddress: other32 } }, /Across recipient differs/u],
      [{ across: { message: "0x1234" } }, /carries a message/u],
      [{ across: { fillDeadline: Math.floor(Date.now() / 1000) + 30 } }, /fill deadline is too close/u],
      [{ toAmountMin: "24937400" }, /guarantees less than the quoted minimum/u],
      [{ reportedTool: "relaydepository" }, /tool relaydepository was not requested/u],
      [{ reportedTool: "polymerStandard" }, /does not match the polymerStandard tool/u],
      // An inflated Across output cannot be filled; it would only win the auction.
      [{ across: { outputAmountMultiplier: 1_100_000_000_000_000_000n }, toAmountMin: "27431250" }, /promises more than it bridges/u],
    ];
    for (const [options, reason] of cases) {
      quoteWith(action, options);
      const error = await errorOf(() => lifiAdapter.plan(action));
      assert.match(error, /^PROVIDER_TRANSACTION_INVALID/u, reason.source);
      assert.match(error, reason);
    }
  });

  it("refuses a route whose response does not echo the request", async () => {
    const action = bridgeAction("base", "arbitrum");
    mock.lifiQuote = () => {
      const body = lifiQuoteBody(action);
      (body.action as Record<string, unknown>).toAddress = OTHER_EVM_ADDRESS;
      return body;
    };
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /^PROVIDER_TRANSACTION_INVALID/u);
    mock.lifiQuote = () => ({ ...lifiQuoteBody(action), estimate: { ...lifiQuoteBody(action).estimate as object, toAmountMin: "20000000" } });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /below the requested slippage/u);
  });

  it("checks Polymer CCTP to Solana against the recipient's derived USDC account", async () => {
    const action = bridgeAction("base", "solana");
    mock.solanaAccounts.set(SOL_USDC_ATA, tokenAccountInfo(SOL_ADDRESS, USDC_SOL));
    quoteWith(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA });
    const planned = await lifiAdapter.plan(action);
    assert.equal(planned.expectedOutput.amount, "24937500");
    assert.equal(planned.minimumOutput.amount, applySlippage("24937500", 5));
    assert.equal(planned.estimatedSeconds, 1_095);
    // CCTP would mint into another token account, or report another wallet.
    quoteWith(action, { tool: "polymerStandard", solanaAta: "9SHQTA66Ekh7ZgMnKWsjxXk6DwXku8przs45E8bcEe38" });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /CCTP would mint to another token account/u);
    quoteWith(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA, polymer: { nonEVMReceiver: `0x${"11".repeat(32)}` } });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /Solana receiver differs/u);
    quoteWith(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA, polymer: { refundRecipient: OTHER_EVM_ADDRESS } });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /refunds would go to another account/u);
    quoteWith(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA, polymer: { hookData: "0x01" } });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /hook data/u);
    quoteWith(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA, polymer: { maxCCTPFee: 100_000n } });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /less than the quoted minimum/u);
    quoteWith(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA, bridge: { receiver: EVM_ADDRESS } });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /receiver is not the step recipient/u);
  });

  it("refuses Polymer to Solana when the recipient has no USDC account, before quoting", async () => {
    const action = bridgeAction("base", "solana");
    quoteWith(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA });
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /^ROUTE_UNAVAILABLE/u);
    mock.solanaAccounts.set(SOL_USDC_ATA, tokenAccountInfo(OTHER_SOL_ADDRESS, USDC_SOL));
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /^ROUTE_UNAVAILABLE/u);
    assert.equal(mock.calls.filter((url) => url.pathname === "/v1/quote").length, 0);
  });

  it("pauses LI.FI for a minute after a 429 instead of retrying every auction", async () => {
    const action = bridgeAction("base", "arbitrum");
    quoteWith(action);
    mock.lifiQuoteStatus = 429;
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /^PROVIDER_UNAVAILABLE/u);
    mock.lifiQuoteStatus = 200;
    assert.match(await errorOf(() => lifiAdapter.plan(action)), /^PROVIDER_UNAVAILABLE/u);
    assert.equal(mock.calls.filter((url) => url.pathname === "/v1/quote").length, 1);
  });

  it("prepares only the bridge tool the auction ranked, and holds prepare to an explicit maxSeconds", async () => {
    const action = bridgeAction("arbitrum", "base");
    mock.allowance = 25_000_000n;
    const allowBridges: (string | null)[] = [];
    let tool: "across" | "polymerStandard" = "across";
    mock.lifiQuote = (query) => {
      allowBridges.push(query.get("allowBridges"));
      return lifiQuoteBody(action, { tool });
    };
    const planned = await lifiAdapter.plan(action);
    assert.equal(planned.provider, "across");
    // The planner records the tool in the step ref and hands it back to prepare.
    configurePlatform({ adapters: [lifiAdapter] });
    try {
      const graph = await planIntent({ text: "bridge 25 USDC from arbitrum to base via lifi", accounts: [action.account.id] });
      const step = graph.steps[0] as IntentStep;
      assert.equal(decodeStepRef(step.quoteRef)?.provider, "across");
      assert.equal(actionForStep(graph, step).provider, "across");
    } finally {
      configurePlatform({ adapters: null });
    }
    const pinned = { ...action, provider: planned.provider };
    allowBridges.length = 0;
    tool = "polymerStandard";
    // An answer for another tool is refused (the client checks it against allowBridges; the adapter again).
    assert.match(await errorOf(() => lifiAdapter.prepare(prepareContext(pinned))), /^(?:QUOTE_MOVED|PROVIDER_TRANSACTION_INVALID): .*(?:polymerStandard|Polymer)/u);
    assert.deepEqual(allowBridges, ["across"], "the re-quote asks for the planned tool only");
    tool = "across";
    assert.equal((await lifiAdapter.prepare(prepareContext(pinned))).transactions.length, 1);
    // Without a recorded tool (steps planned before), the caller's time limit still binds the fresh quote.
    tool = "polymerStandard";
    const limited = { ...prepareContext(action), graph: { request: { constraints: { maxSeconds: 60 } } } as unknown as IntentGraph };
    assert.match(await errorOf(() => lifiAdapter.prepare(limited)), /^QUOTE_MOVED: .*beyond constraints\.maxSeconds \(60 s\)/u);
  });

  it("prepares an exact approval of the pinned diamond and the decoded diamond call", async () => {
    const action = bridgeAction("base", "arbitrum");
    const body = lifiQuoteBody(action);
    mock.lifiQuote = () => body;
    const prepared = await lifiAdapter.prepare(prepareContext(action));
    assert.equal(prepared.transactions.length, 2);
    const [approve, call] = prepared.transactions as [TransactionRequest, TransactionRequest];
    assert.ok(approve.vm === "evm" && call.vm === "evm");
    assert.equal(approve.to.toLowerCase(), action.input.address?.toLowerCase());
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve.data as Hex });
    assert.equal(decoded.functionName, "approve");
    assert.deepEqual(decoded.args, [LIFI_DIAMOND, 25_000_000n]);
    assert.equal(call.to, LIFI_DIAMOND);
    assert.equal(call.value, "0");
    assert.equal(call.data, (body.transactionRequest as { data: string }).data);
    assert.equal(prepared.trackingId, body.transactionId);
    // The same checks run at prepare: a fee forwarder swapped for another contract is refused.
    quoteWith(action, { swap: { callTo: OTHER_EVM_ADDRESS, approveTo: OTHER_EVM_ADDRESS } });
    assert.match(await errorOf(() => lifiAdapter.prepare(prepareContext(action))), /pinned FeeForwarder/u);
    assert.ok(FEE_FORWARDER);
  });
});

describe("LI.FI verification and settlement", () => {
  async function preparedPayload(action: AdapterAction, options: LifiQuoteOptions = {}) {
    const body = lifiQuoteBody(action, options);
    mock.lifiQuote = () => body;
    mock.allowance = 25_000_000n;
    const prepared = await lifiAdapter.prepare(prepareContext(action));
    return { body, transactions: prepared.transactions, transactionId: body.transactionId as string };
  }

  function code(result: VerificationResult): string {
    return result.status === "failed" ? result.failure.code : result.status;
  }

  it("confirms only with LiFiTransferStarted for the prepared transfer from the pinned diamond", async () => {
    const action = bridgeAction("arbitrum", "base");
    const { transactions } = await preparedPayload(action);
    const data = (transactions[0] as { data: Hex }).data;
    const step = evmBridgeStep(action, "lifi", transactions);
    const verify = (references: string[]) => lifiAdapter.verify({ step, references, submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 });
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [lifiStartedLog(data)]))), "confirmed");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, []))), "OUTCOME_NOT_PROVEN");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [lifiStartedLog(data, { transactionId: randomEvmHash() })]))), "OUTCOME_NOT_PROVEN");
    // The event must come from the pinned diamond, not any contract.
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [{ ...lifiStartedLog(data), address: OTHER_EVM_ADDRESS }]))), "OUTCOME_NOT_PROVEN");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [lifiStartedLog(data)], "reverted"))), "TRANSACTION_REVERTED");
  });

  it("settles on DONE/COMPLETED for the deposit's transfer with the destination credit on-chain", async () => {
    const action = bridgeAction("arbitrum", "base");
    const { transactions, transactionId } = await preparedPayload(action);
    const floor = (24_937_500n * 999_600_000_000_000_000n) / 10n ** 18n;
    const [deposit] = landPrepared(mock.rpc, transactions, []);
    const step = evmBridgeStep(action, "lifi", transactions, { references: [deposit as string], trackingIds: [transactionId] });
    const fill = randomEvmHash();
    const usdcBase = action.output.address as string;
    mock.rpc.evm.set(fill, {
      hash: fill, from: OTHER_EVM_ADDRESS, to: usdcBase, input: "0x", value: 0n, chainId: 8453, status: "success",
      blockNumber: 9_000n, timestamp: Math.floor(PREPARED_AT / 1000) + 90, logs: [transferLog(usdcBase, EVM_ADDRESS, floor)],
    });
    const status = (overrides: Record<string, unknown> = {}, receiving: Record<string, unknown> = {}) => ({
      transactionId, status: "DONE", substatus: "COMPLETED", tool: "across", toAddress: EVM_ADDRESS,
      receiving: { txHash: fill, chainId: 8453, amount: floor.toString(), token: { address: usdcBase }, ...receiving },
      ...overrides,
    });
    const poll = async () => {
      const result = await lifiAdapter.poll?.(step, Date.now());
      return result?.status === "failed" ? result.failure.code : result?.status;
    };
    assert.equal(await poll(), "settling", "not indexed (404 / code 1003)");
    mock.lifiStatus.set(deposit as string, status({ status: "PENDING", substatus: "WAIT_DESTINATION_TRANSACTION" }));
    assert.equal(await poll(), "settling");
    mock.lifiStatus.set(deposit as string, status({ transactionId: randomEvmHash() }));
    assert.equal(await poll(), "settling", "another transfer's status never settles the step");
    mock.lifiStatus.set(deposit as string, status({ substatus: "PARTIAL" }));
    assert.equal(await poll(), "SETTLEMENT_MISMATCH");
    mock.lifiStatus.set(deposit as string, status({ substatus: "REFUNDED" }));
    assert.equal(await poll(), "SETTLEMENT_REFUNDED");
    mock.lifiStatus.set(deposit as string, status({ status: "FAILED", substatus: null }));
    assert.equal(await poll(), "SETTLEMENT_FAILED");
    mock.lifiStatus.set(deposit as string, status({ toAddress: OTHER_EVM_ADDRESS }));
    assert.equal(await poll(), "SETTLEMENT_MISMATCH");
    mock.lifiStatus.set(deposit as string, status({}, { token: { address: OTHER_EVM_ADDRESS } }));
    assert.equal(await poll(), "SETTLEMENT_MISMATCH");
    mock.lifiStatus.set(deposit as string, status({}, { amount: (floor - 1n).toString() }));
    assert.equal(await poll(), "SETTLEMENT_MISMATCH");
    mock.lifiStatus.set(deposit as string, status());
    const settled = await lifiAdapter.poll?.(step, Date.now());
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, floor.toString());
    assert.equal(settled?.evidence[0]?.reference, fill);
    // A fill that credits nobody we know stays settling.
    mock.rpc.evm.set(fill, { ...mock.rpc.evm.get(fill)!, logs: [transferLog(usdcBase, OTHER_EVM_ADDRESS, floor)] });
    assert.equal(await poll(), "settling");
  });

  it("never settles on a credit mined before the step was prepared, and reports at most the prepared expected output", async () => {
    const action = bridgeAction("arbitrum", "base");
    const { transactions, transactionId } = await preparedPayload(action);
    const floor = (24_937_500n * 999_600_000_000_000_000n) / 10n ** 18n;
    const [deposit] = landPrepared(mock.rpc, transactions, []);
    const step = evmBridgeStep(action, "lifi", transactions, { references: [deposit as string], trackingIds: [transactionId] });
    const usdcBase = action.output.address as string;
    const fill = (amount: bigint, timestamp: number, blockNumber: bigint) => {
      const hash = randomEvmHash();
      mock.rpc.evm.set(hash, { hash, from: OTHER_EVM_ADDRESS, to: usdcBase, input: "0x", value: 0n, chainId: 8453, status: "success", blockNumber, timestamp, logs: [transferLog(usdcBase, EVM_ADDRESS, amount)] });
      mock.lifiStatus.set(deposit as string, {
        transactionId, status: "DONE", substatus: "COMPLETED", tool: "across", toAddress: EVM_ADDRESS,
        receiving: { txHash: hash, chainId: 8453, amount: floor.toString(), token: { address: usdcBase } },
      });
    };
    // An old transfer to the recipient that the status API names as the fill.
    fill(floor, Math.floor(PREPARED_AT / 1000) - 86_400, 8_000n);
    assert.equal((await lifiAdapter.poll?.(step, Date.now()))?.status, "settling");
    // A credit above the prepared expected output does not fund dependents beyond it.
    fill(30_000_000n, Math.floor(PREPARED_AT / 1000) + 90, 9_300n);
    const expected = { ...(step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>), amount: "24937500", formatted: "24.9375" };
    const settled = await lifiAdapter.poll?.({ ...step, expectedOutput: expected }, Date.now());
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : settled?.status, "24937500");
  });

  it("reads Solana destination credits for CCTP mints", async () => {
    const action = bridgeAction("arbitrum", "solana");
    mock.solanaAccounts.set(SOL_USDC_ATA, tokenAccountInfo(SOL_ADDRESS, USDC_SOL));
    const { transactions, transactionId } = await preparedPayload(action, { tool: "polymerStandard", solanaAta: SOL_USDC_ATA });
    const [deposit] = landPrepared(mock.rpc, transactions, []);
    const step = evmBridgeStep(action, "lifi", transactions, { references: [deposit as string], trackingIds: [transactionId] });
    const fill = randomSolanaSignature();
    mock.rpc.solana.set(fill, {
      signature: fill,
      confirmationStatus: "finalized",
      body: {
        accountKeys: ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", SOL_USDC_ATA],
        programIndexes: [],
        blockTime: Math.floor(PREPARED_AT / 1000) + 900,
        fee: 5_000,
        preBalances: [1_000_000, 2_039_280],
        postBalances: [995_000, 2_039_280],
        preTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: SOL_ADDRESS, amount: "0" }],
        postTokenBalances: [{ accountIndex: 1, mint: USDC_SOL, owner: SOL_ADDRESS, amount: "24937500" }],
      },
    });
    mock.lifiStatus.set(deposit as string, {
      transactionId, status: "DONE", substatus: "COMPLETED", tool: "polymerStandard", toAddress: SOL_ADDRESS,
      receiving: { txHash: fill, chainId: 1151111081099710, amount: "24937500", token: { address: USDC_SOL } },
    });
    const settled = await lifiAdapter.poll?.(step, Date.now());
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, "24937500");
  });
});
