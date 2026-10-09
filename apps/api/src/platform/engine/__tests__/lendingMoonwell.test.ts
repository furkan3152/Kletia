/**
 * Moonwell adapter against in-process contract state: registry pins
 * (underlying, comptroller, listing), the exit-liquidity gate, error-code
 * simulations, the WETH router for native ETH, redeem(MAX) for "withdraw
 * all", and the mandatory Mint / Redeem events (error codes do not revert:
 * a successful receipt without the event fails VENUE_REJECTED).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, type Abi, type Hex } from "viem";
import type { CTokenVenue, EvmTransactionRequest, IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter } from "../adapters/aaveV3.js";
import { compoundV3Adapter } from "../adapters/lending/compoundV3.js";
import { erc4626Adapter } from "../adapters/lending/erc4626.js";
import { listLendingMetrics, resetLendingMetricsCache } from "../adapters/lending/metrics.js";
import { WETH_ABI } from "../adapters/lending/common.js";
import { COMPTROLLER_ABI, MTOKEN_ABI, moonwellAdapter, PAYOUT_ABI, ROUTER_ABI } from "../adapters/lending/moonwell.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import {
  ACCOUNT,
  ACCOUNTS_BASE,
  eventLog,
  installLendingChain,
  landPrepared,
  MAX,
  mockToken,
  Revert,
  setAllowance,
  setBalance,
  tokenAddress,
  transferLog,
  venue,
  type LendingChain,
  type TokenState,
} from "./lendingChain.js";

let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  resetLendingMetricsCache();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [aaveV3Adapter, compoundV3Adapter, erc4626Adapter, moonwellAdapter] });
});
afterEach(() => chain.restore());

/** 0.02 underlying per mToken, scaled 1e18 (1 USDC = 50 mUSDC; 6 vs 8 decimals). */
const RATE = 200_000_000_000_000n;

interface MarketOptions {
  asset?: "USDC" | "WETH";
  cash?: bigint;
  borrows?: bigint;
  mintPaused?: boolean;
  listed?: boolean;
  comptroller?: string;
  supplyCap?: bigint;
  tokens?: bigint;
  mintCode?: bigint;
  redeemCode?: bigint;
  routerWeth?: string;
  /** WETH unwrapper the market pays redeems through (MWethDelegate); omit for an ERC-20 payout market. */
  unwrapper?: string;
}

interface Market {
  readonly market: CTokenVenue;
  readonly underlying: TokenState;
  readonly token: string;
}

