/**
 * The Orders view's model (pure, no React): the create form to the
 * /v1/orders request body, the order list grouped for display, one-line
 * summaries, what each prepared step asks of the wallet, and typed data in
 * the shape wallets sign. node --test loads it.
 */
export type OrderMode = "limit" | "dca";
export type OrderNetworkKey = "solana" | "ethereum" | "arbitrum" | "base";
export const ORDER_NETWORK_KEYS: readonly OrderNetworkKey[] = Object.freeze(["solana", "ethereum", "arbitrum", "base"]);
export const ORDER_PERIODS = Object.freeze(["hour", "day", "week"] as const);
export type OrderPeriodName = (typeof ORDER_PERIODS)[number];

export interface OrderFormState {
  readonly mode: OrderMode;
  /** Limit orders: `sell` counts the amount in the asset sold, `buy` in the asset bought. */
  readonly side: "sell" | "buy";
  readonly network: OrderNetworkKey;
  readonly sell: string;
  readonly buy: string;
  readonly amount: string;
  /** Limit: the price as the person typed it, in the orientation `priceOrientation` names. */
  readonly price: string;
  /** Limit: the price is entered the other way round from the natural orientation (the flip toggle). */
  readonly priceFlipped: boolean;
  /** Limit: days until the order stops filling; empty for the protocol default. */
  readonly expiryDays: string;
  readonly period: OrderPeriodName;
  readonly count: string;
}

export const EMPTY_ORDER_FORM: OrderFormState = Object.freeze({
  mode: "limit",
  side: "sell",
  network: "solana",
  sell: "SOL",
  buy: "USDC",
  amount: "",
  price: "",
  priceFlipped: false,
  expiryDays: "",
  period: "day",
  count: "10",
});

export interface OrderAmountView {
  readonly symbol: string;
  readonly formatted: string;
  readonly amount: string;
}

export interface NativeOrderView {
  readonly id: string;
  readonly protocol: string;
  readonly mechanism: "limit" | "recurring" | "twap";
  readonly network: OrderNetworkKey;
  readonly owner: string;
  readonly status: "open" | "filled" | "cancelled" | "expired" | "unknown";
  readonly sell: OrderAmountView;
  readonly buy: OrderAmountView | null;
  readonly sold: OrderAmountView;
  readonly bought: OrderAmountView;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  readonly schedule: { readonly perPart: OrderAmountView; readonly periodSeconds: number } | null;
  readonly cancellable: boolean;
}

export interface OrderListFailureView {
  readonly protocol: string;
  readonly network: string;
  readonly code: string;
  readonly message: string;
}

export interface Eip712View {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}

export type OrderStepView =
  | { readonly kind: "solana-transaction"; readonly network: "solana"; readonly transaction: string; readonly messageHash: string; readonly description: string }
  | { readonly kind: "evm-transaction"; readonly network: OrderNetworkKey; readonly chainId: number; readonly to: string; readonly data: string; readonly value: "0"; readonly description: string }
  | { readonly kind: "eip712"; readonly network: OrderNetworkKey; readonly chainId: number; readonly typedData: Eip712View; readonly digest: string; readonly description: string }
  | { readonly kind: "safe-transaction"; readonly network: OrderNetworkKey; readonly chainId: number; readonly safe: string; readonly to: string; readonly data: string; readonly value: "0"; readonly description: string };

