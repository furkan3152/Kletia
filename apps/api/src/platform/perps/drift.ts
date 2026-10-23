/**
 * Drift v2 on Solana: account decoding (PerpMarket, User) and the
 * instructions a perp trade needs (initialize_user_stats, initialize_user,
 * deposit, place_perp_order), built from the program's IDL layout (Drift
 * protocol-v2 v2.156.0 `idl/drift.json`): Anchor discriminators
 * sha256("global:<name>")[0..8], Borsh arguments, accounts in IDL order and
 * the remaining accounts Drift loads (oracles, then spot markets, then perp
 * markets; markets writable).
 *
 * The venue is disabled (`PERPS_VENUES`): Drift v2 has not filled an order
 * since the April 1, 2026 exploit. Kletia still reads positions so users can
 * see what they hold; `readDriftMarkets` reports no market whose oracle price
 * is stale, and the service refuses to prepare. Offsets below were computed
 * from the IDL (zero-copy accounts, 8-byte discriminator first) and checked
 * against mainnet accounts on 2026-10-23.
 */
import { createHash } from "node:crypto";
import { DRIFT_V2_SOLANA, type PerpsMarket, type PerpsPosition } from "@kletia/core";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address as toAddress, getAddressEncoder, getProgramDerivedAddress, type Instruction } from "@solana/kit";
import { SOLANA_PROGRAM_IDS } from "../engine/chains/solana.js";
import { concatBytes, instruction, meta, readPubkey, u64Le } from "../engine/adapters/solanaStakeCommon.js";
import { PlatformError } from "../errors.js";
import type { PerpsIo } from "./io.js";

const PROGRAM = DRIFT_V2_SOLANA.program;
const PRICE_PRECISION = 1e6;
const BASE_PRECISION = 1e9;
const QUOTE_PRECISION = 1e6;
const MARGIN_PRECISION = 1e4;
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";

/** PerpMarket field offsets (account size 1,216). */
export const DRIFT_PERP_MARKET = Object.freeze({
  size: 1216,
  oracle: 40,
  lastOraclePrice: 72,
  lastOraclePriceTwapTs: 112,
  baseAssetAmountLong: 304,
  baseAssetAmountShort: 320,
  lastFundingRate: 480,
  orderStepSize: 808,
  lastTradeTs: 864,
  marginRatioMaintenance: 1140,
  marketIndex: 1160,
  status: 1162,
});
/** SpotMarket: the oracle pubkey (account size 776). */
export const DRIFT_SPOT_MARKET = Object.freeze({ oracle: 40, vault: 104 });
/** User: 8 PerpPosition entries of 96 bytes from offset 424 (account size 4,376). */
export const DRIFT_USER = Object.freeze({ size: 4376, authority: 8, perpPositions: 424, perpPositionSize: 96, perpPositionCount: 8, spotPositions: 104, spotPositionSize: 40 });

export function anchorDiscriminator(name: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
}

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const i64 = (data: Uint8Array, offset: number) => view(data).getBigInt64(offset, true);
/** Low 64 bits of an i128 (amounts here never exceed them). */
const i128Low = (data: Uint8Array, offset: number) => view(data).getBigInt64(offset, true);

async function pda(seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"]): Promise<string> {
  const [found] = await getProgramDerivedAddress({ programAddress: toAddress(PROGRAM), seeds: [...seeds] });
  return String(found);
}

function u16Le(value: number): Uint8Array {
  const out = new Uint8Array(2);
  view(out).setUint16(0, value, true);
  return out;
}

export const driftPdas = {
  state: () => pda(["drift_state"]),
  perpMarket: (index: number) => pda(["perp_market", u16Le(index)]),
  spotMarket: (index: number) => pda(["spot_market", u16Le(index)]),
  spotMarketVault: (index: number) => pda(["spot_market_vault", u16Le(index)]),
  userStats: (authority: string) => pda(["user_stats", getAddressEncoder().encode(toAddress(authority))]),
  user: (authority: string, subAccount = 0) => pda(["user", getAddressEncoder().encode(toAddress(authority)), u16Le(subAccount)]),
};

