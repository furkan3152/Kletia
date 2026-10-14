/**
 * What the clarify layer knows about networks, assets and venues. Every
 * capability comes from the constants the grammar, planner and registry
 * already use (SWAP_NETWORKS, the venue words, YIELD_VENUES, the staking
 * tables, ASSETS, getProtocol), so a new venue or network changes the
 * questions and options without an edit here. The only lists of its own are
 * product readings of words (renames, look-alikes, ambiguous symbols).
 */
import {
  AMBIGUOUS_VENUE_WORDS,
  ASSETS,
  CHAINS,
  findAssetBySymbol,
  getProtocol,
  isEvmAddress,
  isSolanaAddress,
  parseAccountId,
  STAKE_PROVIDER_WORDS,
  USD_WORDS,
  YIELD_VENUES,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import {
  BRIDGE_VENUES,
  EVM_STAKING_NETWORK,
  EVM_STAKING_TOKENS,
  GRAMMAR_VENUE_WORDS,
  LENDING_VENUES,
  LIQUID_STAKING_TOKENS,
  SWAP_NETWORKS,
  SWAP_VENUES,
  type VenueWord,
} from "../grammar.js";
import { portableSymbol } from "../departure.js";
import type { Kind } from "./types.js";

export const NETWORK_ORDER = Object.keys(CHAINS) as NetworkKey[];
export const lane = (network: NetworkKey) => CHAINS[network].environment;
export const family = (network: NetworkKey) => CHAINS[network].namespace;
export const networkName = (network: NetworkKey) => CHAINS[network].name;

/** EVM networks a transfer may run on (registry order). */
export const EVM_NETWORKS: readonly NetworkKey[] = NETWORK_ORDER.filter((network) => CHAINS[network].vm === "evm");

/** Networks a bridge can start or end on: every network that lists canonical USDC that a bridge can move. */
export const BRIDGE_NETWORKS: readonly NetworkKey[] = NETWORK_ORDER.filter((network) =>
  NETWORK_ORDER.some((other) => other !== network && portableSymbol(findAssetBySymbol(other, "USDC"), network, other) !== null));

export { SWAP_NETWORKS };

/** 1:1 renames and identity aliases (R5). `silent`: no chip. */
export const ALIASES: readonly { network: NetworkKey | "*"; from: string; to: string; silent?: boolean; material?: boolean; note: string }[] = [
  { network: "polygon", from: "MATIC", to: "POL", note: "MATIC is now POL, Polygon's native token." },
  { network: "base", from: "BTC", to: "cbBTC", material: true, note: "Bitcoin on Base is cbBTC (Coinbase Wrapped BTC)." },
  { network: "solana", from: "BTC", to: "cbBTC", material: true, note: "Bitcoin on Solana is cbBTC (Coinbase Wrapped BTC)." },
  { network: "*", from: "ETHER", to: "ETH", silent: true, note: "" },
  { network: "solana", from: "WSOL", to: "SOL", silent: true, note: "" },
];

/** One symbol, two assets of very different value on one network (R5). */
export const AMBIGUOUS_SYMBOLS: readonly { network: NetworkKey; symbol: string; options: readonly { symbol: string; recommended?: true; detail: string }[] }[] = [
  {
    network: "polygon",
    symbol: "ETH",
    options: [
      { symbol: "WETH", recommended: true, detail: "Ether on Polygon PoS (bridged)" },
      { symbol: "POL", detail: "Polygon's own gas token, worth far less than ether" },
    ],
  },
];

/** Look-alike pairs on one network (R5). */
export const LOOKALIKES: readonly { network: NetworkKey; a: string; b: string; note: string }[] = [
  { network: "base", a: "USDC", b: "USDbC", note: "USDbC is the older bridged USDC on Base, a different token." },
];

export const USD_ORDER: readonly string[] = ["USDC", "USDT", "PYUSD", "DAI"];

export function isUsdWord(word: string | undefined): boolean {
  return word !== undefined && USD_WORDS.has(word.toLowerCase());
}

/** The registry symbol `symbol` names on `network` (native or listed, case-insensitive), or null. */
export function canonicalOn(network: NetworkKey, symbol: string): string | null {
  const upper = symbol.toUpperCase();
  if (CHAINS[network].nativeAsset.symbol.toUpperCase() === upper) return CHAINS[network].nativeAsset.symbol;
  return findAssetBySymbol(network, symbol)?.symbol ?? null;
}

/** True when the asset is listed for balances and transfers only (no venue routes it). */
export function transferOnly(network: NetworkKey, symbol: string): boolean {
  return findAssetBySymbol(network, symbol)?.transferOnly === true;
}

/** Listed symbols of a network in registry order (the native asset first). */
export function symbolsOn(network: NetworkKey): string[] {
  const set = new Set<string>([CHAINS[network].nativeAsset.symbol]);
  for (const asset of ASSETS) if (asset.network === network) set.add(asset.symbol);
  return [...set];
}

export function decimalsOf(network: NetworkKey, symbol: string): number {
  const native = CHAINS[network].nativeAsset;
  if (native.symbol.toUpperCase() === symbol.toUpperCase()) return native.decimals;
  return findAssetBySymbol(network, symbol)?.decimals ?? 18;
}

/** True when `token` is a listed symbol on some network, or a rename the engine maps. */
export function knownSymbol(token: string): boolean {
  const upper = token.toUpperCase();
  return NETWORK_ORDER.some((network) => canonicalOn(network, upper) !== null) || ALIASES.some((alias) => alias.from === upper);
}

/* ------------------------------------------------------------- venues */

function protocolFromWords(raw: string, words: readonly VenueWord[]): ProtocolId | null {
  const value = raw.trim();
  return words.find((entry) => entry.pattern.test(value))?.protocol ?? null;
}

/** Lending protocol a venue word names; bare "spark" stays "spark" (ambiguous, asked as VENUE_AMBIGUOUS). */
export function lendingProtocol(raw: string): string | null {
  const word = raw.trim().toLowerCase().replace(/[\s-]+/gu, " ");
  if (Object.hasOwn(AMBIGUOUS_VENUE_WORDS, word)) return word;
  return protocolFromWords(raw, LENDING_VENUES);
}
export const bridgeProtocol = (raw: string): ProtocolId | null => protocolFromWords(raw, BRIDGE_VENUES);
export const dexProtocol = (raw: string): ProtocolId | null => protocolFromWords(raw, SWAP_VENUES);

/** The protocols an ambiguous venue word may mean (the default first), or null. */
export function ambiguousVenue(protocol: string | undefined): readonly ProtocolId[] | null {
  if (!protocol) return null;
  return Object.hasOwn(AMBIGUOUS_VENUE_WORDS, protocol) ? AMBIGUOUS_VENUE_WORDS[protocol] ?? null : null;
}

export function protocolLabel(id: string): string {
  return getProtocol(id as ProtocolId)?.name ?? id;
}

const WORD_CACHE = new Map<string, string>();

/** The word the grammar reads for a protocol id ("aave-v3" -> "aave", "spark-savings" -> "spark savings"). */
export function protocolWord(id: string): string {
  const cached = WORD_CACHE.get(id);
  if (cached) return cached;
  const all: readonly VenueWord[] = [...LENDING_VENUES, ...BRIDGE_VENUES, ...SWAP_VENUES];
  const word = GRAMMAR_VENUE_WORDS.find((candidate) =>
    !Object.hasOwn(AMBIGUOUS_VENUE_WORDS, candidate) && all.find((entry) => entry.pattern.test(candidate))?.protocol === id) ?? id;
  WORD_CACHE.set(id, word);
  return word;
}

/** Networks a named swap venue runs on, or null when no venue was named. */
export function dexNetworks(protocol: string | undefined): readonly NetworkKey[] | null {
  if (!protocol) return null;
  return getProtocol(protocol as ProtocolId)?.networks ?? [];
}

/** Lending and savings protocols in registry order (YIELD_VENUES). */
export function lendingProtocols(): string[] {
  return [...new Set(YIELD_VENUES.filter((venue) => venue.actions.length > 0).map((venue) => venue.protocol))];
}

function venueMatches(asset: string, symbol: string): boolean {
  return asset.toUpperCase() === symbol.toUpperCase() || (symbol.toUpperCase() === "ETH" && asset.toUpperCase() === "WETH");
}

/** Networks with an executable venue of `protocol` (any when absent) taking the asset `symbolOn(network)`. */
export function venueNetworks(kind: "deposit" | "withdraw", protocol: string | undefined, symbolOn: (network: NetworkKey) => string | null): NetworkKey[] {
  const options = ambiguousVenue(protocol) ?? (protocol ? [protocol] : null);
  const networks = YIELD_VENUES
    .filter((venue) => (!options || options.includes(venue.protocol)) && (venue.actions as readonly string[]).includes(kind))
    .filter((venue) => {
      const symbol = symbolOn(venue.network);
      return symbol !== null && venueMatches(venue.asset, symbol);
    })
    .map((venue) => venue.network);
  return [...new Set(networks)].sort((a, b) => NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b));
}

