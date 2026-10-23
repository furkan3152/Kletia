/**
 * PancakeSwap V3 against in-process contract state: the Uniswap V3 dialect
 * with PancakeSwap's fee tiers (0.25 % instead of 0.3 %), pin drift of the
 * SmartRouter, QuoterV2 and factory (factory, WETH9, deployer /
 * poolDeployer), the factory pool proof, exact SmartRouter calldata,
 * PancakeSwap's own Swap event in the outcome proof, and the same-network
 * auction against Uniswap V3.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Abi, type Address, type Hex } from "viem";
import { dexDeploymentsFor, type EvmTransactionRequest, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { ADDRESS_THIS, PANCAKE_POOL_ABI, POOL_ABI, resetDexCaches, SWAP_ROUTER02_ABI } from "../adapters/dex/concentrated.js";
import { pancakeswapV3Adapter } from "../adapters/dex/pancakeswap.js";
import { uniswapV3Adapter } from "../adapters/dex/uniswapV3.js";
import { ADAPTERS, candidateAdapters, configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { resolveAsset } from "../assets.js";
import { CHAINLINK_FEEDS } from "../policy/feeds.js";
import { configurePlatform, createIntent, getIntent, prepareStep, submitStep } from "../service.js";
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

const PANCAKE = dexDeploymentsFor("ethereum", "pancakeswap-v3")[0]!;
const UNISWAP = dexDeploymentsFor("ethereum", "uniswap-v3")[0]!;
const ROUTER = getAddress(PANCAKE.router);
const USDC = getAddress(tokenAddress("ethereum", "USDC"));
const WETH = getAddress(tokenAddress("ethereum", "WETH"));
const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const OTHER = "0x00000000000000000000000000000000000bad03";
const pancake = pancakeswapV3Adapter as ProtocolAdapter;
const uniswap = uniswapV3Adapter as ProtocolAdapter;

let chain: LendingChain;
let oracle: SwapOracle;
let usdc: TokenState;

beforeEach(() => {
  chain = installLendingChain();
  resetDexCaches();
  oracle = installSwapOracle([
    [CHAINLINK_FEEDS.ethUsdEthereum, 2_500],
    [CHAINLINK_FEEDS.usdcUsdEthereum, 1],
  ]);
  usdc = mockToken(chain, USDC, { symbol: "USDC", decimals: 6 });
  mockToken(chain, WETH, { symbol: "WETH", decimals: 18 });
  setBalance(usdc, ACCOUNT, 100_000_000_000n);
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 19n);
  configurePlatform({ store: new MemoryIntentStore(), adapters: [pancake] });
});

afterEach(() => {
  chain.restore();
  oracle.restore();
  configureAdapters(null);
});

/** USDC/WETH on PancakeSwap's four tiers: the 0.25 % pool quotes best (oracle 0.4 WETH per 1000 USDC). */
function pancakePools(world: DexWorld): Record<number, Address> {
  return {
    100: addPool(chain, world, USDC, WETH, 100, { ab: 396_000_000_000_000_000n, ba: 2_470_000_000n }),
    500: addPool(chain, world, USDC, WETH, 500, { ab: 397_000_000_000_000_000n, ba: 2_480_000_000n }),
    2500: addPool(chain, world, USDC, WETH, 2500, { ab: 399_000_000_000_000_000n, ba: 2_495_000_000n }),
    10000: addPool(chain, world, USDC, WETH, 10000),
  };
}

function swap(from: string, to: string, amount: string, extra: Record<string, unknown> = {}) {
  return createIntent({ actions: [{ kind: "swap", network: "ethereum", from, to, amount, ...extra }], accounts: ACCOUNTS });
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

const inner = (functionName: "exactInputSingle" | "unwrapWETH9", args: readonly unknown[]): Hex =>
  encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName, args } as never) as Hex;

describe("PancakeSwap V3 wiring", () => {
  it("is live, auctioned (not named-only) and serves Ethereum, Base and Arbitrum only", async () => {
    assert.ok(pancakeswapV3Adapter && ADAPTERS.includes(pancakeswapV3Adapter));
    assert.notEqual(pancake.explicitOnly, true);
    configureAdapters(null);
    for (const network of ["ethereum", "base", "arbitrum", "optimism", "polygon"] as const) {
      const route = { kind: "swap" as const, network, destinationNetwork: network, input: await resolveAsset(network, "USDC"), output: await resolveAsset(network, "WETH") };
      const ids = candidateAdapters(route, undefined).map((adapter) => adapter.id);
      assert.equal(ids.includes("pancakeswap-v3"), ["ethereum", "base", "arbitrum"].includes(network), `${network}: ${ids.join(", ")}`);
      assert.ok(ids.includes("uniswap-v3"), network);
    }
  });
});

