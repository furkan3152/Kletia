/**
 * Sentence shapes, vocabularies, the parsed-sentence shape and refusal
 * examples.
 */
import { SENTENCE_VERBS } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  BORROW_VERBS,
  borrowRefusal,
  SENTENCE_FRAGMENTS,
  BRIDGE_WORDS,
  GRAMMAR_VENUE_WORDS,
  LENDING_WORDS,
  LST_WORDS,
  NAME,
  NETWORK_WORDS,
  SWAP_VENUE_WORDS,
  VAULT,
  VERBS,
} from "../../grammar.js";
import { readOnlyRates, readOnlyRatesRefusal } from "../../readOnly.js";
import type { WorkStep } from "../types.js";
import type { ThreadCorrection } from "@kletia/core";

export const AMT =
  "(?<amt>\\d{1,3}(?:\\.\\d{1,2})?%|\\$\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+|all|max|everything|it|them|that|half|a\\s+quarter|quarter)";
const OF = "(?:\\s+of\\s+(?:it|them|that|the\\s+output|the\\s+proceeds))?";
const GUARD = "(?!(?:to|for|into|onto|with|using|from|on|as|via|in|at|my|of)\\b)";
const SYM = (name: string) => `${GUARD}(?<${name}>(?:eip155|solana):\\S+|[A-Za-z0-9$][\\w.\\-]{0,63})`;
export const NET = (name: string) => `(?<${name}>${NETWORK_WORDS})`;
export const ADDR = `(?:0x[0-9a-fA-F]{40}|(?:eip155|solana):\\S+|${NAME}|[1-9A-HJ-NP-Za-km-z]{32,44})`;
const MY = "(?:(?:of\\s+)?(?<my>my)\\s+)?";
const ON = `(?:\\s+(?:on|in)\\s+${NET("net")})?`;
const DEX = `(?:\\s+(?:via|using|through|with)\\s+(?<dex>${SWAP_VENUE_WORDS})|${SENTENCE_FRAGMENTS.SWAP_FILTER_SUFFIX})?`;
/** "with solana pay" after a transfer. */
const PAY = `${SENTENCE_FRAGMENTS.SOLANA_PAY_SUFFIX}?`;
/** A swap names its network and venue in either order. */
const SWAP_SUFFIXES = [`${ON}${DEX}`, `${DEX}${ON}`];

const rx = (source: string) => new RegExp(source, "iu");

export const SHAPES: readonly { shape: "usdSwap" | "earn" | "swap" | "buy" | "bridge" | "transfer" | "transferLabel" | "stake" | "deposit" | "withdraw"; regex: RegExp }[] = [
  ...SWAP_SUFFIXES.map((suffix) => ({
    shape: "usdSwap" as const,
    regex: rx(`^(?<verb>swap|convert|trade|exchange|sell)\\s+(?<usd>\\$\\d[\\d,]*(?:\\.\\d+)?)\\s+(?:of|worth\\s+of)\\s+${MY}${SYM("a")}(?:\\s+(?:to|for|into)\\s+${SYM("b")})?${suffix}$`),
  })),
  { shape: "earn", regex: rx(`^(?:earn|get)\\s+(?:yield|interest)\\s+(?:on|with|from)\\s+(?:${AMT}\\s+)?${MY}${SYM("a")}${ON}$`) },
  ...SWAP_SUFFIXES.map((suffix) => ({
    shape: "swap" as const,
    regex: rx(`^(?<verb>swap|convert|trade|exchange|sell)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+(?:to|for|into)\\s+${SYM("b")})?${suffix}$`),
  })),
  ...SWAP_SUFFIXES.map((suffix) => ({
    shape: "buy" as const,
    regex: rx(`^(?<verb>buy|get|purchase)(?:\\s+me)?(?:\\s+some)?\\s+${SYM("b")}(?:\\s+(?:with|using)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?)?${suffix}$`),
  })),
  {
    shape: "bridge",
    regex: rx(
      `^(?<verb>bridge|move|send|transfer|port)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+from\\s+${NET("n1")})?(?:\\s+(?:to|into|onto)\\s+${NET("n2")})?` +
        `(?:\\s+(?:as|into|for)\\s+${SYM("b")})?(?:\\s+(?:via|using|through|with|over)\\s+(?<bridge>${BRIDGE_WORDS}))?$`,
    ),
  },
  ...[`${ON}${PAY}`, `${PAY}${ON}`].map((suffix) => ({
    shape: "transfer" as const,
    regex: rx(`^(?<verb>send|transfer|pay)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+to\\s+(?<rcpt>${ADDR}))?${suffix}$`),
  })),
  {
    shape: "transferLabel",
    regex: rx(`^(?<verb>send|transfer|pay)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?\\s+to\\s+(?<label>(?:my\\s+)?[a-z][a-z0-9-]{1,40}(?:\\s+[a-z][a-z0-9-]{1,20})?)${ON}$`),
  },
  {
    shape: "stake",
    regex: rx(`^stake(?:\\s+${AMT}${OF})?\\s*${MY}(?:(?<a>sol|eth))?(?:\\s+(?<natively>natively)|\\s+(?:with|via|on|using|into|to|as|at)\\s+(?<lst>${LST_WORDS}))?${ON}$`),
  },
  {
    shape: "deposit",
    regex: rx(
      `^(?<verb>deposit|supply|lend|put|place|invest)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+(?:into|to|on|in|at|with)\\s+(?:the\\s+)?(?<venue>${LENDING_WORDS})(?:\\s+${VAULT})?(?:\\s+vault)?)?${ON}$`,
    ),
  },
  {
    shape: "withdraw",
    regex: rx(
      `^(?<verb>withdraw|redeem)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?\\s+(?:from|out\\s+of)\\s+(?:my\\s+)?(?:the\\s+)?(?<venue>${LENDING_WORDS})(?:\\s+${VAULT})?(?:\\s+(?:vault|position))?${ON}$`,
    ),
  },
];

