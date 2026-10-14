/**
 * USD prices for the asset-change preview.
 *
 * Display prices, not policy prices: USD stablecoins at $1.00, testnet
 * assets at $0 except Arc USDC ($1, Arc's gas asset), native gas assets and
 * wrapped ether through `engine/prices.ts` (Jupiter: SOL, an ETH proxy), and
 * listed SPL mints through Jupiter's price API. Anything else is unpriced
 * (null): the preview lists it as unpriced and never guesses. POL is
 * priced through the Rule Book's Chainlink feed, and the EVM liquid-staking
 * tokens (wstETH, rETH, weETH) through the Rule Book's derived feeds.
 *
 * `quote(asset)` returns the same price with its source and reading time
 * (journey valuation); `price(asset)` stays the fare's input.
 */
import { CHAINS, getAsset, parseAssetId, type AssetId, type JourneyValueSource, type PreviewPrices } from "@kletia/core";
import { isUsdStablecoin, assetFromRef } from "../assets.js";
import { nativeUsdQuote, solanaMintUsdQuote, type UsdQuote } from "../prices.js";

/** A price with where it comes from and when it was read (journey valuation). */
export interface PriceQuoteView {
  readonly usd: number;
  readonly source: JourneyValueSource;
  /** ISO time of the reading. */
  readonly at: string;
}

export interface PreviewPricer {
  /** USD per whole token; null when unpriced. Never throws. */
  price(asset: AssetId): Promise<number | null>;
  /** The price with its source and reading time; null when unpriced. Never throws. Optional for custom pricers. */
  quote?(asset: AssetId): Promise<PriceQuoteView | null>;
}

const ETH_GROUP_SYMBOLS = new Set(["WETH"]);

function view(quote: UsdQuote | null): PriceQuoteView | null {
  if (!quote || !Number.isFinite(quote.usd) || quote.usd < 0) return null;
  return { usd: quote.usd, source: quote.source, at: new Date(quote.at).toISOString() };
}

async function policyQuote(asset: AssetId, network: Parameters<typeof nativeUsdQuote>[0], symbol: string, decimals: number): Promise<PriceQuoteView | null> {
  const { policyPrice, quoteUsdNumber } = await import("../policy/pricing.js");
  const quote = await policyPrice({ asset, symbol, decimals, network });
  if (!quote || quote.basis !== "oracle") return null;
  const observed = quote.readings.reduce((oldest, reading) => Math.min(oldest, reading.observedAt), Number.MAX_SAFE_INTEGER);
  const at = observed === Number.MAX_SAFE_INTEGER ? Date.now() : observed * 1000;
  return { usd: quoteUsdNumber(quote), source: quote.readings.some((reading) => reading.source === "jupiter") && !quote.readings.some((reading) => reading.source !== "jupiter") ? "jupiter" : "chainlink", at: new Date(at).toISOString() };
}

async function defaultQuote(asset: AssetId): Promise<PriceQuoteView | null> {
  const parsed = parseAssetId(asset);
  if (!parsed) return null;
  const network = parsed.chain.key;
  const chain = CHAINS[network];
  const listed = getAsset(parsed.id) ?? getAsset(asset);
  if (parsed.isNative) return view(await nativeUsdQuote(network));
  if (listed) {
    const resolved = assetFromRef({ asset: listed.id, symbol: listed.symbol, decimals: listed.decimals });
    const now = new Date().toISOString();
    // Testnet value is $0, except Arc's USDC (Arc's gas asset, priced like the native asset).
    if (chain.environment === "testnet") return network === "arc" && isUsdStablecoin(resolved) ? { usd: 1, source: "usd-par", at: now } : { usd: 0, source: "testnet", at: now };
    if (isUsdStablecoin(resolved)) return { usd: 1, source: "usd-par", at: now };
    if (listed.group === "ETH" || ETH_GROUP_SYMBOLS.has(listed.symbol.toUpperCase())) {
      const ethereum = CHAINS[network].nativeAsset.symbol === "ETH" ? network : "base";
      return view(await nativeUsdQuote(ethereum));
    }
    if (chain.vm === "svm" && listed.address) return view(await solanaMintUsdQuote(listed.address));
    // EVM liquid staking (wstETH, rETH, weETH): the Rule Book's conservative oracle.
    if (listed.category === "liquid-staking") return policyQuote(listed.id, network, listed.symbol, listed.decimals);
    return null;
  }
  return null;
}

async function safeDefaultQuote(asset: AssetId): Promise<PriceQuoteView | null> {
  try {
    const value = await defaultQuote(asset);
    return value && Number.isFinite(value.usd) && value.usd >= 0 ? value : null;
  } catch {
    return null;
  }
}

export const defaultPreviewPricer: PreviewPricer = {
  async price(asset) {
    return (await safeDefaultQuote(asset))?.usd ?? null;
  },
  quote: safeDefaultQuote,
};

let pricer: PreviewPricer = defaultPreviewPricer;

/** Replaces the preview pricer (tests, a policy pricer once the Rule Book lands); null restores the default. */
export function configurePreviewPricer(next: PreviewPricer | null): void {
  pricer = next ?? defaultPreviewPricer;
}

export function previewPricer(): PreviewPricer {
  return pricer;
}

/**
 * The price of `asset` with its source and time, through the installed
 * pricer (`quote` when it has one; else its `price`, labelled by rule:
 * USD stablecoins `usd-par`, testnet assets `testnet`, Solana `jupiter`,
 * anything else `chainlink`). Null when unpriced; never throws.
 */
export async function quoteAsset(asset: AssetId): Promise<PriceQuoteView | null> {
  try {
    if (pricer.quote) return await pricer.quote(asset);
    const usd = await pricer.price(asset);
    if (usd === null || !Number.isFinite(usd) || usd < 0) return null;
    const parsed = parseAssetId(asset);
    const listed = parsed ? getAsset(parsed.id) ?? getAsset(asset) : null;
    const chain = parsed ? CHAINS[parsed.chain.key] : null;
    const source: JourneyValueSource = chain?.environment === "testnet"
      ? "testnet"
      : listed?.category === "stablecoin" && usd === 1
        ? "usd-par"
        : chain?.vm === "svm"
          ? "jupiter"
          : "chainlink";
    return { usd, source, at: new Date().toISOString() };
  } catch {
    return null;
  }
}

/** Prices every asset id once (in parallel) into the record `aggregatePreview` takes. */
export async function priceAssets(assets: Iterable<AssetId>): Promise<PreviewPrices> {
  const unique = [...new Set(assets)];
  const values = await Promise.all(unique.map((asset) => pricer.price(asset).catch(() => null)));
  const out: Record<string, number | null> = {};
  unique.forEach((asset, index) => {
    out[asset] = values[index] ?? null;
  });
  return out;
}
