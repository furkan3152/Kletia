/**
 * Deterministic natural-language intent grammar. Text is split into clauses
 * and each clause must match exactly one known sentence shape; anything else
 * is refused with INTENT_UNSUPPORTED and example phrases. No model is
 * involved and nothing is guessed: when a network cannot be inferred from
 * the text, the previous clause, `defaultNetwork` or the caller's accounts,
 * the clause is refused.
 */
import {
  CHAINS,
  findAssetByAddress,
  findAssetBySymbol,
  getProtocol,
  isEvmAddress,
  isSolanaAddress,
  MAX_INTENT_ACTIONS,
  parseAccountId,
  PROTOCOLS,
  resolveChain,
  venueContracts,
  YIELD_VENUES,
  type AccountId,
  type IntentActionKind,
  type IntentActionSpec,
  type NetworkKey,
  type ProtocolDescriptor,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError, unsupported, type PlatformIssue } from "../errors.js";
import type { ContractPhrase } from "./contracts/directory.js";

export const GRAMMAR_EXAMPLES: readonly string[] = Object.freeze([
  "swap 1 SOL to USDC",
  "swap 0.01 ETH for USDC on base",
  "buy JitoSOL with 2 SOL",
  "stake 1.5 SOL with marinade",
  "send 5 USDC to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "send 0.001 ETH to 0x000000000000000000000000000000000000dEaD on arbitrum",
  "bridge 25 USDC from base to solana",
  "bridge 100 USDC from solana to arbitrum",
  "move 0.01 ETH from arbitrum to solana as SOL",
  "bridge 50 USDC from base to solana then swap half to JitoSOL",
  "bridge 20 USDC from solana to base and deposit it into aave",
  "swap 10 USDC to SOL on solana, then stake it with jito",
  "deposit 100 USDC into morpho on base",
  "withdraw 50 USDC from aave on base",
  "withdraw all USDC from compound on arbitrum",
  "deposit 10 USDC into jupiter lend",
  "bridge 25 USDC from base to solana via lifi",
  "bridge 100 USDC from ethereum to base",
  "send 5 USDC to vitalik.eth on optimism",
  "swap 1 SOL to USDC via raydium",
  "swap 10 USDC to SOL on solana via orca",
  "swap 1 SOL to USDC via meteora",
  "swap 100 USDC to ETH on ethereum",
  "stake 1 ETH with lido",
  "deposit 100 USDC into sparklend on ethereum",
  "deposit 100 USDC into spark savings on base",
  "deposit 100 USDC into yearn on ethereum",
  "bridge 100 USDC from base to arbitrum via across",
]);

/** A venue word pattern and the protocol it names. */
export interface VenueWord {
  readonly pattern: RegExp;
  readonly protocol: ProtocolId;
}

/* -------------------------------------------- venue words from the registry */

/**
 * Venue words of registry protocols the hand-written lists below do not
 * cover yet (protocols design 3.0): generated from descriptor `words`, so a
 * new venue needs no grammar edit. The hand-written patterns stay as they
 * are (no behaviour change for existing venues); a generated word only adds
 * a reading, and a protocol without a live adapter is refused by the planner
 * as before.
 */
