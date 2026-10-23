/**
 * Round 9 Solana venues: the new SPL stake pools (Sanctum hSOL / dSOL /
 * bonkSOL, BlazeStake bSOL), Save (ex-Solend) main-pool deposits and
 * withdrawals, the Kamino JLP / Altcoins markets, Jupiter venue filters and
 * Solana Pay transfer requests.
 *
 * Pool fixtures carry the live values read on 2026-10-23 (epoch 1065; the
 * expected outputs equal the live DepositSolWithSlippage simulations of
 * fixtures `protocols-2026-10-23.json`). The Save reserve, the Kamino JLP
 * reserve, its lookup table and a real KTX deposit transaction are recorded
 * in `fixtures/solana-round9-2026-10-23.json`. Nothing here reaches a network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import {
  CHAINS,
  findAssetBySymbol,
  getAsset,
  getYieldVenue,
  isSolanaAddress,
  nativeAssetId,
  parseAccountId,
  stakePoolsFor,
  type IntentStep,
  type KaminoReserveVenue,
  type SaveReserveVenue,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resolvedFromDescriptor, type ResolvedAsset } from "../assets.js";
import { encodeJupiterVenueFilter, jupiterAdapter, parseJupiterVenueFilter } from "../adapters/jupiter.js";
import { checkKaminoTransaction, liquidityTokenAccount, readKaminoReserve, vanillaObligation } from "../adapters/kaminoClient.js";
import { saveAdapter } from "../adapters/save.js";
import {
  collateralForWithdrawal,
  collateralRate,
  decodeSaveReserve,
  liquidityForCollateral,
  SAVE_INSTRUCTION,
} from "../adapters/saveClient.js";
import { encodeSolanaPayTransferUrl, parseSolanaPayTransferUrl, solanaPayAdapter, solanaPayReference, solanaPayStepUrl } from "../adapters/solanaPay.js";
import {
  blazeStakePoolAdapter,
  findStakePoolPins,
  poolTokensForDeposit,
  poolWithdrawAuthority,
  sanctumStakePoolAdapter,
  stakePoolPins,
  STAKE_POOL_INSTRUCTION,
  type StakePoolPins,
} from "../adapters/solanaStakePool.js";
import { readU64Le } from "../adapters/solanaStakeCommon.js";
import type { AdapterAction, ProtocolAdapter } from "../adapters/types.js";
import { decodeSolanaTransaction } from "../chains/solana.js";
import { configureJupiterQuoteCache } from "../../../networks/solana/index.js";
import { randomSolanaSignature } from "./helpers.js";
import { ata, ATTACKER, installSolanaLendMock, OWNER, tokenAccountData, TOKEN_PROGRAM, u64, USDC, type SolanaLendMock } from "./solanaLendFixtures.js";

const ACCOUNT = parseAccountId(`solana:${CHAINS.solana.reference}:${OWNER}`)!;
const SYSTEM = "11111111111111111111111111111111";
const EPOCH = 1065n;
const recorded = JSON.parse(readFileSync(new URL("./fixtures/solana-round9-2026-10-23.json", import.meta.url), "utf8")) as {
  ktxWallet: string;
  ktxJlpUsdcDeposit: string;
  accounts: Record<string, { owner: string; data: string }>;
};
const recordedAccount = (key: string) => {
  const entry = recorded.accounts[key];
  assert.ok(entry, key);
  return { owner: entry.owner, data: Uint8Array.from(Buffer.from(entry.data, "base64")) };
};

function asset(symbol: string): ResolvedAsset {
  const descriptor = symbol === "SOL" ? getAsset(nativeAssetId("solana")) : findAssetBySymbol("solana", symbol);
  assert.ok(descriptor, symbol);
  return resolvedFromDescriptor(descriptor);
}

function action(kind: AdapterAction["kind"], input: string, output: string, amount: bigint, extra: Partial<AdapterAction> = {}): AdapterAction {
  return {
    kind, network: "solana", destinationNetwork: "solana", input: asset(input), output: asset(output),
    amount: amount.toString(), account: ACCOUNT, recipient: ACCOUNT, slippageBps: 50, ...extra,
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

async function decodedPayload(adapter: ProtocolAdapter, request: AdapterAction, graphId = "in_round9", stepId = "s1") {
  const payload = await adapter.prepare({ graph: { id: graphId } as never, step: { id: stepId } as IntentStep, action: request, now: Date.now() });
  const transaction = payload.transactions[0];
  assert.ok(transaction && transaction.vm === "svm");
  return { payload, decoded: await decodeSolanaTransaction("solana", transaction.transaction) };
}

/** A prepared step as verification reads it (one Solana transaction to `program`). */
function preparedStep(fields: Partial<IntentStep> & Pick<IntentStep, "kind" | "protocol">, program: string): IntentStep {
  const now = new Date().toISOString();
  return {
    id: "s1", index: 0, title: "round 9", network: "solana", chain: `solana:${CHAINS.solana.reference}`, account: `solana:${CHAINS.solana.reference}:${OWNER}`,
    mode: "wallet", dependsOn: [], status: "submitted", evidence: [],
    prepared: { quoteBinding: "a".repeat(64), preparedAt: now, expiresAt: Math.floor(Date.now() / 1000) + 90, transactions: [{ vm: "svm", network: "solana", feePayer: OWNER, to: program, description: "x" }] },
    ...fields,
  } as IntentStep;
}

