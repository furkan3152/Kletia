/**
 * EVM restaking on Ethereum: Kelp (rsETH) and Renzo (ezETH)
 * against in-process contract state: provenance pins, pause / minimum /
 * limit refusals, Kelp's on-chain minimum, exact calldata, mint proofs held
 * to the floor, the no-unstake warnings and positions valued through each
 * protocol's own rate.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress, keccak256, toHex, zeroAddress, type Abi, type Hex } from "viem";
import { parseAccountId, venueContracts, type EvmTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resolveAsset } from "../assets.js";
import { readLstPositions, STAKE_TOLERANCE_BPS } from "../adapters/staking/index.js";
import { KELP_CONFIG_ABI, KELP_ETH, KELP_ORACLE_ABI, KELP_POOL_ABI, kelpAdapter, kelpDepositData, kelpVenue } from "../adapters/staking/kelp.js";
import { RENZO_DEPOSIT_DATA, RENZO_MANAGER_ABI, RENZO_ORACLE_ABI, renzoAdapter, renzoVenue } from "../adapters/staking/renzo.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import type { LandedEvmReceipt } from "../adapters/verification.js";
import { configurePlatform, createIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { ACCOUNT, installLendingChain, landPrepared, Revert, setBalance, transferLog, type Handler, type LendingChain, type LogFixture, type TokenState } from "./lendingChain.js";

const ACCOUNTS = [`eip155:1:${ACCOUNT}`];
const ONE = 10n ** 18n;
const OTHER = "0x6666666666666666666666666666666666666666";
// Pins (packages/core/src/protocols.ts VENUE_CONTRACTS), checked against the registry below.
const KELP_POOL = "0x036676389e48133B63a802f8635AD39E752D375D";
const KELP_CONFIG = "0x947Cb49334e6571ccBFEF1f1f1178d8469D65ec7";
const KELP_ORACLE = "0x349A73444b1a310BAe67ef67973022020d70020d";
const RSETH = "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7";
const RENZO_MANAGER = "0x74a09653A083691711cF8215a6ab074BB4e99ef5";
const RENZO_ORACLE = "0x5a12796f7e7EBbbc8a402667d266d2e65A814042";
const EZETH = "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110";

let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [kelpAdapter, renzoAdapter] as ProtocolAdapter[] });
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n * ONE);
});
afterEach(() => chain.restore());

function lstToken(address: string, symbol: string, handlers: Record<string, Handler> = {}): TokenState {
  const state: TokenState = { balances: new Map(), allowances: new Map(), totalSupply: 0n, symbol, decimals: 18 };
  chain.contract(address, erc20Abi as Abi, {
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

function landed(data: Hex, value: bigint, logs: readonly LogFixture[]): LandedEvmReceipt {
  return { input: data, value, logs: logs.map((log, index) => ({ ...log, logIndex: index, blockNumber: 1n, transactionHash: `0x${"1".repeat(64)}`, transactionIndex: 0, blockHash: `0x${"2".repeat(64)}`, removed: false })) } as unknown as LandedEvmReceipt;
}

const less = (value: bigint) => (value * (10_000n - STAKE_TOLERANCE_BPS)) / 10_000n;

/** rsETH: 1 ETH = 0.92 rsETH (price 1/0.92 ETH); min 0.0001 ETH; 1,000 ETH of room; depositETH reverts below its minimum. */
function mockKelp(options: { paused?: boolean; config?: string; rseth?: string; pool?: string; oracle?: string; limit?: bigint; rateAtInclusion?: bigint } = {}) {
  const LRT_DEPOSIT_POOL = keccak256(toHex("LRT_DEPOSIT_POOL"));
  chain.contract(KELP_POOL, KELP_POOL_ABI as Abi, {
    lrtConfig: () => options.config ?? KELP_CONFIG,
    paused: () => options.paused ?? false,
    minAmountToDeposit: () => ONE / 10_000n,
    getAssetCurrentLimit: ([asset]) => (String(asset).toLowerCase() === KELP_ETH.toLowerCase() ? options.limit ?? 1_000n * ONE : 0n),
    getRsETHAmountToMint: ([, amount]) => (amount * 92n) / 100n,
    depositETH: ([minimum], call) => {
      const minted = (call.value * (options.rateAtInclusion ?? 92n * 10n ** 16n)) / ONE;
      if (minted < minimum) throw new Revert("0x");
      return undefined;
    },
  });
  chain.contract(KELP_CONFIG, KELP_CONFIG_ABI as Abi, {
    rsETH: () => options.rseth ?? RSETH,
    getContract: ([key]) => (key === LRT_DEPOSIT_POOL ? options.pool ?? KELP_POOL : options.oracle ?? KELP_ORACLE),
  });
  chain.contract(KELP_ORACLE, KELP_ORACLE_ABI as Abi, { rsETHPrice: () => (ONE * 100n) / 92n });
  return lstToken(RSETH, "rsETH");
}

