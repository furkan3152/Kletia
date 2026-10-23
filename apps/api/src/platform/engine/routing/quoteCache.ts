/**
 * Quote coalescing and the pre-screen cache (design B.2; red-team E1, E2, F1).
 *
 * - Coalescing (E2): concurrent quote requests share one provider call only
 *   when the full request is identical: the venue and every field of the
 *   action (kind, networks, assets, exact amount, sender, recipient, the
 *   person's destination account, slippage, gas top-up, provider variant,
 *   venue). The key carries the sender, so a coalesced result is never
 *   reused across accounts, and nothing is kept once the call settles.
 * - Pre-screen cache (E1): ranking-only quotes kept 10 s, keyed on every
 *   field of the request except the exact amount, in size buckets of 5 %
 *   (a hit is scaled to the asked amount and labelled an estimate). A cached
 *   number never becomes a plan: the auction re-quotes the top two fresh and
 *   the winner is always a fresh quote.
 * - Neutral pre-screen address (F1): venues whose quote does not depend on
 *   the account are pre-screened with a fixed address nobody controls; the
 *   person's address goes only to the finalists' fresh quotes.
 */
import { CHAINS, formatAccountId, type ParsedAccountId, type ProtocolId } from "@kletia/core";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "../adapters/types.js";
import { assetAmount, assetFromRef } from "../assets.js";

/** Lifetime of a pre-screen entry. */
export const PRESCREEN_TTL_MS = 10_000;
/** Width of a pre-screen size bucket: amounts within 5 % share an entry. */
export const PRESCREEN_BUCKET_RATIO = 1.05;
const PRESCREEN_LIMIT = 2_000;

/**
 * Quote-only stand-ins (the same as POST /v1/quotes uses without an
 * account). The Solana key is base58(sha256("kletia:quote-placeholder")).
 */
export const NEUTRAL_ADDRESSES: Readonly<Record<"eip155" | "solana", string>> = Object.freeze({
  eip155: "0x000000000000000000000000000000000000dEaD",
  solana: "AXwDd9yL1RstJ2cCyPKFVTaNMCo21j9AYmj5v9zvPHzp",
});

/** Venues whose quote does not depend on who sends (Relay `user`, LI.FI `fromAddress`): pre-screened with the neutral address. */
export const ACCOUNT_INDEPENDENT_QUOTES: ReadonlySet<ProtocolId> = new Set<ProtocolId>(["relay", "lifi"]);

