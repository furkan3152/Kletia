import { getAddress, isAddress, type Address } from "viem";
import { BASE_TOKEN_REGISTRY } from "../networks/base/protocols.js";
import {
  ARC_CONTRACTS,
  ARC_NATIVE_USDC_ADDRESS,
  NETWORKS,
  type NetworkId,
} from "../config/networks.js";
import { ARC_OFFICIAL_ADDRESSES } from "../networks/arc/officialExtensions.js";

export type AssetTrustTier =
  "core" | "established" | "elevated" | "project" | "portfolio";

export type AssetRepresentation =
  "native" | "erc20" | "native_with_erc20_interface" | "app_kit_symbol";

export type AssetCatalogVerification =
  "manifest_verified" | "registry_reviewed";

export const ASSET_CATALOG_REVISION = "2026-08-01.1";

export interface AssetCatalogEntry {
  readonly network: NetworkId;
  readonly symbol: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly address?: Address;
  readonly decimals: number;
  readonly representation: AssetRepresentation;
  readonly trustTier: AssetTrustTier;
  readonly verification: AssetCatalogVerification;
  readonly officialSource?: string;
  readonly executionUnits?: Readonly<Record<string, number>>;
}

export class UnsafeAssetReferenceError extends Error {
  readonly code = "UNSAFE_ASSET_REFERENCE";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeAssetReferenceError";
  }
}

const BASE_ASSET_NAMES: Partial<
  Record<keyof typeof BASE_TOKEN_REGISTRY, readonly [string, ...string[]]>
> = {
  ETH: ["Ether", "Ethereum", "native ETH"],
  WETH: ["Wrapped Ether", "Wrapped ETH"],
  USDC: ["USD Coin"],
  USDBC: ["USD Base Coin", "bridged USDC", "USDbC"],
  CBBTC: ["Coinbase Wrapped BTC", "Coinbase Bitcoin", "cbBTC"],
  DAI: ["Dai Stablecoin"],
  AERO: ["Aerodrome Finance", "Aerodrome token"],
  WSTETH: ["Wrapped stETH", "wrapped staked Ether"],
  CBETH: ["Coinbase Wrapped Staked ETH", "Coinbase Staked ETH"],
  RETH: ["Rocket Pool ETH", "Rocket ETH"],
  WEETH: ["Wrapped eETH"],
  EZETH: ["Renzo Restaked ETH"],
  WRSETH: ["Kelp Wrapped rsETH"],
  EURC: ["Euro Coin"],
  TBTC: ["Threshold Bitcoin"],
  LBTC: ["Lombard Staked Bitcoin"],
  SYRUPUSDC: ["Syrup USDC"],
  WELL: ["Moonwell token"],
  MORPHO: ["Morpho token"],
  COMP: ["Compound token"],
  SEAM: ["Seamless token"],
  SUSDS: ["Savings USDS"],
};

const BASE_PRIMARY_SOURCES: Partial<
  Record<keyof typeof BASE_TOKEN_REGISTRY, string>
> = Object.freeze({
  ETH: "https://docs.base.org/base-chain/network-information/base-contracts",
  WETH: "https://docs.base.org/base-chain/network-information/base-contracts",
  USDC: "https://developers.circle.com/stablecoins/usdc-contract-addresses",
  EURC: "https://developers.circle.com/stablecoins/eurc-contract-addresses",
  AERO: "https://github.com/aerodrome-finance/contracts",
});

