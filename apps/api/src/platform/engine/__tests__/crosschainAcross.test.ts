/**
 * Across adapter (protocols design 3.4, P6a) against the recorded
 * `/suggested-fees` and `/deposit/status` bodies: Kletia encodes the exact
 * SpokePool deposit, refuses quotes that leave the pins or the SpokePool's
 * time buffers, proves the deposit from FundsDeposited and settles only on a
 * fill that credits the recipient the deposit's exact output.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { applySlippage, type IntentGraph, type IntentStep, type TransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  acrossAdapter,
  acrossSpokePool,
  acrossWeth,
  ACROSS_FILL_DEADLINE_BUFFER_SECONDS,
  ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS,
  exclusivityWindowSeconds,
  MAX_EXCLUSIVITY_SECONDS,
} from "../adapters/across.js";
import type { AdapterAction, SettlementResult, VerificationResult } from "../adapters/types.js";
import {
  ACROSS_SPOKE_ARBITRUM,
  ACROSS_SPOKE_BASE,
  acrossQuoteBody,
  asset,
  bridgeAction,
  bridgeFixture,
  ETH_PROXY_MINT,
  evmBridgeStep,
  fundsDepositedLog,
  installCrossChainMock,
  landPrepared,
  PREPARED_AT,
  seconds,
  transferLog,
  type CrossChainMock,
} from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, randomEvmHash } from "./helpers.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
/** The recorded quote: 100 USDC Base -> Arbitrum delivers exactly 99.983067 USDC. */
const RECORDED_OUTPUT = 99_983_067n;

let mock: CrossChainMock;
let integrator: string | undefined;

beforeEach(() => {
  mock = installCrossChainMock();
  integrator = process.env.ACROSS_INTEGRATOR_ID;
  delete process.env.ACROSS_INTEGRATOR_ID;
});

afterEach(() => {
  mock.restore();
  if (integrator === undefined) delete process.env.ACROSS_INTEGRATOR_ID;
  else process.env.ACROSS_INTEGRATOR_ID = integrator;
});

function hundred(options: { recipient?: string } = {}): AdapterAction {
  return bridgeAction("base", "arbitrum", { amount: "100000000", ...options });
}

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

const prepareContext = (action: AdapterAction, step: IntentStep = evmBridgeStep(action, "across", [])) => ({
  graph: {} as IntentGraph,
  step,
  action,
  now: Date.now(),
});

