/**
 * Clarifying questions and per-task memory: the shapes of one
 * conversational turn on `POST /v1/intents?clarify=true`, the thread a
 * task remembers (`kletia.thread/v1`), their validators, the follow-up
 * grammar the composer uses to label a message before it is sent, and the
 * shared constants (reasons, limits, fee reserves, preview accounts).
 *
 * Pure types, constants and validators shared by the API, SDK, widget and
 * web. Nothing here reads the network; the engine (apps/api clarify/*)
 * decides questions and assumptions.
 */
import { isNetworkKey, resolveChain, type NetworkKey } from "./chains.js";
import { parseAccountId, sameAddressAccount, type AccountId } from "./caip.js";
import { ASSETS } from "./assets.js";
import type { IntentConstraints, IntentGraph } from "./intent.js";
import type { IntentPreview } from "./preview.js";
import type { ProtocolId } from "./protocols.js";
import {
  MAX_INTENT_ACTIONS,
  MAX_INTENT_TEXT_LENGTH,
  validateIntentContext,
  type ValidationIssue,
  type ValidationResult,
} from "./validation.js";

export const THREAD_SPEC = "kletia.thread/v1";
/** Bumped whenever a policy rule changes what a turn returns; a thread written by an older policy is re-analysed. */
export const CLARIFY_POLICY_VERSION = "2026-10.1";

export const THREAD_LIMITS = Object.freeze({
  /** Turn labels kept. */
  storedTurns: 8,
  undoSnapshots: 3,
  /** = MAX_INTENT_ACTIONS. */
  maxSteps: MAX_INTENT_ACTIONS,
  /** Serialised thread, UTF-8 bytes. */
  maxBytes: 16_384,
  /** Kletia-held threads: turns before the thread closes. */
  maxTurns: 50,
  /** Kletia-held threads: idle expiry. */
  idleMs: 30 * 60_000,
  /** Kletia-held threads: absolute expiry. */
  absoluteMs: 24 * 3_600_000,
  /** Kletia-held threads open per API key. */
  openPerKey: 1_000,
  /** Kletia-held record (thread + context + last response), bytes. */
  storedRecordBytes: 32_768,
  /** Intents a thread lists. */
  intentsPerThread: 5,
});

/** Copy and shape limits of questions, options and chips. */
export const CLARIFY_LIMITS = Object.freeze({
  questionsPerTurn: 2,
  chipsPerPlan: 3,
  optionsPerQuestion: 8,
  alternativesPerAssumption: 4,
  optionLabel: 48,
  optionDetail: 96,
  prompt: 160,
  why: 160,
  /** A misspelt word kept by a correction chip ("swpa"). */
  correctionFrom: 16,
  /** clientReference on a turn: the intent of revision n gets "<clientReference>:r<n>". */
  clientReference: 72,
  /** Message text and free-text answers. */
  text: MAX_INTENT_TEXT_LENGTH,
});

/** "th_" + 24 lowercase base32 characters. */
export const THREAD_ID_PATTERN = /^th_[a-z2-7]{24}$/u;

export function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID_PATTERN.test(value);
}

export const CLARIFY_QUESTION_KINDS = Object.freeze(["choice", "amount", "address", "confirm"] as const);
export type ClarifyQuestionKind = (typeof CLARIFY_QUESTION_KINDS)[number];

export const CLARIFY_REASONS = Object.freeze([
  // gaps
  "AMOUNT_MISSING", "AMOUNT_BALANCE_UNKNOWN", "DESTINATION_MISSING", "OUTPUT_ASSET_MISSING", "INPUT_ASSET_MISSING",
  "RECIPIENT_MISSING", "SOURCE_MISSING", "TRANSFER_NETWORK", "NETWORK_AMBIGUOUS", "VENUE_MISSING", "COUNTERPART_MISSING",
  // a venue word that names two protocols (bare "spark": Spark Savings or SparkLend)
  "VENUE_AMBIGUOUS",
  // consequences across networks
  "NETWORK_HANDOFF", "FUNDS_ELSEWHERE",
  // a stated value that cannot be used as is
  "AMOUNT_FORMAT_AMBIGUOUS", "ASSET_AMBIGUOUS", "ASSET_LOOKALIKE", "ASSET_NOT_ON_NETWORK", "RECIPIENT_UNRESOLVED",
  "RECIPIENT_NAME_MOVED", "RECIPIENT_NETWORK_MISMATCH", "RECIPIENT_CHECKSUM", "VERB_AMBIGUOUS",
  // follow-ups
  "EDIT_TARGET_AMBIGUOUS",
] as const);
export type ClarifyReason = (typeof CLARIFY_REASONS)[number];

/** Means questions: Kletia may suggest, and an agent may answer them for the person. */
const MEANS_REASONS: readonly ClarifyReason[] = ["VENUE_MISSING", "NETWORK_AMBIGUOUS", "VENUE_AMBIGUOUS"];
/** Reasons whose question may carry one suggested option. */
const SUGGESTING_REASONS: readonly ClarifyReason[] = [
  "VENUE_MISSING", "VENUE_AMBIGUOUS", "FUNDS_ELSEWHERE", "ASSET_AMBIGUOUS", "ASSET_LOOKALIKE", "AMOUNT_FORMAT_AMBIGUOUS",
];

/** Only the person can answer these: agents relay them and never pick an option themselves. */
export const PURPOSE_REASONS: ReadonlySet<ClarifyReason> = new Set(
  CLARIFY_REASONS.filter((reason) => !MEANS_REASONS.includes(reason)),
);
/** Gap and recipient questions: never a suggested option (the value is the person's own choice). */
export const UNSUGGESTED_REASONS: ReadonlySet<ClarifyReason> = new Set(
  CLARIFY_REASONS.filter((reason) => !SUGGESTING_REASONS.includes(reason)),
);

export function isClarifyReason(value: unknown): value is ClarifyReason {
  return typeof value === "string" && (CLARIFY_REASONS as readonly string[]).includes(value);
}