export interface DriftPerpMarketState {
  readonly marketIndex: number;
  readonly oracle: string;
  readonly oraclePrice: number;
  readonly oraclePriceTs: number;
  readonly lastTradeTs: number;
  readonly fundingRate1h: number;
  readonly openInterestBase: { readonly long: number; readonly short: number };
  readonly maintenanceMarginRate: number;
  readonly status: number;
  /** Order sizes are multiples of this (BASE_PRECISION units). */
  readonly orderStepSize: bigint;
}

/** Decodes a PerpMarket account; null when it is not one. */
export function decodeDriftPerpMarket(data: Uint8Array): DriftPerpMarketState | null {
  if (data.length !== DRIFT_PERP_MARKET.size) return null;
  const oracle = readPubkey(data, DRIFT_PERP_MARKET.oracle);
  if (!oracle) return null;
  const oraclePrice = Number(i64(data, DRIFT_PERP_MARKET.lastOraclePrice)) / PRICE_PRECISION;
  return {
    marketIndex: view(data).getUint16(DRIFT_PERP_MARKET.marketIndex, true),
    oracle,
    oraclePrice,
    oraclePriceTs: Number(i64(data, DRIFT_PERP_MARKET.lastOraclePriceTwapTs)),
    lastTradeTs: Number(i64(data, DRIFT_PERP_MARKET.lastTradeTs)),
    // last_funding_rate is quote per base (FUNDING_RATE_PRECISION 1e9) for one funding period (1 h); as a fraction of the price:
    fundingRate1h: oraclePrice > 0 ? Number(i64(data, DRIFT_PERP_MARKET.lastFundingRate)) / 1e9 / oraclePrice : 0,
    openInterestBase: {
      long: Number(i128Low(data, DRIFT_PERP_MARKET.baseAssetAmountLong)) / BASE_PRECISION,
      short: Math.abs(Number(i128Low(data, DRIFT_PERP_MARKET.baseAssetAmountShort))) / BASE_PRECISION,
    },
    maintenanceMarginRate: view(data).getUint32(DRIFT_PERP_MARKET.marginRatioMaintenance, true) / MARGIN_PRECISION,
    status: data[DRIFT_PERP_MARKET.status] ?? 0,
    orderStepSize: view(data).getBigUint64(DRIFT_PERP_MARKET.orderStepSize, true),
  };
}

async function readPerpMarkets(io: PerpsIo): Promise<Map<string, DriftPerpMarketState>> {
  const symbols = Object.keys(DRIFT_V2_SOLANA.perpMarkets);
  const addresses = await Promise.all(symbols.map((symbol) => driftPdas.perpMarket(DRIFT_V2_SOLANA.perpMarkets[symbol]!)));
  const accounts = await io.solanaAccounts(addresses);
  const out = new Map<string, DriftPerpMarketState>();
  accounts.forEach((account, index) => {
    const decoded = account && account.owner === PROGRAM ? decodeDriftPerpMarket(account.data) : null;
    if (decoded && decoded.marketIndex === DRIFT_V2_SOLANA.perpMarkets[symbols[index]!]) out.set(symbols[index]!, decoded);
  });
  return out;
}

/** Drift markets whose oracle price is fresh (none while the venue is halted: a stale price is never shown as a mark). */
export async function readDriftMarkets(io: PerpsIo, maxAgeSeconds: number): Promise<PerpsMarket[]> {
  const now = Math.floor(io.now() / 1000);
  const markets = await readPerpMarkets(io);
  return [...markets.entries()].flatMap(([symbol, market]) => {
    if (now - market.oraclePriceTs > maxAgeSeconds || !(market.oraclePrice > 0)) return [];
    return [{
      venue: "drift-v2" as const,
      symbol,
      marketId: String(market.marketIndex),
      network: "solana" as const,
      markPrice: market.oraclePrice,
      fundingRate1h: { long: market.fundingRate1h, short: -market.fundingRate1h },
      openInterestUsd: { long: market.openInterestBase.long * market.oraclePrice, short: market.openInterestBase.short * market.oraclePrice },
      maxLeverage: 20,
      maintenanceMarginRate: market.maintenanceMarginRate,
      takerFeeRate: 0.00035,
      impactPer10kUsd: 0,
      minSizeUsd: 1,
      minCollateralUsd: 1,
      observedAt: market.oraclePriceTs,
      open: market.status === 1,
    }];
  });
}