async function verified(adapter: ProtocolAdapter, step: IntentStep, signature: string): Promise<string> {
  const result = await adapter.verify({ step, references: [signature], submittedAt: Date.now(), now: Date.now() });
  return result.status === "confirmed" ? `confirmed ${result.actualOutput?.amount}` : result.status === "failed" ? result.failure.code : result.status;
}

/* ------------------------------------------------------------ stake pools */

const key = (value: string) => Uint8Array.from(getAddressEncoder().encode(address(value)));

interface PoolFixture {
  readonly symbol: string;
  readonly total: bigint;
  readonly supply: bigint;
  readonly fee?: readonly [bigint, bigint];
  readonly referral?: number;
  readonly mint?: string;
  readonly authority?: string;
}

/** Live pool values of 2026-10-23 (epoch 1065). */
const POOLS: Readonly<Record<string, PoolFixture>> = {
  hSOL: { symbol: "hSOL", total: 964_063_860_613_017n, supply: 808_423_676_348_522n, fee: [100n, 0n] },
  dSOL: { symbol: "dSOL", total: 2_788_638_857_049_943n, supply: 2_283_607_920_478_893n, fee: [100n, 0n] },
  bonkSOL: { symbol: "bonkSOL", total: 73_614_184_605_432n, supply: 61_064_923_935_340n, fee: [100n, 0n] },
  bSOL: { symbol: "bSOL", total: 873_977_888_813_686n, supply: 661_107_842_660_081n, fee: [10_000n, 8n], referral: 100 },
};

function pinsOf(symbol: string): StakePoolPins {
  const pool = [...stakePoolsFor("sanctum"), ...stakePoolsFor("blazestake")].find((entry) => entry.symbol === symbol);
  assert.ok(pool, symbol);
  return stakePoolPins(pool.protocol, pool.mint);
}

/** StakePool account (611 bytes, spl-stake-pool borsh layout). */
async function poolData(fixture: PoolFixture): Promise<Uint8Array> {
  const pins = pinsOf(fixture.symbol);
  const [, bump] = await getProgramDerivedAddress({ programAddress: address(pins.program), seeds: [key(pins.pool), "withdraw"] });
  const parts: Uint8Array[] = [Uint8Array.of(1), key(ATTACKER), key(ATTACKER), key(ATTACKER), Uint8Array.of(bump)];
  parts.push(key(pins.validatorList), key(pins.reserve), key(fixture.mint ?? pins.mint), key(pins.feeAccount), key(TOKEN_PROGRAM));
  parts.push(u64(fixture.total), u64(fixture.supply), u64(EPOCH), new Uint8Array(48));
  const fee = (pair: readonly [bigint, bigint]) => parts.push(u64(pair[0]), u64(pair[1]));
  fee([100n, 5n]);
  parts.push(Uint8Array.of(0), Uint8Array.of(0), Uint8Array.of(0)); // next epoch fee, preferred deposit / withdraw validators
  fee([0n, 0n]);
  fee([1000n, 1n]);
  parts.push(Uint8Array.of(0), Uint8Array.of(0)); // next stake withdrawal fee, stake referral fee
  parts.push(fixture.authority ? Uint8Array.from([1, ...key(fixture.authority)]) : Uint8Array.of(0));
  fee(fixture.fee ?? [0n, 0n]);
  parts.push(Uint8Array.of(fixture.referral ?? 0));
  const data = new Uint8Array(611);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}