export interface ClarifyOption {
  /** Stable within the question: a network key, a symbol, "all", "half", "decimal", "thousands", a protocol id, a slot path. */
  readonly id: string;
  /** At most 48 characters ("All · 2.49 SOL"). */
  readonly label: string;
  /** At most 96 ("Keeps 0.01 SOL for network fees", "You hold 120.40"). */
  readonly detail?: string;
  /** Kletia's suggestion; at most one per question; never for UNSUGGESTED_REASONS (gaps and recipients). */
  readonly recommended?: true;
  /** For the network bullet. */
  readonly network?: NetworkKey;
  /** The complete sentence this choice leads to when the thread is then ready (stateless agents can send it as text). */
  readonly sentence?: string;
}

export interface ClarifyQuestion {
  /** "q.actions.0.amount"; "q.edit" for an edit target. */
  readonly id: string;
  /** "actions[0].amount". */
  readonly field: string;
  readonly kind: ClarifyQuestionKind;
  readonly reason: ClarifyReason;
  /** PURPOSE_REASONS.has(reason). */
  readonly purpose: boolean;
  /** At most 160 characters, a question or an instruction. */
  readonly prompt: string;
  /** At most 160: the fact behind it ("You hold 2.5 SOL on Solana."). */
  readonly why: string;
  /** At most 8, deterministic order. */
  readonly options: readonly ClarifyOption[];
  readonly allowsText: boolean;
  /** "0x… or name.eth", "Amount in SOL". */
  readonly placeholder?: string;
}

export const ASSUMPTION_SOURCES = Object.freeze(["default", "balance", "position", "context", "correction", "alias", "price"] as const);
export type AssumptionSource = (typeof ASSUMPTION_SOURCES)[number];

export interface ClarifyAssumption {
  /** "a.actions.0.network". */
  readonly id: string;
  readonly field: string;
  /** "On Base", "BTC means cbBTC", "\"swpa\" read as swap". */
  readonly label: string;
  /** "Your largest USDC balance." */
  readonly reason: string;
  readonly source: AssumptionSource;
  /** Changes where money goes or how much moves: highlighted, announced, listed first. */
  readonly material: boolean;
  /** At most 4; more by typing ("on optimism"). */
  readonly alternatives: readonly ClarifyOption[];
}

/** Step kinds a clarify thread can hold. */
export const CLARIFY_STEP_KINDS = Object.freeze(["swap", "bridge", "transfer", "stake", "deposit", "withdraw", "call", "action"] as const);
export type ClarifyStepKind = (typeof CLARIFY_STEP_KINDS)[number];

export interface ClarifyDraftStep {
  readonly index: number;
  readonly kind?: ClarifyStepKind;
  readonly network?: NetworkKey;
  readonly toNetwork?: NetworkKey;
  readonly from?: string;
  readonly to?: string;
  /** "25", "all", "half", "it". */
  readonly amount?: string;
  readonly recipient?: string;
  readonly protocol?: string;
}

export interface ClarifyDraft {
  /** "Swap SOL to USDC on Solana" (title case of what is known). */
  readonly summary: string;
  /** The canonical sentence once ready. */
  readonly sentence: string | null;
  /** Fields of the open questions. */
  readonly missing: readonly string[];
  readonly steps: readonly ClarifyDraftStep[];
}

export const THREAD_PROVENANCES = Object.freeze(["user", "answer", "assumed", "derived"] as const);
export type ThreadProvenance = (typeof THREAD_PROVENANCES)[number];

export interface ThreadSlot<T> {
  readonly v: T;
  readonly by: ThreadProvenance;
  /** Assumed slots only: why, as a template code, so the chip stays the same on later turns. */
  readonly why?: { readonly source: AssumptionSource; readonly code: string };
}

export type ThreadAmount =
  | { readonly t: "exact"; readonly value: string; readonly raw?: string }
  | { readonly t: "usd"; readonly value: string }
  /** "it", "half", "25%" of the previous output. */
  | { readonly t: "previous"; readonly bps: number }
  /** "all my SOL", "half of my USDC". */
  | { readonly t: "balance"; readonly bps: number }
  /** Withdraw all / half of the position. */
  | { readonly t: "position"; readonly bps: number };

export interface ThreadStep {
  readonly kind?: ThreadSlot<string>;
  readonly kindCandidates?: readonly string[];
  readonly amount?: ThreadSlot<ThreadAmount>;
  readonly from?: ThreadSlot<string>;
  readonly to?: ThreadSlot<string>;
  readonly network?: ThreadSlot<NetworkKey>;
  readonly toNetwork?: ThreadSlot<NetworkKey>;
  readonly recipient?: ThreadSlot<string>;
  readonly protocol?: ThreadSlot<string>;
  readonly vault?: ThreadSlot<string>;
  readonly provider?: ThreadSlot<string>;
  /** "<registration>#<entry>" for a bring-your-own-contract step. */
  readonly contract?: ThreadSlot<string>;
  readonly usdFrom?: boolean;
  readonly usdTo?: boolean;
}

export const TURN_KINDS = Object.freeze(["message", "answer", "edit", "append", "replace", "control", "none"] as const);
export type TurnKind = (typeof TURN_KINDS)[number];

export const THREAD_STATUSES = Object.freeze(["needs_input", "ready", "cancelled"] as const);
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export interface ThreadCorrection {
  readonly field: string;
  /** The misspelt word, at most 16 characters. */
  readonly from: string;
  readonly to: string;
  readonly material: boolean;
}

export interface ThreadTurn {
  readonly role: "user" | "kletia";
  readonly kind: string;
  /** Kletia's own words ("Changed the amount to 2"); never the user's message. */
  readonly label: string;
}

export interface ClarifyThread {
  readonly spec: typeof THREAD_SPEC;
  /** "th_" + 24 base32 characters. */
  readonly id: string;
  readonly rev: number;
  readonly status: ThreadStatus;
  /** CLARIFY_POLICY_VERSION that wrote it. */
  readonly policy: string;
  readonly steps: readonly ThreadStep[];
  readonly open: readonly string[];
  /** An edit waiting for EDIT_TARGET_AMBIGUOUS (engine-defined shape). */
  readonly pendingEdit?: unknown;
  readonly corrections: readonly ThreadCorrection[];
  /** Written by Kletia from what each turn changed ("Changed the amount to 2"); never the user's words. */
  readonly turns: readonly ThreadTurn[];
  readonly undo: readonly (readonly ThreadStep[])[];
}