/** ezETH: TVL 1,100 ETH over 1,000 ezETH, so 1 ETH mints 1000/1100 ezETH. */
function mockRenzo(options: { paused?: boolean; ezeth?: string; oracle?: string } = {}) {
  const tvl = 1_100n * ONE;
  const token = lstToken(EZETH, "ezETH");
  token.totalSupply = 1_000n * ONE;
  chain.contract(RENZO_MANAGER, RENZO_MANAGER_ABI as Abi, {
    ezETH: () => options.ezeth ?? EZETH,
    renzoOracle: () => options.oracle ?? RENZO_ORACLE,
    paused: () => options.paused ?? false,
    calculateTVLs: () => [[[tvl]], [tvl], tvl],
    depositETH: () => undefined,
  });
  chain.contract(RENZO_ORACLE, RENZO_ORACLE_ABI as Abi, {
    calculateMintAmount: ([current, added, supply]) => (added * supply) / current,
  });
  return token;
}

describe("restaking pins", () => {
  it("the fixtures use the registry's pinned addresses and the asset rows match the minted tokens", async () => {
    const pin = (protocol: "kelp" | "renzo", role: Parameters<typeof venueContracts>[2]) => venueContracts(protocol, "ethereum", role).map((address) => getAddress(address));
    assert.deepEqual(pin("kelp", "deposit-target"), [getAddress(KELP_POOL)]);
    assert.deepEqual(pin("kelp", "config"), [getAddress(KELP_CONFIG)]);
    assert.deepEqual(pin("kelp", "rate-oracle"), [getAddress(KELP_ORACLE)]);
    assert.deepEqual(pin("kelp", "lst-token"), [getAddress(RSETH)]);
    assert.deepEqual(pin("renzo", "deposit-target"), [getAddress(RENZO_MANAGER)]);
    assert.deepEqual(pin("renzo", "rate-oracle"), [getAddress(RENZO_ORACLE)]);
    assert.deepEqual(pin("renzo", "lst-token"), [getAddress(EZETH)]);
    for (const [symbol, address] of [["rsETH", RSETH], ["ezETH", EZETH]] as const) {
      assert.equal(getAddress((await resolveAsset("ethereum", symbol)).address as string), getAddress(address));
    }
  });
});

