/**
 * Pure rules of a desk task: how a plan failure is handled, which
 * wallets a plan still needs, where the money can start when the planner
 * asks (SOURCE_REQUIRED), the ticket's serial and stamp, and how an
 * execution status maps onto the task. No React, no storage: node --test
 * loads it.
 */
import { CHAINS, NETWORK_KEYS, getProtocol, isNetworkKey, type NetworkKey } from "@kletia/core";

import { formatUtcMinutes } from "../../site/format/utcTime.ts";
import { DESK_COPY } from "../content/copy.ts";
import { routeSubmission, type Departure, type Lane, type SubmissionRoute } from "../state/deskModel.ts";
import type { SignatureState, TaskStatus } from "../state/deskStore.ts";
import type { HoldingsSnapshot } from "../state/holdings.ts";

export type WalletNamespace = "eip155" | "solana";

// --- Plans ------------------------------------------------------------------

interface PlanStepLike {
  readonly index: number;
  readonly network: NetworkKey;
  readonly settlement?: { readonly destinationNetwork?: NetworkKey } | null;
}

interface PlanLike {
  readonly steps: readonly PlanStepLike[];
  readonly summary?: { readonly networks?: readonly NetworkKey[] } | null;
}

/** The wallet namespaces a plan touches: every step's network and destination, and the summary's networks. */
export function namespacesOf(intent: PlanLike): ReadonlySet<WalletNamespace> {
  const networks = new Set<NetworkKey>();
  for (const step of intent.steps) {
    networks.add(step.network);
    if (step.settlement?.destinationNetwork) networks.add(step.settlement.destinationNetwork);
  }
  for (const network of intent.summary?.networks ?? []) networks.add(network);
  const namespaces = new Set<WalletNamespace>();
  for (const network of networks) {
    if (isNetworkKey(network)) namespaces.add(CHAINS[network].namespace === "solana" ? "solana" : "eip155");
  }
  return namespaces;
}

/** Wallets the plan needs that are not connected, EVM first: exactly the connect buttons the preview shows. */
export function missingWallets(
  intent: PlanLike,
  connected: { readonly evm: boolean; readonly solana: boolean },
): readonly WalletNamespace[] {
  const needed = namespacesOf(intent);
  return (["eip155", "solana"] as const).filter((namespace) =>
    needed.has(namespace) && !(namespace === "eip155" ? connected.evm : connected.solana),
  );
}