export interface ThreadRef {
  readonly id: string;
  readonly rev: number;
  readonly status: ThreadStatus;
  /** ISO 8601 (Kletia-held threads). */
  readonly expiresAt: string;
}

export interface IntentTurnRequest {
  // Context: the IntentRequest fields. Required on the first turn; a Kletia-held thread keeps the last one sent.
  readonly accounts?: readonly AccountId[];
  readonly defaultNetwork?: NetworkKey;
  readonly sourceNetwork?: NetworkKey | "auto";
  readonly constraints?: IntentConstraints;
  readonly metadata?: Readonly<Record<string, string>>;
  /** At most 72 characters here: the intent created at revision n gets "<clientReference>:r<n>". */
  readonly clientReference?: string;
  // Input: at most one. None (with a thread) plans the ready thread again: the "commit" turn.
  /** At most 1,000 characters. */
  readonly text?: string;
  readonly answer?: { readonly question: string; readonly option?: string; readonly text?: string };
  readonly assumption?: { readonly id: string; readonly option: string };
  // Memory: at most one of thread / threadId.
  /** Client-held. */
  readonly thread?: ClarifyThread;
  /** Kletia-held (API key). */
  readonly threadId?: string;
  /** First turn: create a Kletia-held thread. */
  readonly remember?: boolean;
  /** Optimistic concurrency for Kletia-held threads. */
  readonly expectedRev?: number;
}

export type IntentTurnResponse =
  | {
      readonly status: "needs_input";
      readonly turn: TurnKind;
      readonly questions: readonly ClarifyQuestion[];
      readonly assumptions: readonly ClarifyAssumption[];
      readonly draft: ClarifyDraft;
      readonly thread: ClarifyThread | ThreadRef;
    }
  | {
      readonly status: "planned";
      readonly turn: TurnKind;
      readonly intent: IntentGraph;
      readonly preview?: IntentPreview;
      readonly assumptions: readonly ClarifyAssumption[];
      readonly sentence: string;
      readonly thread: ClarifyThread | ThreadRef;
      readonly replayed?: boolean;
    }
  | { readonly status: "cancelled"; readonly turn: "control"; readonly thread: ClarifyThread | ThreadRef };

// ------------------------------------------------------------- constants

/**
 * Native gas kept when the user says "all" of a gas asset on a first step
 * (decimal strings of the network's native asset). Journey F6's planned gas
 * reserve covers funded steps; this one covers "all my SOL".
 */
export const NATIVE_FEE_RESERVE: Readonly<Record<NetworkKey, string>> = Object.freeze({
  base: "0.0005",
  arbitrum: "0.0005",
  ethereum: "0.003",
  optimism: "0.0005",
  polygon: "0.5",
  arc: "0.05",
  "arbitrum-sepolia": "0.0005",
  solana: "0.01",
  "solana-devnet": "0.01",
});

/**
 * Studio's demo accounts for read-only previews (dry-run planning never moves
 * funds): never read, never offered as funded, refused for signing. Both
 * addresses are derived from a public label (keccak-256 of
 * "kletia preview account v1 evm" / "... solana"), so nobody holds their keys,
 * and neither is the recipient of a grammar or protocol example (the old
 * 0x…dEaD and 9WzD…AWWM accounts were, which turned those examples into
 * SELF_TRANSFER refusals).
 */
export const PREVIEW_ACCOUNT_IDS: readonly AccountId[] = Object.freeze([
  "eip155:8453:0x9B58BE768EAB41bD43C8293DDDB6bf3c0D066590",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:92x2Ef9emSPRLCDhZNBRoJmqfP65AhNYMYV4pFVsE4BK",
] as AccountId[]);

/** True for a preview account's address on any network of its virtual machine. */
export function isPreviewAccount(account: unknown): boolean {
  if (typeof account !== "string" || !parseAccountId(account)) return false;
  return PREVIEW_ACCOUNT_IDS.some((preview) => sameAddressAccount(preview, account));
}

// ------------------------------------------------------------ follow-ups

/** "cancel", "never mind", "start over": close the task. */
export const CONTROL_CANCEL_PATTERN = /^(?:cancel|stop|abort|never\s*mind|forget\s+it|cancel\s+(?:it|that|this)|start\s+over)$/iu;
/** "undo", "go back": restore the last snapshot. */
export const CONTROL_UNDO_PATTERN = /^(?:undo|go\s+back|revert(?:\s+that)?)$/iu;
export const CONFIRM_YES_PATTERN = /^(?:yes|yep|yeah|ok|okay|sure|confirm|correct|right|do\s+it)$/iu;
export const CONFIRM_NO_PATTERN = /^(?:no|nope|nah)$/iu;

/** Verbs that start a sentence (synonyms read silently). */
export const SENTENCE_VERBS: Readonly<Record<string, ClarifyStepKind>> = Object.freeze({
  swap: "swap", convert: "swap", trade: "swap", exchange: "swap", sell: "swap", buy: "swap", get: "swap", purchase: "swap",
  bridge: "bridge", move: "bridge", port: "bridge",
  send: "transfer", transfer: "transfer", pay: "transfer",
  stake: "stake",
  deposit: "deposit", supply: "deposit", lend: "deposit", put: "deposit", place: "deposit", invest: "deposit", earn: "deposit",
  withdraw: "withdraw", redeem: "withdraw",
});

export type FollowUpVenueRole = "bridge" | "lending" | "dex";

/**
 * Venue words a follow-up may name ("via lifi", "into kamino", "via orca").
 * Bare "spark" is ambiguous (Spark Savings or SparkLend): it maps to the
 * default and `AMBIGUOUS_VENUE_WORDS` lists both, so clarify asks
 * VENUE_AMBIGUOUS with Spark Savings suggested.
 */
