/**
 * Reviewed word lists of the intent reader (design A.2, I12; seam S9): what
 * may be dropped, what may never be dropped, corrected, ignored or sent to a
 * model without a named rule consuming it, and the closed sets of units,
 * unsupported networks, network qualifiers, look-alike symbols and registry
 * words that contain digits.
 *
 * One source for the deterministic reader, the model-reading pre-filter and
 * the evaluation's conservation oracle. Changes go through review with a
 * reason: an entry here changes what Kletia is allowed to read.
 *
 * Every phrase is lowercase with single spaces and matched as whole words
 * (an apostrophe-free spelling is listed next to the one with it). Pure
 * constants and small helpers; nothing here reads the network.
 */
import { ASSETS } from "./assets.js";
import { FOLLOW_UP_VENUE_WORDS, type AmountUnit } from "./clarify.js";

// ------------------------------------------------------------ fillers

/**
 * When a filler is not one: next to an amount ("like 50" is an
 * approximation), before a correction ("actually 3"), right after a network
 * word, before an asset symbol ("w usdc" means "with USDC"), or inside a
 * longer phrase another list reads ("can u").
 */
export type FillerException = "adjacent-amount" | "before-correction" | "after-network" | "before-asset" | "in-phrase";

export interface FillerEntry {
  readonly phrase: string;
  /** Where in a clause the phrase is a filler. */
  readonly position: "any" | "start" | "end";
  /** Contexts where it is not dropped (a rule reads it, or the clause is not read). */
  readonly except?: readonly FillerException[];
}

/**
 * Politeness words a clause may end with. They can never name a network, a
 * lane or an amount, so they are the only fillers dropped right after a
 * network word or next to an amount at the end of a clause.
 */
export const CLAUSE_FINAL_POLITENESS: readonly string[] = Object.freeze(["please", "pls", "plz", "thanks", "thx", "ty"]);

/**
 * Reviewed fillers: the only words a reader may drop. Every dropped filler
 * is listed in a non-material "Ignored: ..." chip. Besides the exceptions of
 * each entry, no filler is dropped next to an amount or right after a network
 * word, except the clause-final politeness words.
 */
export const REVIEWED_FILLERS: readonly FillerEntry[] = Object.freeze([
  // chat
  { phrase: "w", position: "any", except: ["before-asset", "adjacent-amount", "after-network"] },
  { phrase: "u", position: "any", except: ["in-phrase", "adjacent-amount", "after-network"] },
  { phrase: "rn", position: "end" },
  { phrase: "lol", position: "any" },
  { phrase: "gm", position: "start" },
  { phrase: "hey kletia", position: "start" },
  { phrase: "ok so", position: "start" },
  { phrase: "so basically", position: "start" },
  { phrase: "basically", position: "any" },
  { phrase: "first", position: "start" },
  { phrase: "i wanna", position: "start" },
  { phrase: "and that's it", position: "end" },
  { phrase: "and thats it", position: "end" },
  // politeness
  { phrase: "please", position: "any" },
  { phrase: "pls", position: "any" },
  { phrase: "plz", position: "any" },
  { phrase: "kindly", position: "any" },
  { phrase: "thx", position: "end" },
  { phrase: "ty", position: "end" },
  { phrase: "thanks", position: "end" },
  { phrase: "thank you", position: "end" },
  { phrase: "thanks a lot", position: "end" },
  { phrase: "thx in advance", position: "end" },
  { phrase: "thanks in advance", position: "end" },
  { phrase: "for me", position: "end" },
  { phrase: "for me please", position: "end" },
  // pace (the reader never schedules: these only say "now")
  { phrase: "real quick", position: "end" },
  { phrase: "quickly", position: "end" },
  { phrase: "now", position: "end" },
  { phrase: "right now", position: "end" },
  { phrase: "asap", position: "end" },
  // softeners already dropped by the reader before this list existed ("over" and "worth" are not fillers)
  { phrase: "just", position: "any" },
  { phrase: "actually", position: "any", except: ["before-correction"] },
  { phrase: "like", position: "any", except: ["adjacent-amount"] },
  { phrase: "some", position: "any" },
  { phrase: "real", position: "any" },
  { phrase: "quick", position: "any" },
  { phrase: "idle", position: "any" },
  { phrase: "spare", position: "any" },
  { phrase: "somewhere", position: "any" },
  { phrase: "something", position: "any" },
] satisfies readonly FillerEntry[]);

