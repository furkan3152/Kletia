/**
 * The portfolio assistant (`POST /v1/assistant/ask`, docs/platform/assistant.md):
 * questions about a person's own wallets are answered from the data API's
 * reads, never planned; portfolio requests that want action become ordinary
 * desk sentences built from the real holdings, which go through the normal
 * plan, confirm and sign flow.
 *
 * Shared by the API, the SDK and the desk: the request and answer shapes and
 * `assistantRouteOf`, which tells a question or a portfolio request apart
 * from an instruction the sentence reader plans.
 */
import type { DataLane, DataSource } from "./data.js";
import type { NetworkKey } from "./chains.js";
import type { ProtocolId } from "./protocols.js";

/** What the assistant does with a sentence. */
export type AssistantRoute =
  /** A question about the person's own wallets, positions or activity: answered from data. */
  | "portfolio-question"
  /** A portfolio request that wants action ("rebalance my portfolio to 60/40 ETH/USDC"): turned into sentences to plan. */
  | "portfolio-action"
  /** A market question not about the person ("what's the price of ETH"): answered from market data. */
  | "market-question";

export type AssistantTxKind = "swap" | "bridge" | "transfer" | "deposit" | "withdraw" | "stake" | "unstake" | "borrow" | "repay" | "claim" | "other";
export const ASSISTANT_TX_KINDS: readonly AssistantTxKind[] = Object.freeze(["swap", "bridge", "transfer", "deposit", "withdraw", "stake", "unstake", "borrow", "repay", "claim", "other"]);

/** Named time windows (UTC); the API resolves them against its clock. `month` names a calendar month, `last_days` a count of days. */
export type AssistantWindowName =
  | "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "month"
  | "last_days" | "this_year" | "last_year" | "all";
export const ASSISTANT_WINDOW_NAMES: readonly AssistantWindowName[] = Object.freeze([
  "today", "yesterday", "this_week", "last_week", "this_month", "last_month", "month", "last_days", "this_year", "last_year", "all",
]);

export interface AssistantWindow {
  readonly name: AssistantWindowName;
  /** ISO start (inclusive); null for "all". */
  readonly from: string | null;
  /** ISO end (exclusive). */
  readonly to: string;
  /** "October 2026", "this week (since 19 Oct 2026)". */
  readonly label: string;
  /** `last_days`: the number of days (1 to 365). */
  readonly days?: number;
  /** True when the question did not say a window and the assistant chose this one (said in the answer). */
  readonly assumed?: true;
}

export type AssistantSubject =
  | "summary" | "holdings" | "positions" | "health" | "transactions" | "fees" | "pnl" | "earnings" | "allocation" | "prices" | "yields";
export const ASSISTANT_SUBJECTS: readonly AssistantSubject[] = Object.freeze([
  "summary", "holdings", "positions", "health", "transactions", "fees", "pnl", "earnings", "allocation", "prices", "yields",
]);

export type AssistantAggregate = "list" | "total" | "top" | "bottom" | "count" | "exists";
export const ASSISTANT_AGGREGATES: readonly AssistantAggregate[] = Object.freeze(["list", "total", "top", "bottom", "count", "exists"]);

/** The typed query the planner runs (deterministic parser, or a model reading checked against this shape). */
export interface AssistantQuery {
  readonly subject: AssistantSubject;
  readonly filter: {
    readonly kinds?: readonly AssistantTxKind[];
    /** Upper-case symbols. */
    readonly assets?: readonly string[];
    /** Networks a transaction or holding is on. */
    readonly networks?: readonly NetworkKey[];
    /** Destination networks of a bridge ("to Solana"). */
    readonly destinations?: readonly NetworkKey[];
    readonly protocols?: readonly ProtocolId[];
  };
  readonly window?: AssistantWindow;
  readonly aggregate: AssistantAggregate;
  readonly by?: "asset" | "network" | "protocol";
  readonly limit?: number;
}

export type AssistantFactUnit = "usd" | "count" | "fraction" | "amount" | "ratio" | "date" | "text";

/** One computed number or value an answer may state, with where it comes from. */
export interface AssistantFact {
  readonly id: string;
  readonly label: string;
  /** As shown ("$1,234.56", "0.05 ETH", "1.82", "12.4%"). */
  readonly value: string;
  /** The number behind `value`; null for text and dates. */
  readonly number: number | null;
  readonly unit: AssistantFactUnit;
  readonly source: DataSource | "chain";
  readonly asOf: string | null;
}

