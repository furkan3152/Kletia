/**
 * The Goal reader's vocabulary (intent engine v2 §3.2): fillers, goal verbs,
 * connectors, holder words, asset classes and the venue / network words. The
 * venue, network and symbol words come from the grammar and the registry
 * (GRAMMAR_VENUE_WORDS, the chain aliases, ASSETS), so a new protocol or
 * asset is read without an edit here. The lists of its own are readings of
 * plain English words.
 *
 * Fail closed: a word that is not in this vocabulary (and is not a number,
 * symbol, network, venue, address or name) is NOISE, and a clause with NOISE
 * is never read as a Goal ("borrow", "don't", "leverage", "bitcoin").
 */
import type { AssetClass, ClarifyStepKind, GoalKind } from "@kletia/core";

/** Phrases dropped at the start of a clause ("hey could you ...", "i need to ..."), longest first after sorting. */
export const LEADING_FILLERS: readonly string[] = [
  "hey", "hi", "yo", "ok", "okay", "so", "um", "uh", "please", "pls", "plz", "kindly", "kletia",
  "i need to", "i wanna", "i want to", "i would like to", "id like to", "i'd like to", "i'd love to", "i would love to",
  "can you", "could you", "would you", "will you", "can u", "could u", "help me", "help me to", "lets", "let's", "let us",
  "just", "first", "firstly", "quickly", "go ahead and", "now", "then", "also", "and",
];

/** Phrases dropped at the end of a clause ("... for me please", "... real quick"). */
export const TRAILING_FILLERS: readonly string[] = [
  "for me", "please", "pls", "plz", "thanks", "thank you", "thx", "real quick", "quickly", "now", "right now", "asap", "for me please",
];

/**
 * Words that never change what a clause means (dropped as tokens anywhere).
 * "over" is not one: "swap over 100 USDC" sets a limit, so an unread "over"
 * keeps the clause unread (design A.2, red-team A2). "over to" and "over
 * from" are connector spellings (CONNECTOR_VARIANTS).
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  "some", "just", "kindly", "please", "pls", "actually", "real", "quick", "idle", "spare", "worth", "somewhere", "something",
]);

/** Connector spellings read as the connector they spell ("move 25 USDC from base over to solana"); reviewed lexicon entries, not corrections. */
export const CONNECTOR_VARIANTS: Readonly<Record<string, string>> = Object.freeze({
  "over to": "to",
  "over from": "from",
});

export type ObjectRole = "spend" | "want";

export interface VerbEntry {
  /** The goal the verb names. */
  readonly kind: GoalKind;
  /** The canonical step kind the verb is a constraint on, when it names one. */
  readonly op?: ClarifyStepKind;
  /** What the direct object is: the asset spent ("swap 1 SOL") or the asset wanted ("buy SOL", "get me 1 ETH"). */
  readonly object: ObjectRole;
  /** "buy": the strict reader's buy flag (the output is the object). */
  readonly buy?: true;
  /** "sell": the output may be a stablecoin the person did not name. */
  readonly sell?: true;
  /** A verb that needs an earn marker to mean earn ("put my USDC to work", "make my SOL earn"). */
  readonly needsWork?: true;
  /** "exit", "close", "take out": the whole position unless an amount is said. */
  readonly whole?: true;
}

/**
 * Goal verbs (§3.2 table) by their word or phrase. The canonical verbs keep
 * their step kind as `op`; goal verbs leave the route to the solver.
 */
