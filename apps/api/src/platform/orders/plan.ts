/**
 * planNativeOrder: the typed entry point from a sentence (or a form) to a
 * native protocol order. Pure: no asset lookups, no network reads. It checks
 * the shape, picks the network and protocol, and leaves amounts as decimals
 * for the service to convert once the assets are resolved.
 *
 *   sell 1 WETH at 4000 on base         { kind: "limit", sell: "WETH", buy: "USDC", amount: "1", price: "4000", network: "base" }
 *   buy SOL with 500 USDC over 10 days  { kind: "dca", sell: "USDC", buy: "SOL", amount: "500", period: "day", count: 10 }
 *   limit buy 1000 JUP at 0.8           { kind: "limit", sell: "USDC", buy: "JUP", amount: "1000", amountIn: "buy", price: "0.8" }
 */
import { CHAINS, findAssetBySymbol, isDecimalAmount, isEvmAddress, isSolanaAddress } from "@kletia/core";
import { PlatformError, type PlatformIssue } from "../errors.js";
import {
  ORDER_NETWORKS,
  type NativeOrderKind,
  type NativeOrderMechanism,
  type NativeOrderPlan,
  type NativeOrderProtocol,
  type OrderAmountSide,
  type OrderNetwork,
} from "./types.js";

export type OrderPeriod = "minute" | "hour" | "day" | "week" | "month";

export const ORDER_PERIOD_SECONDS: Readonly<Record<OrderPeriod, number>> = Object.freeze({
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
});

/** Bounds shared by every DCA protocol (Jupiter Recurring and the CoW TWAP handler accept wider ranges). */
export const ORDER_LIMITS = Object.freeze({
  minPeriodSeconds: 60,
  maxPeriodSeconds: 31_536_000,
  minCount: 2,
  maxCount: 1_000,
  maxExpirySeconds: 31_536_000,
});

export interface NativeOrderInput {
  readonly kind: NativeOrderKind;
  /** Symbol, address or mint of the asset sold. */
  readonly sell: string;
  /** Symbol, address or mint of the asset bought. */
  readonly buy: string;
  /** Positive decimal; for DCA the total amount sold. */
  readonly amount: string | number;
  /** Which asset `amount` counts (default `sell`; DCA only `sell`). */
  readonly amountIn?: OrderAmountSide;
  /** Limit (required): counter-asset units per one unit of the `amountIn` asset. DCA (optional): least `buy` per one `sell`. */
  readonly price?: string | number;
  /** DCA: a named period or seconds between parts. */
  readonly period?: OrderPeriod | number;
  /** DCA: number of parts. */
  readonly count?: number;
  /** solana, ethereum, arbitrum or base; inferred from the assets when only one network fits. */
  readonly network?: string;
  /** Limit: ISO time or unix seconds after which the order stops filling. */
  readonly expiresAt?: string | number | null;
}

const PROTOCOLS: Readonly<Record<NativeOrderKind, { readonly svm: [NativeOrderProtocol, NativeOrderMechanism]; readonly evm: [NativeOrderProtocol, NativeOrderMechanism] }>> = {
  limit: { svm: ["jupiter-trigger", "limit"], evm: ["cow-protocol", "limit"] },
  dca: { svm: ["jupiter-recurring", "recurring"], evm: ["cow-protocol", "twap"] },
};

function decimal(value: unknown): string | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return text.length <= 40 && isDecimalAmount(text) && /[1-9]/u.test(text) ? text : null;
}

function fitsNetwork(network: OrderNetwork, asset: string): boolean {
  if (CHAINS[network].vm === "svm") return isSolanaAddress(asset) || findAssetBySymbol(network, asset) !== null;
  return isEvmAddress(asset) || findAssetBySymbol(network, asset) !== null;
}