describe("PancakeSwap V3 pins", () => {
  it("refuses router / quoter / factory drift: factory, WETH9, deployer and poolDeployer", async () => {
    for (const field of ["routerFactory", "routerWrapped", "routerDeployer", "quoterFactory", "quoterWrapped", "quoterDeployer", "factoryDeployer"] as const) {
      resetDexCaches();
      const world = mockDex(chain, PANCAKE);
      pancakePools(world);
      world.reported[field] = OTHER;
      const error = await planError("USDC", "WETH", "1000");
      assert.equal(error.code, "VENUE_UNVERIFIED", field);
      assert.match(error.message, /pancakeswap-v3/u, field);
    }
  });

  it("refuses a pool whose factory() is not the pinned factory", async () => {
    const world = mockDex(chain, PANCAKE);
    const pools = pancakePools(world);
    world.poolFactory.set(pools[500].toLowerCase(), OTHER);
    const error = await planError("USDC", "WETH", "1000");
    assert.equal(error.code, "VENUE_UNVERIFIED");
    assert.match(error.message, /factory\(\)/u);
  });
});

describe("PancakeSwap V3 planning and calldata", () => {
  it("quotes every PancakeSwap tier, keeps the best (0.25 %) and records it", async () => {
    const world = mockDex(chain, PANCAKE);
    const pools = pancakePools(world);
    const graph = await swap("USDC", "WETH", "1000");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "pancakeswap-v3");
    assert.equal(step.expectedOutput?.amount, "399000000000000000");
    assert.equal(decodeStepRef(step.quoteRef)?.provider, "v3:2500");
    assert.match((step.warnings ?? []).join(" "), new RegExp(`Route: PancakeSwap V3 \\(ethereum:pancakeswap-v3:v3\\), 0\\.25 % pool, ${pools[2500]}`, "u"));
    // Each pool was proven by the factory before quoting; no 0.3 % (Uniswap) tier was asked for. Two-hop paths are
    // searched alongside the direct pools, so only the USDC / WETH lookups are counted here.
    const getPools = chain.calls.filter((entry) => entry.to === PANCAKE.factory.toLowerCase() && entry.functionName === "getPool");
    const pair = [USDC, WETH].map((address) => address.toLowerCase()).sort().join(":");
    const direct = getPools.filter((entry) => [String(entry.args[0]), String(entry.args[1])].map((address) => address.toLowerCase()).sort().join(":") === pair);
    assert.deepEqual(direct.map((entry) => Number(entry.args[2])).sort((a, b) => a - b), [100, 500, 2500, 10000]);
    assert.ok(getPools.every((entry) => Number(entry.args[2]) !== 3000), "no Uniswap-only tier");
  });

  it("ERC-20 in: exact approval of the SmartRouter only, then exactInputSingle(fee 2500) to the account", async () => {
    const world = mockDex(chain, PANCAKE);
    pancakePools(world);
    const transactions = await prepared(await swap("USDC", "WETH", "1000"));
    assert.equal(transactions.length, 2);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args, [ROUTER, 1_000_000_000n]);
    assert.equal(transactions[1]?.to, ROUTER);
    const decoded = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: transactions[1]?.data as Hex });
    assert.equal(decoded.functionName, "multicall");
    const [deadline] = decoded.args as readonly [bigint, readonly Hex[]];
    const minimum = (399_000_000_000_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[1]?.data, encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: "multicall", args: [deadline, [
      inner("exactInputSingle", [{ tokenIn: USDC, tokenOut: WETH, fee: 2500, recipient: ACCOUNT, amountIn: 1_000_000_000n, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n }]),
    ]] }));
  });

  it("native out: the SmartRouter keeps WETH (ADDRESS_THIS) and unwrapWETH9 pays the account the floor", async () => {
    const world = mockDex(chain, PANCAKE);
    pancakePools(world);
    setAllowance(usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const transactions = await prepared(await swap("USDC", "ETH", "1000"));
    assert.equal(transactions.length, 1);
    const [deadline] = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: transactions[0]?.data as Hex }).args as readonly [bigint, readonly Hex[]];
    const minimum = (399_000_000_000_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[0]?.data, encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: "multicall", args: [deadline, [
      inner("exactInputSingle", [{ tokenIn: USDC, tokenOut: WETH, fee: 2500, recipient: ADDRESS_THIS, amountIn: 1_000_000_000n, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n }]),
      inner("unwrapWETH9", [minimum, ACCOUNT]),
    ]] }));
  });
});

