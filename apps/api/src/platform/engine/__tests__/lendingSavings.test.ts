/**
 * Savings vaults through the ERC-4626 vault engine: Sky's sUSDS
 * (implementation-pinned UUPS proxy) and sDAI (immutable, Pot / DaiJoin
 * pins), and Ethena's sUSDe (immutable, silo pin, deposits only with the live
 * cooldown shown). Provenance refusals, exact calldata, Deposit / Withdraw
 * proofs (sDAI exits are DaiJoin mints) and the deposit-only guard.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, type EvmTransactionRequest, type SavingsVaultVenue } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { VAULT_ABI } from "../adapters/lending/erc4626.js";
import { ethenaAdapter, ethenaExitWarning, SAVINGS_VAULT_ABI, skyAdapter } from "../adapters/lending/savings.js";
import { candidateAdapters } from "../adapters/registry.js";
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
  resolveAsset,
  setBalance,
  setImplementation,
  tokenAddress,
  transferLog,
  venue,
  type LendingChain,
} from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const ONE = 10n ** 18n;
const OTHER = "0x1111111111111111111111111111111111111111";
const POT = "0x197E90f9FAD81970bA7976f33CbD77088E5D7cf7";
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [skyAdapter, ethenaAdapter] as ProtocolAdapter[] });
});
afterEach(() => chain.restore());

interface SavingsOptions {
  implementation?: string;
  /** Overrides of the vault's pinned views ("pot", "silo", "usds"). */
  pins?: Record<string, string>;
  maxDeposit?: bigint;
  shares?: bigint;
  cooldown?: number;
}

