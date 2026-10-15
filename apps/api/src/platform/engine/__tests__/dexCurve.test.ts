/**
 * Curve adapter against in-process contract state (protocols design 3.1,
 * package P2): pinned 3pool only, coin read-back (`coins(i)` must equal the
 * registry address), `get_dy` quotes held to the Chainlink band, exact
 * `exchange(i, j, dx, min_dy)` calldata with the on-chain floor, exact
 * approvals of the pool only (Ethereum USDT reset to zero first), the
 * same-network auction, TokenExchange outcome proofs and the preview
 * invariants of the prepared payload.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress, type Abi, type Hex } from "viem";
import { curvePoolsFor, VENUE_CONTRACTS, type EvmTransactionRequest, type IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { assetAmount } from "../assets.js";
import {
  CURVE_PLAIN_POOL_ABI,
  curveAdapter,
  curveRoutesFor,
  decodeCurveRoute,
  encodeCurveRoute,
  exchangeCall,
  MAX_CURVE_SLIPPAGE_BPS,
} from "../adapters/dex/curve.js";
import { ADAPTERS, candidateAdapters, configureAdapters } from "../adapters/registry.js";
import type { PlannedStep, ProtocolAdapter } from "../adapters/types.js";
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
  resolveAsset,
  Revert,
  setAllowance,
  setBalance,
  tokenAddress,
  transferLog,
  type LendingChain,
  type TokenState,
} from "./lendingChain.js";
import { installSwapOracle, type SwapOracle } from "./rpcMock.js";

const THREEPOOL = curvePoolsFor("ethereum")[0]!;
const POOL = getAddress(THREEPOOL.pool);
const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const DAI = getAddress(tokenAddress("ethereum", "DAI"));
const USDC = getAddress(tokenAddress("ethereum", "USDC"));
const USDT = getAddress(tokenAddress("ethereum", "USDT"));
const OTHER = "0x00000000000000000000000000000000000bad01";
const curve = curveAdapter as ProtocolAdapter;

let chain: LendingChain;
let oracle: SwapOracle;

/* --------------------------------------------------------------- the world */

interface CurveWorld {
  /** coins(i) answers (defaults to the registry addresses DAI, USDC, USDT). */
  readonly coins: string[];
  /** get_dy answers by `${i}:${j}` (any dx); missing: the pool reverts. */
  readonly dy: Map<string, bigint>;
  readonly tokens: { dai: TokenState; usdc: TokenState; usdt: TokenState };
}

function mockCurve(): CurveWorld {
  const world: CurveWorld = {
    coins: [DAI, USDC, USDT],
    dy: new Map([
      ["1:2", 1_001_168_500n], // 1,000 USDC -> 1001.1685 USDT (evidence dex.json scale)
      ["2:1", 998_800_000n],
      ["1:0", 1_000_500_000_000_000_000_000n],
    ]),
    tokens: {
      dai: mockToken(chain, DAI, { symbol: "DAI", decimals: 18 }),
      usdc: mockToken(chain, USDC, { symbol: "USDC", decimals: 6 }),
      usdt: mockToken(chain, USDT, { symbol: "USDT", decimals: 6 }),
    },
  };
  chain.contract(POOL, CURVE_PLAIN_POOL_ABI as unknown as Abi, {
    coins: ([index]) => world.coins[Number(index)],
    get_dy: ([i, j]) => {
      const out = world.dy.get(`${String(i)}:${String(j)}`);
      if (out === undefined) throw new Revert();
      return out;
    },
    exchange: () => undefined,
  });
  setBalance(world.tokens.usdc, ACCOUNT, 100_000_000_000n);
  setBalance(world.tokens.usdt, ACCOUNT, 100_000_000_000n);
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 19n);
  return world;
}

