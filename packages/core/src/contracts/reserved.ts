/**
 * Phrases and integrator names a registration may not claim, and the
 * tokens that need an approval reset.
 */
import {
  CHAINS,
  NETWORK_KEYS,
  resolveChain,
  type NetworkKey,
} from "../chains.js";
import { ASSETS } from "../assets.js";
import { PROTOCOLS } from "../protocols.js";

/* =========================================================== reserved words */

/** Brand-unique venue words: refused anywhere in an alias. */
const VENUE_WORDS: readonly string[] = [
  "aave", "compound", "comet", "morpho", "moonwell", "jupiter", "jup", "kamino", "lifi", "li.fi", "debridge", "dln",
  "relay", "jito", "marinade", "sanctum", "msol", "jitosol", "jupsol",
  // added 2026-10-14
  "velodrome", "raydium", "meteora", "sparklend", "etherfi", "wsteth", "steth", "reth", "weeth", "eeth", "rocketpool",
  "yearn", "uniswap", "aerodrome",
  // added 2026-10-15: brand-unique words of the new venues
  "pancakeswap", "camelot", "stader", "ethx", "sfrxeth", "frxeth",
  // added 2026-10-23: brand-unique words of the new venues
  "ethena", "susde", "susds", "sdai", "kelp", "rseth", "renzo", "ezeth",
];
/**
 * Venue phrases and common English venue words: refused as a whole alias
 * only, so existing aliases such as "fluid vault" keep working.
 */
const VENUE_PHRASES: readonly string[] = [
  "aave v3", "aavev3", "compound v3", "compoundv3", "morpho vault", "morpho vaults", "jupiter lend", "jupiter earn",
  "jup lend", "jup earn", "kamino lend", "debridge dln", "cctp", "across",
  // added 2026-10-14
  "fluid", "spark", "orca", "lido", "pyth", "chainlink", "velo", "uni", "aero", "whirlpool", "whirlpools",
  "uniswap v3", "spark savings", "spark lend", "fluid lend", "fluid lending", "yearn v3", "rocket pool", "ether.fi",
  "susdc", "spusdc", "speth", "cctp v2",
];
const NETWORK_WORDS: readonly string[] = [
  "base", "arbitrum", "arb", "ethereum", "optimism", "op", "polygon", "matic", "arc", "solana", "sol", "devnet",
  "mainnet-beta", "sepolia", "mainnet", "testnet",
];
/** Grammar connectors and articles: refused anywhere in an alias. */
export const CONNECTOR_WORDS: readonly string[] = [
  "to", "for", "into", "onto", "with", "using", "from", "on", "as", "via", "in", "at", "then", "and", "after", "the", "my", "of",
];
/** Grammar amount and target words: refused as a whole alias. */
export const KEYWORD_PHRASES: readonly string[] = [
  "all", "max", "everything", "it", "them", "that", "half", "quarter", "a quarter", "a", "vault", "vaults", "pool", "contract",
  "program", "position", "output", "proceeds",
];

function phraseVariants(value: string): string[] {
  const lower = value.trim().toLowerCase().replace(/\s+/gu, " ");
  return [...new Set([lower, lower.replace(/ /gu, "-"), lower.replace(/-/gu, " ")])];
}

const RESERVED_WHOLE = new Set<string>(
  [
    "kletia",
    ...VENUE_WORDS,
    ...VENUE_PHRASES,
    ...NETWORK_WORDS,
    ...CONNECTOR_WORDS,
    ...KEYWORD_PHRASES,
    ...NETWORK_KEYS,
    ...Object.values(CHAINS).flatMap((chain) => [chain.name, chain.shortName]),
    ...ASSETS.map((asset) => asset.symbol),
    ...PROTOCOLS.flatMap((protocol) => [protocol.id, protocol.name, ...(protocol.words ?? [])]),
    ...ASSETS.flatMap((asset) => asset.aliases ?? []),
    "solana mainnet", "solana devnet", "arbitrum one", "arbitrum sepolia", "arb sepolia", "arc testnet", "base mainnet",
    "ethereum mainnet", "op mainnet", "optimism mainnet", "polygon pos", "polygon mainnet",
  ].flatMap(phraseVariants),
);
const RESERVED_TOKENS = new Set<string>(["kletia", ...VENUE_WORDS, ...NETWORK_WORDS, ...CONNECTOR_WORDS]);

/**
 * Words and phrases an alias may not be (lower-case): network names and
 * aliases, registry asset symbols, built-in venue words, protocol ids and
 * names, `kletia` and grammar keywords. The grammar's venue words must stay a
 * subset of this list (drift test in the engine).
 */
export const RESERVED_CONTRACT_PHRASES: readonly string[] = Object.freeze([...RESERVED_WHOLE].sort());

/**
 * The reserved word or phrase an alias collides with, or null. An alias may
 * not equal a reserved phrase (or name a network), and may not contain a
 * venue word, a network word, `kletia` or a grammar connector as one of its
 * space- or hyphen-separated words.
 */
export function reservedContractPhrase(alias: string): string | null {
  const lower = alias.trim().toLowerCase().replace(/\s+/gu, " ");
  for (const variant of phraseVariants(lower)) if (RESERVED_WHOLE.has(variant)) return variant;
  if (resolveChain(lower) !== null) return lower;
  for (const token of lower.split(/[\s-]+/u)) if (RESERVED_TOKENS.has(token)) return token;
  return null;
}

