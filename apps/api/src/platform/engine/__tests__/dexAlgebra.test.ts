/**
 * Camelot V3 on Arbitrum, the `algebra` dialect of concentrated.ts (round 7
 * protocols design 3.1, package P1), against in-process contract state: pin
 * drift (factory, WNativeToken, poolDeployer on router, quoter and factory),
 * the `poolByPair` pool proof, the single dynamic-fee pool and its recorded
 * route, exact Algebra router calldata (deadline in the params, 20-byte
 * paths, refundNativeToken / unwrapWNativeToken), two hops through WETH and
 * the Swap / output proof.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { concatHex, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { dexDeploymentsFor, nativeAssetId, type EvmTransactionRequest, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { ALGEBRA_ROUTER_ABI, decodeRoute, encodePath, POOL_ABI, resetDexCaches } from "../adapters/dex/concentrated.js";
import { camelotAdapter } from "../adapters/dex/camelot.js";
import { ADAPTERS, candidateAdapters, configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { resolveAsset } from "../assets.js";
import { CHAINLINK_FEEDS } from "../policy/feeds.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { decodeStepRef } from "../stepRef.js";
import { MemoryIntentStore } from "../store.js";
import { addPool, mockDex, type DexWorld } from "./dexWorld.js";
import {
  ACCOUNT,
  eventLog,
  installLendingChain,
  landPrepared,
  mockToken,
  setAllowance,
  setBalance,
  tokenAddress,
  transferLog,
  type LendingChain,
  type TokenState,
} from "./lendingChain.js";
import { installSwapOracle, type SwapOracle } from "./rpcMock.js";

const CAMELOT = dexDeploymentsFor("arbitrum", "camelot")[0]!;
const ROUTER = getAddress(CAMELOT.router);
const USDC = getAddress(tokenAddress("arbitrum", "USDC"));
const WETH = getAddress(tokenAddress("arbitrum", "WETH"));
const ARB = getAddress(tokenAddress("arbitrum", "ARB"));
const ACCOUNTS = [`eip155:42161:${ACCOUNT}`];
const OTHER = "0x00000000000000000000000000000000000bad04";
const camelot = camelotAdapter as ProtocolAdapter;

let chain: LendingChain;
let oracle: SwapOracle;
let usdc: TokenState;
let arb: TokenState;

beforeEach(() => {
  chain = installLendingChain();
  resetDexCaches();
  oracle = installSwapOracle([
    [CHAINLINK_FEEDS.ethUsdArbitrum, 2_500],
    [CHAINLINK_FEEDS.usdcUsdArbitrum, 1],
    [CHAINLINK_FEEDS.arbUsdArbitrum, 0.5],
  ]);
  usdc = mockToken(chain, USDC, { symbol: "USDC", decimals: 6 });
  arb = mockToken(chain, ARB, { symbol: "ARB", decimals: 18 });
  mockToken(chain, WETH, { symbol: "WETH", decimals: 18 });
  setBalance(usdc, ACCOUNT, 100_000_000_000n);
  setBalance(arb, ACCOUNT, 10n ** 22n);
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 19n);
  configurePlatform({ store: new MemoryIntentStore(), adapters: [camelot] });
});

afterEach(() => {
  chain.restore();
  oracle.restore();
  configureAdapters(null);
});

/** The USDC/WETH pool: 1000 USDC buys 0.399 WETH, 1 WETH buys 2495 USDC. */
function usdcWeth(world: DexWorld): Address {
  return addPool(chain, world, USDC, WETH, 0, { ab: 399_000_000_000_000_000n, ba: 2_495_000_000n });
}

function swap(from: string, to: string, amount: string) {
  return createIntent({ actions: [{ kind: "swap", network: "arbitrum", from, to, amount }], accounts: ACCOUNTS });
}