function mockMoonwell(options: MarketOptions = {}): Market {
  const symbol = options.asset ?? "USDC";
  const market = venue<CTokenVenue>(`base:moonwell:${symbol.toLowerCase()}`);
  const token = tokenAddress("base", symbol);
  const decimals = symbol === "USDC" ? 6 : 18;
  const rate = symbol === "USDC" ? RATE : 200_000_000_000_000_000_000_000_000n;
  const underlying = mockToken(chain, token, { symbol, decimals });
  const tokens = options.tokens ?? 0n;
  chain.contract(market.target, [...MTOKEN_ABI, ...PAYOUT_ABI, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as unknown as Abi, {
    ...(options.unwrapper ? { wethUnwrapper: () => options.unwrapper } : { wethUnwrapper: () => { throw new Revert(); } }),
    underlying: () => token,
    comptroller: () => options.comptroller ?? market.comptroller,
    decimals: () => 8,
    symbol: () => `m${symbol}`,
    getCash: () => options.cash ?? 10n ** BigInt(decimals + 6),
    totalBorrows: () => options.borrows ?? 10n ** BigInt(decimals + 6),
    totalReserves: () => 0n,
    supplyRatePerTimestamp: () => 1_585_489_599n,
    exchangeRateCurrent: () => rate,
    balanceOf: () => tokens,
    balanceOfUnderlying: () => (tokens * rate) / 10n ** 18n,
    mint: () => options.mintCode ?? 0n,
    redeem: () => options.redeemCode ?? 0n,
    redeemUnderlying: () => options.redeemCode ?? 0n,
  });
  chain.contract(market.comptroller, COMPTROLLER_ABI as unknown as Abi, {
    markets: () => [options.listed ?? true, 800_000_000_000_000_000n],
    mintGuardianPaused: () => options.mintPaused ?? false,
    supplyCaps: () => options.supplyCap ?? 0n,
  });
  if (options.unwrapper) chain.contract(options.unwrapper, PAYOUT_ABI as unknown as Abi, { weth: () => token });
  if (market.nativeRouter) {
    chain.contract(market.nativeRouter, ROUTER_ABI as unknown as Abi, {
      weth: () => options.routerWeth ?? token,
      mToken: () => market.target,
      mint: () => undefined,
    });
  }
  return { market, underlying, token };
}

async function planError(text: string): Promise<PlatformError> {
  try {
    await createIntent({ text, accounts: ACCOUNTS_BASE });
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail(`"${text}" planned but should have been refused`);
}

async function prepared(graph: IntentGraph): Promise<EvmTransactionRequest[]> {
  const { payload } = await prepareStep(graph.id, "s1");
  return payload.transactions as EvmTransactionRequest[];
}

const mtoken = MTOKEN_ABI as unknown as Abi;
const decode = (abi: Abi, transaction: EvmTransactionRequest | undefined) => decodeFunctionData({ abi, data: transaction?.data as Hex });

describe("Moonwell supply", () => {
  it("mints after an exact approval and requires the Mint event", async () => {
    const { market, underlying, token } = mockMoonwell();
    setBalance(underlying, ACCOUNT, 100_000_000n);
    const graph = await createIntent({ text: "lend 50 USDC on moonwell", accounts: ACCOUNTS_BASE });
    const step = graph.steps[0];
    assert.equal(step?.venue, "base:moonwell:usdc");
    assert.equal(step?.expectedOutput?.amount, "250000000000", "50 USDC at 0.02 per mToken = 2,500 mUSDC (8 decimals)");
    assert.equal(step?.minimumOutput?.amount, "249750000000");
    const transactions = await prepared(graph);
    assert.deepEqual(decode(erc20Abi as unknown as Abi, transactions[0]).args, [market.target, 50_000_000n]);
    assert.deepEqual(decode(mtoken, transactions[1]).args, [50_000_000n]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[], [
      transferLog(token, ACCOUNT, market.target, 50_000_000n),
      eventLog(market.target, mtoken, "Mint", { minter: ACCOUNT, mintAmount: 50_000_000n, mintTokens: 249_999_990_000n }),
      transferLog(market.target, market.target, ACCOUNT, 249_999_990_000n),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "249999990000");
  });

  it("fails a successful receipt that carries a Failure event instead of Mint (VENUE_REJECTED)", async () => {
    const { market, underlying } = mockMoonwell();
    setBalance(underlying, ACCOUNT, 100_000_000n);
    setAllowance(underlying, ACCOUNT, market.target, 100_000_000n);
    const graph = await createIntent({ text: "lend 50 USDC on moonwell", accounts: ACCOUNTS_BASE });
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      eventLog(market.target, mtoken, "Failure", { code: 3n, info: 37n, detail: 9n }),
    ]]));
    assert.equal(done.steps[0]?.status, "failed");
    assert.equal(done.steps[0]?.failure?.code, "VENUE_REJECTED");
    assert.match(done.steps[0]?.failure?.message ?? "", /COMPTROLLER_REJECTION/u);
  });

  it("refuses a mint whose simulation returns an error code", async () => {
    const { market, underlying } = mockMoonwell({ mintCode: 3n });
    setBalance(underlying, ACCOUNT, 100_000_000n);
    setAllowance(underlying, ACCOUNT, market.target, 100_000_000n);
    const graph = await createIntent({ text: "lend 50 USDC on moonwell", accounts: ACCOUNTS_BASE });
    await assert.rejects(prepareStep(graph.id, "s1"), (error: PlatformError) => error.code === "SIMULATION_FAILED" && /COMPTROLLER_REJECTION/u.test(error.message));
  });

  it("gates deposits on exit liquidity, pauses, caps and registry pins", async () => {
    mockMoonwell({ cash: 0n });
    const empty = await planError("lend 50 USDC on moonwell");
    assert.equal(empty.code, "VENUE_ILLIQUID");
    assert.match(empty.message, /could not be withdrawn until borrowers repay/u);
    mockMoonwell({ cash: 1_000_000n, borrows: 999_000_000n });
    assert.equal((await planError("lend 50 USDC on moonwell")).code, "VENUE_ILLIQUID", "over 99% utilised");
    mockMoonwell({ mintPaused: true });
    assert.equal((await planError("lend 50 USDC on moonwell")).code, "RESERVE_UNAVAILABLE");
    mockMoonwell({ supplyCap: 1n });
    assert.equal((await planError("lend 50 USDC on moonwell")).code, "RESERVE_UNAVAILABLE");
    mockMoonwell({ comptroller: "0x5555555555555555555555555555555555555555" });
    assert.equal((await planError("lend 50 USDC on moonwell")).code, "VENUE_UNVERIFIED");
    mockMoonwell({ listed: false });
    assert.equal((await planError("lend 50 USDC on moonwell")).code, "VENUE_UNVERIFIED");
  });

  it("supplies native ETH through the pinned WETH router and proves the routed Mint", async () => {
    const { market } = mockMoonwell({ asset: "WETH" });
    const router = market.nativeRouter as string;
    chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 18n);
    const graph = await createIntent({ text: "deposit 0.1 ETH into moonwell on base", accounts: ACCOUNTS_BASE });
    assert.equal(graph.steps[0]?.venue, "base:moonwell:weth");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1, "one payable call, no approval");
    assert.equal(transactions[0]?.to, router);
    assert.equal(transactions[0]?.value, "100000000000000000");
    assert.deepEqual(decode(ROUTER_ABI as unknown as Abi, transactions[0]).args, [ACCOUNT]);
    const tokens = 499_900_000n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      eventLog(market.target, mtoken, "Mint", { minter: router, mintAmount: 10n ** 17n, mintTokens: tokens }),
      transferLog(market.target, market.target, router, tokens),
      transferLog(market.target, router, ACCOUNT, tokens),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, tokens.toString());
    mockMoonwell({ asset: "WETH", routerWeth: "0x6666666666666666666666666666666666666666" });
    assert.equal((await planError("deposit 0.1 ETH into moonwell on base")).code, "VENUE_UNVERIFIED");
  });
});

