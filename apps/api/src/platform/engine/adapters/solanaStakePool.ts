/**
 * SPL stake pool deposits: Jito (JitoSOL) and Sanctum SPL pools (JupSOL)
 * (protocols design 3.4). SOL goes straight into the pool's reserve and the
 * pool mints its LST at the pool rate, instead of buying the LST at market.
 *
 * - Pins (VENUE_CONTRACTS): program, stake pool, pool mint, reserve stake,
 *   manager fee account and validator list per protocol. Plan and prepare
 *   read the pool account: owner = pinned program, account type StakePool,
 *   every pinned field equal, classic SPL Token mint, no SOL deposit
 *   authority (a gated pool refuses), and `lastUpdateEpoch` equal to the
 *   current epoch (an un-updated pool rejects deposits on-chain, so the plan
 *   refuses with RESERVE_UNAVAILABLE and the Jupiter route stays available).
 * - Expected output follows the program: pool tokens = lamports x supply /
 *   total lamports (floor), less the SOL deposit fee (ceiling). The
 *   transaction is `DepositSolWithSlippage(lamports, minimum)` with the
 *   minimum = expected less 5 bps, so the program itself reverts below the
 *   guaranteed output (`floor: "onchain"`); the referral share goes back to
 *   the user's own token account.
 * - Verification binds the landed deposit instruction (program, pool, mint,
 *   the user's token account, exact lamports) and proves the LST credited to
 *   the step account from token deltas.
 */
