/**
 * Aggregator and forwarder calldata verification (aggregator calldata with
 * another recipient or router): the optional KyberSwap venue is off by default, and when on it
 * hands a wallet only a router call Kletia decoded and held to the step
 * (pinned router, recipient = the step account, tokens, exact amount, an
 * on-chain minimum inside the slippage, no fee receivers, no permit).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, type Hex } from "viem";
import { applySlippage } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { checkKyberSwap, decodeKyberSwap, KYBER_NATIVE, KYBER_ROUTER_ABI } from "../adapters/aggregator/kyberCalldata.js";
import { aggregatorEnabled, kyberRouter, kyberswapAdapter } from "../adapters/aggregator/kyberswap.js";
import { ADAPTERS } from "../adapters/registry.js";
import type { AdapterAction } from "../adapters/types.js";
import { CHAINLINK_FEEDS } from "../policy/feeds.js";
import { account, asset, installCrossChainMock, type CrossChainMock } from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS } from "./helpers.js";
import { installSwapOracle, type SwapOracle } from "./rpcMock.js";

const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const EXECUTOR = "0x8F10B468b06c6FD214B65F87778827F7D113f996";
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AMOUNT = 5_000_000_000n; // 5,000 USDC
const OUT = 1_998_000_000_000_000_000n; // 1.998 ETH at 2,500 USD

interface SwapFields {
  readonly srcToken?: string;
  readonly dstToken?: string;
  readonly amount?: bigint;
  readonly dstReceiver?: string;
  readonly minReturnAmount?: bigint;
  readonly feeReceivers?: readonly string[];
  readonly permit?: Hex;
  readonly srcAmounts?: readonly bigint[];
}

function swapCall(fields: SwapFields = {}): Hex {
  const amount = fields.amount ?? AMOUNT;
  return encodeFunctionData({
    abi: KYBER_ROUTER_ABI,
    functionName: "swap",
    args: [{
      callTarget: EXECUTOR,
      approveTarget: "0x0000000000000000000000000000000000000000",
      targetData: "0xabcdef",
      desc: {
        srcToken: (fields.srcToken ?? USDC_ETHEREUM) as Hex,
        dstToken: (fields.dstToken ?? KYBER_NATIVE) as Hex,
        srcReceivers: [EXECUTOR],
        srcAmounts: [...(fields.srcAmounts ?? [amount])],
        feeReceivers: (fields.feeReceivers ?? []) as Hex[],
        feeAmounts: (fields.feeReceivers ?? []).map(() => 1n),
        dstReceiver: (fields.dstReceiver ?? EVM_ADDRESS) as Hex,
        amount,
        minReturnAmount: fields.minReturnAmount ?? BigInt(applySlippage(OUT.toString(), 50)),
        flags: 0n,
        permit: fields.permit ?? "0x",
      },
      clientData: "0x",
    }],
  });
}

const EXPECT = {
  srcToken: USDC_ETHEREUM,
  dstToken: null,
  amount: AMOUNT,
  recipient: EVM_ADDRESS,
  minReturn: BigInt(applySlippage(OUT.toString(), 50)),
};

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return `${error.code}: ${error.message}`;
  }
  return "OK";
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

describe("KyberSwap router calldata", () => {
  it("accepts exactly the step's swap and reports its on-chain minimum", () => {
    const decoded = checkKyberSwap(swapCall(), EXPECT);
    assert.equal(decoded.dstReceiver.toLowerCase(), EVM_ADDRESS.toLowerCase());
    assert.equal(decoded.minReturnAmount, EXPECT.minReturn);
    assert.equal(decodeKyberSwap("0x12345678"), null);
  });

  it("rejects another recipient, token, amount, a loose minimum, fee receivers, a permit or a partial source split", () => {
    const cases: [SwapFields, RegExp][] = [
      [{ dstReceiver: OTHER_EVM_ADDRESS }, /pays another receiver/u],
      [{ srcToken: OTHER_EVM_ADDRESS }, /sells another token/u],
      [{ dstToken: USDC_ETHEREUM }, /buys another token/u],
      [{ amount: AMOUNT - 1n }, /sells another amount/u],
      [{ minReturnAmount: EXPECT.minReturn - 1n }, /below the step's floor/u],
      [{ minReturnAmount: 0n }, /no on-chain minimum/u],
      [{ feeReceivers: [OTHER_EVM_ADDRESS] }, /fees to other receivers/u],
      [{ permit: "0x1234" }, /carries a permit/u],
      [{ srcAmounts: [AMOUNT - 5n] }, /source split differs/u],
    ];
    for (const [fields, reason] of cases) {
      const error = refusal(() => checkKyberSwap(swapCall(fields), EXPECT));
      assert.match(error, /^PROVIDER_TRANSACTION_INVALID/u, reason.source);
      assert.match(error, reason);
    }
    assert.match(refusal(() => checkKyberSwap("0xdeadbeef", EXPECT)), /cannot be decoded/u);
  });
});

describe("KyberSwap venue: off by default, verified when on", () => {
  let mock: CrossChainMock;
  let oracle: SwapOracle;
  let flag: string | undefined;
  let routerReply: string;
  let buildData: Hex;
  let buildOut: string;
  let builds: Record<string, unknown>[];
  let inner: typeof fetch;

  beforeEach(() => {
    mock = installCrossChainMock();
    oracle = installSwapOracle([
      [CHAINLINK_FEEDS.ethUsdEthereum, 2_500],
      [CHAINLINK_FEEDS.usdcUsdEthereum, 1],
    ]);
    flag = process.env.KLETIA_EVM_AGGREGATOR;
    process.env.KLETIA_EVM_AGGREGATOR = "kyberswap";
    routerReply = ROUTER;
    buildData = swapCall();
    buildOut = OUT.toString();
    builds = [];
    inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== "aggregator-api.kyberswap.com") return inner(input, init);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/ethereum/api/v1/routes") {
        return json({ code: 0, data: { routerAddress: routerReply, routeSummary: { tokenIn: url.searchParams.get("tokenIn"), tokenOut: url.searchParams.get("tokenOut"), amountIn: url.searchParams.get("amountIn"), amountOut: buildOut, route: [] } } });
      }
      if (url.pathname === "/ethereum/api/v1/route/build") {
        builds.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return json({ code: 0, data: { amountIn: AMOUNT.toString(), amountOut: buildOut, gas: "250000", routerAddress: routerReply, data: buildData } });
      }
      return json({ code: 4000, message: "unmocked" });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = inner;
    mock.restore();
    oracle.restore();
    if (flag === undefined) delete process.env.KLETIA_EVM_AGGREGATOR;
    else process.env.KLETIA_EVM_AGGREGATOR = flag;
  });

  const action = (): AdapterAction => ({
    kind: "swap",
    network: "ethereum",
    destinationNetwork: "ethereum",
    input: asset("ethereum", "USDC"),
    output: asset("ethereum", "ETH"),
    amount: AMOUNT.toString(),
    account: account("ethereum"),
    recipient: account("ethereum"),
    slippageBps: 50,
  });

  it("is off unless the server enables it, and is not in the default adapter list", () => {
    assert.equal(aggregatorEnabled({}), false);
    assert.equal(aggregatorEnabled({ KLETIA_EVM_AGGREGATOR: "kyberswap" }), true);
    assert.equal(ADAPTERS.some((adapter) => adapter.id === "kyberswap"), flag?.trim().toLowerCase() === "kyberswap", "listed only when enabled at start");
    delete process.env.KLETIA_EVM_AGGREGATOR;
    assert.equal(kyberswapAdapter.supports(action()), false);
    process.env.KLETIA_EVM_AGGREGATOR = "kyberswap";
    assert.equal(kyberswapAdapter.supports(action()), true);
    assert.equal(kyberswapAdapter.supports({ ...action(), output: asset("ethereum", "WETH"), input: asset("ethereum", "ETH") }), false, "wrap stays with the wrap venue");
    assert.equal(kyberRouter("solana"), null);
  });

  it("plans the verified router call: pinned router, exact approval, on-chain floor, recipient = the account", async () => {
    const planned = await kyberswapAdapter.plan(action());
    assert.equal(planned.protocol, "kyberswap");
    assert.equal(planned.floor, "onchain");
    assert.equal(planned.expectedOutput.amount, OUT.toString());
    assert.equal(planned.minimumOutput.amount, EXPECT.minReturn.toString());
    assert.equal(planned.transactionCount, 2, "exact approval, then the swap");
    const [approve, swap] = planned.preview?.transactions ?? [];
    assert.ok(approve?.vm === "evm" && swap?.vm === "evm");
    assert.equal(approve.to, USDC_ETHEREUM);
    assert.equal(swap.to, ROUTER);
    assert.equal(swap.value, "0");
    assert.equal(builds[0]?.recipient, EVM_ADDRESS);
    assert.equal(builds[0]?.slippageTolerance, 50);
  });

  it("refuses a router other than the pin, a build that pays someone else, and a quote far below the oracle", async () => {
    routerReply = OTHER_EVM_ADDRESS;
    assert.match(await errorOf(() => kyberswapAdapter.plan(action())), /^PROVIDER_TRANSACTION_INVALID.*is not the pinned/u);
    routerReply = ROUTER;
    buildData = swapCall({ dstReceiver: OTHER_EVM_ADDRESS });
    assert.match(await errorOf(() => kyberswapAdapter.plan(action())), /^PROVIDER_TRANSACTION_INVALID.*pays another receiver/u);
    buildOut = (OUT / 2n).toString();
    buildData = swapCall({ minReturnAmount: BigInt(applySlippage((OUT / 2n).toString(), 50)) });
    assert.match(await errorOf(() => kyberswapAdapter.plan(action())), /^PRICE_IMPACT_TOO_HIGH/u);
  });
});
