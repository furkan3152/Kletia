/**
 * Hyperliquid: markets and positions from the public /info API, L1 actions
 * (order, cancel, updateLeverage) as EIP-712 typed data for the user's own
 * wallet, USDC deposits through Bridge2 on Arbitrum, and the relay of an
 * action the user signed to /exchange. Kletia never signs: the relay checks
 * that the signature recovers to the account before forwarding it.
 *
 * Signing follows hyperliquid-python-sdk `utils/signing.py`: the action is
 * MessagePack-encoded, followed by the nonce (u64 big-endian) and a zero byte
 * (no vault); its keccak256 is the `connectionId` of a phantom `Agent`
 * message under the domain { name "Exchange", version "1", chainId 1337,
 * verifyingContract 0x0 }, `source` "a" on mainnet. Wallets that insist the
 * domain chain id match the active network (MetaMask) refuse to sign it.
 */
import { GMX_V2_ARBITRUM, HYPERLIQUID_MAINNET, perpsLiquidationPrice, type EvmTransactionRequest, type HyperliquidActionType, type PerpsMarket, type PerpsPosition, type PerpsSide, type PerpsTypedData } from "@kletia/core";
import { concatBytes, encodeFunctionData, erc20Abi, getAddress, keccak256, parseSignature, recoverTypedDataAddress, type Hex } from "viem";
import { PlatformError } from "../errors.js";
import type { PerpsIo } from "./io.js";
import { encodeMsgpack, type MsgpackValue } from "./msgpack.js";

