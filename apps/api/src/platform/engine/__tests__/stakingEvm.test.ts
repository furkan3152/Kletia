/**
 * EVM liquid staking on Ethereum (Lido, Rocket Pool, ether.fi) against
 * in-process contract state: provenance (Lido's stETH pointers, Rocket
 * Pool's storage-resolved deposit pool, the ether.fi DepositAdapter's
 * pointers), pause / limit / minimum / fee reads, exact transactions,
 * log proofs held to the floor, the no-unstake warning and LST positions.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, type EvmTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resolveAsset } from "../assets.js";
import { ETHERFI_ADAPTER_ABI, ETHERFI_POOL_ABI, etherfiAdapter, WEETH_ABI } from "../adapters/staking/etherfi.js";
import { readLstPositions } from "../adapters/staking/index.js";
import { LIDO_LOCATOR_ABI, lidoAdapter, STETH_ABI, WSTETH_ABI } from "../adapters/staking/lido.js";
import { RETH_ABI, ROCKET_DEPOSIT_POOL_ABI, ROCKET_SETTINGS_ABI, ROCKET_STORAGE_ABI, rocketKey, rocketPoolAdapter } from "../adapters/staking/rocketPool.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, eventLog, installLendingChain, landPrepared, setBalance, transferLog, type Handler, type LendingChain, type TokenState } from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const ONE = 10n ** 18n;
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const LOCATOR = "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb";
const STORAGE = "0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46";
const DEPOSIT_POOL = "0xCE15294273CFb9D9b628F4D61636623decDF4fdC";
const RETH = "0xae78736Cd615f374D3085123A210448E74Fc6393";
const RP_SETTINGS = "0x227b4cfd61bd0e4bbdc79d0e3b8bcb2f22ecc365";
const ADAPTER = "0xcfC6d9Bd7411962Bfe7145451A7EF71A24b6A7A2";
const POOL = "0x308861A430be4cce5502d0A12724771Fc6DaF216";
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const EETH = "0x35fA164735182de50811E8e2E824cFb9B6118ac2";

const adapters = [lidoAdapter, rocketPoolAdapter, etherfiAdapter] as ProtocolAdapter[];
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters });
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n * ONE);
});
afterEach(() => chain.restore());

/** An ERC-20 balance book plus the token's own view functions at one address. */
function lstToken(address: string, symbol: string, abi: Abi, handlers: Record<string, Handler>): TokenState {
  const state: TokenState = { balances: new Map(), allowances: new Map(), totalSupply: 0n, symbol, decimals: 18 };
  chain.contract(address, [...erc20Abi, ...abi] as Abi, {
    balanceOf: ([owner]) => state.balances.get(String(owner).toLowerCase()) ?? 0n,
    symbol: () => symbol,
    decimals: () => 18,
    ...handlers,
  });
  return state;
}

