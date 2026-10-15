/**
 * Direct Solana staking: SPL stake pools (Jito, Sanctum JupSOL), Marinade
 * deposits and native staking.
 *
 * Pool and state fixtures carry live values read at epoch 1058. Covered:
 * pool / state field drift refuses, a stale pool epoch refuses, a SOL
 * deposit authority refuses, expected-output math, the exact instruction
 * account lists and data, the seed-derived stake address, vote accounts
 * must be active, network minimums, and verification bound to the landed
 * instructions plus the credited output.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { CHAINS, findAssetBySymbol, getAsset, nativeAssetId, parseAccountId, type IntentStep } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resolvedFromDescriptor, type ResolvedAsset } from "../assets.js";
import {
  decodeMarinadeState,
  marinadeAdapter,
  marinadePdas,
  marinadePins,
  MARINADE_DEPOSIT_DISCRIMINATOR,
  MARINADE_STATE_DISCRIMINATOR,
  MARINADE_STATE_OFFSETS,
  msolForLamports,
} from "../adapters/marinade.js";
import {
  decodeNativeStakeQuote,
  encodeNativeStakeQuote,
  nativeStakeAddress,
  nativeStakeBindingFailure,
  solanaNativeStakeAdapter,
  stakeInitializeData,
} from "../adapters/solanaNativeStake.js";
import {
  decodeStakePool,
  jitoStakePoolAdapter,
  poolTokensForDeposit,
  poolWithdrawAuthority,
  sanctumStakePoolAdapter,
  stakePoolPins,
  STAKE_POOL_INSTRUCTION,
} from "../adapters/solanaStakePool.js";
import { readU64Le } from "../adapters/solanaStakeCommon.js";
import type { AdapterAction, ProtocolAdapter } from "../adapters/types.js";
import { isReferenceRejection } from "../adapters/verification.js";
import { decodeSolanaTransaction, type SolanaTransactionObservation } from "../chains/solana.js";
import { configurePlatform, createIntent, prepareStep } from "../service.js";
import { encodeStepRef } from "../stepRef.js";
import { MemoryIntentStore } from "../store.js";
import { randomSolanaSignature } from "./helpers.js";
import { ata, ATTACKER, installSolanaLendMock, OWNER, u64, type SolanaLendMock } from "./solanaLendFixtures.js";

const ACCOUNTS = [`solana:${CHAINS.solana.reference}:${OWNER}`];
const DEVNET_ACCOUNT = `solana:${CHAINS["solana-devnet"].reference}:${OWNER}`;
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const STAKE = "Stake11111111111111111111111111111111111111";
const EPOCH = 1058n;
const RENT = 1_666_240n;
const VOTE_1 = "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk";
const VOTE_2 = "3N7s9zXMZ4QqvHQR15t5GNHyqc89KduzMP7423eWiD5g";
const DEVNET_VOTE = "vgcDar2pryHvMgPkKaZfh8pQy4BJxv7SpwUG7zinWjG";
const NAMED_VOTE = "CertusDeBmqN8ZawdkxK5kFGMwBXdudvWHYwtNgNhvLu";

const key = (value: string) => Uint8Array.from(getAddressEncoder().encode(address(value)));

/* ------------------------------------------------------------ fixtures */

interface PoolFixture {
  readonly protocol: "jito" | "sanctum";
  readonly total: bigint;
  readonly supply: bigint;
  readonly epoch?: bigint;
  readonly mint?: string;
  readonly reserve?: string;
  readonly feeAccount?: string;
  readonly validatorList?: string;
  readonly tokenProgram?: string;
  readonly solDepositAuthority?: string;
  readonly solDepositFee?: readonly [bigint, bigint];
  readonly accountType?: number;
  readonly bump?: number;
}

const JITO: PoolFixture = { protocol: "jito", total: 10_469_806_423_056_601n, supply: 8_014_100_892_659_504n };
const JUPSOL: PoolFixture = { protocol: "sanctum", total: 5_215_621_387_911_135n, supply: 4_294_372_851_750_225n, solDepositFee: [100n, 0n] };

async function withdrawBump(protocol: "jito" | "sanctum"): Promise<number> {
  const pins = stakePoolPins(protocol);
  const [, bump] = await getProgramDerivedAddress({ programAddress: address(pins.program), seeds: [key(pins.pool), "withdraw"] });
  return bump;
}

