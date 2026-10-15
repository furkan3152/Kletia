/**
 * More EVM liquid staking on Ethereum: Stader (ETHx), Mantle (mETH) and Frax
 * Ether (sfrxETH) against in-process contract state: provenance pins, pause /
 * health / allowlist / limit refusals, Mantle's on-chain minimum, exact
 * transactions, log proofs held to the floor and LST positions valued through
 * each protocol's own rate.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, type EvmTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resolveAsset } from "../assets.js";
import { FRAX_MINTER_ABI, fraxAdapter, fraxVenue, SFRXETH_ABI } from "../adapters/staking/frax.js";
import { readLstPositions, STAKE_TOLERANCE_BPS, STAKING_VENUES } from "../adapters/staking/index.js";
import { MANTLE_PAUSER_ABI, MANTLE_STAKING_ABI, mantleAdapter, mantleVenue } from "../adapters/staking/mantle.js";
import { STADER_CONFIG_ABI, STADER_MANAGER_ABI, staderAdapter, staderVenue } from "../adapters/staking/stader.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import type { LandedEvmReceipt } from "../adapters/verification.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, eventLog, type LogFixture, installLendingChain, landPrepared, Revert, setBalance, transferLog, type Handler, type LendingChain, type TokenState } from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const ONE = 10n ** 18n;
const OTHER = "0x6666666666666666666666666666666666666666";
// Pins (packages/core/src/protocols.ts VENUE_CONTRACTS), checked against the registry below.
const STADER_MANAGER = "0xcf5EA1b38380f6aF39068375516Daf40Ed70D299";
const STADER_CONFIG = "0x4ABEF2263d5A5ED582FC9A9789a41D85b68d69DB";
const ETHX = "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b";
const MANTLE_STAKING = "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f";
const METH = "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa";
const MANTLE_PAUSER = "0x29Ab878aEd032e2e2c86FF4A9a9B05e3276cf1f8";
const FRAX_MINTER = "0xbAFA44EFE7901E04E39Dad13167D089C559c1138";
const FRXETH = "0x5E8422345238F34275888049021821E8E08CAa1f";
const SFRXETH = "0xac3E018457B222d93114458476f3E3416Abbe38F";

const adapters = [staderAdapter, mantleAdapter, fraxAdapter] as ProtocolAdapter[];
let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters });
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n * ONE);
});
afterEach(() => chain.restore());

function lstToken(address: string, symbol: string, abi: Abi, handlers: Record<string, Handler>): TokenState {
  const state: TokenState = { balances: new Map(), allowances: new Map(), totalSupply: 0n, symbol, decimals: 18 };
  chain.contract(address, [...erc20Abi, ...abi] as Abi, {
    balanceOf: ([owner]) => state.balances.get(String(owner).toLowerCase()) ?? 0n,
    symbol: () => symbol,
    decimals: () => 18,
    totalSupply: () => state.totalSupply,
    ...handlers,
  });
  return state;
}

function refused(code: string, message?: RegExp) {
  return (error: unknown) => error instanceof PlatformError && error.code === code && (!message || message.test(error.message));
}

async function prepare(id: string): Promise<EvmTransactionRequest[]> {
  return (await prepareStep(id, "s1")).payload.transactions as EvmTransactionRequest[];
}

/** A landed call to `data` with `value` and these logs, for the venues' proof functions. */
function landed(data: Hex, value: bigint, logs: readonly LogFixture[]): LandedEvmReceipt {
  return { input: data, value, logs: logs.map((log, index) => ({ ...log, logIndex: index, blockNumber: 1n, transactionHash: `0x${"1".repeat(64)}`, transactionIndex: 0, blockHash: `0x${"2".repeat(64)}`, removed: false })) } as unknown as LandedEvmReceipt;
}

const less = (value: bigint) => (value * (10_000n - STAKE_TOLERANCE_BPS)) / 10_000n;

