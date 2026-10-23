/**
 * Aerodrome (Base) and Velodrome (OP Mainnet) Slipstream swaps against
 * in-process contract state: the best pool across the three pinned Aerodrome
 * factories and every tick spacing, the deployment recorded and the same
 * router called and approved at prepare, exact Slipstream calldata (native
 * in with refundETH, native out unwrapped to the account), pin checks, no
 * classic pools, and the outcome proof.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { dexDeploymentsFor, nativeAssetId, type DexDeployment, type EvmTransactionRequest, type IntentGraph, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { decodeRoute, encodePath, PINS_ABI, POOL_ABI, resetDexCaches, SLIPSTREAM_FACTORY_ABI, SLIPSTREAM_QUOTER_ABI, SLIPSTREAM_ROUTER_ABI } from "../adapters/dex/concentrated.js";
import { aerodromeAdapter, velodromeAdapter } from "../adapters/dex/aerodrome.js";
import { WETH_ABI } from "../adapters/lending/common.js";
import { configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { resolveAsset } from "../assets.js";
import { CHAINLINK_FEEDS } from "../policy/feeds.js";
import { configurePlatform, createIntent, getIntent, prepareStep, submitStep } from "../service.js";
import { decodeStepRef } from "../stepRef.js";
import { MemoryIntentStore } from "../store.js";
import {
  ACCOUNT,
  eventLog,
  installLendingChain,
  landPrepared,
  mockToken,
  Revert,
  setAllowance,
  setBalance,
  tokenAddress,
  transferLog,
  type LendingChain,
  type TokenState,
} from "./lendingChain.js";
import { installSwapOracle, type SwapOracle } from "./rpcMock.js";

const AERODROME = dexDeploymentsFor("base", "aerodrome");
const VELODROME = dexDeploymentsFor("optimism", "velodrome");
/** Aerodrome's classic (solidly) PoolFactory and Router: never called. */
const CLASSIC = ["0x420DD381b31aEf6683db6B902084cB0FFECe40Da", "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"].map((address) => address.toLowerCase());
const OTHER = "0x00000000000000000000000000000000000bad02";

let chain: LendingChain;
let oracle: SwapOracle;

interface Deployed {
  readonly deployment: DexDeployment;
  /** Pool by unordered pair and tick spacing. */
  readonly pools: Map<string, Address>;
  /** amountOut by `${tokenIn}:${tokenOut}:${tickSpacing}`. */
  readonly quotes: Map<string, bigint>;
  /** amountOut by encoded two-pool path (lower case). */
  readonly paths: Map<string, bigint>;
  routerFactory: string;
}

const pairKey = (a: string, b: string, ts: number) => [a.toLowerCase(), b.toLowerCase()].sort().join(":") + `:${ts}`;
const quoteKey = (a: string, b: string, ts: number) => `${a.toLowerCase()}:${b.toLowerCase()}:${ts}`;
let poolCounter = 0;

function deploy(deployment: DexDeployment): Deployed {
  const world: Deployed = { deployment, pools: new Map(), quotes: new Map(), paths: new Map(), routerFactory: deployment.factory };
  chain.contract(deployment.factory, SLIPSTREAM_FACTORY_ABI as unknown as Abi, {
    getPool: ([a, b, ts]) => world.pools.get(pairKey(String(a), String(b), Number(ts))) ?? zeroAddress,
  });
  chain.contract(deployment.quoter as string, [...PINS_ABI, ...SLIPSTREAM_QUOTER_ABI] as unknown as Abi, {
    factory: () => deployment.factory,
    WETH9: () => deployment.wrappedNative,
    quoteExactInputSingle: ([params]) => {
      const { tokenIn, tokenOut, tickSpacing } = params as { tokenIn: string; tokenOut: string; tickSpacing: number };
      const out = world.quotes.get(quoteKey(tokenIn, tokenOut, tickSpacing));
      if (out === undefined) throw new Revert();
      return [out, 0n, 1, 100_000n];
    },
    quoteExactInput: ([path]) => {
      const out = world.paths.get(String(path).toLowerCase());
      if (out === undefined) throw new Revert();
      return [out, [], [], 180_000n];
    },
  });
  chain.contract(deployment.router, [...PINS_ABI, ...SLIPSTREAM_ROUTER_ABI] as unknown as Abi, {
    factory: () => world.routerFactory,
    WETH9: () => deployment.wrappedNative,
    multicall: () => [],
  });
  return world;
}

function pool(world: Deployed, a: string, b: string, ts: number, quotes: { readonly ab?: bigint; readonly ba?: bigint }, factory = world.deployment.factory): Address {
  poolCounter += 1;
  const address = getAddress(`0x${(0xc1000000 + poolCounter).toString(16).padStart(40, "0")}`);
  world.pools.set(pairKey(a, b, ts), address);
  chain.contract(address, POOL_ABI as unknown as Abi, { factory: () => factory });
  if (quotes.ab !== undefined) world.quotes.set(quoteKey(a, b, ts), quotes.ab);
  if (quotes.ba !== undefined) world.quotes.set(quoteKey(b, a, ts), quotes.ba);
  return address;
}