export const FOLLOW_UP_VENUE_WORDS: Readonly<Record<string, { readonly protocol: ProtocolId; readonly role: FollowUpVenueRole }>> = Object.freeze({
  // bridges
  lifi: { protocol: "lifi", role: "bridge" },
  "li.fi": { protocol: "lifi", role: "bridge" },
  debridge: { protocol: "debridge-dln", role: "bridge" },
  "debridge dln": { protocol: "debridge-dln", role: "bridge" },
  dln: { protocol: "debridge-dln", role: "bridge" },
  relay: { protocol: "relay", role: "bridge" },
  across: { protocol: "across", role: "bridge" },
  cctp: { protocol: "cctp-v2", role: "bridge" },
  "cctp v2": { protocol: "cctp-v2", role: "bridge" },
  // lending and savings
  aave: { protocol: "aave-v3", role: "lending" },
  "aave v3": { protocol: "aave-v3", role: "lending" },
  compound: { protocol: "compound-v3", role: "lending" },
  "compound v3": { protocol: "compound-v3", role: "lending" },
  comet: { protocol: "compound-v3", role: "lending" },
  morpho: { protocol: "morpho", role: "lending" },
  "morpho vault": { protocol: "morpho", role: "lending" },
  "morpho vaults": { protocol: "morpho", role: "lending" },
  moonwell: { protocol: "moonwell", role: "lending" },
  "jupiter lend": { protocol: "jupiter-lend", role: "lending" },
  "jupiter earn": { protocol: "jupiter-lend", role: "lending" },
  "jup lend": { protocol: "jupiter-lend", role: "lending" },
  "jup earn": { protocol: "jupiter-lend", role: "lending" },
  kamino: { protocol: "kamino", role: "lending" },
  "kamino lend": { protocol: "kamino", role: "lending" },
  sparklend: { protocol: "sparklend", role: "lending" },
  "spark lend": { protocol: "sparklend", role: "lending" },
  spark: { protocol: "spark-savings", role: "lending" },
  "spark savings": { protocol: "spark-savings", role: "lending" },
  fluid: { protocol: "fluid", role: "lending" },
  "fluid lend": { protocol: "fluid", role: "lending" },
  "fluid lending": { protocol: "fluid", role: "lending" },
  yearn: { protocol: "yearn-v3", role: "lending" },
  "yearn v3": { protocol: "yearn-v3", role: "lending" },
  // named swap venues
  uniswap: { protocol: "uniswap-v3", role: "dex" },
  "uniswap v3": { protocol: "uniswap-v3", role: "dex" },
  uni: { protocol: "uniswap-v3", role: "dex" },
  aerodrome: { protocol: "aerodrome", role: "dex" },
  aero: { protocol: "aerodrome", role: "dex" },
  velodrome: { protocol: "velodrome", role: "dex" },
  velo: { protocol: "velodrome", role: "dex" },
  raydium: { protocol: "raydium", role: "dex" },
  orca: { protocol: "orca", role: "dex" },
  whirlpool: { protocol: "orca", role: "dex" },
  whirlpools: { protocol: "orca", role: "dex" },
  meteora: { protocol: "meteora", role: "dex" },
  jupiter: { protocol: "jupiter", role: "dex" },
  jup: { protocol: "jupiter", role: "dex" },
});

/** Venue words that name more than one protocol: the default first (VENUE_AMBIGUOUS suggests it). */
export const AMBIGUOUS_VENUE_WORDS: Readonly<Record<string, readonly ProtocolId[]>> = Object.freeze({
  spark: Object.freeze(["spark-savings", "sparklend"] as ProtocolId[]),
});

/** Staking providers by word: the liquid staking token each one mints. */
export const STAKE_PROVIDER_WORDS: Readonly<Record<string, { readonly provider: string; readonly symbol: string; readonly network: NetworkKey }>> =
  Object.freeze({
    jito: { provider: "jito", symbol: "JitoSOL", network: "solana" },
    jitosol: { provider: "jito", symbol: "JitoSOL", network: "solana" },
    marinade: { provider: "marinade", symbol: "mSOL", network: "solana" },
    msol: { provider: "marinade", symbol: "mSOL", network: "solana" },
    jupsol: { provider: "jupiter", symbol: "JupSOL", network: "solana" },
    sanctum: { provider: "jupiter", symbol: "JupSOL", network: "solana" },
    lido: { provider: "lido", symbol: "wstETH", network: "ethereum" },
    steth: { provider: "lido", symbol: "wstETH", network: "ethereum" },
    wsteth: { provider: "lido", symbol: "wstETH", network: "ethereum" },
    "rocket pool": { provider: "rocket-pool", symbol: "rETH", network: "ethereum" },
    rocketpool: { provider: "rocket-pool", symbol: "rETH", network: "ethereum" },
    reth: { provider: "rocket-pool", symbol: "rETH", network: "ethereum" },
    "ether.fi": { provider: "etherfi", symbol: "weETH", network: "ethereum" },
    etherfi: { provider: "etherfi", symbol: "weETH", network: "ethereum" },
    weeth: { provider: "etherfi", symbol: "weETH", network: "ethereum" },
    eeth: { provider: "etherfi", symbol: "weETH", network: "ethereum" },
  });

/** Dollar words: the engine reads them as USDC with USDT, PYUSD and DAI as alternatives. */
export const USD_WORDS: ReadonlySet<string> = new Set(["usd", "dollar", "dollars", "stablecoin", "stablecoins", "stable", "stables"]);

const NUMBER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
  "a hundred": "100", "one hundred": "100", "a thousand": "1000", "one thousand": "1000",
});
const NUMBER_WORD_PATTERNS = Object.entries(NUMBER_WORDS)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([word, digits]) => [new RegExp(`(^|\\s)${word}(?=\\s)`, "giu"), digits] as const);

/** Symbols a message may name besides the registry's: renames and synonyms the engine maps (MATIC, BTC, ETHER, WSOL). */
const SYMBOL_ALIASES: ReadonlySet<string> = new Set(["MATIC", "BTC", "ETHER", "WSOL"]);
const LISTED_SYMBOLS: ReadonlySet<string> = new Set(ASSETS.map((asset) => asset.symbol.toUpperCase()));

/** True when `token` is a listed symbol on some network, or a rename the engine maps. */
export function isKnownSymbol(token: string): boolean {
  const upper = token.toUpperCase();
  return LISTED_SYMBOLS.has(upper) || SYMBOL_ALIASES.has(upper);
}

/**
 * Message normalisation shared with the engine: arrows become " to ", quotes
 * and trailing punctuation go, polite prefixes and suffixes are dropped and
 * number words up to "a thousand" become digits.
 */