// ------------------------------------------------------------ closed class

export const CLOSED_CLASS_CATEGORIES = Object.freeze([
  "negation", "cancellation", "question", "condition", "disjunction", "limit", "approximation", "each",
] as const);
export type ClosedClassCategory = (typeof CLOSED_CLASS_CATEGORIES)[number];

/** The refusal message family of a category (`details.closedClass` on a closed-class refusal), plus units. */
export const CLOSED_CLASS_REFUSALS = Object.freeze(["negation", "cancellation", "question", "condition", "disjunction", "limit", "unit"] as const);
export type ClosedClassRefusal = (typeof CLOSED_CLASS_REFUSALS)[number];

/** Which refusal a category's unconsumed word gets. */
export const CLOSED_CLASS_REFUSAL_OF: Readonly<Record<ClosedClassCategory, ClosedClassRefusal>> = Object.freeze({
  negation: "negation",
  cancellation: "cancellation",
  question: "question",
  condition: "condition",
  disjunction: "disjunction",
  limit: "limit",
  approximation: "limit",
  each: "limit",
});

/** What a closed-class rule does with the words it consumes. */
export type ClosedClassOutcome = "plan" | "ask" | "confirm" | "answer" | "control" | "refuse";

export interface ClosedClassRule {
  readonly id: string;
  readonly what: string;
  readonly outcome: ClosedClassOutcome;
  /**
   * The words in context that the rule consumes, as a pattern over the
   * normalised, lowercase text. The conservation oracle accepts an occurrence
   * inside a match only when the rule's outcome is what happened; rules with
   * no pattern are recorded in provenance only.
   */
  readonly context?: RegExp;
}

