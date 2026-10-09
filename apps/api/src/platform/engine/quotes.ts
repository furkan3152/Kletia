/**
 * POST /v1/quotes: live routes for one asset movement (same- or
 * cross-network) from every adapter that can serve it, plus the best route.
 * Routes are ranked like the planner's venue auction (auction.ts): net
 * guaranteed output (minimum minus priced extra costs), then time, then
 * transactions; routes slower than `maxSeconds` (default 600) or with
 * unpriced extra costs rank last. Quotes are advisory; nothing is persisted.
 */
import {
  CHAINS,
  formatAccountId,
  isDecimalAmount,
  isNetworkKey,
  MAX_MAX_SECONDS,
  MIN_MAX_SECONDS,
  toBaseUnits,
  type AssetAmount,
  type NetworkKey,
  type ParsedAccountId,
  type ProtocolId,
  type StepSettlement,
} from "@kletia/core";
import { PlatformError, toPlatformError } from "../errors.js";
import { recipientForNetwork } from "./accounts.js";
import { candidateAdapters } from "./adapters/registry.js";
import type { AdapterAction, AdapterRoute } from "./adapters/types.js";
import { assetAmount, resolveAsset, sameAsset } from "./assets.js";
import { compareQuotes, DEFAULT_MAX_SECONDS, exclusionReason, venueQuote, type VenueQuote } from "./auction.js";
import { looksLikeName, resolveRecipientName } from "./names.js";
import { DEFAULT_SLIPPAGE_BPS } from "./planner.js";
import { isRecord, roundUsd } from "./util.js";

export interface QuoteRoutesInput {
  /** Source network. */
  readonly network: NetworkKey;
  /** Input asset on `network`: symbol, address/mint or CAIP-19 id. */
  readonly from: string;
  /** Output asset on `toNetwork`. */
  readonly to: string;
  /** Destination network (defaults to `network`). */
  readonly toNetwork?: NetworkKey;
  /** Decimal amount of `from` in human units. */
  readonly amount: string;
  /** Sender (CAIP-10 or address on `network`); a placeholder is used when omitted. */
  readonly account?: string;
  /** Recipient on `toNetwork` (CAIP-10, address or name); defaults to the sender for same-namespace routes. */
  readonly recipient?: string;
  readonly slippageBps?: number;
  /** Longest acceptable settlement estimate in seconds (default 600); slower routes rank last. */
  readonly maxSeconds?: number;
}

export interface QuoteRoute {
  readonly protocol: ProtocolId;
  readonly label: string;
  readonly network: NetworkKey;
  readonly toNetwork: NetworkKey;
  readonly input: AssetAmount;
  readonly output: AssetAmount;
  readonly minimumOutput: AssetAmount;
  /** Guaranteed output net of extra costs; absent when those costs cannot be priced. */
  readonly netMinimumOutput?: AssetAmount;
  readonly feesUsd?: number;
  /** Value paid on top of the input (e.g. a fixed native fee). */
  readonly extraCosts?: readonly AssetAmount[];
  readonly estimatedSeconds: number;
  readonly transactionCount: number;
  readonly settlement: StepSettlement;
  readonly warnings: readonly string[];
  readonly quoteId?: string;
  /** False when the route cannot be chosen as best (too slow, unpriced extra costs, other asset). */
  readonly eligible: boolean;
}

export interface QuoteRoutesResult {
  readonly routes: readonly QuoteRoute[];
  readonly best: QuoteRoute | null;
  readonly quotedAt: string;
  readonly unavailable: readonly { readonly protocol: ProtocolId; readonly code: string; readonly message: string }[];
}

/**
 * Quote-only stand-ins when no account is given. The Solana key is
 * base58(sha256("kletia:quote-placeholder")): a plain address nobody controls
 * that providers accept as sender and recipient.
 */
const PLACEHOLDER_ADDRESSES: Readonly<Record<"eip155" | "solana", string>> = {
  eip155: "0x000000000000000000000000000000000000dEaD",
  solana: "AXwDd9yL1RstJ2cCyPKFVTaNMCo21j9AYmj5v9zvPHzp",
};