function escapeWord(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Regex alternation of words (longest first, spaces and hyphens interchangeable). */
function wordAlternation(words: readonly string[]): string {
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((word) => word.trim().toLowerCase().split(/[\s-]+/u).map(escapeWord).join("[\\s-]+"))
    .join("|");
}

function generatedVenueWords(covered: readonly ProtocolId[], select: (protocol: ProtocolDescriptor) => boolean): VenueWord[] {
  return PROTOCOLS
    .filter((protocol) => !covered.includes(protocol.id) && (protocol.words ?? []).length > 0 && select(protocol))
    .map((protocol) => ({ pattern: new RegExp(`^(?:${wordAlternation(protocol.words ?? [])})$`, "iu"), protocol: protocol.id }));
}

/** Lending and savings venue words -> protocol (bare "spark" is Spark Savings, with a warning naming SparkLend). */
export const LENDING_VENUES: readonly VenueWord[] = Object.freeze([
  { pattern: /^aave(?:[\s-]*v3)?$/iu, protocol: "aave-v3" },
  { pattern: /^(?:compound(?:[\s-]*v3)?|comet)$/iu, protocol: "compound-v3" },
  { pattern: /^morpho(?:[\s-]+vaults?)?$/iu, protocol: "morpho" },
  { pattern: /^moonwell$/iu, protocol: "moonwell" },
  { pattern: /^(?:jupiter|jup)[\s-]+(?:lend|earn)$/iu, protocol: "jupiter-lend" },
  { pattern: /^kamino(?:[\s-]+lend)?$/iu, protocol: "kamino" },
  { pattern: /^spark[\s-]*lend$/iu, protocol: "sparklend" },
  { pattern: /^spark(?:[\s-]+savings)?$/iu, protocol: "spark-savings" },
  { pattern: /^fluid(?:[\s-]+(?:lend|lending))?$/iu, protocol: "fluid" },
  { pattern: /^yearn(?:[\s-]+v3)?$/iu, protocol: "yearn-v3" },
]);
export const LENDING_WORDS =
  "aave(?:[\\s-]*v3)?|compound(?:[\\s-]*v3)?|comet|morpho(?:[\\s-]+vaults?)?|moonwell|(?:jupiter|jup)[\\s-]+(?:lend|earn)|kamino(?:[\\s-]+lend)?|" +
  "spark[\\s-]*lend|spark(?:[\\s-]+savings)?|fluid(?:[\\s-]+(?:lending|lend))?|yearn(?:[\\s-]+v3)?";
/** Lending protocols whose venues may be named by vault slug ("into morpho spark-usdc", "into yearn usdc-1", "into spark spusdc"). */
const VAULT_PROTOCOLS: readonly ProtocolId[] = ["morpho", "spark-savings", "yearn-v3"];

/** Cross-network venue words -> protocol ("bridge ... via lifi"). */
export const BRIDGE_VENUES: readonly VenueWord[] = Object.freeze([
  { pattern: /^(?:li\.?fi)$/iu, protocol: "lifi" },
  { pattern: /^(?:debridge(?:[\s-]+dln)?|dln)$/iu, protocol: "debridge-dln" },
  { pattern: /^relay$/iu, protocol: "relay" },
  { pattern: /^across$/iu, protocol: "across" },
  { pattern: /^cctp(?:[\s-]*v2)?$/iu, protocol: "cctp-v2" },
]);
export const BRIDGE_WORDS = "li\\.?fi|debridge(?:[\\s-]+dln)?|dln|relay|across|cctp(?:[\\s-]*v2)?";

const BUILTIN_SWAP_VENUES: readonly VenueWord[] = [
  { pattern: /^(?:jupiter|jup)$/iu, protocol: "jupiter" },
  { pattern: /^raydium$/iu, protocol: "raydium" },
  { pattern: /^orca$/iu, protocol: "orca" },
  { pattern: /^meteora$/iu, protocol: "meteora" },
  { pattern: /^uniswap(?:[\s-]+v3)?$/iu, protocol: "uniswap-v3" },
  { pattern: /^aerodrome$/iu, protocol: "aerodrome" },
  { pattern: /^velodrome$/iu, protocol: "velodrome" },
];
/** Registry DEX protocols with words and no hand-written pattern (round 7: PancakeSwap V3, Camelot, Curve). */
const GENERATED_SWAP_PROTOCOLS: readonly ProtocolDescriptor[] = PROTOCOLS.filter((protocol) =>
  protocol.category === "dex" && (protocol.kinds ?? []).includes("swap") && (protocol.words ?? []).length > 0 &&
  !BUILTIN_SWAP_VENUES.some((venue) => venue.protocol === protocol.id));
/** Same-network swap venue words -> protocol ("swap ... via orca"). */
export const SWAP_VENUES: readonly VenueWord[] = Object.freeze([
  ...BUILTIN_SWAP_VENUES,
  ...generatedVenueWords(BUILTIN_SWAP_VENUES.map((venue) => venue.protocol), (protocol) => GENERATED_SWAP_PROTOCOLS.includes(protocol)),
]);
export const SWAP_VENUE_WORDS = [
  "jupiter|jup|raydium|orca|meteora|uniswap(?:[\\s-]+v3)?|aerodrome|velodrome",
  ...(GENERATED_SWAP_PROTOCOLS.length > 0 ? [wordAlternation(GENERATED_SWAP_PROTOCOLS.flatMap((protocol) => protocol.words ?? []))] : []),
].join("|");

/** Liquid staking targets reachable through Jupiter routes. */
export const LIQUID_STAKING_TOKENS: Readonly<Record<string, { symbol: string; provider: string }>> = Object.freeze({
  jito: { symbol: "JitoSOL", provider: "Jito" },
  jitosol: { symbol: "JitoSOL", provider: "Jito" },
  marinade: { symbol: "mSOL", provider: "Marinade" },
  msol: { symbol: "mSOL", provider: "Marinade" },
  jupiter: { symbol: "JupSOL", provider: "Jupiter" },
  jupsol: { symbol: "JupSOL", provider: "Jupiter" },
  sanctum: { symbol: "JupSOL", provider: "Jupiter" },
});

/** EVM liquid staking on Ethereum: the staking word -> the token it mints and its protocol. */
export const EVM_STAKING_TOKENS: Readonly<Record<string, { symbol: string; provider: string; protocol: ProtocolId }>> = Object.freeze({
  lido: { symbol: "wstETH", provider: "Lido", protocol: "lido" },
  steth: { symbol: "wstETH", provider: "Lido", protocol: "lido" },
  wsteth: { symbol: "wstETH", provider: "Lido", protocol: "lido" },
  "rocket pool": { symbol: "rETH", provider: "Rocket Pool", protocol: "rocket-pool" },
  rocketpool: { symbol: "rETH", provider: "Rocket Pool", protocol: "rocket-pool" },
  reth: { symbol: "rETH", provider: "Rocket Pool", protocol: "rocket-pool" },
  "ether.fi": { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  etherfi: { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  weeth: { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  eeth: { symbol: "weETH", provider: "ether.fi", protocol: "etherfi" },
  // Round 7: generated from the registry (descriptor words; the token is the protocol's pinned lst-token).
  ...Object.fromEntries(generatedEvmStaking().map((entry) => [entry.word, { symbol: entry.symbol, provider: entry.provider, protocol: entry.protocol }])),
});
/** Words of the generated EVM staking entries (also stake-sentence LST words). */
const GENERATED_EVM_STAKING_WORDS: readonly string[] = generatedEvmStaking().map((entry) => entry.word);
/** The network EVM liquid staking runs on. */
export const EVM_STAKING_NETWORK: NetworkKey = "ethereum";

/**
 * Ethereum liquid-staking protocols with words and no hand-written entry
 * (round 7: Stader, Mantle LSP, Frax Ether): each word -> the asset of the
 * protocol's pinned `lst-token` on Ethereum. A protocol without that pin, or
 * whose token is not a registry asset, gets no words (nothing to mint).
 */
function generatedEvmStaking(): { word: string; symbol: string; provider: string; protocol: ProtocolId }[] {
  const handWritten: readonly ProtocolId[] = ["lido", "rocket-pool", "etherfi"];
  return PROTOCOLS.flatMap((protocol) => {
    if (protocol.category !== "liquid-staking" || handWritten.includes(protocol.id) || !protocol.networks.includes("ethereum")) return [];
    const [token] = venueContracts(protocol.id, "ethereum", "lst-token");
    const asset = token ? findAssetByAddress("ethereum", token) : null;
    if (!asset) return [];
    return (protocol.words ?? []).map((word) => ({
      word: word.trim().toLowerCase().replace(/[\s-]+/gu, " "),
      symbol: asset.symbol,
      provider: protocol.name,
      protocol: protocol.id,
    }));
  });
}

function evmStakingToken(word: string | undefined) {
  if (!word) return undefined;
  return EVM_STAKING_TOKENS[word.toLowerCase().replace(/[\s-]+/gu, " ")];
}

/**
 * Every venue word and phrase the built-in sentences recognise (lending,
 * bridge, swap and liquid-staking venues). Contract aliases may never use
 * them: the engine's drift test checks each is in @kletia/core
 * RESERVED_CONTRACT_PHRASES and still matches the patterns above.
 */
export const GRAMMAR_VENUE_WORDS: readonly string[] = Object.freeze([
  "aave", "aave v3", "aavev3", "aave-v3",
  "compound", "compound v3", "compoundv3", "compound-v3", "comet",
  "morpho", "morpho vault", "morpho vaults",
  "moonwell",
  "jupiter lend", "jupiter earn", "jup lend", "jup earn",
  "kamino", "kamino lend",
  "sparklend", "spark lend", "spark-lend", "spark", "spark savings", "spark-savings",
  "fluid", "fluid lend", "fluid lending",
  "yearn", "yearn v3", "yearn-v3",
  "lifi", "li.fi", "debridge", "debridge dln", "dln", "relay", "across", "cctp", "cctp v2",
  "jup", "raydium", "orca", "meteora", "uniswap", "uniswap v3", "aerodrome", "velodrome",
  ...Object.keys(LIQUID_STAKING_TOKENS),
  ...Object.keys(EVM_STAKING_TOKENS),
  // Round 7: generated swap venue words (generated staking words are EVM_STAKING_TOKENS keys above).
  ...GENERATED_SWAP_PROTOCOLS.flatMap((protocol) => (protocol.words ?? []).map((word) => word.toLowerCase())),
]);

/** True when `word` is a venue the built-in patterns match (drift test). */
export function isGrammarVenueWord(word: string): boolean {
  return [...LENDING_VENUES, ...BRIDGE_VENUES, ...SWAP_VENUES].some((venue) => venue.pattern.test(word)) ||
    Object.hasOwn(LIQUID_STAKING_TOKENS, word.toLowerCase()) || evmStakingToken(word) !== undefined;
}

export interface GrammarContext {
  readonly defaultNetwork?: NetworkKey;
  readonly accounts?: readonly AccountId[];
  /**
   * Phrases of the contract registrations the caller's API key may use: a
   * clause naming one of their aliases with one of their verbs becomes a
   * `call` / `action` step (tried before the built-in sentences).
   */
  readonly contracts?: readonly ContractPhrase[];
}

export interface GrammarResult {
  readonly actions: IntentActionSpec[];
  readonly normalizedText: string;
  readonly clauses: readonly string[];
  readonly confidence: number;
  /** Per action: true when its clause named the network or the source ("on base", "from base", a CAIP-10 recipient). */
  readonly explicitNetwork: readonly boolean[];
  /** Readings the user should know about (e.g. bare "spark" read as Spark Savings). */
  readonly warnings: readonly string[];
}

/**
 * A bridge clause without a source and nothing to infer it from. Same code
 * (INTENT_UNSUPPORTED), message, hints and issues as every other clause
 * refusal; the planner's departure step (`sourceNetwork: "auto"`) reads
 * `missing` to choose a funded source instead.
 */
export class MissingSourceError extends PlatformError {
  readonly missing: { readonly asset: string | null; readonly amount: string | null; readonly toNetwork: NetworkKey };

  constructor(message: string, issues: readonly PlatformIssue[], missing: MissingSourceError["missing"]) {
    super("INTENT_UNSUPPORTED", message, 422, issues, GRAMMAR_EXAMPLES);
    this.missing = missing;
  }
}

type AmountPhrase =
  | { readonly type: "exact"; readonly value: string; readonly usd: boolean }
  /** `whole`: said as "all" / "max" / "everything" (a withdraw then closes the position). */
  | { readonly type: "previous"; readonly portionBps: number; readonly whole?: boolean };

interface Draft {
  readonly clause: string;
  readonly kind: IntentActionKind;
  readonly amount: AmountPhrase;
  readonly from?: string;
  readonly to?: string;
  readonly network?: NetworkKey;
  readonly toNetwork?: NetworkKey;
  readonly recipient?: string;
  readonly lst?: string;
  readonly protocol?: ProtocolId;
  /** Vault slug named in the clause (Morpho, Spark Savings, Yearn). */
  readonly venue?: string;
  /** True when the clause named its network or source. */
  readonly explicit: boolean;
  readonly warnings?: readonly string[];
}

/** Verbs that start a built-in sentence. */
export const VERBS: readonly string[] = Object.freeze([
  "swap", "convert", "trade", "exchange", "sell", "buy", "bridge", "move", "send", "transfer", "pay", "port",
  "stake", "deposit", "supply", "lend", "withdraw", "redeem",
]);

export const AMOUNT =
  "(?<amt>\\d{1,3}(?:\\.\\d{1,2})?%|\\$\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+|all|max|everything|it|them|that|half|a\\s+quarter|quarter)" +
  "(?:\\s+of\\s+(?:it|them|that|the\\s+output|the\\s+proceeds))?";
export const KEYWORD_GUARD = "(?!(?:to|for|into|onto|with|using|from|on|as|via|in|at)\\b)";
export const ASSET = (name: string): string => `${KEYWORD_GUARD}(?<${name}>(?:eip155|solana):\\S+|[A-Za-z0-9$][\\w.\\-]{0,63})`;
export const NETWORK_WORDS =
  "arbitrum[\\s-]+sepolia|arb[\\s-]+sepolia|solana[\\s-]+devnet|solana[\\s-]+mainnet|arbitrum[\\s-]+one|arc[\\s-]+testnet|base[\\s-]+mainnet|" +
  "ethereum[\\s-]+mainnet|op[\\s-]+mainnet|optimism[\\s-]+mainnet|polygon[\\s-]+pos|polygon[\\s-]+mainnet|mainnet-beta|" +
  "base|arbitrum|arb|arc|solana|sol|devnet|ethereum|optimism|polygon|matic|op";
export const NETWORK = (name: string): string => `(?<${name}>${NETWORK_WORDS})`;
export const ON_NETWORK = `(?:\\s+(?:on|in|via)\\s+${NETWORK("net")})`;
/** Recipient names resolved through the name hook (ENS, Basenames, SNS). */
export const NAME = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.(?:eth|sns|sol)";
export const ADDRESS = `(?<addr>0x[0-9a-fA-F]{40}|(?:eip155|solana):\\S+|${NAME}|[1-9A-HJ-NP-Za-km-z]{32,44})`;
/** A vault slug after the venue word ("into morpho spark-usdc"); never a connector or "vault" itself. */
export const VAULT = "(?!(?:to|for|into|onto|with|using|from|on|as|via|in|at|vault|vaults|position)\\b)(?<vault>[a-z0-9][a-z0-9-]{2,63})";
/** Solana and EVM liquid staking words. */
export const LST_WORDS = [
  ...Object.keys(LIQUID_STAKING_TOKENS),
  "lido", "wsteth", "steth", "rocket[\\s-]*pool", "reth", "ether\\.?fi", "weeth", "eeth",
  ...(GENERATED_EVM_STAKING_WORDS.length > 0 ? [wordAlternation(GENERATED_EVM_STAKING_WORDS)] : []),
].join("|");
/** "via raydium", "using orca", "through uniswap" after a swap. */
const SWAP_VENUE_SUFFIX = `(?:\\s+(?:via|using|through|with)\\s+(?<dex>${SWAP_VENUE_WORDS}))`;
/** A swap names its network and venue in either order. */
const SWAP_SUFFIXES = [`${ON_NETWORK}?${SWAP_VENUE_SUFFIX}?`, `${SWAP_VENUE_SUFFIX}${ON_NETWORK}?`];

/**
 * The building blocks of the built-in sentences (exported for the clarify
 * layer, which reads the same shapes without refusing).
 */
export const SENTENCE_FRAGMENTS = Object.freeze({
  AMOUNT,
  KEYWORD_GUARD,
  NETWORK_WORDS,
  ON_NETWORK,
  NAME,
  ADDRESS,
  VAULT,
  LENDING_WORDS,
  BRIDGE_WORDS,
  SWAP_VENUE_WORDS,
  LST_WORDS,
});

const PATTERNS: readonly { kind: IntentActionKind | "buy" | "bridge-or-transfer"; regex: RegExp }[] = [
  ...SWAP_SUFFIXES.flatMap((suffix) => [
    {
      kind: "swap" as const,
      regex: new RegExp(
        `^(?:swap|convert|trade|exchange|sell)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?\\s+(?:to|for|into)\\s+${ASSET("b")}${suffix}$`,
        "iu",
      ),
    },
    {
      kind: "buy" as const,
      regex: new RegExp(`^buy\\s+${ASSET("b")}\\s+(?:with|using)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?${suffix}$`, "iu"),
    },
  ]),
  {
    kind: "bridge",
    regex: new RegExp(
      `^(?:bridge|move|send|transfer|port)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?(?:\\s+from\\s+${NETWORK("n1")})?\\s+(?:to|into|onto)\\s+${NETWORK("n2")}(?:\\s+(?:as|into|for)\\s+${ASSET("b")})?` +
        `(?:\\s+(?:via|using|through|with|over)\\s+(?<bridge>${BRIDGE_WORDS}))?$`,
      "iu",
    ),
  },
  {
    kind: "transfer",
    regex: new RegExp(`^(?:send|transfer|pay)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?\\s+to\\s+${ADDRESS}${ON_NETWORK}?$`, "iu"),
  },
  {
    kind: "stake",
    regex: new RegExp(
      `^stake\\s+${AMOUNT}(?:\\s+(?<a>sol|eth))?(?:\\s+(?:with|via|on|using|into|to|as|at)\\s+(?<lst>${LST_WORDS}))?${ON_NETWORK}?$`,
      "iu",
    ),
  },
  {
    kind: "deposit",
    regex: new RegExp(
      `^(?:deposit|supply|lend)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?\\s+(?:into|to|on|in|at|with)\\s+(?:the\\s+)?(?<venue>${LENDING_WORDS})` +
        `(?:\\s+${VAULT})?(?:\\s+vault)?${ON_NETWORK}?$`,
      "iu",
    ),
  },
  {
    kind: "withdraw",
    regex: new RegExp(
      `^(?:withdraw|redeem)\\s+${AMOUNT}(?:\\s+(?:of\\s+)?(?:my\\s+)?${ASSET("a")})?\\s+(?:from|out\\s+of)\\s+(?:my\\s+)?(?:the\\s+)?(?<venue>${LENDING_WORDS})` +
        `(?:\\s+${VAULT})?(?:\\s+(?:vault|position))?${ON_NETWORK}?$`,
      "iu",
    ),
  },
];

/**
 * The text the grammar reads: arrows become " to ", quotes and trailing
 * punctuation go, polite prefixes ("please", "can you") and trailing
 * courtesies ("please", "thanks") are dropped.
 */
export function normalizeText(text: string): string {
  let value = text
    .replace(/[→➡]|->|=>/gu, " to ")
    .replace(/[“”"']/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  const prefix = /^(?:please|pls|kletia,?|i want to|i'?d like to|i would like to|can you|could you|let's|lets)\s+/iu;
  while (prefix.test(value)) value = value.replace(prefix, "");
  value = value.replace(/(?:,?\s+(?:please|pls|thanks|thank\s+you|thx))+$/iu, "").replace(/[,.!?]+$/u, "").trim();
  return value;
}

export function splitClauses(text: string, extraVerbs: readonly string[] = []): string[] {
  const verbs = [...VERBS, ...extraVerbs.filter((verb) => /^[a-z]{2,16}$/u.test(verb) && !VERBS.includes(verb))];
  const verbLookahead = `(?=(?:${verbs.join("|")})\\b)`;
  return text
    .split(/\s*;\s*|\s*,?\s+and\s+then\s+|\s*,\s*then\s+|\s+then\s+/iu)
    .flatMap((part) => part.split(new RegExp(`\\s*,?\\s+and\\s+${verbLookahead}|\\s*,\\s*${verbLookahead}`, "iu")))
    .map((part) => part.trim().replace(/^(?:and|also)\s+/iu, "").replace(/[,.]+$/u, "").trim())
    .filter((part) => part.length > 0);
}

export function resolveNetworkName(raw: string): NetworkKey | null {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  return resolveChain(value)?.key ?? resolveChain(value.replace(/ /gu, "-"))?.key ?? null;
}

function parseAmount(raw: string, clause: string): AmountPhrase {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  const percent = /^(\d{1,3}(?:\.\d{1,2})?)%$/u.exec(value);
  if (percent) {
    const bps = Math.round(Number(percent[1]) * 100);
    if (bps <= 0 || bps > 10_000) throw clauseError(clause, "A percentage must be between 0 and 100.");
    return { type: "previous", portionBps: bps };
  }
  if (value === "half") return { type: "previous", portionBps: 5_000 };
  if (value === "quarter" || value === "a quarter") return { type: "previous", portionBps: 2_500 };
  if (["all", "max", "everything"].includes(value)) return { type: "previous", portionBps: 10_000, whole: true };
  if (["it", "them", "that"].includes(value)) return { type: "previous", portionBps: 10_000 };
  const usd = value.startsWith("$");
  let numeric = value.replace(/^\$/u, "");
  if (numeric.includes(",")) {
    // Commas are accepted only as thousands separators ("1,250.5"). "1,5" (a decimal comma) is refused, never read as 15.
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(numeric)) {
      throw clauseError(clause, `"${raw}" is ambiguous; use a dot for decimals (e.g. "1.5").`);
    }
    numeric = numeric.replace(/,/gu, "");
  }
  if (numeric.startsWith(".")) numeric = `0${numeric}`;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(numeric) || /^0(?:\.0+)?$/u.test(numeric)) {
    throw clauseError(clause, `"${raw}" is not a positive amount.`);
  }
  return { type: "exact", value: numeric, usd };
}

function clauseMessage(clause: string, message: string): string {
  return `${message} (in "${clause.slice(0, 120)}")`;
}

function clauseError(clause: string, message: string): PlatformError {
  return unsupported(clauseMessage(clause, message), GRAMMAR_EXAMPLES, [{ path: "text", message }]);
}

function networkFromGroup(raw: string | undefined, clause: string): NetworkKey | undefined {
  if (!raw) return undefined;
  const network = resolveNetworkName(raw);
  if (!network) throw clauseError(clause, `Unknown network "${raw}".`);
  return network;
}

function venueProtocol(raw: string | undefined, venues: readonly VenueWord[], clause: string): ProtocolId {
  const value = (raw ?? "").trim();
  const entry = venues.find((candidate) => candidate.pattern.test(value));
  if (!entry) throw clauseError(clause, `Unknown venue "${value.slice(0, 32)}".`);
  return entry.protocol;
}

function protocolName(id: ProtocolId): string {
  return getProtocol(id)?.name ?? id;
}

function lendingDraft(clause: string, kind: "deposit" | "withdraw", groups: Record<string, string | undefined>, amount: AmountPhrase, network: NetworkKey | undefined): Draft {
  const protocol = venueProtocol(groups.venue, LENDING_VENUES, clause);
  const vault = groups.vault?.toLowerCase();
  if (vault && !VAULT_PROTOCOLS.includes(protocol)) {
    throw clauseError(clause, `Only Morpho, Spark Savings and Yearn vaults are named; say "${kind === "deposit" ? "into" : "from"} ${groups.venue ?? "the venue"}" without "${vault}".`);
  }
  // Bare "spark" names two protocols: the default (Spark Savings) is used and the alternative named.
  const bareSpark = protocol === "spark-savings" && /^spark$/iu.test((groups.venue ?? "").trim()) && !vault;
  return {
    clause,
    kind,
    amount,
    ...(groups.a ? { from: groups.a } : {}),
    protocol,
    ...(vault ? { venue: vault } : {}),
    ...(network ? { network } : {}),
    explicit: network !== undefined,
    ...(bareSpark ? { warnings: [`"spark" was read as Spark Savings; say "sparklend" to ${kind === "deposit" ? "lend on" : "withdraw from"} SparkLend instead.`] } : {}),
  };
}

function stakeDraft(clause: string, groups: Record<string, string | undefined>, amount: AmountPhrase, network: NetworkKey | undefined): Draft {
  const asset = groups.a?.toLowerCase();
  const word = groups.lst?.toLowerCase().replace(/[\s-]+/gu, " ");
  const evm = evmStakingToken(word);
  if (evm || asset === "eth") {
    if (asset === "sol") throw clauseError(clause, `${evm?.provider ?? "That provider"} stakes ETH on Ethereum, not SOL.`);
    if (word && !evm) throw clauseError(clause, `"${groups.lst}" stakes SOL on Solana, not ETH.`);
    return {
      clause,
      kind: "stake",
      amount,
      from: "ETH",
      lst: word ?? "lido",
      protocol: (evm ?? EVM_STAKING_TOKENS.lido)?.protocol as ProtocolId,
      ...(network ? { network } : {}),
      explicit: network !== undefined,
    };
  }
  return {
    clause,
    kind: "stake",
    amount,
    ...(asset ? { from: "SOL" } : {}),
    lst: word ?? "jito",
    ...(network ? { network } : {}),
    explicit: network !== undefined,
  };
}

function matchClause(clause: string): Draft {
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(clause);
    if (!match?.groups) continue;
    const groups = match.groups;
    const amount = parseAmount(groups.amt ?? "", clause);
    const network = networkFromGroup(groups.net, clause);
    switch (pattern.kind) {
      case "swap":
      case "buy":
        return {
          clause,
          kind: "swap",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.b ? { to: groups.b } : {}),
          ...(network ? { network } : {}),
          ...(groups.dex ? { protocol: venueProtocol(groups.dex, SWAP_VENUES, clause) } : {}),
          explicit: network !== undefined,
        };
      case "bridge": {
        const source = networkFromGroup(groups.n1, clause);
        const destination = networkFromGroup(groups.n2, clause);
        return {
          clause,
          kind: "bridge",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.b ? { to: groups.b } : {}),
          ...(source ? { network: source } : {}),
          ...(destination ? { toNetwork: destination } : {}),
          ...(groups.bridge ? { protocol: venueProtocol(groups.bridge, BRIDGE_VENUES, clause) } : {}),
          explicit: source !== undefined,
        };
      }
      case "transfer":
        return {
          clause,
          kind: "transfer",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.addr ? { recipient: groups.addr } : {}),
          ...(network ? { network } : {}),
          explicit: network !== undefined || (groups.addr ?? "").includes(":"),
        };
      case "stake":
        return stakeDraft(clause, groups, amount, network);
      case "deposit":
      case "withdraw":
        return lendingDraft(clause, pattern.kind, groups, amount, network);
      default:
        break;
    }
  }
  const verb = clause.split(/\s+/u)[0]?.toLowerCase() ?? "";
  const reason = VERBS.includes(verb)
    ? `"${clause.slice(0, 120)}" does not match a supported "${verb}" sentence.`
    : `"${verb.slice(0, 32)}" is not a supported action.`;
  throw unsupported(
    `${reason} Supported actions: swap, buy, bridge/move, send/transfer/pay, stake (SOL, or ETH on Ethereum), deposit/supply/lend into and withdraw from Aave, Compound, Morpho, Moonwell, SparkLend, Spark Savings, Fluid, Yearn V3, Jupiter Lend or Kamino.`,
    GRAMMAR_EXAMPLES,
    [{ path: "text", message: `Could not interpret "${clause.slice(0, 120)}".` }],
  );
}

