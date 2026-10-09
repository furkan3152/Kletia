/**
 * Aave V3 adapter against in-process contract state: supply with an exact
 * approval (and native ETH wrapped first), withdraw exact / all (MAX) with a
 * simulation, frozen reserves allowed for withdraw only, registry pins
 * enforced, and outcomes proven from the Pool Supply / Withdraw events.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import type { AaveReserveVenue, EvmTransactionRequest, IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter, DATA_PROVIDER_ABI, POOL_ABI } from "../adapters/aaveV3.js";
import { evmTransferAdapter } from "../adapters/evmTransfer.js";
import { WETH_ABI } from "../adapters/lending/common.js";
import { compoundV3Adapter } from "../adapters/lending/compoundV3.js";
import { erc4626Adapter } from "../adapters/lending/erc4626.js";
import { moonwellAdapter } from "../adapters/lending/moonwell.js";
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
  resolveAsset,
  revertWith,
  setAllowance,
  setBalance,
  tokenAddress,
  transferLog,
  venue,
  type LendingChain,
  type TokenState,
} from "./lendingChain.js";

const RAY = 10n ** 27n;
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [aaveV3Adapter, compoundV3Adapter, erc4626Adapter, moonwellAdapter] });
});
afterEach(() => chain.restore());

interface AaveOptions {
  asset?: "USDC" | "WETH";
  active?: boolean;
  frozen?: boolean;
  paused?: boolean;
  position?: bigint;
  liquidity?: bigint;
  debt?: bigint;
  supplyCap?: bigint;
  /** aToken the data provider reports (defaults to the registry pin). */
  reportedAToken?: string;
  withdraw?: (args: readonly unknown[]) => unknown;
}

interface AaveMarket {
  readonly reserve: AaveReserveVenue;
  readonly underlying: TokenState;
  readonly aToken: TokenState;
  readonly token: string;
}

