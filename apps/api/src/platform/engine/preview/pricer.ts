/**
 * USD prices for the asset-change preview (asset-preview design §6.3).
 *
 * Display prices, not policy prices: USD stablecoins at $1.00, testnet
 * assets at $0 except Arc USDC ($1, Arc's gas asset), native gas assets and
 * wrapped ether through `engine/prices.ts` (Jupiter: SOL, an ETH proxy), and
 * listed SPL mints through Jupiter's price API. Anything else is unpriced
 * (null): the preview lists it as unpriced and never guesses. POL has no
 * price source yet, so Polygon fees stay unpriced until a pricer covers it.
 */
import { CHAINS, getAsset, parseAssetId, type AssetId, type PreviewPrices } from "@kletia/core";
import { isUsdStablecoin, assetFromRef } from "../assets.js";
import { nativeUsdPrice, solanaMintUsdPrice } from "../prices.js";

export interface PreviewPricer {
  /** USD per whole token; null when unpriced. Never throws. */
  price(asset: AssetId): Promise<number | null>;
}

const ETH_GROUP_SYMBOLS = new Set(["WETH"]);

async function defaultPrice(asset: AssetId): Promise<number | null> {
  const parsed = parseAssetId(asset);
  if (!parsed) return null;
  const network = parsed.chain.key;
  const chain = CHAINS[network];
  const listed = getAsset(parsed.id) ?? getAsset(asset);
  if (parsed.isNative) return nativeUsdPrice(network);
  if (listed) {
    const resolved = assetFromRef({ asset: listed.id, symbol: listed.symbol, decimals: listed.decimals });
    // Testnet value is $0, except Arc's USDC (Arc's gas asset, priced like the native asset).
    if (chain.environment === "testnet") return network === "arc" && isUsdStablecoin(resolved) ? 1 : 0;
    if (isUsdStablecoin(resolved)) return 1;
    if (listed.group === "ETH" || ETH_GROUP_SYMBOLS.has(listed.symbol.toUpperCase())) {
      const ethereum = CHAINS[network].nativeAsset.symbol === "ETH" ? network : "base";
      return nativeUsdPrice(ethereum);
    }
    if (chain.vm === "svm" && listed.address) return solanaMintUsdPrice(listed.address);
    return null;
  }
  return null;
}

export const defaultPreviewPricer: PreviewPricer = {
  async price(asset) {
    try {
      const value = await defaultPrice(asset);
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  },
};

let pricer: PreviewPricer = defaultPreviewPricer;

/** Replaces the preview pricer (tests, a policy pricer once the Rule Book lands); null restores the default. */
export function configurePreviewPricer(next: PreviewPricer | null): void {
  pricer = next ?? defaultPreviewPricer;
}

export function previewPricer(): PreviewPricer {
  return pricer;
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
