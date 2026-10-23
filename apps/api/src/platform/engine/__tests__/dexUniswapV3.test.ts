/**
 * Uniswap V3 adapter against in-process contract state: fee-tier selection
 * from mocked eth_calls, two-hop paths, pin checks of the router, quoter
 * and pools, the Chainlink band, exact SwapRouter02 calldata for ERC-20,
 * native-in and native-out swaps, exact approvals of the router only,
 * outcome proofs (Swap from the factory's pool, output at or above the
 * floor, WETH Withdrawal for native output) and the preview invariants of
 * the prepared payload.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { dexDeploymentsFor, nativeAssetId, type EvmTransactionRequest, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  ADDRESS_THIS,
  encodePath,
  PINS_ABI,
  POOL_ABI,
  resetDexCaches,
  SWAP_ROUTER02_ABI,
  UNISWAP_FACTORY_ABI,
  UNISWAP_QUOTER_ABI,
} from "../adapters/dex/concentrated.js";
import { aerodromeAdapter, velodromeAdapter } from "../adapters/dex/aerodrome.js";
import { uniswapV3Adapter } from "../adapters/dex/uniswapV3.js";
import { WETH_ABI } from "../adapters/lending/common.js";
import { ADAPTERS, candidateAdapters, configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { resolveAsset } from "../assets.js";
import { CHAINLINK_FEEDS } from "../policy/feeds.js";
import { evmViolations, pinnedSpenders } from "../preview/invariants.js";
import { configurePlatform, createIntent, getIntent, prepareStep, submitStep } from "../service.js";
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

const ETHEREUM = dexDeploymentsFor("ethereum", "uniswap-v3")[0]!;
const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const USDC = getAddress(tokenAddress("ethereum", "USDC"));
const WETH = getAddress(tokenAddress("ethereum", "WETH"));
const WSTETH = getAddress(tokenAddress("ethereum", "wstETH"));
const ROUTER = getAddress(ETHEREUM.router);
const OTHER = "0x00000000000000000000000000000000000bad01";
const uniswap = uniswapV3Adapter as ProtocolAdapter;

let chain: LendingChain;
let oracle: SwapOracle;

/* --------------------------------------------------------------- the world */

interface UniswapWorld {
  /** Pool address by unordered pair and fee. */
  readonly pools: Map<string, Address>;
  /** Factory each pool reports (defaults to the pin). */
  readonly poolFactory: Map<string, string>;
  /** amountOut by `${tokenIn}:${tokenOut}:${fee}` (any amount in); missing: the quoter reverts. */
  readonly quotes: Map<string, bigint>;
  /** amountOut by encoded path. */
  readonly paths: Map<string, bigint>;
  routerFactory: string;
  routerWeth: string;
  quoterFactory: string;
  tokens: { usdc: TokenState; weth: TokenState; wsteth: TokenState };
}

const pairKey = (a: string, b: string, fee: number) => [a.toLowerCase(), b.toLowerCase()].sort().join(":") + `:${fee}`;
const quoteKey = (a: string, b: string, fee: number) => `${a.toLowerCase()}:${b.toLowerCase()}:${fee}`;

let poolCounter = 0;
function addPool(world: UniswapWorld, a: string, b: string, fee: number, out?: { readonly ab?: bigint; readonly ba?: bigint }): Address {
  poolCounter += 1;
  const pool = getAddress(`0x${(0xa11ce0000 + poolCounter).toString(16).padStart(40, "0")}`);
  world.pools.set(pairKey(a, b, fee), pool);
  chain.contract(pool, POOL_ABI as unknown as Abi, { factory: () => world.poolFactory.get(pool.toLowerCase()) ?? ETHEREUM.factory });
  if (out?.ab !== undefined) world.quotes.set(quoteKey(a, b, fee), out.ab);
  if (out?.ba !== undefined) world.quotes.set(quoteKey(b, a, fee), out.ba);
  return pool;
}