async function planError(from: string, to: string, amount: string): Promise<PlatformError> {
  try {
    await swap(from, to, amount);
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail(`swap ${amount} ${from} to ${to} planned but should have been refused`);
}

async function prepared(graph: IntentGraph): Promise<EvmTransactionRequest[]> {
  const { payload } = await prepareStep(graph.id, "s1");
  return payload.transactions as EvmTransactionRequest[];
}

type AlgebraInner = "exactInputSingle" | "exactInput" | "refundNativeToken" | "unwrapWNativeToken";
const inner = (functionName: AlgebraInner, args: readonly unknown[] = []): Hex =>
  encodeFunctionData({ abi: ALGEBRA_ROUTER_ABI, functionName, args } as never) as Hex;
const multicall = (calls: readonly Hex[]): Hex => encodeFunctionData({ abi: ALGEBRA_ROUTER_ABI, functionName: "multicall", args: [calls] });

/** The deadline inside the first inner call (Algebra keeps it in the params). */
function innerCalls(transaction: EvmTransactionRequest | undefined): { calls: readonly Hex[]; deadline: bigint } {
  const decoded = decodeFunctionData({ abi: ALGEBRA_ROUTER_ABI, data: transaction?.data as Hex });
  assert.equal(decoded.functionName, "multicall");
  const [calls] = decoded.args as readonly [readonly Hex[]];
  const first = decodeFunctionData({ abi: ALGEBRA_ROUTER_ABI, data: calls[0] as Hex });
  return { calls, deadline: (first.args[0] as { deadline: bigint }).deadline };
}

describe("Camelot V3 wiring", () => {
  it("is live and auctioned on Arbitrum only", async () => {
    assert.ok(camelotAdapter && ADAPTERS.includes(camelotAdapter));
    configureAdapters(null);
    for (const network of ["arbitrum", "base", "ethereum"] as const) {
      const route = { kind: "swap" as const, network, destinationNetwork: network, input: await resolveAsset(network, "USDC"), output: await resolveAsset(network, "ETH") };
      assert.equal(candidateAdapters(route, undefined).some((adapter) => adapter.id === "camelot"), network === "arbitrum", network);
    }
  });

  it("records the single pool as tier 0 and never decodes another tier or a Slipstream-style slug", () => {
    assert.equal(decodeRoute("camelot", "arbitrum", "v3:0")?.deployment.id, "arbitrum:camelot:v3");
    assert.deepEqual(decodeRoute("camelot", "arbitrum", "v3:0:W:0")?.tiers, [0, 0]);
    assert.equal(decodeRoute("camelot", "arbitrum", "v3:100"), null);
    assert.equal(decodeRoute("camelot", "base", "v3:0"), null);
  });
});

describe("Camelot V3 pins and pool proof", () => {
  it("refuses router / quoter / factory drift: factory, WNativeToken and poolDeployer", async () => {
    for (const field of ["routerFactory", "routerWrapped", "routerDeployer", "quoterFactory", "quoterWrapped", "quoterDeployer", "factoryDeployer"] as const) {
      resetDexCaches();
      const world = mockDex(chain, CAMELOT);
      usdcWeth(world);
      world.reported[field] = OTHER;
      const error = await planError("USDC", "WETH", "1000");
      assert.equal(error.code, "VENUE_UNVERIFIED", field);
    }
  });

  it("refuses a pool from poolByPair whose factory() is not the pin", async () => {
    const world = mockDex(chain, CAMELOT);
    const pool = usdcWeth(world);
    world.poolFactory.set(pool.toLowerCase(), OTHER);
    const error = await planError("USDC", "WETH", "1000");
    assert.equal(error.code, "VENUE_UNVERIFIED");
    assert.match(error.message, /factory\(\)/u);
  });

  it("answers ROUTE_UNAVAILABLE when poolByPair has no pool", async () => {
    mockDex(chain, CAMELOT);
    assert.equal((await planError("USDC", "WETH", "1000")).code, "ROUTE_UNAVAILABLE");
  });
});

describe("Camelot V3 planning and calldata", () => {
  it("quotes the dynamic-fee pool and records it", async () => {
    const world = mockDex(chain, CAMELOT);
    const pool = usdcWeth(world);
    const graph = await swap("USDC", "WETH", "1000");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "camelot");
    assert.equal(step.expectedOutput?.amount, "399000000000000000");
    assert.equal(decodeStepRef(step.quoteRef)?.provider, "v3:0");
    assert.match((step.warnings ?? []).join(" "), new RegExp(`Route: Camelot V3 \\(arbitrum:camelot:v3\\), dynamic-fee pool, ${pool}`, "u"));
  });

  it("ERC-20 in: exact approval of the router, exactInputSingle with the deadline and the floor, multicall(bytes[])", async () => {
    const world = mockDex(chain, CAMELOT);
    usdcWeth(world);
    const transactions = await prepared(await swap("USDC", "WETH", "1000"));
    assert.equal(transactions.length, 2);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args, [ROUTER, 1_000_000_000n]);
    assert.equal(transactions[1]?.to, ROUTER);
    const { deadline } = innerCalls(transactions[1]);
    const minimum = (399_000_000_000_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[1]?.data, multicall([
      inner("exactInputSingle", [{ tokenIn: USDC, tokenOut: WETH, recipient: ACCOUNT, deadline, amountIn: 1_000_000_000n, amountOutMinimum: minimum, limitSqrtPrice: 0n }]),
    ]));
    const now = Math.floor(Date.now() / 1000);
    assert.ok(deadline >= BigInt(now + 90 + 300 - 5) && deadline <= BigInt(now + 90 + 300 + 5), "deadline = payload expiry + 300 s");
  });

  it("native in: value is the amount, WETH in, refundNativeToken()", async () => {
    const world = mockDex(chain, CAMELOT);
    usdcWeth(world);
    const transactions = await prepared(await swap("ETH", "USDC", "1"));
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]?.value, (10n ** 18n).toString());
    const { deadline } = innerCalls(transactions[0]);
    const minimum = (2_495_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[0]?.data, multicall([
      inner("exactInputSingle", [{ tokenIn: WETH, tokenOut: USDC, recipient: ACCOUNT, deadline, amountIn: 10n ** 18n, amountOutMinimum: minimum, limitSqrtPrice: 0n }]),
      inner("refundNativeToken"),
    ]));
  });

  it("native out: the router receives the WETH and unwrapWNativeToken pays the account the floor", async () => {
    const world = mockDex(chain, CAMELOT);
    usdcWeth(world);
    setAllowance(usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const graph = await swap("USDC", "ETH", "1000");
    assert.equal(graph.steps[0]?.minimumOutput?.asset, nativeAssetId("arbitrum"));
    const transactions = await prepared(graph);
    const { deadline } = innerCalls(transactions[0]);
    const minimum = (399_000_000_000_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[0]?.data, multicall([
      inner("exactInputSingle", [{ tokenIn: USDC, tokenOut: WETH, recipient: ROUTER, deadline, amountIn: 1_000_000_000n, amountOutMinimum: minimum, limitSqrtPrice: 0n }]),
      inner("unwrapWNativeToken", [minimum, ACCOUNT]),
    ]));
  });

  it("two hops through WETH when no direct pool quotes: a 20-byte-only path to exactInput", async () => {
    const world = mockDex(chain, CAMELOT);
    usdcWeth(world);
    addPool(chain, world, ARB, WETH, 0, { ab: 199_000_000_000_000_000n });
    const path = encodePath([{ tokenIn: ARB, tokenOut: WETH, tier: 0 }, { tokenIn: WETH, tokenOut: USDC, tier: 0 }], "algebra");
    assert.equal(path, concatHex([ARB.toLowerCase() as Hex, WETH.toLowerCase() as Hex, USDC.toLowerCase() as Hex]));
    world.paths.set(path.toLowerCase(), 497_000_000n);
    const graph = await swap("ARB", "USDC", "1000");
    const step = graph.steps[0]!;
    assert.equal(step.expectedOutput?.amount, "497000000");
    assert.equal(decodeStepRef(step.quoteRef)?.provider, "v3:0:W:0");
    const transactions = await prepared(graph);
    const { deadline } = innerCalls(transactions[1]);
    const minimum = (497_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[1]?.data, multicall([
      inner("exactInput", [{ path, recipient: ACCOUNT, deadline, amountIn: 10n ** 21n, amountOutMinimum: minimum }]),
    ]));
  });
});