/* ------------------------------------------------- contract clauses (BYOC) */

const CONTRACT_SUFFIX = "(?:\\s+(?:vault|pool|contract|program))?";
const CONTRACT_CONNECTOR = "(?:into|to|in|on|at|with|via|using|through|from|out\\s+of)";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+");
}

interface ContractMatcher {
  readonly regex: RegExp;
  readonly phrases: readonly ContractPhrase[];
}

/** One regex over every verb and alias the key's registrations declare (longest alternatives first). */
function contractMatcher(phrases: readonly ContractPhrase[]): ContractMatcher | null {
  const verbs = [...new Set(phrases.flatMap((phrase) => phrase.verbs))].filter((verb) => /^[a-z]{2,16}$/u.test(verb));
  const aliases = [...new Set(phrases.flatMap((phrase) => phrase.aliases))].filter((alias) => alias.length > 1);
  if (verbs.length === 0 || aliases.length === 0) return null;
  const byLength = (a: string, b: string) => b.length - a.length;
  const regex = new RegExp(
    `^(?<verb>${verbs.sort(byLength).map(escapeRegex).join("|")})\\s+` +
      `(?:${AMOUNT}(?:\\s+${ASSET("a")})?\\s+|(?:my\\s+)?(?<obj>[a-z][a-z0-9.-]{0,31})\\s+)?` +
      `${CONTRACT_CONNECTOR}\\s+(?:the\\s+|my\\s+)?(?<alias>${aliases.sort(byLength).map(escapeRegex).join("|")})${CONTRACT_SUFFIX}${ON_NETWORK}?$`,
    "iu",
  );
  return { regex, phrases };
}