function baseCatalog(): readonly AssetCatalogEntry[] {
  return Object.entries(BASE_TOKEN_REGISTRY).map(([key, definition]) => {
    const registryKey = key as keyof typeof BASE_TOKEN_REGISTRY;
    const configuredNames = BASE_ASSET_NAMES[registryKey];
    const officialSource = BASE_PRIMARY_SOURCES[registryKey];
    const name = configuredNames?.[0] || definition.symbol;
    const aliases = [
      key,
      definition.symbol,
      name,
      ...(configuredNames?.slice(1) || []),
    ];
    return Object.freeze({
      network: "base" as const,
      symbol: definition.symbol,
      name,
      aliases: Object.freeze([...new Set(aliases)]),

      address: key === "ETH" ? undefined : definition.address,
      decimals: definition.decimals,
      representation: key === "ETH" ? ("native" as const) : ("erc20" as const),
      trustTier: definition.riskTier,

      verification: officialSource
        ? ("manifest_verified" as const)
        : ("registry_reviewed" as const),
      officialSource,
    });
  });
}

const ARC_CATALOG: readonly AssetCatalogEntry[] = Object.freeze([
  Object.freeze({
    network: "arc" as const,
    symbol: "USDC",
    name: "USD Coin",
    aliases: Object.freeze([
      "USDC",
      "USD Coin",
      "native USDC",
      "Arc USDC",
      "USDC gas token",
    ]),
    address: ARC_NATIVE_USDC_ADDRESS,
    decimals: 6,
    representation: "native_with_erc20_interface" as const,
    trustTier: "core" as const,
    verification: "manifest_verified" as const,
    officialSource: "https://docs.arc.io/arc/references/contract-addresses",
    executionUnits: Object.freeze({
      app_kit: 6,
      erc20_interface: 6,
      kletia_native_value: 18,
    }),
  }),
  Object.freeze({
    network: "arc" as const,
    symbol: "EURC",
    name: "Euro Coin",
    aliases: Object.freeze(["EURC", "Euro Coin", "Arc EURC"]),
    address: ARC_OFFICIAL_ADDRESSES.EURC,
    decimals: 6,
    representation: "erc20" as const,
    trustTier: "core" as const,
    verification: "manifest_verified" as const,
    officialSource:
      "https://developers.circle.com/stablecoins/eurc-contract-addresses",
    executionUnits: Object.freeze({ app_kit: 6, erc20: 6 }),
  }),
  Object.freeze({
    network: "arc" as const,
    symbol: "cirBTC",
    name: "Circle Bitcoin",
    aliases: Object.freeze([
      "cirBTC",
      "cir BTC",
      "Circle Bitcoin",
      "Arc cirBTC",
    ]),
    decimals: 8,
    representation: "app_kit_symbol" as const,
    trustTier: "core" as const,
    verification: "manifest_verified" as const,
    officialSource: "https://docs.arc.io/app-kit/swap",
    executionUnits: Object.freeze({ app_kit: 8 }),
  }),
  Object.freeze({
    network: "arc" as const,
    symbol: "KLET",
    name: "Kletia Token",
    aliases: Object.freeze([
      "KLET",
      "Kletia",
      "Kletia coin",
      "Kletia token",
      "Kletia project token",
    ]),
    address: ARC_CONTRACTS.Token,
    decimals: 18,
    representation: "erc20" as const,
    trustTier: "project" as const,
    verification: "registry_reviewed" as const,
    executionUnits: Object.freeze({ kletia_contract: 18 }),
  }),
]);

export const ASSET_CATALOG: Readonly<
  Record<NetworkId, readonly AssetCatalogEntry[]>
> = Object.freeze({
  base: Object.freeze(baseCatalog()),
  arc: ARC_CATALOG,
});

const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function normalizeAssetReference(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  const raw = trimmed.normalize("NFKC");
  if (!raw || raw.length > 128) {
    throw new UnsafeAssetReferenceError(
      "Token reference must be between 1 and 128 visible characters.",
    );
  }
  if (FORBIDDEN_TEXT.test(raw)) {
    throw new UnsafeAssetReferenceError(
      "Token reference cannot contain invisible, directionality, or control characters.",
    );
  }
  if (raw !== trimmed) {
    throw new UnsafeAssetReferenceError(
      "Token reference cannot be silently altered by compatibility/homoglyph normalization.",
    );
  }
  return raw.replace(/\s+/gu, " ");
}