export interface DriftPerpPositionState {
  readonly marketIndex: number;
  readonly baseAssetAmount: bigint;
  readonly quoteEntryAmount: bigint;
}

/** Non-empty perp positions of a User account; null when it is not one. */
export function decodeDriftUserPositions(data: Uint8Array): { readonly authority: string; readonly positions: DriftPerpPositionState[] } | null {
  if (data.length !== DRIFT_USER.size) return null;
  const authority = readPubkey(data, DRIFT_USER.authority);
  if (!authority) return null;
  const positions: DriftPerpPositionState[] = [];
  for (let slot = 0; slot < DRIFT_USER.perpPositionCount; slot += 1) {
    const base = DRIFT_USER.perpPositions + slot * DRIFT_USER.perpPositionSize;
    const baseAssetAmount = i64(data, base + 8);
    if (baseAssetAmount === 0n) continue;
    positions.push({ marketIndex: view(data).getUint16(base + 92, true), baseAssetAmount, quoteEntryAmount: i64(data, base + 32) });
  }
  return { authority, positions };
}

/**
 * Perp positions of subaccount 0 of `authority`. Drift margins across the
 * whole account, so a position carries no collateral of its own; the mark
 * (and with it PnL and the liquidation estimate) is left out while prices
 * are stale.
 */
export async function readDriftPositions(io: PerpsIo, authority: string, maxAgeSeconds: number): Promise<PerpsPosition[]> {
  const [account] = await io.solanaAccounts([await driftPdas.user(authority)]);
  if (!account || account.owner !== PROGRAM) return [];
  const user = decodeDriftUserPositions(account.data);
  if (!user || user.authority !== authority) return [];
  const markets = await readPerpMarkets(io);
  const now = Math.floor(io.now() / 1000);
  return user.positions.flatMap((position) => {
    const entry = [...markets.entries()].find(([, market]) => market.marketIndex === position.marketIndex);
    const symbol = entry?.[0] ?? `PERP-${position.marketIndex}`;
    const sizeBase = Math.abs(Number(position.baseAssetAmount)) / BASE_PRECISION;
    const entryPrice = sizeBase > 0 ? Math.abs(Number(position.quoteEntryAmount)) / QUOTE_PRECISION / sizeBase : 0;
    const fresh = entry && now - entry[1].oraclePriceTs <= maxAgeSeconds ? entry[1].oraclePrice : null;
    const side = position.baseAssetAmount > 0n ? ("long" as const) : ("short" as const);
    return [{
      venue: "drift-v2" as const,
      symbol,
      marketId: String(position.marketIndex),
      network: "solana" as const,
      side,
      sizeUsd: sizeBase * entryPrice,
      sizeBase,
      collateralUsd: null,
      entryPrice,
      markPrice: fresh,
      leverage: null,
      liquidationPrice: null,
      unrealizedPnlUsd: fresh === null ? null : (side === "long" ? 1 : -1) * sizeBase * (fresh - entryPrice),
    }];
  });
}

/* ------------------------------------------------------------ builders */

export interface DriftOrderParams {
  readonly direction: "long" | "short";
  /** BASE_PRECISION (1e9) units. */
  readonly baseAssetAmount: bigint;
  /** Limit price, PRICE_PRECISION (1e6); the order never fills past it. */
  readonly price: bigint;
  readonly marketIndex: number;
  readonly reduceOnly: boolean;
}

const option = (value: Uint8Array | null): Uint8Array => (value === null ? Uint8Array.of(0) : concatBytes(Uint8Array.of(1), value));

/**
 * Borsh OrderParams of a perp market order: orderType Market, marketType
 * Perp, postOnly None, no trigger, the auction left to the program.
 */