const VENUE_PHRASES = Object.keys(FOLLOW_UP_VENUE_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+"))
  .join("|");

/** Refusal rules: a category's word that no other rule consumed refuses the clause with that category's message. */
const REFUSE_RULES: readonly ClosedClassRule[] = CLOSED_CLASS_REFUSALS.map((category) => ({
  id: `refuse:${category}`,
  what: `Refuse the clause with the ${category} message and an example`,
  outcome: "refuse" as const,
}));

/**
 * The rules that may consume a closed-class word, by id. Rule ids also appear
 * in slot provenance (`SlotProvenance.rule`).
 */
export const CLOSED_CLASS_RULES: Readonly<Record<string, ClosedClassRule>> = Object.freeze(Object.fromEntries(([
  { id: "allBut:except", what: "\"all my X except N\": all but N of the holding", outcome: "plan", context: /\b(?:all|everything)\b[^,;]*?\bexcept\b/u },
  { id: "avoid:without", what: "\"without <venue>\": the venue is avoided", outcome: "plan", context: new RegExp(`\\bwithout\\s+(?:using\\s+|going\\s+through\\s+)?(?:the\\s+)?(?:${VENUE_PHRASES})\\b`, "u") },
  { id: "answer:no", what: "\"no\" answering an open yes/no question", outcome: "answer" },
  { id: "edit:in-message", what: "An in-message correction of the only slot of its type (a confirm)", outcome: "confirm", context: /\b(?:no,?\s+wait|wait,?\s+no|actually,?\s+make\s+it|sorry,?\s+i\s+meant|i\s+meant)\b/u },
  { id: "control:cancel", what: "Cancel an open thread (follow-up control)", outcome: "control" },
  { id: "control:undo", what: "Undo the last change of an open thread (follow-up control)", outcome: "control" },
  { id: "readOnly:answer", what: "A rate, price or balance question answered read-only", outcome: "answer" },
  { id: "questionForm:polite", what: "A polite command (\"can you ...\"): a confirm of the solved plan", outcome: "confirm" },
  { id: "questionForm:cheapest", what: "\"what is the cheapest way to X\": a confirm of the solved plan", outcome: "confirm" },
  { id: "questionImperative", what: "A question followed by a clean imperative: a confirm of the solved plan", outcome: "confirm" },
  { id: "connector:over", what: "\"over to\", \"over from\": connector spellings of to and from", outcome: "plan", context: /\bover\s+(?:to|from)\b/u },
  { id: "order:then", what: "Step order (\"then\", \"after that\", \"and then\")", outcome: "plan", context: /\b(?:(?:and\s+)?then|(?:and\s+)?after\s+that)\b/u },
  { id: "scope:everywhere", what: "\"everywhere\", \"every network\": an exit-all scope (a moves confirm)", outcome: "confirm", context: /\b(?:everywhere|every\s+network|all\s+networks)\b/u },
  { id: "amountVague:or", what: "\"1 or 2 <asset>\": the amount is asked", outcome: "ask", context: /\b\d+(?:\.\d+)?\s+or\s+\d+(?:\.\d+)?\b/u },
  { id: "amountVague:approx", what: "An approximate amount: asked with the stated number as an option", outcome: "ask" },
  { id: "atLeast", what: "\"at least N\" on the wanted side of an ensure goal", outcome: "plan", context: /\bat\s+least\b/u },
  { id: "maxSlippage", what: "\"max slippage N %\": constraints.maxSlippageBps", outcome: "plan", context: /\bmax(?:imum)?\s+slippage\b/u },
  { id: "deliverEach", what: "\"N <asset> each to A and B\": one payment of N per recipient", outcome: "plan", context: /\b(?:each|apiece|a\s+piece)\b/u },
  { id: "unit:thousand", what: "x 1,000 (\"k\", \"thousand\", \"grand\")", outcome: "plan" },
  { id: "unit:million", what: "x 1,000,000 (\"m\", \"mm\", \"mil\", \"million\")", outcome: "plan" },
  { id: "unit:billion", what: "x 1,000,000,000 (\"bn\", \"billion\")", outcome: "plan" },
  { id: "unit:cents", what: "x 0.01 of a USD stablecoin", outcome: "plan" },
  { id: "unit:sats", what: "10^-8 BTC (read as cbBTC)", outcome: "plan" },
  { id: "unit:gwei", what: "10^-9 ETH", outcome: "plan" },
  { id: "unit:wei", what: "10^-18 ETH", outcome: "plan" },
  { id: "unit:lamports", what: "10^-9 SOL", outcome: "plan" },
  { id: "unit:bps", what: "0.01 % of a holding (\"of my X\", \"of it\")", outcome: "plan" },
  ...REFUSE_RULES,
] satisfies readonly ClosedClassRule[]).map((rule) => [rule.id, Object.freeze(rule)])));

export interface NeverDropEntry {
  readonly phrase: string;
  readonly category: ClosedClassCategory;
  /** Rule ids that may consume the phrase; the last one is always the category's refusal. */
  readonly rules: readonly string[];
  /** Approximation words that only count directly before an amount ("like 50"). */
  readonly beforeAmount?: true;
}

const entries = (category: ClosedClassCategory, rules: readonly string[], phrases: readonly string[]): NeverDropEntry[] =>
  phrases.map((phrase) => ({ phrase, category, rules: [...rules, `refuse:${CLOSED_CLASS_REFUSAL_OF[category]}`] }));

/**
 * Never-drop words (I12): never dropped, corrected, ignored or sent to a
 * model. A clause holding one that no listed rule consumed is not read: it is
 * refused with the category's message (approximations are asked).
 */
export const NEVER_DROP: readonly NeverDropEntry[] = Object.freeze([
  // negation
  ...entries("negation", [], ["not", "dont", "don't", "do not", "didnt", "didn't", "doesnt", "doesn't", "never", "nah", "neither", "nor", "but not", "wont", "won't", "shouldnt", "shouldn't", "cant", "can't", "cannot"]),
  ...entries("negation", ["answer:no", "edit:in-message"], ["no"]),
  ...entries("negation", ["avoid:without"], ["without"]),
  ...entries("negation", ["allBut:except"], ["except"]),
  // cancellation
  ...entries("cancellation", ["control:cancel"], ["cancel", "stop", "abort", "never mind", "nevermind", "forget it", "scratch that"]),
  ...entries("cancellation", ["control:undo"], ["undo", "revert"]),
  // questions, modals and hesitation
  ...entries("question", ["readOnly:answer", "questionForm:polite", "questionForm:cheapest", "questionImperative"], ["?"]),
  ...entries("question", ["readOnly:answer"], [
    "should", "should i", "would i", "could i", "can i", "is it", "what if", "whether", "maybe", "might", "perhaps", "idk", "i guess",
    "not sure", "wondering",
  ]),
  // condition and time
  ...entries("condition", [], [
    "if", "unless", "when", "whenever", "once", "until", "till", "before", "tomorrow", "tonight", "later", "today", "daily", "weekly",
    "monthly", "hourly", "next week", "next month", "by monday", "by tuesday", "by wednesday", "by thursday", "by friday", "by saturday",
    "by sunday", "by tomorrow", "in an hour", "in a day", "per day", "per week", "per month",
  ]),
  ...entries("condition", ["order:then"], ["after"]),
  ...entries("condition", ["scope:everywhere"], ["every"]),
  // disjunction
  ...entries("disjunction", ["amountVague:or"], ["or"]),
  ...entries("disjunction", [], ["either", "whichever", "vs", "versus", "or whatever"]),
  // limits
  ...entries("limit", ["atLeast"], ["at least"]),
  ...entries("limit", ["connector:over"], ["over"]),
  ...entries("limit", [], [
    "up to", "at most", "no more than", "no less than", "more than", "less than", "fewer than", "under", "above", "below",
    "max of", "min", "minimum", "not more than", "not less than",
  ]),
  // approximations (asked, never read as the exact number)
  ...entries("approximation", ["amountVague:approx"], ["around", "about", "approximately", "approx", "roughly", "~", "ish", "or so", "give or take", "circa", "more or less", "nearly", "almost", "close to"]),
  { phrase: "like", category: "approximation", rules: ["amountVague:approx", "refuse:limit"], beforeAmount: true },
  // each / per
  ...entries("each", ["deliverEach"], ["each", "apiece", "a piece"]),
  ...entries("each", [], ["per"]),
] satisfies readonly NeverDropEntry[]);

/** Clause openers that ask a question (first word or words of a clause). */
export const QUESTION_OPENERS: readonly string[] = Object.freeze([
  "what", "whats", "what's", "how", "hows", "how's", "which", "why", "who", "whose", "where", "is", "are", "am", "does", "did", "do i",
  "do you", "should", "shall", "would", "could i", "can i", "will i", "will it", "may i", "might",
]);

/** Polite command openers: a command asked as a question is planned only as a confirm of the solved plan. */
export const POLITE_OPENERS: readonly string[] = Object.freeze([
  "can you", "could you", "would you", "will you", "can u", "could u", "would u", "can you please", "could you please", "would you please",
]);

/** Approximation phrases (the approximation entries of NEVER_DROP). */
export const APPROXIMATION_WORDS: readonly string[] = Object.freeze(
  NEVER_DROP.filter((entry) => entry.category === "approximation").map((entry) => entry.phrase),
);

// ------------------------------------------------------------ units

export interface UnitWord {
  readonly unit: AmountUnit;
  /** Decimal multiplier applied to the number before the word. */
  readonly factor: string;
  /** The asset the unit implies, when it implies one (sats -> cbBTC, gwei -> ETH, lamports -> SOL). */
  readonly asset?: "BTC" | "ETH" | "SOL";
  /** What the unit needs to apply: a USD stablecoin or "$" (cents), or "of my X" / "of it" (bps). */
  readonly needs?: "usd" | "holding";
  /** May be glued to the number ("1.5k", "2m"). */
  readonly glued?: true;
  /** "m" right before a listed symbol that starts with m ("2 msol", "2 m sol") is always asked. */
  readonly ambiguousBeforeM?: true;
}

/** Units and multipliers after an amount (A.2 L0). A unit word no rule applies to refuses; never sent to a model. */
export const UNIT_WORDS: Readonly<Record<string, UnitWord>> = Object.freeze({
  k: { unit: "thousand", factor: "1000", glued: true },
  thousand: { unit: "thousand", factor: "1000" },
  grand: { unit: "thousand", factor: "1000" },
  m: { unit: "million", factor: "1000000", glued: true, ambiguousBeforeM: true },
  mm: { unit: "million", factor: "1000000", glued: true },
  mil: { unit: "million", factor: "1000000" },
  million: { unit: "million", factor: "1000000" },
  bn: { unit: "billion", factor: "1000000000", glued: true },
  billion: { unit: "billion", factor: "1000000000" },
  cent: { unit: "cents", factor: "0.01", needs: "usd" },
  cents: { unit: "cents", factor: "0.01", needs: "usd" },
  sat: { unit: "sats", factor: "0.00000001", asset: "BTC" },
  sats: { unit: "sats", factor: "0.00000001", asset: "BTC" },
  satoshi: { unit: "sats", factor: "0.00000001", asset: "BTC" },
  satoshis: { unit: "sats", factor: "0.00000001", asset: "BTC" },
  gwei: { unit: "gwei", factor: "0.000000001", asset: "ETH" },
  wei: { unit: "wei", factor: "0.000000000000000001", asset: "ETH" },
  lamport: { unit: "lamports", factor: "0.000000001", asset: "SOL" },
  lamports: { unit: "lamports", factor: "0.000000001", asset: "SOL" },
  bps: { unit: "bps", factor: "0.0001", needs: "holding" },
  bp: { unit: "bps", factor: "0.0001", needs: "holding" },
});

// ------------------------------------------------------------ networks

export interface UnsupportedNetwork {
  /** How the refusal names it ("Kletia does not run on Arbitrum Nova."). */
  readonly name: string;
  /**
   * The phrase is also an ordinary English word ("era", "ink", "scroll"):
   * it names a network only in a network position (after on/to/from/onto/
   * into/via/across, or right after a network word).
   */
  readonly commonWord?: true;
}

/** Networks Kletia does not run on: any of them in a network position refuses with NETWORK_UNSUPPORTED naming it. */
export const UNSUPPORTED_NETWORKS: Readonly<Record<string, UnsupportedNetwork>> = Object.freeze({
  "arbitrum nova": { name: "Arbitrum Nova" },
  nova: { name: "Arbitrum Nova", commonWord: true },
  "polygon zkevm": { name: "Polygon zkEVM" },
  zkevm: { name: "Polygon zkEVM" },
  zksync: { name: "zkSync Era" },
  "zksync era": { name: "zkSync Era" },
  era: { name: "zkSync Era", commonWord: true },
  linea: { name: "Linea" },
  scroll: { name: "Scroll", commonWord: true },
  blast: { name: "Blast", commonWord: true },
  mantle: { name: "Mantle", commonWord: true },
  "mantle network": { name: "Mantle" },
  bsc: { name: "BNB Smart Chain" },
  bnb: { name: "BNB Smart Chain" },
  "bnb chain": { name: "BNB Smart Chain" },
  "bnb smart chain": { name: "BNB Smart Chain" },
  "binance smart chain": { name: "BNB Smart Chain" },
  opbnb: { name: "opBNB" },
  avalanche: { name: "Avalanche" },
  avax: { name: "Avalanche" },
  "avalanche c-chain": { name: "Avalanche" },
  sonic: { name: "Sonic", commonWord: true },
  unichain: { name: "Unichain" },
  ink: { name: "Ink", commonWord: true },
  celo: { name: "Celo" },
  gnosis: { name: "Gnosis Chain" },
  "gnosis chain": { name: "Gnosis Chain" },
  fantom: { name: "Fantom" },
  tron: { name: "Tron" },
  ton: { name: "TON", commonWord: true },
  sui: { name: "Sui" },
  aptos: { name: "Aptos" },
  starknet: { name: "Starknet" },
  "bitcoin network": { name: "the Bitcoin network" },
  "btc network": { name: "the Bitcoin network" },
});

export interface NetworkQualifier {
  /** The lane the qualifier names. */
  readonly lane: "mainnet" | "testnet";
  /**
   * Network words this qualifier may follow and still name a supported
   * network ("arbitrum sepolia", "arc testnet", "solana devnet", "base
   * mainnet"); after any other network word it refuses NETWORK_UNSUPPORTED.
   */
  readonly supportedAfter: readonly string[];
}

/** Lane qualifiers after a network word (A.2 L0). A word right after a network word is never dropped. */
export const NETWORK_QUALIFIERS: Readonly<Record<string, NetworkQualifier>> = Object.freeze({
  sepolia: { lane: "testnet", supportedAfter: ["arbitrum", "arb"] },
  goerli: { lane: "testnet", supportedAfter: [] },
  holesky: { lane: "testnet", supportedAfter: [] },
  testnet: { lane: "testnet", supportedAfter: ["arc"] },
  devnet: { lane: "testnet", supportedAfter: ["solana", "sol"] },
  mainnet: { lane: "mainnet", supportedAfter: ["base", "arbitrum", "arb", "ethereum", "eth", "op", "optimism", "polygon", "solana", "sol"] },
  "mainnet-beta": { lane: "mainnet", supportedAfter: ["solana", "sol"] },
});

// ------------------------------------------------------------ assets

export interface LookalikeFamily {
  readonly id: string;
  /** Every member as usually spelt; members the registry lists are exact symbols, the others are look-alikes only. */
  readonly members: readonly string[];
  /** What a member is, for a question about it ("wstETH": "wrapped stETH, about 1.2 stETH each"). */
  readonly notes: Readonly<Record<string, string>>;
}

/**
 * Look-alike families (A10): a typed symbol of a family that is not exactly
 * a listed symbol is always asked (ASSET_LOOKALIKE or ASSET_TYPO), on every
 * path; carriers and crossing outputs are chosen by exact token address,
 * never by family.
 */
export const LOOKALIKE_FAMILIES: readonly LookalikeFamily[] = Object.freeze<LookalikeFamily[]>([
  {
    id: "eth",
    members: ["ETH", "WETH", "stETH", "wstETH", "eETH", "weETH", "rETH", "mETH", "ETHx", "cbETH", "frxETH", "sfrxETH"],
    notes: {
      WETH: "wrapped ether, 1:1 with ETH",
      wstETH: "wrapped stETH, about 1.2 stETH each",
      weETH: "wrapped eETH, worth more than 1 eETH each",
      sfrxETH: "staked frxETH, worth more than 1 frxETH each",
    },
  },
  {
    id: "sol",
    members: ["SOL", "wSOL", "JitoSOL", "JupSOL", "mSOL", "bSOL", "stSOL"],
    notes: { wSOL: "SOL held in a token account; Kletia spends and delivers native SOL" },
  },
  {
    id: "usdc",
    members: ["USDC", "USDbC", "USDC.e"],
    notes: { USDbC: "the older bridged USDC on Base, a different token", "USDC.e": "bridged USDC, a different token from native USDC" },
  },
  {
    id: "usdt",
    members: ["USDT", "USDT0", "bridged USDT"],
    notes: { USDT0: "Tether's omnichain USDT, listed by address per network", "bridged USDT": "a bridged USDT, not the network's native USDT" },
  },
]);

const plain = (symbol: string): string => symbol.toUpperCase().replace(/[\s.-]/gu, "");

/** The family a typed symbol belongs to (case, dots, dashes and spaces ignored), or null. */
export function lookalikeFamilyOf(typed: string): LookalikeFamily | null {
  const key = plain(typed);
  return LOOKALIKE_FAMILIES.find((family) => family.members.some((member) => plain(member) === key)) ?? null;
}

// ------------------------------------------------------------ digits

/**
 * Registry words that contain digits: sent verbatim by the model-reading
 * masker and allowed in evidence (never a `<number_N>` placeholder). Listed
 * symbols with a digit, venue words with one, and network or venue words.
 */
export const DIGIT_TOKENS: readonly string[] = Object.freeze([...new Set([
  ...ASSETS.map((asset) => asset.symbol.toLowerCase()).filter((symbol) => /\d/u.test(symbol)),
  ...Object.keys(FOLLOW_UP_VENUE_WORDS).filter((word) => /\d/u.test(word)),
  "v2", "v3", "l1", "1inch", "x402",
])].sort());

// ------------------------------------------------------------ helpers

const normalisePhrase = (text: string): string => text.toLowerCase().replace(/\s+/gu, " ").trim();
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A whole-word pattern for a phrase ("?" and "~" match anywhere; "-ish" style suffixes too). */
export function phrasePattern(phrase: string): RegExp {
  const body = escape(normalisePhrase(phrase)).replace(/ /gu, "\\s+");
  if (/^[^a-z0-9]+$/u.test(phrase)) return new RegExp(body, "gu");
  if (phrase === "ish") return /(?:\b|-)ish\b/gu;
  return new RegExp(`(?<![\\w'])${body}(?![\\w'])`, "gu");
}

export interface ClosedClassHit {
  readonly phrase: string;
  /** A never-drop category, "unit" for a unit word after a number, "network" for an unsupported network or a qualifier. */
  readonly category: ClosedClassCategory | "unit" | "network";
  readonly start: number;
  readonly end: number;
  /** Rules that may consume it (empty for network hits: those always refuse NETWORK_UNSUPPORTED or name a supported lane). */
  readonly rules: readonly string[];
}

const NETWORK_POSITION = /(?:\b(?:on|to|from|onto|into|via|across|over)\s+(?:the\s+)?|\b(?:base|arbitrum|arb|ethereum|eth|optimism|op|polygon|solana|sol|arc)\s+)$/u;
/** A standalone number (not inside an address or a word), then an optional space, then a unit word. */
const UNIT_PATTERN = new RegExp(
  `(?<![\\w.])\\$?\\d+(?:[.,]\\d+)*(\\s?)(${Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\w])`,
  "gu",
);

/**
 * Every closed-class phrase in a lowercase message, with its offsets: never-
 * drop words, unit words directly after a number, unsupported networks in a
 * network position and lane qualifiers right after a network word. Longer
 * phrases win over the words inside them ("at least" over "least"); every
 * occurrence is reported. Used by the evaluation's conservation oracle and
 * the model-reading pre-filter; the reader records its own spans.
 */
export function scanClosedClass(text: string): ClosedClassHit[] {
  const value = text.toLowerCase();
  const hits: ClosedClassHit[] = [];
  const taken: [number, number][] = [];
  const free = (start: number, end: number) => taken.every(([a, b]) => end <= a || start >= b);
  const add = (hit: ClosedClassHit) => {
    if (!free(hit.start, hit.end)) return;
    taken.push([hit.start, hit.end]);
    hits.push(hit);
  };
  const neverDrop = [...NEVER_DROP].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const entry of neverDrop) {
    for (const match of value.matchAll(phrasePattern(entry.phrase))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (entry.beforeAmount && !/^\s*\$?\d/u.test(value.slice(end))) continue;
      add({ phrase: entry.phrase, category: entry.category, start, end, rules: entry.rules });
    }
  }
  for (const match of value.matchAll(UNIT_PATTERN)) {
    const word = match[2] as string;
    const unit = UNIT_WORDS[word] as UnitWord;
    if (match[1] === "" && !unit.glued) continue;
    const start = (match.index ?? 0) + match[0].length - word.length;
    add({ phrase: word, category: "unit", start, end: start + word.length, rules: [`unit:${unit.unit}`, "refuse:unit"] });
  }
  const networkPhrases = Object.keys(UNSUPPORTED_NETWORKS).sort((a, b) => b.length - a.length);
  for (const phrase of networkPhrases) {
    for (const match of value.matchAll(phrasePattern(phrase))) {
      const start = match.index ?? 0;
      if ((UNSUPPORTED_NETWORKS[phrase] as UnsupportedNetwork).commonWord && !NETWORK_POSITION.test(value.slice(0, start))) continue;
      add({ phrase, category: "network", start, end: start + match[0].length, rules: [] });
    }
  }
  for (const [word, qualifier] of Object.entries(NETWORK_QUALIFIERS)) {
    for (const match of value.matchAll(phrasePattern(word))) {
      const start = match.index ?? 0;
      const before = /([a-z]+)[\s-]+$/u.exec(value.slice(0, start))?.[1];
      if (!before || !/^(?:base|arbitrum|arb|ethereum|eth|optimism|op|polygon|solana|sol|arc|bnb|avalanche|linea|scroll|blast|zksync)$/u.test(before)) continue;
      if (qualifier.supportedAfter.includes(before)) continue;
      add({ phrase: `${before} ${word}`, category: "network", start, end: start + match[0].length, rules: [] });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}