/** "int_7f3ac21e…" or a task uuid -> "7F3A-C21E": the last eight letters and digits. */
export function serialOf(id: string): string {
  const chars = id.replace(/[^a-z0-9]/giu, "").toUpperCase().slice(-8).padStart(8, "0");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * What is known about the wallet's signatures for a task's intent:
 * "signed" once a wallet returned a reference (or the API moved a step past
 * signing), "unknown" while a request was sent to the wallet and no outcome
 * came back (it may still be open, or it may have been sent), "none" when
 * nothing was ever signed. Only "signed" may be printed as signed.
 */
export type { SignatureState };

interface SignedStepLike {
  readonly id: string;
  readonly status: string;
  readonly references?: readonly string[] | null;
}

/** API step statuses that only exist after a wallet produced a reference. */
const PAST_SIGNING = new Set(["submitted", "confirmed", "settling", "settled", "indeterminate"]);

/**
 * The signature state of an intent from the API's steps, the browser's
 * local phases (`confirming`: the wallet returned a reference) and the steps
 * whose signature request has no known outcome yet.
 */
export function signatureStateOf(
  intent: { readonly steps: readonly SignedStepLike[] } | null,
  phases: Readonly<Record<string, string>> = {},
  unknownStepIds: readonly string[] = [],
): SignatureState {
  if (!intent) return "none";
  const signed = intent.steps.some(
    (step) => (step.references?.length ?? 0) > 0 || PAST_SIGNING.has(step.status) || phases[step.id] === "confirming",
  );
  if (signed) return "signed";
  const pending = intent.steps.some((step) => phases[step.id] === "signing" || unknownStepIds.includes(step.id));
  return pending ? "unknown" : "none";
}

type StampWord = "planned" | "signed" | "settled" | "held" | "failed";

/** The stamp a ticket carries for a task state (art system stamps). Never "signed" without a signature. */
export function stampFor(status: TaskStatus, signature: SignatureState = "unknown"): StampWord {
  switch (status) {
    case "executing":
      return signature === "signed" ? "signed" : "planned";
    case "completed":
      return "settled";
    case "paused":
      return signature === "none" ? "planned" : "held";
    case "question":
      return "held";
    case "failed":
    case "cancelled":
    case "unsupported":
      return "failed";
    default:
      return "planned";
  }
}

export interface TicketStamp {
  readonly state: StampWord;
  readonly detail?: string;
  /** The visually hidden sentence printed next to the stamp. */
  readonly sentence: string;
}

const STAMP_SENTENCE: Readonly<Record<StampWord, string>> = {
  planned: "Planned. Nothing has been signed.",
  signed: "Signed in the user's wallet. Waiting for on-chain evidence.",
  settled: "Settled. Every leg was seen on-chain.",
  held: "Held. The outcome is unknown and will be recovered by transaction hash.",
  failed: "Failed. The route stopped before every leg settled.",
};

/**
 * The stamp of a task's ticket, or null when there is no outcome to stamp:
 * an open question, a sentence Kletia cannot plan yet (a neutral note, not a
 * failure) and a network engine task (the engine shows its own state).
 * A task whose intent was never signed never reads "signed" or "held".
 */
export function ticketStampOf(task: {
  readonly status: TaskStatus;
  readonly intentId: string | null;
  readonly signature?: SignatureState;
  readonly engine?: { readonly kind: string };
}): TicketStamp | null {
  if (task.engine?.kind === "rates" || task.engine?.kind === "assistant") return null;
  if (task.status === "question" || task.status === "unsupported" || task.status === "engine" || task.status === "handoff") return null;
  const signature = task.signature ?? "unknown";
  const state = stampFor(task.status, signature);
  if (task.status === "executing" && state === "planned") {
    return { state, detail: "NOT SIGNED YET", sentence: "Waiting for your approval. Nothing has been signed." };
  }
  if (task.status === "paused" && state === "planned") {
    return { state, detail: "NOT SIGNED YET", sentence: "Paused. Nothing has been signed." };
  }
  if (task.status === "cancelled" && signature === "none") return { state, detail: "CANCELLED", sentence: "Cancelled. Nothing was signed." };
  if (state === "failed" && task.intentId === null) return { state, detail: "NOT PLANNED", sentence: "Not planned. Nothing was signed." };
  if (state === "failed" && signature === "none") return { state, detail: "NOTHING SIGNED", sentence: "Stopped. Nothing was signed." };
  return { state, sentence: STAMP_SENTENCE[state] };
}

/** What the ticket says (visually hidden) when it carries no stamp. */
export function unstampedSentence(status: TaskStatus, engine?: { readonly kind: string }): string {
  if (engine?.kind === "rates" || engine?.kind === "assistant") return "Read only. Nothing was planned and nothing can be signed.";
  if (status === "unsupported") return "Kletia can't do that yet. Nothing was planned or signed.";
  if (status === "engine") return "Handed to a network engine. Nothing has been signed.";
  if (status === "handoff") return "Opened in its own view to check and sign there. Nothing has been signed.";
  return "Waiting for your answer. Nothing has been signed.";
}

/** The status word of a task row and ticket stub: "Signing" only while a signature exists or a wallet is asking. */
export function taskStatusLabel(task: {
  readonly status: TaskStatus;
  readonly signature?: SignatureState;
  readonly engine?: { readonly kind: string };
}): string {
  if (task.engine?.kind === "rates") {
    return task.status === "planning" ? DESK_COPY.rates.reading : task.status === "failed" ? DESK_COPY.tasks.status.failed : DESK_COPY.rates.readOnly;
  }
  if (task.engine?.kind === "assistant") {
    return task.status === "planning" ? DESK_COPY.assistant.reading : task.status === "failed" ? DESK_COPY.tasks.status.failed : DESK_COPY.assistant.answered;
  }
  if (task.status === "executing" && task.signature === "none") return DESK_COPY.tasks.awaitingApproval;
  if (task.status === "executing" && task.signature === "unknown") return DESK_COPY.tasks.inWallet;
  return DESK_COPY.tasks.status[task.status];
}

/** Execution statuses of `useIntentExecution`, mirrored without importing it (it needs React). */
export type ExecutionStatus = "idle" | "planning" | "review" | "executing" | "paused" | "completed" | "failed" | "cancelled";

/** The task status an execution status stands for; null keeps the task as it is (idle). */
export function taskStatusOf(status: ExecutionStatus): TaskStatus | null {
  return status === "idle" ? null : status;
}

/** Answer refusals after which the question cannot be answered any more (it timed out, or its thread moved on). */
const QUESTION_EXPIRED_CODES: ReadonlySet<string> = new Set(["QUESTION_NOT_OPEN", "THREAD_CLOSED", "THREAD_INVALID", "THREAD_CONFLICT", "THREAD_EXPIRED"]);

/** True when a refused answer leaves the question expired: its options are disabled and the card offers "Ask again". */
export function questionExpiredBy(code: string): boolean {
  return QUESTION_EXPIRED_CODES.has(code) || /_TIMEOUT$/u.test(code);
}

/** Task states whose stored intent is read again when the card mounts after the person left the desk. */
const STORED_INTENT_STATES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["review", "executing", "paused", "completed", "failed", "cancelled"]);