/** The deposit encoded independently of the adapter, from the quote body's own fields. */
function expectedDeposit(action: AdapterAction, body: Record<string, unknown>): Hex {
  const abi = parseAbi([
    "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
  ]);
  const word = (value: string) => `0x${value.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  return encodeFunctionData({
    abi,
    functionName: "deposit",
    args: [
      word(action.account.address),
      word(action.recipient.address),
      word(USDC_BASE),
      word(USDC_ARBITRUM),
      100_000_000n,
      BigInt(String(body.outputAmount)),
      42_161n,
      word(String(body.exclusiveRelayer)),
      Number(body.timestamp),
      Number(body.fillDeadline),
      Number(body.exclusivityDeadline),
      "0x",
    ],
  });
}

describe("Across routes it serves", () => {
  it("serves registry USDC between the EVM production networks only", () => {
    assert.equal(acrossAdapter.supports(bridgeAction("base", "arbitrum")), true);
    assert.equal(acrossAdapter.supports(bridgeAction("ethereum", "polygon")), true);
    assert.equal(acrossAdapter.supports(bridgeAction("optimism", "base")), true);
    assert.equal(acrossAdapter.supports(bridgeAction("base", "optimism", { symbol: "ETH" })), true, "ETH both ways (RC6)");
    assert.equal(acrossAdapter.supports(bridgeAction("base", "polygon", { symbol: "ETH", out: "WETH" })), true, "ETH to Polygon's WETH");
    assert.equal(acrossAdapter.supports(bridgeAction("base", "arbitrum", { symbol: "WETH" })), true);
    assert.equal(acrossAdapter.supports(bridgeAction("base", "arbitrum", { symbol: "ETH", out: "USDC" })), false, "no token change");
    assert.equal(acrossAdapter.supports(bridgeAction("polygon", "base", { symbol: "POL", out: "ETH" })), false, "POL is not ETH");
    assert.equal(acrossAdapter.supports(bridgeAction("base", "solana")), false, "no Solana spoke pinned");
    assert.equal(acrossAdapter.supports(bridgeAction("solana", "base")), false);
    assert.equal(acrossAdapter.supports({ ...bridgeAction("base", "arbitrum"), destinationNetwork: "base", output: asset("base", "USDC") }), false);
    assert.equal(acrossAdapter.supports({ ...bridgeAction("base", "arbitrum"), input: { ...asset("base", "USDC"), transferOnly: true } }), false);
    assert.equal(acrossAdapter.supports({ ...bridgeAction("base", "arbitrum"), output: { ...asset("arbitrum", "USDC"), canonical: false } }), false);
    assert.equal(acrossAdapter.supports({ ...bridgeAction("base", "arbitrum"), destinationNetwork: "arbitrum-sepolia", output: asset("arbitrum-sepolia", "USDC") }), false);
  });
});

describe("Across quotes and the encoded deposit", () => {
  it("plans the recorded quote: exact output, on-chain floor, re-quote cushion and the refund rule", async () => {
    const action = hundred();
    let query: URLSearchParams | null = null;
    mock.acrossQuote = (params) => {
      query = params;
      return acrossQuoteBody(action);
    };
    const planned = await acrossAdapter.plan(action);
    const sent = query as unknown as URLSearchParams;
    assert.equal(sent.get("depositor"), EVM_ADDRESS);
    assert.equal(sent.get("recipient"), EVM_ADDRESS);
    assert.equal(sent.get("amount"), "100000000");
    assert.equal(sent.get("originChainId"), "8453");
    assert.equal(sent.get("destinationChainId"), "42161");
    assert.equal(planned.protocol, "across");
    assert.equal(planned.expectedOutput.amount, RECORDED_OUTPUT.toString());
    assert.equal(planned.minimumOutput.amount, applySlippage(RECORDED_OUTPUT.toString(), 5));
    assert.equal(planned.floor, "onchain");
    assert.equal(planned.transactionCount, 2, "exact approval, then the deposit");
    assert.equal(planned.estimatedSeconds, 6, "the fill estimate plus Base's confirmation (no signing margin, design B.2)");
    assert.equal(planned.settlement.kind, "cross-network");
    assert.ok(planned.warnings.some((warning) => /refunds the deposit to the sending account on Base/u.test(warning)), planned.warnings.join(" | "));
    assert.equal(planned.preview?.approvalSpender, ACROSS_SPOKE_BASE.toLowerCase());
    assert.equal(planned.preview?.venueFees?.[0]?.amount, "16933");
  });

  it("encodes the exact deposit(bytes32 ...) call with and without the integrator suffix", async () => {
    const action = hundred();
    const body = acrossQuoteBody(action);
    mock.acrossQuote = () => body;
    const plain = await acrossAdapter.prepare(prepareContext(action));
    const [approve, deposit] = plain.transactions as [TransactionRequest, TransactionRequest];
    assert.ok(approve.vm === "evm" && deposit.vm === "evm");
    assert.equal(approve.to, USDC_BASE);
    assert.equal(approve.data, `0x095ea7b3${ACROSS_SPOKE_BASE.slice(2).toLowerCase().padStart(64, "0")}${(100_000_000n).toString(16).padStart(64, "0")}`);
    assert.equal(deposit.to, ACROSS_SPOKE_BASE);
    assert.equal(deposit.value, "0");
    assert.equal(deposit.data, expectedDeposit(action, body));
    assert.equal(plain.expectedOutput.amount, RECORDED_OUTPUT.toString());
    process.env.ACROSS_INTEGRATOR_ID = "0x00AB";
    const attributed = await acrossAdapter.prepare(prepareContext(action));
    const tagged = attributed.transactions[1];
    assert.ok(tagged?.vm === "evm");
    assert.equal(tagged.data, `${expectedDeposit(action, body)}1dc0de00ab`);
    process.env.ACROSS_INTEGRATOR_ID = "0x1";
    assert.match(await errorOf(() => acrossAdapter.prepare(prepareContext(action))), /^PROVIDER_UNAVAILABLE.*ACROSS_INTEGRATOR_ID/u);
  });

  it("skips the approval when the SpokePool allowance covers the amount", async () => {
    const action = hundred();
    mock.acrossQuote = () => acrossQuoteBody(action);
    mock.allowance = 100_000_000n;
    const prepared = await acrossAdapter.prepare(prepareContext(action));
    assert.equal(prepared.transactions.length, 1);
    assert.equal(prepared.transactions[0]?.vm === "evm" ? prepared.transactions[0].to : null, ACROSS_SPOKE_BASE);
  });

  it("pays a third-party recipient and keeps the refund with the sending account", async () => {
    const action = hundred({ recipient: OTHER_EVM_ADDRESS });
    const body = acrossQuoteBody(action);
    mock.acrossQuote = () => body;
    const planned = await acrossAdapter.plan(action);
    assert.ok(planned.warnings.some((warning) => warning.includes(`Across pays ${OTHER_EVM_ADDRESS}`)));
    const prepared = await acrossAdapter.prepare(prepareContext(action));
    const deposit = prepared.transactions[1];
    assert.ok(deposit?.vm === "evm");
    assert.equal(deposit.data, expectedDeposit(action, body));
    assert.ok(deposit.data.includes(OTHER_EVM_ADDRESS.slice(2).toLowerCase()), "recipient in the calldata");
    assert.ok(deposit.data.includes(EVM_ADDRESS.slice(2).toLowerCase()), "the step account is the depositor (refunds go there)");
  });

  it("refuses quotes off the pins, too low, beyond the SpokePool buffers or otherwise malformed", async () => {
    const action = hundred();
    const now = Math.floor(Date.now() / 1000);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ spokePoolAddress: OTHER_EVM_ADDRESS }, /^PROVIDER_TRANSACTION_INVALID.*origin SpokePool .* is not the pinned/u],
      [{ destinationSpokePoolAddress: ACROSS_SPOKE_BASE }, /^PROVIDER_TRANSACTION_INVALID.*destination SpokePool/u],
      [{ isAmountTooLow: true }, /^AMOUNT_TOO_SMALL/u],
      [{ limits: { minDeposit: "200000000", maxDeposit: "611889123624", maxDepositInstant: "51736593723" } }, /^AMOUNT_TOO_SMALL/u],
      [{ limits: { minDeposit: "1", maxDeposit: "50000000", maxDepositInstant: "50000000" } }, /^ROUTE_UNAVAILABLE/u],
      [{ fillDeadline: String(now + ACROSS_FILL_DEADLINE_BUFFER_SECONDS + 60) }, /^PROVIDER_TRANSACTION_INVALID.*fill deadline buffer/u],
      [{ fillDeadline: String(now + 60) }, /^PROVIDER_TRANSACTION_INVALID.*fill deadline is too close/u],
      [{ timestamp: String(now - 3_500) }, /^PROVIDER_TRANSACTION_INVALID.*too old/u],
      [{ timestamp: String(now + 3_600) }, /^PROVIDER_TRANSACTION_INVALID.*in the future/u],
      [{ outputAmount: "100000001" }, /^PROVIDER_TRANSACTION_INVALID.*above the amount/u],
      [{ outputAmount: "0" }, /^PROVIDER_TRANSACTION_INVALID/u],
      [{ outputAmount: "80000000" }, /^PRICE_IMPACT_TOO_HIGH/u],
      [{ exclusiveRelayer: "0x0000000000000000000000000000000000000000", exclusivityDeadline: 5 }, /^PROVIDER_TRANSACTION_INVALID.*exclusive relayer/u],
      [{ outputToken: { address: USDC_BASE, chainId: 42161 } }, /^PROVIDER_TRANSACTION_INVALID.*output token/u],
      [{ spokePoolAddress: "not an address" }, /^PROVIDER_TRANSACTION_INVALID.*spokePoolAddress/u],
    ];
    for (const [overrides, reason] of cases) {
      mock.acrossQuote = () => acrossQuoteBody(action, overrides);
      assert.match(await errorOf(() => acrossAdapter.plan(action)), reason, JSON.stringify(overrides));
      assert.match(await errorOf(() => acrossAdapter.prepare(prepareContext(action))), reason, `prepare ${JSON.stringify(overrides)}`);
    }
  });
});

describe("Across exclusivity (RC7, red-team D9)", () => {
  const RELAYER = "0x1111111111111111111111111111111111111111";

  it("reads exclusivityParameter like the SpokePool: a period up to MAX_EXCLUSIVITY_PERIOD_SECONDS, a timestamp above it", () => {
    const now = 1_790_000_000;
    assert.equal(ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS, 31_536_000, "read back from all five pinned SpokePools on 2026-10-23");
    assert.equal(exclusivityWindowSeconds(0, now), 0);
    assert.equal(exclusivityWindowSeconds(5, now), 5, "a period");
    assert.equal(exclusivityWindowSeconds(ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS, now), ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS, "at the constant: still a period");
    assert.equal(exclusivityWindowSeconds(ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS + 1, ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS), 1, "above it: a timestamp");
    assert.equal(exclusivityWindowSeconds(now + 120, now), 120);
    assert.equal(exclusivityWindowSeconds(now - 60, now), 0, "a timestamp already past leaves no exclusivity");
  });

  it("accepts the absolute exclusivity deadline Across returns from Ethereum and Polygon, and refuses long windows", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const network of ["ethereum", "polygon"] as const) {
      const action = bridgeAction(network, "base", { amount: "100000000" });
      mock.acrossQuote = () => acrossQuoteBody(action, {
        exclusiveRelayer: RELAYER,
        exclusivityDeadline: now + 30,
        spokePoolAddress: acrossSpokePool(network),
        destinationSpokePoolAddress: acrossSpokePool("base"),
      });
      const planned = await acrossAdapter.plan(action);
      assert.equal(planned.protocol, "across", network);
      const deposit = planned.preview?.transactions.at(-1);
      assert.ok(deposit && deposit.vm === "evm");
      assert.ok(deposit.data.includes((now + 30).toString(16)), "the timestamp is encoded unchanged");
    }
    const action = hundred();
    const cases: [number, boolean][] = [
      [MAX_EXCLUSIVITY_SECONDS, true],
      [MAX_EXCLUSIVITY_SECONDS + 1, false],
      [now + MAX_EXCLUSIVITY_SECONDS - 60, true],
      [now + 2 * MAX_EXCLUSIVITY_SECONDS, false],
      [now - 10, true],
      [ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS, false],
    ];
    for (const [exclusivityDeadline, accepted] of cases) {
      mock.acrossQuote = () => acrossQuoteBody(action, { exclusiveRelayer: RELAYER, exclusivityDeadline });
      if (accepted) assert.equal((await acrossAdapter.plan(action)).protocol, "across", String(exclusivityDeadline));
      else assert.match(await errorOf(() => acrossAdapter.plan(action)), /^PROVIDER_TRANSACTION_INVALID.*exclusivity window is too long/u, String(exclusivityDeadline));
    }
  });
});

describe("Across verification and settlement", () => {
  async function landed(action: AdapterAction) {
    mock.allowance = 0n;
    const body = acrossQuoteBody(action);
    mock.acrossQuote = () => body;
    const prepared = await acrossAdapter.prepare(prepareContext(action));
    const deposit = prepared.transactions[1];
    assert.ok(deposit?.vm === "evm");
    return { transactions: prepared.transactions, data: deposit.data as Hex };
  }

  const stepFor = (action: AdapterAction, transactions: readonly TransactionRequest[], references?: string[]) =>
    evmBridgeStep(action, "across", transactions, { minimum: applySlippage(RECORDED_OUTPUT.toString(), 5), ...(references ? { references } : {}) });

  it("confirms only with the pinned SpokePool's FundsDeposited matching the calldata, depositor and recipient", async () => {
    const action = hundred();
    const { transactions, data } = await landed(action);
    const step = stepFor(action, transactions);
    const verify = (references: string[]) => acrossAdapter.verify({ step, references, submittedAt: PREPARED_AT, now: PREPARED_AT + 60_000 });
    const confirmed = await verify(landPrepared(mock.rpc, transactions, [fundsDepositedLog(ACROSS_SPOKE_BASE, data, 6_333_400n)]));
    assert.equal(code(confirmed), "confirmed");
    assert.ok(confirmed.evidence.some((entry) => entry.reference === "6333400"));
    const other = `0x${OTHER_EVM_ADDRESS.slice(2).toLowerCase().padStart(64, "0")}`;
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [fundsDepositedLog(ACROSS_SPOKE_BASE, data, 1n, { recipient: other })]))), "OUTCOME_NOT_PROVEN", "another recipient");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [fundsDepositedLog(ACROSS_SPOKE_BASE, data, 1n, { inputAmount: 99_000_000n })]))), "OUTCOME_NOT_PROVEN", "another amount");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [fundsDepositedLog(ACROSS_SPOKE_BASE, data, 1n, { outputAmount: 90_000_000n })]))), "OUTCOME_NOT_PROVEN", "another output");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [fundsDepositedLog(ACROSS_SPOKE_BASE, data, 1n, { depositor: other })]))), "OUTCOME_NOT_PROVEN", "another depositor");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, [fundsDepositedLog(OTHER_EVM_ADDRESS, data, 1n)]))), "OUTCOME_NOT_PROVEN", "unpinned emitter");
    assert.equal(code(await verify(landPrepared(mock.rpc, transactions, []))), "OUTCOME_NOT_PROVEN", "no event");
  });

  it("settles a filled deposit only on a fill crediting the recipient the exact output; expired is refunded", async () => {
    const action = hundred({ recipient: OTHER_EVM_ADDRESS });
    const { transactions, data } = await landed(action);
    const references = landPrepared(mock.rpc, transactions, [fundsDepositedLog(ACROSS_SPOKE_BASE, data, 6_333_400n)]);
    const deposit = references[references.length - 1] as string;
    const step = stepFor(action, transactions, references);
    const poll = () => acrossAdapter.poll?.(step, Date.now());
    const unknown = await poll();
    assert.equal(code(unknown), "settling", "not indexed yet");
    assert.equal(unknown?.status === "settling" ? unknown.trackingId : null, "6333400", "the deposit id becomes the tracking id");
    const recorded = bridgeFixture("across-deposit-status-filled.json");
    const fill = randomEvmHash();
    const status = (overrides: Record<string, unknown>) => mock.acrossStatus.set("8453:6333400", { ...recorded, depositTxHash: deposit, depositTxnRef: deposit, fillTx: fill, fillTxnRef: fill, destinationChainId: 42161, ...overrides });
    status({ status: "pending", fillTx: null, fillTxnRef: null });
    assert.equal(code(await poll()), "settling");
    status({ depositTxHash: randomEvmHash(), depositTxnRef: null });
    assert.equal(code(await poll()), "settling", "a status record for another deposit transaction never settles");
    status({});
    const landFill = (credit: bigint, to = OTHER_EVM_ADDRESS) => mock.rpc.evm.set(fill, {
      hash: fill, from: "0x3333333333333333333333333333333333333333", to: ACROSS_SPOKE_ARBITRUM, input: "0x", value: 0n, chainId: 42161, status: "success",
      blockNumber: 9_200n, timestamp: seconds(PREPARED_AT) + 40, logs: [transferLog(USDC_ARBITRUM, to, credit)],
    });
    landFill(RECORDED_OUTPUT, EVM_ADDRESS);
    assert.equal(code(await poll()), "settling", "a fill that pays someone else is not this deposit's fill");
    landFill(RECORDED_OUTPUT - 1n);
    const short = await poll();
    assert.equal(code(short), "SETTLEMENT_MISMATCH");
    assert.equal(short?.status === "failed" ? short.credited?.amount : null, (RECORDED_OUTPUT - 1n).toString(), "the credit is reported");
    landFill(RECORDED_OUTPUT);
    const settled = await poll();
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, RECORDED_OUTPUT.toString());
    assert.equal(settled?.evidence[0]?.reference, fill);
    status({ status: "expired", fillTx: null, fillTxnRef: null });
    const expired = await poll();
    assert.equal(code(expired), "SETTLEMENT_REFUNDED");
    assert.match(expired?.status === "failed" ? expired.failure.message : "", /refunds it to the sending account on Base/u);
    status({ status: "refunded", fillTx: null, fillTxnRef: null, depositRefundTxHash: randomEvmHash() });
    assert.equal(code(await poll()), "SETTLEMENT_REFUNDED");
  });
});

describe("Across ETH and WETH: the delivered form follows the recipient's code (RC6, D2, seam S6)", () => {
  const WETH_BASE = "0x4200000000000000000000000000000000000006";
  const WETH_ARBITRUM = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
  const ONE_ETH = 10n ** 18n;
  const OUT = 999_400_000_000_000_000n;
  const DELEGATION = `0xef0100${"ab".repeat(20)}`;

  function ethQuote(action: AdapterAction, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return acrossQuoteBody(action, {
      inputToken: { address: acrossWeth(action.network), symbol: "WETH", decimals: 18, chainId: 8453 },
      outputToken: { address: acrossWeth(action.destinationNetwork), symbol: "WETH", decimals: 18, chainId: 42161 },
      outputAmount: OUT.toString(),
      totalRelayFee: { pct: "600000000000000", total: (ONE_ETH - OUT).toString() },
      limits: { minDeposit: "1000000000000000", maxDeposit: (10n ** 22n).toString(), maxDepositInstant: (10n ** 21n).toString() },
      ...overrides,
    });
  }

  function ethAction(options: { symbol?: string; out?: string; recipient?: string } = {}): AdapterAction {
    return bridgeAction("base", "arbitrum", { symbol: options.symbol ?? "ETH", out: options.out ?? options.symbol ?? "ETH", amount: ONE_ETH.toString(), ...(options.recipient ? { recipient: options.recipient } : {}) });
  }

  it("wraps native ETH through the SpokePool: WETH on both sides of the quote and the deposit, msg.value = amount, no approval", async () => {
    const action = ethAction();
    let query: URLSearchParams | null = null;
    mock.prices.set(ETH_PROXY_MINT, 2_400);
    mock.acrossQuote = (params) => {
      query = params;
      return ethQuote(action);
    };
    const planned = await acrossAdapter.plan(action);
    const sent = query as unknown as URLSearchParams;
    assert.equal(sent.get("inputToken"), WETH_BASE);
    assert.equal(sent.get("outputToken"), WETH_ARBITRUM);
    assert.equal(planned.expectedOutput.amount, OUT.toString());
    assert.equal(planned.expectedOutput.symbol, "ETH", "native ETH is what an account without code receives");
    assert.equal(planned.transactionCount, 1, "no approval for native ETH");
    assert.ok(planned.feesUsd !== undefined && Math.abs(planned.feesUsd - 0.0006 * 2_400) < 1e-6, `fee priced in USD: ${planned.feesUsd}`);
    assert.ok(planned.warnings.some((warning) => /delivers native ETH because the recipient has no code/u.test(warning)), planned.warnings.join(" | "));
    const prepared = await acrossAdapter.prepare(prepareContext(action));
    assert.equal(prepared.transactions.length, 1);
    const deposit = prepared.transactions[0];
    assert.ok(deposit?.vm === "evm");
    assert.equal(deposit.to, ACROSS_SPOKE_BASE);
    assert.equal(deposit.value, ONE_ETH.toString());
    assert.ok(deposit.data.includes(WETH_BASE.slice(2).toLowerCase()), "input token WETH");
    assert.ok(deposit.data.includes(WETH_ARBITRUM.slice(2).toLowerCase()), "output token WETH (unwrapped by the SpokePool for an account without code)");
  });

  it("refuses native ETH to an account with code (contract or EIP-7702 delegation) and when the code cannot be read", async () => {
    const action = ethAction({ recipient: OTHER_EVM_ADDRESS });
    mock.acrossQuote = () => ethQuote(action);
    mock.accountCodes.set(OTHER_EVM_ADDRESS.toLowerCase(), DELEGATION);
    assert.match(await errorOf(() => acrossAdapter.plan(action)), /^ROUTE_UNAVAILABLE.*WETH, not ETH.*EIP-7702 delegation/u);
    assert.match(await errorOf(() => acrossAdapter.prepare(prepareContext(action))), /^ROUTE_UNAVAILABLE.*WETH, not ETH/u, "checked again at prepare");
    mock.accountCodes.set(OTHER_EVM_ADDRESS.toLowerCase(), "0x6080604052");
    assert.match(await errorOf(() => acrossAdapter.plan(action)), /^ROUTE_UNAVAILABLE.*WETH, not ETH.*a contract/u);
    mock.accountCodes.set(OTHER_EVM_ADDRESS.toLowerCase(), "error");
    assert.match(await errorOf(() => acrossAdapter.plan(action)), /^ROUTE_UNAVAILABLE.*could not be checked/u);
    assert.ok(!mock.calls.some((url) => url.pathname === "/api/suggested-fees"), "no quote is asked for an ineligible output form");
  });

  it("delivers WETH only to an account with code; an account without code would receive ETH", async () => {
    const eoa = ethAction({ symbol: "WETH" });
    mock.acrossQuote = () => ethQuote(eoa);
    assert.match(await errorOf(() => acrossAdapter.plan(eoa)), /^ROUTE_UNAVAILABLE.*native ETH, not WETH/u);
    const contract = ethAction({ symbol: "WETH", recipient: OTHER_EVM_ADDRESS });
    mock.accountCodes.set(OTHER_EVM_ADDRESS.toLowerCase(), DELEGATION);
    mock.acrossQuote = () => ethQuote(contract);
    const planned = await acrossAdapter.plan(contract);
    assert.equal(planned.expectedOutput.symbol, "WETH");
    assert.equal(planned.transactionCount, 2, "WETH input needs the exact approval");
    const prepared = await acrossAdapter.prepare(prepareContext(contract));
    assert.equal(prepared.transactions[1]?.vm === "evm" ? prepared.transactions[1].value : null, "0");
  });

  it("delivers WETH on Polygon as the token itself (no code check: POL is the gas asset there)", async () => {
    const action = bridgeAction("base", "polygon", { symbol: "ETH", out: "WETH", amount: ONE_ETH.toString() });
    mock.accountCodes.set(EVM_ADDRESS.toLowerCase(), "error");
    mock.acrossQuote = () => ethQuote(action, {
      outputToken: { address: acrossWeth("polygon"), symbol: "WETH", decimals: 18, chainId: 137 },
      destinationSpokePoolAddress: acrossSpokePool("polygon"),
    });
    const planned = await acrossAdapter.plan(action);
    assert.equal(planned.expectedOutput.symbol, "WETH");
  });

  it("fails a native fill that arrived as WETH (the recipient gained code) instead of settling it as ETH", async () => {
    const action = ethAction();
    mock.acrossQuote = () => ethQuote(action);
    const prepared = await acrossAdapter.prepare(prepareContext(action));
    const data = (prepared.transactions[0] as { data: Hex }).data;
    const references = landPrepared(mock.rpc, prepared.transactions, [fundsDepositedLog(ACROSS_SPOKE_BASE, data, 77n)]);
    const step = evmBridgeStep(action, "across", prepared.transactions, { minimum: OUT.toString(), references });
    const fill = randomEvmHash();
    mock.acrossStatus.set("8453:77", { status: "filled", depositTxHash: references.at(-1), fillTx: fill, originChainId: 8453, depositId: "77" });
    mock.rpc.evm.set(fill, {
      hash: fill, from: "0x3333333333333333333333333333333333333333", to: ACROSS_SPOKE_ARBITRUM, input: "0x", value: 0n, chainId: 42161, status: "success",
      blockNumber: 9_300n, timestamp: seconds(PREPARED_AT) + 40, logs: [transferLog(WETH_ARBITRUM, EVM_ADDRESS, OUT)],
    });
    const result = await acrossAdapter.poll?.(step, Date.now());
    assert.equal(code(result), "SETTLEMENT_MISMATCH");
    assert.match(result?.status === "failed" ? result.failure.message : "", /WETH instead of ETH/u);
  });
});