/**
 * What a contract clause reads as: the action, a gap the user can fill (the
 * amount of a spending entry; the network of an alias registered on several
 * networks), or null when the clause names no registered alias.
 */
export type ContractPhraseMatch =
  | { readonly action: IntentActionSpec; readonly explicit: boolean }
  | { readonly gap: "amount"; readonly message: string }
  | { readonly gap: "network"; readonly networks: readonly NetworkKey[]; readonly message: string };

function matchWithMatcher(clause: string, matcher: ContractMatcher, previousDestination: NetworkKey | undefined, index: number): ContractPhraseMatch | null {
  const match = matcher.regex.exec(clause);
  if (!match?.groups) return null;
  const groups = match.groups;
  const verb = (groups.verb ?? "").toLowerCase();
  const alias = (groups.alias ?? "").toLowerCase().replace(/\s+/gu, " ");
  const network = networkFromGroup(groups.net, clause);
  const named = matcher.phrases.filter((phrase) => phrase.aliases.includes(alias));
  const byVerb = named.filter((phrase) => phrase.verbs.includes(verb));
  if (byVerb.length === 0) {
    const verbs = [...new Set(named.flatMap((phrase) => phrase.verbs))];
    throw clauseError(clause, `"${alias}" accepts ${verbs.map((entry) => `"${entry}"`).join(", ")}, not "${verb}".`);
  }
  let candidates = network ? byVerb.filter((phrase) => phrase.network === network) : byVerb;
  if (candidates.length === 0) {
    throw clauseError(clause, `"${alias}" is registered on ${[...new Set(byVerb.map((phrase) => CHAINS[phrase.network].name))].join(", ")}, not ${CHAINS[network as NetworkKey].name}.`);
  }
  const distinct = (list: readonly ContractPhrase[]) => new Set(list.map((phrase) => `${phrase.contract}#${phrase.entry}`)).size;
  if (distinct(candidates) > 1 && previousDestination) {
    const onPrevious = candidates.filter((phrase) => phrase.network === previousDestination);
    if (onPrevious.length > 0) candidates = onPrevious;
  }
  if (distinct(candidates) > 1) {
    const networks = [...new Set(candidates.map((phrase) => phrase.network))];
    return {
      gap: "network",
      networks,
      message: `"${alias}" names several registered actions (${networks.map((entry) => CHAINS[entry].name).join(", ")}); add "on <network>".`,
    };
  }
  const phrase = candidates[0] as ContractPhrase;
  const raw = groups.amt;
  let amount: AmountPhrase | null = raw ? parseAmount(raw, clause) : null;
  if (!phrase.spends) {
    if (amount) throw clauseError(clause, `"${verb} … ${alias}" spends nothing; leave out the amount.`);
  } else if (!amount) {
    return { gap: "amount", message: `Say how much to ${verb}, e.g. "${verb} 100 ${groups.obj ?? "USDC"} into ${alias}".` };
  }
  if (amount?.type === "previous" && index === 0) {
    throw clauseError(clause, "\"all\", \"half\", \"it\" and percentages refer to a previous step; give an explicit amount.");
  }
  let from = groups.a;
  if (amount?.type === "exact" && amount.usd) {
    if (from && !["USDC", "USDT", "PYUSD", "DAI"].includes(from.toUpperCase())) throw clauseError(clause, "A $ amount must be paid in a USD stablecoin.");
    from = from ?? "USDC";
  }
  const params: Record<string, string | number | boolean> = {};
  if (amount?.type === "previous" && amount.portionBps !== 10_000) params.portionBps = amount.portionBps;
  amount = amount ?? null;
  return {
    action: {
      kind: phrase.vm === "evm" ? "call" : "action",
      network: phrase.network,
      contract: phrase.contract,
      entry: phrase.entry,
      ...(from ? { from } : {}),
      ...(amount ? { amount: amount.type === "exact" ? amount.value : "max" } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    },
    explicit: network !== undefined,
  };
}

const matcherCache = new WeakMap<readonly ContractPhrase[], ContractMatcher | null>();

function cachedMatcher(phrases: readonly ContractPhrase[]): ContractMatcher | null {
  if (!matcherCache.has(phrases)) matcherCache.set(phrases, contractMatcher(phrases));
  return matcherCache.get(phrases) ?? null;
}

/**
 * A clause naming a registered alias: `<verb> [<amount> [<asset>]] <connector>
 * [the|my] <alias> [vault|pool|contract|program] [on <network>]`. Ambiguous
 * aliases are settled by `on <network>`, then by the previous step's
 * destination network; otherwise the network is a gap. A spending entry
 * without an amount is an amount gap. Returns null when the clause names no
 * alias (built-in sentences then apply unchanged); throws for what a
 * question cannot fix (a verb the registration does not accept, a network it
 * is not registered on, an amount on a non-spending entry).
 */
export function matchContractPhrase(
  clause: string,
  phrases: readonly ContractPhrase[],
  options: { readonly previousDestination?: NetworkKey; readonly index?: number } = {},
): ContractPhraseMatch | null {
  const matcher = phrases.length > 0 ? cachedMatcher(phrases) : null;
  if (!matcher) return null;
  return matchWithMatcher(normalizeText(clause), matcher, options.previousDestination, options.index ?? 0);
}

interface InferenceContext {
  readonly defaultNetwork?: NetworkKey;
  readonly accountNetworks: readonly NetworkKey[];
}

/** Networks a swap may run on: Solana and the five EVM production networks (the planner checks live venues). */
export const SWAP_NETWORKS: readonly NetworkKey[] = Object.freeze(["solana", "base", "arbitrum", "ethereum", "optimism", "polygon"]);
const EVM_SWAP_NETWORKS: readonly NetworkKey[] = SWAP_NETWORKS.filter((network) => CHAINS[network].vm === "evm");
const EVM_DEFAULT_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum"];
/** EVM networks a transfer to an address or name may run on, in default order. */
export const EVM_TRANSFER_NETWORKS: readonly NetworkKey[] = Object.freeze(["base", "arbitrum", "ethereum", "optimism", "polygon", "arc", "arbitrum-sepolia"]);

/** Networks with an executable venue of `protocol` for `kind`, in registry order. */
function lendingNetworks(protocol: ProtocolId | undefined, kind: IntentActionKind): NetworkKey[] {
  return [...new Set(YIELD_VENUES
    .filter((venue) => (!protocol || venue.protocol === protocol) && (venue.actions as readonly string[]).includes(kind))
    .map((venue) => venue.network))];
}

function knownOn(network: NetworkKey, token: string): boolean {
  const chain = CHAINS[network];
  if (token.includes(":")) return token.startsWith(`${chain.id}/`);
  if (isEvmAddress(token)) return chain.namespace === "eip155";
  if (isSolanaAddress(token)) return chain.namespace === "solana";
  if (token.toUpperCase() === chain.nativeAsset.symbol.toUpperCase()) return true;
  return findAssetBySymbol(network, token) !== null;
}

function preferred(candidates: readonly NetworkKey[], context: InferenceContext): NetworkKey | null {
  const order = [context.defaultNetwork, ...context.accountNetworks].filter((entry): entry is NetworkKey => entry !== undefined);
  for (const network of order) if (candidates.includes(network)) return network;
  return null;
}

function inferSwapNetwork(draft: Draft, context: InferenceContext): NetworkKey {
  const tokens = [draft.from ?? (draft.amount.type === "exact" && draft.amount.usd ? "USDC" : undefined), draft.to]
    .filter((token): token is string => token !== undefined);
  // A named venue keeps the swap on the networks it lists.
  const venueNetworks = draft.protocol ? getProtocol(draft.protocol)?.networks ?? [] : null;
  const networks = venueNetworks ? SWAP_NETWORKS.filter((network) => venueNetworks.includes(network)) : SWAP_NETWORKS;
  const candidates = networks.filter((network) => tokens.every((token) => knownOn(network, token)));
  if (candidates.length === 1) return candidates[0] as NetworkKey;
  if (candidates.length > 1) {
    const pick = preferred(candidates, context);
    if (pick) return pick;
    // Only EVM candidates and no hint: Base, as before more EVM networks swapped.
    if (candidates.every((network) => CHAINS[network].vm === "evm")) {
      const fallback = EVM_DEFAULT_NETWORKS.find((network) => candidates.includes(network));
      if (fallback) return fallback;
    }
    throw clauseError(draft.clause, `Say which network to use, e.g. "${draft.clause} on ${candidates[0]}".`);
  }
  // A token unknown to every EVM registry but plausible on Solana is resolved through Jupiter.
  const solanaVenue = !venueNetworks || venueNetworks.includes("solana");
  const evmKnown = tokens.some((token) => EVM_SWAP_NETWORKS.some((network) => knownOn(network, token)) && !knownOn("solana", token));
  if (solanaVenue && !evmKnown && tokens.every((token) => !isEvmAddress(token))) return "solana";
  if (draft.protocol && venueNetworks) {
    throw clauseError(draft.clause, `${protocolName(draft.protocol)} swaps run on ${venueNetworks.map((network) => CHAINS[network].name).join(", ")}; ${tokens.join(" and ")} are not listed there together.`);
  }
  throw clauseError(draft.clause, `Cannot find one network that lists ${tokens.join(" and ")}. Add "on <network>".`);
}

function inferTransferNetwork(draft: Draft, context: InferenceContext): NetworkKey {
  const recipient = draft.recipient ?? "";
  if (recipient.includes(":")) {
    const parsed = parseAccountId(recipient);
    if (!parsed) throw clauseError(draft.clause, "The recipient is not a valid CAIP-10 account.");
    return parsed.chain.key;
  }
  // Basenames live on Base; other ENS names follow the caller's EVM network.
  if (/\.base\.eth$/iu.test(recipient)) return "base";
  if (isEvmAddress(recipient) || /\.eth$/iu.test(recipient)) {
    const pick = preferred(EVM_TRANSFER_NETWORKS, context);
    return pick ?? "base";
  }
  if (isSolanaAddress(recipient) || /\.(?:sns|sol)$/iu.test(recipient)) {
    if (context.defaultNetwork === "solana" || context.defaultNetwork === "solana-devnet") return context.defaultNetwork;
    const solanaAccounts = context.accountNetworks.filter((network) => CHAINS[network].namespace === "solana");
    if (solanaAccounts.length > 0 && solanaAccounts.every((network) => network === "solana-devnet")) return "solana-devnet";
    return "solana";
  }
  throw clauseError(draft.clause, "The recipient is not a valid EVM or Solana address.");
}

/** A source to show in the "say where the funds come from" hint: never the destination itself. */
function sourceHint(destination: NetworkKey, context: InferenceContext): NetworkKey {
  const lane = CHAINS[destination].environment;
  const order = [context.defaultNetwork, ...context.accountNetworks, "base", "solana", "arbitrum", ...(Object.keys(CHAINS) as NetworkKey[])]
    .filter((entry): entry is NetworkKey => entry !== undefined);
  return order.find((network) => network !== destination && CHAINS[network].environment === lane) ?? "base";
}

function inferNetwork(draft: Draft, previousDestination: NetworkKey | undefined, context: InferenceContext): NetworkKey {
  if (draft.network) return draft.network;
  switch (draft.kind) {
    case "transfer": {
      const byAddress = inferTransferNetwork(draft, context);
      if (previousDestination && CHAINS[previousDestination].namespace === CHAINS[byAddress].namespace && !draft.recipient?.includes(":")) {
        return previousDestination;
      }
      return byAddress;
    }
    case "stake":
      // EVM liquid staking runs on Ethereum; SOL staking on Solana.
      return previousDestination ?? (draft.protocol ? EVM_STAKING_NETWORK : "solana");
    case "deposit":
    case "withdraw": {
      if (previousDestination) return previousDestination;
      const networks = lendingNetworks(draft.protocol, draft.kind);
      return preferred(networks, context) ?? networks[0] ?? preferred(EVM_DEFAULT_NETWORKS, context) ?? "base";
    }
    case "bridge": {
      if (previousDestination) return previousDestination;
      if (context.defaultNetwork && context.defaultNetwork !== draft.toNetwork) return context.defaultNetwork;
      const destination = draft.toNetwork ?? "solana";
      const message = `Say where the funds come from, e.g. "from ${sourceHint(destination, context)} to ${destination}".`;
      throw new MissingSourceError(clauseMessage(draft.clause, message), [{ path: "text", message }], {
        asset: draft.from ?? (draft.amount.type === "exact" && draft.amount.usd ? "USDC" : null),
        amount: draft.amount.type === "exact" ? draft.amount.value : null,
        toNetwork: destination,
      });
    }
    default:
      return previousDestination ?? inferSwapNetwork(draft, context);
  }
}

function toActionSpec(draft: Draft, network: NetworkKey, index: number): IntentActionSpec {
  const amount = draft.amount;
  if (draft.kind === "withdraw") {
    if (amount.type === "previous" && !amount.whole) {
      throw clauseError(draft.clause, "Withdraw an exact amount or \"all\" (the whole position).");
    }
    if (!draft.from) throw clauseError(draft.clause, "Say which asset to withdraw, e.g. \"withdraw 50 USDC from aave\".");
    if (amount.type === "exact" && amount.usd && !["USDC", "USDT", "PYUSD", "DAI"].includes(draft.from.toUpperCase())) {
      throw clauseError(draft.clause, "A $ amount must be withdrawn in a USD stablecoin.");
    }
  } else if (amount.type === "previous" && index === 0) {
    throw clauseError(draft.clause, "\"all\", \"half\", \"it\" and percentages refer to a previous step; give an explicit amount.");
  }
  let from = draft.from;
  if (amount.type === "exact" && amount.usd) {
    if (from && !["USDC", "USDT", "PYUSD", "DAI"].includes(from.toUpperCase())) {
      throw clauseError(draft.clause, "A $ amount must be paid in a USD stablecoin.");
    }
    from = from ?? "USDC";
  }
  const params: Record<string, string | number | boolean> = {};
  if (amount.type === "previous" && amount.portionBps !== 10_000) params.portionBps = amount.portionBps;
  if (draft.venue) params.venue = draft.venue;
  let to = draft.to;
  if (draft.kind === "stake") {
    const evm = draft.protocol ? evmStakingToken(draft.lst) ?? EVM_STAKING_TOKENS.lido : undefined;
    const target = evm ?? LIQUID_STAKING_TOKENS[draft.lst ?? "jito"] ?? LIQUID_STAKING_TOKENS.jito;
    to = target?.symbol ?? "JitoSOL";
    params.provider = target?.provider ?? "Jito";
  }
  if (draft.kind === "transfer" && !draft.recipient) throw clauseError(draft.clause, "A recipient address is required.");
  if (draft.kind === "bridge" && !draft.toNetwork) throw clauseError(draft.clause, "A destination network is required.");
  if (draft.kind === "bridge" && draft.toNetwork === network) {
    throw clauseError(draft.clause, "The source and destination networks are the same; use swap or send instead.");
  }
  return {
    kind: draft.kind,
    network,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    amount: amount.type === "exact" ? amount.value : "max",
    ...(draft.toNetwork ? { toNetwork: draft.toNetwork } : {}),
    ...(draft.recipient ? { recipient: draft.recipient } : {}),
    ...(draft.protocol ? { protocol: draft.protocol } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/** Compiles intent text into structured actions, or throws INTENT_UNSUPPORTED (MissingSourceError for a bridge without a source). */
export function compileIntentText(text: string, context: GrammarContext = {}): GrammarResult {
  const normalizedText = normalizeText(text);
  if (!normalizedText) throw unsupported("The intent text is empty.", GRAMMAR_EXAMPLES);
  const matcher = context.contracts && context.contracts.length > 0 ? cachedMatcher(context.contracts) : null;
  const clauses = splitClauses(normalizedText, matcher ? matcher.phrases.flatMap((phrase) => phrase.verbs) : []);
  if (clauses.length === 0) throw unsupported("The intent text is empty.", GRAMMAR_EXAMPLES);
  if (clauses.length > MAX_INTENT_ACTIONS) {
    throw unsupported(`An intent may contain at most ${MAX_INTENT_ACTIONS} actions.`, GRAMMAR_EXAMPLES);
  }
  const accountNetworks = (context.accounts ?? [])
    .map((account) => parseAccountId(account)?.chain.key)
    .filter((network): network is NetworkKey => network !== undefined);
  const inference: InferenceContext = {
    ...(context.defaultNetwork ? { defaultNetwork: context.defaultNetwork } : {}),
    accountNetworks,
  };
  const actions: IntentActionSpec[] = [];
  const explicitNetwork: boolean[] = [];
  const warnings: string[] = [];
  let previousDestination: NetworkKey | undefined;
  clauses.forEach((clause, index) => {
    const contract = matcher ? matchWithMatcher(clause, matcher, previousDestination, index) : null;
    if (contract && "gap" in contract) throw clauseError(clause, contract.message);
    let action: IntentActionSpec;
    if (contract) {
      action = contract.action;
      explicitNetwork.push(contract.explicit);
    } else {
      const draft = matchClause(clause);
      const network = inferNetwork(draft, previousDestination, inference);
      action = toActionSpec(draft, network, index);
      explicitNetwork.push(draft.explicit);
      warnings.push(...(draft.warnings ?? []));
    }
    actions.push(action);
    previousDestination = action.toNetwork ?? action.network;
  });
  return {
    actions,
    normalizedText: clauses.join(", then "),
    clauses,
    confidence: 0.95,
    explicitNetwork,
    warnings: [...new Set(warnings)],
  };
}
