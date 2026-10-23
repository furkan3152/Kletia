/**
 * Carriers of composite crossings (design C.2, red-team A10): the token a
 * composite route moves across networks, chosen by exact token address on
 * each network, never by asset group.
 *
 * - USDC whenever both networks list canonical USDC (each network's own
 *   registry address; bridged variants such as USDbC or USDC.e are other
 *   tokens and never carry).
 * - USDT0 only where the registry lists USDT0 by address on both networks
 *   (OP Mainnet lists the legacy bridged USDT, a different token).
 * - ETH only between networks whose gas asset is ETH, and only when the
 *   crossing's own input or output is ETH or WETH (no added price exposure).
 *
 * Mainnet and testnet never share a carrier (capital lanes).
 */
import { CHAINS, findAssetBySymbol, getAsset, nativeAssetId, sameCapitalLane, type AssetDescriptor, type NetworkKey } from "@kletia/core";
import { resolvedFromDescriptor, type ResolvedAsset } from "../assets.js";

export type CarrierId = "USDC" | "USDT0" | "ETH";

/** One carrier between two networks: the exact token on each side. */
export interface Carrier {
  readonly id: CarrierId;
  readonly source: ResolvedAsset;
  readonly destination: ResolvedAsset;
}

/** The listed descriptor whose symbol is exactly `symbol` (case-insensitive), never a look-alike. */
function exactListing(network: NetworkKey, symbol: string): AssetDescriptor | null {
  const descriptor = findAssetBySymbol(network, symbol);
  if (!descriptor || descriptor.symbol.toUpperCase() !== symbol.toUpperCase()) return null;
  if (descriptor.transferOnly) return null;
  return descriptor;
}

function ethNetwork(network: NetworkKey): boolean {
  return CHAINS[network].vm === "evm" && CHAINS[network].nativeAsset.symbol.toUpperCase() === "ETH";
}

function isEther(asset: Pick<ResolvedAsset, "symbol" | "isNative" | "network">): boolean {
  const symbol = asset.symbol.toUpperCase();
  return (asset.isNative && ethNetwork(asset.network)) || symbol === "WETH" || symbol === "ETH";
}

/** USDC listed on both networks, by each network's own registry address. */
function stableCarrier(id: "USDC" | "USDT0", source: NetworkKey, destination: NetworkKey): Carrier | null {
  const a = exactListing(source, id);
  const b = exactListing(destination, id);
  if (!a || !b || !a.address || !b.address) return null;
  return { id, source: resolvedFromDescriptor(a), destination: resolvedFromDescriptor(b) };
}

function etherCarrier(source: NetworkKey, destination: NetworkKey): Carrier | null {
  if (!ethNetwork(source) || !ethNetwork(destination)) return null;
  const a = nativeEther(source);
  const b = nativeEther(destination);
  return a && b ? { id: "ETH", source: a, destination: b } : null;
}

function nativeEther(network: NetworkKey): ResolvedAsset | null {
  const descriptor = getAsset(nativeAssetId(network));
  return descriptor ? resolvedFromDescriptor(descriptor) : null;
}

/**
 * Carriers for a crossing `input`@A -> `output`@B, in pre-screen order:
 * USDC first (it beat the one-shot in 26 of 29 measured cases), then ETH
 * when eligible, then USDT0 only when USDC is not listed on both networks.
 */
export function carriersFor(input: ResolvedAsset, output: ResolvedAsset): Carrier[] {
  const source = input.network;
  const destination = output.network;
  if (source === destination || !sameCapitalLane(source, destination)) return [];
  const carriers: Carrier[] = [];
  const usdc = stableCarrier("USDC", source, destination);
  if (usdc) carriers.push(usdc);
  if (isEther(input) || isEther(output)) {
    const eth = etherCarrier(source, destination);
    if (eth) carriers.push(eth);
  }
  if (!usdc) {
    const usdt0 = stableCarrier("USDT0", source, destination);
    if (usdt0) carriers.push(usdt0);
  }
  return carriers;
}

/** True when `asset` is exactly the carrier token on its network (same asset id). */
export function isCarrierToken(asset: Pick<ResolvedAsset, "id">, carrier: ResolvedAsset): boolean {
  return asset.id.toLowerCase() === carrier.id.toLowerCase();
}
