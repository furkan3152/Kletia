/**
 * Pure rules of a desk task: how a plan failure is handled, which
 * wallets a plan still needs, where the money can start when the planner
 * asks (SOURCE_REQUIRED), the ticket's serial and stamp, and how an
 * execution status maps onto the task. No React, no storage: node --test
 * loads it.
 */
import { CHAINS, NETWORK_KEYS, isNetworkKey, type NetworkKey } from "@kletia/core";

import { routeSubmission, type Departure, type Lane, type SubmissionRoute } from "../state/deskModel.ts";
import type { TaskStatus } from "../state/deskStore.ts";
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

/** The stamp a ticket carries for a task state (art system stamps). */
export function stampFor(status: TaskStatus): "planned" | "signed" | "settled" | "held" | "failed" {
  switch (status) {
    case "executing":
      return "signed";
    case "completed":
      return "settled";
    case "paused":
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

/** Execution statuses of `useIntentExecution`, mirrored without importing it (it needs React). */
export type ExecutionStatus = "idle" | "planning" | "review" | "executing" | "paused" | "completed" | "failed" | "cancelled";

/** The task status an execution status stands for; null keeps the task as it is (idle). */
export function taskStatusOf(status: ExecutionStatus): TaskStatus | null {
  return status === "idle" ? null : status;
}

// --- Plan failures ------------------------------------------------------------

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
  /** The API could not answer (offline, rate limit, 5xx): retry the same plan. */
  | { readonly kind: "retry" }
  /** Any other refusal: a safety or input check, shown as is and never retried elsewhere. */
  | { readonly kind: "refused" };

/**
 * Where a failed plan goes. Platform first; a network engine only on
 * engine only on INTENT_UNSUPPORTED for a sentence that names Base, Arbitrum
 * One or Arc (or with one of them as the departure). A missing source is a
 * question, never a refusal.
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

/** Time of day for task rows and holdings ("12:44"), in the visitor's locale (24 h). */
export function clockOf(at: number | string | null | undefined): string {
  const time = typeof at === "string" ? Date.parse(at) : at;
  if (typeof time !== "number" || !Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
