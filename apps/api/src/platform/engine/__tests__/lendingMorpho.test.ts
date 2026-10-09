/**
 * Morpho ERC-4626 vault adapter against in-process contract state: factory
 * provenance, pinned asset and share decimals, Vault V2 gates, MetaMorpho
 * v1 caps and liquidity, the shares floor of a deposit, redeem(balanceOf)
 * for "withdraw all", Deposit / Withdraw event proofs and the realised
 * share-price APY.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import type { Erc4626Venue, EvmTransactionRequest, IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { aaveV3Adapter } from "../adapters/aaveV3.js";
import { compoundV3Adapter } from "../adapters/lending/compoundV3.js";
import { erc4626Adapter, FACTORY_ABI, morphoMetrics, VAULT_ABI } from "../adapters/lending/erc4626.js";
import { moonwellAdapter } from "../adapters/lending/moonwell.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import {
  ACCOUNT,
  ACCOUNTS_BASE,
  eventLog,
  installLendingChain,
  landPrepared,
  mockToken,
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
  configurePlatform({ store: new MemoryIntentStore(), adapters: [aaveV3Adapter, compoundV3Adapter, erc4626Adapter, moonwellAdapter] });
});
afterEach(() => chain.restore());

const E18 = 10n ** 18n;
/** 1 share (1e18) = 1.04 USDC. */
const PRICE_NUM = 1_040_000n;

interface VaultOptions {
  slug?: string;
  confirmed?: boolean;
  asset?: string;
  decimals?: number;
  gate?: string;
  shares?: bigint;
  maxDeposit?: bigint;
  maxWithdraw?: bigint;
  /** Assets per 1e18 shares one week ago (for the realised APY). */
  pastPrice?: bigint;
}

interface Vault {
  readonly vault: Erc4626Venue;
  readonly usdc: TokenState;
  readonly token: string;
}

const toAssets = (shares: bigint, price = PRICE_NUM) => (shares * price) / E18;
const toShares = (assets: bigint) => (assets * E18) / PRICE_NUM;