const PROVIDER = "Hyperliquid";
/** Base-tier taker fee of validator-operated perps (Hyperliquid docs, Fees). */
export const HYPERLIQUID_TAKER_FEE_RATE = 0.00045;
/** Largest decimals of a perp price (`MAX_DECIMALS` 6 minus the asset's szDecimals). */
const PERP_PRICE_DECIMALS = 6;
/** A relayed action's nonce must be this close to now (the exchange itself accepts two days back). */
export const HYPERLIQUID_NONCE_WINDOW_MS = 10 * 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface HyperliquidAsset {
  readonly symbol: string;
  /** Index in `meta.universe`: the asset id of every action. */
  readonly asset: number;
  readonly szDecimals: number;
  readonly maxLeverage: number;
  readonly markPrice: number;
  readonly market: PerpsMarket;
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Listed Hyperliquid perps with their asset ids, from `metaAndAssetCtxs`. Refuses an unreadable answer. */
export async function readHyperliquidAssets(io: PerpsIo): Promise<HyperliquidAsset[]> {
  const body = await io.json(PROVIDER, `${HYPERLIQUID_MAINNET.api}/info`, { type: "metaAndAssetCtxs" });
  const meta = Array.isArray(body) ? body[0] : null;
  const contexts = Array.isArray(body) ? body[1] : null;
  if (!isRecord(meta) || !Array.isArray(meta.universe) || !Array.isArray(contexts)) {
    throw new PlatformError("PERPS_PRICE_UNAVAILABLE", "Hyperliquid market data is unreadable.", 503);
  }
  const observedAt = Math.floor(io.now() / 1000);
  const out: HyperliquidAsset[] = [];
  meta.universe.forEach((entry: unknown, asset: number) => {
    const context = contexts[asset];
    if (!isRecord(entry) || !isRecord(context) || typeof entry.name !== "string" || !HYPERLIQUID_MAINNET.markets.includes(entry.name)) return;
    const markPrice = positiveNumber(context.markPx);
    const maxLeverage = typeof entry.maxLeverage === "number" ? entry.maxLeverage : null;
    const szDecimals = typeof entry.szDecimals === "number" ? entry.szDecimals : null;
    if (markPrice === null || maxLeverage === null || szDecimals === null) return;
    const funding = typeof context.funding === "string" ? Number(context.funding) : NaN;
    const openInterest = positiveNumber(context.openInterest);
    const impact = Array.isArray(context.impactPxs) ? context.impactPxs.map(Number) : [];
    const spread = impact.length === 2 && impact.every((value) => value > 0) ? Math.abs(impact[1]! - impact[0]!) / 2 / markPrice : 0;
    out.push({
      symbol: entry.name,
      asset,
      szDecimals,
      maxLeverage,
      markPrice,
      market: {
        venue: "hyperliquid",
        symbol: entry.name,
        marketId: entry.name,
        network: "arbitrum",
        markPrice,
        // Hourly funding; positive: longs pay shorts.
        fundingRate1h: Number.isFinite(funding) ? { long: funding, short: -funding } : { long: 0, short: 0 },
        openInterestUsd: openInterest === null ? null : { long: openInterest * markPrice, short: openInterest * markPrice },
        maxLeverage,
        // Maintenance margin is half the initial margin at max leverage (Hyperliquid docs, Margining).
        maintenanceMarginRate: 1 / (2 * maxLeverage),
        takerFeeRate: HYPERLIQUID_TAKER_FEE_RATE,
        impactPer10kUsd: spread,
        minSizeUsd: 10,
        minCollateralUsd: 0,
        observedAt,
        open: entry.isDelisted !== true,
      },
    });
  });
  return out;
}

interface ClearinghouseState {
  readonly withdrawable: number;
  readonly positions: readonly { readonly coin: string; readonly szi: string; readonly raw: Record<string, unknown> }[];
}

async function readClearinghouse(io: PerpsIo, address: string): Promise<ClearinghouseState> {
  const body = await io.json(PROVIDER, `${HYPERLIQUID_MAINNET.api}/info`, { type: "clearinghouseState", user: address.toLowerCase() });
  if (!isRecord(body) || !Array.isArray(body.assetPositions)) throw new PlatformError("PERPS_PRICE_UNAVAILABLE", "Hyperliquid account state is unreadable.", 503);
  const withdrawable = Number(body.withdrawable);
  return {
    withdrawable: Number.isFinite(withdrawable) ? withdrawable : 0,
    positions: body.assetPositions.flatMap((entry: unknown) => {
      const position = isRecord(entry) && isRecord(entry.position) ? entry.position : null;
      return position && typeof position.coin === "string" && typeof position.szi === "string" ? [{ coin: position.coin, szi: position.szi, raw: position }] : [];
    }),
  };
}

/** Open positions of an address (every coin, the venue's own liquidation price and PnL). */
export async function readHyperliquidPositions(io: PerpsIo, address: string): Promise<PerpsPosition[]> {
  const state = await readClearinghouse(io, address);
  return state.positions.flatMap(({ coin, szi, raw }) => {
    const signed = Number(szi);
    const entryPrice = Number(raw.entryPx);
    const value = Number(raw.positionValue);
    if (!Number.isFinite(signed) || signed === 0 || !(entryPrice > 0)) return [];
    const sizeBase = Math.abs(signed);
    const leverage = isRecord(raw.leverage) && typeof raw.leverage.value === "number" ? raw.leverage.value : null;
    const liquidation = Number(raw.liquidationPx);
    const pnl = Number(raw.unrealizedPnl);
    return [{
      venue: "hyperliquid" as const,
      symbol: coin,
      marketId: coin,
      network: "arbitrum" as const,
      side: (signed > 0 ? "long" : "short") as PerpsSide,
      sizeUsd: Number.isFinite(value) ? value : sizeBase * entryPrice,
      sizeBase,
      collateralUsd: Number(raw.marginUsed) || 0,
      entryPrice,
      markPrice: Number.isFinite(value) && value > 0 ? value / sizeBase : null,
      leverage,
      liquidationPrice: raw.liquidationPx !== null && Number.isFinite(liquidation) && liquidation > 0 ? liquidation : null,
      unrealizedPnlUsd: Number.isFinite(pnl) ? pnl : null,
    }];
  });
}

/* --------------------------------------------------------------- wire */

/** Canonical decimal string (python `float_to_wire`: no exponent, no trailing zeros, "-0" as "0"). */
export function wireDecimal(value: string): string {
  let out = value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;
  if (out === "-0" || out === "") out = "0";
  return out;
}

/**
 * A perp price on the exchange's grid: at most five significant figures and
 * `6 - szDecimals` decimals (integers always valid), rounded toward the
 * tighter side (`up` for a sell's floor, down for a buy's ceiling).
 */
export function hyperliquidPrice(price: number, szDecimals: number, up: boolean): string {
  if (!(price > 0)) throw new PlatformError("PERPS_PRICE_UNAVAILABLE", "No price to place the order at.", 503);
  const integerDigits = Math.floor(Math.log10(price)) + 1;
  const decimals = Math.max(0, Math.min(PERP_PRICE_DECIMALS - szDecimals, 5 - integerDigits));
  const scale = 10 ** decimals;
  const scaled = up ? Math.ceil(price * scale - 1e-9) : Math.floor(price * scale + 1e-9);
  return wireDecimal((scaled / scale).toFixed(decimals));
}

/** A size floored to the asset's `szDecimals`. */
export function hyperliquidSize(sizeBase: number, szDecimals: number): string {
  const scale = 10 ** szDecimals;
  return wireDecimal((Math.floor(sizeBase * scale + 1e-9) / scale).toFixed(szDecimals));
}

export interface HyperliquidOrderInput {
  readonly asset: number;
  readonly isBuy: boolean;
  readonly price: string;
  readonly size: string;
  readonly reduceOnly: boolean;
}

/** An IOC limit order: Hyperliquid's market order, bounded by `price`. */
export function hyperliquidOrderAction(order: HyperliquidOrderInput): Record<string, MsgpackValue> {
  return {
    type: "order",
    orders: [{ a: order.asset, b: order.isBuy, p: order.price, s: order.size, r: order.reduceOnly, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
}

export function hyperliquidCancelAction(asset: number, orderId: number): Record<string, MsgpackValue> {
  return { type: "cancel", cancels: [{ a: asset, o: orderId }] };
}

/** Isolated margin at an integer leverage for the asset (set before opening). */
export function hyperliquidLeverageAction(asset: number, leverage: number): Record<string, MsgpackValue> {
  return { type: "updateLeverage", asset, isCross: false, leverage };
}

/** keccak256(msgpack(action) ‖ nonce u64 BE ‖ 0x00): the phantom agent's connectionId (no vault, no expiry). */
export function hyperliquidActionHash(action: MsgpackValue, nonce: number): Hex {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
  return keccak256(concatBytes([encodeMsgpack(action), nonceBytes, new Uint8Array([0])]));
}

/** The EIP-712 message the user's wallet signs for an L1 action on mainnet. */
export function hyperliquidTypedData(action: MsgpackValue, nonce: number): PerpsTypedData {
  return {
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: "a", connectionId: hyperliquidActionHash(action, nonce) },
  };
}

/** USDC transfer to Bridge2 on Arbitrum: credited to the sender's Hyperliquid account in about a minute. */
export function hyperliquidDepositTransaction(from: string, amountBaseUnits: bigint): EvmTransactionRequest {
  if (amountBaseUnits < BigInt(HYPERLIQUID_MAINNET.minDepositUsdc) * 1_000_000n) {
    throw new PlatformError("PERPS_COLLATERAL_TOO_LOW", `Bridge2 loses deposits below ${HYPERLIQUID_MAINNET.minDepositUsdc} USDC, so Kletia never builds one.`, 422);
  }
  return {
    vm: "evm",
    network: "arbitrum",
    chainId: GMX_V2_ARBITRUM.chainId,
    from: getAddress(from),
    to: getAddress(HYPERLIQUID_MAINNET.usdc),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(HYPERLIQUID_MAINNET.bridge), amountBaseUnits] }),
    value: "0",
    description: `Deposit ${Number(amountBaseUnits) / 1e6} USDC to Hyperliquid (Bridge2 on Arbitrum)`,
  };
}