function pickNetwork(input: NativeOrderInput, issues: PlatformIssue[]): OrderNetwork | null {
  if (input.network !== undefined) {
    const named = ORDER_NETWORKS.find((network) => network === String(input.network).trim().toLowerCase());
    if (named) return named;
    throw new PlatformError("ORDER_UNSUPPORTED", `Native orders run on ${ORDER_NETWORKS.join(", ")}; not on ${String(input.network).slice(0, 40)}.`, 422, undefined, undefined, {
      reason: "network",
      networks: [...ORDER_NETWORKS],
    });
  }
  if (issues.length > 0) return null;
  const candidates = ORDER_NETWORKS.filter((network) => fitsNetwork(network, input.sell) && fitsNetwork(network, input.buy));
  if (candidates.length === 1) return candidates[0] as OrderNetwork;
  if (candidates.length === 0) {
    throw new PlatformError("ORDER_UNSUPPORTED", `No order network lists both ${input.sell} and ${input.buy}.`, 422, undefined, undefined, { reason: "assets" });
  }
  throw new PlatformError("ORDER_NETWORK_REQUIRED", `${input.sell} and ${input.buy} exist on ${candidates.join(", ")}. Name the network.`, 422, undefined, undefined, {
    candidates,
  });
}

function periodSeconds(period: unknown): number | null {
  if (typeof period === "number") return Number.isInteger(period) ? period : null;
  if (typeof period !== "string") return null;
  const named = ORDER_PERIOD_SECONDS[period.trim().toLowerCase() as OrderPeriod];
  return named ?? null;
}

function expirySeconds(value: unknown, now: number): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const seconds = typeof value === "number" ? value : Math.floor(Date.parse(String(value)) / 1000);
  if (!Number.isInteger(seconds) || seconds <= now || seconds > now + ORDER_LIMITS.maxExpirySeconds) return "invalid";
  return seconds;
}

/**
 * Checks an order intent and picks its protocol. Throws ORDER_INVALID with
 * per-field issues, ORDER_NETWORK_REQUIRED (error.details.candidates) when
 * the assets fit several networks, or ORDER_UNSUPPORTED.
 */
export function planNativeOrder(input: NativeOrderInput, now = Math.floor(Date.now() / 1000)): NativeOrderPlan {
  const issues: PlatformIssue[] = [];
  const kind = input.kind;
  if (kind !== "limit" && kind !== "dca") issues.push({ path: "kind", message: "kind is limit or dca." });
  const sell = typeof input.sell === "string" ? input.sell.trim() : "";
  const buy = typeof input.buy === "string" ? input.buy.trim() : "";
  if (!sell || sell.length > 64) issues.push({ path: "sell", message: "Name the asset sold (symbol, address or mint)." });
  if (!buy || buy.length > 64) issues.push({ path: "buy", message: "Name the asset bought (symbol, address or mint)." });
  if (sell && buy && sell.toLowerCase() === buy.toLowerCase()) issues.push({ path: "buy", message: "Sell and buy different assets." });
  const amount = decimal(input.amount);
  if (!amount) issues.push({ path: "amount", message: "amount is a positive decimal." });
  const amountIn: OrderAmountSide = input.amountIn ?? "sell";
  if (amountIn !== "sell" && amountIn !== "buy") issues.push({ path: "amountIn", message: "amountIn is sell or buy." });
  const price = input.price === undefined || input.price === null ? null : decimal(input.price);
  if (input.price !== undefined && input.price !== null && !price) issues.push({ path: "price", message: "price is a positive decimal." });

  let period: number | null = null;
  let count: number | null = null;
  let expiresAt: number | null = null;
  if (kind === "limit") {
    if (!price) issues.push({ path: "price", message: "A limit order needs a price." });
    if (input.period !== undefined || input.count !== undefined) issues.push({ path: "period", message: "period and count belong to DCA orders." });
    const expiry = expirySeconds(input.expiresAt, now);
    if (expiry === "invalid") issues.push({ path: "expiresAt", message: "expiresAt is a future time within one year." });
    else expiresAt = expiry;
  } else if (kind === "dca") {
    if (amountIn !== "sell") issues.push({ path: "amountIn", message: "A DCA order counts the amount sold." });
    period = periodSeconds(input.period);
    if (period === null || period < ORDER_LIMITS.minPeriodSeconds || period > ORDER_LIMITS.maxPeriodSeconds) {
      issues.push({ path: "period", message: `period is minute, hour, day, week, month or ${ORDER_LIMITS.minPeriodSeconds}-${ORDER_LIMITS.maxPeriodSeconds} seconds.` });
    }
    count = typeof input.count === "number" && Number.isInteger(input.count) ? input.count : null;
    if (count === null || count < ORDER_LIMITS.minCount || count > ORDER_LIMITS.maxCount) {
      issues.push({ path: "count", message: `count is a whole number of parts, ${ORDER_LIMITS.minCount}-${ORDER_LIMITS.maxCount}.` });
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) issues.push({ path: "expiresAt", message: "A DCA order ends after its last part." });
  }

  const network = pickNetwork({ ...input, sell, buy }, issues);
  if (issues.length > 0 || !network || !amount) throw new PlatformError("ORDER_INVALID", "The order is incomplete or invalid.", 400, issues);
  const [protocol, mechanism] = PROTOCOLS[kind][CHAINS[network].vm === "svm" ? "svm" : "evm"];
  return { kind, protocol, mechanism, network, sell, buy, amount, amountIn, price, periodSeconds: period, count, expiresAt };
}