describe("Kelp", () => {
  it("encodes the guaranteed rsETH as depositETH's minimum (an on-chain floor) and proves the mint", async () => {
    mockKelp();
    const graph = await createIntent({ text: "stake 1 ETH with kelp", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "kelp");
    assert.equal(step?.title, "Stake 1 ETH with Kelp for rsETH on Ethereum");
    const expected = (92n * ONE) / 100n;
    const minimum = less(expected);
    assert.equal(step?.expectedOutput?.amount, expected.toString());
    assert.equal(step?.minimumOutput?.amount, minimum.toString());
    const warnings = step?.warnings?.join(" ") ?? "";
    assert.match(warnings, /slashing risk/u);
    assert.match(warnings, /Kletia does not unstake rsETH: .*cannot swap rsETH back yet/u, "rsETH has no price feed: no swap exit is offered");
    const txs = await prepare(graph.id);
    assert.equal(txs.length, 1);
    assert.equal(txs[0]?.to, getAddress(KELP_POOL));
    assert.equal(txs[0]?.value, ONE.toString());
    const decoded = decodeFunctionData({ abi: KELP_POOL_ABI, data: txs[0]?.data as Hex });
    assert.equal(decoded.functionName, "depositETH");
    assert.deepEqual(decoded.args, [minimum, ""], "the call's own minimum is the step's minimum");
    const low = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[transferLog(RSETH, zeroAddress, ACCOUNT, minimum - 1n)]]));
    assert.equal(low.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN", "a mint below the floor fails");
    const ok = await createIntent({ text: "stake 1 ETH with kelp", accounts: ACCOUNTS });
    const done = await submitStep(ok.id, "s1", landPrepared(chain, await prepare(ok.id), [[transferLog(RSETH, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
    assert.equal(done.steps[0]?.actualOutput?.amount, expected.toString());
  });

  it("plans with floor onchain; the dry run reverts when the rate falls below the encoded minimum", async () => {
    mockKelp();
    const eth = await resolveAsset("ethereum", "ETH");
    const account = parseAccountId(ACCOUNTS[0])!;
    const action = { kind: "stake" as const, network: "ethereum" as const, destinationNetwork: "ethereum" as const, input: eth, output: await resolveAsset("ethereum", "rsETH"), amount: ONE.toString(), account, recipient: account, slippageBps: 50 };
    assert.equal((await (kelpAdapter as ProtocolAdapter).plan(action)).floor, "onchain");
    mockKelp({ rateAtInclusion: 9n * 10n ** 17n });
    const graph = await createIntent({ text: "stake 1 ETH with kelp", accounts: ACCOUNTS });
    await assert.rejects(prepare(graph.id), refused("SIMULATION_FAILED"));
  });

  it("refuses when paused, re-pointed, below the minimum or past the deposit limit", async () => {
    mockKelp({ paused: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with kelp", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /paused/u));
    for (const repoint of [{ config: OTHER }, { rseth: OTHER }, { pool: OTHER }, { oracle: OTHER }]) {
      mockKelp(repoint);
      await assert.rejects(createIntent({ text: "stake 1 ETH with kelp", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"), JSON.stringify(repoint));
    }
    mockKelp();
    await assert.rejects(createIntent({ text: "stake 0.00001 ETH with kelp", accounts: ACCOUNTS }), refused("AMOUNT_TOO_SMALL", /at least 0\.0001 ETH/u));
    mockKelp({ limit: ONE / 2n });
    await assert.rejects(createIntent({ text: "stake 1 ETH with kelp", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /at most 0\.5 ETH/u));
  });

  it("does not accept another call, a minimum below the floor or a mint to someone else as proof", async () => {
    mockKelp();
    const graph = await createIntent({ text: "stake 1 ETH with kelp", accounts: ACCOUNTS });
    const step = graph.steps[0]!;
    const expected = (92n * ONE) / 100n;
    const mint = transferLog(RSETH, zeroAddress, ACCOUNT, expected);
    const zero = kelpVenue.prove(step, landed(kelpDepositData(0n), ONE, [mint]), ACCOUNT);
    assert.ok("failure" in zero && /below the step's guaranteed/u.test(zero.failure));
    assert.ok("failure" in kelpVenue.prove(step, landed(RENZO_DEPOSIT_DATA, ONE, [mint]), ACCOUNT));
    assert.ok("failure" in kelpVenue.prove(step, landed(kelpDepositData(less(expected)), ONE, [transferLog(RSETH, zeroAddress, OTHER, expected)]), ACCOUNT));
    const ok = kelpVenue.prove(step, landed(kelpDepositData(less(expected)), ONE, [mint]), ACCOUNT);
    assert.ok(!("failure" in ok) && ok.minted === expected);
  });
});

describe("Renzo", () => {
  it("quotes the mint with Renzo's oracle, sends depositETH() (floor claimed) and proves the ezETH mint", async () => {
    mockRenzo();
    const graph = await createIntent({ text: "stake 1 ETH with renzo", accounts: ACCOUNTS });
    const step = graph.steps[0];
    assert.equal(step?.protocol, "renzo");
    const expected = (ONE * 1_000n) / 1_100n;
    assert.equal(step?.expectedOutput?.amount, expected.toString());
    assert.equal(step?.minimumOutput?.amount, less(expected).toString());
    const warnings = step?.warnings?.join(" ") ?? "";
    assert.match(warnings, /takes no minimum output/u);
    assert.match(warnings, /Kletia does not unstake ezETH: .*swap it back \(for example "swap 1 ezETH to ETH on ethereum"\)/u, "ezETH is priced: the swap exit is offered");
    const txs = await prepare(graph.id);
    assert.equal(txs[0]?.to, getAddress(RENZO_MANAGER));
    assert.equal(txs[0]?.data, RENZO_DEPOSIT_DATA);
    assert.equal(txs[0]?.value, ONE.toString());
    assert.ok(chain.calls.some((call) => call.functionName === "depositETH" && call.to === RENZO_MANAGER.toLowerCase()), "prepare dry-runs the deposit");
    const low = await submitStep(graph.id, "s1", landPrepared(chain, txs, [[transferLog(EZETH, zeroAddress, ACCOUNT, expected / 2n)]]));
    assert.equal(low.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");
    const ok = await createIntent({ text: "stake 1 ETH with renzo", accounts: ACCOUNTS });
    const done = await submitStep(ok.id, "s1", landPrepared(chain, await prepare(ok.id), [[transferLog(EZETH, zeroAddress, ACCOUNT, expected)]]));
    assert.equal(done.steps[0]?.status, "settled", JSON.stringify(done.steps[0]?.failure));
  });

  it("refuses when paused or re-pointed, and rejects other calldata as proof", async () => {
    mockRenzo({ paused: true });
    await assert.rejects(createIntent({ text: "stake 1 ETH with renzo", accounts: ACCOUNTS }), refused("RESERVE_UNAVAILABLE", /paused/u));
    mockRenzo({ ezeth: OTHER });
    await assert.rejects(createIntent({ text: "stake 1 ETH with renzo", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockRenzo({ oracle: OTHER });
    await assert.rejects(createIntent({ text: "stake 1 ETH with renzo", accounts: ACCOUNTS }), refused("VENUE_UNVERIFIED"));
    mockRenzo();
    const graph = await createIntent({ text: "stake 1 ETH with renzo", accounts: ACCOUNTS });
    const mint = transferLog(EZETH, zeroAddress, ACCOUNT, ONE);
    assert.ok("failure" in renzoVenue.prove(graph.steps[0]!, landed(kelpDepositData(0n), ONE, [mint]), ACCOUNT));
    const ok = renzoVenue.prove(graph.steps[0]!, landed(RENZO_DEPOSIT_DATA, ONE, [mint]), ACCOUNT);
    assert.ok(!("failure" in ok) && ok.minted === ONE);
  });
});

describe("LST positions (restaking tokens)", () => {
  it("values rsETH with Kelp's oracle and ezETH with Renzo's TVL", async () => {
    const rseth = mockKelp();
    const ezeth = mockRenzo();
    for (const address of ["0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "0xae78736Cd615f374D3085123A210448E74Fc6393", "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b", "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa", "0xac3E018457B222d93114458476f3E3416Abbe38F"]) {
      lstToken(address, "LST");
    }
    setBalance(rseth, ACCOUNT, 92n * ONE / 100n);
    setBalance(ezeth, ACCOUNT, 10n * ONE);
    const positions = await readLstPositions(parseAccountId(ACCOUNTS[0])!);
    assert.deepEqual(positions.map((position) => position.venue), ["ethereum:kelp:rsETH", "ethereum:renzo:ezETH"]);
    assert.deepEqual(positions.map((position) => position.underlying.amount), [ONE - 1n, 11n * ONE].map(String));
    assert.ok(positions.every((position) => position.withdrawableNow === null));
  });
});