export const VERB_LEXICON: Readonly<Record<string, VerbEntry>> = Object.freeze({
  // convert
  swap: { kind: "convert", op: "swap", object: "spend" },
  convert: { kind: "convert", op: "swap", object: "spend" },
  trade: { kind: "convert", op: "swap", object: "spend" },
  exchange: { kind: "convert", op: "swap", object: "spend" },
  sell: { kind: "convert", op: "swap", object: "spend", sell: true },
  turn: { kind: "convert", object: "spend" },
  change: { kind: "convert", object: "spend" },
  flip: { kind: "convert", object: "spend" },
  dump: { kind: "convert", object: "spend", sell: true },
  "cash out": { kind: "convert", object: "spend", sell: true },
  "get rid of": { kind: "convert", object: "spend", sell: true },
  hedge: { kind: "convert", object: "spend" },
  diversify: { kind: "convert", object: "spend" },
  "go all in on": { kind: "convert", object: "want" },
  buy: { kind: "acquire", op: "swap", object: "want", buy: true },
  purchase: { kind: "acquire", op: "swap", object: "want", buy: true },
  // relocate
  bridge: { kind: "relocate", op: "bridge", object: "spend" },
  move: { kind: "relocate", object: "spend" },
  port: { kind: "relocate", op: "bridge", object: "spend" },
  ship: { kind: "relocate", object: "spend" },
  // deliver (a network destination makes send / transfer a relocate; frames decide)
  send: { kind: "deliver", object: "spend" },
  transfer: { kind: "deliver", object: "spend" },
  pay: { kind: "deliver", op: "transfer", object: "spend" },
  give: { kind: "deliver", op: "transfer", object: "spend" },
  tip: { kind: "deliver", op: "transfer", object: "spend" },
  // payment verbs (U2 RF12): money to someone else, read as a payment
  gift: { kind: "deliver", op: "transfer", object: "spend" },
  reimburse: { kind: "deliver", op: "transfer", object: "spend" },
  "pay back": { kind: "deliver", op: "transfer", object: "spend" },
  "settle up": { kind: "deliver", op: "transfer", object: "spend" },
  // earn
  stake: { kind: "earn", op: "stake", object: "spend" },
  "liquid stake": { kind: "earn", op: "stake", object: "spend" },
  deposit: { kind: "earn", op: "deposit", object: "spend" },
  supply: { kind: "earn", op: "deposit", object: "spend" },
  lend: { kind: "earn", op: "deposit", object: "spend" },
  invest: { kind: "earn", op: "deposit", object: "spend" },
  park: { kind: "earn", op: "deposit", object: "spend" },
  put: { kind: "earn", op: "deposit", object: "spend" },
  place: { kind: "earn", op: "deposit", object: "spend" },
  earn: { kind: "earn", object: "spend" },
  "earn yield on": { kind: "earn", object: "spend" },
  "earn yield with": { kind: "earn", object: "spend" },
  "earn interest on": { kind: "earn", object: "spend" },
  "earn on": { kind: "earn", object: "spend" },
  "get yield on": { kind: "earn", object: "spend" },
  "get interest on": { kind: "earn", object: "spend" },
  make: { kind: "earn", object: "spend", needsWork: true },
  zap: { kind: "earn", object: "spend" },
  // exit
  withdraw: { kind: "exit", op: "withdraw", object: "spend" },
  redeem: { kind: "exit", op: "withdraw", object: "spend" },
  exit: { kind: "exit", object: "spend", whole: true },
  close: { kind: "exit", object: "spend", whole: true },
  unwind: { kind: "exit", object: "spend", whole: true },
  take: { kind: "exit", object: "spend" },
  pull: { kind: "exit", object: "spend" },
  "take out": { kind: "exit", object: "spend" },
  "pull out": { kind: "exit", object: "spend" },
  // acquire
  get: { kind: "acquire", object: "want" },
  "get me": { kind: "acquire", object: "want" },
  need: { kind: "acquire", object: "want" },
  "i need": { kind: "acquire", object: "want" },
  want: { kind: "acquire", object: "want" },
  "i want": { kind: "acquire", object: "want" },
  "i want to hold": { kind: "acquire", object: "want" },
  hold: { kind: "acquire", object: "want" },
  "i want exposure to": { kind: "acquire", object: "want" },
  "want exposure to": { kind: "acquire", object: "want" },
  "get exposure to": { kind: "acquire", object: "want" },
  "exposure to": { kind: "acquire", object: "want" },
  "i'd like": { kind: "acquire", object: "want" },
  "id like": { kind: "acquire", object: "want" },
  acquire: { kind: "acquire", object: "want" },
  "top up": { kind: "fuel", object: "want" },
  fund: { kind: "acquire", object: "want" },
  // consolidate / rebalance
  consolidate: { kind: "consolidate", object: "spend" },
  gather: { kind: "consolidate", object: "spend" },
  sweep: { kind: "consolidate", object: "spend" },
  rebalance: { kind: "rebalance", object: "spend" },
  split: { kind: "rebalance", object: "spend" },
});

/** Verb phrases, longest first (the lexer matches the longest). */
export const VERB_PHRASES: readonly string[] = Object.keys(VERB_LEXICON).sort((a, b) => b.split(" ").length - a.split(" ").length || b.length - a.length);

/** Connectors (§3.2 CONN), multi-word first. */
export const CONNECTORS: readonly string[] = [
  "out of", "instead of", "in exchange for", "on top of",
  "from", "to", "into", "onto", "on", "in", "at", "with", "via", "using", "through", "for", "as", "and", "then", "of", "by",
];
export type Connector = (typeof CONNECTORS)[number];

/** Earn markers: "to work", "yield", "interest" (they make put / make / park mean earn). */
export const WORK_PHRASES: readonly string[] = ["to work", "earn yield", "earn interest", "earn", "yield", "interest", "with yield", "for yield"];

/** Venue phrases that leave the venue to the solver ("into the best yield", "somewhere safe"). */
export const BEST_VENUE_PHRASES: readonly string[] = ["the best yield", "best yield", "highest yield", "highest apy", "the highest apy", "best apy", "best rate", "safe",
  "the best provider", "best provider", "the best venue", "best venue", "the safest venue", "safest venue", "the safest provider", "safest provider"];

/** Asset classes ("my stablecoins", "gas"). */
export const CLASS_WORDS: Readonly<Record<string, AssetClass>> = Object.freeze({
  stables: "usd-stable", stablecoins: "usd-stable", stablecoin: "usd-stable", stable: "usd-stable", dollars: "usd-stable", dollar: "usd-stable", usd: "usd-stable",
  gas: "gas",
});