export function encodeDriftOrderParams(params: DriftOrderParams): Uint8Array {
  return concatBytes(
    Uint8Array.of(0, 1, params.direction === "long" ? 0 : 1, 0), // orderType Market, marketType Perp, direction, userOrderId
    u64Le(params.baseAssetAmount),
    u64Le(params.price),
    u16Le(params.marketIndex),
    Uint8Array.of(params.reduceOnly ? 1 : 0, 0, 0), // reduceOnly, postOnly None, bitFlags
    option(null), // maxTs
    option(null), // triggerPrice
    Uint8Array.of(0), // triggerCondition Above
    option(null), // oraclePriceOffset
    option(null), // auctionDuration
    option(null), // auctionStartPrice
    option(null), // auctionEndPrice
  );
}

/**
 * Markets Drift must load to check margin: every perp market the user holds
 * plus the one traded (first), and the USDC spot market. Remaining accounts
 * go oracles first, then spot markets, then perp markets (drift-labs/sdk
 * `getRemainingAccounts`).
 */
export interface DriftMarketAccounts {
  readonly perps: readonly { readonly market: string; readonly oracle: string }[];
  readonly spotMarket: string;
  readonly spotOracle: string;
}

function remainingAccounts(markets: DriftMarketAccounts, spotWritable: boolean): ReturnType<typeof meta>[] {
  const oracles = [...new Set([...markets.perps.map((perp) => perp.oracle), markets.spotOracle])];
  return [
    ...oracles.map((oracle) => meta(oracle, "r")),
    meta(markets.spotMarket, spotWritable ? "w" : "r"),
    ...[...new Set(markets.perps.map((perp) => perp.market))].map((market) => meta(market, "r")),
  ];
}

/** initialize_user_stats + initialize_user (subaccount 0, name "Kletia") for a new authority. */
export async function driftInitializeInstructions(authority: string): Promise<Instruction[]> {
  const [state, userStats, user] = await Promise.all([driftPdas.state(), driftPdas.userStats(authority), driftPdas.user(authority)]);
  const name = new Uint8Array(32);
  name.set(new TextEncoder().encode("Kletia"));
  return [
    instruction(PROGRAM, [meta(userStats, "w"), meta(state, "w"), meta(authority, "r"), meta(authority, "ws"), meta(RENT_SYSVAR, "r"), meta(SOLANA_PROGRAM_IDS.system, "r")], anchorDiscriminator("initialize_user_stats")),
    instruction(PROGRAM, [meta(user, "w"), meta(userStats, "w"), meta(state, "w"), meta(authority, "r"), meta(authority, "ws"), meta(RENT_SYSVAR, "r"), meta(SOLANA_PROGRAM_IDS.system, "r")], concatBytes(anchorDiscriminator("initialize_user"), u16Le(0), name)),
  ];
}