beforeEach(() => {
  chain = installLendingChain();
  oracle = installSwapOracle([
    [CHAINLINK_FEEDS.ethUsdEthereum, 2_500],
    [CHAINLINK_FEEDS.usdcUsdEthereum, 1],
    [CHAINLINK_FEEDS.usdtUsdEthereum, 1],
    [CHAINLINK_FEEDS.daiUsdEthereum, 1],
  ]);
  configurePlatform({ store: new MemoryIntentStore(), adapters: [curve] });
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

function exchangeArgs(transaction: EvmTransactionRequest | undefined): readonly bigint[] {
  const decoded = decodeFunctionData({ abi: CURVE_PLAIN_POOL_ABI, data: transaction?.data as Hex });
  assert.equal(decoded.functionName, "exchange");
  return decoded.args as readonly bigint[];
}

function exchangeLog(buyer: string, i: number, sold: bigint, j: number, bought: bigint, address: string = POOL) {
  return eventLog(address, CURVE_PLAIN_POOL_ABI as unknown as Abi, "TokenExchange", {
    buyer, sold_id: BigInt(i), tokens_sold: sold, bought_id: BigInt(j), tokens_bought: bought,
  });
}

const FLOOR_1_2 = (1_001_168_500n * 9_950n) / 10_000n;

/* ------------------------------------------------------------------- tests */

describe("Curve adapter wiring", () => {
  it("is live in the default registry, auctioned (not named-only) and pinned as the only spender", async () => {
    assert.ok(curveAdapter, "non-null");
    assert.ok(ADAPTERS.includes(curveAdapter));
    assert.notEqual(curveAdapter.explicitOnly, true);
    assert.ok(VENUE_CONTRACTS.some((entry) => entry.protocol === "curve" && entry.network === "ethereum" && entry.role === "curve-pool" && entry.address === THREEPOOL.pool));
    configureAdapters(null);
    const route = { kind: "swap" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const, input: await resolveAsset("ethereum", "USDC"), output: await resolveAsset("ethereum", "USDT") };
    assert.ok(candidateAdapters(route, undefined).some((adapter) => adapter.id === "curve"));
  });

  it("serves only same-network ERC-20 swaps between coins of a pinned pool", async () => {
    type Network = "ethereum" | "base" | "arbitrum";
    const route = async (network: Network, from: string, to: string) =>
      ({ kind: "swap" as const, network, destinationNetwork: network, input: await resolveAsset(network, from), output: await resolveAsset(network, to) });
    assert.equal(curve.supports(await route("ethereum", "USDC", "USDT")), true);
    assert.equal(curve.supports(await route("ethereum", "USDT", "DAI")), true);
    assert.equal(curve.supports(await route("ethereum", "USDC", "WETH")), false, "WETH is not a 3pool coin");
    assert.equal(curve.supports(await route("ethereum", "USDC", "ETH")), false, "native legs are out of scope");
    assert.equal(curve.supports(await route("ethereum", "USDC", "USDC")), false);
    assert.equal(curve.supports(await route("arbitrum", "USDC", "USDT")), false, "no pinned pool on Arbitrum");
    assert.equal(curve.supports({ ...(await route("ethereum", "USDC", "USDT")), kind: "bridge", destinationNetwork: "arbitrum" }), false);
  });

  it("records the route as <slug>:<i>:<j> and parses only pinned pools and valid indices", () => {
    const [route] = curveRoutesFor("ethereum", USDC, USDT);
    assert.ok(route);
    assert.equal(encodeCurveRoute(route), "3pool:1:2");
    assert.deepEqual(decodeCurveRoute("ethereum", "3pool:1:2"), { pool: THREEPOOL, i: 1, j: 2 });
    for (const bad of ["3pool:1:1", "3pool:1:3", "tricrypto:0:1", "3pool:1", "v3:500", undefined]) assert.equal(decodeCurveRoute("ethereum", bad), null, String(bad));
    assert.equal(decodeCurveRoute("arbitrum", "3pool:1:2"), null);
  });
});

describe("Curve planning", () => {
  it("quotes get_dy on the pinned pool, records the indices and floors the output on-chain", async () => {
    mockCurve();
    const graph = await swap("USDC", "USDT", "1000");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "curve");
    assert.equal(step.expectedOutput?.amount, "1001168500");
    assert.equal(step.minimumOutput?.amount, FLOOR_1_2.toString(), "default slippage 0.5 %");
    assert.match(step.warnings?.join(" ") ?? "", new RegExp(`Route: Curve \\(ethereum:curve:3pool\\), USDC \\(coin 1\\) to USDT \\(coin 2\\), pool ${POOL}`, "u"));
    const coinReads = chain.calls.filter((entry) => entry.functionName === "coins" && entry.to === POOL.toLowerCase()).map((entry) => Number(entry.args[0]));
    assert.deepEqual([...new Set(coinReads)].sort(), [1, 2], "both coins re-read before the quote");
  });

  it("refuses when the pool's coins(i) does not match the registry address (coin index mismatch)", async () => {
    const world = mockCurve();
    world.coins[2] = DAI;
    const error = await planError("USDC", "USDT", "1000");
    assert.equal(error.code, "VENUE_UNVERIFIED");
    assert.match(error.message, /coins\(2\)/u);
    world.coins[2] = USDT;
    world.coins[1] = OTHER;
    assert.equal((await planError("USDC", "USDT", "1000")).code, "VENUE_UNVERIFIED");
    assert.ok(!chain.calls.some((entry) => entry.functionName === "get_dy"), "no quote is read from an unverified pool");
  });

  it("refuses when the pool does not quote, and holds the quote to the Chainlink band", async () => {
    const world = mockCurve();
    world.dy.delete("1:2");
    assert.equal((await planError("USDC", "USDT", "1000")).code, "ROUTE_UNAVAILABLE");
    world.dy.set("1:2", 940_000_000n);
    const error = await planError("USDC", "USDT", "1000");
    assert.equal(error.code, "PRICE_IMPACT_TOO_HIGH");
  });

  it("answers PRICE_UNAVAILABLE when an asset has no fresh price", async () => {
    mockCurve();
    oracle.answers.delete(`ethereum:${CHAINLINK_FEEDS.usdtUsdEthereum.address.toLowerCase()}`);
    const error = await planError("USDC", "USDT", "1000");
    assert.equal(error.code, "PRICE_UNAVAILABLE");
    assert.match(error.message, /USDT/u);
  });

  it("caps slippage at 3 %", async () => {
    mockCurve();
    const wide = await createIntent({ actions: [{ kind: "swap", network: "ethereum", from: "USDC", to: "USDT", amount: "1000" }], accounts: ACCOUNTS, constraints: { maxSlippageBps: 800 } });
    assert.equal(wide.steps[0]?.minimumOutput?.amount, ((1_001_168_500n * BigInt(10_000 - MAX_CURVE_SLIPPAGE_BPS)) / 10_000n).toString());
    assert.match(wide.steps[0]?.warnings?.join(" ") ?? "", /Slippage capped at 3 %/u);
  });
});

describe("Curve calldata", () => {
  it("exact approval of the pool, then exchange(i, j, dx, min_dy) with min_dy = the floor", async () => {
    const world = mockCurve();
    setAllowance(world.tokens.usdc, ACCOUNT, POOL, 5n);
    const graph = await swap("USDC", "USDT", "1000");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2, "USDC needs no reset: one approval");
    assert.equal(transactions[0]?.to.toLowerCase(), USDC.toLowerCase());
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args, [POOL, 1_000_000_000n]);
    assert.equal(transactions[1]?.to, POOL);
    assert.equal(transactions[1]?.value, "0");
    assert.deepEqual(exchangeArgs(transactions[1]), [1n, 2n, 1_000_000_000n, FLOOR_1_2]);
    assert.equal(transactions[1]?.data, exchangeCall({ pool: THREEPOOL, i: 1, j: 2 }, 1_000_000_000n, FLOOR_1_2));
    const step = (await getIntent(graph.id)).steps[0]!;
    assert.equal(step.minimumOutput?.amount, FLOOR_1_2.toString());
  });

  it("USDT with a partial allowance: approve(pool, 0) then approve(pool, amount), then the exchange", async () => {
    const world = mockCurve();
    setAllowance(world.tokens.usdt, ACCOUNT, POOL, 5_000_000n);
    const graph = await swap("USDT", "USDC", "10");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 3);
    for (const transaction of transactions.slice(0, 2)) assert.equal(transaction.to.toLowerCase(), USDT.toLowerCase());
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args, [POOL, 0n]);
    assert.match(transactions[0]?.description ?? "", /Reset the USDT allowance/u);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[1]?.data as Hex }).args, [POOL, 10_000_000n]);
    assert.deepEqual(exchangeArgs(transactions[2]).slice(0, 3), [2n, 1n, 10_000_000n]);
  });

  it("USDT with a zero allowance needs one approval; a covering allowance none (and the exchange is simulated)", async () => {
    const world = mockCurve();
    const graph = await swap("USDT", "USDC", "10");
    assert.equal((await prepared(graph)).length, 2);
    setAllowance(world.tokens.usdt, ACCOUNT, POOL, 10_000_000n);
    const covered = await prepared(await swap("USDT", "USDC", "10"));
    assert.equal(covered.length, 1);
    assert.ok(chain.calls.some((entry) => entry.functionName === "exchange" && entry.direct), "the exchange was dry-run");
  });

  it("prepare re-reads the coins of the recorded pool and refuses a quote below the planned floor", async () => {
    const world = mockCurve();
    setAllowance(world.tokens.usdc, ACCOUNT, POOL, 1_000_000_000n);
    const graph = await swap("USDC", "USDT", "1000");
    world.dy.set("1:2", 990_000_000n);
    await assert.rejects(prepareStep(graph.id, "s1"), (error: PlatformError) => error.code === "QUOTE_MOVED");
    world.dy.set("1:2", 1_001_100_000n);
    world.coins[2] = OTHER;
    await assert.rejects(prepareStep(graph.id, "s1"), (error: PlatformError) => error.code === "VENUE_UNVERIFIED");
    world.coins[2] = USDT;
    const transactions = await prepared(graph);
    assert.deepEqual(exchangeArgs(transactions[0]).slice(0, 2), [1n, 2n]);
  });

  it("prepare refuses a recorded route whose indices do not name the step's tokens", async () => {
    mockCurve();
    const route = await resolveAsset("ethereum", "USDC");
    const output = await resolveAsset("ethereum", "USDT");
    const action = {
      kind: "swap" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const, input: route, output, amount: "1000000000",
      account: { namespace: "eip155", chainId: "1", address: ACCOUNT } as never, recipient: { namespace: "eip155", chainId: "1", address: ACCOUNT } as never, slippageBps: 50,
    };
    await assert.rejects(curve.prepare({ action: { ...action, provider: "3pool:0:2" }, now: Date.now() } as never), (error: PlatformError) => error.code === "PLAN_INVALID");
    await assert.rejects(curve.prepare({ action: { ...action, provider: undefined }, now: Date.now() } as never), (error: PlatformError) => error.code === "PLAN_INVALID");
  });
});