export function foldAssetReference(value: unknown): string {
  return normalizeAssetReference(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "");
}

/** Exact identity matching keeps punctuation significant. */
export function assetReferenceIdentityKey(value: unknown): string {
  return normalizeAssetReference(value).toLocaleLowerCase("en-US");
}

function entryAliasKeys(entry: AssetCatalogEntry): readonly string[] {
  return [
    ...new Set(
      [entry.symbol, entry.name, ...entry.aliases].map(
        assetReferenceIdentityKey,
      ),
    ),
  ];
}

export function findCatalogAssetsByReference(
  network: NetworkId,
  reference: unknown,
): readonly AssetCatalogEntry[] {
  const raw = normalizeAssetReference(reference);
  if (isAddress(raw)) {
    const address = getAddress(raw);
    const matches = ASSET_CATALOG[network].filter(
      (entry) =>
        entry.address !== undefined &&
        entry.address.toLowerCase() === address.toLowerCase(),
    );

    const erc20Matches = matches.filter(
      ({ representation }) => representation !== "native",
    );
    return erc20Matches.length > 0 ? erc20Matches : matches;
  }

  const identityKey = assetReferenceIdentityKey(raw);
  return ASSET_CATALOG[network].filter((entry) =>
    entryAliasKeys(entry).includes(identityKey),
  );
}

export function canonicalizeKnownAssetReference(
  network: NetworkId,
  reference: unknown,
): string | undefined {
  if (typeof reference !== "string" || !reference.trim()) return undefined;
  const matches = findCatalogAssetsByReference(network, reference);
  return matches.length === 1 ? matches[0].symbol : undefined;
}

export function assetAliasesForSymbol(
  network: NetworkId,
  symbol: string,
): readonly string[] {
  if (!symbol.trim()) return [];
  let foldedSymbol: string;
  try {
    foldedSymbol = assetReferenceIdentityKey(symbol);
  } catch {
    return [];
  }
  const entry = ASSET_CATALOG[network].find(
    (candidate) => assetReferenceIdentityKey(candidate.symbol) === foldedSymbol,
  );
  return entry
    ? [...new Set([entry.symbol, entry.name, ...entry.aliases])]
    : [];
}

export function compareAssetReferenceSimilarity(
  firstValue: string,
  secondValue: string,
): number {
  const first = foldAssetReference(firstValue);
  const second = foldAssetReference(secondValue);
  if (first === second) return 1;
  if (first.length < 2 || second.length < 2) return 0;

  const firstBigrams = new Map<string, number>();
  for (let index = 0; index < first.length - 1; index += 1) {
    const bigram = first.slice(index, index + 2);
    firstBigrams.set(bigram, (firstBigrams.get(bigram) || 0) + 1);
  }

  let intersection = 0;
  for (let index = 0; index < second.length - 1; index += 1) {
    const bigram = second.slice(index, index + 2);
    const count = firstBigrams.get(bigram) || 0;
    if (count > 0) {
      firstBigrams.set(bigram, count - 1);
      intersection += 1;
    }
  }
  return (2 * intersection) / (first.length + second.length - 2);
}

export function closestCatalogAssets(
  network: NetworkId,
  reference: unknown,
  threshold = 0.68,
): readonly { asset: AssetCatalogEntry; similarity: number }[] {
  const raw = normalizeAssetReference(reference);
  return ASSET_CATALOG[network]
    .map((asset) => ({
      asset,
      similarity: Math.max(
        ...[asset.symbol, asset.name, ...asset.aliases].map((alias) =>
          compareAssetReferenceSimilarity(raw, alias),
        ),
      ),
    }))
    .filter(({ similarity }) => similarity >= threshold)
    .sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.asset.symbol.localeCompare(right.asset.symbol),
    )
    .slice(0, 4);
}

export function catalogChainId(network: NetworkId): number {
  return NETWORKS[network].chainId;
}
