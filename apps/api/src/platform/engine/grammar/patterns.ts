/**
 * Regular-expression fragments and the clause patterns.
 */
import {
  CHAINS,
  isJupiterDexFamily,
  JUPITER_DEX_FAMILIES,
  type IntentActionKind,
  type JupiterDexFamily,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import { encodeJupiterVenueFilter } from "../adapters/jupiter.js";
import { GRAMMAR_EXAMPLES } from "./examples.js";
import {
  BRIDGE_WORDS,
  GENERATED_EVM_STAKING_WORDS,
  LENDING_WORDS,
  LIQUID_STAKING_TOKENS,
  NATIVE_STAKE_WORDS,
  SWAP_VENUE_WORDS,
  SWAP_VENUES,
  wordAlternation,
} from "./venues.js";
import { clauseError, clauseMessage } from "./types.js";

/**
 * Words that name both a listed token and a network: "op" is OP Mainnet or
 * the OP token, "sol" Solana or SOL.
 */
export const ASSET_NETWORK_WORDS: Readonly<Record<string, { readonly network: NetworkKey; readonly symbol: string }>> = Object.freeze({
  sol: { network: "solana", symbol: "SOL" },
  op: { network: "optimism", symbol: "OP" },
  arb: { network: "arbitrum", symbol: "ARB" },
  matic: { network: "polygon", symbol: "POL" },
});

/** Verbs that say neither "change the token" nor "change the network": "move 10 USDC to op" can mean either. */
export const NEUTRAL_MOVE_VERBS: readonly string[] = Object.freeze(["move", "send", "transfer", "ship"]);

/**
 * INTENT_UNSUPPORTED for a neutral verb whose destination names a token and
 * a network ("move 10 USDC to op", "send 10 USDC to sol") with no source
 * network said: both readings are given as examples, never one chosen.
 * `what` is the amount and token as said ("10 USDC"), when the clause said both.
 */
export function assetOrNetworkRefusal(clause: string, verb: string, word: string, what?: string): PlatformError {
  const entry = ASSET_NETWORK_WORDS[word.toLowerCase()] ?? { network: "optimism" as NetworkKey, symbol: word.toUpperCase() };
  const spend = what ?? "10 USDC";
  const bridge = `bridge ${spend} to ${entry.network}`;
  const swap = `swap ${spend} to ${entry.symbol}`;
  const message = `"${verb} ... to ${word.slice(0, 16)}" can mean ${CHAINS[entry.network].name} or the ${entry.symbol} token. To move it to ${CHAINS[entry.network].name}, say "${bridge}"; to change it into ${entry.symbol}, say "${swap}".`;
  return unsupported(clauseMessage(clause, message), [bridge, swap, ...GRAMMAR_EXAMPLES.slice(0, 3)], [{ path: "text", message: "A token or a network: say which." }]);
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
  ...(NATIVE_STAKE_WORDS.length > 0 ? [wordAlternation(NATIVE_STAKE_WORDS)] : []),
].join("|");
/** A Solana vote account named after "validator" ("stake 2 SOL with validator <vote>"). */
const VOTE_ACCOUNT = "(?<vote>[1-9A-HJ-NP-Za-km-z]{32,44})";
/** "via raydium", "using orca", "through uniswap" after a swap. */
const SWAP_VENUE_SUFFIX = `(?:\\s+(?:via|using|through|with)\\s+(?<dex>${SWAP_VENUE_WORDS}))`;
/** The Solana Pay protocol id (named only: never picked for a plain send). */
export const SOLANA_PAY_PROTOCOL: ProtocolId = "solana-pay";
/** "with solana pay" after a transfer: the Solana Pay protocol (reference-tracked transfer). */
const SOLANA_PAY_SUFFIX = "(?:\\s+(?:with|via|using|through|over|by)\\s+(?<pay>solana[\\s-]*pay))";
/** A Jupiter venue family ("phoenix", "pump.fun"); see `jupiterFamily`. */
const FAMILY = `(?:${Object.keys(JUPITER_DEX_FAMILIES).filter((family) => family !== "pumpfun").join("|")}|pump(?:\\.|[\\s-]?)fun)`;
const FAMILY_LIST = `${FAMILY}(?:(?:\\s*,\\s*|\\s+(?:and|or|nor)\\s+|\\s*,\\s*(?:and|or)\\s+)${FAMILY}){0,2}`;
/** Families that are no swap venue word of their own ("via phoenix"): read as "only through Phoenix" on Jupiter. */
const FILTER_ONLY_FAMILIES = Object.keys(JUPITER_DEX_FAMILIES).filter((family) => !SWAP_VENUES.some((venue) => venue.pattern.test(family)));
/**
 * A Jupiter venue filter after a Solana swap: "using only raydium and orca", "via phoenix",
 * "avoiding raydium", "without solfi or humidifi". Encoded as `params.provider` (encodeJupiterVenueFilter).
 */
const SWAP_FILTER_SUFFIX =
  `(?:\\s+(?:using\\s+only|only\\s+(?:via|through|using|on)|via\\s+only|through\\s+only)\\s+(?<only>${FAMILY_LIST})` +
  `|\\s+(?:via|through|using)\\s+(?<viaOnly>${FILTER_ONLY_FAMILIES.join("|")})` +
  `|\\s+(?:avoiding|avoid|excluding|except|without|not\\s+(?:via|through|using|on))\\s+(?<avoid>${FAMILY_LIST}))`;
const SWAP_VENUE_OR_FILTER = `(?:${SWAP_VENUE_SUFFIX}|${SWAP_FILTER_SUFFIX})`;
/** A swap names its network and venue (or venue filter) in either order. */
const SWAP_SUFFIXES = [`${ON_NETWORK}?${SWAP_VENUE_OR_FILTER}?`, `${SWAP_VENUE_OR_FILTER}${ON_NETWORK}?`];

/** A swap's venue filter in the grammar's words ("using only phoenix and orca", "avoiding raydium"), or null. */
export function swapFilterWords(provider: string | undefined): string | null {
  const match = /^(dexes|avoid):([a-z]+(?:,[a-z]+)*)$/u.exec(provider ?? "");
  if (!match) return null;
  const families = (match[2] as string).split(",");
  const list = families.length === 1 ? families[0] : `${families.slice(0, -1).join(", ")} and ${families[families.length - 1]}`;
  return match[1] === "dexes" ? `using only ${list}` : `avoiding ${list}`;
}

/** The Jupiter family a filter word names ("pump.fun" -> pumpfun), or null. */
function jupiterFamily(word: string): JupiterDexFamily | null {
  const value = word.trim().toLowerCase().replace(/^pump(?:\.|[\s-]?)fun$/u, "pumpfun");
  return isJupiterDexFamily(value) ? value : null;
}

/**
 * The `provider` of a swap's venue filter from the suffix groups ("only", "viaOnly", "avoid"), or undefined
 * when the swap names none. Refuses a filter off Solana (Jupiter routes Solana swaps only).
 */
export function swapFilterProvider(groups: Record<string, string | undefined>, network: NetworkKey | undefined, clause: string): string | undefined {
  const list = groups.only ?? groups.viaOnly ?? groups.avoid;
  if (!list) return undefined;
  if (network && CHAINS[network].vm !== "svm") {
    throw clauseError(clause, `Venue filters ("via phoenix", "avoiding raydium") choose Jupiter venues on Solana; ${CHAINS[network].name} swaps do not take them.`);
  }
  const families = list.split(/\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|nor)\s+/u).map(jupiterFamily).filter((family): family is JupiterDexFamily => family !== null);
  return encodeJupiterVenueFilter({ mode: groups.avoid ? "avoid" : "only", families });
}