function stable(value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Canonical JSON of a value (sorted keys, bigint-safe). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

/** Every field of the provider request of `adapter` for `action` (the coalescing key). */
export function fullRequestKey(adapter: Pick<ProtocolAdapter, "id">, action: AdapterAction): string {
  const { call: _call, ...rest } = action;
  return canonicalJson({ venue: adapter.id, action: rest });
}

/* ------------------------------------------------------------- coalescing */

const inflight = new Map<string, Promise<PlannedStep>>();

/**
 * Plans through `adapter`, sharing one call with identical concurrent
 * requests (full request key). The shared promise is forgotten once it
 * settles, so results are never reused afterwards.
 */
export function coalescedPlan(adapter: ProtocolAdapter, action: AdapterAction): Promise<PlannedStep> {
  if (action.call) return adapter.plan(action);
  const key = fullRequestKey(adapter, action);
  const pending = inflight.get(key);
  if (pending) return pending;
  const started = adapter.plan(action);
  inflight.set(key, started);
  const forget = () => {
    if (inflight.get(key) === started) inflight.delete(key);
  };
  started.then(forget, forget);
  return started;
}

/** Calls in flight (tests). */
export function inflightQuotes(): number {
  return inflight.size;
}

/* ------------------------------------------------------- pre-screen cache */

interface PrescreenEntry {
  readonly planned: PlannedStep;
  readonly amount: bigint;
  readonly at: number;
}

const prescreen = new Map<string, PrescreenEntry>();

/** The 5 % size bucket of an amount in base units. */
export function sizeBucket5(amount: bigint): number {
  if (amount <= 0n) return -1;
  const digits = amount.toString().length;
  // log of a big integer without losing range: leading 15 digits plus the exponent.
  const lead = Number(amount.toString().slice(0, 15));
  const log = Math.log(lead) + (digits - Math.min(15, digits)) * Math.LN10;
  return Math.floor(log / Math.log(PRESCREEN_BUCKET_RATIO));
}

/** Every field of the request except the exact amount, plus the amount's 5 % bucket. */
export function prescreenKey(adapter: Pick<ProtocolAdapter, "id">, action: AdapterAction): string {
  const { call: _call, amount, ...rest } = action;
  return canonicalJson({ venue: adapter.id, action: rest, bucket: sizeBucket5(BigInt(amount)) });
}

function scale(units: string, from: bigint, to: bigint): string {
  if (from <= 0n) return units;
  return ((BigInt(units) * to) / from).toString();
}

/** Remembers a fresh quote for pre-screening (never for planning). */
export function rememberPrescreen(adapter: Pick<ProtocolAdapter, "id">, action: AdapterAction, planned: PlannedStep, now: number = Date.now()): void {
  if (action.call) return;
  const key = prescreenKey(adapter, action);
  prescreen.delete(key);
  prescreen.set(key, { planned, amount: BigInt(action.amount), at: now });
  while (prescreen.size > PRESCREEN_LIMIT) {
    const oldest = prescreen.keys().next().value;
    if (oldest === undefined) break;
    prescreen.delete(oldest);
  }
}

/**
 * A cached pre-screen quote for this request scaled to its amount, or null.
 * The result carries no transactions (`preview` dropped) and must never be
 * planned: it ranks as an estimate only.
 */
export function recallPrescreen(adapter: Pick<ProtocolAdapter, "id">, action: AdapterAction, now: number = Date.now()): PlannedStep | null {
  if (action.call) return null;
  const key = prescreenKey(adapter, action);
  const entry = prescreen.get(key);
  if (!entry) return null;
  if (now - entry.at > PRESCREEN_TTL_MS) {
    prescreen.delete(key);
    return null;
  }
  const amount = BigInt(action.amount);
  const { preview: _preview, quoteId: _quoteId, ...planned } = entry.planned;
  const rescale = (value: PlannedStep["expectedOutput"]) => {
    try {
      return assetAmount(assetFromRef(value), scale(value.amount, entry.amount, amount));
    } catch {
      return { ...value, amount: scale(value.amount, entry.amount, amount) };
    }
  };
  return {
    ...planned,
    input: rescale(planned.input),
    expectedOutput: rescale(planned.expectedOutput),
    minimumOutput: rescale(planned.minimumOutput),
  };
}

/** Forgets every pre-screen entry and in-flight key (tests). */
export function resetQuoteCache(): void {
  prescreen.clear();
  inflight.clear();
}

/* ---------------------------------------------------------- neutral address */

function neutralAccount(account: ParsedAccountId): ParsedAccountId {
  const address = NEUTRAL_ADDRESSES[account.chain.namespace];
  return { chain: account.chain, address, id: formatAccountId(account.chain, address) };
}

/**
 * The pre-screen form of a request: the neutral sender (and recipient, when
 * the recipient is the sender's own account on the same namespace) for a
 * venue whose quote does not depend on the account; null when the venue
 * needs the real account (its pre-screen goes out with it, AR1).
 */
export function neutralPrescreenAction(adapter: Pick<ProtocolAdapter, "id">, action: AdapterAction): AdapterAction | null {
  if (!ACCOUNT_INDEPENDENT_QUOTES.has(adapter.id) || action.call || action.gasTopupUsd !== undefined) return null;
  const ownRecipient = action.recipient.address.toLowerCase() === action.account.address.toLowerCase() ||
    (action.destinationAccount !== undefined && action.recipient.address.toLowerCase() === action.destinationAccount.address.toLowerCase());
  if (!ownRecipient) return null;
  const sender = neutralAccount(action.account);
  const recipientChain = CHAINS[action.destinationNetwork];
  const recipientAddress = NEUTRAL_ADDRESSES[recipientChain.namespace];
  const recipient: ParsedAccountId = { chain: recipientChain, address: recipientAddress, id: formatAccountId(recipientChain, recipientAddress) };
  const { destinationAccount: _destination, ...rest } = action;
  return { ...rest, account: sender, recipient };
}

/** True when `account` is one of the neutral stand-ins (the person's address was not sent). */
export function isNeutralAccount(account: Pick<ParsedAccountId, "address">): boolean {
  return Object.values(NEUTRAL_ADDRESSES).some((address) => address.toLowerCase() === account.address.toLowerCase());
}
