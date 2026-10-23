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
  capabilityIndex,
  capableProtocols,
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
  type ProtocolTier,
  type YieldVenue,
} from "@kletia/core";
import {
  BRIDGE_VENUES,
  EVM_STAKING_NETWORK,
  EVM_STAKING_TOKENS,
  GRAMMAR_VENUE_WORDS,
  l2StakeAlternatives,
  LENDING_VENUES,
  LIQUID_STAKING_TOKENS,
  NATIVE_STAKE_PROTOCOL,
  NATIVE_STAKE_PROVIDER,
  NATIVE_STAKE_WORDS,
  SWAP_NETWORKS as GRAMMAR_SWAP_NETWORKS,
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

/** Bridge networks of a lane (mainnet: BRIDGE_NETWORKS; testnet: the CCTP V2 testnets). */
export function bridgeNetworksOf(current: "mainnet" | "testnet"): readonly NetworkKey[] {
  return current === "testnet" ? TESTNET_BRIDGE_NETWORKS : BRIDGE_NETWORKS.filter((network) => lane(network) === "mainnet");
}

/**
 * Networks a swap can run on, both lanes: the grammar's mainnet swap networks
 * plus testnets with a swap venue in the capability index (Uniswap V3 on
 * Arbitrum Sepolia). Every list is filtered by the request's lane where used.
 */
export const SWAP_NETWORKS: readonly NetworkKey[] = Object.freeze([
  ...GRAMMAR_SWAP_NETWORKS,
  ...NETWORK_ORDER.filter((network) => lane(network) === "testnet" && capabilityIndex(network, "swap").length > 0),
]);

/** Bridge networks of the testnet lane: CCTP V2 testnets (a bridge venue there, or a Solana cluster CCTP mints on) that list USDC. */
export const TESTNET_BRIDGE_NETWORKS: readonly NetworkKey[] = Object.freeze(NETWORK_ORDER.filter((network) =>
  lane(network) === "testnet" && findAssetBySymbol(network, "USDC") !== null &&
  (capabilityIndex(network, "bridge").length > 0 || (CHAINS[network].vm === "svm" && NETWORK_ORDER.some((other) => lane(other) === "testnet" && capabilityIndex(other, "bridge").some((row) => row.protocol === "cctp-v2"))))));

/**
 * 1:1 renames and identity aliases (R5). `silent`: no chip. `lookalike`: the word names a different token
 * that Kletia does not spend or deliver (wSOL in a token account is not native SOL), so the listed one is
 * asked (ASSET_LOOKALIKE, the prompt per side), never read silently.
 */
export const ALIASES: readonly {
  network: NetworkKey | "*";
  from: string;
  to: string;
  silent?: boolean;
  material?: boolean;
  lookalike?: { readonly spend: string; readonly receive: string };
  note: string;
}[] = [
  { network: "polygon", from: "MATIC", to: "POL", note: "MATIC is now POL, Polygon's native token." },
  { network: "base", from: "BTC", to: "cbBTC", material: true, note: "Bitcoin on Base is cbBTC (Coinbase Wrapped BTC)." },
  { network: "solana", from: "BTC", to: "cbBTC", material: true, note: "Bitcoin on Solana is cbBTC (Coinbase Wrapped BTC)." },
  { network: "*", from: "ETHER", to: "ETH", silent: true, note: "" },
  {
    network: "solana",
    from: "WSOL",
    to: "SOL",
    lookalike: {
      spend: "Kletia spends native SOL; wSOL held in a token account is not used. Use SOL?",
      receive: "Kletia delivers native SOL, not wSOL in a token account. Receive SOL?",
    },
    note: "wSOL is SOL wrapped in a token account, a separate balance. Kletia does not unwrap it.",
  },
];

/**
 * Look-alike families: wrapped, staked and bridged forms of one asset, in their usual spelling (matched
 * without case, dots or dashes). A typed member that Kletia does not list is never read as a listed member one
 * letter away (stETH is not wstETH): the person is asked (ASSET_LOOKALIKE) with what the listed token is.
 */
export const LOOKALIKE_GROUPS: readonly (readonly string[])[] = [
  ["ETH", "WETH", "stETH", "wstETH", "eETH", "weETH", "rETH", "mETH", "ETHx", "cbETH", "frxETH", "sfrxETH"],
  ["SOL", "wSOL", "JitoSOL", "JupSOL", "mSOL", "bSOL", "stSOL"],
  ["USDC", "USDbC", "USDC.e"],
  ["USDT", "USDT0"],
];

/** What the listed member is, for the member it is mistaken for ("typed>listed"). */
const LOOKALIKE_NOTES: Readonly<Record<string, string>> = {
  "stETH>wstETH": "wrapped stETH, about 1.2 stETH each",
  "eETH>weETH": "wrapped eETH, worth more than 1 eETH each",
  "frxETH>sfrxETH": "staked frxETH, worth more than 1 frxETH each",
  "USDC.e>USDC": "the native token",
};

const plainSymbol = (symbol: string) => symbol.toUpperCase().replace(/[.-]/gu, "");

/**
 * When `typed` and the listed `symbol` are different members of one look-alike family: the typed member in
 * its usual spelling and, when known, what the listed one is. Null otherwise (a plain typo).
 */
export function lookalikeOf(typed: string, symbol: string): { typed: string; note?: string } | null {
  const a = plainSymbol(typed);
  const b = plainSymbol(symbol);
  if (a === b) return null;
  for (const group of LOOKALIKE_GROUPS) {
    const member = group.find((entry) => plainSymbol(entry) === a);
    const listed = group.find((entry) => plainSymbol(entry) === b);
    if (!member || !listed) continue;
    const note = LOOKALIKE_NOTES[`${member}>${listed}`];
    return { typed: member, ...(note ? { note } : {}) };
  }
  return null;
}

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

/**
 * Lending and savings protocols in registry order, from the capability index
 * (deposit and withdraw rows): the options of a VENUE_MISSING question.
 */
export function lendingProtocols(): string[] {
  return [...new Set([...capableProtocols("deposit"), ...capableProtocols("withdraw")])];
}

/**
 * The venues a venue-less deposit can use on `network` for `symbol`
 * (capability index), ranked by tier (core, curated, extended, testnet), then
 * registry order; at most `limit`. The first is the suggestion. Ether counts
 * as WETH (EVM venues take the wrapped token).
 */
export function rankedVenueOptions(network: NetworkKey, kind: "deposit" | "withdraw", symbol: string, limit = 4): YieldVenue[] {
  const rank = (tier: ProtocolTier) => TIER_ORDER.indexOf(tier);
  const rows = capabilityIndex(network, kind)
    .filter((row) => row.asset !== null && venueMatches(row.asset, symbol) && row.venueId !== undefined)
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.tier) - rank(b.row.tier) || a.index - b.index);
  const seen = new Set<string>();
  const out: YieldVenue[] = [];
  for (const { row } of rows) {
    if (seen.has(row.protocol)) continue;
    const venue = YIELD_VENUES.find((entry) => entry.id === row.venueId);
    if (!venue) continue;
    seen.add(row.protocol);
    out.push(venue);
    if (out.length >= limit) break;
  }
  return out;
}