describe("Curve in the same-network auction", () => {
  it("wins against a DEX whose guaranteed output is lower, and loses to a better one", async () => {
    mockCurve();
    const stub = (id: "uniswap-v3" | "pancakeswap-v3", out: bigint): ProtocolAdapter => ({
      id,
      protocols: [id],
      label: id,
      supports: (route) => route.kind === "swap" && route.network === "ethereum",
      plan: async (action): Promise<PlannedStep> => ({
        protocol: id,
        title: `stub ${id}`,
        mode: "wallet",
        input: assetAmount(action.input, action.amount),
        expectedOutput: assetAmount(action.output, out.toString()),
        minimumOutput: assetAmount(action.output, ((out * 9_950n) / 10_000n).toString()),
        estimatedSeconds: 15,
        settlement: { kind: "same-network" },
        warnings: [],
        transactionCount: 1,
        slippageBps: 50,
        floor: "onchain",
      }),
      prepare: async () => assert.fail("not prepared"),
      verify: async () => assert.fail("not verified"),
    });
    configurePlatform({ store: new MemoryIntentStore(), adapters: [stub("uniswap-v3", 1_001_162_000n), stub("pancakeswap-v3", 1_001_149_000n), curve] });
    assert.equal((await swap("USDC", "USDT", "1000")).steps[0]?.protocol, "curve");
    configurePlatform({ store: new MemoryIntentStore(), adapters: [stub("uniswap-v3", 1_002_000_000n), curve] });
    assert.equal((await swap("USDC", "USDT", "1000")).steps[0]?.protocol, "uniswap-v3");
    // Named: "via curve" keeps Curve even when another venue would pay more.
    const named = await createIntent({ actions: [{ kind: "swap", network: "ethereum", from: "USDC", to: "USDT", amount: "1000", protocol: "curve" }], accounts: ACCOUNTS });
    assert.equal(named.steps[0]?.protocol, "curve");
  });
});