function mockUniswap(network: "ethereum" | "arbitrum" = "ethereum"): UniswapWorld {
  const deployment = dexDeploymentsFor(network, "uniswap-v3")[0]!;
  const world: UniswapWorld = {
    pools: new Map(),
    poolFactory: new Map(),
    quotes: new Map(),
    paths: new Map(),
    routerFactory: deployment.factory,
    routerWeth: deployment.wrappedNative,
    quoterFactory: deployment.factory,
    tokens: {
      usdc: mockToken(chain, tokenAddress(network, "USDC"), { symbol: "USDC", decimals: 6 }),
      weth: mockToken(chain, tokenAddress(network, "WETH"), { symbol: "WETH", decimals: 18 }),
      wsteth: mockToken(chain, WSTETH, { symbol: "wstETH", decimals: 18 }),
    },
  };
  chain.contract(deployment.factory, UNISWAP_FACTORY_ABI as unknown as Abi, {
    getPool: ([a, b, fee]) => world.pools.get(pairKey(String(a), String(b), Number(fee))) ?? zeroAddress,
  });
  chain.contract(deployment.quoter as string, [...PINS_ABI, ...UNISWAP_QUOTER_ABI] as unknown as Abi, {
    factory: () => world.quoterFactory,
    WETH9: () => deployment.wrappedNative,
    quoteExactInputSingle: ([params]) => {
      const { tokenIn, tokenOut, fee } = params as { tokenIn: string; tokenOut: string; fee: number };
      const out = world.quotes.get(quoteKey(tokenIn, tokenOut, fee));
      if (out === undefined || !world.pools.has(pairKey(tokenIn, tokenOut, fee))) throw new Revert();
      return [out, 0n, 1, 90_000n];
    },
    quoteExactInput: ([path]) => {
      const out = world.paths.get(String(path).toLowerCase());
      if (out === undefined) throw new Revert();
      return [out, [], [], 160_000n];
    },
  });
  chain.contract(deployment.router, [...PINS_ABI, ...SWAP_ROUTER02_ABI] as unknown as Abi, {
    factory: () => world.routerFactory,
    WETH9: () => world.routerWeth,
    multicall: () => [],
  });
  setBalance(world.tokens.usdc, ACCOUNT, 100_000_000_000n);
  setBalance(world.tokens.wsteth, ACCOUNT, 10n ** 19n);
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 19n);
  return world;
}

/** USDC/WETH on every tier: 1000 USDC buys 0.396 / 0.399 / 0.38 WETH (oracle 0.4 at $2500); the 1% tier has no liquidity. */
function usdcWethPools(world: UniswapWorld): Record<number, Address> {
  return {
    100: addPool(world, USDC, WETH, 100, { ab: 396_000_000_000_000_000n, ba: 2_470_000_000n }),
    500: addPool(world, USDC, WETH, 500, { ab: 399_000_000_000_000_000n, ba: 2_495_000_000n }),
    3000: addPool(world, USDC, WETH, 3000, { ab: 380_000_000_000_000_000n, ba: 2_400_000_000n }),
    10000: addPool(world, USDC, WETH, 10000),
  };
}

beforeEach(() => {
  chain = installLendingChain();
  resetDexCaches();
  oracle = installSwapOracle([
    [CHAINLINK_FEEDS.ethUsdEthereum, 2_500],
    [CHAINLINK_FEEDS.usdcUsdEthereum, 1],
    [CHAINLINK_FEEDS.stethUsdEthereum, 2_500],
  ]);
  configurePlatform({ store: new MemoryIntentStore(), adapters: [uniswap] });
});

afterEach(() => {
  chain.restore();
  oracle.restore();
  configureAdapters(null);
});

/* ----------------------------------------------------------------- helpers */

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

/** The router call's multicall: deadline and inner calls decoded. */
function multicall(transaction: EvmTransactionRequest | undefined): { deadline: bigint; calls: readonly Hex[] } {
  const decoded = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: transaction?.data as Hex });
  assert.equal(decoded.functionName, "multicall");
  const [deadline, calls] = decoded.args as readonly [bigint, readonly Hex[]];
  return { deadline, calls };
}

function swapLog(pool: string, recipient: string) {
  return eventLog(pool, POOL_ABI as unknown as Abi, "Swap", {
    sender: ROUTER, recipient, amount0: 1_000_000_000n, amount1: -399_000_000_000_000_000n, sqrtPriceX96: 1n, liquidity: 1n, tick: 0,
  });
}