/** ETHx: 1 ETH = 0.9 ETHx; min 0.0001 ETH, max 10,000 ETH per deposit. */
function mockStader(options: { paused?: boolean; healthy?: boolean; ethx?: string; config?: string; simulated?: bigint } = {}) {
  chain.contract(STADER_MANAGER, STADER_MANAGER_ABI as Abi, {
    staderConfig: () => options.config ?? STADER_CONFIG,
    paused: () => options.paused ?? false,
    isVaultHealthy: () => options.healthy ?? true,
    previewDeposit: ([amount]) => (amount * 9n) / 10n,
    convertToAssets: ([shares]) => (shares * 10n) / 9n,
    deposit: (_args, call) => options.simulated ?? (call.value * 9n) / 10n,
  });
  chain.contract(STADER_CONFIG, STADER_CONFIG_ABI as Abi, {
    getETHxToken: () => options.ethx ?? ETHX,
    getStakePoolManager: () => STADER_MANAGER,
    getMinDepositAmount: () => ONE / 10_000n,
    getMaxDepositAmount: () => 10_000n * ONE,
  });
  return lstToken(ETHX, "ETHx", [], {});
}

/** mETH: 1 ETH = 0.9 mETH; min 0.02 ETH; stake(min) reverts below its minimum. */
function mockMantle(options: { paused?: boolean; allowlist?: boolean; pauser?: string; supply?: bigint; cap?: bigint; rateAtInclusion?: bigint } = {}) {
  const token = lstToken(METH, "mETH", [], {});
  token.totalSupply = options.supply ?? 200_000n * ONE;
  chain.contract(MANTLE_STAKING, MANTLE_STAKING_ABI as Abi, {
    mETH: () => METH,
    pauser: () => options.pauser ?? MANTLE_PAUSER,
    isStakingAllowlist: () => options.allowlist ?? false,
    minimumStakeBound: () => ONE / 50n,
    maximumMETHSupply: () => options.cap ?? 3_000_000n * ONE,
    ethToMETH: ([amount]) => (amount * 9n) / 10n,
    mETHToETH: ([amount]) => (amount * 10n) / 9n,
    stake: ([minimum], call) => {
      const minted = (call.value * (options.rateAtInclusion ?? 9n * 10n ** 17n)) / ONE;
      if (minted < minimum) throw new Revert("0x");
      return undefined;
    },
  });
  chain.contract(MANTLE_PAUSER, MANTLE_PAUSER_ABI as Abi, { isStakingPaused: () => options.paused ?? false });
  return token;
}

/** sfrxETH: 1 frxETH = 0.85 sfrxETH. */
function mockFrax(options: { paused?: boolean; sfrxeth?: string; asset?: string; simulated?: bigint } = {}) {
  chain.contract(FRAX_MINTER, FRAX_MINTER_ABI as Abi, {
    submitPaused: () => options.paused ?? false,
    frxETHToken: () => FRXETH,
    sfrxETHToken: () => options.sfrxeth ?? SFRXETH,
    submitAndDeposit: (_args, call) => options.simulated ?? (call.value * 85n) / 100n,
  });
  return lstToken(SFRXETH, "sfrxETH", SFRXETH_ABI as Abi, {
    asset: () => options.asset ?? FRXETH,
    previewDeposit: ([amount]) => (amount * 85n) / 100n,
    convertToAssets: ([shares]) => (shares * 100n) / 85n,
  });
}

describe("registry pins", () => {
  it("the fixtures use the registry's pinned addresses and the asset rows match the minted tokens", async () => {
    const { venueContracts } = await import("@kletia/core");
    const pin = (protocol: Parameters<typeof venueContracts>[0], role: Parameters<typeof venueContracts>[2]) => venueContracts(protocol, "ethereum", role).map((address) => getAddress(address));
    assert.deepEqual(pin("stader", "deposit-target"), [getAddress(STADER_MANAGER)]);
    assert.deepEqual(pin("stader", "config"), [getAddress(STADER_CONFIG)]);
    assert.deepEqual(pin("stader", "lst-token"), [getAddress(ETHX)]);
    assert.deepEqual(pin("mantle-lsp", "deposit-target"), [getAddress(MANTLE_STAKING)]);
    assert.deepEqual(pin("mantle-lsp", "lst-token"), [getAddress(METH)]);
    assert.deepEqual(pin("mantle-lsp", "pauser"), [getAddress(MANTLE_PAUSER)]);
    assert.deepEqual(pin("frax-ether", "deposit-target"), [getAddress(FRAX_MINTER)]);
    assert.deepEqual(pin("frax-ether", "underlying-token"), [getAddress(FRXETH)]);
    assert.deepEqual(pin("frax-ether", "lst-token"), [getAddress(SFRXETH)]);
    for (const [symbol, address] of [["ETHx", ETHX], ["mETH", METH], ["sfrxETH", SFRXETH]] as const) {
      assert.equal(getAddress((await resolveAsset("ethereum", symbol)).address as string), getAddress(address));
    }
    assert.deepEqual(STAKING_VENUES.map((venue) => venue.protocol), ["lido", "rocket-pool", "etherfi", "stader", "mantle-lsp", "frax-ether"]);
  });
});