function mockAave(options: AaveOptions = {}): AaveMarket {
  const symbol = options.asset ?? "USDC";
  const reserve = venue<AaveReserveVenue>(`base:aave-v3:${symbol.toLowerCase()}`);
  const decimals = symbol === "USDC" ? 6 : 18;
  const token = tokenAddress("base", symbol);
  const underlying = mockToken(chain, token, { symbol, decimals });
  const aToken = mockToken(chain, reserve.receipt.address, { symbol: `aBas${symbol}`, decimals, totalSupply: 10n ** BigInt(decimals + 6) });
  setBalance(aToken, ACCOUNT, options.position ?? 0n);
  chain.contract(reserve.dataProvider, DATA_PROVIDER_ABI as unknown as Abi, {
    getReserveTokensAddresses: () => [options.reportedAToken ?? reserve.receipt.address, zeroAddress, zeroAddress],
    getReserveConfigurationData: () => [BigInt(decimals), 7500n, 7800n, 10500n, 1000n, true, true, false, options.active ?? true, options.frozen ?? false],
    getPaused: () => options.paused ?? false,
    getReserveCaps: () => [0n, options.supplyCap ?? 0n],
  });
  chain.contract(reserve.target, POOL_ABI as unknown as Abi, {
    getReserveData: () => ({
      configuration: 0n,
      liquidityIndex: RAY,
      currentLiquidityRate: (45n * RAY) / 1000n,
      variableBorrowIndex: RAY,
      currentVariableBorrowRate: 0n,
      currentStableBorrowRate: 0n,
      lastUpdateTimestamp: 1,
      id: 1,
      aTokenAddress: reserve.receipt.address,
      stableDebtTokenAddress: zeroAddress,
      variableDebtTokenAddress: zeroAddress,
      interestRateStrategyAddress: zeroAddress,
      accruedToTreasury: 0n,
      unbacked: 0n,
      isolationModeTotalDebt: 0n,
    }),
    getVirtualUnderlyingBalance: () => options.liquidity ?? 10n ** BigInt(decimals + 9),
    getUserAccountData: () => [0n, options.debt ?? 0n, 0n, 0n, 0n, MAX],
    supply: () => undefined,
    withdraw: (args) => (options.withdraw ? options.withdraw(args) : args[1] === MAX ? (options.position ?? 0n) : args[1]),
  });
  return { reserve, underlying, aToken, token };
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

const call = (abi: Abi, transaction: EvmTransactionRequest | undefined) => decodeFunctionData({ abi, data: transaction?.data as Hex });

describe("Aave V3 supply", () => {
  it("approves exactly the amount, supplies on behalf of the account and proves the Supply event", async () => {
    const market = mockAave();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    setAllowance(market.underlying, ACCOUNT, market.reserve.spender, 1n);
    const graph = await createIntent({ text: "deposit 100 USDC into aave on base", accounts: ACCOUNTS_BASE });
    const step = graph.steps[0];
    assert.equal(step?.venue, "base:aave-v3:usdc");
    assert.equal(step?.minimumOutput?.symbol, "aBasUSDC");
    assert.equal(step?.minimumOutput?.amount, "99999998", "the aToken mint may round down by a wei or two");
    assert.match(step?.warnings?.join(" ") ?? "", /4\.6\d% APY at planning/u);
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2);
    const approve = call(erc20Abi as unknown as Abi, transactions[0]);
    assert.equal(transactions[0]?.to.toLowerCase(), market.token.toLowerCase());
    assert.deepEqual(approve.args, [market.reserve.spender, 100_000_000n], "exact approval of the pinned Pool");
    const supply = call(POOL_ABI as unknown as Abi, transactions[1]);
    assert.equal(supply.functionName, "supply");
    assert.deepEqual(supply.args, [market.token, 100_000_000n, ACCOUNT, 0]);
    assert.equal(transactions[1]?.to, market.reserve.target);

    const hashes = landPrepared(chain, transactions, [[], [
      transferLog(market.token, ACCOUNT, market.reserve.receipt.address, 100_000_000n),
      transferLog(market.reserve.receipt.address, zeroAddress, ACCOUNT, 99_999_999n),
      eventLog(market.reserve.target, POOL_ABI as unknown as Abi, "Supply", { reserve: market.token, user: ACCOUNT, onBehalfOf: ACCOUNT, amount: 100_000_000n, referralCode: 0 }),
    ]]);
    const done = await submitStep(graph.id, "s1", hashes);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "100000000");
    assert.match(done.steps[0]?.evidence.map((entry) => entry.detail).join(" ") ?? "", /Aave Pool Supply/u);
  });

  it("prepares and proves a supply step stored without a venue (planned before steps recorded one)", async () => {
    const store = new MemoryIntentStore();
    configurePlatform({ store, adapters: [aaveV3Adapter] });
    const market = mockAave();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    setAllowance(market.underlying, ACCOUNT, market.reserve.spender, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into aave on base", accounts: ACCOUNTS_BASE });
    const stored = await store.get(graph.id);
    assert.ok(stored?.steps[0]);
    const { venue: _venue, ...legacy } = stored.steps[0];
    await store.update(graph.id, { ...stored, steps: [legacy] }, stored.updatedAt);
    const transactions = await prepared(graph);
    assert.deepEqual(call(POOL_ABI as unknown as Abi, transactions.at(-1)).args, [market.token, 100_000_000n, ACCOUNT, 0]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(market.token, ACCOUNT, market.reserve.receipt.address, 100_000_000n),
      transferLog(market.reserve.receipt.address, zeroAddress, ACCOUNT, 99_999_999n),
      eventLog(market.reserve.target, POOL_ABI as unknown as Abi, "Supply", { reserve: market.token, user: ACCOUNT, onBehalfOf: ACCOUNT, amount: 100_000_000n, referralCode: 0 }),
    ]]));
    assert.equal(done.steps[0]?.venue, undefined);
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "100000000");
  });

  it("fails the step when the receipt succeeded without a matching Supply event or aToken mint", async () => {
    const market = mockAave();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    setAllowance(market.underlying, ACCOUNT, market.reserve.spender, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into aave on base", accounts: ACCOUNTS_BASE });
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1, "no approval when the allowance covers the amount");
    assert.ok(chain.calls.some((entry) => entry.direct && entry.functionName === "supply" && entry.from?.toLowerCase() === ACCOUNT.toLowerCase()), "an un-approved supply is simulated from the account");
    const noEvent = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[transferLog(market.token, ACCOUNT, market.reserve.receipt.address, 100_000_000n)]]));
    assert.equal(noEvent.steps[0]?.status, "failed");
    assert.equal(noEvent.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(noEvent.steps[0]?.failure?.message ?? "", /no Supply event/u);
  });

  it("wraps native ETH into the pinned WETH before supplying it", async () => {
    const market = mockAave({ asset: "WETH" });
    chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 18n);
    const graph = await createIntent({ text: "deposit 0.5 ETH into aave on base", accounts: ACCOUNTS_BASE });
    assert.equal(graph.steps[0]?.venue, "base:aave-v3:weth");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 3);
    assert.equal(call(WETH_ABI as unknown as Abi, transactions[0]).functionName, "deposit");
    assert.equal(transactions[0]?.value, "500000000000000000");
    assert.equal(transactions[0]?.to.toLowerCase(), market.token.toLowerCase());
    assert.deepEqual(call(erc20Abi as unknown as Abi, transactions[1]).args, [market.reserve.spender, 500_000_000_000_000_000n]);
    assert.equal(call(POOL_ABI as unknown as Abi, transactions[2]).functionName, "supply");
    const amount = 500_000_000_000_000_000n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [
      [eventLog(market.token, WETH_ABI as unknown as Abi, "Deposit", { dst: ACCOUNT, wad: amount })],
      [],
      [
        transferLog(market.token, ACCOUNT, market.reserve.receipt.address, amount),
        transferLog(market.reserve.receipt.address, zeroAddress, ACCOUNT, amount),
        eventLog(market.reserve.target, POOL_ABI as unknown as Abi, "Supply", { reserve: market.token, user: ACCOUNT, onBehalfOf: ACCOUNT, amount, referralCode: 0 }),
      ],
    ]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("refuses frozen, paused or capped reserves and registry mismatches", async () => {
    mockAave({ frozen: true });
    assert.equal((await planError("deposit 100 USDC into aave on base")).code, "RESERVE_UNAVAILABLE");
    mockAave({ supplyCap: 100n, position: 0n });
    assert.equal((await planError("deposit 100 USDC into aave on base")).code, "RESERVE_UNAVAILABLE");
    mockAave({ reportedAToken: "0x1111111111111111111111111111111111111111" });
    const unverified = await planError("deposit 100 USDC into aave on base");
    assert.equal(unverified.code, "VENUE_UNVERIFIED");
    assert.match(unverified.message, /not the pinned/u);
  });
});