/* ------------------------------------------------------------------- tests */

describe("Uniswap V3 adapter wiring", () => {
  it("is live in the default registry, takes part in the same-network auction and keeps on-chain floors", async () => {
    for (const adapter of [uniswapV3Adapter, aerodromeAdapter, velodromeAdapter]) {
      assert.ok(adapter, "non-null");
      assert.ok(ADAPTERS.includes(adapter));
      assert.notEqual(adapter.explicitOnly, true, `${adapter.id} is auctioned, not named-only`);
    }
    configureAdapters(null);
    const route = { kind: "swap" as const, network: "base" as const, destinationNetwork: "base" as const, input: await resolveAsset("base", "USDC"), output: await resolveAsset("base", "ETH") };
    const ids = candidateAdapters(route, undefined).map((adapter) => adapter.id);
    assert.ok(ids.includes("uniswap-v3") && ids.includes("aerodrome") && !ids.includes("velodrome"), ids.join(", "));
  });

  it("serves same-network swaps of registry assets on the five EVM networks only", async () => {
    type Network = "ethereum" | "base" | "polygon" | "arbitrum" | "optimism" | "solana";
    const route = async (network: Network, from: string, to: string, destination: Network = network) =>
      ({ kind: "swap" as const, network, destinationNetwork: destination, input: await resolveAsset(network, from), output: await resolveAsset(destination, to) });
    for (const network of ["ethereum", "base", "arbitrum", "optimism"] as const) assert.equal(uniswap.supports(await route(network, "USDC", "ETH")), true, network);
    assert.equal(uniswap.supports(await route("polygon", "USDC", "POL")), true, "POL through WPOL");
    assert.equal(uniswap.supports(await route("ethereum", "ETH", "WETH")), false, "wrapping is not a swap");
    assert.equal(uniswap.supports(await route("base", "USDbC", "USDC")), false, "transfer-only assets never route");
    assert.equal(uniswap.supports(await route("solana", "SOL", "USDC")), false);
    assert.equal(uniswap.supports({ ...(await route("base", "USDC", "ETH")), kind: "bridge", destinationNetwork: "arbitrum", output: await resolveAsset("arbitrum", "ETH") }), false);
  });
});

describe("Uniswap V3 planning", () => {
  it("picks the best fee tier from the pinned quoter, records it and floors the output on-chain", async () => {
    const world = mockUniswap();
    const pools = usdcWethPools(world);
    const graph = await swap("USDC", "WETH", "1000");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "uniswap-v3");
    assert.equal(step.expectedOutput?.amount, "399000000000000000", "the 0.05 % tier quotes best");
    assert.equal(step.minimumOutput?.amount, ((399_000_000_000_000_000n * 9_950n) / 10_000n).toString(), "default slippage 0.5 %");
    assert.match(step.warnings?.join(" ") ?? "", new RegExp(`Route: Uniswap V3 \\(ethereum:uniswap-v3:v3\\), 0\\.05 % pool, ${pools[500]}`, "u"));
    assert.doesNotMatch(step.warnings?.join(" ") ?? "", /Price impact/u, "0.25 % below the oracle: no warning");
    // Pools were proven by the factory before quoting; the 1 % tier pool was found but its quote reverted.
    const factoryChecks = chain.calls.filter((entry) => entry.functionName === "factory" && Object.values(pools).some((pool) => pool.toLowerCase() === entry.to));
    assert.equal(factoryChecks.length, 4);
  });

  it("refuses a pool whose factory() differs from the pin", async () => {
    const world = mockUniswap();
    const pools = usdcWethPools(world);
    world.poolFactory.set(pools[3000].toLowerCase(), OTHER);
    const error = await planError("USDC", "WETH", "1000");
    assert.equal(error.code, "VENUE_UNVERIFIED");
    assert.match(error.message, /factory\(\)/u);
  });

  it("refuses a router or quoter whose factory() or WETH9() differ from the pins", async () => {
    for (const field of ["routerFactory", "routerWeth", "quoterFactory"] as const) {
      resetDexCaches();
      const world = mockUniswap();
      usdcWethPools(world);
      world[field] = OTHER;
      const error = await planError("USDC", "WETH", "1000");
      assert.equal(error.code, "VENUE_UNVERIFIED", field);
    }
  });

  it("routes two hops through WETH when no direct pool quotes, and records the path", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    addPool(world, WSTETH, WETH, 100, { ab: 1_199_000_000_000_000_000n });
    const path = encodePath([{ tokenIn: WSTETH, tokenOut: WETH, tier: 100 }, { tokenIn: WETH, tokenOut: USDC, tier: 500 }]);
    world.paths.set(path.toLowerCase(), 2_985_000_000n);
    const graph = await swap("wstETH", "USDC", "1");
    const step = graph.steps[0]!;
    assert.equal(step.expectedOutput?.amount, "2985000000");
    assert.match(step.warnings?.join(" ") ?? "", /0\.01 % then 0\.05 % pools through the wrapped native token/u);
    const transactions = await prepared(graph);
    const { deadline, calls } = multicall(transactions[1]);
    const minimum = (2_985_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[1]?.data, encodeFunctionDataExact([encodeInner("exactInput", [{ path, recipient: ACCOUNT, amountIn: 10n ** 18n, amountOutMinimum: minimum }])], deadline));
    assert.equal(calls.length, 1);
  });

  it("refuses when no pinned pool quotes", async () => {
    mockUniswap();
    const error = await planError("USDC", "WETH", "1000");
    assert.equal(error.code, "ROUTE_UNAVAILABLE");
  });
});