/** deposit(marketIndex 0 = USDC, amount, reduceOnly false) from the authority's USDC token account. */
export async function driftDepositInstruction(authority: string, amount: bigint, markets: DriftMarketAccounts): Promise<Instruction> {
  const [state, user, userStats, vault] = await Promise.all([driftPdas.state(), driftPdas.user(authority), driftPdas.userStats(authority), driftPdas.spotMarketVault(DRIFT_V2_SOLANA.usdcSpotMarket)]);
  const [tokenAccount] = await findAssociatedTokenPda({ owner: toAddress(authority), mint: toAddress(DRIFT_V2_SOLANA.usdcMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return instruction(
    PROGRAM,
    [
      meta(state, "r"), meta(user, "w"), meta(userStats, "w"), meta(authority, "rs"), meta(vault, "w"), meta(String(tokenAccount), "w"), meta(SOLANA_PROGRAM_IDS.token, "r"),
      ...remainingAccounts(markets, true),
    ],
    concatBytes(anchorDiscriminator("deposit"), u16Le(DRIFT_V2_SOLANA.usdcSpotMarket), u64Le(amount), Uint8Array.of(0)),
  );
}

/** place_perp_order (a reduce-only order in the opposite direction closes or reduces a position). */
export async function driftPlacePerpOrderInstruction(authority: string, params: DriftOrderParams, markets: DriftMarketAccounts): Promise<Instruction> {
  const [state, user] = await Promise.all([driftPdas.state(), driftPdas.user(authority)]);
  return instruction(
    PROGRAM,
    [meta(state, "r"), meta(user, "w"), meta(authority, "rs"), ...remainingAccounts(markets, false)],
    concatBytes(anchorDiscriminator("place_perp_order"), encodeDriftOrderParams(params)),
  );
}

export interface DriftTradeInput {
  readonly authority: string;
  readonly symbol: string;
  readonly side: "long" | "short";
  /** Reduce-only in the opposite direction (decrease, close). */
  readonly reduce: boolean;
  /** Base size to trade (BASE_PRECISION); "all" closes the whole position. */
  readonly baseAmount: bigint | "all";
  /** Worst price (USD) the order may fill at. */
  readonly limitPrice: number;
  /** USDC base units to deposit first (open, increase). */
  readonly depositUsdc: bigint;
}

/**
 * Instructions of one Drift trade: account setup for a new authority, the
 * USDC deposit, then the order. Refuses an account holding perp markets
 * Kletia does not load (their markets would be missing from the margin check).
 */
export async function driftTradeInstructions(io: PerpsIo, input: DriftTradeInput): Promise<Instruction[]> {
  const index = DRIFT_V2_SOLANA.perpMarkets[input.symbol];
  if (index === undefined) throw new PlatformError("PERPS_MARKET_UNSUPPORTED", `Kletia lists no Drift ${input.symbol} market.`, 422);
  const [markets, userAddress, spotAddress] = await Promise.all([readPerpMarkets(io), driftPdas.user(input.authority), driftPdas.spotMarket(DRIFT_V2_SOLANA.usdcSpotMarket)]);
  const [userAccount, spotAccount] = await io.solanaAccounts([userAddress, spotAddress]);
  const spotOracle = spotAccount && spotAccount.owner === PROGRAM ? readPubkey(spotAccount.data, DRIFT_SPOT_MARKET.oracle) : null;
  const byIndex = new Map([...markets.values()].map((market) => [market.marketIndex, market]));
  const traded = byIndex.get(index);
  if (!spotOracle || !traded) throw new PlatformError("PERPS_PRICE_UNAVAILABLE", "Drift's markets could not be read.", 503);
  const user = userAccount && userAccount.owner === PROGRAM ? decodeDriftUserPositions(userAccount.data) : null;
  const held = user?.positions ?? [];
  if (held.some((position) => !byIndex.has(position.marketIndex))) {
    throw new PlatformError("PERPS_MARKET_UNSUPPORTED", "This Drift account holds perp markets Kletia does not load, so the margin check would miss them.", 422);
  }
  const current = held.find((position) => position.marketIndex === index);
  let base: bigint;
  if (input.baseAmount === "all") {
    if (!current) throw new PlatformError("PERPS_POSITION_NOT_FOUND", `No Drift ${input.symbol} position to close.`, 422);
    base = current.baseAssetAmount < 0n ? -current.baseAssetAmount : current.baseAssetAmount;
  } else {
    base = traded.orderStepSize > 0n ? (input.baseAmount / traded.orderStepSize) * traded.orderStepSize : input.baseAmount;
  }
  if (base === 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `The size is below Drift's ${input.symbol} order step.`, 422);
  const perpIndexes = [index, ...held.map((position) => position.marketIndex).filter((other) => other !== index)];
  const accounts: DriftMarketAccounts = {
    perps: await Promise.all(perpIndexes.map(async (perp) => ({ market: await driftPdas.perpMarket(perp), oracle: byIndex.get(perp)!.oracle }))),
    spotMarket: spotAddress,
    spotOracle,
  };
  const direction = input.reduce ? (input.side === "long" ? "short" : "long") : input.side;
  return [
    ...(user ? [] : await driftInitializeInstructions(input.authority)),
    ...(input.depositUsdc > 0n ? [await driftDepositInstruction(input.authority, input.depositUsdc, accounts)] : []),
    await driftPlacePerpOrderInstruction(input.authority, { direction, baseAssetAmount: base, price: BigInt(Math.round(input.limitPrice * PRICE_PRECISION)), marketIndex: index, reduceOnly: input.reduce }, accounts),
  ];
}
