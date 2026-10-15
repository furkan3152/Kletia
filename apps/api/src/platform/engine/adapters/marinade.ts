/**
 * Marinade native mSOL deposits (protocols design 3.4): Anchor
 * `deposit(lamports)` on the pinned Marinade program, which fills the order
 * from its liquidity pool's mSOL leg and mints the rest, both at the state's
 * own price.
 *
 * - Pins (VENUE_CONTRACTS): program, state, mSOL mint and the liquidity
 *   pool's mSOL leg. Plan and prepare read the state account: owner = pinned
 *   program, Anchor `State` discriminator, `msol_mint` and `liq_pool.msol_leg`
 *   equal to their pins, not paused, the amount at least `min_deposit` and
 *   within `staking_sol_cap`. The PDAs (liquidity SOL leg, mSOL leg
 *   authority, reserve, mint authority) are derived from the state and must
 *   reproduce the bumps the state stores.
 * - Expected output = lamports x msol_supply / total virtual staked lamports
 *   (Marinade's `calc_msol_from_lamports`); the guarantee is 5 bps below it.
 *   The program takes no minimum, so the floor is held by verification
 *   (`floor: "claimed"`): mSOL credited to the step account >= the lowest
 *   guaranteed output of any prepared payload.
 */
import { createHash } from "node:crypto";
import { address as toAddress, createNoopSigner, getAddressEncoder, getProgramDerivedAddress, type Instruction } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { PlatformError } from "../../errors.js";
import { assetAmount } from "../assets.js";
import { readSolanaAccounts, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import {
  assertLiquidStakeAction,
  buildStakeTransaction,
  concatBytes,
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
import { userPoolTokenAccount } from "./solanaStakePool.js";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "./types.js";

const LABEL = "Marinade";
const SYMBOL = "mSOL";
/** ATA creation (idempotent) plus the deposit (liquidity-pool swap and mint). */
const DEPOSIT_COMPUTE_UNITS = 200_000;

function anchorDiscriminator(name: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(name).digest().subarray(0, 8));
}

/** Anchor discriminators: the `State` account and the `deposit` instruction. */
export const MARINADE_STATE_DISCRIMINATOR = anchorDiscriminator("account:State");
export const MARINADE_DEPOSIT_DISCRIMINATOR = anchorDiscriminator("global:deposit");

/** Byte offsets of the State fields read here (Anchor layout, 8-byte discriminator first). */
export const MARINADE_STATE_OFFSETS = Object.freeze({
  msolMint: 8,
  reserveBump: 136,
  msolMintAuthorityBump: 137,
  delayedUnstakeCoolingDown: 226,
  totalActiveBalance: 376,
  liqPoolSolLegBump: 418,
  liqPoolMsolLegAuthorityBump: 419,
  liqPoolMsolLeg: 420,
  availableReserveBalance: 496,
  msolSupply: 504,
  circulatingTicketBalance: 528,
  minDeposit: 544,
  stakingSolCap: 560,
  emergencyCoolingDown: 568,
  paused: 608,
});

export interface MarinadeState {
  readonly msolMint: string;
  readonly msolLeg: string;
  readonly reserveBump: number;
  readonly msolMintAuthorityBump: number;
  readonly solLegBump: number;
  readonly msolLegAuthorityBump: number;
  readonly msolSupply: bigint;
  /** total_active_balance + cooling down + available reserve - circulating tickets. */
  readonly totalVirtualStaked: bigint;
  readonly minDeposit: bigint;
  readonly stakingSolCap: bigint;
  readonly paused: boolean;
}

export function decodeMarinadeState(data: Uint8Array): MarinadeState | null {
  const o = MARINADE_STATE_OFFSETS;
  if (data.length <= o.paused || !MARINADE_STATE_DISCRIMINATOR.every((value, index) => data[index] === value)) return null;
  const msolMint = readPubkey(data, o.msolMint);
  const msolLeg = readPubkey(data, o.liqPoolMsolLeg);
  const values = [o.totalActiveBalance, o.delayedUnstakeCoolingDown, o.emergencyCoolingDown, o.availableReserveBalance, o.circulatingTicketBalance, o.msolSupply, o.minDeposit, o.stakingSolCap]
    .map((offset) => readU64Le(data, offset));
  if (!msolMint || !msolLeg || values.some((value) => value === null)) return null;
  const [active, delayed, emergency, available, tickets, msolSupply, minDeposit, stakingSolCap] = values as bigint[];
  const underControl = (active as bigint) + (delayed as bigint) + (emergency as bigint) + (available as bigint);
  return {
    msolMint,
    msolLeg,
    reserveBump: data[o.reserveBump] as number,
    msolMintAuthorityBump: data[o.msolMintAuthorityBump] as number,
    solLegBump: data[o.liqPoolSolLegBump] as number,
    msolLegAuthorityBump: data[o.liqPoolMsolLegAuthorityBump] as number,
    msolSupply: msolSupply as bigint,
    totalVirtualStaked: underControl > (tickets as bigint) ? underControl - (tickets as bigint) : 0n,
    minDeposit: minDeposit as bigint,
    stakingSolCap: stakingSolCap as bigint,
    paused: data[o.paused] !== 0,
  };
}

/** mSOL for `lamports` at the state's price (`shares_from_value`, floor; 1:1 while nothing is staked). */
export function msolForLamports(state: Pick<MarinadeState, "msolSupply" | "totalVirtualStaked">, lamports: bigint): bigint {
  if (state.msolSupply === 0n || state.totalVirtualStaked === 0n) return lamports;
  return (lamports * state.msolSupply) / state.totalVirtualStaked;
}

export interface MarinadePins {
  readonly program: string;
  readonly state: string;
  readonly mint: string;
  readonly msolLeg: string;
}

let pinsMemo: MarinadePins | null = null;

/** Marinade's pins (read once from the frozen VENUE_CONTRACTS; `supports` runs on every route probe). */
export function marinadePins(): MarinadePins {
  pinsMemo ??= {
    program: pinnedSolana("marinade", "solana", "program"),
    state: pinnedSolana("marinade", "solana", "program-state"),
    mint: pinnedSolana("marinade", "solana", "pool-mint"),
    msolLeg: pinnedSolana("marinade", "solana", "liquidity-leg"),
  };
  return pinsMemo;
}

export interface MarinadePdas {
  readonly solLeg: string;
  readonly msolLegAuthority: string;
  readonly reserve: string;
  readonly msolMintAuthority: string;
}

/** The program's PDAs under the state; each bump must equal the one the state stores. */
export async function marinadePdas(pins: Pick<MarinadePins, "program" | "state">, state?: MarinadeState): Promise<MarinadePdas> {
  const derive = async (seed: string, bump: number | undefined, what: string) => {
    const [pda, found] = await getProgramDerivedAddress({
      programAddress: toAddress(pins.program),
      seeds: [getAddressEncoder().encode(toAddress(pins.state)), seed],
    });
    if (bump !== undefined && found !== bump) {
      throw new PlatformError("VENUE_UNVERIFIED", `Marinade's ${what} no longer derives with the bump its state stores. Kletia will not use it.`, 422);
    }
    return String(pda);
  };
  const [solLeg, msolLegAuthority, reserve, msolMintAuthority] = await Promise.all([
    derive("liq_sol", state?.solLegBump, "liquidity SOL leg"),
    derive("liq_st_sol_authority", state?.msolLegAuthorityBump, "mSOL leg authority"),
    derive("reserve", state?.reserveBump, "reserve"),
    derive("st_mint", state?.msolMintAuthorityBump, "mint authority"),
  ]);
  return { solLeg, msolLegAuthority, reserve, msolMintAuthority };
}

/** Refusal for a decoded state against its pins and the amount, or null. */
export function marinadeRefusal(pins: MarinadePins, state: MarinadeState, lamports: bigint): PlatformError | null {
  if (state.msolMint !== pins.mint || state.msolLeg !== pins.msolLeg) {
    return new PlatformError("VENUE_UNVERIFIED", "Marinade's state no longer points at the pinned mSOL mint and liquidity pool. Kletia will not use it.", 422);
  }
  if (state.paused) return new PlatformError("RESERVE_UNAVAILABLE", "Marinade deposits are paused right now; try again later.", 422);
  if (lamports < state.minDeposit) {
    return new PlatformError("AMOUNT_TOO_SMALL", `Marinade takes deposits of at least ${state.minDeposit} lamports.`, 422);
  }
  if (state.totalVirtualStaked + lamports > state.stakingSolCap) {
    return new PlatformError("RESERVE_UNAVAILABLE", "Marinade's staking cap does not fit this deposit right now.", 422);
  }
  return null;
}

export async function readMarinadeState(pins: MarinadePins): Promise<MarinadeState> {
  const [account] = await readSolanaAccounts("solana", [pins.state]);
  if (!account || account.owner !== pins.program) {
    throw new PlatformError("VENUE_UNVERIFIED", "Marinade's state account is missing or not owned by the pinned program.", 422);
  }
  const state = decodeMarinadeState(account.data);
  if (!state) throw new PlatformError("VENUE_UNVERIFIED", "Marinade's state account could not be decoded.", 422);
  return state;
}

export function marinadeDepositData(lamports: bigint): Uint8Array {
  return concatBytes(MARINADE_DEPOSIT_DISCRIMINATOR, u64Le(lamports));
}

/** Idempotent mSOL ATA creation + `deposit(lamports)` (accounts in the program's `Deposit` order). */
export async function marinadeDepositInstructions(pins: MarinadePins, pdas: MarinadePdas, owner: string, lamports: bigint): Promise<Instruction[]> {
  const userAta = await userPoolTokenAccount(owner, pins.mint);
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(toAddress(owner)),
      ata: toAddress(userAta),
      owner: toAddress(owner),
      mint: toAddress(pins.mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    instruction(pins.program, [
      meta(pins.state, "w"),
      meta(pins.mint, "w"),
      meta(pdas.solLeg, "w"),
      meta(pins.msolLeg, "w"),
      meta(pdas.msolLegAuthority, "r"),
      meta(pdas.reserve, "w"),
      meta(owner, "ws"),
      meta(userAta, "w"),
      meta(pdas.msolMintAuthority, "r"),
      meta(SOLANA_PROGRAM_IDS.system, "r"),
      meta(SOLANA_PROGRAM_IDS.token, "r"),
    ], marinadeDepositData(lamports)),
  ];
}

interface Quoted {
  readonly pins: MarinadePins;
  readonly state: MarinadeState;
  readonly amount: bigint;
  readonly expected: bigint;
  readonly minimum: bigint;
}

async function quote(action: AdapterAction): Promise<Quoted> {
  const pins = marinadePins();
  const amount = assertLiquidStakeAction(action, LABEL, SYMBOL, pins.mint);
  const state = await readMarinadeState(pins);
  const refusal = marinadeRefusal(pins, state, amount);
  if (refusal) throw refusal;
  const expected = msolForLamports(state, amount);
  if (expected <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "The amount mints no mSOL.", 422);
  return { pins, state, amount, expected, minimum: lessBps(expected, STAKE_TOLERANCE_BPS) };
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

const WARNINGS = [noUnstakeWarning(LABEL, SYMBOL)];

export const marinadeAdapter: ProtocolAdapter | null = {
  id: "marinade",
  protocols: ["marinade"],
  label: LABEL,

  supports(route) {
    return liquidStakeRoute(route, marinadePins().mint);
  },

  async plan(action): Promise<PlannedStep> {
    const quoted = await quote(action);
    // Derive (and bump-check) the PDAs at plan as well: a drifted state refuses before the review.
    await marinadePdas(quoted.pins, quoted.state);
    const fees = await stakeFeeUsd("solana");
    return {
      protocol: "marinade",
      title: stakeTitle(quoted.amount, LABEL, SYMBOL, "solana"),
      mode: "wallet",
      ...(await amounts(action, quoted)),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: STAKE_ESTIMATED_SECONDS,
      settlement: { kind: "same-network" },
      warnings: [...WARNINGS],
      transactionCount: 1,
      slippageBps: Number(STAKE_TOLERANCE_BPS),
      floor: "claimed",
    };
  },

  async prepare({ action }) {
    const quoted = await quote(action);
    const owner = action.account.address;
    const pdas = await marinadePdas(quoted.pins, quoted.state);
    const built = await buildStakeTransaction(
      "solana",
      owner,
      await marinadeDepositInstructions(quoted.pins, pdas, owner, quoted.amount),
      DEPOSIT_COMPUTE_UNITS,
      "Marinade deposit",
    );
    const fees = await stakeFeeUsd("solana");
    return stakePayload("solana", owner, quoted.pins.program, built, stakeTitle(quoted.amount, LABEL, SYMBOL, "solana"), await amounts(action, quoted), {
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: WARNINGS,
    });
  },

  async verify(context) {
    const pins = marinadePins();
    const owner = context.step.account.slice(context.step.account.lastIndexOf(":") + 1);
    const userAta = await userPoolTokenAccount(owner, pins.mint);
    return verifyLiquidStake(context, {
      protocol: "marinade",
      label: LABEL,
      mint: pins.mint,
      bind: (step, observations) => {
        const bound = observations.flatMap((observation) => observation.instructions ?? []).some((entry) =>
          entry.program === pins.program &&
          MARINADE_DEPOSIT_DISCRIMINATOR.every((value, index) => entry.data[index] === value) &&
          readU64Le(entry.data, 8)?.toString() === step.input?.amount &&
          entry.accounts[0] === pins.state &&
          entry.accounts[1] === pins.mint &&
          entry.accounts[6] === owner &&
          entry.accounts[7] === userAta);
        return bound ? null : `No landed transaction deposited ${step.input?.formatted} SOL into Marinade for the step account.`;
      },
    });
  },
};