describe("Uniswap V3 path search", () => {
  const DAI = getAddress(tokenAddress("ethereum", "DAI"));
  const viaWeth = () => encodePath([{ tokenIn: WSTETH, tokenOut: WETH, tier: 100 }, { tokenIn: WETH, tokenOut: USDC, tier: 500 }]);

  function wstethWorld(directOut: bigint | null): UniswapWorld {
    const world = mockUniswap();
    usdcWethPools(world);
    addPool(world, WSTETH, WETH, 100, { ab: 1_199_000_000_000_000_000n });
    world.paths.set(viaWeth().toLowerCase(), 2_985_000_000n);
    if (directOut !== null) addPool(world, WSTETH, USDC, 3000, { ab: directOut });
    return world;
  }

  it("quotes direct pools and two-hop paths together and takes the larger output", async () => {
    // A thin direct pool must not hide the deeper two-hop path.
    wstethWorld(2_900_000_000n);
    const step = (await swap("wstETH", "USDC", "1")).steps[0]!;
    assert.equal(step.expectedOutput?.amount, "2985000000");
    assert.match(step.warnings?.join(" ") ?? "", /0\.01 % then 0\.05 % pools through the wrapped native token/u);
  });

  it("keeps the direct pool when a two-hop path gains less than 2 bps (it costs another pool's gas)", async () => {
    wstethWorld(2_984_500_000n);
    const step = (await swap("wstETH", "USDC", "1")).steps[0]!;
    assert.equal(step.expectedOutput?.amount, "2984500000");
    assert.match(step.warnings?.join(" ") ?? "", /0\.3 % pool/u);
  });

  it("applies the Chainlink band to the best path, not to a thin direct pool", async () => {
    // 2,500 USDC for 1 wstETH is far below the oracle: before, the direct pool's refusal refused the whole venue.
    wstethWorld(2_500_000_000n);
    const step = (await swap("wstETH", "USDC", "1")).steps[0]!;
    assert.equal(step.expectedOutput?.amount, "2985000000");
  });

  it("routes through DAI, USDT0 / USDT and cbBTC / WBTC by exact registry address, and prepares the recorded path", async () => {
    const world = wstethWorld(null);
    addPool(world, WSTETH, DAI, 100, { ab: 2_995_000_000_000_000_000_000n });
    addPool(world, DAI, USDC, 100, { ab: 2_994_000_000n });
    const path = encodePath([{ tokenIn: WSTETH, tokenOut: DAI, tier: 100 }, { tokenIn: DAI, tokenOut: USDC, tier: 100 }]);
    world.paths.set(path.toLowerCase(), 2_993_000_000n);
    const graph = await swap("wstETH", "USDC", "1");
    const step = graph.steps[0]!;
    assert.equal(step.expectedOutput?.amount, "2993000000");
    assert.match(step.warnings?.join(" ") ?? "", /through DAI/u);
    const transactions = await prepared(graph);
    const { deadline } = multicall(transactions[1]);
    const minimum = (2_993_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[1]?.data, encodeFunctionDataExact([encodeInner("exactInput", [{ path, recipient: ACCOUNT, amountIn: 10n ** 18n, amountOutMinimum: minimum }])], deadline));
  });
});