function installEpoch(mock: SolanaLendMock): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" && init.body.includes("getEpochInfo") ? (JSON.parse(init.body) as { id: unknown }) : null;
    if (body) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { absoluteSlot: 460_000_000, blockHeight: 438_000_000, epoch: Number(EPOCH), slotIndex: 1, slotsInEpoch: 432_000, transactionCount: 1 } }), { headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }) as typeof fetch;
  void mock;
}

describe("round 9: Solana venues", () => {
  let mock: SolanaLendMock;

  beforeEach(async () => {
    mock = installSolanaLendMock();
    installEpoch(mock);
    configureJupiterQuoteCache({ ttlMs: 0 });
    for (const fixture of Object.values(POOLS)) {
      const pins = pinsOf(fixture.symbol);
      mock.accounts.set(pins.pool, { owner: pins.program, data: await poolData(fixture) });
    }
  });

  afterEach(() => {
    mock.restore();
    configureJupiterQuoteCache(null);
  });

  describe("SPL stake pools: Sanctum hSOL / dSOL / bonkSOL and BlazeStake bSOL", () => {
    it("serves each LST from its own protocol's adapter; the Sanctum default stays JupSOL", () => {
      const route = (symbol: string) => ({ kind: "stake" as const, network: "solana" as const, destinationNetwork: "solana" as const, input: asset("SOL"), output: asset(symbol) });
      for (const symbol of ["JupSOL", "hSOL", "dSOL", "bonkSOL"]) assert.equal(sanctumStakePoolAdapter?.supports(route(symbol)), true, symbol);
      assert.equal(sanctumStakePoolAdapter?.supports(route("bSOL")), false);
      assert.equal(blazeStakePoolAdapter?.supports(route("bSOL")), true);
      assert.equal(blazeStakePoolAdapter?.supports(route("hSOL")), false);
      assert.equal(stakePoolPins("sanctum").symbol, "JupSOL");
      assert.equal(findStakePoolPins("blazestake", asset("JitoSOL").address as string), null);
    });

    it("plans at each pool's rate (equal to the live simulations) with a 5 bps on-chain floor", async () => {
      const expected: Record<string, bigint> = { hSOL: 838_558_221n, dSOL: 818_896_973n, bonkSOL: 829_526_595n, bSOL: 755_830_283n };
      for (const [symbol, user] of Object.entries(expected)) {
        const adapter = symbol === "bSOL" ? blazeStakePoolAdapter! : sanctumStakePoolAdapter!;
        const planned = await adapter.plan(action("stake", "SOL", symbol, 1_000_000_000n));
        assert.equal(planned.protocol, symbol === "bSOL" ? "blazestake" : "sanctum");
        assert.equal(planned.expectedOutput.amount, user.toString(), symbol);
        assert.equal(planned.minimumOutput.amount, ((user * 9_995n) / 10_000n).toString(), symbol);
        assert.equal(planned.floor, "onchain");
        assert.match(planned.title, new RegExp(`for ${symbol} on Solana`, "u"));
      }
      // bSOL's 0.08 % SOL deposit fee is refunded through the referral share (100 %), so no fee warning.
      const bsol = await blazeStakePoolAdapter!.plan(action("stake", "SOL", "bSOL", 1_000_000_000n));
      assert.ok(!bsol.warnings.some((warning) => /deposit fee/u.test(warning)));
      const state = { totalLamports: POOLS.bSOL!.total, poolTokenSupply: POOLS.bSOL!.supply, solDepositFee: { denominator: 10_000n, numerator: 8n } };
      assert.deepEqual(poolTokensForDeposit(state, 1_000_000_000n), { minted: 756_435_432n, fee: 605_149n, user: 755_830_283n });
    });

    it("builds DepositSolWithSlippage on each pool's own program with its pinned accounts", async () => {
      for (const symbol of ["hSOL", "bSOL"]) {
        const adapter = symbol === "bSOL" ? blazeStakePoolAdapter! : sanctumStakePoolAdapter!;
        const pins = pinsOf(symbol);
        const { payload, decoded } = await decodedPayload(adapter, action("stake", "SOL", symbol, 1_000_000_000n));
        assert.deepEqual(decoded.signers, [OWNER]);
        assert.equal(payload.records[0]?.to, pins.program);
        const userAta = await ata(OWNER, pins.mint);
        const deposit = decoded.instructions.find((entry) => entry.program === pins.program);
        assert.ok(deposit, symbol);
        assert.deepEqual(deposit.accounts, [pins.pool, await poolWithdrawAuthority(pins), pins.reserve, OWNER, userAta, pins.feeAccount, userAta, pins.mint, SYSTEM, TOKEN_PROGRAM]);
        assert.equal(deposit.data[0], STAKE_POOL_INSTRUCTION.depositSolWithSlippage);
        assert.equal(readU64Le(deposit.data, 1), 1_000_000_000n);
        assert.equal(readU64Le(deposit.data, 9)?.toString(), payload.minimumOutput.amount);
      }
      assert.equal(pinsOf("hSOL").program, "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
      assert.equal(pinsOf("bSOL").program, "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
    });

    it("refuses a drifted mint, a gated pool and a foreign owner per pool", async () => {
      const pins = pinsOf("dSOL");
      const request = action("stake", "SOL", "dSOL", 1_000_000_000n);
      mock.accounts.set(pins.pool, { owner: pins.program, data: await poolData({ ...POOLS.dSOL!, mint: ATTACKER }) });
      assert.equal(await refusal(sanctumStakePoolAdapter!.plan(request)), "VENUE_UNVERIFIED");
      mock.accounts.set(pins.pool, { owner: pins.program, data: await poolData({ ...POOLS.dSOL!, authority: ATTACKER }) });
      assert.equal(await refusal(sanctumStakePoolAdapter!.plan(request)), "RESERVE_UNAVAILABLE");
      mock.accounts.set(pins.pool, { owner: "SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn", data: await poolData(POOLS.dSOL!) });
      assert.equal(await refusal(sanctumStakePoolAdapter!.plan(request)), "VENUE_UNVERIFIED", "a pool owned by another Sanctum program");
    });

    it("verifies a landed deposit into the step's own pool only", async () => {
      const pins = pinsOf("hSOL");
      const userAta = await ata(OWNER, pins.mint);
      const authority = await poolWithdrawAuthority(pins);
      const land = (pool: string) => {
        const signature = randomSolanaSignature();
        mock.landed.set(signature, {
          signature, feePayer: OWNER, blockTime: Math.floor(Date.now() / 1000),
          instructions: [{ program: pins.program, accounts: [pool, authority, pins.reserve, OWNER, userAta, pins.feeAccount, userAta, pins.mint, SYSTEM, TOKEN_PROGRAM], data: Uint8Array.from([25, ...u64(1_000_000_000n), ...u64(838_138_941n)]) }],
          tokenBalances: [{ owner: OWNER, mint: pins.mint, account: userAta, pre: 0n, post: 838_558_221n }],
          lamports: new Map([[OWNER, -1_000_005_000n], [pins.reserve, 1_000_000_000n]]),
        });
        return signature;
      };
      const output = asset("hSOL");
      const step = preparedStep({
        kind: "stake", protocol: "sanctum",
        input: { asset: asset("SOL").id, symbol: "SOL", decimals: 9, amount: "1000000000", formatted: "1" },
        minimumOutput: { asset: output.id, symbol: "hSOL", decimals: 9, amount: "838138941", formatted: "0.838138941" },
      }, pins.program);
      assert.equal(await verified(sanctumStakePoolAdapter!, step, land(pins.pool)), "confirmed 838558221");
      assert.equal(await verified(sanctumStakePoolAdapter!, step, land(pinsOf("dSOL").pool)), "REFERENCE_MISMATCH");
    });
  });

  describe("Jupiter venue filters", () => {
    const QUOTE_LABELS: string[][] = [];
    function serveQuotes(labels: string[]) {
      const inner = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("/swap/v1/quote")) {
          QUOTE_LABELS.push([url.searchParams.get("dexes") ?? "", url.searchParams.get("excludeDexes") ?? ""]);
          return new Response(JSON.stringify({
            inputMint: url.searchParams.get("inputMint"), outputMint: url.searchParams.get("outputMint"), inAmount: url.searchParams.get("amount"),
            outAmount: "150000000", otherAmountThreshold: "149250000", slippageBps: 50, priceImpactPct: "0.0001", contextSlot: 1,
            routePlan: labels.map((label) => ({ percent: 100, swapInfo: { label, inputMint: "a", outputMint: "b" } })),
          }), { headers: { "content-type": "application/json" } });
        }
        return inner(input, init);
      }) as typeof fetch;
    }

    it("encodes and parses dexes / avoid filters within the step ref's 32 characters", () => {
      assert.equal(encodeJupiterVenueFilter({ mode: "only", families: ["raydium", "orca", "raydium"] }), "dexes:raydium,orca");
      assert.equal(encodeJupiterVenueFilter({ mode: "avoid", families: ["phoenix"] }), "avoid:phoenix");
      assert.deepEqual(parseJupiterVenueFilter("avoid:phoenix,solfi"), { mode: "avoid", families: ["phoenix", "solfi"] });
      assert.equal(parseJupiterVenueFilter("Jito"), null, "a staking provider label is not a filter");
      assert.equal(parseJupiterVenueFilter(undefined), null);
      assert.throws(() => parseJupiterVenueFilter("dexes:lifinity"), /not a Jupiter venue/u);
      assert.throws(() => parseJupiterVenueFilter("dexes:"), /malformed/u);
      assert.throws(() => encodeJupiterVenueFilter({ mode: "only", families: [] }), /at least one/u);
      assert.throws(() => encodeJupiterVenueFilter({ mode: "avoid", families: ["humidifi", "openbook", "manifest", "pumpfun"] }), /at most three/u);
    });

    it("sends the family labels as dexes / excludeDexes and records the filter as the step provider", async () => {
      QUOTE_LABELS.length = 0;
      serveQuotes(["Whirlpool", "Raydium CLMM"]);
      const only = await jupiterAdapter.plan(action("swap", "SOL", "USDC", 1_000_000_000n, { provider: "dexes:raydium,orca" }));
      assert.equal(only.provider, "dexes:raydium,orca");
      assert.ok(only.warnings.some((warning) => /Routed only through raydium, orca/u.test(warning)));
      assert.deepEqual(QUOTE_LABELS.at(-1), ["Raydium,Raydium CLMM,Raydium CP,Whirlpool", ""]);
      await jupiterAdapter.plan(action("swap", "SOL", "USDC", 1_000_000_000n, { provider: "avoid:phoenix" }));
      assert.deepEqual(QUOTE_LABELS.at(-1), ["", "Phoenix"]);
      const plain = await jupiterAdapter.plan(action("swap", "SOL", "USDC", 1_000_000_000n));
      assert.equal(plain.provider, undefined);
      assert.deepEqual(QUOTE_LABELS.at(-1), ["", ""]);
    });

    it("refuses a quote whose route breaks the filter (fail closed)", async () => {
      serveQuotes(["Phoenix"]);
      assert.equal(await refusal(jupiterAdapter.plan(action("swap", "SOL", "USDC", 1_000_000_000n, { provider: "avoid:phoenix" }))), "PROVIDER_TRANSACTION_REJECTED");
      assert.equal(await refusal(jupiterAdapter.plan(action("swap", "SOL", "USDC", 1_000_000_000n, { provider: "dexes:orca" }))), "PROVIDER_TRANSACTION_REJECTED");
      assert.equal(await refusal(jupiterAdapter.plan(action("swap", "SOL", "USDC", 1_000_000_000n, { provider: "dexes:nowhere" }))), "INTENT_UNSUPPORTED");
    });
  });

  describe("Save (ex-Solend) main pool", () => {
    const venue = getYieldVenue("solana:save:usdc") as SaveReserveVenue;
    const reserve = recordedAccount(venue.reserve);
    const state = decodeSaveReserve(reserve.data)!;
    const rate = collateralRate(state);

    beforeEach(() => {
      mock.accounts.set(venue.reserve, reserve);
    });

    it("decodes the recorded USDC reserve and derives the pinned market authority", async () => {
      assert.ok(state);
      assert.equal(state.market, venue.market);
      assert.equal(state.liquidityMint, USDC);
      assert.equal(state.supplyVault, venue.supplyVault);
      assert.equal(state.collateralMint, venue.receipt.address);
      assert.equal(state.decimals, 6);
      assert.equal(state.pythOracle, "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX");
      assert.equal(state.extraOracle, null);
      assert.equal(decodeSaveReserve(new Uint8Array(618)), null);
      // The rate only falls as interest accrues: a withdrawal's cTokens always redeem for at least the amount.
      const collateral = collateralForWithdrawal(rate, 10_000_000n);
      assert.ok(liquidityForCollateral(rate, collateral) >= 10_000_000n);
      assert.ok(liquidityForCollateral(rate, collateral - 1n) < 10_000_000n);
      const [authority] = await getProgramDerivedAddress({ programAddress: address(venue.target), seeds: [key(venue.market)] });
      assert.equal(String(authority), venue.marketAuthority);
    });

    it("plans a deposit at the reserve rate and builds [ATA, RefreshReserve, DepositReserveLiquidity] with every pinned account", async () => {
      const request = action("deposit", "USDC", "USDC", 10_000_000n, { venue: venue.id });
      const planned = await saveAdapter.plan(request);
      const minted = (10_000_000n * rate) / 10n ** 18n;
      assert.equal(planned.expectedOutput.amount, minted.toString());
      assert.equal(planned.minimumOutput.amount, ((minted * 9_990n) / 10_000n).toString());
      assert.equal(planned.expectedOutput.symbol, "cUSDC");
      const { payload, decoded } = await decodedPayload(saveAdapter, request);
      assert.deepEqual(decoded.signers, [OWNER]);
      assert.equal(payload.records[0]?.to, venue.target);
      const userUsdc = await ata(OWNER, USDC);
      const userCToken = await ata(OWNER, venue.receipt.address);
      const saves = decoded.instructions.filter((entry) => entry.program === venue.target);
      assert.deepEqual(saves.map((entry) => entry.data[0]), [SAVE_INSTRUCTION.refreshReserve, SAVE_INSTRUCTION.depositReserveLiquidity]);
      assert.deepEqual(saves[0]?.accounts, [venue.reserve, state.pythOracle, state.switchboardOracle]);
      assert.deepEqual(saves[1]?.accounts, [userUsdc, userCToken, venue.reserve, venue.supplyVault, venue.receipt.address, venue.market, venue.marketAuthority, OWNER, TOKEN_PROGRAM]);
      assert.equal(readU64Le(saves[1]!.data, 1), 10_000_000n);
      const create = decoded.instructions.find((entry) => entry.program === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
      assert.equal(create?.accounts[1], userCToken, "creates the step account's own cToken account");
    });

    it("withdraws an exact amount or the whole position by redeeming cTokens", async () => {
      const userCToken = await ata(OWNER, venue.receipt.address);
      mock.accounts.set(userCToken, { owner: TOKEN_PROGRAM, data: tokenAccountData(venue.receipt.address, OWNER, 50_000_000n) });
      const exact = action("withdraw", "USDC", "USDC", 10_000_000n, { venue: venue.id });
      const { decoded } = await decodedPayload(saveAdapter, exact);
      const redeem = decoded.instructions.find((entry) => entry.program === venue.target && entry.data[0] === SAVE_INSTRUCTION.redeemReserveCollateral);
      assert.ok(redeem);
      assert.equal(readU64Le(redeem.data, 1), collateralForWithdrawal(rate, 10_000_000n));
      assert.deepEqual(redeem.accounts, [userCToken, await ata(OWNER, USDC), venue.reserve, venue.receipt.address, venue.supplyVault, venue.market, venue.marketAuthority, OWNER, TOKEN_PROGRAM]);
      const all = await saveAdapter.plan({ ...exact, amount: "0", closePosition: true });
      assert.equal(all.input.amount, liquidityForCollateral(rate, 50_000_000n).toString());
      assert.equal(await refusal(saveAdapter.plan({ ...exact, amount: "1000000000" })), "INSUFFICIENT_BALANCE");
    });

    it("refuses a drifted reserve, a foreign owner and token-2022 underlyings", async () => {
      const request = action("deposit", "USDC", "USDC", 10_000_000n, { venue: venue.id });
      const drifted = Uint8Array.from(reserve.data);
      drifted.set(key(ATTACKER), 75);
      mock.accounts.set(venue.reserve, { owner: venue.target, data: drifted });
      assert.equal(await refusal(saveAdapter.plan(request)), "VENUE_UNVERIFIED");
      mock.accounts.set(venue.reserve, { owner: ATTACKER, data: reserve.data });
      assert.equal(await refusal(saveAdapter.plan(request)), "VENUE_UNVERIFIED");
      assert.equal(saveAdapter.supports({ kind: "deposit", network: "solana", destinationNetwork: "solana", input: asset("PYUSD"), output: asset("PYUSD") }), false);
      assert.equal(saveAdapter.supports({ kind: "deposit", network: "solana", destinationNetwork: "solana", input: asset("USDT"), output: asset("USDT") }), true);
    });

    it("verifies a landed deposit by its Save instruction and token deltas", async () => {
      const userUsdc = await ata(OWNER, USDC);
      const userCToken = await ata(OWNER, venue.receipt.address);
      const minted = (10_000_000n * rate) / 10n ** 18n;
      const deposit = (options: { reserve?: string; extra?: number; minted?: bigint } = {}) => {
        const signature = randomSolanaSignature();
        mock.landed.set(signature, {
          signature, feePayer: OWNER, blockTime: Math.floor(Date.now() / 1000),
          instructions: [
            { program: venue.target, accounts: [venue.reserve, state.pythOracle, state.switchboardOracle], data: Uint8Array.of(3) },
            ...(options.extra !== undefined ? [{ program: venue.target, accounts: [venue.reserve], data: Uint8Array.from([options.extra, ...u64(1n)]) }] : []),
            {
              program: venue.target,
              accounts: [userUsdc, userCToken, options.reserve ?? venue.reserve, venue.supplyVault, venue.receipt.address, venue.market, venue.marketAuthority, OWNER, TOKEN_PROGRAM],
              data: Uint8Array.from([4, ...u64(10_000_000n)]),
            },
          ],
          tokenBalances: [
            { owner: OWNER, mint: USDC, account: userUsdc, pre: 20_000_000n, post: 10_000_000n },
            { owner: OWNER, mint: venue.receipt.address, account: userCToken, pre: 0n, post: options.minted ?? minted },
          ],
        });
        return signature;
      };
      const receipt = asset("USDC");
      const step = preparedStep({
        kind: "deposit", protocol: "save", venue: venue.id,
        input: { asset: receipt.id, symbol: "USDC", decimals: 6, amount: "10000000", formatted: "10" },
        minimumOutput: { asset: `solana:${CHAINS.solana.reference}/token:${venue.receipt.address}`, symbol: "cUSDC", decimals: 6, amount: ((minted * 9_990n) / 10_000n).toString(), formatted: "x" },
      }, venue.target);
      assert.equal(await verified(saveAdapter, step, deposit()), `confirmed ${minted}`);
      assert.equal(await verified(saveAdapter, step, deposit({ reserve: ATTACKER })), "REFERENCE_MISMATCH");
      assert.equal(await verified(saveAdapter, step, deposit({ minted: 1n })), "OUTCOME_NOT_PROVEN");
      assert.equal(await verified(saveAdapter, step, deposit({ extra: 10 })), "OUTCOME_NOT_PROVEN", "a borrow in the same transaction");
    });
  });

  describe("Kamino JLP and Altcoins markets", () => {
    it("accepts the recorded live KTX deposit into the JLP USDC reserve and rejects it as any other venue", async () => {
      const jlp = getYieldVenue("solana:kamino:jlp-usdc") as KaminoReserveVenue;
      for (const [account, entry] of Object.entries(recorded.accounts)) mock.accounts.set(account, { owner: entry.owner, data: Uint8Array.from(Buffer.from(entry.data, "base64")) });
      const owner = recorded.ktxWallet;
      const reserve = await readKaminoReserve("solana", jlp, USDC);
      assert.equal(reserve.market, "DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek");
      const decoded = await decodeSolanaTransaction("solana", recorded.ktxJlpUsdcDeposit);
      const expectation = async (venue: KaminoReserveVenue) => ({
        kind: "deposit" as const, owner, venue, reserve, amount: 1_000_000n,
        obligation: await vanillaObligation(venue, owner),
        ownerLiquidity: await liquidityTokenAccount(owner, USDC, TOKEN_PROGRAM),
      });
      const expected = await expectation(jlp);
      const checked = checkKaminoTransaction(decoded, expected);
      assert.equal(checked.instructionAmount, 1_000_000n);
      assert.equal(checked.createsObligation, true);
      const main = getYieldVenue("solana:kamino:usdc") as KaminoReserveVenue;
      assert.throws(() => checkKaminoTransaction(decoded, { ...expected, venue: { ...jlp, marketAuthority: main.marketAuthority } }), /will not sign/u);
      assert.throws(() => checkKaminoTransaction(decoded, { ...expected, amount: 2_000_000n }), /will not sign/u);
      // The Altcoins market's USDC reserve is pinned by address (the market lists capped decoys).
      const altcoins = getYieldVenue("solana:kamino:altcoins-usdc") as KaminoReserveVenue;
      assert.equal(altcoins.reserve, "9TD2TSv4pENb8VwfbVYg25jvym7HN6iuAR6pFNSrKjqQ");
      assert.equal(altcoins.marketAuthority, "81BgcfZuZf9bESLvw3zDkh7cZmMtDwTPgkCvYu7zx26o");
    });
  });

  describe("Solana Pay transfer requests", () => {
    it("builds and reads back transfer request URLs as the spec describes", () => {
      const reference = solanaPayReference("in_1", "s1");
      assert.ok(isSolanaAddress(reference));
      assert.equal(solanaPayReference("in_1", "s1"), reference, "deterministic per step");
      assert.notEqual(solanaPayReference("in_2", "s1"), reference);
      const url = encodeSolanaPayTransferUrl({ recipient: ATTACKER, amount: "0.01", splToken: USDC, references: [reference], label: "Michael", message: "Thanks for all the fish", memo: "OrderId12345" });
      assert.equal(url, `solana:${ATTACKER}?amount=0.01&spl-token=${USDC}&reference=${reference}&label=Michael&message=Thanks%20for%20all%20the%20fish&memo=OrderId12345`);
      assert.deepEqual(parseSolanaPayTransferUrl(url), { recipient: ATTACKER, amount: "0.01", splToken: USDC, references: [reference], label: "Michael", message: "Thanks for all the fish", memo: "OrderId12345" });
      assert.deepEqual(parseSolanaPayTransferUrl(`solana:${ATTACKER}`), { recipient: ATTACKER, references: [] });
      assert.throws(() => parseSolanaPayTransferUrl(`solana:${ATTACKER}?amount=1e3`), /plain decimal/u);
      assert.throws(() => parseSolanaPayTransferUrl(`solana:${ATTACKER}?amount=1&amount=2`), /at most once/u);
      assert.throws(() => parseSolanaPayTransferUrl(`solana:${ATTACKER}?reference=notakey`), /reference/u);
      assert.throws(() => parseSolanaPayTransferUrl("https://example.com"), /Not a Solana Pay/u);
      const step = { network: "solana" as const, recipient: `solana:${CHAINS.solana.reference}:${ATTACKER}` as const, input: { asset: asset("SOL").id, symbol: "SOL", decimals: 9, amount: "1500000000", formatted: "1.5" } };
      assert.equal(solanaPayStepUrl(step, reference), `solana:${ATTACKER}?amount=1.5&reference=${reference}&label=Kletia`);
    });

    it("is named-only and appends the step's reference to the transfer instruction", async () => {
      assert.equal(solanaPayAdapter.explicitOnly, true);
      const recipient = parseAccountId(`solana:${CHAINS.solana.reference}:${ATTACKER}`)!;
      const request = action("transfer", "SOL", "SOL", 250_000_000n, { recipient });
      const planned = await solanaPayAdapter.plan(request);
      assert.equal(planned.protocol, "solana-pay");
      const { payload, decoded } = await decodedPayload(solanaPayAdapter, request, "in_pay", "s2");
      const reference = solanaPayReference("in_pay", "s2");
      assert.equal(payload.trackingId, reference);
      const transfer = decoded.instructions.find((entry) => entry.program === SYSTEM);
      assert.deepEqual(transfer?.accounts, [OWNER, ATTACKER, reference]);
      const meta = decoded.instructions.find((entry) => entry.program === SYSTEM)?.metas?.[2];
      assert.ok(meta && !meta.signer && !meta.writable, "the reference is a read-only, non-signer account");
    });

    it("verifies by the reference and the credited amount", async () => {
      const reference = solanaPayReference("in_pay", "s1");
      const land = (accounts: string[], credited: bigint) => {
        const signature = randomSolanaSignature();
        mock.landed.set(signature, {
          signature, feePayer: OWNER, blockTime: Math.floor(Date.now() / 1000),
          instructions: [{ program: SYSTEM, accounts, data: Uint8Array.from([2, 0, 0, 0, ...u64(credited)]) }],
          lamports: new Map([[OWNER, -credited - 5_000n], [ATTACKER, credited]]),
        });
        return signature;
      };
      const step = preparedStep({
        kind: "transfer", protocol: "solana-pay", recipient: `solana:${CHAINS.solana.reference}:${ATTACKER}`,
        input: { asset: asset("SOL").id, symbol: "SOL", decimals: 9, amount: "250000000", formatted: "0.25" },
        settlement: { kind: "same-network", trackingId: reference },
      }, SYSTEM);
      assert.equal(await verified(solanaPayAdapter, step, land([OWNER, ATTACKER, reference], 250_000_000n)), "confirmed 250000000");
      assert.equal(await verified(solanaPayAdapter, step, land([OWNER, ATTACKER], 250_000_000n)), "REFERENCE_MISMATCH", "no reference");
      assert.equal(await verified(solanaPayAdapter, step, land([OWNER, ATTACKER, reference], 1_000n)), "REFERENCE_MISMATCH", "short payment");
      assert.equal(await verified(solanaPayAdapter, { ...step, settlement: { kind: "same-network" } }, land([OWNER, ATTACKER, reference], 250_000_000n)), "STEP_INVALID");
    });
  });
});
