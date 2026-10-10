/** Spark uses its own canonical pool and reserve pins, despite sharing Aave pool semantics. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import type { AaveReserveVenue, EvmTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { DATA_PROVIDER_ABI, POOL_ABI } from "../adapters/aaveV3.js";
import { WETH_ABI } from "../adapters/lending/common.js";
import { sparkAdapter, sparkMetrics } from "../adapters/lending/spark.js";
import { configurePlatform, createIntent, prepareStep, refreshIntent, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, eventLog, installLendingChain, landPrepared, MAX, mockToken, setAllowance, setBalance, tokenAddress, transferLog, venue, type LendingChain } from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const RAY = 10n ** 27n;
let chain: LendingChain;
beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [sparkAdapter] });
});
afterEach(() => chain.restore());

function mockSpark(options: { asset?: "USDC" | "WETH"; position?: bigint; frozen?: boolean; paused?: boolean; supplyCap?: bigint; reportedReceipt?: string } = {}) {
  const asset = options.asset ?? "USDC";
  const decimals = asset === "USDC" ? 6 : 18;
  const reserve = venue<AaveReserveVenue>(`ethereum:spark:${asset.toLowerCase()}`);
  const token = tokenAddress("ethereum", asset);
  const underlying = mockToken(chain, token, { symbol: asset, decimals });
  const receipt = mockToken(chain, reserve.receipt.address, { symbol: `sp${asset}`, decimals, totalSupply: 1_000_000n * 10n ** BigInt(decimals) });
  setBalance(receipt, ACCOUNT, options.position ?? 0n);
  chain.contract(reserve.dataProvider, DATA_PROVIDER_ABI as Abi, {
    getReserveTokensAddresses: () => [options.reportedReceipt ?? reserve.receipt.address, zeroAddress, zeroAddress],
    getReserveConfigurationData: () => [BigInt(decimals), 7500n, 7800n, 10500n, 1000n, true, true, false, true, options.frozen ?? false],
    getPaused: () => options.paused ?? false,
    getReserveCaps: () => [0n, options.supplyCap ?? 0n],
  });
  chain.contract(reserve.target, POOL_ABI as Abi, {
    getReserveData: () => ({ configuration: 0n, liquidityIndex: RAY, currentLiquidityRate: RAY / 20n,
      variableBorrowIndex: RAY, currentVariableBorrowRate: 0n, currentStableBorrowRate: 0n,
      lastUpdateTimestamp: 1, id: 1, aTokenAddress: reserve.receipt.address,
      stableDebtTokenAddress: zeroAddress, variableDebtTokenAddress: zeroAddress, interestRateStrategyAddress: zeroAddress,
      accruedToTreasury: 0n, unbacked: 0n, isolationModeTotalDebt: 0n }),
    getVirtualUnderlyingBalance: () => 10_000_000n * 10n ** BigInt(decimals),
    getUserAccountData: () => [0n, 0n, 0n, 0n, 0n, MAX],
    supply: () => undefined,
    withdraw: ([, amount]) => amount === MAX ? options.position ?? 0n : amount,
  });
  return { reserve, token, underlying, receipt };
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

function supplyLogs(market: ReturnType<typeof mockSpark>, amount: bigint, recipient = ACCOUNT) {
  return [transferLog(market.token, ACCOUNT, market.reserve.receipt.address, amount),
    transferLog(market.reserve.receipt.address, zeroAddress, recipient, amount),
    eventLog(market.reserve.target, POOL_ABI as Abi, "Supply", { reserve: market.token, user: ACCOUNT, onBehalfOf: recipient, amount, referralCode: 0 })];
}

describe("SparkLend", () => {
  it("re-reads a revoked allowance at prepare, approves exactly the pinned pool and proves economic supply", async () => {
    const market = mockSpark();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    setAllowance(market.underlying, ACCOUNT, market.reserve.spender, 100_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into spark on ethereum", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "spark");
    assert.equal(graph.steps[0]?.venue, "ethereum:spark:usdc");
    assert.ok(chain.calls.some((entry) => entry.functionName === "allowance"), "the plan reads the existing allowance");
    setAllowance(market.underlying, ACCOUNT, market.reserve.spender, 1n);
    const txs = await prepare(graph.id);
    assert.equal(txs.length, 2);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: txs[0]?.data as Hex }).args, [market.reserve.spender, 100_000_000n]);
    assert.equal(txs[1]?.chainId, 1);
    assert.equal(txs[1]?.to, market.reserve.target);
    assert.deepEqual(decodeFunctionData({ abi: POOL_ABI, data: txs[1]?.data as Hex }).args, [market.token, 100_000_000n, ACCOUNT, 0]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], supplyLogs(market, 100_000_000n)]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.symbol, "spUSDC");
    assert.equal(done.steps[0]?.actualOutput?.amount, "100000000");
    assert.match(done.steps[0]?.evidence.map((e) => e.detail).join(" ") ?? "", /SparkLend Pool Supply/u);
  });

  it("revalidates stale reserve pins and freeze state before the payload leaves", async () => {
    const market = mockSpark();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into spark on ethereum", accounts: ACCOUNTS });
    const changed = mockSpark({ reportedReceipt: zeroAddress });
    setBalance(changed.underlying, ACCOUNT, 500_000_000n);
    await assert.rejects(prepare(graph.id), (error: unknown) => error instanceof PlatformError && error.code === "VENUE_UNVERIFIED");
    const frozen = mockSpark({ frozen: true });
    setBalance(frozen.underlying, ACCOUNT, 500_000_000n);
    await assert.rejects(prepare(graph.id), (error: unknown) => error instanceof PlatformError && error.code === "RESERVE_UNAVAILABLE");
  });

  it("fails closed on paused/capped reserves and a successful receipt paying another account", async () => {
    mockSpark({ paused: true });
    await assert.rejects(createIntent({ text: "deposit 100 USDC into spark on ethereum", accounts: ACCOUNTS }), (e: unknown) => e instanceof PlatformError && e.code === "RESERVE_UNAVAILABLE");
    mockSpark({ supplyCap: 100n });
    await assert.rejects(createIntent({ text: "deposit 100 USDC into spark on ethereum", accounts: ACCOUNTS }), (e: unknown) => e instanceof PlatformError && e.code === "RESERVE_UNAVAILABLE");
    const market = mockSpark();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into spark on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], supplyLogs(market, 100_000_000n, "0x2222222222222222222222222222222222222222")]));
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
  });

  it("wraps native ETH into Ethereum WETH and closes a frozen USDC reserve with MAX", async () => {
    const weth = mockSpark({ asset: "WETH" });
    chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 18n);
    const deposit = await createIntent({ text: "deposit 0.5 ETH into spark on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(deposit.id);
    assert.equal(txs.length, 3);
    assert.equal(txs[0]?.to.toLowerCase(), weth.token.toLowerCase());
    assert.equal(decodeFunctionData({ abi: WETH_ABI, data: txs[0]?.data as Hex }).functionName, "deposit");
    assert.equal(txs[0]?.value, "500000000000000000");
    const market = mockSpark({ position: 123_456_789n, frozen: true });
    const graph = await createIntent({ text: "withdraw all USDC from spark on ethereum", accounts: ACCOUNTS });
    const withdrawals = await prepare(graph.id);
    assert.deepEqual(decodeFunctionData({ abi: POOL_ABI, data: withdrawals[0]?.data as Hex }).args, [market.token, MAX, ACCOUNT]);
    const paid = 123_456_800n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, withdrawals, [[
      transferLog(market.token, market.reserve.receipt.address, ACCOUNT, paid),
      eventLog(market.reserve.target, POOL_ABI as Abi, "Withdraw", { reserve: market.token, user: ACCOUNT, to: ACCOUNT, amount: paid }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, paid.toString());
  });

  it("recovers the existing submitted reference when the receipt becomes visible", async () => {
    const market = mockSpark({ position: 100_000_000n });
    const graph = await createIntent({ text: "withdraw 20 USDC from spark on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    const hashes = landPrepared(chain, txs, [[transferLog(market.token, market.reserve.receipt.address, ACCOUNT, 20_000_000n),
      eventLog(market.reserve.target, POOL_ABI as Abi, "Withdraw", { reserve: market.token, user: ACCOUNT, to: ACCOUNT, amount: 20_000_000n })]]);
    const hash = hashes[0] as string;
    const landed = chain.rpc.evm.get(hash.toLowerCase());
    assert.ok(landed);
    chain.rpc.evm.delete(hash.toLowerCase());
    const pending = await submitStep(graph.id, "s1", hashes);
    assert.equal(pending.steps[0]?.status, "submitted");
    await assert.rejects(prepare(graph.id), (e: unknown) => e instanceof PlatformError && e.status === 409);
    chain.rpc.evm.set(hash.toLowerCase(), landed);
    const recovered = await refreshIntent(graph.id);
    assert.equal(recovered.steps[0]?.status, "settled", JSON.stringify(recovered.steps[0]?.failure));
    assert.equal(recovered.steps[0]?.actualOutput?.amount, "20000000");
    assert.equal(chain.rpc.evm.size, 1, "recovery uses the same transaction; it does not broadcast a retry");
  });

  it("publishes Spark metrics under the correct protocol identity", async () => {
    const { reserve } = mockSpark();
    const metrics = await sparkMetrics(reserve);
    assert.equal(metrics.protocol, "spark");
    assert.equal(metrics.network, "ethereum");
    assert.ok(metrics.supplyApy !== null && metrics.supplyApy > 0.05);
  });
});