/** Holder words: the person themselves, another of their wallets, or a nickname (never resolved). */
export const HOLDER_WORDS: Readonly<Record<string, "self" | "selfOther" | "nickname">> = Object.freeze({
  me: "self", myself: "self", "my wallet": "self", "my own wallet": "self",
  "my other wallet": "selfOther", "my other account": "selfOther", "another wallet": "selfOther", "my second wallet": "selfOther",
  mom: "nickname", dad: "nickname", "my mom": "nickname", "my dad": "nickname", "my friend": "nickname", "my brother": "nickname", "my sister": "nickname",
  "my wife": "nickname", "my husband": "nickname", "a friend": "nickname",
});

/** Network aliases beyond the chain registry's ("eth mainnet"). */
export const NETWORK_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "eth mainnet": "ethereum", "ethereum one": "ethereum", "arb one": "arbitrum", "optimism one": "optimism", "poly": "polygon",
});

/** Preference words ("from whatever network is cheapest"). */
export const PREFERENCE_PHRASES: Readonly<Record<string, "cheapest" | "fastest" | "safest">> = Object.freeze({
  "whatever network is cheapest": "cheapest", "whichever network is cheapest": "cheapest", "the cheapest network": "cheapest", "cheapest": "cheapest",
  "the cheapest way": "cheapest", "fastest": "fastest", "the fastest way": "fastest", "safest": "safest",
});

/** Reference words (F9): the previous step's output. */
export const REFERENCE_WORDS: readonly string[] = ["it", "them", "that", "the proceeds", "the output", "the rest", "those"];

/** Number words (§3.2): units, teens, tens and scales, read up to 999,999. */
export const NUMBER_UNITS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
});
export const NUMBER_TENS: Readonly<Record<string, number>> = Object.freeze({
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});
export const NUMBER_SCALES: Readonly<Record<string, number>> = Object.freeze({ hundred: 100, thousand: 1000 });

/** Portion words and their basis points. */
export const PORTION_WORDS: Readonly<Record<string, number>> = Object.freeze({
  half: 5_000, "a half": 5_000, "one half": 5_000, quarter: 2_500, "a quarter": 2_500, "one quarter": 2_500, "three quarters": 7_500,
  third: 3_333, "a third": 3_333, "one third": 3_333, "two thirds": 6_667, "a tenth": 1_000, "one tenth": 1_000,
});

/**
 * Token-unit fractions (design A.2, red-team A4): a portion word followed by
 * "a"/"an" (or "of a"/"of an") and a token is an amount of that token, never
 * a share of the balance: "half a sol" is 0.5 SOL, "a quarter of an eth" is
 * 0.25 ETH. The value is exact; a fraction with no exact decimal ("a third
 * of a sol") is null and the clause is not read (asked again in words).
 */
export const TOKEN_UNIT_FRACTIONS: Readonly<Record<string, string | null>> = Object.freeze({
  half: "0.5", "a half": "0.5", "one half": "0.5", quarter: "0.25", "a quarter": "0.25", "one quarter": "0.25", "three quarters": "0.75",
  "a tenth": "0.1", "one tenth": "0.1",
  third: null, "a third": null, "one third": null, "two thirds": null,
});

/** Whole-balance words ("all", "everything I have in"). */
export const MAX_PHRASES: readonly string[] = [
  "everything i have in", "everything i have", "all i have in", "all i have", "all of", "everything", "all", "max", "the max", "the whole",
];

/** "all but 0.1", "everything except 0.5". */
export const ALL_BUT_PHRASES: readonly string[] = ["all but", "everything but", "all except", "everything except"];

/** Dollar unit words after a number ("50 dollars", "50 bucks"). */
export const USD_UNITS: ReadonlySet<string> = new Set(["dollars", "dollar", "bucks", "buck", "usd"]);

/**
 * Approximation words before an amount ("around 3", "about 50", "~3",
 * "close to 2"): the amount is asked, never read as the stated number
 * (design A.2 never-drop table, rule "amountVague:approx").
 */
export const APPROXIMATION_BEFORE: readonly string[] = [
  "close to", "around", "about", "approximately", "approx", "roughly", "circa", "nearly", "almost", "like", "~",
];

/** Approximation phrases after an amount ("3 sol or so", "50 usdc give or take", "3ish"). */
export const APPROXIMATION_AFTER: readonly string[] = ["give or take", "more or less", "or so", "ish"];

/**
 * Vague quantities before a token ("a couple of sol", "a few usdc", "a bit
 * of eth"): an amount was meant but not said, so it is asked (U2 RF7).
 */
export const VAGUE_QUANTITIES: readonly string[] = [
  "a little bit of", "a couple of", "a bunch of", "a handful of", "a bit of", "a couple", "a few", "a little", "a tad of",
];