/**
 * Reserved integrator brand words and the website hosts allowed to use them.
 * `substring`: anywhere in the name ("TheKletiaFund"); `prefix`: at the start
 * of a word ("AaveYield", not "Polymorphic"); `word`: a whole word only (common
 * English words such as "Relay" or "Across").
 */
export const RESERVED_INTEGRATOR_NAMES: readonly {
  readonly word: string;
  readonly hosts: readonly string[];
  readonly match: "substring" | "prefix" | "word";
}[] = Object.freeze([
  { word: "kletia", hosts: ["kletiaai.xyz"], match: "substring" },
  { word: "uniswap", hosts: ["uniswap.org"], match: "substring" },
  { word: "aerodrome", hosts: ["aerodrome.finance"], match: "prefix" },
  { word: "aave", hosts: ["aave.com"], match: "prefix" },
  { word: "compound", hosts: ["compound.finance"], match: "word" },
  { word: "moonwell", hosts: ["moonwell.fi"], match: "substring" },
  { word: "morpho", hosts: ["morpho.org"], match: "prefix" },
  { word: "basenames", hosts: ["base.org"], match: "substring" },
  { word: "ens", hosts: ["ens.domains"], match: "word" },
  { word: "x402", hosts: ["x402.org"], match: "prefix" },
  { word: "across", hosts: ["across.to"], match: "word" },
  { word: "cctp", hosts: ["circle.com"], match: "prefix" },
  { word: "circle", hosts: ["circle.com"], match: "word" },
  { word: "relay", hosts: ["relay.link"], match: "word" },
  { word: "lifi", hosts: ["li.fi"], match: "word" },
  { word: "debridge", hosts: ["debridge.finance"], match: "substring" },
  { word: "jupiter", hosts: ["jup.ag"], match: "substring" },
  { word: "kamino", hosts: ["kamino.finance"], match: "substring" },
  { word: "jito", hosts: ["jito.network"], match: "prefix" },
  { word: "marinade", hosts: ["marinade.finance"], match: "prefix" },
  { word: "sanctum", hosts: ["sanctum.so"], match: "prefix" },
  { word: "webacy", hosts: ["webacy.com"], match: "substring" },
  { word: "allora", hosts: ["allora.network"], match: "prefix" },
  // added 2026-10-14
  { word: "velodrome", hosts: ["velodrome.finance"], match: "prefix" },
  { word: "raydium", hosts: ["raydium.io"], match: "substring" },
  { word: "orca", hosts: ["orca.so"], match: "word" },
  { word: "meteora", hosts: ["meteora.ag"], match: "prefix" },
  { word: "lido", hosts: ["lido.fi"], match: "word" },
  { word: "rocketpool", hosts: ["rocketpool.net"], match: "substring" },
  { word: "etherfi", hosts: ["ether.fi"], match: "prefix" },
  { word: "sparklend", hosts: ["spark.fi"], match: "substring" },
  { word: "spark", hosts: ["spark.fi"], match: "word" },
  { word: "fluid", hosts: ["fluid.io", "instadapp.io"], match: "word" },
  { word: "yearn", hosts: ["yearn.fi"], match: "word" },
  { word: "chainlink", hosts: ["chain.link"], match: "substring" },
  { word: "pyth", hosts: ["pyth.network"], match: "word" },
  // added 2026-10-15
  { word: "pancakeswap", hosts: ["pancakeswap.finance"], match: "substring" },
  { word: "camelot", hosts: ["camelot.exchange"], match: "word" },
  { word: "curve", hosts: ["curve.fi", "curve.finance"], match: "word" },
  { word: "stader", hosts: ["staderlabs.com"], match: "prefix" },
  { word: "mantle", hosts: ["mantle.xyz", "methprotocol.xyz"], match: "word" },
  { word: "frax", hosts: ["frax.finance", "frax.com"], match: "word" },
]);

/** The reserved brand an integrator name uses (see RESERVED_INTEGRATOR_NAMES), or null. */
export function reservedIntegratorName(name: string): { readonly word: string; readonly hosts: readonly string[] } | null {
  const lower = name.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/gu, "");
  const words = lower.split(/[^a-z0-9.]+/u).filter(Boolean).map((word) => word.replace(/\./gu, ""));
  for (const entry of RESERVED_INTEGRATOR_NAMES) {
    const hit =
      entry.match === "substring"
        ? compact.includes(entry.word)
        : entry.match === "prefix"
          ? words.some((word) => word.startsWith(entry.word))
          : words.includes(entry.word);
    if (hit) return { word: entry.word, hosts: entry.hosts };
  }
  return null;
}

/** True when `host` is one of `hosts` or a subdomain of one. */
export function hostMatches(host: string, hosts: readonly string[]): boolean {
  const lower = host.toLowerCase().replace(/^www\./u, "");
  return hosts.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`));
}

/* ===================================================== approval reset tokens */

/** Tokens whose `approve` reverts unless the allowance is 0 first (USDT-style). */
export const APPROVAL_RESET_TOKENS: readonly { readonly network: NetworkKey; readonly address: string; readonly symbol: string }[] = Object.freeze([
  { network: "ethereum", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT" },
]);

export function needsApprovalReset(network: NetworkKey, token: string): boolean {
  const wanted = token.toLowerCase();
  return APPROVAL_RESET_TOKENS.some((entry) => entry.network === network && entry.address.toLowerCase() === wanted);
}