describe("Stader", () => {
  it("deposits for the account, dry-runs the deposit and proves Deposited plus the ETHx mint", async () => {
    mockStader();
    const graph = await createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "stader");
    assert.equal(step?.title, "Stake 1 ETH with Stader for ETHx on Ethereum");
    const expected = (9n * ONE) / 10n;
    assert.equal(step?.expectedOutput?.amount, expected.toString());
    assert.equal(step?.minimumOutput?.amount, less(expected).toString());
    assert.match(step?.warnings?.join(" ") ?? "", /Kletia does not unstake ETHx/u);
    const txs = await prepare(graph.id);
    assert.equal(txs.length, 1);
    assert.equal(txs[0]?.to, getAddress(STADER_MANAGER));
    assert.equal(txs[0]?.value, ONE.toString());
    assert.deepEqual(decodeFunctionData({ abi: STADER_MANAGER_ABI, data: txs[0]?.data as Hex }).args, [ACCOUNT]);
    assert.ok(chain.calls.some((call) => call.functionName === "deposit" && call.to === STADER_MANAGER.toLowerCase()), "prepare dry-runs the deposit");
    const deposited = eventLog(STADER_MANAGER, STADER_MANAGER_ABI as Abi, "Deposited", { caller: ACCOUNT, owner: ACCOUNT, assets: ONE, shares: expected });
    const noEvent = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[transferLog(ETHX, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(noEvent.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a mint without the manager's Deposited event is not proof");
    const low = await createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS });
    const lowMint = expected / 2n;
    const lowDone = await submitStep(low.id, "s1", landPrepared(chain, await prepare(low.id), [[
      eventLog(STADER_MANAGER, STADER_MANAGER_ABI as Abi, "Deposited", { caller: ACCOUNT, owner: ACCOUNT, assets: ONE, shares: lowMint }),
      transferLog(ETHX, zeroAddress, ACCOUNT, lowMint),
    ]]));
    assert.equal(lowDone.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a mint below the floor fails");
    const ok = await createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS });
    const done = await submitStep(ok.id, "s1", landPrepared(chain, await prepare(ok.id), [[deposited, transferLog(ETHX, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, expected.toString());
  });

  it("refuses a deposit to another receiver (the service binding first, the proof as well)", async () => {
    mockStader();
    const graph = await createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS });
    const txs = await prepare(graph.id);
    const other = encodeFunctionData({ abi: STADER_MANAGER_ABI, functionName: "deposit", args: [OTHER] });
    const tampered = txs.map((tx) => ({ ...tx, data: other }));
    await assert.rejects(submitStep(graph.id, "s1", landPrepared(chain, tampered, [[]])), refused("REFERENCE_MISMATCH"));
    const minted = (9n * ONE) / 10n;
    const proof = staderVenue.prove(graph.steps[0]!, landed(other, ONE, [
      eventLog(STADER_MANAGER, STADER_MANAGER_ABI as Abi, "Deposited", { caller: ACCOUNT, owner: OTHER, assets: ONE, shares: minted }),
      transferLog(ETHX, zeroAddress, ACCOUNT, minted),
    ]), ACCOUNT);
    assert.ok("failure" in proof && /deposit\(account\)/u.test(proof.failure));
  });

  it("refuses when paused, unhealthy, re-pointed, outside the deposit limits or when the dry run mints below the floor", async () => {
    mockStader({ paused: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /paused/u));
    mockStader({ healthy: false });
    await assert.rejects(createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /unhealthy/u));
    mockStader({ ethx: OTHER });
    await assert.rejects(createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockStader({ config: OTHER });
    await assert.rejects(createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockStader();
    await assert.rejects(createIntent({ text: "stake 0.00001 ETH with stader", accounts: ACCOUNTS }), refused("AMOUNT_TOO_SMALL", /at least 0\.0001 ETH/u));
    chain.nativeBalances.set(ACCOUNT.toLowerCase(), 20_000n * ONE);
    await assert.rejects(createIntent({ text: "stake 10001 ETH with stader", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /at most 10,?000 ETH/u));
    mockStader({ simulated: ONE / 2n });
    const graph = await createIntent({ text: "stake 1 ETH with stader", accounts: ACCOUNTS });
    await assert.rejects(prepare(graph.id), refused("SIMULATION_FAILED"));
  });
});

describe("Mantle", () => {
  it("encodes the guaranteed output as stake(minMETHAmount) (an on-chain floor) and proves Staked plus the mETH mint", async () => {
    mockMantle();
    const graph = await createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "mantle-lsp");
    const expected = (9n * ONE) / 10n;
    const minimum = less(expected);
    assert.equal(step?.expectedOutput?.amount, expected.toString());
    assert.equal(step?.minimumOutput?.amount, minimum.toString());
    const txs = await prepare(graph.id);
    assert.equal(txs[0]?.to, getAddress(MANTLE_STAKING));
    const decoded = decodeFunctionData({ abi: MANTLE_STAKING_ABI, data: txs[0]?.data as Hex });
    assert.equal(decoded.functionName, "stake");
    assert.deepEqual(decoded.args, [minimum], "the call's own minimum is the step's minimum");
    const staked = eventLog(MANTLE_STAKING, MANTLE_STAKING_ABI as Abi, "Staked", { staker: ACCOUNT, ethAmount: ONE, mETHAmount: expected });
    const noEvent = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[transferLog(METH, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(noEvent.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a mint without Staked is not proof");
    const ok = await createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS });
    const done = await submitStep(ok.id, "s1", landPrepared(chain, await prepare(ok.id), [[staked, transferLog(METH, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, expected.toString());
  });

  it("plans with floor onchain and the dry run reverts when the rate falls below the encoded minimum", async () => {
    mockMantle();
    const eth = await resolveAsset("ethereum", "ETH");
    const meth = await resolveAsset("ethereum", "mETH");
    const account = parseAccountId(ACCOUNTS[0])!;
    const action = { kind: "stake" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const, input: eth, output: meth, amount: ONE.toString(), account, recipient: account, slippageBps: 50 };
    const planned = await (mantleAdapter as ProtocolAdapter).plan(action);
    assert.equal(planned.floor, "onchain");
    mockStader();
    const staderPlanned = await (staderAdapter as ProtocolAdapter).plan({ ...action, output: await resolveAsset("ethereum", "ETHx") });
    assert.equal(staderPlanned.floor, "claimed", "Stader takes no on-chain minimum");
    mockMantle({ rateAtInclusion: 8n * 10n ** 17n });
    const graph = await createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS });
    await assert.rejects(prepare(graph.id), (error: unknown) => error instanceof PlatformError && error.code === "SIMULATION_FAILED");
  });

  it("refuses when paused, allowlisted, re-pointed, below the minimum stake or past the supply cap", async () => {
    mockMantle({ paused: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /paused/u));
    mockMantle({ allowlist: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /allowlisted/u));
    mockMantle({ pauser: OTHER });
    await assert.rejects(createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockMantle();
    await assert.rejects(createIntent({ text: "stake 0.01 ETH with mantle", accounts: ACCOUNTS }), refused("AMOUNT_TOO_SMALL", /at least 0\.02 ETH/u));
    mockMantle({ supply: 3_000_000n * ONE - ONE / 2n });
    await assert.rejects(createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /supply cap/u));
  });

  it("does not accept stake(0) (no on-chain minimum) or a Staked event for another amount as proof", async () => {
    mockMantle();
    const graph = await createIntent({ text: "stake 1 ETH with mantle", accounts: ACCOUNTS });
    const step = graph.steps[0]!;
    const expected = (9n * ONE) / 10n;
    const logs = (minted: bigint) => [
      eventLog(MANTLE_STAKING, MANTLE_STAKING_ABI as Abi, "Staked", { staker: ACCOUNT, ethAmount: ONE, mETHAmount: minted }),
      transferLog(METH, zeroAddress, ACCOUNT, minted),
    ];
    const zero = mantleVenue.prove(step, landed(encodeFunctionData({ abi: MANTLE_STAKING_ABI, functionName: "stake", args: [0n] }), ONE, logs(expected)), ACCOUNT);
    assert.ok("failure" in zero && /no on-chain minimum/u.test(zero.failure));
    const data = encodeFunctionData({ abi: MANTLE_STAKING_ABI, functionName: "stake", args: [less(expected)] });
    const mismatch = mantleVenue.prove(step, landed(data, ONE, [logs(expected)[0]!, transferLog(METH, zeroAddress, ACCOUNT, expected - 1n)]), ACCOUNT);
    assert.ok("failure" in mismatch, "Staked must report the minted amount");
    const ok = mantleVenue.prove(step, landed(data, ONE, logs(expected)), ACCOUNT);
    assert.ok(!("failure" in ok) && ok.minted === expected);
  });
});

describe("Frax", () => {
  it("submits and deposits for the account and proves ETHSubmitted, the vault Deposit and the sfrxETH mint", async () => {
    mockFrax();
    const graph = await createIntent({ text: "stake 1 ETH with frax", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "frax-ether");
    const expected = (85n * ONE) / 100n;
    assert.equal(step?.expectedOutput?.amount, expected.toString());
    assert.equal(step?.minimumOutput?.amount, less(expected).toString());
    assert.match(step?.warnings?.join(" ") ?? "", /frxETH, which Frax mints 1:1/u);
    assert.match(step?.warnings?.join(" ") ?? "", /Kletia does not unstake sfrxETH: .*cannot swap sfrxETH back yet/u, "no swap exit is offered for an unpriced token");
    assert.doesNotMatch(step?.warnings?.join(" ") ?? "", /swap 1 sfrxETH/u);
    const txs = await prepare(graph.id);
    assert.equal(txs[0]?.to, getAddress(FRAX_MINTER));
    assert.deepEqual(decodeFunctionData({ abi: FRAX_MINTER_ABI, data: txs[0]?.data as Hex }).args, [ACCOUNT]);
    const submitted = eventLog(FRAX_MINTER, FRAX_MINTER_ABI as Abi, "ETHSubmitted", { sender: ACCOUNT, recipient: FRAX_MINTER, sent_amount: ONE, withheld_amt: 0n });
    const deposit = eventLog(SFRXETH, SFRXETH_ABI as Abi, "Deposit", { caller: FRAX_MINTER, owner: ACCOUNT, assets: ONE, shares: expected });
    const noDeposit = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[submitted, transferLog(SFRXETH, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(noDeposit.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a mint without the vault Deposit is not proof");
    const ok = await createIntent({ text: "stake 1 ETH with frax", accounts: ACCOUNTS });
    const done = await submitStep(ok.id, "s1", landPrepared(chain, await prepare(ok.id), [[submitted, deposit, transferLog(SFRXETH, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("refuses when minting is paused, the vault is re-pointed or the dry run mints below the floor", async () => {
    mockFrax({ paused: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with frax", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /paused/u));
    mockFrax({ sfrxeth: OTHER });
    await assert.rejects(createIntent({ text: "stake 1 ETH with frax", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockFrax({ asset: OTHER });
    await assert.rejects(createIntent({ text: "stake 1 ETH with frax", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockFrax({ simulated: ONE / 2n });
    const graph = await createIntent({ text: "stake 1 ETH with frax", accounts: ACCOUNTS });
    await assert.rejects(prepare(graph.id), refused("SIMULATION_FAILED"));
  });

  it("does not accept an ETHSubmitted to another recipient or a Deposit for another owner as proof", async () => {
    mockFrax();
    const graph = await createIntent({ text: "stake 1 ETH with frax", accounts: ACCOUNTS });
    const step = graph.steps[0]!;
    const minted = (85n * ONE) / 100n;
    const data = encodeFunctionData({ abi: FRAX_MINTER_ABI, functionName: "submitAndDeposit", args: [ACCOUNT] });
    const submitted = (recipient: string) => eventLog(FRAX_MINTER, FRAX_MINTER_ABI as Abi, "ETHSubmitted", { sender: ACCOUNT, recipient, sent_amount: ONE, withheld_amt: 0n });
    const deposit = (owner: string) => eventLog(SFRXETH, SFRXETH_ABI as Abi, "Deposit", { caller: FRAX_MINTER, owner, assets: ONE, shares: minted });
    const mint = transferLog(SFRXETH, zeroAddress, ACCOUNT, minted);
    assert.ok("failure" in fraxVenue.prove(step, landed(data, ONE, [submitted(ACCOUNT), deposit(ACCOUNT), mint]), ACCOUNT), "frxETH goes to the minter, not the account");
    assert.ok("failure" in fraxVenue.prove(step, landed(data, ONE, [submitted(FRAX_MINTER), deposit(OTHER), mint]), ACCOUNT));
    const ok = fraxVenue.prove(step, landed(data, ONE, [submitted(FRAX_MINTER), deposit(ACCOUNT), mint]), ACCOUNT);
    assert.ok(!("failure" in ok) && ok.minted === minted);
  });

  it("serves only native ETH into sfrxETH", async () => {
    mockFrax();
    const route = { kind: "stake" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const };
    const eth = await resolveAsset("ethereum", "ETH");
    const weth = await resolveAsset("ethereum", "WETH");
    const sfrxeth = await resolveAsset("ethereum", "sfrxETH");
    const meth = await resolveAsset("ethereum", "mETH");
    const frax = fraxAdapter as ProtocolAdapter;
    assert.equal(frax.supports({ ...route, input: eth, output: sfrxeth }), true);
    assert.equal(frax.supports({ ...route, input: weth, output: sfrxeth }), false);
    assert.equal(frax.supports({ ...route, input: eth, output: meth }), false);
  });
});

describe("LST positions (ETHx, mETH, sfrxETH)", () => {
  it("values ETHx, mETH and sfrxETH through each protocol's own rate", async () => {
    const ethx = mockStader();
    const meth = mockMantle();
    const sfrxeth = mockFrax();
    // Lido, Rocket Pool and ether.fi tokens hold nothing.
    for (const [address, symbol] of [["0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "wstETH"], ["0xae78736Cd615f374D3085123A210448E74Fc6393", "rETH"], ["0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", "weETH"]] as const) {
      lstToken(address, symbol, [], {});
    }
    setBalance(ethx, ACCOUNT, 9n * ONE);
    setBalance(meth, ACCOUNT, 18n * ONE / 10n);
    setBalance(sfrxeth, ACCOUNT, 17n * ONE / 10n);
    const positions = await readLstPositions(parseAccountId(ACCOUNTS[0])!);
    assert.deepEqual(positions.map((position) => position.venue), ["ethereum:stader:ETHx", "ethereum:mantle-lsp:mETH", "ethereum:frax-ether:sfrxETH"]);
    assert.deepEqual(positions.map((position) => position.underlying.amount), [10n * ONE, 2n * ONE, 2n * ONE].map(String));
    assert.ok(positions.every((position) => position.underlying.symbol === "ETH" && position.withdrawableNow === null));
    assert.ok(chain.calls.some((call) => call.functionName === "convertToAssets" && call.to === STADER_MANAGER.toLowerCase()), "ETHx is valued by the Stader manager");
    assert.ok(chain.calls.some((call) => call.functionName === "mETHToETH" && call.to === MANTLE_STAKING.toLowerCase()), "mETH is valued by the Mantle Staking contract");
  });
});
