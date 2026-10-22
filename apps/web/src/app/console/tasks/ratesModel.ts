/**
 * Read-only rate questions on the desk ("compare yield", "show live Aave
 * rates"): what the sentence asks for, the venue list it is answered from
 * (`GET /v1/venues`, no wallet and no API key), and how the rows are
 * filtered, ordered and printed. Pure: node --test loads it.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";

import { isLegacyNetwork, networksNamedIn, type Departure, type LegacyNetwork } from "../state/deskModel.ts";

/** Lending protocols the venue list covers, by the words a sentence uses for them. */
const PROTOCOL_WORDS: readonly { readonly id: string; readonly word: string; readonly pattern: RegExp }[] = [
  { id: "aave-v3", word: "aave", pattern: /\baave(?:\s*v3)?\b/iu },
  { id: "compound-v3", word: "compound", pattern: /\bcompound(?:\s*v3)?\b/iu },
  { id: "morpho", word: "morpho", pattern: /\bmorpho\b/iu },
  { id: "moonwell", word: "moonwell", pattern: /\bmoonwell\b/iu },
];

const ASSET = /\b(USDC|USDT0?|DAI|EURC|GHO|USDS|WETH|ETH|wstETH|cbETH|cbBTC|WBTC)\b/iu;
const STABLES = new Set(["USDC", "USDT", "USDT0", "DAI", "EURC", "GHO", "USDS"]);

export interface RateQuery {
  /** The EVM network the sentence (or the departure) names; null for every network. */
  readonly network: NetworkKey | null;
  /** Protocol ids the sentence names; empty for every protocol. */
  readonly protocols: readonly string[];
  /** The asset asked about (upper case, "ETH" also matches WETH); null for every asset. */
  readonly asset: string | null;
  /** The sentence asks about borrowing, which the venue list does not cover. */
  readonly borrow: boolean;
  /** The sentence names Solana, whose venues are not in this list. */
  readonly solana: boolean;
}

/** What a rate question asks for. A Solana or test-yard departure never narrows the venue list; a sentence that names a network does. */
export function rateQueryOf(text: string, departure: Departure = "auto"): RateQuery {
  const named = networksNamedIn(text);
  // A network the sentence names counts (the test yard too); the departure only narrows to a production EVM network.
  const evm = named.filter((network) => CHAINS[network].namespace === "eip155");
  const fromDeparture =
    departure !== "auto" && CHAINS[departure].namespace === "eip155" && CHAINS[departure].lane !== "testnet" ? departure : null;
  const asset = ASSET.exec(text)?.[1] ?? null;
  return {
    network: evm[0] ?? (named.length === 0 ? fromDeparture : null),
    protocols: PROTOCOL_WORDS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.id),
    asset: asset ? (asset.toLowerCase() === "wsteth" ? "wstETH" : asset.toUpperCase().replace(/^CB/u, "cb")) : null,
    borrow: /\bborrow(?:ing)?\b/iu.test(text),
    solana: named.some((network) => CHAINS[network].namespace === "solana"),
  };
}

/** `GET /v1/venues` query string for a question (the network narrows the read; the rest is filtered here). */
export function venuesPath(query: RateQuery): string {
  return query.network ? `/v1/venues?network=${encodeURIComponent(query.network)}` : "/v1/venues";
}

export interface VenueRate {
  readonly venue: string;
  readonly protocol: string;
  readonly network: NetworkKey;
  readonly name: string;
  readonly asset: string;
  /** Fraction (0.0247 = 2.47 %); null when the venue did not report one. */
  readonly supplyApy: number | null;
  readonly totalSupplied: string | null;
  readonly exitLiquidity: string | null;
  readonly observedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHORT = /^[\w .:/()-]{1,80}$/u;
const AMOUNT = /^\d{1,40}(?:\.\d{1,40})?$/u;

function formattedOf(value: unknown): string | null {
  return isRecord(value) && typeof value.formatted === "string" && AMOUNT.test(value.formatted) ? value.formatted : null;
}

/** The venue list, validated: a row that does not parse is dropped, never guessed. */
export function parseVenues(body: unknown): readonly VenueRate[] | null {
  if (!isRecord(body) || !Array.isArray(body.venues)) return null;
  const rows: VenueRate[] = [];
  for (const entry of body.venues.slice(0, 200)) {
    if (!isRecord(entry)) continue;
    const { venue, protocol, network, name, asset, supplyApy, observedAt } = entry;
    if (typeof venue !== "string" || !SHORT.test(venue) || typeof protocol !== "string" || !SHORT.test(protocol)) continue;
    if (typeof network !== "string" || !(network in CHAINS)) continue;
    if (typeof name !== "string" || !SHORT.test(name) || typeof asset !== "string" || !SHORT.test(asset)) continue;
    rows.push({
      venue,
      protocol,
      network: network as NetworkKey,
      name,
      asset,
      supplyApy: typeof supplyApy === "number" && Number.isFinite(supplyApy) && supplyApy >= 0 && supplyApy < 10 ? supplyApy : null,
      totalSupplied: formattedOf(entry.totalSupplied),
      exitLiquidity: formattedOf(entry.exitLiquidity),
      observedAt: typeof observedAt === "string" && Number.isFinite(Date.parse(observedAt)) ? observedAt : null,
    });
  }
  return rows;
}

function assetMatches(row: VenueRate, asset: string | null): boolean {
  if (!asset) return true;
  const symbol = row.asset.toUpperCase();
  const wanted = asset.toUpperCase();
  if (wanted === "ETH" || wanted === "WETH") return symbol === "ETH" || symbol === "WETH";
  if (wanted === "USDT" || wanted === "USDT0") return symbol === "USDT" || symbol === "USDT0";
  return symbol === wanted;
}

/**
 * The rows a question asks about, best supply rate first (rows without a
 * rate last). Without a named network the test yard's venues are left out:
 * their rates say nothing about where money earns.
 */
export function ratesFor(rows: readonly VenueRate[], query: RateQuery): readonly VenueRate[] {
  return rows
    .filter((row) => (query.network ? row.network === query.network : CHAINS[row.network].lane !== "testnet"))
    .filter((row) => (query.protocols.length === 0 || query.protocols.includes(row.protocol)) && assetMatches(row, query.asset))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (b.row.supplyApy ?? -1) - (a.row.supplyApy ?? -1) || a.index - b.index)
    .map((entry) => entry.row);
}

/** "2.47%" (two decimals; below 0.01 % reads "under 0.01%"). */
export function formatApy(value: number | null): string {
  if (value === null) return "not reported";
  const percent = value * 100;
  if (percent > 0 && percent < 0.01) return "under 0.01%";
  return `${percent.toFixed(2)}%`;
}

/** A large token amount for a table cell: "216.6M", "97.4K", "12.24". */
export function formatSize(value: string | null): string {
  if (value === null) return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return number.toFixed(2);
}

/** "deposit 100 USDC into aave on base": the sentence a row's "Plan a deposit" fills; null for non-stable assets. */
export function depositSentence(row: VenueRate): string | null {
  const word = PROTOCOL_WORDS.find((entry) => entry.id === row.protocol)?.word;
  const symbol = row.asset.toUpperCase();
  if (!word || !STABLES.has(symbol)) return null;
  return `deposit 100 ${row.asset} into ${word} on ${row.network}`;
}

/** The network engine that reads borrow rates for a question, when one serves its network. */
export function borrowEngineFor(query: RateQuery): LegacyNetwork | null {
  return query.network && isLegacyNetwork(query.network) && query.network !== "arc" ? query.network : null;
}