describe("Uniswap V3 Chainlink band (oracleGuard through policyPrices)", () => {
  it("refuses a quote 5.1 % below the oracle", async () => {
    const world = mockUniswap();
    addPool(world, USDC, WETH, 500, { ab: 379_600_000_000_000_000n });
    const error = await planError("USDC", "WETH", "1000");
    assert.equal(error.code, "PRICE_IMPACT_TOO_HIGH");
    assert.match(error.message, /5\.10 % below the Chainlink oracle/u);
  });

  it("warns on a quote 1.5 % below the oracle", async () => {
    const world = mockUniswap();
    addPool(world, USDC, WETH, 500, { ab: 394_000_000_000_000_000n });
    const graph = await swap("USDC", "WETH", "1000");
    assert.match(graph.steps[0]?.warnings?.join(" ") ?? "", /Price impact: the quote is 1\.50 % below the Chainlink oracle price/u);
  });

  it("answers PRICE_UNAVAILABLE when an asset has no fresh price", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    oracle.answers.delete(`ethereum:${CHAINLINK_FEEDS.ethUsdEthereum.address.toLowerCase()}`);
    const error = await planError("USDC", "WETH", "1000");
    assert.equal(error.code, "PRICE_UNAVAILABLE");
    assert.match(error.message, /WETH/u);
  });
});

/* -------------------------------------------------------- calldata (exact) */

type InnerName = "exactInputSingle" | "exactInput" | "refundETH" | "unwrapWETH9";
const encodeInner = (functionName: InnerName, args: readonly unknown[] = []): Hex =>
  encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName, args } as never) as Hex;
const encodeFunctionDataExact = (calls: readonly Hex[], deadline: bigint): Hex =>
  encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: "multicall", args: [deadline, calls] });