/** Withdrawable USDC and the signed size of `coin` for an address. */
export async function readHyperliquidAccount(io: PerpsIo, address: string, coin: string): Promise<{ readonly withdrawable: number; readonly szi: string | null }> {
  const state = await readClearinghouse(io, address);
  return { withdrawable: state.withdrawable, szi: state.positions.find((position) => position.coin === coin)?.szi ?? null };
}

/** Estimated isolated liquidation price of a new position. */
export function hyperliquidLiquidation(side: PerpsSide, entryPrice: number, sizeUsd: number, marginUsd: number, maxLeverage: number): number | null {
  return perpsLiquidationPrice({ side, entryPrice, sizeUsd, collateralUsd: marginUsd, maintenanceMarginRate: 1 / (2 * maxLeverage) });
}

/* -------------------------------------------------------------- relay */

const ACTION_TYPES: readonly HyperliquidActionType[] = ["order", "cancel", "updateLeverage"];
const WIRE_DECIMAL = /^\d{1,12}(?:\.\d{1,8})?$/u;
const isAssetId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < 100_000;

function invalidAction(message: string): PlatformError {
  return new PlatformError("PERPS_SIGNATURE_INVALID", message, 400);
}

/**
 * Rebuilds a client-sent action in canonical key order from validated
 * fields, so the relayed bytes are exactly what Kletia would have prepared.
 * Only single IOC orders, cancels and isolated leverage updates pass.
 */
