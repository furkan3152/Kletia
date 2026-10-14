/**
 * Spark Savings vaults (sUSDC "susdc-v1" and the Spark Vaults V2 spUSDC /
 * spETH) through the ERC-4626 vault engine: implementation-slot, psm() and
 * admin provenance, deposit caps via maxDeposit, V2 idle-balance exits (whose
 * previews revert on short liquidity), PSM-pocket payouts in proofs, the
 * Ethereum default venue and the journey facts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, type EvmTransactionRequest, type SparkVaultVenue } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { erc4626Adapter, VAULT_ABI } from "../adapters/lending/erc4626.js";
import { SPARK_VAULT_ABI, sparkSavingsAdapter, sparkSavingsMetrics } from "../adapters/lending/sparkSavings.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import {
  ACCOUNT,
  eventLog,
  installLendingChain,
  landPrepared,
  MAX,
  mockToken,
  Revert,
  setBalance,
  setImplementation,
  tokenAddress,
  transferLog,
  venue,
  type LendingChain,
} from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const OWNER = parseAccountId(ACCOUNTS[0])!;
const spark = sparkSavingsAdapter as ProtocolAdapter;
const SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";
/** LitePSM pocket that pays sUSDC withdrawals on Ethereum (not the vault). */
const POCKET = "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341";
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [erc4626Adapter, spark] });
});
afterEach(() => chain.restore());

interface SparkOptions {
  slug?: "usdc" | "spusdc" | "speth";
  implementation?: string;
  psm?: string;
  admin?: string;
  maxDeposit?: bigint;
  maxWithdraw?: bigint;
  /** Shares the account holds. */
  shares?: bigint;
  /** Idle underlying the V2 vault holds. */
  idle?: bigint;
}