/** 1 share = 1.25 underlying (all three use 18-decimal shares over 18-decimal stablecoins). */
function mockSavings(id: string, options: SavingsOptions = {}) {
  const vault = venue<SavingsVaultVenue>(id);
  const token = tokenAddress("ethereum", vault.asset);
  const underlying = mockToken(chain, token, { symbol: vault.asset, decimals: 18 });
  const toAssets = (shares: bigint) => (shares * 5n) / 4n;
  const toShares = (assets: bigint) => (assets * 4n) / 5n;
  // Immutable vaults keep an empty implementation slot.
  setImplementation(chain, vault.target, options.implementation ?? vault.implementation ?? zeroAddress);
  const pins = Object.fromEntries(vault.pins.map((pin) => [pin.call, () => options.pins?.[pin.call] ?? pin.address]));
  const shares = options.shares ?? 0n;
  const pinAbi = vault.pins.map((pin) => ({ type: "function", name: pin.call, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }));
  chain.contract(vault.target, [...SAVINGS_VAULT_ABI, ...pinAbi, ...erc20Abi.filter((item) => item.type === "function" && item.name === "symbol")] as Abi, {
    ...pins,
    asset: () => token,
    decimals: () => 18,
    symbol: () => vault.slug,
    ssr: () => 1_000_000_001_182_641_576_793_209_935n,
    cooldownDuration: () => options.cooldown ?? 86_400,
    totalAssets: () => 1_000_000n * ONE,
    balanceOf: () => shares,
    convertToAssets: ([amount]) => toAssets(amount),
    previewDeposit: ([assets]) => toShares(assets),
    previewRedeem: ([amount]) => toAssets(amount),
    maxDeposit: () => options.maxDeposit ?? MAX,
    maxWithdraw: () => toAssets(shares),
    deposit: ([assets]) => toShares(assets),
    withdraw: ([assets]) => toShares(assets),
    redeem: ([amount]) => toAssets(amount),
  });
  chain.contract(POT, SAVINGS_VAULT_ABI as Abi, { dsr: () => 1_000_000_000_393_915_525_145_987_602n });
  return { vault, token, underlying, toAssets, toShares };
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

function refused(code: string) {
  return (error: unknown) => error instanceof PlatformError && error.code === code;
}

const action = (kind: "deposit" | "withdraw", from: string, protocol: string, venueRef?: string, amount = "100") => ({
  actions: [{ kind, network: "ethereum", from, amount, protocol, ...(venueRef ? { params: { venue: venueRef } } : {}) }],
  accounts: ACCOUNTS,
});

describe("Sky savings", () => {
  it("deposits USDS into sUSDS (the default USDS venue) and proves the Deposit", async () => {
    const market = mockSavings("ethereum:sky:susds");
    setBalance(market.underlying, ACCOUNT, 500n * ONE);
    const graph = await createIntent(action("deposit", "USDS", "sky"));
    const step = graph.steps[0];
    assert.equal(step?.venue, "ethereum:sky:susds");
    assert.equal(step?.title, "Deposit 100 USDS into Sky Savings USDS (sUSDS) on Ethereum");
    assert.match(step?.warnings?.join(" ") ?? "", /APY at planning \(the current on-chain supply rate\)/u);
    const txs = await prepare(graph.id);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: txs[0]?.data as Hex }).args, [market.vault.target, 100n * ONE]);
    assert.deepEqual(decodeFunctionData({ abi: VAULT_ABI, data: txs[1]?.data as Hex }).args, [100n * ONE, ACCOUNT]);
    const shares = market.toShares(100n * ONE);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[], [
      transferLog(market.token, ACCOUNT, market.vault.target, 100n * ONE),
      transferLog(market.vault.target, zeroAddress, ACCOUNT, shares),
      eventLog(market.vault.target, VAULT_ABI as Abi, "Deposit", { sender: ACCOUNT, owner: ACCOUNT, assets: 100n * ONE, shares }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("refuses an upgraded sUSDS, a proxied sDAI, a re-pointed Pot and a deposit above maxDeposit", async () => {
    mockSavings("ethereum:sky:susds", { implementation: OTHER });
    await assert.rejects(createIntent(action("deposit", "USDS", "sky")), refused("VENUE_UNVERIFIED"));
    mockSavings("ethereum:sky:susds", { pins: { usds: OTHER } });
    await assert.rejects(createIntent(action("deposit", "USDS", "sky")), refused("VENUE_UNVERIFIED"));
    mockSavings("ethereum:sky:sdai", { implementation: OTHER });
    await assert.rejects(createIntent(action("deposit", "DAI", "sky")), refused("VENUE_UNVERIFIED"));
    mockSavings("ethereum:sky:sdai", { pins: { pot: OTHER } });
    await assert.rejects(createIntent(action("deposit", "DAI", "sky")), refused("VENUE_UNVERIFIED"));
    mockSavings("ethereum:sky:sdai", { maxDeposit: ONE });
    await assert.rejects(createIntent(action("deposit", "DAI", "sky")), refused("RESERVE_UNAVAILABLE"));
  });

  it("withdraws DAI from sDAI: the DaiJoin mints it to the account, and the proof accepts that mint", async () => {
    const market = mockSavings("ethereum:sky:sdai", { shares: 200n * ONE });
    const graph = await createIntent(action("withdraw", "DAI", "sky", undefined, "50"));
    assert.equal(graph.steps[0]?.venue, "ethereum:sky:sdai");
    const txs = await prepare(graph.id);
    const call = decodeFunctionData({ abi: VAULT_ABI, data: txs[0]?.data as Hex });
    assert.equal(call.functionName, "withdraw");
    assert.deepEqual(call.args, [50n * ONE, ACCOUNT, ACCOUNT]);
    const burned = market.toShares(50n * ONE);
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[
      transferLog(market.vault.target, ACCOUNT, zeroAddress, burned),
      transferLog(market.token, zeroAddress, ACCOUNT, 50n * ONE),
      eventLog(market.vault.target, VAULT_ABI as Abi, "Withdraw", { sender: ACCOUNT, receiver: ACCOUNT, owner: ACCOUNT, assets: 50n * ONE, shares: burned }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });
});

describe("Ethena sUSDe", () => {
  it("deposits USDe with the live cooldown in the warnings", async () => {
    const market = mockSavings("ethereum:ethena:susde", { cooldown: 7 * 86_400 });
    setBalance(market.underlying, ACCOUNT, 500n * ONE);
    const graph = await createIntent(action("deposit", "USDe", "ethena"));
    const step = graph.steps[0];
    assert.equal(step?.venue, "ethereum:ethena:susde");
    assert.match(step?.warnings?.join(" ") ?? "", /sUSDe has no instant exit through Kletia: Ethena's cooldown is 7 days right now/u);
    const txs = await prepare(graph.id);
    assert.deepEqual(decodeFunctionData({ abi: VAULT_ABI, data: txs[1]?.data as Hex }).args, [100n * ONE, ACCOUNT]);
  });

  it("refuses a re-pointed silo and never serves a withdrawal", async () => {
    mockSavings("ethereum:ethena:susde", { pins: { silo: OTHER } });
    await assert.rejects(createIntent(action("deposit", "USDe", "ethena")), refused("VENUE_UNVERIFIED"));
    const usde = await resolveAsset("ethereum", "USDe");
    const route = { kind: "withdraw" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const, input: usde, output: usde };
    assert.equal((ethenaAdapter as ProtocolAdapter).supports(route), false, "sUSDe is listed for deposits only");
    assert.equal((ethenaAdapter as ProtocolAdapter).supports({ ...route, kind: "deposit" }), true);
    assert.deepEqual(candidateAdapters(route, undefined, "ethena"), []);
  });

  it("words the exit warning for a cooldown that is off, one day or fractional", () => {
    assert.match(ethenaExitWarning(0), /cooldown is off right now, but it can be switched back on/u);
    assert.match(ethenaExitWarning(86_400), /cooldown is 1 day right now/u);
    assert.match(ethenaExitWarning(129_600), /cooldown is 1\.50 days right now/u);
  });
});

describe("Sky and Ethena positions", () => {
  it("reports sUSDe as held with nothing withdrawable now", async () => {
    mockSavings("ethereum:ethena:susde", { shares: 80n * ONE });
    const position = await (ethenaAdapter as ProtocolAdapter).positionOf?.(venue("ethereum:ethena:susde"), parseAccountId(ACCOUNTS[0])!);
    assert.equal(position?.underlying.amount, (100n * ONE).toString());
    assert.equal(position?.withdrawableNow?.amount, "0");
  });
});