const TIER_ORDER: readonly ProtocolTier[] = ["core", "curated", "extended", "testnet"];

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

/**
 * Staking providers by id (core STAKE_PROVIDER_WORDS), with the grammar's
 * provider names. The hand-written set; `REGISTRY_STAKE_PROVIDERS` adds the
 * venues the registry names, and every lookup reads both.
 */
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

/**
 * Staking providers the registry adds through descriptor words:
 * the generated EVM liquid staking venues (Stader, Mantle LSP, Frax Ether;
 * grammar EVM_STAKING_TOKENS) and native SOL staking. A word the grammar
 * reads must never fall back to the default provider: "stake 1 ETH with
 * stader" is Stader, not Lido.
 */
export const REGISTRY_STAKE_PROVIDERS: readonly StakeProvider[] = (() => {
  const known = new Set(STAKE_PROVIDERS.map((provider) => provider.id));
  const out = new Map<string, StakeProvider>();
  for (const [word, entry] of Object.entries(EVM_STAKING_TOKENS)) {
    if (known.has(entry.protocol) || out.has(entry.protocol)) continue;
    out.set(entry.protocol, {
      id: entry.protocol,
      word,
      symbol: entry.symbol,
      label: `${entry.provider} (${entry.symbol})`,
      network: EVM_STAKING_NETWORK,
      input: "ETH",
      grammarProvider: entry.provider,
    });
  }
  const [nativeWord] = NATIVE_STAKE_WORDS;
  if (nativeWord && !known.has(NATIVE_STAKE_PROTOCOL)) {
    out.set(NATIVE_STAKE_PROTOCOL, {
      id: NATIVE_STAKE_PROTOCOL,
      word: nativeWord,
      symbol: CHAINS.solana.nativeAsset.symbol,
      label: "Native staking (stake account)",
      network: "solana",
      input: "SOL",
      grammarProvider: NATIVE_STAKE_PROVIDER,
    });
  }
  return [...out.values()];
})();

