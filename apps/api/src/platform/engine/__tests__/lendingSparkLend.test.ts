/**
 * SparkLend through the Aave-family adapter: its own protocol id and labels,
 * the pinned PoolAddressesProvider, the aToken-cash exit liquidity (the
 * revision-4 Pool has no getVirtualUnderlyingBalance), Supply / Withdraw
 * proofs bound to the SparkLend Pool, and the journey facts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, type AaveReserveVenue, type EvmTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter, ADDRESSES_PROVIDER_ABI, DATA_PROVIDER_ABI, POOL_ABI } from "../adapters/aaveV3.js";
import { sparklendAdapter, sparklendMetrics } from "../adapters/lending/sparklend.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, eventLog, installLendingChain, landPrepared, MAX, mockToken, Revert, setBalance, tokenAddress, transferLog, venue, type LendingChain } from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const RAY = 10n ** 27n;
const PROVIDER = "0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE";
const sparklend = sparklendAdapter as ProtocolAdapter;
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [aaveV3Adapter, sparklend] });
});
afterEach(() => chain.restore());

interface SparkOptions {
  asset?: "USDC" | "WETH";
  position?: bigint;
  /** Underlying cash the spToken holds (exit liquidity on revision 4). */
  cash?: bigint;
  providerPool?: string;
  supplyCap?: bigint;
  paused?: boolean;
}