function mockVault(options: VaultOptions = {}): Vault {
  const vault = venue<Erc4626Venue>(`base:morpho:${options.slug ?? "steakhouse-prime-usdc"}`);
  const token = tokenAddress("base", "USDC");
  const usdc = mockToken(chain, token, { symbol: "USDC", decimals: 6 });
  const shares = options.shares ?? 0n;
  chain.contract(vault.factory, FACTORY_ABI as unknown as Abi, {
    isVaultV2: ([target]) => (options.confirmed ?? true) && String(target).toLowerCase() === vault.target.toLowerCase(),
    isMetaMorpho: ([target]) => (options.confirmed ?? true) && String(target).toLowerCase() === vault.target.toLowerCase(),
  });
  const latest = `0x${chain.latestBlock.toString(16)}`;
  chain.contract(vault.target, [...VAULT_ABI, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as unknown as Abi, {
    asset: () => options.asset ?? token,
    decimals: () => options.decimals ?? 18,
    symbol: () => "steakUSDC",
    totalAssets: () => 272_000_000_000_000n,
    balanceOf: () => shares,
    convertToAssets: ([amount], call) => toAssets(amount as bigint, call.block === "latest" || call.block === latest ? PRICE_NUM : (options.pastPrice ?? PRICE_NUM)),
    previewDeposit: ([assets]) => toShares(assets as bigint),
    previewRedeem: ([amount]) => toAssets(amount as bigint),
    previewWithdraw: ([assets]) => toShares(assets as bigint) + 1n,
    maxDeposit: () => options.maxDeposit ?? 0n,
    maxWithdraw: () => options.maxWithdraw ?? 0n,
    receiveSharesGate: () => options.gate ?? zeroAddress,
    sendSharesGate: () => zeroAddress,
    receiveAssetsGate: () => zeroAddress,
    sendAssetsGate: () => zeroAddress,
    deposit: ([assets]) => toShares(assets as bigint),
    withdraw: ([assets]) => toShares(assets as bigint) + 1n,
    redeem: ([amount]) => toAssets(amount as bigint),
  });
  return { vault, usdc, token };
}

async function planError(input: string | object): Promise<PlatformError> {
  try {
    await createIntent(typeof input === "string" ? { text: input, accounts: ACCOUNTS_BASE } : input);
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return error;
  }
  assert.fail("planned but should have been refused");
}

async function prepared(graph: IntentGraph): Promise<EvmTransactionRequest[]> {
  const { payload } = await prepareStep(graph.id, "s1");
  return payload.transactions as EvmTransactionRequest[];
}

const vaultAbi = VAULT_ABI as unknown as Abi;
const decode = (transaction: EvmTransactionRequest | undefined) => decodeFunctionData({ abi: vaultAbi, data: transaction?.data as Hex });

describe("Morpho vault deposit", () => {
  it("deposits into the factory-proven vault with an exact approval and holds the shares to preview - 10 bps", async () => {
    const { vault, usdc, token } = mockVault();
    setBalance(usdc, ACCOUNT, 1_000_000_000n);
    const graph = await createIntent({ text: "deposit 104 USDC into morpho on base", accounts: ACCOUNTS_BASE });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "morpho");
    assert.equal(step?.venue, "base:morpho:steakhouse-prime-usdc");
    assert.equal(step?.expectedOutput?.amount, (100n * E18).toString());
    assert.equal(step?.minimumOutput?.amount, ((100n * E18 * 9_990n) / 10_000n).toString());
    assert.equal(step?.minimumOutput?.symbol, "steakUSDC");
    assert.ok(chain.calls.some((entry) => entry.functionName === "isVaultV2" && entry.to === vault.factory.toLowerCase()), "factory provenance is read");
    assert.ok(!chain.calls.some((entry) => entry.functionName === "maxDeposit"), "Vault V2 max* are not gated on");
    const transactions = await prepared(graph);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args, [vault.target, 104_000_000n]);
    assert.deepEqual(decode(transactions[1]).args, [104_000_000n, ACCOUNT]);
    const shares = 100n * E18 - 7n;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[], [
      transferLog(token, ACCOUNT, vault.target, 104_000_000n),
      transferLog(vault.target, zeroAddress, ACCOUNT, shares),
      eventLog(vault.target, vaultAbi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 104_000_000n, shares }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, shares.toString());
  });

  it("fails a deposit that minted fewer shares than the floor", async () => {
    const { vault, usdc, token } = mockVault();
    setBalance(usdc, ACCOUNT, 1_000_000_000n);
    const graph = await createIntent({ text: "deposit 104 USDC into morpho on base", accounts: ACCOUNTS_BASE });
    const transactions = await prepared(graph);
    const shares = 90n * E18;
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[], [
      transferLog(token, ACCOUNT, vault.target, 104_000_000n),
      transferLog(vault.target, zeroAddress, ACCOUNT, shares),
      eventLog(vault.target, vaultAbi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 104_000_000n, shares }),
    ]]));
    assert.equal(done.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    assert.match(done.steps[0]?.failure?.message ?? "", /minted 90000000000000000000 shares/u);
  });

  it("refuses vaults the factory does not confirm, another asset, other share decimals or a gate", async () => {
    mockVault({ confirmed: false });
    const unconfirmed = await planError("deposit 104 USDC into morpho on base");
    assert.equal(unconfirmed.code, "VENUE_UNVERIFIED");
    assert.match(unconfirmed.message, /not confirmed by its pinned Morpho factory/u);
    mockVault({ asset: "0x3333333333333333333333333333333333333333" });
    assert.equal((await planError("deposit 104 USDC into morpho on base")).code, "VENUE_UNVERIFIED");
    mockVault({ decimals: 6 });
    assert.equal((await planError("deposit 104 USDC into morpho on base")).code, "VENUE_UNVERIFIED");
    mockVault({ gate: "0x4444444444444444444444444444444444444444" });
    const gated = await planError("deposit 104 USDC into morpho on base");
    assert.equal(gated.code, "VENUE_UNVERIFIED");
    assert.match(gated.message, /receiveSharesGate/u);
  });

  it("holds MetaMorpho v1 deposits to maxDeposit and never resolves a vault by an unknown name", async () => {
    mockVault({ slug: "spark-usdc", maxDeposit: 50_000_000n });
    const capped = await planError({ actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "104", protocol: "morpho", params: { venue: "spark-usdc" } }], accounts: ACCOUNTS_BASE });
    assert.equal(capped.code, "RESERVE_UNAVAILABLE");
    const unknown = await planError({ actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "1", protocol: "morpho", params: { venue: "0x3014ED70bfd1B9d2E2E8C3a0Df17E3B8c9F96522" } }], accounts: ACCOUNTS_BASE });
    assert.equal(unknown.code, "VENUE_UNKNOWN");
  });
});

