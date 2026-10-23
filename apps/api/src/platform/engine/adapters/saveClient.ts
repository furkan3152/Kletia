/**
 * Save (ex-Solend) client: the pinned main-pool reserve read on-chain, the
 * cToken exchange-rate math and the three instructions a deposit or
 * withdrawal uses, encoded by the engine (no provider API).
 *
 * Layouts follow solendprotocol/solana-program-library (branch `mainnet`,
 * token-lending/sdk): `state/reserve.rs` (619-byte Reserve, `unpack_from_slice`)
 * and `instruction.rs` (RefreshReserve = 3, DepositReserveLiquidity = 4,
 * RedeemReserveCollateral = 5 with their account lists). Offsets were read
 * back against the live USDC and USDT reserves on 2026-10-23 and the
 * refresh + deposit pair simulated on mainnet.
 */
import { address, getAddressEncoder, getProgramDerivedAddress, type Instruction } from "@solana/kit";
import type { SaveReserveVenue } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { readSolanaAccounts, SOLANA_PROGRAM_IDS, type SolanaInstructionView } from "../chains/solana.js";
import { concatBytes, instruction, meta, readPubkey, readU64Le, u64Le } from "./solanaStakeCommon.js";

export const SAVE_INSTRUCTION = Object.freeze({ refreshReserve: 3, depositReserveLiquidity: 4, redeemReserveCollateral: 5 });

const RESERVE_LEN = 619;
const PROGRAM_VERSION = 1;
/** Decimal / Rate fixed point (1e18). */
const WAD = 10n ** 18n;
/** SPL token-lending's initial collateral rate (1 cToken per liquidity unit), used for an empty reserve. */
const INITIAL_COLLATERAL_RATE = WAD;
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/** Byte offsets in the Reserve account (`unpack_from_slice` field order). */
export const SAVE_RESERVE_OFFSETS = Object.freeze({
  version: 0,
  lastUpdateSlot: 1,
  lendingMarket: 10,
  liquidityMint: 42,
  liquidityDecimals: 74,
  liquiditySupply: 75,
  pythOracle: 107,
  switchboardOracle: 139,
  availableAmount: 171,
  borrowedAmountWads: 179,
  collateralMint: 227,
  collateralMintTotalSupply: 259,
  depositLimit: 323,
  accumulatedProtocolFeesWads: 373,
  /** After the 56-byte rate limiter and the round-2 config fields. */
  extraOracle: 489,
});

export interface SaveReserveState {
  readonly market: string;
  readonly liquidityMint: string;
  readonly decimals: number;
  readonly supplyVault: string;
  readonly pythOracle: string;
  readonly switchboardOracle: string;
  /** null when the reserve has no extra oracle (the default pubkey). */
  readonly extraOracle: string | null;
  readonly available: bigint;
  readonly borrowedWads: bigint;
  readonly accumulatedFeesWads: bigint;
  readonly collateralMint: string;
  readonly collateralSupply: bigint;
  /** Deposit limit in liquidity units (0: the reserve takes no deposits). */
  readonly depositLimit: bigint;
}

function u128(data: Uint8Array, offset: number): bigint {
  return (readU64Le(data, offset) ?? 0n) + ((readU64Le(data, offset + 8) ?? 0n) << 64n);
}

/** Decodes a Reserve account; null for data that is not a version-1 reserve. */
export function decodeSaveReserve(data: Uint8Array): SaveReserveState | null {
  const o = SAVE_RESERVE_OFFSETS;
  if (data.length !== RESERVE_LEN || data[o.version] !== PROGRAM_VERSION) return null;
  const key = (offset: number) => readPubkey(data, offset) as string;
  const extra = key(o.extraOracle);
  return {
    market: key(o.lendingMarket),
    liquidityMint: key(o.liquidityMint),
    decimals: data[o.liquidityDecimals] as number,
    supplyVault: key(o.liquiditySupply),
    pythOracle: key(o.pythOracle),
    switchboardOracle: key(o.switchboardOracle),
    extraOracle: extra === DEFAULT_PUBKEY ? null : extra,
    available: readU64Le(data, o.availableAmount) ?? 0n,
    borrowedWads: u128(data, o.borrowedAmountWads),
    accumulatedFeesWads: u128(data, o.accumulatedProtocolFeesWads),
    collateralMint: key(o.collateralMint),
    collateralSupply: readU64Le(data, o.collateralMintTotalSupply) ?? 0n,
    depositLimit: readU64Le(data, o.depositLimit) ?? 0n,
  };
}