function tokens(network: NetworkKey): { usdc: TokenState; weth: TokenState; USDC: Address; WETH: Address } {
  const USDC = getAddress(tokenAddress(network, "USDC"));
  const WETH = getAddress(tokenAddress(network, "WETH"));
  const usdc = mockToken(chain, USDC, { symbol: "USDC", decimals: 6 });
  const weth = mockToken(chain, WETH, { symbol: "WETH", decimals: 18 });
  setBalance(usdc, ACCOUNT, 100_000_000_000n);
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 19n);
  return { usdc, weth, USDC, WETH };
}

beforeEach(() => {
  chain = installLendingChain();
  resetDexCaches();
  oracle = installSwapOracle([
    [CHAINLINK_FEEDS.ethUsdBase, 2_500],
    [CHAINLINK_FEEDS.usdcUsdBase, 1],
    [CHAINLINK_FEEDS.ethUsdOptimism, 2_500],
    [CHAINLINK_FEEDS.usdcUsdEthereum, 1],
  ]);
  configurePlatform({ store: new MemoryIntentStore(), adapters: [aerodromeAdapter as ProtocolAdapter, velodromeAdapter as ProtocolAdapter] });
});

afterEach(() => {
  chain.restore();
  oracle.restore();
  configureAdapters(null);
});

function swap(network: "base" | "optimism", from: string, to: string, amount: string, protocol?: string) {
  return createIntent({
    actions: [{ kind: "swap", network, from, to, amount, ...(protocol ? { protocol } : {}) }],
    accounts: [`eip155:${network === "base" ? 8453 : 10}:${ACCOUNT}`],
  });
}

async function prepared(graph: IntentGraph): Promise<EvmTransactionRequest[]> {
  const { payload } = await prepareStep(graph.id, "s1");
  return payload.transactions as EvmTransactionRequest[];
}

const inner = (functionName: "exactInputSingle" | "refundETH" | "unwrapWETH9", args: readonly unknown[] = []): Hex =>
  encodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, functionName, args } as never) as Hex;
const multicallData = (calls: readonly Hex[]): Hex => encodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, functionName: "multicall", args: [calls] });

/** Deadline inside the first exactInputSingle of a Slipstream multicall. */
function deadlineOf(transaction: EvmTransactionRequest | undefined): bigint {
  const outer = decodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, data: transaction?.data as Hex });
  assert.equal(outer.functionName, "multicall");
  const first = decodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, data: (outer.args[0] as readonly Hex[])[0] as Hex });
  return (first.args[0] as { deadline: bigint }).deadline;
}

/** Three Aerodrome factories: the gauges-v3 tick-spacing-50 pool quotes best (1000 USDC -> 0.3995 WETH). */
function aerodromeMarket() {
  const t = tokens("base");
  const [initial, caps, v3] = AERODROME.map(deploy) as [Deployed, Deployed, Deployed];
  const pools = {
    initial100: pool(initial, t.USDC, t.WETH, 100, { ab: 399_000_000_000_000_000n, ba: 2_494_000_000n }),
    initial1: pool(initial, t.USDC, t.WETH, 1, { ab: 398_000_000_000_000_000n }),
    caps50: pool(caps, t.USDC, t.WETH, 50, { ab: 388_000_000_000_000_000n }),
    v3_50: pool(v3, t.USDC, t.WETH, 50, { ab: 399_500_000_000_000_000n, ba: 2_496_000_000n }),
    v3_2000: pool(v3, t.USDC, t.WETH, 2000, {}),
  };
  return { ...t, initial, caps, v3, pools };
}