export function normalizeMessage(text: string): string {
  let value = text
    .replace(/[→➡]|->|=>/gu, " to ")
    .replace(/[“”"']/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  const prefix = /^(?:please|pls|kletia,?|i want to|id like to|i would like to|can you|could you|lets)\s+/iu;
  while (prefix.test(value)) value = value.replace(prefix, "");
  value = value.replace(/(?:,?\s+(?:please|pls|thanks|thank you|thx))+$/iu, "").trim();
  for (const [pattern, digits] of NUMBER_WORD_PATTERNS) value = value.replace(pattern, `$1${digits}`);
  return value;
}

const NETWORK_WORDS =
  "arbitrum[\\s-]+sepolia|arb[\\s-]+sepolia|solana[\\s-]+devnet|solana[\\s-]+mainnet|arbitrum[\\s-]+one|arc[\\s-]+testnet|base[\\s-]+mainnet|" +
  "ethereum[\\s-]+mainnet|op[\\s-]+mainnet|optimism[\\s-]+mainnet|polygon[\\s-]+pos|polygon[\\s-]+mainnet|mainnet-beta|" +
  "base|arbitrum|arb|arc|solana|sol|devnet|ethereum|optimism|polygon|matic|op";
const NAME_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.(?:eth|sns|sol)";
const ADDRESS_PATTERN = `(?:0x[0-9a-fA-F]{40}|(?:eip155|solana):\\S+|${NAME_PATTERN}|[1-9A-HJ-NP-Za-km-z]{32,44})`;
const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "[\\s-]+");
const wordAlternation = (words: readonly string[]): string => [...words].sort((a, b) => b.length - a.length).map(escapeWord).join("|");
const VENUE_ALTERNATION = wordAlternation(Object.keys(FOLLOW_UP_VENUE_WORDS));
const PROVIDER_ALTERNATION = wordAlternation(Object.keys(STAKE_PROVIDER_WORDS));

const FOLLOW_UP = Object.freeze({
  append: /^(?:and\s+)?then\s+(?<rest>.+)$/iu,
  appendVerb: new RegExp(`^and\\s+(?<rest>(?:${Object.keys(SENTENCE_VERBS).join("|")})\\b.+)$`, "iu"),
  unsupported: /^(?:double|triple|halve|half)\s+it$/iu,
  amount: /^(?:(?:make\s+it|change\s+(?:it|the\s+amount)\s+to|set\s+(?:it|the\s+amount)\s+to|use)\s+)?(?<amt>\$?\d[\d,]*(?:\.\d+)?|\.\d+|\d{1,3}(?:\.\d{1,2})?%)(?:\s+(?<unit>[a-z][a-z0-9]{1,9}))?$/iu,
  network: new RegExp(`^(?<dir>from|to|on|in|use)\\s+(?<net>${NETWORK_WORDS})$`, "iu"),
  recipient: new RegExp(`^(?:(?:send|pay|transfer)\\s+(?:it|them|that)\\s+)?to\\s+(?<rcpt>${ADDRESS_PATTERN})$`, "iu"),
  provider: new RegExp(`^(?:with|via|using)\\s+(?<p>${PROVIDER_ALTERNATION})$`, "iu"),
  venue: new RegExp(`^(?:via|using|through|over|into|in|to|with|use|on)\\s+(?:the\\s+)?(?<v>${VENUE_ALTERNATION})$`, "iu"),
  asset: /^(?:make\s+it|use|as|for|into|swap\s+(?:it\s+)?(?:to|for|into))\s+(?<sym>[A-Za-z][\w.-]{1,15})$/iu,
  network_only: new RegExp(`^(?:${NETWORK_WORDS})$`, "iu"),
});

/** The network a word names ("arbitrum one", "op", "sol", "solana devnet"), or null. */
export function networkFromWord(word: string): NetworkKey | null {
  const value = word.trim().toLowerCase().replace(/[\s-]+/gu, " ");
  const direct = resolveChain(value) ?? resolveChain(value.replace(/ /gu, "-"));
  if (direct) return direct.key;
  if (value === "arb sepolia") return "arbitrum-sepolia";
  return null;
}

/** One follow-up on a task that has steps. */
export type FollowUp =
  | { readonly op: "amount"; readonly amount: ThreadAmount; readonly unit?: string }
  | { readonly op: "network"; readonly dir: "from" | "to" | "on" | "use"; readonly network: NetworkKey }
  | { readonly op: "recipient"; readonly recipient: string }
  | { readonly op: "asset"; readonly symbol: string }
  | { readonly op: "provider"; readonly provider: string; readonly symbol: string }
  | { readonly op: "venue"; readonly protocol: ProtocolId; readonly role: FollowUpVenueRole; readonly word: string }
  | { readonly op: "append"; readonly text: string };

/**
 * Reads a follow-up amount: exact ("50", "1,500", "$20"), or a percentage of
 * the balance ("25%"). Null when it is not a clear positive amount.
 */
function followUpAmount(raw: string): ThreadAmount | null {
  const value = raw.trim().toLowerCase();
  const percent = /^(\d{1,3}(?:\.\d{1,2})?)%$/u.exec(value);
  if (percent) {
    const bps = Math.round(Number(percent[1]) * 100);
    return bps > 0 && bps <= 10_000 ? { t: "balance", bps } : null;
  }
  const usd = value.startsWith("$");
  let numeric = value.replace(/^\$/u, "");
  // "1,5": a decimal comma (the engine shows a material chip).
  if (/^\d+,\d{1,2}$/u.test(numeric)) numeric = numeric.replace(",", ".");
  else if (numeric.includes(",")) {
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(numeric)) return null;
    numeric = numeric.replace(/,/gu, "");
  }
  if (numeric.startsWith(".")) numeric = `0${numeric}`;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(numeric) || /^0(?:\.0+)?$/u.test(numeric)) return null;
  return usd ? { t: "usd", value: numeric } : { t: "exact", value: numeric, raw: value };
}

/**
 * The follow-up grammar: what a message does to a task that already has
 * steps. `"unsupported"` for a recognised but unsupported edit ("double
 * it": say the amount), null when the message is not a follow-up (a
 * complete sentence replaces the task; anything else is EDIT_UNSUPPORTED).
 */