/** Total supplied liquidity in WADs: available + borrowed - protocol fees (`ReserveLiquidity::total_supply`). */
export function totalLiquidityWads(state: Pick<SaveReserveState, "available" | "borrowedWads" | "accumulatedFeesWads">): bigint {
  return state.available * WAD + state.borrowedWads - state.accumulatedFeesWads;
}

/** cTokens per liquidity unit, WAD-scaled (`ReserveCollateral::exchange_rate`). */
export function collateralRate(state: Pick<SaveReserveState, "available" | "borrowedWads" | "accumulatedFeesWads" | "collateralSupply">): bigint {
  const total = totalLiquidityWads(state);
  if (state.collateralSupply === 0n || total <= 0n) return INITIAL_COLLATERAL_RATE;
  return (state.collateralSupply * WAD * WAD) / total;
}

/** cTokens minted for `liquidity` at `rate` (rounded down, as the program does). */
export function collateralForLiquidity(rate: bigint, liquidity: bigint): bigint {
  return (liquidity * rate) / WAD;
}

/** Liquidity redeemed for `collateral` at `rate` (rounded down). */
export function liquidityForCollateral(rate: bigint, collateral: bigint): bigint {
  return (collateral * WAD) / rate;
}

/** The fewest cTokens that redeem for at least `liquidity` at `rate`. */
export function collateralForWithdrawal(rate: bigint, liquidity: bigint): bigint {
  let collateral = (liquidity * rate + WAD - 1n) / WAD;
  while (liquidityForCollateral(rate, collateral) < liquidity) collateral += 1n;
  return collateral;
}

/** Underlying per whole cToken as 18-decimal fixed point (journey facts). */
export function saveShareRate(rate: bigint): bigint {
  return (WAD * WAD) / rate;
}

/** PDA([market], program): the market authority that owns every reserve vault. */
export async function saveMarketAuthority(venue: Pick<SaveReserveVenue, "target" | "market">): Promise<string> {
  const [authority] = await getProgramDerivedAddress({
    programAddress: address(venue.target),
    seeds: [getAddressEncoder().encode(address(venue.market))],
  });
  return String(authority);
}

/**
 * Reads the pinned reserve and checks it against the registry: Save owner,
 * 619-byte version-1 reserve, market, liquidity mint, supply vault, cToken
 * mint and decimals, plus the market authority derivation.
 */
export async function readSaveReserve(venue: SaveReserveVenue, liquidityMint: string): Promise<SaveReserveState> {
  const [[account], authority] = await Promise.all([readSolanaAccounts("solana", [venue.reserve]), saveMarketAuthority(venue)]);
  const state = account && account.owner === venue.target ? decodeSaveReserve(account.data) : null;
  if (!state) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s reserve account is missing or not a Save reserve. Kletia will not use it.`, 422);
  }
  if (
    authority !== venue.marketAuthority ||
    state.market !== venue.market ||
    state.liquidityMint !== liquidityMint ||
    state.supplyVault !== venue.supplyVault ||
    state.collateralMint !== venue.receipt.address ||
    state.decimals !== venue.receipt.decimals
  ) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s on-chain reserve does not match the pinned market, mint, vault or cToken. Kletia will not use it.`, 422);
  }
  return state;
}

/** The step account's token accounts for the reserve's liquidity and cToken. */
export interface SaveUserAccounts {
  readonly owner: string;
  readonly liquidity: string;
  readonly collateral: string;
}