describe("Curve verification", () => {
  async function landed(logs: readonly ReturnType<typeof eventLog>[], approve = false) {
    const world = mockCurve();
    if (!approve) setAllowance(world.tokens.usdc, ACCOUNT, POOL, 1_000_000_000n);
    const graph = await swap("USDC", "USDT", "1000");
    const transactions = await prepared(graph);
    const hashes = landPrepared(chain, transactions, transactions.map((_, index) => (index === transactions.length - 1 ? logs : [])));
    return submitStep(graph.id, "s1", hashes);
  }

  it("proves the output: TokenExchange(buyer = account, 1, dx, 2, dy) from the pool and a Transfer at or above the floor", async () => {
    const done = await landed([
      transferLog(USDC, ACCOUNT, POOL, 1_000_000_000n),
      transferLog(USDT, POOL, ACCOUNT, 1_001_000_000n),
      exchangeLog(ACCOUNT, 1, 1_000_000_000n, 2, 1_001_000_000n),
    ]);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "1001000000");
    assert.match(done.steps[0]?.evidence.map((entry) => entry.detail).join(" ") ?? "", /Curve TokenExchange on ethereum:curve:3pool/u);
  });

  it("also proves the swap after an approval transaction", async () => {
    const done = await landed([transferLog(USDT, POOL, ACCOUNT, 1_001_000_000n), exchangeLog(ACCOUNT, 1, 1_000_000_000n, 2, 1_001_000_000n)], true);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("fails OUTCOME_NOT_PROVEN below the floor, without the event, or for an event from another address or buyer", async () => {
    const below = await landed([transferLog(USDT, POOL, ACCOUNT, 900_000_000n), exchangeLog(ACCOUNT, 1, 1_000_000_000n, 2, 900_000_000n)]);
    assert.equal(below.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(below.steps[0]?.failure?.message ?? "", /below the guaranteed/u);
    const missing = await landed([transferLog(USDT, POOL, ACCOUNT, 1_001_000_000n)]);
    assert.equal(missing.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    const foreign = await landed([transferLog(USDT, POOL, ACCOUNT, 1_001_000_000n), exchangeLog(ACCOUNT, 1, 1_000_000_000n, 2, 1_001_000_000n, OTHER)]);
    assert.equal(foreign.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    const buyer = await landed([transferLog(USDT, POOL, ACCOUNT, 1_001_000_000n), exchangeLog(OTHER, 1, 1_000_000_000n, 2, 1_001_000_000n)]);
    assert.equal(buyer.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
  });

  it("fails when the event claims the floor but the account was credited less", async () => {
    const done = await landed([transferLog(USDT, POOL, ACCOUNT, 500_000_000n), exchangeLog(ACCOUNT, 1, 1_000_000_000n, 2, 1_001_000_000n)]);
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
  });
});

describe("Curve preview invariants", () => {
  it("I1-I7 hold for the prepared payload; I4 accepts only the pinned pool as spender", async () => {
    mockCurve();
    const graph = await swap("USDC", "USDT", "1000");
    const transactions = await prepared(graph);
    const step = (await getIntent(graph.id)).steps[0]!;
    const spender = String(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args[0]).toLowerCase();
    assert.equal(spender, POOL.toLowerCase());
    assert.ok(pinnedSpenders(step).has(spender), "the pool is a pinned spender of the step's protocol");
    const effect = (approvalSpender: string) => ({
      reverted: null,
      debits: new Map([[USDC.toLowerCase(), 1_000_000_000n]]),
      credits: new Map([[USDT.toLowerCase(), 1_001_168_500n]]),
      net: new Map([[USDC.toLowerCase(), -1_000_000_000n], [USDT.toLowerCase(), 1_001_168_500n]]),
      nativeOut: 0n,
      nativeIn: 0n,
      nftOut: [],
      approvals: [{ token: USDC.toLowerCase(), spender: approvalSpender, value: 1_000_000_000n }],
      approvalsForAll: [],
      valueTotal: 0n,
      balanceBefore: 100_000_000_000n,
    });
    const rules = {
      step,
      input: { token: USDC.toLowerCase(), amount: 1_000_000_000n },
      extraNative: 0n,
      minimumOutput: { token: USDT.toLowerCase(), amount: BigInt(step.minimumOutput?.amount ?? "0") },
      ready: true,
    };
    assert.deepEqual(evmViolations(effect(spender), rules), []);
    assert.deepEqual(evmViolations(effect(OTHER), rules).map((violation) => violation.rule), ["I4"]);
  });
});