/**
 * What a platform task's card does when it mounts. A task is planned once
 * (`started`: its first turn was sent in this page). Coming back to the desk
 * (Menu, Developers, back) mounts the card again: a task with a stored intent
 * reads it again ("load": shown as it is, never signed on its own), a plan
 * whose answer was lost while away is asked again ("plan"), and anything else
 * is shown as the task record has it ("show"). Restored tasks (after a reload)
 * keep their own pick-up flow.
 */
export function mountActionOf(
  task: { readonly restored?: boolean; readonly sentence: string; readonly status: TaskStatus; readonly intentId: string | null },
  started: boolean,
): "plan" | "load" | "show" {
  if (task.restored || !task.sentence) return "show";
  if (!started) return "plan";
  if (task.intentId !== null && STORED_INTENT_STATES.has(task.status)) return "load";
  return task.status === "planning" ? "plan" : "show";
}

// --- Plan failures ------------------------------------------------------------

/**
 * Issue messages of an INTENT_UNSUPPORTED the planner gives for a sentence it
 * understood: no route with the holdings it read, holdings it could not
 * read, an ambiguous reference, too many steps.
 */
const UNDERSTOOD_ISSUE = /^(?:No route|Holdings unavailable|Ambiguous reference|Too many steps)\.$/u;

/** What the grammar says when a bridge has no source (older APIs answer INTENT_UNSUPPORTED with it). */
const MISSING_SOURCE_ISSUE = /say where the funds come from/iu;

export interface PlanFailureLike {
  readonly code: string;
  readonly message: string;
  /** HTTP status; 0 when the API could not be reached. */
  readonly status: number;
  readonly issues?: readonly { readonly path?: string; readonly message: string }[];
  readonly retryable?: boolean;
}

export type PlanFailureRoute =
  /** The planner needs to know where the money starts: chips re-plan with the choice. */
  | { readonly kind: "source" }
  /** SOURCE_UNREACHABLE: its message, nothing tried elsewhere. */
  | { readonly kind: "unreachable" }
  /** A wallet the plan needs is not connected: show the dry-run preview with the exact connect buttons. */
  | { readonly kind: "needs-wallet" }
  /** INTENT_UNSUPPORTED: a network engine, the engine offer, or the "not supported" panel. */
  | { readonly kind: "unsupported"; readonly route: SubmissionRoute }
  /**
   * INTENT_UNSUPPORTED for a sentence the planner understood (a goal with no
   * route from the holdings it could read, holdings it could not read, an
   * ambiguous "it"): a network engine would not do better, so the task
   * explains, and asks for a wallet when none is connected.
   */
  | { readonly kind: "understood" }
  /** The API could not answer (offline, rate limit, 5xx): retry the same plan. */
  | { readonly kind: "retry" }
  /** Any other refusal: a safety or input check, shown as is and never retried elsewhere. */
  | { readonly kind: "refused" };

/**
 * Where a failed plan goes. Platform first; a network engine only on
 * INTENT_UNSUPPORTED for a sentence the planner cannot express that names
 * Base, Arbitrum One or Arc (or with one of them as the departure). A
 * sentence it understood but could not route never goes to an engine. A
 * missing source is a question, never a refusal.
 */
export function routePlanFailure(
  failure: PlanFailureLike,
  { text, departure }: { readonly text: string; readonly departure: Departure },
): PlanFailureRoute {
  if (failure.code === "SOURCE_REQUIRED") return { kind: "source" };
  if (failure.code === "SOURCE_UNREACHABLE") return { kind: "unreachable" };
  if (failure.code === "INTENT_UNSUPPORTED" && (failure.issues ?? []).some((issue) => MISSING_SOURCE_ISSUE.test(issue.message))) {
    return { kind: "source" };
  }
  if (failure.code === "INTENT_UNSUPPORTED" && (failure.issues ?? []).some((issue) => UNDERSTOOD_ISSUE.test(issue.message))) {
    return { kind: "understood" };
  }
  if (failure.code === "INTENT_UNSUPPORTED") {
    return { kind: "unsupported", route: routeSubmission({ text, departure, platformError: failure.code }) };
  }
  if (failure.code === "ACCOUNT_REQUIRED" || failure.code === "WALLET_REQUIRED") return { kind: "needs-wallet" };
  if (failure.status === 0 || failure.status === 429 || failure.status >= 500) return { kind: "retry" };
  return { kind: "refused" };
}

// --- Where the money starts ---------------------------------------------------

export interface SourceCandidate {
  readonly network: NetworkKey;
  /** The balance the API (or the holdings) read there, as printed; null when unknown. */
  readonly balance: string | null;
  /** True when it covers the amount; null when unknown. */
  readonly enough: boolean | null;
}

