/**
 * The deterministic question reader: a sentence about the person's own data
 * (or the market) read into the typed `AssistantQuery`, or null when no
 * rule reads it (the model step may then try, under consent). Words only;
 * nothing here reads data.
 *
 * Entities: assets (listed symbols, "bitcoin" -> cbBTC), networks (names;
 * "sol", "op" only after on/to/from/in), protocols (venue words, plus the
 * perps, order and prediction venues), activity kinds ("bridged" -> bridge,
 * "bet" -> prediction, "reverted" -> failed) and a time window (windows.ts).
 * The subject is the first rule that matches, in the order of SUBJECT_RULES:
 * open perps, orders, automations and prediction positions are read from the
 * positions' extras, unless the question asks about activity in a window
 * ("did I bet on Polymarket this week"), which the history answers.
 */
import {
  ASSETS,
  FOLLOW_UP_VENUE_WORDS,
  resolveChain,
  type AssistantAggregate,
  type AssistantQuery,
  type AssistantRoute,
  type AssistantSubject,
  type AssistantTxKind,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { windowPhrase, type WindowSpec } from "./windows.js";

/** Listed symbols by lower-case spelling ("jitosol" -> "JitoSOL"), plus everyday names. */
export const SYMBOLS: ReadonlyMap<string, string> = new Map([
  ...ASSETS.map((asset) => [asset.symbol.toLowerCase(), asset.symbol] as const),
  ["ether", "ETH"], ["btc", "cbBTC"], ["bitcoin", "cbBTC"], ["usd coin", "USDC"], ["tether", "USDT"],
]);
/** Network words that are never an asset. */
const PLAIN_NETWORKS = /\b(base|arbitrum(?:\s+one)?|ethereum|polygon|optimism|solana|arc(?:\s+testnet)?|arbitrum\s+sepolia|solana\s+devnet|mainnet)\b/gu;
/** Network words that are also asset symbols: a network only after a preposition ("sol" and "eth" stay assets: "lose on eth"). */
const PREPOSITION_NETWORK = /\b(?:on|to|from|in|across|onto|into|via)\s+(op|arb|matic)\b/gu;

export interface ParsedEntities {
  readonly assets: string[];
  readonly networks: NetworkKey[];
  readonly destinations: NetworkKey[];
  readonly protocols: ProtocolId[];
  readonly kinds: AssistantTxKind[];
  readonly window: WindowSpec | null;
  /** The sentence without the window phrase. */
  readonly rest: string;
}

const KIND_WORDS: readonly [RegExp, AssistantTxKind][] = [
  [/\b(?:swaps?|swapped|swapping|trades?|traded|trading|bought|buys?|sold|sells?)\b/u, "swap"],
  [/\b(?:bridges?|bridged|bridging)\b/u, "bridge"],
  [/\b(?:sent|send|sends|transfers?|transferred|received|receive|receives|payments?|paid\s+(?!.*\bfees?\b))\b/u, "transfer"],
  [/\b(?:deposits?|deposited|supplied|supply|lent|lend)\b/u, "deposit"],
  [/\b(?:withdrawals?|withdrew|withdrawn|withdraw)\b/u, "withdraw"],
  [/\b(?:unstaked?|unstaking)\b/u, "unstake"],
  [/\b(?:staked?|staking)\b/u, "stake"],
  [/\b(?:borrowed|borrows?)\b/u, "borrow"],
  [/\b(?:repaid|repay|repayments?)\b/u, "repay"],
  [/\b(?:claimed|claims?)\b/u, "claim"],
  [/\b(?:perps?|perpetuals?|futures|leveraged)\b/u, "perp"],
  [/\b(?:orders?|twaps?)\b/u, "order"],
  [/\b(?:bets?|betted|betting|wagers?|wagered|predictions?|polymarket)\b/u, "prediction"],
  [/\b(?:approvals?|approved|approve|allowances?)\b/u, "approve"],
  [/\b(?:failed|fail|fails|reverted|failures?)\b/u, "failed"],
];

/** Venues of perps, native orders and prediction markets (the follow-up venue words cover spot venues). */
const EXTRA_VENUES: readonly [RegExp, ProtocolId][] = [
  [/\bpolymarket\b/u, "polymarket"],
  [/\bgmx\b/u, "gmx-v2"],
  [/\bhyperliquid\b/u, "hyperliquid"],
  [/\bdrift\b/u, "drift-v2"],
  [/\bcow(?:\s+(?:protocol|swap))?\b/u, "cow-protocol"],
];

function networkOf(word: string): NetworkKey | null {
  const value = word.replace(/\s+/gu, " ");
  if (value === "eth" || value === "mainnet") return "ethereum";
  return resolveChain(value)?.key ?? resolveChain(value.replace(/ /gu, "-"))?.key ?? null;
}

/** The entities a sentence names (lower-case, punctuation stripped). */
export function entitiesOf(sentence: string): ParsedEntities {
  const window = windowPhrase(sentence);
  const rest = window ? sentence.replace(window.phrase, " ").replace(/\s+/gu, " ").trim() : sentence;
  const networks: NetworkKey[] = [];
  const destinations: NetworkKey[] = [];
  const networkSpans: [number, number][] = [];
  const addNetwork = (word: string, index: number, length: number) => {
    const network = networkOf(word);
    if (!network) return;
    networkSpans.push([index, index + length]);
    const before = rest.slice(Math.max(0, index - 6), index);
    const list = /\b(?:to|onto|into)\s+$/u.test(before) ? destinations : networks;
    if (!list.includes(network)) list.push(network);
  };
  for (const match of rest.matchAll(PLAIN_NETWORKS)) addNetwork(match[1] as string, match.index ?? 0, match[0].length);
  for (const match of rest.matchAll(PREPOSITION_NETWORK)) {
    const word = match[1] as string;
    addNetwork(word, (match.index ?? 0) + match[0].length - word.length, word.length);
  }
  const assets: string[] = [];
  for (const match of rest.matchAll(/[a-z0-9][a-z0-9.]*/gu)) {
    const start = match.index ?? 0;
    if (networkSpans.some(([from, to]) => start >= from && start < to)) continue;
    const pair = /^usd coin\b/u.test(rest.slice(start)) ? "usd coin" : match[0];
    const symbol = SYMBOLS.get(pair);
    if (symbol && !assets.includes(symbol)) assets.push(symbol);
  }
  const protocols: ProtocolId[] = [];
  for (const [word, entry] of Object.entries(FOLLOW_UP_VENUE_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(rest) && !protocols.includes(entry.protocol)) protocols.push(entry.protocol);
  }
  for (const [pattern, protocol] of EXTRA_VENUES) if (pattern.test(rest) && !protocols.includes(protocol)) protocols.push(protocol);
  // "aero" and "jup" are tokens first; the venue reading needs the venue's full name.
  const venueOnly = protocols.filter((protocol) => !(protocol === "aerodrome" && assets.includes("AERO") && !/\baerodrome\b/u.test(rest)) && !(protocol === "jupiter" && assets.includes("JUP") && !/\bjupiter\b/u.test(rest)));
  const kinds = KIND_WORDS.filter(([pattern]) => pattern.test(rest)).map(([, kind]) => kind);
  return { assets, networks, destinations, protocols: venueOnly, kinds, window: window?.spec ?? null, rest };
}

/* ------------------------------------------------------------ subjects */

const BIGGEST = /\b(?:biggest|largest|top|most\s+valuable|main)\b/u;
const SMALLEST = /\b(?:smallest|least\s+valuable|tiniest)\b/u;
const LOST = /\b(?:lost|losing|loser|losers|worst|down\s+the\s+most|dropped|fell|declined|underperform\w*|(?:biggest|largest)\s+loss(?:es)?)\b/u;
/** Activity words: with a window and a yes/no or count shape, a perps, order or bet question is about the history. */
const ACTIVITY = /\b(?:transactions?|txs?|history|activity|activities|trades?|traded|placed|opened)\b/u;
const asksActivity = (s: string, e: ParsedEntities) => ACTIVITY.test(s) || (e.window !== null && /^(?:did|have|has|had|how\s+many|when)\b/u.test(s));
const PNL_WORDS = /\b(?:pnl|p&l|profits?|loss(?:es)?|gains?|up|down|making|made|lost|lose)\b/u;
const GAINED = /\b(?:gained|gaining|winner|winners|best|up\s+the\s+most|rose|grew|outperform\w*)\b/u;

interface Rule {
  readonly subject: AssistantSubject;
  readonly test: (s: string, e: ParsedEntities) => boolean;
  readonly aggregate: (s: string, e: ParsedEntities) => AssistantAggregate;
  readonly by?: (s: string, e: ParsedEntities) => AssistantQuery["by"];
}

const SUBJECT_RULES: readonly Rule[] = [
  {
    subject: "fees",
    test: (s) => /\b(?:fees?|gas)\b/u.test(s),
    aggregate: () => "total",
  },
  {
    subject: "exposure",
    test: (s) => /\b(?:exposure|exposed)\b/u.test(s),
    aggregate: () => "list",
  },
  {
    subject: "predictions",
    test: (s, e) => e.kinds.includes("prediction") && !asksActivity(s, e),
    aggregate: (s) => (PNL_WORDS.test(s) || /\bhow\s+much\b/u.test(s) ? "total" : "list"),
  },
  {
    subject: "perps",
    test: (s, e) => e.kinds.includes("perp") && !asksActivity(s, e),
    aggregate: (s) => (BIGGEST.test(s) ? "top" : PNL_WORDS.test(s) || /\bhow\s+much\b/u.test(s) ? "total" : "list"),
  },
  {
    subject: "orders",
    test: (s, e) => e.kinds.includes("order") && !asksActivity(s, e),
    aggregate: (s) => (/\bhow\s+many\b/u.test(s) ? "count" : "list"),
  },
  {
    subject: "automations",
    test: (s) => /\b(?:automations?|automated|recurring\s+(?:buys?|swaps?|orders?)|dca)\b/u.test(s),
    aggregate: (s) => (/\bhow\s+many\b/u.test(s) ? "count" : "list"),
  },
  {
    subject: "health",
    test: (s) => /\b(?:loans?|debts?|borrow(?:ed|ing|s)?|health(?:\s+factor)?|liquidat\w*|collateral|ltv)\b/u.test(s) && !/\bhow\s+much\s+did\s+i\s+borrow\b/u.test(s),
    aggregate: () => "list",
  },
  {
    subject: "earnings",
    test: (s) => /\b(?:earn(?:ed|ings)?|rewards?|interest\s+(?:earned|received|made)|yield\s+(?:earned|received|made))\b/u.test(s) || (/\b(?:made|make)\b/u.test(s) && /\b(?:staking|lending|yield|interest|supply)\b/u.test(s)),
    aggregate: () => "total",
  },
  {
    subject: "pnl",
    test: (s) => /\b(?:pnl|p&l|profits?|loss(?:es)?|perform(?:ed|ing|ance)?|performers?|gain(?:ed|s)?)\b/u.test(s) || LOST.test(s) || (GAINED.test(s) && /\b(?:assets?|tokens?|coins?|holdings?)\b/u.test(s)) || /\bhow\s+much\s+(?:did\s+i|have\s+i)\s+(?:made|make|lose|lost)\b/u.test(s) || /\bhow\s+(?:is|was|has)\s+my\s+(?:portfolio|wallet|bag)\s+(?:doing|done|been\s+doing)\b/u.test(s),
    aggregate: (s, e) => (LOST.test(s) ? "bottom" : GAINED.test(s) ? "top" : e.assets.length > 0 || /\b(?:assets?|tokens?|coins?|holdings?)\b/u.test(s) ? "list" : "total"),
    by: (s, e) => (e.assets.length > 0 || /\b(?:assets?|tokens?|coins?|holdings?|performers?)\b/u.test(s) || LOST.test(s) || GAINED.test(s) ? "asset" : undefined),
  },
  {
    subject: "transactions",
    test: (s, e) => e.kinds.length > 0 || /\b(?:transactions?|txs?|history|activity|activities)\b/u.test(s),
    aggregate: (s) => (/^(?:did|have|has|had|was|were)\b|\bany\b/u.test(s) ? "exists" : /\bhow\s+many\b/u.test(s) ? "count" : /\bhow\s+much\b/u.test(s) ? "total" : /\b(?:last|latest|most\s+recent)\s+(?:transaction|swap|trade|bridge|deposit|transfer)\b/u.test(s) ? "top" : "list"),
  },
  {
    subject: "allocation",
    test: (s) => /\b(?:allocation|allocated|split|breakdown|broken\s+down|distribution|distributed|spread|diversif\w*|concentrat\w*)\b/u.test(s),
    aggregate: () => "list",
    by: (s) => (/\b(?:networks?|chains?)\b/u.test(s) ? "network" : /\b(?:protocols?|venues?|platforms?)\b/u.test(s) ? "protocol" : "asset"),
  },
  {
    subject: "positions",
    // "show my positions", "what do i have in aave": venue positions (the biggest one is a holdings question).
    test: (s, e) => (/\bpositions?\b/u.test(s) && !BIGGEST.test(s) && !SMALLEST.test(s)) || (e.protocols.length > 0 && e.kinds.length === 0),
    aggregate: () => "list",
  },
  {
    subject: "holdings",
    test: (s, e) =>
      /\b(?:balances?|holdings?|hold|have|own|got|bag|tokens?|assets?|coins?|positions?)\b/u.test(s) || (e.assets.length > 0 && /\bhow\s+much\b/u.test(s)),
    aggregate: (s, e) => (BIGGEST.test(s) ? "top" : SMALLEST.test(s) ? "bottom" : e.assets.length > 0 || /\bhow\s+much\b/u.test(s) ? "total" : "list"),
  },
  {
    subject: "summary",
    test: (s) => /\b(?:portfolio|net\s+worth|worth|total\s+value|overview|summary|summari[sz]e|wallets?|value)\b/u.test(s),
    aggregate: () => "total",
  },
];

const MARKET_RULES: readonly Rule[] = [
  { subject: "yields", test: (s) => /\b(?:yields?|apys?|aprs?|rates?|interest)\b/u.test(s), aggregate: () => "top" },
  { subject: "prices", test: (s, e) => e.assets.length > 0 && /\b(?:price|prices|trading\s+at|cost|costs|worth|value)\b/u.test(s), aggregate: () => "list" },
];

export interface ParsedQuestion {
  readonly query: Omit<AssistantQuery, "window">;
  readonly window: WindowSpec | null;
}

/** Normalised words of a sentence: lower case, apostrophes unified, trailing punctuation and greetings dropped. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/gu, "'")
    .replace(/[?¿？﹖⸮!]+/gu, " ")
    .replace(/[,;:()"]/gu, " ")
    .replace(/\.(?=\s|$)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:hey|hi|hello|ok|okay|so|kletia)\s+/u, "")
    .replace(/^(?:please\s+)?(?:can|could)\s+you\s+(?:please\s+)?/u, "");
}

/** "what did I send" counts what left, "what did I receive" what arrived; "transfers" both. */
function directionOf(sentence: string): { readonly direction?: "out" | "in" } {
  const out = /\b(?:sent|send|sends|paid)\b/u.test(sentence);
  const into = /\b(?:received|receive|receives|got)\b/u.test(sentence);
  return out === into ? {} : { direction: out ? "out" : "in" };
}

/** "my failed swaps" is about failed transactions: the kind they tried no longer narrows them. */
function activityKinds(kinds: readonly AssistantTxKind[]): AssistantTxKind[] {
  if (kinds.includes("failed")) return ["failed"];
  // "my perp trades": "trades" names the venue's own kind, not a spot swap.
  return kinds.some((kind) => kind === "perp" || kind === "order" || kind === "prediction") ? kinds.filter((kind) => kind !== "swap") : [...kinds];
}

/** The typed query of a question, or null when no rule reads it. */
export function parseQuestion(text: string, route: AssistantRoute): ParsedQuestion | null {
  const sentence = normalizeQuestion(text);
  const entities = entitiesOf(sentence);
  const rules = route === "market-question" ? MARKET_RULES : SUBJECT_RULES;
  const rule = rules.find((candidate) => candidate.test(entities.rest, entities));
  if (!rule) return null;
  const filter: AssistantQuery["filter"] = {
    ...(entities.kinds.length > 0 && (rule.subject === "transactions" || rule.subject === "fees" || rule.subject === "earnings") ? { kinds: activityKinds(entities.kinds) } : {}),
    ...(entities.assets.length > 0 ? { assets: entities.assets } : {}),
    ...(entities.networks.length > 0 ? { networks: entities.networks } : {}),
    ...(entities.destinations.length > 0 ? { destinations: entities.destinations } : {}),
    ...(entities.protocols.length > 0 ? { protocols: entities.protocols } : {}),
    ...(rule.subject === "transactions" && entities.kinds.includes("transfer") ? directionOf(entities.rest) : {}),
  };
  const aggregate = rule.aggregate(entities.rest, entities);
  const by = rule.by?.(entities.rest, entities);
  const top = /\b(?:top|biggest|largest|worst|best)\s+(\d{1,2})\b/u.exec(entities.rest);
  const limit = top ? Math.min(Number(top[1]), 12) : /\b(?:biggest|largest|smallest|worst|best|top|most|least)\b/u.test(entities.rest) ? 1 : undefined;
  return {
    query: { subject: rule.subject, filter, aggregate, ...(by ? { by } : {}), ...(limit !== undefined && (aggregate === "top" || aggregate === "bottom") ? { limit } : {}) },
    window: entities.window,
  };
}