describe("Slipstream pool selection", () => {
  it("picks the best of the three Aerodrome factories and records the deployment", async () => {
    const market = aerodromeMarket();
    const graph = await swap("base", "USDC", "WETH", "1000");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "aerodrome");
    assert.equal(step.expectedOutput?.amount, "399500000000000000");
    const recorded = decodeRoute("aerodrome", "base", decodeStepRef(step.quoteRef)?.provider);
    assert.equal(recorded?.deployment.id, "base:aerodrome:cl-gauges-v3");
    assert.deepEqual(recorded?.tiers, [50]);
    assert.match(step.warnings?.join(" ") ?? "", new RegExp(`Aerodrome \\(base:aerodrome:cl-gauges-v3\\), tick spacing 50 pool, ${market.pools.v3_50}`, "u"));
    // Every factory and tick spacing was asked; classic pools were never touched.
    for (const deployment of AERODROME) {
      const asked = chain.calls.filter((entry) => entry.to === deployment.factory.toLowerCase() && entry.functionName === "getPool").map((entry) => Number(entry.args[2]));
      assert.deepEqual(asked.sort((a, b) => a - b), [1, 50, 100, 200, 2000], deployment.id);
    }
    assert.ok(chain.calls.every((entry) => !CLASSIC.includes(entry.to)), "no classic pools");
  });

  it("calls and approves only the recorded deployment's router, with exact Slipstream calldata", async () => {
    const market = aerodromeMarket();
    const graph = await swap("base", "USDC", "WETH", "1000");
    const transactions = await prepared(graph);
    const router = getAddress(market.v3.deployment.router);
    assert.equal(transactions.length, 2);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args, [router, 1_000_000_000n]);
    assert.equal(transactions[1]?.to, router);
    const minimum = (399_500_000_000_000_000n * 9_950n) / 10_000n;
    const deadline = deadlineOf(transactions[1]);
    assert.equal(transactions[1]?.data, multicallData([inner("exactInputSingle", [{
      tokenIn: market.USDC, tokenOut: market.WETH, tickSpacing: 50, recipient: ACCOUNT, deadline, amountIn: 1_000_000_000n, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n,
    }])]));
    const spenders = transactions.flatMap((transaction) => {
      try {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.data as Hex });
        return decoded.functionName === "approve" ? [String(decoded.args[0])] : [];
      } catch {
        return [];
      }
    });
    assert.deepEqual(spenders, [router], "no other router is approved");
  });

  it("native in sends value and refunds; native out swaps to the router and unwraps to the account", async () => {
    const market = aerodromeMarket();
    const ethIn = await swap("base", "ETH", "USDC", "1");
    const buy = await prepared(ethIn);
    assert.equal(buy.length, 1);
    assert.equal(buy[0]?.value, (10n ** 18n).toString());
    const buyMinimum = (2_496_000_000n * 9_950n) / 10_000n;
    assert.equal(buy[0]?.data, multicallData([
      inner("exactInputSingle", [{ tokenIn: market.WETH, tokenOut: market.USDC, tickSpacing: 50, recipient: ACCOUNT, deadline: deadlineOf(buy[0]), amountIn: 10n ** 18n, amountOutMinimum: buyMinimum, sqrtPriceLimitX96: 0n }]),
      inner("refundETH"),
    ]));
    setAllowance(market.usdc, ACCOUNT, market.v3.deployment.router, 1_000_000_000n);
    const ethOut = await swap("base", "USDC", "ETH", "1000");
    const sell = await prepared(ethOut);
    const router = getAddress(market.v3.deployment.router);
    const sellMinimum = (399_500_000_000_000_000n * 9_950n) / 10_000n;
    assert.equal(sell[0]?.data, multicallData([
      inner("exactInputSingle", [{ tokenIn: market.USDC, tokenOut: market.WETH, tickSpacing: 50, recipient: router, deadline: deadlineOf(sell[0]), amountIn: 1_000_000_000n, amountOutMinimum: sellMinimum, sqrtPriceLimitX96: 0n }]),
      inner("unwrapWETH9", [sellMinimum, ACCOUNT]),
    ]));
  });

  it("refuses a pool that does not name its factory, and a router that reports another factory", async () => {
    const market = aerodromeMarket();
    pool(market.caps, market.USDC, market.WETH, 100, { ab: 1n }, OTHER);
    await assert.rejects(swap("base", "USDC", "WETH", "1000"), (error: PlatformError) => error.code === "VENUE_UNVERIFIED");
    resetDexCaches();
    const fresh = aerodromeMarket();
    fresh.initial.routerFactory = OTHER;
    await assert.rejects(swap("base", "USDC", "WETH", "1000"), (error: PlatformError) => error.code === "VENUE_UNVERIFIED" && /router's factory/u.test(error.message));
  });

  it("serves Aerodrome on Base and Velodrome on OP Mainnet only", async () => {
    const route = async (network: "base" | "optimism") => ({ kind: "swap" as const, network, destinationNetwork: network, input: await resolveAsset(network, "USDC"), output: await resolveAsset(network, "ETH") });
    assert.equal((aerodromeAdapter as ProtocolAdapter).supports(await route("base")), true);
    assert.equal((aerodromeAdapter as ProtocolAdapter).supports(await route("optimism")), false);
    assert.equal((velodromeAdapter as ProtocolAdapter).supports(await route("optimism")), true);
    assert.equal((velodromeAdapter as ProtocolAdapter).supports(await route("base")), false);
  });

  it("plans Velodrome across its two factories, skipping tick spacings whose quote reverts", async () => {
    const t = tokens("optimism");
    const [initial, gauges] = VELODROME.map(deploy) as [Deployed, Deployed];
    pool(initial, t.USDC, t.WETH, 1, {});
    pool(initial, t.USDC, t.WETH, 100, { ab: 399_200_000_000_000_000n });
    const best = pool(gauges, t.USDC, t.WETH, 50, { ab: 399_300_000_000_000_000n });
    const graph = await swap("optimism", "USDC", "WETH", "1000", "velodrome");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "velodrome");
    assert.equal(decodeRoute("velodrome", "optimism", decodeStepRef(step.quoteRef)?.provider)?.deployment.id, "optimism:velodrome:cl-gauges-v2");
    assert.match(step.warnings?.join(" ") ?? "", new RegExp(best, "u"));
  });
});