import type { ProtocolId } from "@kletia/core";
import { address as toAddress, createNoopSigner, getAddressEncoder, getProgramDerivedAddress, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { PlatformError } from "../../errors.js";
import { assetAmount } from "../assets.js";
import { readSolanaAccounts, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import {
  assertLiquidStakeAction,
  buildStakeTransaction,
  concatBytes,
  currentEpoch,
  instruction,
  lessBps,
  liquidStakeRoute,
  meta,
  noUnstakeWarning,
  pinnedSolana,
  readPubkey,
  readU64Le,
  stakeFeeUsd,
  stakePayload,
  stakeTitle,
  STAKE_ESTIMATED_SECONDS,
  STAKE_TOLERANCE_BPS,
  u64Le,
  verifyLiquidStake,
} from "./solanaStakeCommon.js";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "./types.js";

/** SPL stake pool instruction tags (StakePoolInstruction enum order). */
export const STAKE_POOL_INSTRUCTION = Object.freeze({ depositSol: 14, depositSolWithSlippage: 25 });
/** Account type tag of an initialised StakePool account. */
const ACCOUNT_TYPE_STAKE_POOL = 1;
/** ATA creation (idempotent) plus the deposit; measured well below this on mainnet. */
const DEPOSIT_COMPUTE_UNITS = 150_000;

export type StakePoolProtocol = Extract<ProtocolId, "jito" | "sanctum">;

interface PoolConfig {
  readonly protocol: StakePoolProtocol;
  readonly label: string;
  readonly symbol: string;
}

const POOLS: Readonly<Record<StakePoolProtocol, PoolConfig>> = Object.freeze({
  jito: { protocol: "jito", label: "Jito stake pool", symbol: "JitoSOL" },
  sanctum: { protocol: "sanctum", label: "Sanctum JupSOL pool", symbol: "JupSOL" },
});

/** A pool fee ratio (borsh `Fee { denominator, numerator }`). */
export interface PoolFee {
  readonly denominator: bigint;
  readonly numerator: bigint;
}

/** The StakePool fields a SOL deposit depends on. */
export interface StakePoolState {
  readonly accountType: number;
  readonly withdrawBumpSeed: number;
  readonly validatorList: string;
  readonly reserveStake: string;
  readonly poolMint: string;
  readonly managerFeeAccount: string;
  readonly tokenProgram: string;
  readonly totalLamports: bigint;
  readonly poolTokenSupply: bigint;
  readonly lastUpdateEpoch: bigint;
  readonly solDepositAuthority: string | null;
  readonly solDepositFee: PoolFee;
  readonly solReferralFee: number;
}

/** Pinned accounts of one pool. */
export interface StakePoolPins {
  readonly program: string;
  readonly pool: string;
  readonly mint: string;
  readonly reserve: string;
  readonly feeAccount: string;
  readonly validatorList: string;
}

const poolPins = new Map<StakePoolProtocol, StakePoolPins>();

/** The pool's pins (VENUE_CONTRACTS is frozen, so they are read once; `supports` runs on every route probe). */
export function stakePoolPins(protocol: StakePoolProtocol): StakePoolPins {
  const known = poolPins.get(protocol);
  if (known) return known;
  const pins: StakePoolPins = {
    program: pinnedSolana(protocol, "solana", "program"),
    pool: pinnedSolana(protocol, "solana", "stake-pool"),
    mint: pinnedSolana(protocol, "solana", "pool-mint"),
    reserve: pinnedSolana(protocol, "solana", "reserve-stake"),
    feeAccount: pinnedSolana(protocol, "solana", "fee-account"),
    validatorList: pinnedSolana(protocol, "solana", "validator-list"),
  };
  poolPins.set(protocol, pins);
  return pins;
}

/**
 * Decodes a StakePool account (borsh, spl-stake-pool `state.rs`) up to the
 * SOL deposit fields. Returns null for data that does not parse.
 */
export function decodeStakePool(data: Uint8Array): StakePoolState | null {
  try {
    let offset = 0;
    const byte = () => {
      const value = data[offset];
      if (value === undefined) throw new Error("short");
      offset += 1;
      return value;
    };
    const key = () => {
      const value = readPubkey(data, offset);
      if (value === null) throw new Error("short");
      offset += 32;
      return value;
    };
    const u64 = () => {
      const value = readU64Le(data, offset);
      if (value === null) throw new Error("short");
      offset += 8;
      return value;
    };
    const fee = (): PoolFee => ({ denominator: u64(), numerator: u64() });
    const option = () => (byte() === 0 ? null : key());
    const futureFee = () => {
      if (byte() !== 0) fee();
    };
    const accountType = byte();
    key(); // manager
    key(); // staker
    key(); // stake deposit authority
    const withdrawBumpSeed = byte();
    const validatorList = key();
    const reserveStake = key();
    const poolMint = key();
    const managerFeeAccount = key();
    const tokenProgram = key();
    const totalLamports = u64();
    const poolTokenSupply = u64();
    const lastUpdateEpoch = u64();
    offset += 8 + 8 + 32; // lockup
    fee(); // epoch fee
    futureFee(); // next epoch fee
    option(); // preferred deposit validator
    option(); // preferred withdraw validator
    fee(); // stake deposit fee
    fee(); // stake withdrawal fee
    futureFee(); // next stake withdrawal fee
    byte(); // stake referral fee
    const solDepositAuthority = option();
    const solDepositFee = fee();
    const solReferralFee = byte();
    return {
      accountType,
      withdrawBumpSeed,
      validatorList,
      reserveStake,
      poolMint,
      managerFeeAccount,
      tokenProgram,
      totalLamports,
      poolTokenSupply,
      lastUpdateEpoch,
      solDepositAuthority,
      solDepositFee,
      solReferralFee,
    };
  } catch {
    return null;
  }
}

/** Ceiling fee as the program applies it (`Fee::apply`). */
function applyFee(fee: PoolFee, amount: bigint): bigint {
  if (fee.denominator === 0n) return 0n;
  return (amount * fee.numerator + fee.denominator - 1n) / fee.denominator;
}

/**
 * Pool tokens a SOL deposit mints to the user: `lamports x supply / total`
 * (floor; 1:1 for an empty pool) less the SOL deposit fee. The referral part
 * of the fee is paid to the user's own account as well, but is not counted.
 */
export function poolTokensForDeposit(state: Pick<StakePoolState, "totalLamports" | "poolTokenSupply" | "solDepositFee">, lamports: bigint): { minted: bigint; fee: bigint; user: bigint } {
  const minted = state.totalLamports === 0n || state.poolTokenSupply === 0n ? lamports : (lamports * state.poolTokenSupply) / state.totalLamports;
  const fee = applyFee(state.solDepositFee, minted);
  return { minted, fee, user: fee > minted ? 0n : minted - fee };
}

export interface PoolSnapshot {
  readonly pins: StakePoolPins;
  readonly state: StakePoolState;
  readonly epoch: bigint;
}

/**
 * Checks a decoded pool against its pins and the current epoch. Returns the
 * refusal, or null when the pool takes SOL deposits from anyone now.
 */
export function stakePoolRefusal(config: Pick<PoolConfig, "label">, pins: StakePoolPins, state: StakePoolState, epoch: bigint): PlatformError | null {
  const drift = (field: string) => new PlatformError("VENUE_UNVERIFIED", `The ${config.label} ${field} no longer matches its pin. Kletia will not use it.`, 422);
  if (state.accountType !== ACCOUNT_TYPE_STAKE_POOL) return drift("account type");
  if (state.poolMint !== pins.mint) return drift("pool mint");
  if (state.reserveStake !== pins.reserve) return drift("reserve stake");
  if (state.managerFeeAccount !== pins.feeAccount) return drift("manager fee account");
  if (state.validatorList !== pins.validatorList) return drift("validator list");
  if (state.tokenProgram !== SOLANA_PROGRAM_IDS.token) return drift("token program");
  if (state.solDepositAuthority !== null) {
    return new PlatformError("RESERVE_UNAVAILABLE", `The ${config.label} only takes SOL deposits signed by its deposit authority.`, 422);
  }
  if (state.lastUpdateEpoch !== epoch) {
    return new PlatformError(
      "RESERVE_UNAVAILABLE",
      `The ${config.label} has not been updated for epoch ${epoch} yet (pools update at epoch start); try again in a few minutes.`,
      422,
    );
  }
  return null;
}

export async function readStakePool(protocol: StakePoolProtocol): Promise<PoolSnapshot> {
  const config = POOLS[protocol];
  const pins = stakePoolPins(protocol);
  const [[account], epoch] = await Promise.all([readSolanaAccounts("solana", [pins.pool]), currentEpoch("solana")]);
  if (!account || account.owner !== pins.program) {
    throw new PlatformError("VENUE_UNVERIFIED", `The ${config.label} account is missing or not owned by the pinned stake pool program.`, 422);
  }
  const state = decodeStakePool(account.data);
  if (!state) throw new PlatformError("VENUE_UNVERIFIED", `The ${config.label} account could not be decoded.`, 422);
  const refusal = stakePoolRefusal(config, pins, state, epoch);
  if (refusal) throw refusal;
  return { pins, state, epoch };
}

/** The pool's withdraw authority (PDA `[pool, "withdraw"]`); its bump must be the one the pool stores. */
export async function poolWithdrawAuthority(pins: Pick<StakePoolPins, "program" | "pool">, bump?: number): Promise<string> {
  const [authority, found] = await getProgramDerivedAddress({
    programAddress: toAddress(pins.program),
    seeds: [getAddressEncoder().encode(toAddress(pins.pool)), "withdraw"],
  });
  if (bump !== undefined && found !== bump) {
    throw new PlatformError("VENUE_UNVERIFIED", "The stake pool's withdraw authority bump does not match its derivation.", 422);
  }
  return String(authority);
}

export async function userPoolTokenAccount(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: toAddress(owner), mint: toAddress(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return String(ata);
}

export function depositSolData(lamports: bigint, minimum: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(STAKE_POOL_INSTRUCTION.depositSolWithSlippage), u64Le(lamports), u64Le(minimum));
}

/** Idempotent ATA creation + `DepositSolWithSlippage` (accounts in program order). */
export async function stakePoolDepositInstructions(snapshot: PoolSnapshot, owner: string, lamports: bigint, minimum: bigint): Promise<Instruction[]> {
  const { pins, state } = snapshot;
  const [authority, userAta] = await Promise.all([poolWithdrawAuthority(pins, state.withdrawBumpSeed), userPoolTokenAccount(owner, pins.mint)]);
  const signer = createNoopSigner(toAddress(owner));
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      ata: toAddress(userAta),
      owner: toAddress(owner),
      mint: toAddress(pins.mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    instruction(pins.program, [
      meta(pins.pool, "w"),
      meta(authority, "r"),
      meta(pins.reserve, "w"),
      meta(owner, "ws"),
      meta(userAta, "w"),
      meta(pins.feeAccount, "w"),
      meta(userAta, "w"), // referrer: the user's own account
      meta(pins.mint, "w"),
      meta(SOLANA_PROGRAM_IDS.system, "r"),
      meta(SOLANA_PROGRAM_IDS.token, "r"),
    ], depositSolData(lamports, minimum)),
  ];
}

interface Quoted {
  readonly snapshot: PoolSnapshot;
  readonly amount: bigint;
  readonly expected: bigint;
  readonly minimum: bigint;
  readonly warnings: string[];
}

async function quote(config: PoolConfig, action: AdapterAction): Promise<Quoted> {
  const pins = stakePoolPins(config.protocol);
  const amount = assertLiquidStakeAction(action, config.label, config.symbol, pins.mint);
  const snapshot = await readStakePool(config.protocol);
  const { user, fee } = poolTokensForDeposit(snapshot.state, amount);
  if (user <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `The amount mints no ${config.symbol}.`, 422);
  const minimum = lessBps(user, STAKE_TOLERANCE_BPS);
  const warnings = [noUnstakeWarning(config.label.replace(/ (stake )?pool$/u, ""), config.symbol)];
  if (fee > 0n) warnings.push(`The pool keeps a SOL deposit fee of ${fee} ${config.symbol} base units.`);
  return { snapshot, amount, expected: user, minimum, warnings };
}

async function amounts(action: AdapterAction, quoted: Quoted) {
  const sol = await nativeUsdPrice("solana");
  const usd = sol === null ? undefined : (Number(quoted.amount) / 1e9) * sol;
  return {
    input: assetAmount(action.input, action.amount, usd),
    expectedOutput: assetAmount(action.output, quoted.expected.toString()),
    minimumOutput: assetAmount(action.output, quoted.minimum.toString()),
  };
}

function createStakePoolAdapter(config: PoolConfig): ProtocolAdapter {
  return {
    id: config.protocol,
    protocols: [config.protocol],
    label: config.label,

    supports(route) {
      return liquidStakeRoute(route, stakePoolPins(config.protocol).mint);
    },

    async plan(action): Promise<PlannedStep> {
      const quoted = await quote(config, action);
      const fees = await stakeFeeUsd("solana");
      return {
        protocol: config.protocol,
        title: stakeTitle(quoted.amount, config.label, config.symbol, "solana"),
        mode: "wallet",
        ...(await amounts(action, quoted)),
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        estimatedSeconds: STAKE_ESTIMATED_SECONDS,
        settlement: { kind: "same-network" },
        warnings: quoted.warnings,
        quoteId: `epoch:${quoted.snapshot.epoch}`,
        transactionCount: 1,
        slippageBps: Number(STAKE_TOLERANCE_BPS),
        // DepositSolWithSlippage reverts below the guaranteed amount.
        floor: "onchain",
      };
    },

    async prepare({ action }) {
      const quoted = await quote(config, action);
      const owner = action.account.address;
      const built = await buildStakeTransaction(
        "solana",
        owner,
        await stakePoolDepositInstructions(quoted.snapshot, owner, quoted.amount, quoted.minimum),
        DEPOSIT_COMPUTE_UNITS,
        `${config.label} deposit`,
      );
      const fees = await stakeFeeUsd("solana");
      return stakePayload("solana", owner, quoted.snapshot.pins.program, built, stakeTitle(quoted.amount, config.label, config.symbol, "solana"), await amounts(action, quoted), {
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        quoteId: `epoch:${quoted.snapshot.epoch}`,
        warnings: quoted.warnings,
      });
    },

    async verify(context) {
      const pins = stakePoolPins(config.protocol);
      const owner = context.step.account.slice(context.step.account.lastIndexOf(":") + 1);
      const userAta = await userPoolTokenAccount(owner, pins.mint);
      return verifyLiquidStake(context, {
        protocol: config.protocol,
        label: config.label,
        mint: pins.mint,
        bind: (step, observations) => {
          const deposits = observations.flatMap((observation) => observation.instructions ?? []).filter((entry) => entry.program === pins.program);
          const bound = deposits.some((entry) =>
            entry.data[0] === STAKE_POOL_INSTRUCTION.depositSolWithSlippage &&
            readU64Le(entry.data, 1)?.toString() === step.input?.amount &&
            entry.accounts[0] === pins.pool &&
            entry.accounts[3] === owner &&
            entry.accounts[4] === userAta &&
            entry.accounts[7] === pins.mint);
          return bound ? null : `No landed transaction deposited ${step.input?.formatted} SOL into the ${config.label} for the step account.`;
        },
      });
    },
  };
}

export const jitoStakePoolAdapter: ProtocolAdapter | null = createStakePoolAdapter(POOLS.jito);
export const sanctumStakePoolAdapter: ProtocolAdapter | null = createStakePoolAdapter(POOLS.sanctum);