describe("Morpho vault withdraw", () => {
  it("redeems the whole share balance for 'withdraw all' and proves the Withdraw event", async () => {
    const shares = 500n * E18;
    const { vault, token } = mockVault({ shares });
    const graph = await createIntent({ text: "withdraw all USDC from morpho steakhouse-prime-usdc on base", accounts: ACCOUNTS_BASE });
    assert.equal(graph.steps[0]?.input?.amount, "520000000");
    assert.equal(graph.steps[0]?.minimumOutput?.amount, ((520_000_000n * 9_999n) / 10_000n).toString(), "one basis point of loss tolerance");
    const transactions = await prepared(graph);
    const redeem = decode(transactions[0]);
    assert.equal(redeem.functionName, "redeem");
    assert.deepEqual(redeem.args, [shares, ACCOUNT, ACCOUNT]);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, transactions, [[
      transferLog(vault.target, ACCOUNT, zeroAddress, shares),
      transferLog(token, vault.target, ACCOUNT, 520_000_100n),
      eventLog(vault.target, vaultAbi, "Withdraw", { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT, assets: 520_000_100n, shares }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, "520000100");
  });

  it("withdraws an exact amount to the account and checks MetaMorpho v1 liquidity", async () => {
    const { vault } = mockVault({ shares: 500n * E18 });
    const graph = await createIntent({ text: "withdraw 100 USDC from morpho on base", accounts: ACCOUNTS_BASE });
    const transactions = await prepared(graph);
    assert.equal(transactions[0]?.to, vault.target);
    assert.deepEqual(decode(transactions[0]).args, [100_000_000n, ACCOUNT, ACCOUNT]);
    mockVault({ slug: "spark-usdc", shares: 500n * E18, maxWithdraw: 10_000_000n });
    const illiquid = await planError({ actions: [{ kind: "withdraw", network: "base", from: "USDC", amount: "100", protocol: "morpho", params: { venue: "spark-usdc" } }], accounts: ACCOUNTS_BASE });
    assert.equal(illiquid.code, "VENUE_ILLIQUID");
    mockVault({ shares: 0n });
    assert.equal((await planError("withdraw all USDC from morpho on base")).code, "POSITION_EMPTY");
    mockVault({ shares: E18 });
    assert.equal((await planError("withdraw 100 USDC from morpho on base")).code, "INSUFFICIENT_BALANCE");
  });
});

describe("Morpho vault metrics", () => {
  it("reports the APY realised by the share price over the last week and the vault's total assets", async () => {
    const { vault } = mockVault({ pastPrice: 1_039_100n });
    const metrics = await morphoMetrics(vault);
    assert.equal(metrics.apySource, "share-price");
    assert.ok(metrics.supplyApy !== null && metrics.supplyApy > 0.04 && metrics.supplyApy < 0.05, String(metrics.supplyApy));
    assert.equal(metrics.totalSupplied?.amount, "272000000000000");
    assert.equal(metrics.exitLiquidity, null);
  });
});
