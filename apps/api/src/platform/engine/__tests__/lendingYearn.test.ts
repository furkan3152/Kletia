/** Yearn exits use explicit loss limits, not its permissive three-argument redeem. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import type { EvmTransactionRequest, YearnVaultVenue } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { YEARN_REGISTRY_ABI, YEARN_VAULT_ABI } from "../adapters/lending/erc4626.js";
import { yearnAdapter, yearnMetrics } from "../adapters/lending/yearn.js";
import { configurePlatform, createIntent, prepareStep, refreshIntent, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, eventLog, installLendingChain, landPrepared, MAX, mockToken, setAllowance, setBalance, tokenAddress, transferLog, venue, type LendingChain } from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
let chain: LendingChain;
const vaultAbi = YEARN_VAULT_ABI as Abi;
beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [yearnAdapter] });
});
afterEach(() => chain.restore());

function mockYearn(options: { shares?: bigint; endorsed?: boolean; asset?: string; version?: string; decimals?: number; maxDeposit?: bigint; maxWithdraw?: bigint; simulatedRedeem?: bigint } = {}) {
  const vault = venue<YearnVaultVenue>("ethereum:yearn-v3:usdc-1");
  const token = tokenAddress("ethereum", "USDC");
  const underlying = mockToken(chain, token, { symbol: "USDC", decimals: 6 });
  for (const registry of vault.registries) chain.contract(registry, YEARN_REGISTRY_ABI as Abi, {
    getEndorsedVaults: () => options.endorsed === false ? [] : [vault.target],
  });
  const shares = options.shares ?? 0n;
  const assetsOf = (n: bigint) => n * 104n / 100n;
  chain.contract(vault.target, [...vaultAbi, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as Abi, {
    asset: () => options.asset ?? token,
    decimals: () => options.decimals ?? 6,
    apiVersion: () => options.version ?? vault.apiVersion,
    symbol: () => "yvUSDC-1",
    balanceOf: () => shares,
    totalAssets: () => 19_300_000_000_000n,
    convertToAssets: ([n]) => assetsOf(n),
    previewDeposit: ([n]) => n * 100n / 104n,
    previewWithdraw: ([n]) => (n * 100n + 103n) / 104n,
    previewRedeem: ([n]) => assetsOf(n),
    maxDeposit: () => options.maxDeposit ?? MAX,
    maxWithdraw: () => options.maxWithdraw ?? assetsOf(shares),
    deposit: ([n]) => n * 100n / 104n,
    withdraw: ([n]) => (n * 100n + 103n) / 104n,
    redeem: ([n]) => options.simulatedRedeem ?? assetsOf(n),
  });
  return { vault, token, underlying };
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

describe("Yearn V3 curated vault", () => {
  it("binds the official endorsed vault, exact approval and actual minted shares", async () => {
    const market = mockYearn();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 104 USDC into yearn usdc-1 on ethereum", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "yearn-v3");
    assert.equal(graph.steps[0]?.venue, market.vault.id);
    assert.equal(graph.steps[0]?.minimumOutput?.amount, "99900000");
    const txs = await prepare(graph.id);
    assert.equal(txs.length, 2);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: txs[0]?.data as Hex }).args, [market.vault.target, 104_000_000n]);
    assert.deepEqual(decodeFunctionData({ abi: YEARN_VAULT_ABI, data: txs[1]?.data as Hex }).args, [104_000_000n, ACCOUNT]);
    assert.ok(chain.calls.some((c) => c.functionName === "getEndorsedVaults"));
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], [
      transferLog(market.token, ACCOUNT, market.vault.target, 104_000_000n),
      transferLog(market.vault.target, zeroAddress, ACCOUNT, 99_999_999n),
      eventLog(market.vault.target, vaultAbi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 104_000_000n, shares: 99_999_999n }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "99999999");
  });

  it("revalidates revoked endorsement, underlying, API version and share decimals before signing", async () => {
    const market = mockYearn();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 104 USDC into yearn on ethereum", accounts: ACCOUNTS });
    for (const options of [{ endorsed: false }, { asset: zeroAddress }, { version: "3.1.0" }, { decimals: 18 }]) {
      const changed = mockYearn(options);
      setBalance(changed.underlying, ACCOUNT, 500_000_000n);
      await assert.rejects(prepare(graph.id), (e: unknown) => e instanceof PlatformError && e.code === "VENUE_UNVERIFIED");
    }
  });

  it("refuses arbitrary addresses, unsupported networks and exhausted deposit caps", async () => {
    mockYearn({ maxDeposit: 1n });
    await assert.rejects(createIntent({ text: "deposit 104 USDC into yearn on ethereum", accounts: ACCOUNTS }), (e: unknown) => e instanceof PlatformError && e.code === "RESERVE_UNAVAILABLE");
    await assert.rejects(createIntent({ actions: [{ kind: "deposit", network: "ethereum", from: "USDC", amount: "1", protocol: "yearn-v3", params: { venue: "0x3333333333333333333333333333333333333333" } }], accounts: ACCOUNTS }), (e: unknown) => e instanceof PlatformError && e.code === "VENUE_UNKNOWN");
    await assert.rejects(createIntent({ text: "deposit 1 USDC into yearn on base", accounts: [`eip155:8453:${ACCOUNT}`] }), (e: unknown) => e instanceof PlatformError);
  });

  it("sets redeem's onchain maximum loss to one basis point and proves the full close", async () => {
    const market = mockYearn({ shares: 500_000_000n });
    const graph = await createIntent({ text: "withdraw all USDC from yearn on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    assert.equal(txs.length, 1);
    const call = decodeFunctionData({ abi: YEARN_VAULT_ABI, data: txs[0]?.data as Hex });
    assert.equal(call.functionName, "redeem");
    assert.deepEqual(call.args, [500_000_000n, ACCOUNT, ACCOUNT, 1n]);
    assert.equal(graph.steps[0]?.minimumOutput?.amount, "519948000");
    const paid = 520_000_100n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[
      transferLog(market.vault.target, ACCOUNT, zeroAddress, 500_000_000n),
      transferLog(market.token, market.vault.target, ACCOUNT, paid),
      eventLog(market.vault.target, vaultAbi, "Withdraw", { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT, assets: paid, shares: 500_000_000n }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, paid.toString());
  });

  it("encodes exact withdrawals with zero loss and refuses liquidity or simulated losses", async () => {
    mockYearn({ shares: 500_000_000n });
    const graph = await createIntent({ text: "withdraw 100 USDC from yearn on ethereum", accounts: ACCOUNTS });
    assert.deepEqual(decodeFunctionData({ abi: YEARN_VAULT_ABI, data: (await prepare(graph.id))[0]?.data as Hex }).args, [100_000_000n, ACCOUNT, ACCOUNT, 0n]);
    mockYearn({ shares: 500_000_000n, maxWithdraw: 10_000_000n });
    await assert.rejects(createIntent({ text: "withdraw 100 USDC from yearn on ethereum", accounts: ACCOUNTS }), (e: unknown) => e instanceof PlatformError && e.code === "VENUE_ILLIQUID");
    mockYearn({ shares: 500_000_000n, simulatedRedeem: 500_000_000n });
    await assert.rejects(createIntent({ text: "withdraw all USDC from yearn on ethereum", accounts: ACCOUNTS }), (e: unknown) => e instanceof PlatformError && e.code === "SIMULATION_FAILED");
  });

  it("fails a successful receipt whose share mint is below the floor", async () => {
    const market = mockYearn();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    setAllowance(market.underlying, ACCOUNT, market.vault.spender, 104_000_000n);
    const graph = await createIntent({ text: "deposit 104 USDC into yearn on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[
      transferLog(market.token, ACCOUNT, market.vault.target, 104_000_000n),
      transferLog(market.vault.target, zeroAddress, ACCOUNT, 90_000_000n),
      eventLog(market.vault.target, vaultAbi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 104_000_000n, shares: 90_000_000n }),
    ]]));
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
  });

  it("recovers a delayed withdrawal receipt without preparing or broadcasting another transaction", async () => {
    const market = mockYearn({ shares: 500_000_000n });
    const graph = await createIntent({ text: "withdraw 100 USDC from yearn on ethereum", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    const burnt = 96_153_847n;
    const hashes = landPrepared(chain, txs, [[transferLog(market.vault.target, ACCOUNT, zeroAddress, burnt),
      transferLog(market.token, market.vault.target, ACCOUNT, 100_000_000n),
      eventLog(market.vault.target, vaultAbi, "Withdraw", { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT, assets: 100_000_000n, shares: burnt })]]);
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
    assert.equal(recovered.steps[0]?.actualOutput?.amount, "100000000");
    assert.equal(chain.rpc.evm.size, 1);
  });

  it("reports TVL under Yearn identity without fabricating yield", async () => {
    const { vault } = mockYearn();
    const metrics = await yearnMetrics(vault);
    assert.equal(metrics.protocol, "yearn-v3");
    assert.equal(metrics.totalSupplied?.amount, "19300000000000");
    assert.equal(metrics.supplyApy, 0, "unchanged historical share price means measured zero APY");
  });
});