export function parseFollowUp(message: string): FollowUp | "unsupported" | null {
  const text = normalizeMessage(message)
    .replace(/\s+instead$/iu, "")
    .replace(/^(?:actually|no,?|wait,?|oh,?|hmm,?)\s+/iu, "")
    .trim();
  if (!text) return null;
  let match = FOLLOW_UP.append.exec(text) ?? FOLLOW_UP.appendVerb.exec(text);
  if (match?.groups?.rest) return { op: "append", text: match.groups.rest };
  if (FOLLOW_UP.unsupported.test(text)) return "unsupported";
  match = FOLLOW_UP.amount.exec(text);
  if (match?.groups?.amt) {
    const unit = match.groups.unit;
    if (unit && !isKnownSymbol(unit)) return null;
    const amount = followUpAmount(match.groups.amt);
    if (!amount) return "unsupported";
    return { op: "amount", amount, ...(unit ? { unit } : {}) };
  }
  match = FOLLOW_UP.network.exec(text);
  if (match?.groups?.dir && match.groups.net) {
    const network = networkFromWord(match.groups.net);
    const dir = match.groups.dir.toLowerCase();
    if (network) return { op: "network", dir: dir === "in" ? "on" : (dir as "from" | "to" | "on" | "use"), network };
  }
  match = FOLLOW_UP.recipient.exec(text);
  if (match?.groups?.rcpt) return { op: "recipient", recipient: match.groups.rcpt };
  match = FOLLOW_UP.provider.exec(text);
  if (match?.groups?.p) {
    const entry = STAKE_PROVIDER_WORDS[match.groups.p.toLowerCase().replace(/[\s-]+/gu, " ")];
    if (entry) return { op: "provider", provider: entry.provider, symbol: entry.symbol };
  }
  match = FOLLOW_UP.venue.exec(text);
  if (match?.groups?.v) {
    const word = match.groups.v.toLowerCase().replace(/[\s-]+/gu, " ");
    const entry = FOLLOW_UP_VENUE_WORDS[word];
    if (entry) return { op: "venue", protocol: entry.protocol, role: entry.role, word };
  }
  match = FOLLOW_UP.asset.exec(text);
  if (match?.groups?.sym) {
    const symbol = match.groups.sym;
    const network = networkFromWord(symbol);
    if (network) return { op: "network", dir: "use", network };
    if (isKnownSymbol(symbol) || USD_WORDS.has(symbol.toLowerCase())) return { op: "asset", symbol };
  }
  if (FOLLOW_UP.network_only.test(text)) {
    const network = networkFromWord(text);
    if (network) return { op: "network", dir: "use", network };
  }
  return null;
}

/** What a message will do, for the composer's chip; the server's `turn` in the response is authoritative. */
export type MessageClass = "control" | "answer" | "edit" | "append" | "sentence" | "unknown";

function startsWithVerb(text: string): boolean {
  const first = text.split(" ", 1)[0]?.toLowerCase() ?? "";
  return Object.hasOwn(SENTENCE_VERBS, first);
}

/**
 * Classifies a message the way a turn reads it: controls first, then an
 * answer to the open question, then a follow-up on the task, then a new
 * sentence. A message the server would refuse (a bare "yes" with nothing to
 * confirm) is `unknown`.
 */
export function classifyMessage(
  text: string,
  context: { readonly hasOpenQuestion: boolean; readonly hasTask: boolean },
): MessageClass {
  const value = normalizeMessage(text);
  if (!value) return "unknown";
  if (context.hasTask && (CONTROL_CANCEL_PATTERN.test(value) || CONTROL_UNDO_PATTERN.test(value))) return "control";
  const followUp = context.hasTask ? parseFollowUp(value) : null;
  if (followUp && typeof followUp === "object" && followUp.op === "append") return "append";
  if (context.hasOpenQuestion && !startsWithVerb(value)) return "answer";
  if (followUp) return "edit";
  if (startsWithVerb(value) || !context.hasTask) return "sentence";
  return "unknown";
}

// ------------------------------------------------------------ validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: path ? `${path}.${key}` : key, message: "Unknown field." });
  }
}

function boundedString(value: unknown, max: number, pattern?: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && (!pattern || pattern.test(value));
}

const FIELD_PATTERN = /^actions\[[0-7]\]\.[a-zA-Z]{1,24}$/u;
const WHY_CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,47}$/u;
const TOKEN_PATTERN = /^\S{1,128}$/u;
const PROTOCOL_SLOT_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const VAULT_SLOT_PATTERN = /^[A-Za-z0-9][\w.:-]{0,127}$/u;
const CONTRACT_SLOT_PATTERN = /^[A-Za-z0-9][\w .:-]{0,63}#[a-z][a-z0-9_-]{0,39}$/u;
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/u;

function validAmount(value: unknown): value is ThreadAmount {
  if (!isRecord(value)) return false;
  switch (value.t) {
    case "exact":
      return Object.keys(value).every((key) => key === "t" || key === "value" || key === "raw") &&
        typeof value.value === "string" && POSITIVE_DECIMAL.test(value.value) && !/^0(?:\.0+)?$/u.test(value.value) &&
        (value.raw === undefined || boundedString(value.raw, 40));
    case "usd":
      return Object.keys(value).every((key) => key === "t" || key === "value") &&
        typeof value.value === "string" && POSITIVE_DECIMAL.test(value.value) && !/^0(?:\.0+)?$/u.test(value.value);
    case "previous":
    case "balance":
    case "position":
      return Object.keys(value).every((key) => key === "t" || key === "bps") &&
        Number.isInteger(value.bps) && (value.bps as number) >= 1 && (value.bps as number) <= 10_000;
    default:
      return false;
  }
}

const SLOT_CHECKS: Readonly<Record<string, (v: unknown) => boolean>> = Object.freeze({
  kind: (v) => (CLARIFY_STEP_KINDS as readonly unknown[]).includes(v),
  amount: validAmount,
  from: (v) => typeof v === "string" && TOKEN_PATTERN.test(v),
  to: (v) => typeof v === "string" && TOKEN_PATTERN.test(v),
  network: isNetworkKey,
  toNetwork: isNetworkKey,
  recipient: (v) => typeof v === "string" && TOKEN_PATTERN.test(v),
  protocol: (v) => typeof v === "string" && PROTOCOL_SLOT_PATTERN.test(v),
  vault: (v) => typeof v === "string" && VAULT_SLOT_PATTERN.test(v),
  provider: (v) => typeof v === "string" && PROTOCOL_SLOT_PATTERN.test(v),
  contract: (v) => typeof v === "string" && CONTRACT_SLOT_PATTERN.test(v),
});
const STEP_KEYS = [...Object.keys(SLOT_CHECKS), "kindCandidates", "usdFrom", "usdTo"];