describe("Camelot V3 verification", () => {
  const swapLog = (pool: string, recipient: string) => eventLog(pool, POOL_ABI as unknown as Abi, "Swap", {
    sender: ROUTER, recipient, amount0: 1_000_000_000n, amount1: -399_000_000_000_000_000n, sqrtPriceX96: 1n, liquidity: 1n, tick: 0,
  });

  async function landed(output: "WETH" | "ETH", logs: (pool: Address) => ReturnType<typeof eventLog>[]) {
    const world = mockDex(chain, CAMELOT);
    const pool = usdcWeth(world);
    setAllowance(usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const graph = await swap("USDC", output, "1000");
    const transactions = await prepared(graph);
    return submitStep(graph.id, "s1", landPrepared(chain, transactions, [logs(pool)]));
  }

  it("settles on the pool's Swap and a Transfer to the account at or above the floor", async () => {
    const done = await landed("WETH", (pool) => [transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n), swapLog(pool, ACCOUNT)]);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.match(done.steps[0]?.evidence.map((entry) => entry.detail).join(" ") ?? "", /Camelot V3 Swap through/u);
  });

  it("settles native output through the router's WETH burn (aeWETH) and refuses a foreign Swap", async () => {
    const done = await landed("ETH", (pool) => [
      transferLog(WETH, pool, ROUTER, 398_500_000_000_000_000n),
      swapLog(pool, ROUTER),
      transferLog(WETH, ROUTER, zeroAddress, 398_500_000_000_000_000n),
    ]);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "398500000000000000");
    const refused = await landed("WETH", (pool) => [transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n), swapLog(pool, ACCOUNT), swapLog(OTHER, ACCOUNT)]);
    assert.equal(refused.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
  });

  it("refuses a router call that is not the prepared Algebra multicall", async () => {
    const world = mockDex(chain, CAMELOT);
    const pool = usdcWeth(world);
    setAllowance(usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const graph = await swap("USDC", "WETH", "1000");
    const transactions = await prepared(graph);
    // A SwapRouter02-style multicall(deadline, bytes[]) to the Camelot router is not what Kletia prepared: refused before any proof.
    const forged = { ...transactions[0]!, data: `0x5ae401dc${"00".repeat(64)}` as Hex };
    await assert.rejects(
      submitStep(graph.id, "s1", landPrepared(chain, [forged], [[transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n), swapLog(pool, ACCOUNT)]])),
      /do not match a payload prepared for this step/u,
    );
  });
});