/**
 * The building blocks of the built-in sentences (exported for the clarify
 * layer, which reads the same shapes without refusing).
 */
export const SENTENCE_FRAGMENTS = Object.freeze({
  SWAP_FILTER_SUFFIX,
  SOLANA_PAY_SUFFIX,
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

export const PATTERNS: readonly { kind: IntentActionKind | "buy" | "bridge-or-transfer" | "native-stake"; regex: RegExp }[] = [
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
  // "pay 5 USDC to <address> with solana pay": a Solana Pay transfer, named only, network and connector in either order.
  ...[`${ON_NETWORK}?${SOLANA_PAY_SUFFIX}?`, `${SOLANA_PAY_SUFFIX}${ON_NETWORK}?`].map((suffix) => ({
    kind: "transfer" as const,
    regex: new RegExp(`^(?:send|transfer|pay)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?\\s+to\\s+${ADDRESS}${suffix}$`, "iu"),
  })),
  {
    // Native SOL staking: "stake 2 SOL natively", "stake 2 SOL with native staking", "stake 2 SOL with validator <vote>".
    kind: "native-stake",
    regex: new RegExp(
      `^stake\\s+${AMOUNT}(?:\\s+(?<a>sol))?(?:\\s+natively|\\s+(?:with|via|using|to|at)\\s+(?:a\\s+|the\\s+)?(?<lst>${wordAlternation(NATIVE_STAKE_WORDS)})` +
        `(?:\\s+${VOTE_ACCOUNT})?)${ON_NETWORK}?$`,
      "iu",
    ),
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