export function stakeProvider(id: string | undefined): StakeProvider | undefined {
  return STAKE_PROVIDERS.find((provider) => provider.id === id) ?? REGISTRY_STAKE_PROVIDERS.find((provider) => provider.id === id);
}

/** The provider a staking word names (jito, marinade, lido, "rocket pool", stader, "native stake", ...). */
export function providerFromWord(word: string): StakeProvider | undefined {
  const spaced = word.toLowerCase().replace(/[\s-]+/gu, " ");
  const entry = STAKE_PROVIDER_WORDS[spaced] ??
    STAKE_PROVIDER_WORDS[word.toLowerCase().replace(/[\s-]+/gu, "")] ??
    (word.toLowerCase() === "jupiter" ? { provider: "jupiter" } : undefined);
  if (entry) return stakeProvider(entry.provider);
  const evm = EVM_STAKING_TOKENS[spaced];
  if (evm) return stakeProvider(evm.protocol);
  return NATIVE_STAKE_WORDS.includes(spaced) ? stakeProvider(NATIVE_STAKE_PROTOCOL) : undefined;
}

/* -------------------------------------------- staking ETH off Ethereum */

/**
 * The options of "stake ETH" on an EVM network without staking: buy each
 * listed liquid staking token there at market (a swap, titled "Buy", never
 * "Stake"), or bridge to Ethereum and stake with the default provider (two
 * steps). Empty on Ethereum and where no alternative exists. Option ids
 * are stable: `buy:<symbol>`, `bridge-stake`.
 */
export interface L2StakeOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly actions: readonly { readonly kind: "swap" | "bridge" | "stake"; readonly network: NetworkKey; readonly from: string; readonly to?: string; readonly toNetwork?: NetworkKey; readonly provider?: string }[];
}

export function l2StakeOptions(network: NetworkKey): L2StakeOption[] {
  const alternatives = l2StakeAlternatives(network);
  if (!alternatives) return [];
  const options: L2StakeOption[] = alternatives.tokens.map((symbol) => ({
    id: `buy:${symbol}`,
    label: `Buy ${symbol} on ${networkName(network)}`,
    detail: "At market through a swap venue; the price guard checks the rate.",
    actions: [{ kind: "swap", network, from: alternatives.etherSymbol, to: symbol }],
  }));
  if (alternatives.etherSymbol.toUpperCase() === "ETH") {
    const lido = defaultProvider("ETH");
    options.push({
      id: "bridge-stake",
      label: `Bridge to ${networkName(EVM_STAKING_NETWORK)}, stake with ${lido.grammarProvider}`,
      detail: `Two steps: a bridge, then ${lido.grammarProvider} mints ${lido.symbol} at the protocol rate.`,
      actions: [
        { kind: "bridge", network, from: "ETH", toNetwork: EVM_STAKING_NETWORK },
        { kind: "stake", network: EVM_STAKING_NETWORK, from: "ETH", to: lido.symbol, provider: lido.id },
      ],
    });
  }
  return options;
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