describe("Uniswap V3 calldata", () => {
  it("ERC-20 to ERC-20: exact approval of the router, then exactInputSingle to the account", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    setAllowance(world.tokens.usdc, ACCOUNT, ROUTER, 5n);
    const graph = await swap("USDC", "WETH", "1000");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2);
    assert.equal(transactions[0]?.to.toLowerCase(), USDC.toLowerCase());
    const approve = decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex });
    assert.deepEqual(approve.args, [ROUTER, 1_000_000_000n], "exact approval of the router that is called, and only it");
    assert.equal(transactions[1]?.to, ROUTER);
    assert.equal(transactions[1]?.value, "0");
    const { deadline } = multicall(transactions[1]);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(deadline >= BigInt(now + 90 + 300 - 5) && deadline <= BigInt(now + 90 + 300 + 5), "deadline = payload expiry + 300 s");
    const minimum = (399_000_000_000_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[1]?.data, encodeFunctionDataExact([encodeInner("exactInputSingle", [{
      tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: ACCOUNT, amountIn: 1_000_000_000n, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n,
    }])], deadline));
  });

  it("skips the approval when the allowance covers the amount", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    setAllowance(world.tokens.usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const transactions = await prepared(await swap("USDC", "WETH", "1000"));
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]?.to, ROUTER);
  });

  it("native to ERC-20: value is the amount, WETH9 in, refundETH()", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    const graph = await swap("ETH", "USDC", "1");
    assert.equal(graph.steps[0]?.expectedOutput?.amount, "2495000000");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1, "no approval for native input");
    assert.equal(transactions[0]?.value, (10n ** 18n).toString());
    const { deadline } = multicall(transactions[0]);
    const minimum = (2_495_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[0]?.data, encodeFunctionDataExact([
      encodeInner("exactInputSingle", [{ tokenIn: WETH, tokenOut: USDC, fee: 500, recipient: ACCOUNT, amountIn: 10n ** 18n, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n }]),
      encodeInner("refundETH"),
    ], deadline));
  });

  it("ERC-20 to native: the router keeps the WETH (ADDRESS_THIS) and unwrapWETH9 pays the account", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    setAllowance(world.tokens.usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const graph = await swap("USDC", "ETH", "1000");
    assert.equal(graph.steps[0]?.minimumOutput?.asset, nativeAssetId("ethereum"));
    const transactions = await prepared(graph);
    const { deadline } = multicall(transactions[0]);
    const minimum = (399_000_000_000_000_000n * 9_950n) / 10_000n;
    assert.equal(transactions[0]?.data, encodeFunctionDataExact([
      encodeInner("exactInputSingle", [{ tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: ADDRESS_THIS, amountIn: 1_000_000_000n, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n }]),
      encodeInner("unwrapWETH9", [minimum, ACCOUNT]),
    ], deadline));
  });

  it("caps slippage at 3 %", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    const wide = await createIntent({ actions: [{ kind: "swap", network: "ethereum", from: "USDC", to: "WETH", amount: "1000" }], accounts: ACCOUNTS, constraints: { maxSlippageBps: 800 } });
    assert.equal(wide.steps[0]?.minimumOutput?.amount, ((399_000_000_000_000_000n * 9_700n) / 10_000n).toString());
    assert.match(wide.steps[0]?.warnings?.join(" ") ?? "", /Slippage capped at 3 %/u);
  });

  it("re-quotes the recorded pool at prepare and refuses a price below the planned floor", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    const graph = await swap("USDC", "WETH", "1000");
    // The 0.01 % tier would now be best, but prepare keeps the recorded 0.05 % pool; that pool moved 2.5 %.
    world.quotes.set(quoteKey(USDC, WETH, 100), 399_500_000_000_000_000n);
    world.quotes.set(quoteKey(USDC, WETH, 500), 389_000_000_000_000_000n);
    await assert.rejects(prepareStep(graph.id, "s1"), (error: PlatformError) => error.code === "QUOTE_MOVED");
    world.quotes.set(quoteKey(USDC, WETH, 500), 398_900_000_000_000_000n);
    const transactions = await prepared(graph);
    const inner = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: multicall(transactions[transactions.length - 1]).calls[0] as Hex });
    assert.equal((inner.args[0] as { fee: number }).fee, 500);
  });
});