describe("Slipstream two-pool paths", () => {
  it("routes through WETH when no direct pool exists, with an exactInput path of tick spacings", async () => {
    const t = tokens("base");
    const AERO = getAddress(tokenAddress("base", "AERO"));
    const aero = mockToken(chain, AERO, { symbol: "AERO", decimals: 18 });
    setBalance(aero, ACCOUNT, 10n ** 21n);
    const [initial] = AERODROME.map(deploy) as [Deployed, Deployed, Deployed];
    pool(initial, AERO, t.WETH, 200, { ab: 40_000_000_000_000_000n });
    pool(initial, t.WETH, t.USDC, 100, { ab: 99_600_000n });
    const path = encodePath([{ tokenIn: AERO, tokenOut: t.WETH, tier: 200 }, { tokenIn: t.WETH, tokenOut: t.USDC, tier: 100 }]);
    initial.paths.set(path.toLowerCase(), 99_500_000n);
    oracle.restore();
    oracle = installSwapOracle([
      [CHAINLINK_FEEDS.ethUsdBase, 2_500],
      [CHAINLINK_FEEDS.usdcUsdBase, 1],
      [CHAINLINK_FEEDS.aeroUsdBase, 1],
    ]);
    const graph = await swap("base", "AERO", "USDC", "100");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "aerodrome");
    assert.equal(step.expectedOutput?.amount, "99500000");
    const recorded = decodeRoute("aerodrome", "base", decodeStepRef(step.quoteRef)?.provider);
    assert.deepEqual(recorded?.tiers, [200, 100]);
    assert.equal(recorded?.intermediate, "W");
    const transactions = await prepared(graph);
    const router = getAddress(initial.deployment.router);
    assert.equal(transactions.at(-1)?.to, router);
    const outer = decodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, data: transactions.at(-1)?.data as Hex });
    assert.equal(outer.functionName, "multicall");
    const swapCall = decodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, data: (outer.args[0] as readonly Hex[])[0] as Hex });
    assert.equal(swapCall.functionName, "exactInput");
    const params = swapCall.args[0] as { path: Hex; recipient: string; amountIn: bigint; amountOutMinimum: bigint };
    assert.equal(params.path.toLowerCase(), path.toLowerCase());
    assert.equal(getAddress(params.recipient), getAddress(ACCOUNT));
    assert.equal(params.amountIn, 10n ** 20n);
    assert.equal(params.amountOutMinimum, (99_500_000n * 9_950n) / 10_000n);
  });
});

describe("Slipstream verification", () => {
  it("proves the swap from the recorded pool and the native output unwrapped by the recorded router", async () => {
    const market = aerodromeMarket();
    setAllowance(market.usdc, ACCOUNT, market.v3.deployment.router, 1_000_000_000n);
    const graph = await swap("base", "USDC", "ETH", "1000");
    const transactions = await prepared(graph);
    const router = getAddress(market.v3.deployment.router);
    const swapLog = (address: string) => eventLog(address, POOL_ABI as unknown as Abi, "Swap", {
      sender: router, recipient: router, amount0: 1_000_000_000n, amount1: -399_000_000_000_000_000n, sqrtPriceX96: 1n, liquidity: 1n, tick: 0,
    });
    const withdrawal = eventLog(market.WETH, WETH_ABI as unknown as Abi, "Withdrawal", { src: router, wad: 399_000_000_000_000_000n });
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[transferLog(market.USDC, ACCOUNT, market.pools.v3_50, 1_000_000_000n), swapLog(market.pools.v3_50), withdrawal]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.asset, nativeAssetId("base"));
    assert.equal(done.steps[0]?.actualOutput?.amount, "399000000000000000");

    const again = await swap("base", "USDC", "ETH", "1000");
    const second = await prepared(again);
    // A Swap from another deployment's pool (same pair) is not the recorded route.
    const failed = await submitStep(again.id, "s1", landPrepared(chain, second, [[swapLog(market.pools.initial100), withdrawal]]));
    assert.equal(failed.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    const floor = BigInt((await getIntent(again.id)).steps[0]?.minimumOutput?.amount ?? "0");
    assert.ok(floor > 0n);
  });
});