export interface OrderPreparationView {
  readonly id: string;
  readonly protocol: string;
  readonly action: "create" | "cancel";
  readonly network: OrderNetworkKey;
  readonly owner: string;
  readonly orderId: string | null;
  readonly steps: readonly OrderStepView[];
  readonly submit: "kletia" | "wallet";
  readonly expiresAt: string;
  readonly warnings: readonly string[];
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export function isSolanaOrderNetwork(network: OrderNetworkKey): boolean {
  return network === "solana";
}

/** The wallet that signs on `network`, or null when that family is not connected. */
export function ownerFor(network: OrderNetworkKey, wallets: { readonly evm: string | null; readonly solana: string | null }): string | null {
  return isSolanaOrderNetwork(network) ? wallets.solana : wallets.evm;
}

function positive(value: string): boolean {
  return DECIMAL.test(value.trim()) && /[1-9]/u.test(value);
}

const USD_STABLES: ReadonlySet<string> = new Set(["USDC", "USDT", "USDT0", "DAI", "USDBC", "USDC.E", "PYUSD", "USDS"]);

function isUsdStable(symbol: string): boolean {
  return USD_STABLES.has(symbol.trim().toUpperCase());
}

/**
 * How the limit price is entered: `counted` per 1 `per`. Naturally the price
 * of the asset you sell in the asset you get ("150 USDC per 1 SOL"), except
 * that a dollar stablecoin is never priced in a volatile asset: selling USDC
 * for WETH reads "2222 USDC per 1 WETH", not "0.00045 WETH per 1 USDC". The
 * flip toggle turns it round. `api`: the orientation of the API's `price`
 * (units of the other asset per one unit of the amount's asset).
 */
export function priceOrientation(form: Pick<OrderFormState, "side" | "sell" | "buy" | "priceFlipped">): { readonly counted: string; readonly per: string; readonly api: boolean } {
  const sell = form.sell.trim();
  const buy = form.buy.trim();
  const natural = isUsdStable(sell) && !isUsdStable(buy) ? { counted: sell, per: buy } : { counted: buy, per: sell };
  const shown = form.priceFlipped ? { counted: natural.per, per: natural.counted } : natural;
  const apiCounted = form.side === "sell" ? buy : sell;
  return { ...shown, api: shown.counted === apiCounted };
}

/** 1 / `value` for a positive decimal string, to 30 significant digits, rounded `up` or `down`. */
export function invertPrice(value: string, round: "up" | "down"): string {
  const [whole = "0", fraction = ""] = value.trim().split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator === 0n) return "0";
  const decimals = 30 + numerator.toString().length;
  const scaled = 10n ** BigInt(fraction.length + decimals);
  let quotient = scaled / numerator;
  if (round === "up" && quotient * numerator !== scaled) quotient += 1n;
  const digits = quotient.toString().padStart(decimals + 1, "0");
  const text = `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/u, "");
  return text.replace(/^0+(?=\d)/u, "");
}

/**
 * The request body for POST /v1/orders/quote and /prepare, or the first
 * problem in the form (shown next to the button; nothing is sent).
 */
export function orderRequestBody(form: OrderFormState, owner: string | null, now = Date.now()): { readonly body: Record<string, unknown> } | { readonly problem: string } {
  if (!owner) return { problem: `Connect ${isSolanaOrderNetwork(form.network) ? "a Solana" : "an EVM"} wallet to place orders on ${form.network}.` };
  const sell = form.sell.trim();
  const buy = form.buy.trim();
  if (!sell || !buy) return { problem: "Name both assets." };
  if (sell.toLowerCase() === buy.toLowerCase()) return { problem: "Sell and buy different assets." };
  if (!positive(form.amount)) return { problem: "Enter a positive amount." };
  const base = { owner, network: form.network, sell, buy, amount: form.amount.trim() };
  if (form.mode === "limit") {
    if (!positive(form.price)) return { problem: "Enter the limit price." };
    const days = form.expiryDays.trim();
    if (days && (!/^\d{1,3}$/u.test(days) || Number(days) < 1 || Number(days) > 365)) return { problem: "Expiry is 1-365 days, or empty." };
    return {
      body: {
        ...base,
        kind: "limit",
        amountIn: form.side,
        // In the API's orientation, rounded in the person's favour: a seller gets at least, a buyer pays at most, the price typed.
        price: priceOrientation(form).api ? form.price.trim() : invertPrice(form.price.trim(), form.side === "sell" ? "up" : "down"),
        ...(days ? { expiresAt: Math.floor(now / 1000) + Number(days) * 86_400 } : {}),
      },
    };
  }
  const count = Number(form.count);
  if (!Number.isInteger(count) || count < 2 || count > 1000) return { problem: "Split the DCA into 2-1000 parts." };
  return { body: { ...base, kind: "dca", period: form.period, count } };
}

/**
 * The API's own words for an order refusal or a relay that failed ("The order
 * was not placed on CoW Protocol: it could not be reached. Nothing was
 * sold."), or null for other errors (shown generically).
 */
export function orderErrorMessage(error: { readonly code: string; readonly message: string; readonly unreachable: boolean }): string | null {
  return !error.unreachable && error.code.startsWith("ORDER_") && error.message ? error.message : null;
}

/** "every day for 10 days": the schedule of a DCA form. */
export function scheduleSentence(period: OrderPeriodName, count: number): string {
  return `every ${period} for ${count} ${period}${count === 1 ? "" : "s"}`;
}

export function formatPeriod(seconds: number): string {
  for (const [name, value] of [["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (seconds % value === 0) return seconds === value ? name : `${seconds / value} ${name}s`;
  }
  return `${seconds} s`;
}

/** One line per order: what it sells, for what, and how it runs. */
export function orderSummary(order: NativeOrderView): string {
  const sell = `${order.sell.formatted} ${order.sell.symbol}`;
  if (order.schedule) return `${order.schedule.perPart.formatted} ${order.sell.symbol} into ${order.bought.symbol} every ${formatPeriod(order.schedule.periodSeconds)} (${sell} in total)`;
  return order.buy ? `Sell ${sell} for at least ${order.buy.formatted} ${order.buy.symbol}` : `Sell ${sell}`;
}

/** Filled share of the sell amount, in whole percent (0-100), or null when the amount is zero. */
export function filledPercent(order: NativeOrderView): number | null {
  const total = BigInt(order.sell.amount || "0");
  if (total === 0n) return null;
  return Number((BigInt(order.sold.amount || "0") * 100n) / total);
}

export interface GroupedOrders {
  readonly open: readonly NativeOrderView[];
  readonly filled: readonly NativeOrderView[];
  readonly closed: readonly NativeOrderView[];
  readonly unknown: readonly NativeOrderView[];
}

/** Open, filled, cancelled or expired (closed), and unrecognised states, each newest first. */
export function groupOrders(orders: readonly NativeOrderView[]): GroupedOrders {
  const newest = [...orders].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return {
    open: newest.filter((order) => order.status === "open"),
    filled: newest.filter((order) => order.status === "filled"),
    closed: newest.filter((order) => order.status === "cancelled" || order.status === "expired"),
    unknown: newest.filter((order) => order.status === "unknown"),
  };
}

const PROTOCOL_NAMES: Readonly<Record<string, string>> = {
  "jupiter-trigger": "Jupiter Trigger",
  "jupiter-recurring": "Jupiter Recurring",
  "cow-protocol": "CoW Protocol",
};

export function protocolName(protocol: string): string {
  return PROTOCOL_NAMES[protocol] ?? protocol;
}

/** "Could not read Jupiter Trigger on solana: …": a list failure, never shown as "no orders". */
export function failureLine(failure: OrderListFailureView): string {
  return `Could not read ${protocolName(failure.protocol)} on ${failure.network}: ${failure.message}`;
}

/** What the wallet is asked to do for one step (button label). */
export function stepAction(step: OrderStepView): string {
  switch (step.kind) {
    case "solana-transaction":
      return "Sign in your Solana wallet";
    case "evm-transaction":
      return "Send the approval";
    case "eip712":
      return "Sign the order (no gas)";
    case "safe-transaction":
      return "Execute in your Safe";
  }
}

/** True when every step runs in the wallet or Safe and nothing comes back to Kletia. */
export function walletOnly(preparation: OrderPreparationView): boolean {
  return preparation.submit === "wallet";
}

/**
 * Typed data as wallets sign it: integer fields of the primary type as
 * bigint (the API sends them as decimal strings, which viem would encode
 * wrongly).
 */
export function walletTypedData(typed: Eip712View): { domain: Eip712View["domain"]; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> } {
  const message: Record<string, unknown> = { ...typed.message };
  for (const field of typed.types[typed.primaryType] ?? []) {
    const value = message[field.name];
    if (/^u?int\d*$/u.test(field.type) && (typeof value === "string" || typeof value === "number")) message[field.name] = BigInt(value);
  }
  const types: Record<string, { name: string; type: string }[]> = {};
  for (const [name, fields] of Object.entries(typed.types)) types[name] = fields.map((field) => ({ ...field }));
  return { domain: { ...typed.domain }, types, primaryType: typed.primaryType, message };
}