/* ------------------------------------------------------- vocabularies */

export const VERB_VOCAB: readonly string[] = VERBS;
export const CONNECTOR_VOCAB = ["from", "into", "onto", "with", "using", "through", "then"];
export const NETWORK_VOCAB = ["base", "arbitrum", "ethereum", "optimism", "polygon", "solana", "devnet", "sepolia", "mainnet"];
/** Single venue and provider words of the grammar ("aave", "kamino", "jito", "uniswap", ...). */
export const VENUE_VOCAB: readonly string[] = [...new Set(GRAMMAR_VENUE_WORDS.flatMap((word) => word.split(/[\s.-]+/u)).filter((word) => /^[a-z]{4,}$/u.test(word)))]
  // "save" (Save finance) is an English word first: never a correction target ("safe", "same" stay as typed).
  .filter((word) => !["vault", "vaults", "lend", "earn", "lending", "savings", "pool", "save"].includes(word));
/**
 * Every word the keyword corrector may correct into (verbs at the start of a
 * clause; connectors, networks and venues elsewhere). The drift test pins it
 * to the list clarify/englishWords.ts was reviewed against.
 */
export const KEYWORD_VOCABULARY: readonly string[] = Object.freeze([...VERB_VOCAB, ...CONNECTOR_VOCAB, ...NETWORK_VOCAB, ...VENUE_VOCAB]);
export const FILLER = new Set([
  "my", "the", "of", "all", "half", "max", "everything", "it", "them", "that", "some", "me", "a", "an", "quarter", "instead", "and", "to", "on", "in",
  "at", "as", "for", "via", "vault", "position", "yield", "interest", "lend", "earn", "v3", "out", "savings", "pool",
]);

export interface ParsedSentence {
  readonly steps: WorkStep[];
  readonly corrections: ThreadCorrection[];
}

/** Example sentences sent with a refusal (`hints`), so the reader sees what does work. */
export const REFUSAL_EXAMPLES: readonly string[] = Object.freeze([
  "swap 1 SOL to USDC",
  "bridge 25 USDC from base to solana",
  "send 5 USDC to vitalik.eth on base",
  "stake 1.5 SOL with marinade",
  "deposit 100 USDC into aave on base",
]);

export function notUnderstood(clause: string): PlatformError {
  const verb = clause.split(/\s+/u)[0]?.toLowerCase() ?? "";
  // "borrow" and "repay" are lending actions Kletia does not run yet: said so, in every path.
  if (BORROW_VERBS.includes(verb)) {
    const refusal = borrowRefusal(clause, verb);
    return new PlatformError("INTENT_UNSUPPORTED", refusal.message, 422, refusal.issues, REFUSAL_EXAMPLES);
  }
  // "show live Aave rates": a read-only question, answered by GET /v1/venues (details say so).
  const rates = readOnlyRates(clause);
  if (rates) return readOnlyRatesRefusal(rates, REFUSAL_EXAMPLES);
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    Object.hasOwn(SENTENCE_VERBS, verb)
      ? `Kletia could not read "${clause.slice(0, 120)}" as a ${verb} it can plan. Name the token and the amount, as in the examples.`
      : `Kletia cannot do "${clause.slice(0, 60)}". It can swap, buy, bridge, send, stake, deposit and withdraw tokens.`,
    422,
    [{ path: "text", message: "Could not read this clause." }],
    REFUSAL_EXAMPLES,
  );
}
