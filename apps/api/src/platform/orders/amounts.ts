/**
 * Order amounts for responses: resolved assets, or assets a provider names
 * only by address (order lists), described from the registry when listed.
 */
import { CHAINS, findAssetByAddress, formatAssetId, fromBaseUnits, toBaseUnits, type AssetId } from "@kletia/core";
import type { ResolvedAsset } from "../engine/assets.js";
import type { OrderAmount, OrderNetwork } from "./types.js";

export function orderAmount(asset: Pick<ResolvedAsset, "id" | "symbol" | "decimals">, units: bigint | string): OrderAmount {
  const amount = String(units);
  return { asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, amount, formatted: fromBaseUnits(amount, asset.decimals) };
}

/** Short label of an unlisted token address ("61V8…pump"). */
function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Decimals that turn the provider's `human` reading into its `raw` base units, or null. */
export function decimalsFromReading(raw: string, human: string): number | null {
  if (!/^\d+$/u.test(raw) || BigInt(raw) === 0n) return null;
  for (let decimals = 0; decimals <= 18; decimals += 1) {
    try {
      if (toBaseUnits(human, decimals) === BigInt(raw).toString()) return decimals;
    } catch {
      // Too few decimals for this reading: try the next.
    }
  }
  return null;
}

export interface TokenRef {
  readonly id: AssetId;
  readonly symbol: string;
  /** Null when neither the registry nor the provider's own reading gives them. */
  readonly decimals: number | null;
}

/** A token by address: the registry entry when listed, else the address with decimals read from a provider pair. */
export function tokenRef(network: OrderNetwork, address: string, reading?: { readonly raw: string; readonly human: string }): TokenRef {
  const listed = findAssetByAddress(network, address);
  if (listed) return { id: listed.id, symbol: listed.symbol, decimals: listed.decimals };
  const id = formatAssetId(CHAINS[network], CHAINS[network].vm === "svm" ? "token" : "erc20", address);
  return { id, symbol: shortAddress(address), decimals: reading ? decimalsFromReading(reading.raw, reading.human) : null };
}

/** An amount of a token ref; unknown decimals are shown as base units (decimals 0) rather than guessed. */
export function refAmount(token: TokenRef, units: bigint | string): OrderAmount {
  return orderAmount({ id: token.id, symbol: token.symbol, decimals: token.decimals ?? 0 }, units);
}