export interface AssistantTable {
  readonly columns: readonly { readonly key: string; readonly label: string; readonly numeric?: true }[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export interface AssistantChart {
  readonly kind: "bar";
  readonly label: string;
  readonly unit: "usd" | "fraction";
  readonly points: readonly { readonly label: string; readonly value: number }[];
}

/** A portfolio request turned into desk sentences: each is planned, confirmed and signed as if typed. */
export interface AssistantAction {
  readonly goal: "rebalance" | "sell" | "best-yield" | "exit";
  readonly summary: string;
  /** Sentences in the reader's words with amounts from the data ("swap 0.0123 ETH to USDC on base"). */
  readonly sentences: readonly string[];
}

export type AssistantStatus =
  /** Every number the question needs was read. */
  | "answered"
  /** Some data could not be read: the answer covers the known part and says what is missing. */
  | "partial"
  /** The data needed is not available: nothing is invented. */
  | "unknown"
  /** Not answered (someone else's wallet, keys, unsupported). */
  | "refused"
  /** The deterministic reader could not read the question and the model is off or not allowed. */
  | "needs-model";

export interface AssistantWalletLabel {
  readonly label: string;
  readonly address: string;
  readonly vm: "evm" | "solana";
}

export interface AssistantAnswer {
  readonly route: AssistantRoute | null;
  readonly status: AssistantStatus;
  readonly text: string;
  readonly facts: readonly AssistantFact[];
  readonly query: AssistantQuery | null;
  readonly table?: AssistantTable;
  readonly chart?: AssistantChart;
  readonly followUps: readonly string[];
  readonly action?: AssistantAction;
  /** What the assistant chose because the question did not say it (a window, a network). */
  readonly assumptions: readonly string[];
  /** Data that could not be read or is not available. */
  readonly gaps: readonly string[];
  /** `model` only when a model worded the answer and every number in it matched the facts. */
  readonly wording: "template" | "model";
  /** How the question was read: Kletia's parser, or a model reading checked against the query shape. */
  readonly understoodBy: "parser" | "model" | null;
  readonly wallets: readonly AssistantWalletLabel[];
  readonly asOf: string;
}

export interface AssistantAskRequest {
  readonly question: string;
  /** The wallets asked about (API keys). A desk wallet session answers for its own wallet. */
  readonly wallets?: { readonly evm?: readonly string[]; readonly solana?: readonly string[]; readonly lane?: DataLane };
  /** Opt in to the model steps (understanding and wording); off by default. */
  readonly model?: "on" | "off";
  /** A session consent token (desk), see POST /v1/assistant/consent. */
  readonly consent?: string;
}

export const ASSISTANT_LIMITS = Object.freeze({ questionChars: 500, followUps: 3, sentences: 6, tableRows: 12 });

/* ------------------------------------------------------------ routing */

/** Portfolio requests that want action, each the start of the sentence or a whole phrase. */
const ACTION_REQUESTS: readonly RegExp[] = [
  /^(?:please\s+)?rebalance\s+(?:my\s+)?(?:portfolio|holdings|wallet|bag)?\s*(?:to|into|as)?\s*\d{1,3}\s*(?:%|\/)/u,
  /^(?:please\s+)?rebalance\s+my\s+(?:portfolio|holdings|wallet)\b/u,
  /\b(?:sell|dump|exit|close)\s+(?:out\s+of\s+)?my\s+(?:worst|best|weakest|strongest|top)[\s-]+(?:performer|performing\s+(?:asset|token|holding|position)|asset|token|holding|loser|winner)s?\b/u,
  /^(?:sell|dump)\s+my\s+(?:losers|winners|losing\s+(?:assets|tokens|positions))\b/u,
  /^(?:move|put|park|send|deploy)\s+(?:all\s+(?:of\s+)?)?my\s+idle\s+(?:stables|stablecoins|cash|usdc|usdt|dai|dollars|funds|money)\b.*\b(?:best|highest|top)\s+(?:yield|apy|rate|interest)\b/u,
  /^(?:close|exit|unwind|sell|dump)\s+(?:everything|all(?:\s+of)?(?:\s+my)?(?:\s+(?:positions|holdings|assets))?)\s+(?:that(?:'s|\s+is)\s+)?(?:risky|volatile)\b/u,
  /^(?:close|exit|unwind|sell|dump)\s+(?:all\s+)?(?:of\s+)?my\s+(?:risky|volatile)\s+(?:positions|assets|holdings|tokens|stuff)\b/u,
  /^de-?risk\s+my\s+(?:portfolio|holdings|wallet)\b/u,
];

/** Verbs that start an instruction the sentence reader plans as typed. */
const ACTION_VERB = /^(?:please\s+)?(?:swap|bridge|send|transfer|deposit|supply|lend|stake|unstake|withdraw|buy|sell|borrow|repay|move|put|pay|wrap|unwrap|convert|exchange|trade|long|short|open|close|claim|earn|make|keep|get|give|top|fund|prepare|exit|go|hold|park|rebalance|split|cancel|set|create|schedule|dca|limit)\b/u;
const QUESTION_OPENER = /^(?:what|whats|what's|how|which|did|do|does|have|has|had|was|were|when|where|why|is|are|am|can\s+you\s+(?:tell|show|list|summari[sz]e)|could\s+you\s+(?:tell|show|list)|tell\s+me|show(?:\s+me)?|list|summari[sz]e|give\s+me\s+(?:a\s+)?(?:summary|breakdown|overview)|display|break\s+down|explain|any)\b/u;
const PERSONAL = /\b(?:my|mine|i|i've|ive|i'm|im|i'd|me|myself|our|ours|we)\b/u;
const DATA_WORDS = /\b(?:portfolio|balances?|holdings?|hold|have|own|worth|net\s+worth|value|positions?|loans?|debts?|borrow(?:ed|ing)?|health|fees?|gas|spen[dt]|paid|pay|earn(?:ed|ings)?|made|pnl|p&l|profits?|loss(?:es)?|lost|gains?|gained|performance|perform(?:ed|ing)?|performers?|trades?|traded|swaps?|swapped|bridges?|bridged|transactions?|txs?|transfers?|transferred|deposits?|deposited|withdrawals?|withdrew|history|activity|allocation|exposure|staking|staked|stakes?|rewards?|yields?|apys?|assets?|tokens?|coins?|wallets?|sent|received|bought|sold|summary|overview|breakdown|biggest|largest|smallest|top|worst|best|stables?|stablecoins?|eth|sol|usdc|usdt|btc)\b/u;
const MARKET_WORDS = /\b(?:price|prices|trading\s+at|cost|costs|worth|market|yields?|apys?|aprs?|rates?)\b/u;
const ADDRESS_OR_NAME = /\b0x[0-9a-f]{40}\b|\b[1-9a-hj-np-z]{32,44}\b|\b[a-z0-9-]+\.(?:eth|sol|base\.eth)\b/iu;

/**
 * Whether a sentence is for the assistant, and how; null for an instruction
 * (or anything else) the sentence reader handles. A sentence that starts
 * with an action verb ("swap 1 SOL to USDC", "sell all my SOL?") is never a
 * question here: the reader plans it, or refuses it for its question mark.
 */
export function assistantRouteOf(text: string): AssistantRoute | null {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > ASSISTANT_LIMITS.questionChars) return null;
  // "what's the best yield for my USDC? put it there": a later clause is an instruction for the reader.
  const clauses = raw.toLowerCase().split(/[?¿？﹖⸮.!;]+/u).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.slice(1).some((clause) => ACTION_VERB.test(clause))) return null;
  const questionMark = /[?¿？﹖⸮]/u.test(raw);
  const sentence = raw.toLowerCase().replace(/[’`]/gu, "'").replace(/[?¿？﹖⸮.!]+$/gu, "").replace(/\s+/gu, " ").trim().replace(/^(?:hey|hi|hello|ok|okay|so|kletia)[,!\s]+/u, "");
  if (ACTION_REQUESTS.some((pattern) => pattern.test(sentence))) return "portfolio-action";
  const asks = questionMark || QUESTION_OPENER.test(sentence) || /^my\s/u.test(sentence);
  // An instruction stays the reader's, with or without a question mark (the reader refuses "swap ...?").
  if (!asks || ACTION_VERB.test(sentence)) return null;
  if ((PERSONAL.test(sentence) || ADDRESS_OR_NAME.test(raw)) && DATA_WORDS.test(sentence)) return "portfolio-question";
  if (MARKET_WORDS.test(sentence)) return "market-question";
  return null;
}