const PRICE_SCALE = 36;

/** Exact base units of a decimal, or ORDER_INVALID when it has more decimals than the asset. */
export function decimalUnits(value: string, decimals: number, path: string): bigint {
  const [, fraction = ""] = value.split(".");
  if (fraction.replace(/0+$/u, "").length > decimals) {
    throw new PlatformError("ORDER_INVALID", `${path} has more than ${decimals} decimals.`, 400, [{ path, message: `At most ${decimals} decimals.` }]);
  }
  const [whole = "0"] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.replace(/0+$/u, "") || "0").padEnd(decimals, "0") || "0");
}

/**
 * `units` (with `fromDecimals`) times a decimal price, in base units with
 * `toDecimals`, rounded `up` or down. Exact up to 36 price decimals.
 */
export function priceUnits(units: bigint, fromDecimals: number, price: string, toDecimals: number, round: "up" | "down"): bigint {
  const scaled = decimalUnits(price, PRICE_SCALE, "price");
  const numerator = units * scaled * 10n ** BigInt(toDecimals);
  const denominator = 10n ** BigInt(fromDecimals + PRICE_SCALE);
  const quotient = numerator / denominator;
  return round === "up" && quotient * denominator !== numerator ? quotient + 1n : quotient;
}

/** Base-unit sell and buy amounts of a plan whose assets have `sellDecimals` and `buyDecimals`. */
export function planAmounts(plan: NativeOrderPlan, sellDecimals: number, buyDecimals: number): { sellAmount: bigint; buyAmount: bigint | null } {
  let sellAmount: bigint;
  let buyAmount: bigint | null;
  if (plan.amountIn === "buy") {
    buyAmount = decimalUnits(plan.amount, buyDecimals, "amount");
    // A buyer never pays more than the stated price: round the sell side down.
    sellAmount = priceUnits(buyAmount, buyDecimals, plan.price as string, sellDecimals, "down");
  } else {
    sellAmount = decimalUnits(plan.amount, sellDecimals, "amount");
    // A seller never receives less than the stated price: round the buy side up.
    buyAmount = plan.price === null ? null : priceUnits(sellAmount, sellDecimals, plan.price, buyDecimals, "up");
  }
  if (sellAmount <= 0n || (buyAmount !== null && buyAmount <= 0n)) {
    throw new PlatformError("ORDER_INVALID", "The order rounds to zero; raise the amount or the price.", 400, [{ path: "amount", message: "Rounds to zero base units." }]);
  }
  return { sellAmount, buyAmount };
}