export function venuesOn(network: NetworkKey, kind: "deposit" | "withdraw", protocol: string | undefined, symbol: string) {
  return YIELD_VENUES.filter((venue) =>
    venue.network === network && (!protocol || venue.protocol === protocol) && (venue.actions as readonly string[]).includes(kind) && venueMatches(venue.asset, symbol));
}

/** Protocols whose venues are named by slug in the grammar ("into morpho spark-usdc"). */
export const VAULT_PROTOCOLS: readonly string[] = ["morpho", "spark-savings", "yearn-v3"];

/* ------------------------------------------------------------ staking */

export interface StakeProvider {
  readonly id: string;
  readonly word: string;
  readonly symbol: string;
  readonly label: string;
  readonly network: NetworkKey;
  /** Asset the provider stakes. */
  readonly input: "SOL" | "ETH";
  /** params.provider the grammar writes. */
  readonly grammarProvider: string;
}

/** Staking providers by id (core STAKE_PROVIDER_WORDS), with the grammar's provider names. */
export const STAKE_PROVIDERS: readonly StakeProvider[] = (() => {
  const seen = new Map<string, StakeProvider>();
  for (const [word, entry] of Object.entries(STAKE_PROVIDER_WORDS)) {
    if (seen.has(entry.provider)) continue;
    const evm = EVM_STAKING_TOKENS[word];
    const sol = LIQUID_STAKING_TOKENS[word];
    const grammarProvider = evm?.provider ?? sol?.provider ?? entry.provider;
    seen.set(entry.provider, {
      id: entry.provider,
      word,
      symbol: entry.symbol,
      label: `${grammarProvider} (${entry.symbol})`,
      network: entry.network,
      input: entry.network === EVM_STAKING_NETWORK ? "ETH" : "SOL",
      grammarProvider,
    });
  }
  return [...seen.values()];
})();