describe("Uniswap V3 verification", () => {
  async function landedSwap(output: "WETH" | "ETH", logs: (pool: Address) => ReturnType<typeof eventLog>[]) {
    const world = mockUniswap();
    const pools = usdcWethPools(world);
    setAllowance(world.tokens.usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const graph = await swap("USDC", output, "1000");
    const transactions = await prepared(graph);
    const hashes = landPrepared(chain, transactions, [logs(pools[500])]);
    return { done: await submitStep(graph.id, "s1", hashes), floor: BigInt((await getIntent(graph.id)).steps[0]?.minimumOutput?.amount ?? "0"), pools };
  }

  it("proves an ERC-20 output: Swap from the factory's pool and a Transfer to the account at or above the floor", async () => {
    const { done } = await landedSwap("WETH", (pool) => [
      transferLog(USDC, ACCOUNT, pool, 1_000_000_000n),
      transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n),
      swapLog(pool, ACCOUNT),
    ]);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "398000000000000000");
    assert.match(done.steps[0]?.evidence.map((entry) => entry.detail).join(" ") ?? "", /Uniswap V3 Swap through/u);
  });

  it("fails OUTCOME_NOT_PROVEN for a Transfer below the floor", async () => {
    const { done } = await landedSwap("WETH", (pool) => [transferLog(WETH, pool, ACCOUNT, 300_000_000_000_000_000n), swapLog(pool, ACCOUNT)]);
    assert.equal(done.steps[0]?.status, "failed");
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(done.steps[0]?.failure?.message ?? "", /below the guaranteed/u);
  });

  it("fails OUTCOME_NOT_PROVEN for a Swap from a pool the factory does not return", async () => {
    const { done } = await landedSwap("WETH", (pool) => [transferLog(WETH, pool, ACCOUNT, 398_000_000_000_000_000n), swapLog(pool, ACCOUNT), swapLog(OTHER, ACCOUNT)]);
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(done.steps[0]?.failure?.message ?? "", /not a pool of the pinned factory/u);
    const { done: missing } = await landedSwap("WETH", () => [transferLog(WETH, OTHER, ACCOUNT, 398_000_000_000_000_000n), swapLog(OTHER, ACCOUNT)]);
    assert.equal(missing.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
  });

  it("proves Arbitrum native output through aeWETH's burn from the router (no Withdrawal event there)", async () => {
    oracle.set(CHAINLINK_FEEDS.ethUsdArbitrum, 2_500);
    oracle.set(CHAINLINK_FEEDS.usdcUsdArbitrum, 1);
    const world = mockUniswap("arbitrum");
    const usdc = getAddress(tokenAddress("arbitrum", "USDC"));
    const weth = getAddress(tokenAddress("arbitrum", "WETH"));
    const pool = addPool(world, usdc, weth, 500, { ab: 399_000_000_000_000_000n });
    setAllowance(world.tokens.usdc, ACCOUNT, ROUTER, 1_000_000_000n);
    const graph = await createIntent({ actions: [{ kind: "swap", network: "arbitrum", from: "USDC", to: "ETH", amount: "1000" }], accounts: [`eip155:42161:${ACCOUNT}`] });
    const transactions = await prepared(graph);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(weth, pool, ROUTER, 398_500_000_000_000_000n),
      swapLog(pool, ROUTER),
      transferLog(weth, ROUTER, zeroAddress, 398_500_000_000_000_000n),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "398500000000000000");
  });

  it("proves native output through the WETH Withdrawal by the router", async () => {
    const { done } = await landedSwap("ETH", (pool) => [
      transferLog(WETH, pool, ROUTER, 398_000_000_000_000_000n),
      swapLog(pool, ROUTER),
      eventLog(WETH, WETH_ABI as unknown as Abi, "Withdrawal", { src: ROUTER, wad: 398_000_000_000_000_000n }),
    ]);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "398000000000000000");
    assert.equal(done.steps[0]?.actualOutput?.asset, nativeAssetId("ethereum"));
    const { done: short } = await landedSwap("ETH", (pool) => [
      swapLog(pool, ROUTER),
      eventLog(WETH, WETH_ABI as unknown as Abi, "Withdrawal", { src: OTHER, wad: 398_000_000_000_000_000n }),
    ]);
    assert.equal(short.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a Withdrawal by anyone but the router proves nothing");
  });
});

describe("Uniswap V3 preview invariants", () => {
  it("I1-I7 hold for the prepared payload; I4 accepts only the pinned router as spender", async () => {
    const world = mockUniswap();
    usdcWethPools(world);
    const graph = await swap("USDC", "WETH", "1000");
    const transactions = await prepared(graph);
    const step = (await getIntent(graph.id)).steps[0]!;
    const approve = decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex });
    const spender = String(approve.args[0]).toLowerCase();
    assert.ok(pinnedSpenders(step).has(spender), "the router is a pinned spender of the step's protocol");
    const effect = (approvalSpender: string) => ({
      reverted: null,
      debits: new Map([[USDC.toLowerCase(), 1_000_000_000n]]),
      credits: new Map([[WETH.toLowerCase(), 399_000_000_000_000_000n]]),
      net: new Map([[USDC.toLowerCase(), -1_000_000_000n], [WETH.toLowerCase(), 399_000_000_000_000_000n]]),
      nativeOut: 0n,
      nativeIn: 0n,
      nftOut: [],
      approvals: [{ token: USDC.toLowerCase(), spender: approvalSpender, value: 1_000_000_000n }],
      approvalsForAll: [],
      valueTotal: transactions.reduce((total, transaction) => total + BigInt(transaction.value), 0n),
      balanceBefore: 100_000_000_000n,
    });
    const rules = {
      step,
      input: { token: USDC.toLowerCase(), amount: 1_000_000_000n },
      extraNative: 0n,
      minimumOutput: { token: WETH.toLowerCase(), amount: BigInt(step.minimumOutput?.amount ?? "0") },
      ready: true,
    };
    assert.deepEqual(evmViolations(effect(spender), rules), []);
    assert.deepEqual(evmViolations(effect(OTHER), rules).map((violation) => violation.rule), ["I4"]);
  });
});