/** A StakePool account (611 bytes, borsh layout of spl-stake-pool). */
async function stakePoolData(fixture: PoolFixture): Promise<Uint8Array> {
  const pins = stakePoolPins(fixture.protocol);
  const parts: Uint8Array[] = [];
  const fee = (pair: readonly [bigint, bigint]) => parts.push(u64(pair[0]), u64(pair[1]));
  parts.push(Uint8Array.of(fixture.accountType ?? 1));
  parts.push(key(ATTACKER), key(ATTACKER), key(ATTACKER)); // manager, staker, stake deposit authority
  parts.push(Uint8Array.of(fixture.bump ?? (await withdrawBump(fixture.protocol))));
  parts.push(
    key(fixture.validatorList ?? pins.validatorList),
    key(fixture.reserve ?? pins.reserve),
    key(fixture.mint ?? pins.mint),
    key(fixture.feeAccount ?? pins.feeAccount),
    key(fixture.tokenProgram ?? TOKEN),
  );
  parts.push(u64(fixture.total), u64(fixture.supply), u64(fixture.epoch ?? EPOCH));
  parts.push(new Uint8Array(48)); // lockup
  fee([100n, 5n]); // epoch fee
  parts.push(Uint8Array.of(1)); // next epoch fee: One(fee)
  fee([100n, 4n]);
  parts.push(Uint8Array.of(1), key(VOTE_1)); // preferred deposit validator: Some
  parts.push(Uint8Array.of(0)); // preferred withdraw validator: None
  fee([0n, 0n]); // stake deposit fee
  fee([1000n, 1n]); // stake withdrawal fee
  parts.push(Uint8Array.of(0)); // next stake withdrawal fee: None
  parts.push(Uint8Array.of(0)); // stake referral fee
  parts.push(fixture.solDepositAuthority ? Uint8Array.from([1, ...key(fixture.solDepositAuthority)]) : Uint8Array.of(0));
  fee(fixture.solDepositFee ?? [0n, 0n]);
  parts.push(Uint8Array.of(0)); // sol referral fee
  const used = parts.reduce((total, part) => total + part.length, 0);
  const data = new Uint8Array(611);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  assert.ok(used <= 611);
  return data;
}

interface MarinadeFixture {
  readonly mint?: string;
  readonly msolLeg?: string;
  readonly paused?: boolean;
  readonly minDeposit?: bigint;
  readonly cap?: bigint;
  readonly reserveBump?: number;
  readonly discriminator?: Uint8Array;
}

/** Marinade State (2,616 bytes) with the live values of 2026-10-15. */
async function marinadeStateData(fixture: MarinadeFixture = {}): Promise<Uint8Array> {
  const pins = marinadePins();
  const o = MARINADE_STATE_OFFSETS;
  const bump = async (seed: string) =>
    (await getProgramDerivedAddress({ programAddress: address(pins.program), seeds: [key(pins.state), seed] }))[1];
  const data = new Uint8Array(2616);
  data.set(fixture.discriminator ?? MARINADE_STATE_DISCRIMINATOR, 0);
  data.set(key(fixture.mint ?? pins.mint), o.msolMint);
  data[o.reserveBump] = fixture.reserveBump ?? (await bump("reserve"));
  data[o.msolMintAuthorityBump] = await bump("st_mint");
  data[o.liqPoolSolLegBump] = await bump("liq_sol");
  data[o.liqPoolMsolLegAuthorityBump] = await bump("liq_st_sol_authority");
  data.set(key(fixture.msolLeg ?? pins.msolLeg), o.liqPoolMsolLeg);
  data.set(u64(1_961_773_386_209_698n), o.totalActiveBalance);
  data.set(u64(0n), o.delayedUnstakeCoolingDown);
  data.set(u64(14_845_305_911_355n), o.emergencyCoolingDown);
  data.set(u64(307_514_500_604_303n), o.availableReserveBalance);
  data.set(u64(29_035_700_653_958n), o.circulatingTicketBalance);
  data.set(u64(1_596_813_430_892_259n), o.msolSupply);
  data.set(u64(fixture.minDeposit ?? 1n), o.minDeposit);
  data.set(u64(fixture.cap ?? (1n << 64n) - 1n), o.stakingSolCap);
  data[o.paused] = fixture.paused ? 1 : 0;
  return data;
}

/* ------------------------------------------------------------ RPC mock */

interface StakingMock extends SolanaLendMock {
  epoch: bigint;
  /** Vote accounts reported as current (voting); everything else is delinquent. */
  readonly current: Set<string>;
  readonly voteCommission: Map<string, number>;
}