export function canonicalHyperliquidAction(input: unknown): Record<string, MsgpackValue> {
  if (!isRecord(input) || !(ACTION_TYPES as readonly unknown[]).includes(input.type)) throw invalidAction("Relay only order, cancel and updateLeverage actions.");
  if (input.type === "updateLeverage") {
    if (!isAssetId(input.asset) || input.isCross !== false || !Number.isSafeInteger(input.leverage) || (input.leverage as number) < 1 || (input.leverage as number) > 100) {
      throw invalidAction("updateLeverage needs an asset, isCross false and an integer leverage.");
    }
    return hyperliquidLeverageAction(input.asset, input.leverage as number);
  }
  if (input.type === "cancel") {
    const cancel = Array.isArray(input.cancels) && input.cancels.length === 1 && isRecord(input.cancels[0]) ? input.cancels[0] : null;
    if (!cancel || !isAssetId(cancel.a) || !Number.isSafeInteger(cancel.o) || (cancel.o as number) < 0) throw invalidAction("cancel needs one { a, o }.");
    return hyperliquidCancelAction(cancel.a, cancel.o as number);
  }
  const order = Array.isArray(input.orders) && input.orders.length === 1 && isRecord(input.orders[0]) ? input.orders[0] : null;
  const limit = order && isRecord(order.t) && isRecord(order.t.limit) ? order.t.limit : null;
  if (
    !order || input.grouping !== "na" || !isAssetId(order.a) || typeof order.b !== "boolean" || typeof order.r !== "boolean" ||
    typeof order.p !== "string" || !WIRE_DECIMAL.test(order.p) || typeof order.s !== "string" || !WIRE_DECIMAL.test(order.s) || limit?.tif !== "Ioc"
  ) {
    throw invalidAction("order needs one IOC limit order { a, b, p, s, r, t } and grouping na.");
  }
  return hyperliquidOrderAction({ asset: order.a, isBuy: order.b, price: order.p, size: order.s, reduceOnly: order.r });
}

export interface HyperliquidRelayInput {
  readonly account: string;
  readonly action: unknown;
  readonly nonce: unknown;
  readonly signature: unknown;
}

export interface HyperliquidRelayResult {
  readonly status: "ok";
  /** The exchange's per-order statuses (resting, filled with its average price, ...). */
  readonly response: unknown;
}

/** Relays an action the account signed: checks the signature recovers to it, then forwards to /exchange. */
export async function relayHyperliquidAction(io: PerpsIo, input: HyperliquidRelayInput): Promise<HyperliquidRelayResult> {
  const action = canonicalHyperliquidAction(input.action);
  const nonce = input.nonce;
  if (!Number.isSafeInteger(nonce) || Math.abs((nonce as number) - io.now()) > HYPERLIQUID_NONCE_WINDOW_MS) {
    throw invalidAction("The nonce is not a recent millisecond timestamp: prepare the action again.");
  }
  if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/u.test(input.signature)) throw invalidAction("Send the 65-byte hex signature from the wallet.");
  const typed = hyperliquidTypedData(action, nonce as number);
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({ ...typed, domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as Hex }, message: { source: typed.message.source!, connectionId: typed.message.connectionId as Hex }, signature: input.signature as Hex });
  } catch {
    throw invalidAction("The signature does not recover to an address.");
  }
  if (signer.toLowerCase() !== input.account.toLowerCase()) throw invalidAction("The signature is not from this account: Kletia relays only actions the account signed itself.");
  const { r, s, yParity } = parseSignature(input.signature as Hex);
  const body = await io.json(PROVIDER, `${HYPERLIQUID_MAINNET.api}/exchange`, {
    action,
    nonce,
    signature: { r, s, v: Number(yParity) + 27 },
    vaultAddress: null,
  });
  if (!isRecord(body) || body.status !== "ok") {
    const reason = isRecord(body) && typeof body.response === "string" ? body.response : "unreadable answer";
    throw new PlatformError("PERPS_RELAY_REJECTED", `Hyperliquid refused the action: ${reason.slice(0, 200)}`, 422);
  }
  const statuses = isRecord(body.response) && isRecord(body.response.data) && Array.isArray(body.response.data.statuses) ? body.response.data.statuses : [];
  const failed = statuses.find((status: unknown) => isRecord(status) && typeof status.error === "string") as { error: string } | undefined;
  if (failed) throw new PlatformError("PERPS_RELAY_REJECTED", `Hyperliquid refused the order: ${failed.error.slice(0, 200)}`, 422);
  return { status: "ok", response: body.response ?? null };
}

