/**
 * Yearn V3 vaults through the ERC-4626 vault engine (adapted from the Codex
 * branch's lendingYearn.test.ts): EIP-1167 clone, API version, registry
 * endorsement and asset provenance; isShutdown refuses deposits only; exits
 * always carry an explicit loss limit (withdraw max_loss 0, redeem max_loss
 * 1); the title does not repeat "(Yearn)"; journey facts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, type EvmTransactionRequest, type YearnVaultVenue } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { VAULT_ABI } from "../adapters/lending/erc4626.js";
import { YEARN_REGISTRY_ABI, YEARN_VAULT_ABI, yearnAdapter, yearnFamily, yearnMetrics } from "../adapters/lending/yearn.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, eventLog, installLendingChain, landPrepared, MAX, mockToken, setAllowance, setBalance, setClone, tokenAddress, transferLog, venue, type LendingChain } from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const yearn = yearnAdapter as ProtocolAdapter;
const vaultAbi = YEARN_VAULT_ABI as Abi;
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [yearn] });
});
afterEach(() => chain.restore());

interface YearnOptions {
  shares?: bigint;
  endorsed?: boolean;
  clone?: string;
  asset?: string;
  version?: string;
  decimals?: number;
  shutdown?: boolean;
  maxDeposit?: bigint;
  maxWithdraw?: bigint;
  simulatedRedeem?: bigint;
}

function mockYearn(options: YearnOptions = {}) {
  const vault = venue<YearnVaultVenue>("ethereum:yearn-v3:usdc-1");
  const token = tokenAddress("ethereum", "USDC");
  const underlying = mockToken(chain, token, { symbol: "USDC", decimals: 6 });
  setClone(chain, vault.target, options.clone ?? vault.implementation);
  for (const registry of vault.registries) {
    chain.contract(registry, YEARN_REGISTRY_ABI as Abi, { isEndorsed: () => options.endorsed !== false });
  }
  const shares = options.shares ?? 0n;
  const assetsOf = (n: bigint) => (n * 104n) / 100n;
  chain.contract(vault.target, [...vaultAbi, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as Abi, {
    asset: () => options.asset ?? token,
    decimals: () => options.decimals ?? 6,
    apiVersion: () => options.version ?? vault.apiVersion,
    isShutdown: () => options.shutdown ?? false,
    symbol: () => "yvUSDC-1",
    balanceOf: () => shares,
    totalAssets: () => 19_300_000_000_000n,
    convertToAssets: ([n]) => assetsOf(n),
    previewDeposit: ([n]) => (n * 100n) / 104n,
    previewWithdraw: ([n]) => (n * 100n + 103n) / 104n,
    previewRedeem: ([n]) => assetsOf(n),
    maxDeposit: () => options.maxDeposit ?? MAX,
    maxWithdraw: () => options.maxWithdraw ?? assetsOf(shares),
    deposit: ([n]) => (n * 100n) / 104n,
    withdraw: ([n]) => (n * 100n + 103n) / 104n,
    redeem: ([n]) => options.simulatedRedeem ?? assetsOf(n),
  });
  return { vault, token, underlying };
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

function refused(code: string) {
  return (error: unknown) => error instanceof PlatformError && error.code === code;
}

describe("Yearn V3 vaults", () => {
  it("deposits into the endorsed clone with an exact approval, a title without \"(Yearn)\" and a proven share mint", async () => {
    const market = mockYearn();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 104 USDC into yearn usdc-1 on ethereum", accounts: ACCOUNTS });
    assert.equal(graph.steps[0]?.protocol, "yearn-v3");
    assert.equal(graph.steps[0]?.venue, market.vault.id);
    assert.equal(graph.steps[0]?.title, "Deposit 104 USDC into Yearn V3 USDC-1 on Ethereum");
    assert.equal(graph.steps[0]?.minimumOutput?.amount, "99900000");
    const txs = await prepare(graph.id);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: txs[0]?.data as Hex }).args, [market.vault.target, 104_000_000n]);
    assert.deepEqual(decodeFunctionData({ abi: VAULT_ABI, data: txs[1]?.data as Hex }).args, [104_000_000n, ACCOUNT]);
    assert.ok(chain.calls.some((call) => call.functionName === "isEndorsed"));
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], [
      transferLog(market.token, ACCOUNT, market.vault.target, 104_000_000n),
      transferLog(market.vault.target, zeroAddress, ACCOUNT, 99_999_999n),
      eventLog(market.vault.target, vaultAbi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 104_000_000n, shares: 99_999_999n }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "99999999");
  });

  it("re-checks the clone target, endorsement, asset, API version and decimals before signing", async () => {
    const market = mockYearn();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 104 USDC into yearn on ethereum", accounts: ACCOUNTS });
    for (const options of [{ clone: "0x5555555555555555555555555555555555555555" }, { endorsed: false }, { asset: zeroAddress }, { version: "3.1.0" }, { decimals: 18 }]) {
      const changed = mockYearn(options);
      setBalance(changed.underlying, ACCOUNT, 500_000_000n);
      await assert.rejects(prepare(graph.id), refused("VENUE_UNVERIFIED"), JSON.stringify(options));
    }
    chain.code.set(market.vault.target.toLowerCase(), "0x6080604052" as Hex);
    await assert.rejects(prepare(graph.id), refused("VENUE_UNVERIFIED"), "a vault that is not an EIP-1167 clone");
  });

  it("refuses deposits into a shut-down vault but still withdraws from it", async () => {
    mockYearn({ shutdown: true, shares: 500_000_000n });
    const error = await createIntent({ text: "deposit 104 USDC into yearn on ethereum", accounts: ACCOUNTS }).catch((caught: unknown) => caught);
    assert.ok(error instanceof PlatformError && error.code === "RESERVE_UNAVAILABLE");
    assert.match(error.message, /shut down: it takes no deposits \(withdrawals still work\)/u);
    const withdraw = await createIntent({ text: "withdraw 100 USDC from yearn on ethereum", accounts: ACCOUNTS });
    assert.equal(withdraw.steps[0]?.kind, "withdraw");
    mockYearn({ maxDeposit: 1n });
    await assert.rejects(createIntent({ text: "deposit 104 USDC into yearn on ethereum", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE"));
  });

  it("exits with withdraw(..., max_loss 0) and redeem(..., max_loss 1) and proves the full close", async () => {
    const market = mockYearn({ shares: 500_000_000n });
    const exact = await createIntent({ text: "withdraw 100 USDC from yearn on ethereum", accounts: ACCOUNTS });
    const withdraw = await prepare(exact.id);
    assert.equal(withdraw[0]?.data.slice(0, 10), "0xa318c1a4");
    assert.deepEqual(decodeFunctionData({ abi: YEARN_VAULT_ABI, data: withdraw[0]?.data as Hex }).args, [100_000_000n, ACCOUNT, ACCOUNT, 0n]);
    assert.ok(chain.calls.some((call) => call.functionName === "maxWithdraw" && call.args.length === 3 && call.args[1] === 0n), "maxWithdraw(owner, 0, [])");
    const all = await createIntent({ text: "withdraw all USDC from yearn on ethereum", accounts: ACCOUNTS });
    const redeem = await prepare(all.id);
    assert.equal(redeem[0]?.data.slice(0, 10), "0x9f40a7b3");
    assert.deepEqual(decodeFunctionData({ abi: YEARN_VAULT_ABI, data: redeem[0]?.data as Hex }).args, [500_000_000n, ACCOUNT, ACCOUNT, 1n]);
    assert.equal(all.steps[0]?.minimumOutput?.amount, "519948000");
    const paid = 520_000_100n;
    const done = await submitStep(all.id, "s1", landPrepared(chain, redeem, [[
      transferLog(market.vault.target, ACCOUNT, zeroAddress, 500_000_000n),
      transferLog(market.token, market.vault.target, ACCOUNT, paid),
      eventLog(market.vault.target, vaultAbi, "Withdraw", { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT, assets: paid, shares: 500_000_000n }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, paid.toString());
  });

  it("refuses short liquidity, simulated losses and any other loss limit in a landed call", async () => {
    mockYearn({ shares: 500_000_000n, maxWithdraw: 10_000_000n });
    await assert.rejects(createIntent({ text: "withdraw 100 USDC from yearn on ethereum", accounts: ACCOUNTS }), refused("VENUE_ILLIQUID"));
    mockYearn({ shares: 500_000_000n, simulatedRedeem: 500_000_000n });
    await assert.rejects(createIntent({ text: "withdraw all USDC from yearn on ethereum", accounts: ACCOUNTS }), refused("SIMULATION_FAILED"));
    const threeArgument = encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [1n, ACCOUNT, ACCOUNT] });
    const anyLoss = encodeFunctionData({ abi: YEARN_VAULT_ABI, functionName: "redeem", args: [1n, ACCOUNT, ACCOUNT, 10_000n] });
    const lossyWithdraw = encodeFunctionData({ abi: YEARN_VAULT_ABI, functionName: "withdraw", args: [1n, ACCOUNT, ACCOUNT, 1n] });
    for (const data of [threeArgument, anyLoss, lossyWithdraw]) assert.ok("refused" in yearnFamily.decodeCall(data));
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

  it("reports the position, the capacity (paused when shut down) and metrics under Yearn", async () => {
    const { vault } = mockYearn({ shares: 100_000_000n, maxWithdraw: 60_000_000n, maxDeposit: 30_000_000_000n });
    const owner = parseAccountId(ACCOUNTS[0])!;
    const position = await yearn.positionOf?.(vault, owner);
    assert.equal(position?.protocol, "yearn-v3");
    assert.equal(position?.underlying.amount, "104000000");
    assert.equal(position?.withdrawableNow?.amount, "60000000");
    const capacity = await yearn.venueCapacity?.(vault);
    assert.equal(capacity?.capRemaining, "30000000000");
    assert.equal(capacity?.paused, false);
    mockYearn({ shutdown: true });
    const shut = await yearn.venueCapacity?.(vault);
    assert.equal(shut?.paused, true);
    assert.equal(shut?.capRemaining, "0");
    const metrics = await yearnMetrics(vault);
    assert.equal(metrics.protocol, "yearn-v3");
    assert.equal(metrics.totalSupplied?.amount, "19300000000000");
    assert.deepEqual(metrics.warnings, ["The vault is shut down: withdrawals only, no new deposits."]);
  });
});