function validateSlot(value: unknown, path: string, check: (v: unknown) => boolean, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "A slot is { v, by, why? }." });
    return;
  }
  unknownKeys(value, ["v", "by", "why"], path, issues);
  if (!check(value.v)) issues.push({ path: `${path}.v`, message: "Invalid value for this slot." });
  if (!(THREAD_PROVENANCES as readonly unknown[]).includes(value.by)) {
    issues.push({ path: `${path}.by`, message: `Must be one of ${THREAD_PROVENANCES.join(", ")}.` });
  }
  if (value.why !== undefined) {
    const why = value.why;
    if (value.by !== "assumed") issues.push({ path: `${path}.why`, message: "Only assumed slots carry a reason." });
    else if (
      !isRecord(why) || Object.keys(why).some((key) => key !== "source" && key !== "code") ||
      !(ASSUMPTION_SOURCES as readonly unknown[]).includes(why.source) ||
      typeof why.code !== "string" || !WHY_CODE_PATTERN.test(why.code)
    ) {
      issues.push({ path: `${path}.why`, message: "A reason is { source, code } with a template code." });
    }
  }
}

function validateSteps(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || value.length > THREAD_LIMITS.maxSteps) {
    issues.push({ path, message: `At most ${THREAD_LIMITS.maxSteps} steps.` });
    return;
  }
  value.forEach((step, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(step)) {
      issues.push({ path: at, message: "A step is an object of slots." });
      return;
    }
    unknownKeys(step, STEP_KEYS, at, issues);
    for (const [key, check] of Object.entries(SLOT_CHECKS)) {
      if (step[key] !== undefined) validateSlot(step[key], `${at}.${key}`, check, issues);
    }
    const candidates = step.kindCandidates;
    if (
      candidates !== undefined &&
      (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 4 ||
        candidates.some((kind) => !(CLARIFY_STEP_KINDS as readonly unknown[]).includes(kind)))
    ) {
      issues.push({ path: `${at}.kindCandidates`, message: "Up to 4 step kinds." });
    }
    for (const flag of ["usdFrom", "usdTo"] as const) {
      if (step[flag] !== undefined && typeof step[flag] !== "boolean") issues.push({ path: `${at}.${flag}`, message: "Must be a boolean." });
    }
  });
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function threadIssues(input: unknown, path: string, issues: ValidationIssue[]): void {
  const at = (key: string) => (path ? `${path}.${key}` : key);
  if (!isRecord(input)) {
    issues.push({ path, message: "A thread is an object." });
    return;
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(input);
  } catch {
    issues.push({ path, message: "A thread must be plain JSON." });
    return;
  }
  if (utf8Length(serialised) > THREAD_LIMITS.maxBytes) {
    issues.push({ path, message: `A thread is at most ${THREAD_LIMITS.maxBytes} bytes.` });
    return;
  }
  unknownKeys(input, ["spec", "id", "rev", "status", "policy", "steps", "open", "pendingEdit", "corrections", "turns", "undo"], path, issues);
  if (input.spec !== THREAD_SPEC) issues.push({ path: at("spec"), message: `Must be "${THREAD_SPEC}".` });
  if (!isThreadId(input.id)) issues.push({ path: at("id"), message: "Must be th_ followed by 24 base32 characters." });
  if (!Number.isSafeInteger(input.rev) || (input.rev as number) < 0) issues.push({ path: at("rev"), message: "Must be a non-negative integer." });
  if (!(THREAD_STATUSES as readonly unknown[]).includes(input.status)) {
    issues.push({ path: at("status"), message: `Must be one of ${THREAD_STATUSES.join(", ")}.` });
  }
  if (!boundedString(input.policy, 32, /^\d{4}-\d{2}\.\d{1,4}$/u)) issues.push({ path: at("policy"), message: "Must be a policy version such as 2026-10.1." });
  validateSteps(input.steps, at("steps"), issues);
  const open = input.open;
  if (!Array.isArray(open) || open.length > THREAD_LIMITS.maxSteps * 4 || open.some((field) => typeof field !== "string" || !FIELD_PATTERN.test(field))) {
    issues.push({ path: at("open"), message: "Open fields are slot paths such as actions[0].amount." });
  } else if (input.status !== "needs_input" && open.length > 0) {
    issues.push({ path: at("open"), message: "Only a thread that needs input has open questions." });
  }
  const corrections = input.corrections;
  if (
    !Array.isArray(corrections) || corrections.length > THREAD_LIMITS.maxSteps * 4 ||
    corrections.some((entry) =>
      !isRecord(entry) || Object.keys(entry).some((key) => !["field", "from", "to", "material"].includes(key)) ||
      !boundedString(entry.field, 40, FIELD_PATTERN) || !boundedString(entry.from, CLARIFY_LIMITS.correctionFrom) ||
      !boundedString(entry.to, 64) || typeof entry.material !== "boolean")
  ) {
    issues.push({ path: at("corrections"), message: `Corrections are { field, from (at most ${CLARIFY_LIMITS.correctionFrom} characters), to, material }.` });
  }
  const turns = input.turns;
  if (
    !Array.isArray(turns) || turns.length > THREAD_LIMITS.storedTurns ||
    turns.some((entry) =>
      !isRecord(entry) || Object.keys(entry).some((key) => !["role", "kind", "label"].includes(key)) ||
      (entry.role !== "user" && entry.role !== "kletia") || !boundedString(entry.kind, 24, /^[a-z_]+$/u) || !boundedString(entry.label, 160))
  ) {
    issues.push({ path: at("turns"), message: `At most ${THREAD_LIMITS.storedTurns} turns of { role, kind, label }.` });
  }
  const undo = input.undo;
  if (!Array.isArray(undo) || undo.length > THREAD_LIMITS.undoSnapshots) {
    issues.push({ path: at("undo"), message: `At most ${THREAD_LIMITS.undoSnapshots} undo snapshots.` });
  } else {
    undo.forEach((snapshot, index) => validateSteps(snapshot, `${at("undo")}[${index}]`, issues));
  }
}