/** RefreshReserve: the reserve and its oracles as the reserve itself names them (the program checks them). */
export function refreshReserveInstruction(venue: SaveReserveVenue, state: SaveReserveState): Instruction {
  return instruction(venue.target, [
    meta(venue.reserve, "w"),
    meta(state.pythOracle, "r"),
    meta(state.switchboardOracle, "r"),
    ...(state.extraOracle ? [meta(state.extraOracle, "r")] : []),
  ], Uint8Array.of(SAVE_INSTRUCTION.refreshReserve));
}

/** DepositReserveLiquidity(amount): liquidity from the user's account, cTokens to the user's account. */
export function depositInstruction(venue: SaveReserveVenue, user: SaveUserAccounts, amount: bigint): Instruction {
  return instruction(venue.target, [
    meta(user.liquidity, "w"),
    meta(user.collateral, "w"),
    meta(venue.reserve, "w"),
    meta(venue.supplyVault, "w"),
    meta(venue.receipt.address, "w"),
    meta(venue.market, "r"),
    meta(venue.marketAuthority, "r"),
    meta(user.owner, "rs"),
    meta(SOLANA_PROGRAM_IDS.token, "r"),
  ], concatBytes(Uint8Array.of(SAVE_INSTRUCTION.depositReserveLiquidity), u64Le(amount)));
}

/** RedeemReserveCollateral(collateral): cTokens from the user's account, liquidity to the user's account. */
export function redeemInstruction(venue: SaveReserveVenue, user: SaveUserAccounts, collateral: bigint): Instruction {
  return instruction(venue.target, [
    meta(user.collateral, "w"),
    meta(user.liquidity, "w"),
    meta(venue.reserve, "w"),
    meta(venue.receipt.address, "w"),
    meta(venue.supplyVault, "w"),
    meta(venue.market, "w"),
    meta(venue.marketAuthority, "r"),
    meta(user.owner, "rs"),
    meta(SOLANA_PROGRAM_IDS.token, "r"),
  ], concatBytes(Uint8Array.of(SAVE_INSTRUCTION.redeemReserveCollateral), u64Le(collateral)));
}

/**
 * Checks a landed Save instruction against the step: program, tag, 9-byte
 * data and every account of the deposit / redeem at its position. `amount`
 * (deposit: liquidity units) must match exactly when given. Returns a reason,
 * or null when it matches.
 */
export function saveInstructionMismatch(
  entry: SolanaInstructionView,
  expected: { readonly kind: "deposit" | "withdraw"; readonly venue: SaveReserveVenue; readonly user: SaveUserAccounts; readonly amount: bigint | null },
): string | null {
  const { venue, user } = expected;
  if (entry.program !== venue.target) return "it does not invoke the pinned Save program";
  const tag = expected.kind === "deposit" ? SAVE_INSTRUCTION.depositReserveLiquidity : SAVE_INSTRUCTION.redeemReserveCollateral;
  if (entry.data.length !== 9 || entry.data[0] !== tag) return `it is not a Save ${expected.kind === "deposit" ? "deposit" : "redeem"}`;
  const pinned = expected.kind === "deposit"
    ? [user.liquidity, user.collateral, venue.reserve, venue.supplyVault, venue.receipt.address, venue.market, venue.marketAuthority, user.owner, SOLANA_PROGRAM_IDS.token]
    : [user.collateral, user.liquidity, venue.reserve, venue.receipt.address, venue.supplyVault, venue.market, venue.marketAuthority, user.owner, SOLANA_PROGRAM_IDS.token];
  if (entry.accounts.length < pinned.length) return `it has ${entry.accounts.length} accounts, not ${pinned.length}`;
  const wrong = pinned.findIndex((account, index) => entry.accounts[index] !== account);
  if (wrong >= 0) return `account ${wrong} is ${String(entry.accounts[wrong]).slice(0, 44)}, not ${pinned[wrong]}`;
  const amount = readU64Le(entry.data, 1);
  if (amount === null || amount <= 0n) return "it encodes no amount";
  if (expected.amount !== null && amount !== expected.amount) return `it moves ${amount} units, not ${expected.amount}`;
  return null;
}