describe("Moonwell withdraw", () => {
  it("redeems every mToken with redeem(MAX) and requires the Redeem event", async () => {
    const { market, token } = mockMoonwell({ tokens: 500_000_000_000n });
    const graph = await createIntent({ text: "withdraw all USDC from moonwell on base", accounts: ACCOUNTS_BASE });
    assert.equal(graph.steps[0]?.input?.amount, "100000000");
    const transactions = await prepared(graph);
    const redeem = decode(mtoken, transactions[0]);
    assert.equal(redeem.functionName, "redeem");
    assert.deepEqual(redeem.args, [MAX]);
    const missing = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      eventLog(market.target, mtoken, "Failure", { code: 14n, info: 46n, detail: 0n }),
    ]]));
    assert.equal(missing.steps[0]?.failure?.code, "VENUE_REJECTED");
    assert.match(missing.steps[0]?.failure?.message ?? "", /TOKEN_INSUFFICIENT_CASH/u);

    const again = await createIntent({ text: "withdraw all USDC from moonwell on base", accounts: ACCOUNTS_BASE });
    const retry = await prepared(again);
    const done = await submitStep(again.id, "s1", landPrepared(chain, retry, [[
      transferLog(market.target, ACCOUNT, market.target, 500_000_000_000n),
      eventLog(market.target, mtoken, "Redeem", { redeemer: ACCOUNT, redeemAmount: 100_000_010n, redeemTokens: 500_000_000_000n }),
      transferLog(token, market.target, ACCOUNT, 100_000_010n),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "100000010");
  });

  it("uses redeemUnderlying for an exact amount and refuses missing cash or an error-code simulation", async () => {
    mockMoonwell({ tokens: 500_000_000_000n });
    const graph = await createIntent({ text: "withdraw 40 USDC from moonwell on base", accounts: ACCOUNTS_BASE });
    const call = decode(mtoken, (await prepared(graph))[0]);
    assert.equal(call.functionName, "redeemUnderlying");
    assert.deepEqual(call.args, [40_000_000n]);
    mockMoonwell({ tokens: 500_000_000_000n, cash: 1_000_000n });
    assert.equal((await planError("withdraw 40 USDC from moonwell on base")).code, "VENUE_ILLIQUID");
    mockMoonwell({ tokens: 500_000_000_000n, redeemCode: 14n });
    const rejected = await planError("withdraw 40 USDC from moonwell on base");
    assert.equal(rejected.code, "SIMULATION_FAILED");
    assert.match(rejected.message, /TOKEN_INSUFFICIENT_CASH/u);
  });
});