/** Shape, size and slot syntax of a client-held thread (`THREAD_INVALID` when it fails). */
export function validateThread(input: unknown): ValidationResult<ClarifyThread> {
  const issues: ValidationIssue[] = [];
  threadIssues(input, "", issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: input as unknown as ClarifyThread };
}

const TURN_REQUEST_KEYS = [
  "accounts", "defaultNetwork", "sourceNetwork", "constraints", "metadata", "clientReference",
  "text", "answer", "assumption", "thread", "threadId", "remember", "expectedRev",
];
const QUESTION_ID_PATTERN = /^q\.[\w.[\]-]{1,94}$/u;
const ASSUMPTION_ID_PATTERN = /^a\.[\w.[\]-]{1,94}$/u;
const OPTION_ID_PATTERN = /^[\w.:[\]-]{1,128}$/u;

/**
 * Validates one clarify turn: at most one input (text, answer,
 * assumption), at most one memory (thread, threadId), `remember` only on a
 * first turn, `expectedRev` only with `threadId`, the request context as
 * `validateIntentRequest` reads it with a clientReference of at most 72
 * characters, and accounts required unless a Kletia-held thread keeps
 * them. Structured `actions` are refused: structured requests are explicit
 * by construction.
 */
export function validateIntentTurnRequest(input: unknown): ValidationResult<IntentTurnRequest> {
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  const issues: ValidationIssue[] = [];
  if (input.actions !== undefined) {
    issues.push({ path: "actions", message: "Clarify turns take text; send structured actions without clarify." });
  }
  unknownKeys(input, [...TURN_REQUEST_KEYS, "actions"], "", issues);

  const inputs = (["text", "answer", "assumption"] as const).filter((key) => input[key] !== undefined);
  if (inputs.length > 1) issues.push({ path: inputs[1] as string, message: "Send at most one of text, answer and assumption." });
  const hasThread = input.thread !== undefined;
  const hasThreadId = input.threadId !== undefined;
  if (hasThread && hasThreadId) issues.push({ path: "threadId", message: "Send either thread or threadId, not both." });
  if (!hasThread && !hasThreadId && input.text === undefined) {
    issues.push({ path: "text", message: "A first turn needs text." });
  }

  const text = input.text;
  if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > CLARIFY_LIMITS.text)) {
    issues.push({ path: "text", message: `Must be a non-empty string up to ${CLARIFY_LIMITS.text} characters.` });
  }
  const answer = input.answer;
  if (answer !== undefined) {
    if (!isRecord(answer)) issues.push({ path: "answer", message: "An answer is { question, option } or { question, text }." });
    else {
      unknownKeys(answer, ["question", "option", "text"], "answer", issues);
      if (!boundedString(answer.question, 96, QUESTION_ID_PATTERN)) issues.push({ path: "answer.question", message: "Must be an open question id (q.…)." });
      if ((answer.option === undefined) === (answer.text === undefined)) {
        issues.push({ path: "answer", message: "Send exactly one of option and text." });
      }
      if (answer.option !== undefined && !boundedString(answer.option, 128, OPTION_ID_PATTERN)) {
        issues.push({ path: "answer.option", message: "Must be an option id of the question." });
      }
      if (answer.text !== undefined && (typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > CLARIFY_LIMITS.text)) {
        issues.push({ path: "answer.text", message: `Must be a non-empty string up to ${CLARIFY_LIMITS.text} characters.` });
      }
    }
  }
  const assumption = input.assumption;
  if (assumption !== undefined) {
    if (!isRecord(assumption)) issues.push({ path: "assumption", message: "A chip change is { id, option }." });
    else {
      unknownKeys(assumption, ["id", "option"], "assumption", issues);
      if (!boundedString(assumption.id, 96, ASSUMPTION_ID_PATTERN)) issues.push({ path: "assumption.id", message: "Must be an assumption id (a.…)." });
      if (!boundedString(assumption.option, 128, OPTION_ID_PATTERN)) issues.push({ path: "assumption.option", message: "Must be one of the chip's alternatives." });
    }
  }
  if ((answer !== undefined || assumption !== undefined) && !hasThread && !hasThreadId) {
    issues.push({ path: answer !== undefined ? "answer" : "assumption", message: "Answers and chip changes need the thread they belong to." });
  }

  if (hasThread) threadIssues(input.thread, "thread", issues);
  if (hasThreadId && !isThreadId(input.threadId)) issues.push({ path: "threadId", message: "Must be th_ followed by 24 base32 characters." });
  if (input.remember !== undefined) {
    if (typeof input.remember !== "boolean") issues.push({ path: "remember", message: "Must be a boolean." });
    else if (input.remember && (hasThread || hasThreadId)) issues.push({ path: "remember", message: "Only a first turn creates a remembered thread." });
  }
  if (input.expectedRev !== undefined) {
    if (!Number.isSafeInteger(input.expectedRev) || (input.expectedRev as number) < 0) {
      issues.push({ path: "expectedRev", message: "Must be a non-negative integer." });
    } else if (!hasThreadId) issues.push({ path: "expectedRev", message: "expectedRev applies to a remembered thread (threadId)." });
  }

  const context = validateIntentContext(input, issues, {
    requireAccounts: !hasThreadId,
    clientReferenceMax: CLARIFY_LIMITS.clientReference,
  });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      ...context,
      ...(typeof text === "string" ? { text: text.trim() } : {}),
      ...(isRecord(answer)
        ? { answer: { question: answer.question as string, ...(answer.option !== undefined ? { option: answer.option as string } : { text: (answer.text as string).trim() }) } }
        : {}),
      ...(isRecord(assumption) ? { assumption: { id: assumption.id as string, option: assumption.option as string } } : {}),
      ...(hasThread ? { thread: input.thread as unknown as ClarifyThread } : {}),
      ...(hasThreadId ? { threadId: input.threadId as string } : {}),
      ...(input.remember === true ? { remember: true } : {}),
      ...(input.expectedRev !== undefined ? { expectedRev: input.expectedRev as number } : {}),
    },
  };
}