/**
 * Accepts the documented nested body
 * `{ from: { network, asset, amount, account? }, to: { network?, asset, recipient? }, slippageBps? }`
 * and the flat body (`network`, `from`, `to`, `toNetwork`, `amount`, …).
 */
function flatten(input: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(input.from) || !isRecord(input.to)) return input;
  const from = input.from;
  const to = input.to;
  return {
    network: from.network,
    from: from.asset,
    amount: from.amount,
    to: to.asset,
    ...(to.network !== undefined ? { toNetwork: to.network } : {}),
    ...(from.account !== undefined || input.account !== undefined ? { account: from.account ?? input.account } : {}),
    ...(to.recipient !== undefined || input.recipient !== undefined ? { recipient: to.recipient ?? input.recipient } : {}),
    ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {}),
    ...(input.maxSeconds !== undefined ? { maxSeconds: input.maxSeconds } : {}),
  };
}

function parseInput(raw: unknown): QuoteRoutesInput {
  const issues: { path: string; message: string }[] = [];
  if (!isRecord(raw)) throw new PlatformError("INVALID_REQUEST", "Request body must be an object.", 400);
  const input = flatten(raw);
  if (!isNetworkKey(input.network)) issues.push({ path: "network", message: "Unknown network." });
  if (input.toNetwork !== undefined && !isNetworkKey(input.toNetwork)) issues.push({ path: "toNetwork", message: "Unknown network." });
  for (const key of ["from", "to"] as const) {
    if (typeof input[key] !== "string" || !(input[key] as string).trim() || (input[key] as string).length > 128) {
      issues.push({ path: key, message: "Required asset symbol, address or CAIP-19 id." });
    }
  }
  if (!isDecimalAmount(input.amount) || /^0(?:\.0*)?$/u.test(input.amount as string)) {
    issues.push({ path: "amount", message: "Must be a positive decimal string." });
  }
  for (const key of ["account", "recipient"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || (input[key] as string).length > 128)) {
      issues.push({ path: key, message: "Must be an address or CAIP-10 account." });
    }
  }
  const slippage = input.slippageBps;
  if (slippage !== undefined && (typeof slippage !== "number" || !Number.isInteger(slippage) || slippage < 1 || slippage > 1_000)) {
    issues.push({ path: "slippageBps", message: "Must be an integer between 1 and 1000." });
  }
  const seconds = input.maxSeconds;
  if (seconds !== undefined && (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < MIN_MAX_SECONDS || seconds > MAX_MAX_SECONDS)) {
    issues.push({ path: "maxSeconds", message: `Must be an integer between ${MIN_MAX_SECONDS} and ${MAX_MAX_SECONDS}.` });
  }
  if (issues.length > 0) throw new PlatformError("INVALID_REQUEST", "The quote request is invalid.", 400, issues);
  return input as unknown as QuoteRoutesInput;
}

async function recipientFor(value: string, network: NetworkKey): Promise<ParsedAccountId> {
  if (!looksLikeName(value)) return accountFor(value, network);
  return accountFor((await resolveRecipientName(value, network)).address, network);
}

function accountFor(value: string | undefined, network: NetworkKey): ParsedAccountId {
  if (value) return recipientForNetwork(value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value, network);
  const chain = CHAINS[network];
  return { chain, address: PLACEHOLDER_ADDRESSES[chain.namespace], id: formatAccountId(chain, PLACEHOLDER_ADDRESSES[chain.namespace]) };
}