export function stakeProvider(id: string | undefined): StakeProvider | undefined {
  return STAKE_PROVIDERS.find((provider) => provider.id === id);
}

/** The provider a staking word names (jito, marinade, lido, "rocket pool", ...). */
export function providerFromWord(word: string): StakeProvider | undefined {
  const entry = STAKE_PROVIDER_WORDS[word.toLowerCase().replace(/[\s-]+/gu, " ")] ??
    STAKE_PROVIDER_WORDS[word.toLowerCase().replace(/[\s-]+/gu, "")] ??
    (word.toLowerCase() === "jupiter" ? { provider: "jupiter" } : undefined);
  return entry ? stakeProvider(entry.provider) : undefined;
}

/** Kletia's default provider for an input (Jito for SOL, Lido for ETH). */
export function defaultProvider(input: "SOL" | "ETH"): StakeProvider {
  return STAKE_PROVIDERS.find((provider) => provider.input === input) as StakeProvider;
}

/* ----------------------------------------------------------- accounts */

/** Accounts re-home across eip155 networks and across Solana clusters (engine/accounts.ts accountForNetwork). */
export function hasAccount(accounts: readonly string[], network: NetworkKey): boolean {
  return accounts.some((account) => parseAccountId(account)?.chain.namespace === family(network));
}

export function ownAddress(accounts: readonly string[], recipient: string): boolean {
  const target = recipient.includes(":") ? parseAccountId(recipient)?.address ?? recipient : recipient;
  return accounts.some((account) => {
    const parsed = parseAccountId(account);
    if (!parsed) return false;
    return parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() === target.toLowerCase() : parsed.address === target;
  });
}

export function laneOf(accounts: readonly string[]): "mainnet" | "testnet" {
  const networks = accounts.map((account) => parseAccountId(account)?.chain.key).filter((key): key is NetworkKey => key !== undefined);
  return networks.length > 0 && networks.every((key) => lane(key) === "testnet") ? "testnet" : "mainnet";
}

export function recipientFamily(recipient: string): "eip155" | "solana" | "caip" | null {
  if (recipient.includes(":")) return "caip";
  if (isEvmAddress(recipient) || /\.eth$/iu.test(recipient)) return "eip155";
  if (isSolanaAddress(recipient) || /\.(?:sns|sol)$/iu.test(recipient)) return "solana";
  return null;
}

export const isName = (recipient: string) => /\.(?:eth|sns|sol)$/iu.test(recipient);

/** Portable inputs (departure.ts): canonical USDC between mainnets that list it, native ETH between Base, Arbitrum One, Ethereum and OP Mainnet. */
export function portable(raw: string | undefined, usd: boolean | undefined, from: NetworkKey, to: NetworkKey): boolean {
  const symbol = raw && !isUsdWord(raw) ? raw : usd || isUsdWord(raw) ? "USDC" : "";
  if (!symbol) return false;
  const there = findAssetBySymbol(to, symbol);
  return portableSymbol(there, from, to) !== null;
}

/** Steps a kind can run on, by name of the step kind (for the capability test). */
export const OFFERED_KINDS: readonly Kind[] = ["swap", "bridge", "transfer", "stake", "deposit", "withdraw"];
