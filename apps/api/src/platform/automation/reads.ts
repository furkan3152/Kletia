/**
 * What the evaluator reads, read-only: USD prices from the Rule Book's
 * oracles (Chainlink, Pyth, Jupiter; conservative, fresh sources only),
 * balances from the portfolio reader, venue APYs from the EVM lending metrics,
 * and the oracle-priced notional of a planned intent. Every read may fail; the
 * evaluator then treats the trigger as unknown and never fires on it.
 */
import { findAssetBySymbol, fromBaseUnits, parseAssetId, type AccountId, type IntentGraph, type NetworkKey, type VenueRate } from "@kletia/core";
import { listLendingMetrics, notionalUsdMicros, policyPrice, readAccountPortfolio } from "../index.js";
import { quoteUsdNumber } from "../engine/policy/pricing.js";

export interface AutomationReads {
  /** USD per whole token of `symbol` on `network`; null when no fresh source prices it. */
  priceUsd(symbol: string, network: NetworkKey): Promise<number | null>;
  /** Whole tokens of `symbol` held by `account` (0 when it holds none). Throws when unreadable. */
  balance(account: AccountId, symbol: string): Promise<number>;
  /** Supply APYs of the venues for `symbol` on these networks (unreadable venues are left out). */
  rates(symbol: string, networks: readonly NetworkKey[]): Promise<VenueRate[]>;
  /** USD micro-dollars of the intent's inputs; null when one of them is unpriced. */
  notionalUsdMicros(intent: IntentGraph): Promise<bigint | null>;
}

async function priceUsd(symbol: string, network: NetworkKey): Promise<number | null> {
  const asset = findAssetBySymbol(network, symbol);
  if (!asset) return null;
  const quote = await policyPrice({ asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, network });
  return quote ? quoteUsdNumber(quote) : null;
}

async function balance(account: AccountId, symbol: string): Promise<number> {
  const portfolio = await readAccountPortfolio(account);
  const holding = portfolio.holdings.find((entry) => entry.symbol.toUpperCase() === symbol.toUpperCase());
  return holding ? Number(fromBaseUnits(holding.amount, holding.decimals)) : 0;
}

async function rates(symbol: string, networks: readonly NetworkKey[]): Promise<VenueRate[]> {
  const listings = await Promise.all(networks.map((network) => listLendingMetrics({ network })));
  return listings
    .flatMap((listing) => listing.venues)
    .filter((venue) => venue.asset.toUpperCase() === symbol.toUpperCase() && venue.supplyApy !== null)
    .map((venue) => ({ venue: venue.venue, network: venue.network, apyBps: Math.round((venue.supplyApy ?? 0) * 10_000) }));
}

async function intentNotional(intent: IntentGraph): Promise<bigint | null> {
  let total = 0n;
  for (const input of intent.summary.inputs) {
    const network = parseAssetId(input.asset)?.chain.key;
    if (!network) return null;
    const quote = await policyPrice({ asset: input.asset, symbol: input.symbol, decimals: input.decimals, network });
    if (!quote) return null;
    total += notionalUsdMicros(input.amount, input.decimals, quote);
  }
  return total;
}

export const LIVE_AUTOMATION_READS: AutomationReads = Object.freeze({ priceUsd, balance, rates, notionalUsdMicros: intentNotional });