/** 1 share = 1.1 underlying (sUSDC: 18-decimal shares over 6-decimal USDC). */
function mockSpark(options: SparkOptions = {}) {
  const vault = venue<SparkVaultVenue>(`ethereum:spark-savings:${options.slug ?? "usdc"}`);
  const symbol = vault.asset;
  const decimals = symbol === "USDC" ? 6 : 18;
  const token = tokenAddress("ethereum", symbol);
  const underlying = mockToken(chain, token, { symbol, decimals });
  const scale = 10n ** BigInt(vault.receipt.decimals - decimals);
  const toAssets = (shares: bigint) => (shares * 11n) / (10n * scale);
  const toShares = (assets: bigint) => (assets * 10n * scale) / 11n;
  const v2 = vault.generation === "spark-vault-v2";
  setBalance(underlying, vault.target, options.idle ?? 1_000_000n * 10n ** BigInt(decimals));
  setImplementation(chain, vault.target, options.implementation ?? vault.implementation);
  const shares = options.shares ?? 0n;
  chain.contract(vault.target, [...SPARK_VAULT_ABI, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as Abi, {
    asset: () => token,
    decimals: () => vault.receipt.decimals,
    symbol: () => (v2 ? `sp${symbol}` : "sUSDC"),
    psm: () => options.psm ?? vault.psm,
    susds: () => SUSDS,
    vsr: () => 1_000_000_001_182_641_576_793_209_935n,
    getRoleMember: () => options.admin ?? vault.admin ?? zeroAddress,
    totalAssets: () => 173_000_000n * 10n ** BigInt(decimals),
    balanceOf: () => shares,
    convertToAssets: ([amount]) => toAssets(amount),
    previewDeposit: ([assets]) => toShares(assets),
    previewRedeem: ([amount]) => {
      // V2 previews revert when idle cash is short; the adapter must not depend on them.
      if (v2) throw new Revert();
      return toAssets(amount);
    },
    maxDeposit: () => options.maxDeposit ?? MAX,
    maxWithdraw: () => options.maxWithdraw ?? toAssets(shares),
    deposit: ([assets]) => toShares(assets),
    withdraw: ([assets]) => toShares(assets) + 1n,
    redeem: ([amount]) => toAssets(amount),
  });
  chain.contract(SUSDS, SPARK_VAULT_ABI as Abi, { ssr: () => 1_000_000_001_182_641_576_793_209_935n });
  return { vault, token, underlying, toAssets, toShares };
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

function refused(code: string) {
  return (error: unknown) => error instanceof PlatformError && error.code === code;
}

const deposit = (amount: string, venueRef?: string) => ({
  actions: [{ kind: "deposit", network: "ethereum", from: "USDC", amount, protocol: "spark-savings", ...(venueRef ? { params: { venue: venueRef } } : {}) }],
  accounts: ACCOUNTS,
});

describe("Spark Savings sUSDC", () => {
  it("is Ethereum's default USDC savings venue, titled without a repeated protocol name, and proves the deposit", async () => {
    const market = mockSpark();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into spark savings on ethereum", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "spark-savings");
    assert.equal(step?.venue, "ethereum:spark-savings:usdc");
    assert.equal(step?.title, "Deposit 100 USDC into Spark Savings USDC (sUSDC) on Ethereum");
    assert.match(step?.warnings?.join(" ") ?? "", /about 3\.80% APY at planning \(the current on-chain supply rate\)/u);
    const txs = await prepare(graph.id);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: txs[0]?.data as Hex }).args, [market.vault.target, 100_000_000n]);
    assert.deepEqual(decodeFunctionData({ abi: VAULT_ABI, data: txs[1]?.data as Hex }).args, [100_000_000n, ACCOUNT]);
    const shares = market.toShares(100_000_000n);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], [
      transferLog(market.token, ACCOUNT, market.vault.target, 100_000_000n),
      transferLog(market.vault.target, zeroAddress, ACCOUNT, shares),
      eventLog(market.vault.target, VAULT_ABI as Abi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 100_000_000n, shares }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, shares.toString());
  });

  it("refuses an upgraded implementation, another PSM and a deposit above maxDeposit", async () => {
    mockSpark({ implementation: "0x1111111111111111111111111111111111111111" });
    await assert.rejects(createIntent(deposit("100")), refused("VENUE_UNVERIFIED"));
    mockSpark({ psm: "0x2222222222222222222222222222222222222222" });
    await assert.rejects(createIntent(deposit("100")), refused("VENUE_UNVERIFIED"));
    mockSpark({ maxDeposit: 50_000_000n });
    const capped = await createIntent(deposit("100")).catch((error: unknown) => error);
    assert.ok(capped instanceof PlatformError && capped.code === "RESERVE_UNAVAILABLE");
    assert.match(capped.message, /accepts at most 50 USDC more/u);
  });

  it("bounds exits by maxWithdraw and accepts the payout from the PSM pocket", async () => {
    const shares = 200n * 10n ** 18n;
    mockSpark({ shares, maxWithdraw: 30_000_000n });
    await assert.rejects(createIntent({ text: "withdraw 100 USDC from spark savings on ethereum", accounts: ACCOUNTS }), refused("VENUE_ILLIQUID"));
    const market = mockSpark({ shares });
    const graph = await createIntent({ text: "withdraw 100 USDC from spark savings on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    assert.deepEqual(decodeFunctionData({ abi: VAULT_ABI, data: txs[0]?.data as Hex }).args, [100_000_000n, ACCOUNT, ACCOUNT]);
    const burned = market.toShares(100_000_000n) + 1n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[
      transferLog(market.vault.target, ACCOUNT, zeroAddress, burned),
      transferLog(market.token, POCKET, ACCOUNT, 100_000_000n),
      eventLog(market.vault.target, VAULT_ABI as Abi, "Withdraw", { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT, assets: 100_000_000n, shares: burned }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });
});

describe("Spark Vaults V2 (spUSDC, spETH)", () => {
  it("reaches spUSDC and spETH by slug and checks the admin role", async () => {
    const market = mockSpark({ slug: "spusdc" });
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent(deposit("100", "spusdc"));
    assert.equal(graph.steps[0]?.venue, "ethereum:spark-savings:spusdc");
    assert.equal(graph.steps[0]?.title, "Deposit 100 USDC into Spark Savings USDC (spUSDC) on Ethereum");
    const eth = mockSpark({ slug: "speth" });
    setBalance(eth.underlying, ACCOUNT, 10n ** 18n);
    const speth = await createIntent({ actions: [{ kind: "deposit", network: "ethereum", from: "WETH", amount: "1", protocol: "spark-savings", params: { venue: "speth" } }], accounts: ACCOUNTS });
    assert.equal(speth.steps[0]?.venue, "ethereum:spark-savings:speth");
    mockSpark({ slug: "spusdc", admin: "0x3333333333333333333333333333333333333333" });
    await assert.rejects(createIntent(deposit("100", "spusdc")), refused("VENUE_UNVERIFIED"));
  });

  it("values the position with convertToAssets (previews revert) and refuses an exit above the idle balance", async () => {
    const shares = 500_000_000n;
    mockSpark({ slug: "spusdc", shares, idle: 40_000_000n });
    const withdraw = { actions: [{ kind: "withdraw", network: "ethereum", from: "USDC", amount: "100", protocol: "spark-savings", params: { venue: "spusdc" } }], accounts: ACCOUNTS };
    const error = await createIntent(withdraw).catch((caught: unknown) => caught);
    assert.ok(error instanceof PlatformError && error.code === "VENUE_ILLIQUID", String(error));
    assert.match(error.message, /can pay out 40 USDC/u);
    mockSpark({ slug: "spusdc", shares });
    const all = await createIntent({ actions: [{ kind: "withdraw", network: "ethereum", from: "USDC", amount: "max", protocol: "spark-savings", params: { venue: "spusdc" } }], accounts: ACCOUNTS });
    assert.equal(all.steps[0]?.input?.amount, "550000000", "500 shares at 1.1 USDC");
    const txs = await prepare(all.id);
    const call = decodeFunctionData({ abi: VAULT_ABI, data: txs[0]?.data as Hex });
    assert.equal(call.functionName, "redeem");
    assert.deepEqual(call.args, [shares, ACCOUNT, ACCOUNT]);
  });

  it("reports positions, capacity and metrics from the idle balance and the vault rate", async () => {
    const market = mockSpark({ slug: "spusdc", shares: 500_000_000n, idle: 300_000_000n });
    const position = await spark.positionOf?.(market.vault, OWNER);
    assert.equal(position?.protocol, "spark-savings");
    assert.equal(position?.underlying.amount, "550000000");
    assert.equal(position?.withdrawableNow?.amount, "300000000");
    assert.equal(position?.rate, (11n * 10n ** 17n).toString(), "1.1 USDC per share, 18-decimal fixed point");
    assert.ok((position?.apy ?? 0) > 0.03);
    const capacity = await spark.venueCapacity?.(market.vault);
    assert.equal(capacity?.exitLiquidity, "300000000");
    assert.equal(capacity?.capRemaining, null, "maxDeposit reads uncapped");
    const metrics = await sparkSavingsMetrics(market.vault);
    assert.equal(metrics.apySource, "rate");
    assert.equal(metrics.exitLiquidity?.amount, "300000000");
    const usdc = mockSpark({ shares: 10n * 10n ** 18n });
    const v1 = await spark.positionOf?.(usdc.vault, OWNER);
    assert.equal(v1?.rate, (11n * 10n ** 17n).toString());
    assert.equal(v1?.withdrawableNow?.amount, "11000000");
  });
});