function installStakingMock(): StakingMock {
  const base = installSolanaLendMock();
  const inner = globalThis.fetch;
  const mock = Object.assign(base, { epoch: EPOCH, current: new Set<string>(), voteCommission: new Map<string, number>() }) as StakingMock;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const text = typeof init?.body === "string" ? init.body : "";
    let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] } | null = null;
    try {
      body = text ? (JSON.parse(text) as typeof body) : null;
    } catch {
      body = null;
    }
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body?.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    if (body?.jsonrpc === "2.0") {
      if (body.method === "getEpochInfo") {
        return reply({ absoluteSlot: 457_000_000, blockHeight: 435_000_000, epoch: Number(mock.epoch), slotIndex: 1_000, slotsInEpoch: 432_000, transactionCount: 1 });
      }
      if (body.method === "getMinimumBalanceForRentExemption") return reply(Number(RENT));
      if (body.method === "getVoteAccounts") {
        const wanted = (body.params?.[0] as { votePubkey?: string } | undefined)?.votePubkey;
        const entry = (vote: string) => ({ votePubkey: vote, nodePubkey: ATTACKER, activatedStake: 1_000, commission: mock.voteCommission.get(vote) ?? 0, epochVoteAccount: true, epochCredits: [], lastVote: 1, rootSlot: 1 });
        const current = [...mock.current].filter((vote) => !wanted || vote === wanted).map(entry);
        return reply({ current, delinquent: [] });
      }
    }
    return inner(input, init);
  }) as typeof fetch;
  return mock;
}

/* ------------------------------------------------------------ helpers */

function asset(network: "solana" | "solana-devnet", symbol: string): ResolvedAsset {
  const descriptor = symbol === "SOL" ? getAsset(nativeAssetId(network)) : findAssetBySymbol(network, symbol);
  assert.ok(descriptor, `${symbol} on ${network}`);
  return resolvedFromDescriptor(descriptor);
}