describe("Moonwell native ETH payout", () => {
  const UNWRAPPER = "0x1382cFf3CeE10D283DccA55A30496187759e4cAf";

  it("plans a WETH market's withdrawal as native ETH (MWethDelegate unwraps) and proves the unwrapper leg", async () => {
    const { market, token } = mockMoonwell({ asset: "WETH", tokens: 1_000_000_000n, unwrapper: UNWRAPPER });
    const graph = await createIntent({ text: "withdraw all WETH from moonwell on base", accounts: ACCOUNTS_BASE });
    const step = graph.steps[0];
    assert.equal(step?.minimumOutput?.symbol, "ETH", "the market pays native ETH, not WETH");
    assert.match(step?.warnings?.join(" ") ?? "", /pays withdrawals in native ETH/u);
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1, "no unwrap transaction: the market unwraps itself");
    const paid = 200_000_000_000_000_000n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(market.target, ACCOUNT, market.target, 1_000_000_000n),
      eventLog(market.target, mtoken, "Redeem", { redeemer: ACCOUNT, redeemAmount: paid, redeemTokens: 1_000_000_000n }),
      transferLog(token, market.target, UNWRAPPER, paid),
      eventLog(token, WETH_ABI as unknown as Abi, "Withdrawal", { src: UNWRAPPER, wad: paid }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.symbol, "ETH");
    assert.equal(done.steps[0]?.actualOutput?.amount, paid.toString());
  });

  it("fails a native payout the unwrapper did not unwrap, and refuses an unwrapper of another WETH", async () => {
    const { market, token } = mockMoonwell({ asset: "WETH", tokens: 1_000_000_000n, unwrapper: UNWRAPPER });
    const graph = await createIntent({ text: "withdraw all ETH from moonwell on base", accounts: ACCOUNTS_BASE });
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1);
    const paid = 200_000_000_000_000_000n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(market.target, ACCOUNT, market.target, 1_000_000_000n),
      eventLog(market.target, mtoken, "Redeem", { redeemer: ACCOUNT, redeemAmount: paid, redeemTokens: 1_000_000_000n }),
      transferLog(token, market.target, UNWRAPPER, paid),
    ]]));
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    mockMoonwell({ asset: "WETH", tokens: 1_000_000_000n, unwrapper: UNWRAPPER });
    chain.contract(UNWRAPPER, PAYOUT_ABI as unknown as Abi, { weth: () => "0x7777777777777777777777777777777777777777" });
    assert.equal((await planError("withdraw all ETH from moonwell on base")).code, "VENUE_UNVERIFIED");
  });

  it("requires the market to report exactly the registry's pinned unwrapper", async () => {
    const { market } = mockMoonwell({ asset: "WETH", tokens: 1_000_000_000n, unwrapper: UNWRAPPER });
    assert.equal(market.nativePayout, UNWRAPPER, "Base mWETH pins its WethUnwrapper");
    const swapped = "0x8888888888888888888888888888888888888888";
    mockMoonwell({ asset: "WETH", tokens: 1_000_000_000n, unwrapper: swapped });
    const moved = await planError("withdraw all ETH from moonwell on base");
    assert.equal(moved.code, "VENUE_UNVERIFIED");
    assert.match(moved.message, /wethUnwrapper\(\)/u);
    mockMoonwell({ asset: "WETH", tokens: 1_000_000_000n });
    const gone = await planError("withdraw all ETH from moonwell on base");
    assert.equal(gone.code, "VENUE_UNVERIFIED", "a pinned native-payout market that stops reporting its unwrapper is refused");
  });
});

describe("lending metrics read path", () => {
  it("lists rates, TVL and exit liquidity per venue and reports venues it cannot read", async () => {
    mockMoonwell({ cash: 0n });
    const listing = await listLendingMetrics({ network: "base", protocol: "moonwell" });
    const usdc = listing.venues.find((entry) => entry.venue === "base:moonwell:usdc");
    assert.ok(usdc, JSON.stringify(listing.unavailable));
    assert.ok(usdc.supplyApy !== null && usdc.supplyApy > 0.05 && usdc.supplyApy < 0.06, String(usdc.supplyApy));
    assert.equal(usdc.exitLiquidity?.amount, "0");
    assert.equal(usdc.totalSupplied?.amount, "1000000000000");
    assert.match(usdc.warnings.join(" "), /No exit liquidity/u);
    assert.deepEqual(listing.unavailable.map((entry) => entry.venue), ["base:moonwell:weth"], "the WETH market has no mock state: reported, not thrown");
  });
});