function mockSparkLend(options: SparkOptions = {}) {
  const asset = options.asset ?? "USDC";
  const decimals = asset === "USDC" ? 6 : 18;
  const reserve = venue<AaveReserveVenue>(`ethereum:sparklend:${asset.toLowerCase()}`);
  const token = tokenAddress("ethereum", asset);
  const underlying = mockToken(chain, token, { symbol: asset, decimals });
  const receipt = mockToken(chain, reserve.receipt.address, { symbol: `sp${asset}`, decimals, totalSupply: 1_000_000n * 10n ** BigInt(decimals) });
  setBalance(receipt, ACCOUNT, options.position ?? 0n);
  setBalance(underlying, reserve.receipt.address, options.cash ?? 10_000_000n * 10n ** BigInt(decimals));
  chain.contract(PROVIDER, ADDRESSES_PROVIDER_ABI as Abi, {
    getPool: () => options.providerPool ?? reserve.target,
    getPoolDataProvider: () => reserve.dataProvider,
  });
  chain.contract(reserve.dataProvider, DATA_PROVIDER_ABI as Abi, {
    getReserveTokensAddresses: () => [reserve.receipt.address, zeroAddress, zeroAddress],
    getReserveConfigurationData: () => [BigInt(decimals), 7500n, 7800n, 10500n, 1000n, true, true, false, true, false],
    getPaused: () => options.paused ?? false,
    getReserveCaps: () => [0n, options.supplyCap ?? 0n],
  });
  chain.contract(reserve.target, POOL_ABI as Abi, {
    getReserveData: () => ({
      configuration: 0n, liquidityIndex: RAY, currentLiquidityRate: RAY / 25n, variableBorrowIndex: RAY, currentVariableBorrowRate: 0n,
      currentStableBorrowRate: 0n, lastUpdateTimestamp: 1, id: 1, aTokenAddress: reserve.receipt.address, stableDebtTokenAddress: zeroAddress,
      variableDebtTokenAddress: zeroAddress, interestRateStrategyAddress: zeroAddress, accruedToTreasury: 0n, unbacked: 0n, isolationModeTotalDebt: 0n,
    }),
    // Revision 4 has no virtual balance: the read reverts and the adapter falls back to the aToken's cash.
    getVirtualUnderlyingBalance: () => {
      throw new Revert();
    },
    getUserAccountData: () => [0n, 0n, 0n, 0n, 0n, MAX],
    supply: () => undefined,
    withdraw: ([, amount]) => (amount === MAX ? options.position ?? 0n : amount),
  });
  return { reserve, token, underlying, receipt };
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

function refused(code: string) {
  return (error: unknown) => error instanceof PlatformError && error.code === code;
}

describe("SparkLend (Aave family)", () => {
  it("plans under protocol sparklend, approves the SparkLend Pool and proves the supply from its Supply event", async () => {
    const market = mockSparkLend();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into sparklend on ethereum", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "sparklend");
    assert.equal(step?.venue, "ethereum:sparklend:usdc");
    assert.equal(step?.title, "Supply 100 USDC to SparkLend on Ethereum");
    assert.ok(chain.calls.some((call) => call.to === PROVIDER.toLowerCase() && call.functionName === "getPool"), "the addresses provider is read");
    const txs = await prepare(graph.id);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: txs[0]?.data as Hex }).args, [market.reserve.spender, 100_000_000n]);
    assert.equal(txs[1]?.to, market.reserve.target);
    const supply = [
      transferLog(market.token, ACCOUNT, market.reserve.receipt.address, 100_000_000n),
      transferLog(market.reserve.receipt.address, zeroAddress, ACCOUNT, 100_000_000n),
      eventLog(market.reserve.target, POOL_ABI as Abi, "Supply", { reserve: market.token, user: ACCOUNT, onBehalfOf: ACCOUNT, amount: 100_000_000n, referralCode: 0 }),
    ];
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], supply]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.match(done.steps[0]?.evidence.map((entry) => entry.detail).join(" ") ?? "", /SparkLend Pool Supply/u);
  });

  it("fails the proof when the Supply event comes from another pool (the Aave Pool)", async () => {
    const market = mockSparkLend();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const aavePool = venue<AaveReserveVenue>("ethereum:aave-v3:usdc").target;
    const graph = await createIntent({ text: "deposit 100 USDC into sparklend on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], [
      transferLog(market.token, ACCOUNT, market.reserve.receipt.address, 100_000_000n),
      transferLog(market.reserve.receipt.address, zeroAddress, ACCOUNT, 100_000_000n),
      eventLog(aavePool, POOL_ABI as Abi, "Supply", { reserve: market.token, user: ACCOUNT, onBehalfOf: ACCOUNT, amount: 100_000_000n, referralCode: 0 }),
    ]]));
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
  });

  it("refuses a provider that reports another Pool (VENUE_UNVERIFIED)", async () => {
    const market = mockSparkLend({ providerPool: "0x1111111111111111111111111111111111111111" });
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    await assert.rejects(createIntent({ text: "deposit 100 USDC into sparklend on ethereum", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
  });

  it("falls back to the aToken's cash for exit liquidity and refuses a withdrawal above it", async () => {
    mockSparkLend({ position: 500_000_000n, cash: 40_000_000n });
    const error = await createIntent({ text: "withdraw 100 USDC from sparklend on ethereum", accounts: ACCOUNTS }).catch((caught: unknown) => caught);
    assert.ok(error instanceof PlatformError && error.code === "VENUE_ILLIQUID", String(error));
    assert.match(error.message, /SparkLend USDC on Ethereum can pay out 40 USDC/u);
    const exact = await createIntent({ text: "withdraw 30 USDC from sparklend on ethereum", accounts: ACCOUNTS });
    assert.equal(exact.steps[0]?.title, "Withdraw 30 USDC from SparkLend on Ethereum");
    const txs = await prepare(exact.id);
    assert.equal(txs[0]?.data.slice(0, 10), "0x69328dec", "Pool.withdraw(address,uint256,address)");
  });

  it("never runs a SparkLend venue under Aave V3: the Aave adapter refuses it and an Aave-planned step is PLAN_INVALID", async () => {
    mockSparkLend();
    const action = {
      kind: "deposit" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const,
      input: (await import("../assets.js")).resolveAsset("ethereum", "USDC"),
    };
    const input = await action.input;
    assert.equal(aaveV3Adapter.supports({ ...action, input, output: input }), true, "Aave V3 has its own Ethereum USDC reserve");
    await assert.rejects(aaveV3Adapter.plan({
      ...action, input, output: input, amount: "1000000", slippageBps: 50, venue: "ethereum:sparklend:usdc",
      account: parseAccountId(ACCOUNTS[0])!, recipient: parseAccountId(ACCOUNTS[0])!,
    }), refused("VENUE_INVALID"));
    // An adapter that serves SparkLend routes but reports another protocol is caught by the planner.
    const impostor: ProtocolAdapter = { ...sparklend, async plan(planned) { return { ...(await sparklend.plan(planned)), protocol: "aave-v3" }; } };
    configurePlatform({ store: new MemoryIntentStore(), adapters: [impostor] });
    await assert.rejects(createIntent({ text: "deposit 1 USDC into sparklend on ethereum", accounts: ACCOUNTS }), refused("PLAN_INVALID"));
  });

  it("reports the position, the capacity and metrics under SparkLend", async () => {
    const { reserve } = mockSparkLend({ position: 250_000_000n, cash: 100_000_000n, supplyCap: 2_000_000n });
    const owner = parseAccountId(ACCOUNTS[0])!;
    const position = await sparklend.positionOf?.(reserve, owner);
    assert.equal(position?.protocol, "sparklend");
    assert.equal(position?.receipt.symbol, "spUSDC");
    assert.equal(position?.underlying.amount, "250000000");
    assert.equal(position?.withdrawableNow?.amount, "100000000", "bounded by the aToken's cash");
    assert.equal(position?.rate, null);
    const capacity = await sparklend.venueCapacity?.(reserve);
    assert.equal(capacity?.exitLiquidity, "100000000");
    assert.equal(capacity?.capRemaining, (2_000_000n * 10n ** 6n - 1_000_000n * 10n ** 6n).toString());
    assert.equal(capacity?.paused, false);
    await assert.rejects(aaveV3Adapter.positionOf!(reserve, owner), refused("VENUE_INVALID"));
    const metrics = await sparklendMetrics(reserve);
    assert.equal(metrics.protocol, "sparklend");
    assert.equal(metrics.exitLiquidity?.amount, "100000000");
    mockSparkLend();
    assert.equal(await sparklend.positionOf?.(reserve, owner), null, "no aToken balance, no position");
  });
});