describe("Aave V3 withdraw", () => {
  it("withdraws the whole position with MAX (frozen reserves allowed) and proves the Withdraw event", async () => {
    const market = mockAave({ frozen: true, position: 123_456_789n });
    const graph = await createIntent({ text: "withdraw all USDC from aave on base", accounts: ACCOUNTS_BASE });
    const step = graph.steps[0];
    assert.equal(step?.input?.amount, "123456789");
    assert.equal(step?.minimumOutput?.amount, "123456787");
    assert.equal(step?.minimumOutput?.symbol, "USDC");
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 1);
    assert.deepEqual(call(POOL_ABI as unknown as Abi, transactions[0]).args, [market.token, MAX, ACCOUNT]);
    assert.ok(chain.calls.some((entry) => entry.direct && entry.functionName === "withdraw" && entry.from?.toLowerCase() === ACCOUNT.toLowerCase()), "simulated from the account");
    const paid = 123_456_800n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(market.reserve.receipt.address, ACCOUNT, zeroAddress, 123_456_000n),
      transferLog(market.token, market.reserve.receipt.address, ACCOUNT, paid),
      eventLog(market.reserve.target, POOL_ABI as unknown as Abi, "Withdraw", { reserve: market.token, user: ACCOUNT, to: ACCOUNT, amount: paid }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, paid.toString(), "the observed Withdraw amount, not the aToken burn");
  });

  it("encodes an exact amount, and MAX when the amount is the whole position", async () => {
    const market = mockAave({ position: 50_000_000n });
    const exact = await createIntent({ text: "withdraw 20 USDC from aave on base", accounts: ACCOUNTS_BASE });
    assert.deepEqual(call(POOL_ABI as unknown as Abi, (await prepared(exact))[0]).args, [market.token, 20_000_000n, ACCOUNT]);
    const whole = await createIntent({ text: "withdraw 50 USDC from aave on base", accounts: ACCOUNTS_BASE });
    assert.deepEqual(call(POOL_ABI as unknown as Abi, (await prepared(whole))[0]).args, [market.token, MAX, ACCOUNT]);
  });

  it("refuses amounts above the position or the Pool's liquidity, paused reserves and reverting simulations", async () => {
    mockAave({ position: 10_000_000n });
    assert.equal((await planError("withdraw 20 USDC from aave on base")).code, "INSUFFICIENT_BALANCE");
    mockAave({ position: 0n });
    assert.equal((await planError("withdraw all USDC from aave on base")).code, "POSITION_EMPTY");
    mockAave({ position: 100_000_000n, liquidity: 5_000_000n });
    assert.equal((await planError("withdraw 20 USDC from aave on base")).code, "VENUE_ILLIQUID");
    mockAave({ position: 100_000_000n, paused: true });
    assert.equal((await planError("withdraw 20 USDC from aave on base")).code, "RESERVE_UNAVAILABLE");
    mockAave({ position: 100_000_000n, debt: 1n, withdraw: () => { throw revertWith(POOL_ABI as unknown as Abi, "HealthFactorLowerThanLiquidationThreshold"); } });
    const unhealthy = await planError("withdraw 20 USDC from aave on base");
    assert.equal(unhealthy.code, "SIMULATION_FAILED");
    assert.match(unhealthy.message, /HealthFactorLowerThanLiquidationThreshold/u);
  });

  it("fails a full withdrawal that paid less than the prepared floor or did not pay the account", async () => {
    const market = mockAave({ position: 123_456_789n });
    const graph = await createIntent({ text: "withdraw all USDC from aave on base", accounts: ACCOUNTS_BASE });
    const transactions = await prepared(graph);
    const short = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(market.token, market.reserve.receipt.address, ACCOUNT, 1_000_000n),
      eventLog(market.reserve.target, POOL_ABI as unknown as Abi, "Withdraw", { reserve: market.token, user: ACCOUNT, to: ACCOUNT, amount: 1_000_000n }),
    ]]));
    assert.equal(short.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(short.steps[0]?.failure?.message ?? "", /at least 123456787/u);
  });

  it("unwraps a native ETH withdrawal and reports the ETH received", async () => {
    const market = mockAave({ asset: "WETH", position: 2n * 10n ** 18n });
    const graph = await createIntent({ text: "withdraw 1 ETH from aave on base", accounts: ACCOUNTS_BASE });
    const transactions = await prepared(graph);
    assert.equal(transactions.length, 2);
    assert.deepEqual(call(WETH_ABI as unknown as Abi, transactions[1]).args, [10n ** 18n]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [
      [
        transferLog(market.token, market.reserve.receipt.address, ACCOUNT, 10n ** 18n),
        eventLog(market.reserve.target, POOL_ABI as unknown as Abi, "Withdraw", { reserve: market.token, user: ACCOUNT, to: ACCOUNT, amount: 10n ** 18n }),
      ],
      [eventLog(market.token, WETH_ABI as unknown as Abi, "Withdrawal", { src: ACCOUNT, wad: 10n ** 18n })],
    ]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.symbol, "ETH");
    assert.equal(done.steps[0]?.actualOutput?.amount, (10n ** 18n).toString());
  });
});