export async function quoteRoutes(rawInput: unknown): Promise<QuoteRoutesResult> {
  try {
    const input = parseInput(rawInput);
    const toNetwork = input.toNetwork ?? input.network;
    if (CHAINS[input.network].environment !== CHAINS[toNetwork].environment) {
      throw new PlatformError("CAPITAL_LANE_MIXED", "Mainnet and testnet networks cannot be quoted together.", 422);
    }
    const [from, to] = await Promise.all([resolveAsset(input.network, input.from), resolveAsset(toNetwork, input.to)]);
    if (input.network === toNetwork && sameAsset(from, to)) {
      throw new PlatformError("SWAP_SAME_ASSET", "Input and output are the same asset on the same network.", 422);
    }
    let amount: string;
    try {
      amount = toBaseUnits(input.amount, from.decimals);
    } catch {
      throw new PlatformError("AMOUNT_INVALID", `${input.amount} ${from.symbol} has more than ${from.decimals} decimal places.`, 422);
    }
    const account = accountFor(input.account, input.network);
    const recipient = input.recipient
      ? await recipientFor(input.recipient, toNetwork)
      : CHAINS[toNetwork].namespace === account.chain.namespace
        ? { ...account, chain: CHAINS[toNetwork], id: formatAccountId(CHAINS[toNetwork], account.address) }
        : accountFor(undefined, toNetwork);
    const route: AdapterRoute = {
      kind: input.network === toNetwork ? "swap" : "bridge",
      network: input.network,
      destinationNetwork: toNetwork,
      input: from,
      output: to,
    };
    const adapters = candidateAdapters(route, undefined);
    if (adapters.length === 0) {
      throw new PlatformError(
        "ROUTE_UNSUPPORTED",
        `No venue routes ${from.symbol} on ${CHAINS[input.network].name} to ${to.symbol} on ${CHAINS[toNetwork].name}.`,
        422,
      );
    }
    const action: AdapterAction = {
      ...route,
      amount,
      account,
      recipient,
      slippageBps: input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    };
    const maxSeconds = input.maxSeconds ?? DEFAULT_MAX_SECONDS;
    const settled = await Promise.allSettled(adapters.map((adapter) => adapter.plan(action)));
    const quotes: VenueQuote[] = [];
    const unavailable: { protocol: ProtocolId; code: string; message: string }[] = [];
    for (const [index, result] of settled.entries()) {
      const adapter = adapters[index];
      if (!adapter) continue;
      if (result.status === "rejected") {
        const error = toPlatformError(result.reason);
        unavailable.push({ protocol: adapter.id, code: error.code, message: error.message });
        continue;
      }
      quotes.push(await venueQuote(adapter, action, result.value, maxSeconds));
    }
    if (quotes.length === 0) {
      const first = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw toPlatformError(first?.reason);
    }
    quotes.sort((a, b) => compareQuotes(a, b, [], adapters));
    const routes = quotes.map((quote): QuoteRoute => {
      const planned = quote.planned;
      const reason = exclusionReason(quote);
      const priced = quote.netMinimum !== null && sameAsset(planned.minimumOutput, to);
      return {
        protocol: planned.protocol,
        label: quote.adapter.label,
        network: input.network,
        toNetwork,
        input: planned.input,
        output: planned.expectedOutput,
        minimumOutput: planned.minimumOutput,
        ...(priced && quote.netMinimum !== null
          ? { netMinimumOutput: assetAmount(to, (quote.netMinimum < 0n ? 0n : quote.netMinimum).toString()) }
          : {}),
        ...(planned.feesUsd !== undefined ? { feesUsd: roundUsd(planned.feesUsd) } : {}),
        ...(planned.extraCosts && planned.extraCosts.length > 0 ? { extraCosts: planned.extraCosts } : {}),
        estimatedSeconds: planned.estimatedSeconds,
        transactionCount: planned.transactionCount,
        settlement: planned.settlement,
        warnings: reason ? [...planned.warnings, `Not eligible as best route: ${reason}.`] : planned.warnings,
        ...(planned.quoteId ? { quoteId: planned.quoteId } : {}),
        eligible: quote.excluded === undefined,
      };
    });
    // A lone route is still the best one, unless the caller's own time limit rules it out.
    const fallback = routes.length === 1 && !(input.maxSeconds !== undefined && quotes[0]?.excluded === "slow") ? routes[0] : null;
    const best = routes.find((route) => route.eligible) ?? fallback ?? null;
    return { routes, best, quotedAt: new Date().toISOString(), unavailable };
  } catch (error) {
    throw toPlatformError(error);
  }
}