export interface SourceQuestion {
  readonly asset: string | null;
  readonly amount: string | null;
  readonly candidates: readonly SourceCandidate[];
}

const AMOUNT = /^\d{1,30}(?:\.\d{1,36})?$/u;
const SYMBOL = /^[A-Za-z0-9.$-]{1,16}$/u;
const BALANCE = /^\d[\d.,]{0,39}$/u;
const MAX_CANDIDATES = 9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `error.details` of SOURCE_REQUIRED (`{ asset, amount, toNetwork,
 * candidates: [{ network, balance, enough }] }`), validated: anything that
 * does not parse is dropped, never guessed.
 */
export function parseSourceDetails(details: unknown): SourceQuestion | null {
  if (!isRecord(details) || !Array.isArray(details.candidates)) return null;
  const seen = new Set<NetworkKey>();
  const candidates: SourceCandidate[] = [];
  for (const entry of details.candidates.slice(0, MAX_CANDIDATES * 2)) {
    if (!isRecord(entry) || !isNetworkKey(entry.network) || seen.has(entry.network)) continue;
    seen.add(entry.network);
    candidates.push({
      network: entry.network,
      balance: typeof entry.balance === "string" && BALANCE.test(entry.balance) ? entry.balance : null,
      enough: typeof entry.enough === "boolean" ? entry.enough : null,
    });
  }
  return {
    asset: typeof details.asset === "string" && SYMBOL.test(details.asset) ? details.asset : null,
    amount: typeof details.amount === "string" && AMOUNT.test(details.amount) ? details.amount : null,
    // Funded networks first; the API's order otherwise.
    candidates: candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => Number(b.candidate.enough === true) - Number(a.candidate.enough === true) || a.index - b.index)
      .map((entry) => entry.candidate)
      .slice(0, MAX_CANDIDATES),
  };
}

/**
 * The networks offered when the planner needs a source but sent no
 * candidates (an older API, or an SDK that drops `details`): every network of
 * the lane, the ones holding the most first (from the holdings snapshot), the
 * registry order otherwise. Nothing is claimed about balances it did not read.
 */
export function fallbackSourceCandidates(lane: Lane, holdings: HoldingsSnapshot | null): readonly SourceCandidate[] {
  const networks = NETWORK_KEYS.filter((network) => (CHAINS[network].lane === "testnet" ? "testnet" : "production") === lane);
  const value = (network: NetworkKey) => holdings?.byNetwork[network]?.totalUsd ?? 0;
  return networks
    .map((network, index) => ({ network, index }))
    .sort((a, b) => value(b.network) - value(a.network) || a.index - b.index)
    .map(({ network }) => ({ network, balance: null, enough: null }));
}

// --- Composer helpers ---------------------------------------------------------

/** "bridge 25 USDC to <network>" style follow-up the Holdings "Fund" action fills in. */
export function fundSentence(from: NetworkKey, to: NetworkKey): string {
  const word = (network: NetworkKey) =>
    network === "arbitrum-sepolia" ? "arbitrum sepolia" : network === "solana-devnet" ? "solana devnet" : network;
  return `bridge 25 USDC from ${word(from)} to ${word(to)}`;
}

/** Time of day for task rows and holdings ("12:44 UTC"): every clock on the desk is UTC, 24 h. */
export function clockOf(at: number | string | null | undefined): string {
  const time = typeof at === "string" ? Date.parse(at) : at;
  if (typeof time !== "number" || !Number.isFinite(time)) return "";
  return formatUtcMinutes(time) ?? "";
}

// --- Review and sign ----------------------------------------------------------

interface VenueStepLike {
  readonly index: number;
  readonly protocol: string;
}

/** Protocol names of a plan, step by step ("Uniswap V3", "Aerodrome"). */
function venuesOf(intent: { readonly steps: readonly VenueStepLike[] }): string[] {
  return [...intent.steps].sort((a, b) => a.index - b.index).map((step) => getProtocol(step.protocol)?.name ?? step.protocol);
}

/**
 * The note shown when "Review and sign" planned the task again on another
 * venue than the preview showed (the stored plan is quoted afresh): what
 * changed, and that the ticket number changed with it. Null when the venues
 * are the same.
 */
export function venueChangeNote(
  before: { readonly steps: readonly VenueStepLike[] } | null,
  after: { readonly steps: readonly VenueStepLike[] },
): string | null {
  if (!before) return null;
  const was = venuesOf(before);
  const now = venuesOf(after);
  if (was.length === now.length && was.every((name, index) => name === now[index])) return null;
  const changed = now.filter((name, index) => name !== was[index]);
  const previous = was.filter((name, index) => name !== now[index]);
  return DESK_COPY.tasks.venueChanged(changed.join(", ") || now.join(", "), previous.join(", ") || was.join(", "));
}