function stakeAction(symbol: string, amount: bigint, overrides: Partial<AdapterAction> = {}): AdapterAction {
  const network = overrides.network ?? "solana";
  const account = parseAccountId(network === "solana" ? ACCOUNTS[0] as string : DEVNET_ACCOUNT);
  assert.ok(account);
  return {
    kind: "stake",
    network,
    destinationNetwork: network,
    input: asset(network, "SOL"),
    output: asset(network, symbol),
    amount: amount.toString(),
    account,
    recipient: account,
    slippageBps: 50,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, `expected PlatformError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected a refusal");
}

async function decodedPayload(adapter: ProtocolAdapter, action: AdapterAction, step: Partial<IntentStep> = {}) {
  const payload = await adapter.prepare({ graph: {} as never, step: step as IntentStep, action, now: Date.now() });
  const transaction = payload.transactions[0];
  assert.ok(transaction && transaction.vm === "svm");
  return { payload, decoded: await decodeSolanaTransaction(action.network as "solana", transaction.transaction) };
}

const tag = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);

/* ------------------------------------------------------------ tests */

describe("Solana staking adapters", () => {
  let mock: StakingMock;

  beforeEach(async () => {
    mock = installStakingMock();
    configurePlatform({ store: new MemoryIntentStore(), adapters: null });
    for (const fixture of [JITO, JUPSOL]) {
      const pins = stakePoolPins(fixture.protocol);
      mock.accounts.set(pins.pool, { owner: pins.program, data: await stakePoolData(fixture) });
    }
    mock.accounts.set(marinadePins().state, { owner: marinadePins().program, data: await marinadeStateData() });
    mock.current.add(VOTE_1).add(VOTE_2).add(DEVNET_VOTE).add(NAMED_VOTE);
  });

  afterEach(() => mock.restore());

  describe("SPL stake pools", () => {
    it("decodes the pool layout and computes the program's deposit math", async () => {
      const state = decodeStakePool(await stakePoolData(JITO));
      assert.ok(state);
      assert.equal(state.poolMint, "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
      assert.equal(state.lastUpdateEpoch, EPOCH);
      assert.equal(state.solDepositAuthority, null);
      // Live rate 1.30642 SOL/JitoSOL: 1 SOL -> 0.765448812 JitoSOL (read back by simulation, live-1.json).
      assert.deepEqual(poolTokensForDeposit(state, 1_000_000_000n), { minted: 765_448_812n, fee: 0n, user: 765_448_812n });
      const jupsol = decodeStakePool(await stakePoolData(JUPSOL));
      assert.ok(jupsol);
      assert.deepEqual(jupsol.solDepositFee, { denominator: 100n, numerator: 0n });
      assert.equal(poolTokensForDeposit(jupsol, 1_000_000_000n).user, 823_367_444n);
      // The SOL deposit fee is applied as the program does (ceiling).
      assert.deepEqual(poolTokensForDeposit({ ...state, solDepositFee: { denominator: 1_000n, numerator: 3n } }, 1_000_000_000n), {
        minted: 765_448_812n, fee: 2_296_347n, user: 763_152_465n,
      });
      assert.deepEqual(poolTokensForDeposit({ totalLamports: 0n, poolTokenSupply: 0n, solDepositFee: { denominator: 0n, numerator: 0n } }, 5n), { minted: 5n, fee: 0n, user: 5n });
      assert.equal(decodeStakePool(new Uint8Array(100)), null);
    });

    it("serves SOL -> its own LST only, on Solana mainnet", () => {
      const route = (symbol: string, network: "solana" | "solana-devnet" = "solana") => ({
        kind: "stake" as const, network, destinationNetwork: network, input: asset(network, "SOL"), output: asset("solana", symbol),
      });
      assert.equal(jitoStakePoolAdapter?.supports(route("JitoSOL")), true);
      assert.equal(jitoStakePoolAdapter?.supports(route("JupSOL")), false);
      assert.equal(sanctumStakePoolAdapter?.supports(route("JupSOL")), true);
      assert.equal(marinadeAdapter?.supports(route("mSOL")), true);
      assert.equal(marinadeAdapter?.supports(route("JitoSOL")), false);
      assert.equal(jitoStakePoolAdapter?.supports({ ...route("JitoSOL"), kind: "swap" }), false);
      assert.equal(jitoStakePoolAdapter?.supports(route("JitoSOL", "solana-devnet")), false);
    });

    it("plans at the pool rate with a 5 bps on-chain floor", async () => {
      const planned = await jitoStakePoolAdapter!.plan(stakeAction("JitoSOL", 1_000_000_000n));
      assert.equal(planned.protocol, "jito");
      assert.equal(planned.expectedOutput.amount, "765448812");
      assert.equal(planned.minimumOutput.amount, ((765_448_812n * 9_995n) / 10_000n).toString());
      assert.equal(planned.floor, "onchain");
      assert.equal(planned.quoteId, `epoch:${EPOCH}`);
      assert.match(planned.title, /Stake 1 SOL with Jito stake pool for JitoSOL/u);
    });

    it("refuses a drifted pool, a gated pool, a stale epoch and a foreign owner", async () => {
      const pins = stakePoolPins("jito");
      const action = stakeAction("JitoSOL", 1_000_000_000n);
      const set = async (fixture: Partial<PoolFixture>, owner = pins.program) =>
        mock.accounts.set(pins.pool, { owner, data: await stakePoolData({ ...JITO, ...fixture }) });
      for (const drift of [{ mint: ATTACKER }, { reserve: ATTACKER }, { feeAccount: ATTACKER }, { validatorList: ATTACKER }, { tokenProgram: SYSTEM }, { accountType: 2 }]) {
        await set(drift);
        assert.equal(await refusal(jitoStakePoolAdapter!.plan(action)), "VENUE_UNVERIFIED", JSON.stringify(drift));
      }
      await set({ solDepositAuthority: ATTACKER });
      assert.equal(await refusal(jitoStakePoolAdapter!.plan(action)), "RESERVE_UNAVAILABLE");
      await set({ epoch: EPOCH - 1n });
      assert.equal(await refusal(jitoStakePoolAdapter!.plan(action)), "RESERVE_UNAVAILABLE");
      await set({}, ATTACKER);
      assert.equal(await refusal(jitoStakePoolAdapter!.plan(action)), "VENUE_UNVERIFIED");
      // A withdraw-authority bump the derivation does not reproduce refuses at prepare.
      await set({ bump: (await withdrawBump("jito")) - 1 });
      assert.equal(await refusal(jitoStakePoolAdapter!.prepare({ graph: {} as never, step: {} as IntentStep, action, now: Date.now() })), "VENUE_UNVERIFIED");
    });

    it("refuses other shapes: another LST, a third-party recipient, zero", async () => {
      assert.equal(await refusal(jitoStakePoolAdapter!.plan(stakeAction("JupSOL", 1_000_000_000n))), "INTENT_UNSUPPORTED");
      const other = parseAccountId(`solana:${CHAINS.solana.reference}:${ATTACKER}`);
      assert.ok(other);
      assert.equal(await refusal(jitoStakePoolAdapter!.plan(stakeAction("JitoSOL", 1_000_000_000n, { recipient: other }))), "INTENT_UNSUPPORTED");
      assert.equal(await refusal(jitoStakePoolAdapter!.plan(stakeAction("JitoSOL", 0n))), "AMOUNT_TOO_SMALL");
      assert.equal(await refusal(jitoStakePoolAdapter!.plan(stakeAction("JitoSOL", 1n))), "AMOUNT_TOO_SMALL");
    });

    it("builds ATA creation + DepositSolWithSlippage with the pinned accounts in program order", async () => {
      for (const [adapter, protocol, symbol] of [[jitoStakePoolAdapter!, "jito", "JitoSOL"], [sanctumStakePoolAdapter!, "sanctum", "JupSOL"]] as const) {
        const pins = stakePoolPins(protocol);
        const { payload, decoded } = await decodedPayload(adapter, stakeAction(symbol, 1_000_000_000n));
        assert.deepEqual(decoded.signers, [OWNER]);
        assert.equal(payload.records[0]?.to, pins.program);
        const userAta = await ata(OWNER, pins.mint);
        const deposit = decoded.instructions.find((entry) => entry.program === pins.program);
        assert.ok(deposit);
        assert.deepEqual(deposit.accounts, [
          pins.pool, await poolWithdrawAuthority(pins), pins.reserve, OWNER, userAta, pins.feeAccount, userAta, pins.mint, SYSTEM, TOKEN,
        ]);
        assert.equal(deposit.data[0], STAKE_POOL_INSTRUCTION.depositSolWithSlippage);
        assert.equal(readU64Le(deposit.data, 1), 1_000_000_000n);
        assert.equal(readU64Le(deposit.data, 9)?.toString(), payload.minimumOutput.amount);
        assert.equal(deposit.data.length, 17);
        const create = decoded.instructions.find((entry) => entry.program === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
        assert.ok(create);
        assert.equal(create.accounts[1], userAta);
        assert.deepEqual(decoded.programs.filter((program) => program !== "ComputeBudget111111111111111111111111111111"), ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", pins.program]);
      }
    });

    it("refuses a prepare whose simulation fails", async () => {
      mock.simulationError = { InstructionError: [3, { Custom: 1 }] };
      const code = await refusal(jitoStakePoolAdapter!.prepare({ graph: {} as never, step: {} as IntentStep, action: stakeAction("JitoSOL", 1_000_000_000n), now: Date.now() }));
      assert.equal(code, "SIMULATION_FAILED");
    });
  });

  describe("Marinade", () => {
    it("decodes the state and computes calc_msol_from_lamports", async () => {
      // Live account discriminator (d8926b5e684bb6b1) equals sha256("account:State")[..8].
      assert.equal(Buffer.from(MARINADE_STATE_DISCRIMINATOR).toString("hex"), "d8926b5e684bb6b1");
      assert.equal(Buffer.from(MARINADE_DEPOSIT_DISCRIMINATOR).toString("hex"), createHash("sha256").update("global:deposit").digest("hex").slice(0, 16));
      const state = decodeMarinadeState(await marinadeStateData());
      assert.ok(state);
      assert.equal(state.totalVirtualStaked, 2_255_097_492_071_398n);
      // 1 SOL -> 0.708090641 mSOL, equal to the live simulation (live-1.json).
      assert.equal(msolForLamports(state, 1_000_000_000n), 708_090_641n);
      assert.equal(decodeMarinadeState(await marinadeStateData({ discriminator: new Uint8Array(8) })), null);
    });

    it("plans with a claimed floor and builds deposit with the derived accounts", async () => {
      const planned = await marinadeAdapter!.plan(stakeAction("mSOL", 1_000_000_000n));
      assert.equal(planned.expectedOutput.amount, "708090641");
      assert.equal(planned.minimumOutput.amount, ((708_090_641n * 9_995n) / 10_000n).toString());
      assert.equal(planned.floor, "claimed");
      const pins = marinadePins();
      const pdas = await marinadePdas(pins);
      const { decoded } = await decodedPayload(marinadeAdapter!, stakeAction("mSOL", 1_000_000_000n));
      assert.deepEqual(decoded.signers, [OWNER]);
      const deposit = decoded.instructions.find((entry) => entry.program === pins.program);
      assert.ok(deposit);
      assert.deepEqual(deposit.accounts, [
        pins.state, pins.mint, pdas.solLeg, pins.msolLeg, pdas.msolLegAuthority, pdas.reserve, OWNER, await ata(OWNER, pins.mint), pdas.msolMintAuthority, SYSTEM, TOKEN,
      ]);
      // Live-derived PDAs (read back on mainnet 2026-10-15).
      assert.equal(pdas.reserve, "Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN");
      assert.equal(pdas.msolMintAuthority, "3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM");
      assert.deepEqual([...deposit.data.subarray(0, 8)], [...MARINADE_DEPOSIT_DISCRIMINATOR]);
      assert.equal(readU64Le(deposit.data, 8), 1_000_000_000n);
    });

    it("refuses drift, pause, minimum, cap, owner and a bump mismatch", async () => {
      const pins = marinadePins();
      const action = stakeAction("mSOL", 1_000_000_000n);
      const set = async (fixture: MarinadeFixture, owner = pins.program) => mock.accounts.set(pins.state, { owner, data: await marinadeStateData(fixture) });
      await set({ mint: ATTACKER });
      assert.equal(await refusal(marinadeAdapter!.plan(action)), "VENUE_UNVERIFIED");
      await set({ msolLeg: ATTACKER });
      assert.equal(await refusal(marinadeAdapter!.plan(action)), "VENUE_UNVERIFIED");
      await set({ paused: true });
      assert.equal(await refusal(marinadeAdapter!.plan(action)), "RESERVE_UNAVAILABLE");
      await set({ minDeposit: 2_000_000_000n });
      assert.equal(await refusal(marinadeAdapter!.plan(action)), "AMOUNT_TOO_SMALL");
      await set({ cap: 2_255_097_492_071_398n });
      assert.equal(await refusal(marinadeAdapter!.plan(action)), "RESERVE_UNAVAILABLE");
      await set({}, ATTACKER);
      assert.equal(await refusal(marinadeAdapter!.plan(action)), "VENUE_UNVERIFIED");
      await set({ reserveBump: 1 });
      assert.equal(await refusal(marinadeAdapter!.plan(action)), "VENUE_UNVERIFIED");
    });
  });

  describe("native staking", () => {
    it("is named-only and serves SOL on solana and solana-devnet", () => {
      const route = (network: "solana" | "solana-devnet") => ({ kind: "stake" as const, network, destinationNetwork: network, input: asset(network, "SOL"), output: asset(network, "SOL") });
      assert.equal(solanaNativeStakeAdapter?.explicitOnly, true);
      assert.equal(solanaNativeStakeAdapter?.supports(route("solana")), true);
      assert.equal(solanaNativeStakeAdapter?.supports(route("solana-devnet")), true);
      assert.equal(solanaNativeStakeAdapter?.supports({ ...route("solana"), output: asset("solana", "JitoSOL") }), false);
    });

    it("derives the stake account from wallet + seed + Stake program (createAccountWithSeed)", async () => {
      const seed = "kletia:00112233aabbccdd";
      const expected = createHash("sha256").update(Buffer.concat([Buffer.from(key(OWNER)), Buffer.from(seed), Buffer.from(key(STAKE))])).digest();
      const derived = await nativeStakeAddress("solana", OWNER, seed);
      assert.deepEqual([...key(derived)], [...expected]);
      assert.equal(encodeNativeStakeQuote({ vote: VOTE_1, seed }), `native:${VOTE_1}:00112233aabbccdd`);
      assert.deepEqual(decodeNativeStakeQuote(`native:${VOTE_1}:00112233aabbccdd`), { vote: VOTE_1, seed });
      assert.equal(decodeNativeStakeQuote(`native:${VOTE_1}:0011`), null);
      assert.equal(decodeNativeStakeQuote(`native:notanaddress:00112233aabbccdd`), null);
    });

    it("plans with the first active default validator, or the named one, and refuses an inactive one", async () => {
      let planned = await solanaNativeStakeAdapter!.plan(stakeAction("SOL", 2_000_000_000n));
      assert.equal(decodeNativeStakeQuote(planned.quoteId)?.vote, VOTE_1);
      assert.equal(planned.minimumOutput.amount, "2000000000");
      assert.equal(planned.extraCosts?.[0]?.amount, RENT.toString());
      assert.equal(planned.floor, "onchain");
      mock.current.delete(VOTE_1);
      planned = await solanaNativeStakeAdapter!.plan(stakeAction("SOL", 2_000_000_000n));
      assert.equal(decodeNativeStakeQuote(planned.quoteId)?.vote, VOTE_2, "falls back to the next pinned validator");
      planned = await solanaNativeStakeAdapter!.plan(stakeAction("SOL", 2_000_000_000n, { provider: NAMED_VOTE }));
      assert.equal(decodeNativeStakeQuote(planned.quoteId)?.vote, NAMED_VOTE);
      assert.equal(await refusal(solanaNativeStakeAdapter!.plan(stakeAction("SOL", 2_000_000_000n, { provider: VOTE_1 }))), "VENUE_UNSUPPORTED");
      mock.current.clear();
      assert.equal(await refusal(solanaNativeStakeAdapter!.plan(stakeAction("SOL", 2_000_000_000n))), "RESERVE_UNAVAILABLE");
    });

    it("enforces the network minimum (1 SOL mainnet, 0.01 SOL devnet) and own-account staking", async () => {
      assert.equal(await refusal(solanaNativeStakeAdapter!.plan(stakeAction("SOL", 999_999_999n))), "AMOUNT_TOO_SMALL");
      assert.equal(await refusal(solanaNativeStakeAdapter!.plan(stakeAction("SOL", 9_999_999n, { network: "solana-devnet", destinationNetwork: "solana-devnet" }))), "AMOUNT_TOO_SMALL");
      const devnet = await solanaNativeStakeAdapter!.plan(stakeAction("SOL", 10_000_000n, { network: "solana-devnet", destinationNetwork: "solana-devnet" }));
      assert.equal(decodeNativeStakeQuote(devnet.quoteId)?.vote, DEVNET_VOTE);
      const other = parseAccountId(`solana:${CHAINS.solana.reference}:${ATTACKER}`);
      assert.ok(other);
      assert.equal(await refusal(solanaNativeStakeAdapter!.plan(stakeAction("SOL", 2_000_000_000n, { recipient: other }))), "INTENT_UNSUPPORTED");
    });

    it("prepares create-with-seed + initialize + delegate, signed only by the wallet", async () => {
      const seed = "kletia:00112233aabbccdd";
      const step = { quoteRef: encodeStepRef({ v: 1, slippageBps: 1, quote: encodeNativeStakeQuote({ vote: VOTE_1, seed }) }) };
      const { payload, decoded } = await decodedPayload(solanaNativeStakeAdapter!, stakeAction("SOL", 2_000_000_000n), step);
      const stake = await nativeStakeAddress("solana", OWNER, seed);
      assert.deepEqual(decoded.signers, [OWNER]);
      assert.equal(payload.records[0]?.to, STAKE);
      const [create, initialize, delegate] = decoded.instructions.filter((entry) => entry.program !== "ComputeBudget111111111111111111111111111111");
      assert.ok(create && initialize && delegate);
      assert.equal(create.program, SYSTEM);
      assert.equal(tag(create.data), 3);
      assert.deepEqual(create.accounts.slice(0, 2), [OWNER, stake]);
      const seedEnd = 44 + seed.length;
      assert.equal(Buffer.from(create.data.subarray(44, seedEnd)).toString(), seed);
      assert.equal(readU64Le(create.data, seedEnd), 2_000_000_000n + RENT);
      assert.equal(readU64Le(create.data, seedEnd + 8), 200n);
      assert.equal(initialize.program, STAKE);
      assert.deepEqual([...initialize.data], [...stakeInitializeData(OWNER)]);
      assert.deepEqual(initialize.accounts, [stake, "SysvarRent111111111111111111111111111111111"]);
      assert.equal(delegate.program, STAKE);
      assert.deepEqual(delegate.accounts, [stake, VOTE_1, "SysvarC1ock11111111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111", "StakeConfig11111111111111111111111111111111", OWNER]);
      assert.equal(payload.extraCosts?.[0]?.amount, RENT.toString());
      // Without the planned quote, or with the validator gone delinquent, prepare refuses.
      assert.equal(await refusal(solanaNativeStakeAdapter!.prepare({ graph: {} as never, step: {} as IntentStep, action: stakeAction("SOL", 2_000_000_000n), now: Date.now() })), "STEP_INVALID");
      mock.current.delete(VOTE_1);
      assert.equal(await refusal(solanaNativeStakeAdapter!.prepare({ graph: {} as never, step: step as IntentStep, action: stakeAction("SOL", 2_000_000_000n), now: Date.now() })), "RESERVE_UNAVAILABLE");
    });

    it("binds a landed stake to its three instructions and the credited lamports", async () => {
      const seed = "kletia:00112233aabbccdd";
      const stake = await nativeStakeAddress("solana", OWNER, seed);
      const amount = 2_000_000_000n;
      const { decoded } = await decodedPayload(solanaNativeStakeAdapter!, stakeAction("SOL", amount), {
        quoteRef: encodeStepRef({ v: 1, slippageBps: 1, quote: encodeNativeStakeQuote({ vote: VOTE_1, seed }) }),
      });
      const observation = (instructions: typeof decoded.instructions, credited: bigint): SolanaTransactionObservation => ({
        network: "solana", signature: "x", status: "finalized", error: null, feePayer: OWNER, programs: [SYSTEM, STAKE], blockTime: 1, slot: "1",
        explorerUrl: "", tokenDeltas: new Map(), lamportDeltas: new Map([[stake, credited]]), fee: 5_000n, instructions, detailsAvailable: true,
      });
      const expected = { program: STAKE, owner: OWNER, stake, seed, vote: VOTE_1, amount };
      assert.equal(nativeStakeBindingFailure([observation(decoded.instructions, amount + RENT)], expected), null);
      assert.match(nativeStakeBindingFailure([observation(decoded.instructions, amount + RENT)], { ...expected, vote: VOTE_2 }) ?? "", /planned validator/u);
      assert.match(nativeStakeBindingFailure([observation(decoded.instructions, amount + RENT)], { ...expected, seed: "kletia:ffffffffffffffff" }) ?? "", /stake account/u);
      assert.match(nativeStakeBindingFailure([observation(decoded.instructions, amount + RENT)], { ...expected, amount: amount + RENT + 1n }) ?? "", /less than/u);
      assert.match(nativeStakeBindingFailure([observation(decoded.instructions, 1n)], expected) ?? "", /did not receive/u);
      const withoutDelegate = decoded.instructions.filter((entry) => !(entry.program === STAKE && entry.data.length === 4));
      assert.match(nativeStakeBindingFailure([observation(withoutDelegate, amount + RENT)], expected) ?? "", /not delegated/u);
    });
  });

  describe("engine round trip (named venue preferred)", () => {
    async function preparedJito() {
      const intent = await createIntent({ text: "stake 1 SOL with jito", accounts: ACCOUNTS, constraints: { preferProtocols: ["jito"] } });
      const step = intent.steps[0]!;
      assert.equal(step.protocol, "jito");
      assert.equal(step.minimumOutput?.amount, ((765_448_812n * 9_995n) / 10_000n).toString());
      const { intent: prepared, payload } = await prepareStep(intent.id, step.id);
      assert.equal(payload.transactions.length, 1);
      return prepared.steps[0]!;
    }

    async function land(options: { credited?: bigint; pool?: string; lamports?: bigint } = {}) {
      const pins = stakePoolPins("jito");
      const userAta = await ata(OWNER, pins.mint);
      const signature = randomSolanaSignature();
      const authority = await poolWithdrawAuthority(pins);
      mock.landed.set(signature, {
        signature,
        feePayer: OWNER,
        blockTime: Math.floor(Date.now() / 1000),
        instructions: [{
          program: pins.program,
          accounts: [options.pool ?? pins.pool, authority, pins.reserve, OWNER, userAta, pins.feeAccount, userAta, pins.mint, SYSTEM, TOKEN],
          data: Uint8Array.from([STAKE_POOL_INSTRUCTION.depositSolWithSlippage, ...u64(options.lamports ?? 1_000_000_000n), ...u64(764_066_087n)]),
        }],
        tokenBalances: [{ owner: OWNER, mint: pins.mint, account: userAta, pre: 0n, post: options.credited ?? 765_448_812n }],
        lamports: new Map([[OWNER, -1_000_005_000n], [pins.reserve, 1_000_000_000n]]),
      });
      return signature;
    }

    const verify = async (step: IntentStep, signature: string) => {
      const result = await jitoStakePoolAdapter!.verify({ step, references: [signature], submittedAt: Date.now(), now: Date.now() });
      return result.status === "confirmed" ? `confirmed ${result.actualOutput?.amount}` : result.status === "failed" ? result.failure.code : result.status;
    };

    it("plans, prepares and verifies a Jito pool deposit", async () => {
      const step = await preparedJito();
      assert.equal(await verify(step, await land()), "confirmed 765448812");
    });

    it("rejects a landed deposit below the floor, into another pool, or of another amount", async () => {
      const step = await preparedJito();
      assert.equal(await verify(step, await land({ credited: 700_000_000n })), "REFERENCE_MISMATCH");
      assert.equal(await verify(step, await land({ pool: ATTACKER })), "REFERENCE_MISMATCH");
      assert.equal(await verify(step, await land({ lamports: 999_999_999n })), "REFERENCE_MISMATCH");
      const result = await jitoStakePoolAdapter!.verify({ step, references: [await land({ credited: 1n })], submittedAt: Date.now(), now: Date.now() });
      assert.ok(isReferenceRejection(result));
    });

    it("falls back to the direct pool when the Jupiter route cannot quote", async () => {
      // Jupiter stays first in ADAPTERS; with no Jupiter quote available the planner tries the next candidate.
      const intent = await createIntent({ text: "stake 1 SOL with jito", accounts: ACCOUNTS });
      assert.equal(intent.steps[0]?.protocol, "jito");
    });
  });
});