describe("PancakeSwap V3 verification (PancakeSwap's Swap event)", () => {
  const pancakeSwap = (pool: string) => eventLog(pool, PANCAKE_POOL_ABI as unknown as Abi, "Swap", {
    sender: ROUTER, recipient: ACCOUNT, amount0: 1_000_000_000n, amount1: -399_000_000_000_000_000n, sqrtPriceX96: 1n, liquidity: 1n, tick: 0,
    protocolFeesToken0: 1n, protocolFeesToken1: 0n,
  });
  const uniswapShapedSwap = (pool: string) => eventLog(pool, POOL_ABI as unknown as Abi, "Swap", {
    sender: ROUTER, recipient: ACCOUNT, amount0: 1_000_000_000n, amount1: -399_000_000_000_000_000n, sqrtPriceX96: 1n, liquidity: 1n, tick: 0,
  });

  async function landed(logs: (pool: Address) => ReturnType<typeof eventLog>[]) {
    const world = mockDex(chain, PANCAKE);
    const pools = pancakePools(world);
    setAllowance(usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const graph = await swap("USDC", "WETH", "1000");
    const transactions = await prepared(graph);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [logs(pools[2500])]));
    return { done, step: (await getIntent(graph.id)).steps[0]! };
  }

  it("settles on PancakeSwap's Swap from the recorded pool and a Transfer to the account at or above the floor", async () => {
    const { done } = await landed((pool) => [transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n), pancakeSwap(pool)]);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.match(done.steps[0]?.evidence.map((entry) => entry.detail).join(" ") ?? "", /PancakeSwap V3 Swap through/u);
  });

  it("does not accept a Uniswap-shaped Swap from the pool, and refuses a Swap of either shape from another address", async () => {
    const { done } = await landed((pool) => [transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n), uniswapShapedSwap(pool)]);
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(done.steps[0]?.failure?.message ?? "", /emitted no Swap event/u);
    for (const foreign of [pancakeSwap(OTHER), uniswapShapedSwap(OTHER)]) {
      const { done: refused } = await landed((pool) => [transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n), pancakeSwap(pool), foreign]);
      assert.equal(refused.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
      assert.match(refused.steps[0]?.failure?.message ?? "", /not a pool of the pinned factory/u);
    }
  });

  it("refuses an output below the floor", async () => {
    const { done } = await landed((pool) => [transferLog(WETH, pool, ACCOUNT, 300_000_000_000_000_000n), pancakeSwap(pool)]);
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(done.steps[0]?.failure?.message ?? "", /below the guaranteed/u);
  });
});

describe("PancakeSwap V3 in the same-network auction", () => {
  function both(pancakeOut: bigint, uniswapOut: bigint): void {
    const cake = mockDex(chain, PANCAKE);
    addPool(chain, cake, USDC, WETH, 100, { ab: pancakeOut });
    const uni = mockDex(chain, UNISWAP);
    addPool(chain, uni, USDC, WETH, 500, { ab: uniswapOut });
    configurePlatform({ store: new MemoryIntentStore(), adapters: [uniswap, pancake] });
  }

  it("picks PancakeSwap when it quotes more, Uniswap when Uniswap does", async () => {
    both(399_500_000_000_000_000n, 399_000_000_000_000_000n);
    const cakeWins = await swap("USDC", "WETH", "1000");
    assert.equal(cakeWins.steps[0]?.protocol, "pancakeswap-v3");
    assert.equal(cakeWins.steps[0]?.expectedOutput?.amount, "399500000000000000");
    chain.restore();
    chain = installLendingChain();
    resetDexCaches();
    usdc = mockToken(chain, USDC, { symbol: "USDC", decimals: 6 });
    mockToken(chain, WETH, { symbol: "WETH", decimals: 18 });
    setBalance(usdc, ACCOUNT, 100_000_000_000n);
    both(398_000_000_000_000_000n, 399_000_000_000_000_000n);
    const uniWins = await swap("USDC", "WETH", "1000");
    assert.equal(uniWins.steps[0]?.protocol, "uniswap-v3");
  });

  it("a named venue (protocol pancakeswap-v3) is honoured even when Uniswap quotes more", async () => {
    both(398_000_000_000_000_000n, 399_000_000_000_000_000n);
    const named = await swap("USDC", "WETH", "1000", { protocol: "pancakeswap-v3" });
    assert.equal(named.steps[0]?.protocol, "pancakeswap-v3");
  });
});
