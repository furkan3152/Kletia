/**
 * Fluid fTokens through the ERC-4626 vault engine: LendingFactory provenance
 * (getData() pins and allTokens()), the floor-carrying deposit / withdraw /
 * redeem overloads (exact calldata), minDeposit and maxDeposit, maxWithdraw
 * exit liquidity, Liquidity-layer transfers in proofs and the journey facts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, type EvmTransactionRequest, type FluidFTokenVenue } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { VAULT_ABI } from "../adapters/lending/erc4626.js";
import { FLUID_FACTORY_ABI, fluidAdapter, fluidFamily, fluidMetrics, FTOKEN_ABI } from "../adapters/lending/fluid.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, eventLog, installLendingChain, landPrepared, mockToken, setBalance, tokenAddress, transferLog, venue, type LendingChain } from "./lendingChain.js";

const ACCOUNTS = [`eip155:8453:${ACCOUNT}`];
const fluid = fluidAdapter as ProtocolAdapter;
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [fluid] });
});
afterEach(() => chain.restore());

interface FluidOptions {
  factory?: string;
  listed?: boolean;
  shares?: bigint;
  maxWithdraw?: bigint;
  minDeposit?: bigint;
  maxDeposit?: bigint;
}

/** 1 fUSDC = 1.25 USDC. */
function mockFluid(options: FluidOptions = {}) {
  const vault = venue<FluidFTokenVenue>("base:fluid:usdc");
  const token = tokenAddress("base", "USDC");
  const underlying = mockToken(chain, token, { symbol: "USDC", decimals: 6 });
  const toAssets = (shares: bigint) => (shares * 5n) / 4n;
  const toShares = (assets: bigint) => (assets * 4n) / 5n;
  const shares = options.shares ?? 0n;
  chain.contract(vault.lendingFactory, FLUID_FACTORY_ABI as Abi, {
    allTokens: () => (options.listed === false ? ["0x1A996cb54bb95462040408C06122D45D6Cdb6096"] : ["0x1A996cb54bb95462040408C06122D45D6Cdb6096", vault.target]),
  });
  chain.contract(vault.target, [...FTOKEN_ABI, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as Abi, {
    asset: () => token,
    decimals: () => 6,
    symbol: () => "fUSDC",
    getData: () => [vault.liquidity, options.factory ?? vault.lendingFactory, zeroAddress, zeroAddress, zeroAddress, false, 0n, 0n, 0n],
    minDeposit: () => options.minDeposit ?? 2n,
    totalAssets: () => 11_000_000_000_000n,
    balanceOf: () => shares,
    convertToAssets: ([amount]) => toAssets(amount),
    previewDeposit: ([assets]) => toShares(assets),
    previewWithdraw: ([assets]) => toShares(assets) + 1n,
    previewRedeem: ([amount]) => toAssets(amount),
    maxDeposit: () => options.maxDeposit ?? 1n << 127n,
    maxWithdraw: () => options.maxWithdraw ?? toAssets(shares),
    deposit: ([assets]) => toShares(assets),
    withdraw: ([assets]) => toShares(assets) + 1n,
    redeem: ([amount]) => toAssets(amount),
  });
  return { vault, token, underlying, toAssets, toShares };
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

function refused(code: string) {
  return (error: unknown) => error instanceof PlatformError && error.code === code;
}

describe("Fluid fTokens", () => {
  it("deposits with the three-argument overload carrying the share floor and proves it against the Liquidity layer", async () => {
    const market = mockFluid();
    setBalance(market.underlying, ACCOUNT, 500_000_000n);
    const graph = await createIntent({ text: "deposit 100 USDC into fluid on base", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "fluid");
    assert.equal(step?.title, "Deposit 100 USDC into Fluid USDC on Base");
    assert.equal(step?.minimumOutput?.amount, "79920000", "80 fUSDC less 10 bps");
    const txs = await prepare(graph.id);
    assert.equal(txs[1]?.data.slice(0, 10), "0xbc157ac1", "deposit(uint256,address,uint256)");
    assert.deepEqual(decodeFunctionData({ abi: FTOKEN_ABI, data: txs[1]?.data as Hex }).args, [100_000_000n, ACCOUNT, 79_920_000n]);
    const shares = 80_000_000n;
    const logs = (to: string) => [
      transferLog(market.token, ACCOUNT, to, 100_000_000n),
      transferLog(market.vault.target, zeroAddress, ACCOUNT, shares),
      eventLog(market.vault.target, VAULT_ABI as Abi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 100_000_000n, shares }),
    ];
    const toVault = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], logs(market.vault.target)]));
    assert.equal(toVault.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "Fluid deposits move the tokens to the Liquidity layer, not the fToken");
    const again = await createIntent({ text: "deposit 100 USDC into fluid on base", accounts: ACCOUNTS });
    const second = await prepare(again.id);
    const done = await submitStep(again.id, "s1", landPrepared(chain, second, [[], logs(market.vault.liquidity)]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("refuses an fToken whose getData() names another factory or that the factory does not list", async () => {
    mockFluid({ factory: "0x4444444444444444444444444444444444444444" });
    await assert.rejects(createIntent({ text: "deposit 100 USDC into fluid on base", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockFluid({ listed: false });
    await assert.rejects(createIntent({ text: "deposit 100 USDC into fluid on base", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockFluid({ minDeposit: 5_000_000n });
    await assert.rejects(createIntent({ text: "deposit 1 USDC into fluid on base", accounts: ACCOUNTS }), refused("AMOUNT_TOO_SMALL"));
    mockFluid({ maxDeposit: 10_000_000n });
    await assert.rejects(createIntent({ text: "deposit 100 USDC into fluid on base", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE"));
  });

  it("withdraws with maxSharesBurn, redeems with minAmountOut and refuses beyond maxWithdraw", async () => {
    const shares = 400_000_000n;
    mockFluid({ shares, maxWithdraw: 50_000_000n });
    const error = await createIntent({ text: "withdraw 100 USDC from fluid on base", accounts: ACCOUNTS }).catch((caught: unknown) => caught);
    assert.ok(error instanceof PlatformError && error.code === "VENUE_ILLIQUID", String(error));
    assert.match(error.message, /can pay out 50 USDC/u);
    const market = mockFluid({ shares });
    const exact = await createIntent({ text: "withdraw 100 USDC from fluid on base", accounts: ACCOUNTS });
    const withdraw = await prepare(exact.id);
    assert.equal(withdraw[0]?.data.slice(0, 10), "0xa318c1a4");
    // previewWithdraw(100) = 80_000_001 shares, plus 10 bps (rounded down) and one wei.
    assert.deepEqual(decodeFunctionData({ abi: FTOKEN_ABI, data: withdraw[0]?.data as Hex }).args, [100_000_000n, ACCOUNT, ACCOUNT, 80_080_002n]);
    const all = await createIntent({ text: "withdraw all USDC from fluid on base", accounts: ACCOUNTS });
    const redeem = await prepare(all.id);
    assert.equal(redeem[0]?.data.slice(0, 10), "0x9f40a7b3");
    assert.deepEqual(decodeFunctionData({ abi: FTOKEN_ABI, data: redeem[0]?.data as Hex }).args, [shares, ACCOUNT, ACCOUNT, 499_950_000n]);
    const done = await submitStep(all.id, "s1", landPrepared(chain, redeem, [[
      transferLog(market.vault.target, ACCOUNT, zeroAddress, shares),
      transferLog(market.token, market.vault.liquidity, ACCOUNT, 500_000_000n),
      eventLog(market.vault.target, VAULT_ABI as Abi, "Withdraw", { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT, assets: 500_000_000n, shares }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("only accepts its own floor-carrying overloads when decoding a landed call", () => {
    const plainRedeem = encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [1n, ACCOUNT, ACCOUNT] });
    const plainDeposit = encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [1n, ACCOUNT] });
    const zeroFloor = encodeFunctionData({ abi: FTOKEN_ABI, functionName: "redeem", args: [1n, ACCOUNT, ACCOUNT, 0n] });
    for (const data of [plainRedeem, plainDeposit, zeroFloor]) assert.ok("refused" in fluidFamily.decodeCall(data));
    const floored = fluidFamily.decodeCall(encodeFunctionData({ abi: FTOKEN_ABI, functionName: "redeem", args: [7n, ACCOUNT, ACCOUNT, 5n] }));
    assert.deepEqual(floored, { functionName: "redeem", amount: 7n, receiver: ACCOUNT, owner: ACCOUNT });
  });

  it("reports the position, capacity and metrics", async () => {
    const market = mockFluid({ shares: 400_000_000n, maxWithdraw: 120_000_000n });
    const owner = parseAccountId(ACCOUNTS[0])!;
    const position = await fluid.positionOf?.(market.vault, owner);
    assert.equal(position?.underlying.amount, "500000000");
    assert.equal(position?.withdrawableNow?.amount, "120000000");
    assert.equal(position?.rate, (125n * 10n ** 16n).toString());
    const capacity = await fluid.venueCapacity?.(market.vault);
    assert.equal(capacity?.capRemaining, null, "Fluid's 2^127 maxDeposit reads as uncapped");
    assert.equal(capacity?.paused, false);
    const metrics = await fluidMetrics(market.vault);
    assert.equal(metrics.protocol, "fluid");
    assert.equal(metrics.totalSupplied?.amount, "11000000000000");
  });
});