function refused(code: string) {
  return (error: unknown) => error instanceof PlatformError && error.code === code;
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

/** wstETH: 1 stETH = 0.8 wstETH. */
function mockLido(options: { paused?: boolean; limit?: bigint; stETH?: string } = {}) {
  const wsteth = lstToken(WSTETH, "wstETH", WSTETH_ABI as Abi, {
    stETH: () => options.stETH ?? STETH,
    getWstETHByStETH: ([amount]) => (amount * 8n) / 10n,
    getStETHByWstETH: ([amount]) => (amount * 10n) / 8n,
    receive: () => undefined,
  });
  chain.contract(STETH, STETH_ABI as Abi, {
    isStakingPaused: () => options.paused ?? false,
    getCurrentStakeLimit: () => options.limit ?? 150_000n * ONE,
  });
  chain.contract(LOCATOR, LIDO_LOCATOR_ABI as Abi, { lido: () => STETH });
  return wsteth;
}

/** rETH: 1 ETH = 0.85 rETH, fee 0.05%. */
function mockRocket(options: { depositPool?: string; enabled?: boolean; minimum?: bigint } = {}) {
  const resolved: Record<string, string> = {
    [rocketKey("rocketDepositPool")]: options.depositPool ?? DEPOSIT_POOL,
    [rocketKey("rocketTokenRETH")]: RETH,
    [rocketKey("rocketDAOProtocolSettingsDeposit")]: RP_SETTINGS,
  };
  chain.contract(STORAGE, ROCKET_STORAGE_ABI as Abi, { getAddress: ([key]) => resolved[String(key)] ?? zeroAddress });
  chain.contract(RP_SETTINGS, ROCKET_SETTINGS_ABI as Abi, {
    getDepositEnabled: () => options.enabled ?? true,
    getMinimumDeposit: () => options.minimum ?? ONE / 100n,
    getDepositFee: () => ONE / 2000n,
  });
  chain.contract(DEPOSIT_POOL, ROCKET_DEPOSIT_POOL_ABI as Abi, { getMaximumDepositAmount: () => 6_000_000n * ONE, deposit: () => undefined });
  return lstToken(RETH, "rETH", RETH_ABI as Abi, {
    getRethValue: ([amount]) => (amount * 85n) / 100n,
    getEthValue: ([amount]) => (amount * 100n) / 85n,
  });
}

/** weETH: 1 eETH = 0.9 weETH. */
function mockEtherfi(options: { paused?: boolean; weETH?: string; simulated?: bigint } = {}) {
  chain.contract(ADAPTER, ETHERFI_ADAPTER_ABI as Abi, {
    weETH: () => options.weETH ?? WEETH,
    eETH: () => EETH,
    liquidityPool: () => POOL,
    depositETHForWeETH: (_args, call) => options.simulated ?? ((call.value - 2n) * 9n) / 10n,
  });
  chain.contract(POOL, ETHERFI_POOL_ABI as Abi, { paused: () => options.paused ?? false });
  return lstToken(WEETH, "weETH", WEETH_ABI as Abi, {
    getWeETHByeETH: ([amount]) => (amount * 9n) / 10n,
    getEETHByWeETH: ([amount]) => (amount * 10n) / 9n,
  });
}

describe("Lido", () => {
  it("stakes with {to: wstETH, value, data: 0x}, warns that it does not unstake and proves Submitted plus the wstETH mint", async () => {
    mockLido();
    const graph = await createIntent({ text: "stake 1 ETH with lido", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "lido");
    assert.equal(step?.network, "ethereum");
    assert.equal(step?.title, "Stake 1 ETH with Lido for wstETH on Ethereum");
    assert.equal(step?.expectedOutput?.amount, (8n * ONE / 10n).toString());
    assert.equal(step?.minimumOutput?.amount, ((8n * ONE / 10n) * 9995n / 10000n).toString());
    assert.match(step?.warnings?.join(" ") ?? "", /Kletia does not unstake wstETH: .*swap 1 wstETH to ETH on ethereum/u);
    const txs = await prepare(graph.id);
    assert.equal(txs.length, 1);
    assert.deepEqual({ to: txs[0]?.to, value: txs[0]?.value, data: txs[0]?.data }, { to: getAddress(WSTETH), value: ONE.toString(), data: "0x" });
    assert.ok(chain.calls.some((call) => call.functionName === "receive" && call.to === WSTETH.toLowerCase()), "prepare dry-runs the stake");
    const minted = 8n * ONE / 10n;
    const submitted = eventLog(STETH, STETH_ABI as Abi, "Submitted", { sender: WSTETH, amount: ONE, referral: zeroAddress });
    const failing = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[transferLog(WSTETH, zeroAddress, ACCOUNT, minted)]]));
    assert.equal(failing.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a mint without stETH's Submitted event is not proof");
    const again = await createIntent({ text: "stake 1 ETH with lido", accounts: ACCOUNTS });
    const second = await prepare(again.id);
    const low = await submitStep(again.id, "s1", landPrepared(chain, second, [[submitted, transferLog(WSTETH, zeroAddress, ACCOUNT, minted / 2n)]]));
    assert.equal(low.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a mint below the floor fails");
    const third = await createIntent({ text: "stake 1 ETH with lido", accounts: ACCOUNTS });
    const ok = await submitStep(third.id, "s1", landPrepared(chain, await prepare(third.id), [[submitted, transferLog(WSTETH, zeroAddress, ACCOUNT, minted)]]));
    assert.equal(ok.steps[0]?.status, "settled", JSON.stringify(ok.steps[0]?.failure));
    assert.equal(ok.steps[0]?.actualOutput?.amount, minted.toString());
  });

  it("refuses when staking is paused, the stake limit is short or wstETH points elsewhere", async () => {
    mockLido({ paused: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with lido", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE"));
    mockLido({ limit: ONE / 2n });
    const limited = await createIntent({ text: "stake 1 ETH with lido", accounts: ACCOUNTS }).catch((error: unknown) => error);
    assert.ok(limited instanceof PlatformError && limited.code === "RESERVE_UNAVAILABLE");
    assert.match(limited.message, /stake limit/u);
    mockLido({ stETH: "0x6666666666666666666666666666666666666666" });
    await assert.rejects(createIntent({ text: "stake 1 ETH with lido", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
  });

  it("refuses a non-native input and serves only native ETH into its own token", async () => {
    mockLido();
    const weth = await resolveAsset("ethereum", "WETH");
    const wsteth = await resolveAsset("ethereum", "wstETH");
    const reth = await resolveAsset("ethereum", "rETH");
    const route = { kind: "stake" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const };
    const eth = await resolveAsset("ethereum", "ETH");
    const lido = lidoAdapter as ProtocolAdapter;
    assert.equal(lido.supports({ ...route, input: eth, output: wsteth }), true);
    assert.equal(lido.supports({ ...route, input: weth, output: wsteth }), false);
    assert.equal(lido.supports({ ...route, input: eth, output: reth }), false);
    const account = parseAccountId(ACCOUNTS[0])!;
    await assert.rejects(lido.plan({ ...route, input: weth, output: wsteth, amount: ONE.toString(), account, recipient: account, slippageBps: 50 }), refused("INTENT_UNSUPPORTED"));
  });
});

describe("Rocket Pool", () => {
  it("resolves the deposit pool from storage, applies the deposit fee and proves DepositReceived plus the rETH mint", async () => {
    mockRocket();
    const graph = await createIntent({ text: "stake 1 ETH with rocket pool", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "rocket-pool");
    const net = ONE - ONE / 2000n;
    const expected = (net * 85n) / 100n;
    assert.equal(step?.expectedOutput?.amount, expected.toString(), "getRethValue(amount - fee)");
    assert.match(step?.warnings?.join(" ") ?? "", /0\.05% deposit fee/u);
    assert.match(step?.warnings?.join(" ") ?? "", /Kletia does not unstake rETH/u);
    const txs = await prepare(graph.id);
    assert.equal(txs[0]?.to, getAddress(DEPOSIT_POOL));
    assert.equal(txs[0]?.data, "0xd0e30db0");
    assert.equal(txs[0]?.value, ONE.toString());
    const done = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[
      transferLog(RETH, zeroAddress, ACCOUNT, expected),
      eventLog(DEPOSIT_POOL, ROCKET_DEPOSIT_POOL_ABI as Abi, "DepositReceived", { from: ACCOUNT, amount: ONE, time: 1n }),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("refuses a storage-resolved deposit pool other than the pin, disabled deposits and amounts below the minimum", async () => {
    mockRocket({ depositPool: "0x7777777777777777777777777777777777777777" });
    await assert.rejects(createIntent({ text: "stake 1 ETH with rocket pool", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockRocket({ enabled: false });
    await assert.rejects(createIntent({ text: "stake 1 ETH with rocket pool", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE"));
    mockRocket();
    const small = await createIntent({ text: "stake 0.005 ETH with rocket pool", accounts: ACCOUNTS }).catch((error: unknown) => error);
    assert.ok(small instanceof PlatformError && small.code === "AMOUNT_TOO_SMALL");
    assert.match(small.message, /at least 0\.01 ETH per deposit/u);
  });
});

describe("ether.fi", () => {
  it("deposits through the pinned DepositAdapter, labels the restaking risk and proves weETH from the adapter", async () => {
    mockEtherfi();
    const graph = await createIntent({ text: "stake 1 ETH with ether.fi", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "etherfi");
    assert.match(step?.warnings?.join(" ") ?? "", /slashing risk/u);
    assert.match(step?.warnings?.join(" ") ?? "", /Kletia does not unstake weETH/u);
    const txs = await prepare(graph.id);
    assert.equal(txs[0]?.to, getAddress(ADAPTER));
    assert.deepEqual(decodeFunctionData({ abi: ETHERFI_ADAPTER_ABI, data: txs[0]?.data as Hex }).args, [zeroAddress]);
    const amount = ((ONE - 2n) * 9n) / 10n;
    const minted = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[transferLog(WEETH, zeroAddress, ACCOUNT, amount)]]));
    assert.equal(minted.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "weETH reaches the account from the adapter, not as a mint");
    const again = await createIntent({ text: "stake 1 ETH with ether.fi", accounts: ACCOUNTS });
    const done = await submitStep(again.id, "s1", landPrepared(chain, await prepare(again.id), [[
      transferLog(WEETH, zeroAddress, ADAPTER, amount),
      transferLog(WEETH, ADAPTER, ACCOUNT, amount),
    ]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("refuses when the pool is paused, the adapter points elsewhere or the dry run returns less than the floor", async () => {
    mockEtherfi({ paused: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with ether.fi", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE"));
    mockEtherfi({ weETH: "0x8888888888888888888888888888888888888888" });
    await assert.rejects(createIntent({ text: "stake 1 ETH with ether.fi", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockEtherfi({ simulated: ONE / 2n });
    const graph = await createIntent({ text: "stake 1 ETH with ether.fi", accounts: ACCOUNTS });
    await assert.rejects(prepare(graph.id), refused("SIMULATION_FAILED"));
  });
});

describe("LST positions", () => {
  it("reports wstETH, rETH and weETH balances valued in ETH, with no withdrawable amount", async () => {
    const wsteth = mockLido();
    const reth = mockRocket();
    mockEtherfi();
    setBalance(wsteth, ACCOUNT, 4n * ONE);
    setBalance(reth, ACCOUNT, 17n * ONE / 20n);
    const positions = await readLstPositions(parseAccountId(ACCOUNTS[0])!);
    assert.deepEqual(positions.map((position) => position.venue), ["ethereum:lido:wstETH", "ethereum:rocket-pool:rETH"]);
    assert.equal(positions[0]?.underlying.amount, (5n * ONE).toString());
    assert.equal(positions[0]?.underlying.symbol, "ETH");
    assert.equal(positions[0]?.rate, (125n * 10n ** 16n).toString());
    assert.equal(positions[1]?.underlying.amount, ONE.toString());
    assert.equal(positions[0]?.withdrawableNow, null);
    assert.deepEqual(await readLstPositions(parseAccountId(`eip155:8453:${ACCOUNT}`)!), [], "Ethereum only");
  });
});