describe("Aave V3 withdraw all, then pay a third party", () => {
  const BOB = "0x2222222222222222222222222222222222222222";

  it("refuses a position that grew since planning and never pays the third party above the planned amount plus slippage", async () => {
    const store = new MemoryIntentStore();
    configurePlatform({ store, adapters: [aaveV3Adapter, evmTransferAdapter] });
    let position = 10_000_000n;
    const market = mockAave({ position, withdraw: (args) => (args[1] === MAX ? position : args[1]) });
    const graph = await createIntent({ text: `withdraw all USDC from aave on base then send it to ${BOB}`, accounts: ACCOUNTS_BASE });
    const planned = BigInt(graph.steps[1]?.input?.amount ?? "0");
    assert.equal(planned, 9_999_998n);
    // The account's own 10,000 USDC deposit lands between planning and execution.
    position = 10_010_000_000n;
    setBalance(market.aToken, ACCOUNT, position);
    await assert.rejects(prepareStep(graph.id, "s1"), (error: PlatformError) => error.code === "QUOTE_MOVED" && /withdraw all/u.test(error.message));
    // Interest-sized growth is still withdrawn in full.
    position = 10_000_500n;
    setBalance(market.aToken, ACCOUNT, position);
    const transactions = await prepared(graph);
    setBalance(market.underlying, ACCOUNT, 20_000_000_000n);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(market.token, market.reserve.receipt.address, ACCOUNT, position),
      eventLog(market.reserve.target, POOL_ABI as unknown as Abi, "Withdraw", { reserve: market.token, user: ACCOUNT, to: ACCOUNT, amount: position }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    // A funding output far above the plan pays Bob at most the planned amount plus the step's slippage.
    const stored = await store.get(graph.id);
    assert.ok(stored);
    const [withdraw, send] = stored.steps;
    assert.ok(withdraw?.actualOutput && send);
    await store.update(graph.id, { ...stored, steps: [{ ...withdraw, actualOutput: { ...withdraw.actualOutput, amount: "10010000000" } }, send] }, stored.updatedAt);
    const { payload } = await prepareStep(graph.id, "s2");
    const transfer = call(erc20Abi as unknown as Abi, payload.transactions[0] as EvmTransactionRequest);
    assert.equal(String(transfer.args?.[0]).toLowerCase(), BOB);
    assert.equal(transfer.args?.[1], (planned * 10_050n) / 10_000n);
  });
});

describe("Aave V3 registry", () => {
  it("serves the networks with pinned reserves, for their ERC-20s and native ETH only", async () => {
    const route = async (kind: "deposit" | "withdraw", network: "base" | "arbitrum" | "ethereum" | "optimism" | "polygon", symbol: string, destination = network) => {
      const asset = await resolveAsset(network, symbol);
      return aaveV3Adapter.supports({ kind, network, destinationNetwork: destination, input: asset, output: asset });
    };
    for (const network of ["base", "arbitrum", "ethereum", "optimism", "polygon"] as const) {
      assert.equal(await route("deposit", network, "USDC"), true, network);
      assert.equal(await route("withdraw", network, "WETH"), true, network);
    }
    assert.equal(await route("deposit", "ethereum", "ETH"), true, "native ETH is wrapped into the WETH reserve");
    assert.equal(await route("withdraw", "optimism", "ETH"), true, "and unwrapped after a withdrawal");
    assert.equal(await route("deposit", "polygon", "POL"), false, "POL has no WETH-style reserve");
    assert.equal(await route("deposit", "arbitrum", "ARB"), false, "unlisted reserve");
    assert.equal(await route("deposit", "base", "USDC", "arbitrum"), false, "same-network only");
  });

  it("refuses an action whose venue is not an Aave reserve of the step network (engine bug, 500)", async () => {
    mockAave();
    const usdc = await resolveAsset("base", "USDC");
    const account = { chain: { key: "base" }, address: ACCOUNT } as never;
    const action = { kind: "deposit", network: "base", destinationNetwork: "base", input: usdc, output: usdc, amount: "1000000", account, recipient: account, slippageBps: 50 } as const;
    for (const venueId of [undefined, "base:compound-v3:usdc", "arbitrum:aave-v3:usdc", "base:aave-v3:weth"]) {
      await assert.rejects(aaveV3Adapter.plan({ ...action, ...(venueId ? { venue: venueId } : {}) }), (error: PlatformError) => error.code === "VENUE_INVALID" && error.status === 500, String(venueId));
    }
  });
});
