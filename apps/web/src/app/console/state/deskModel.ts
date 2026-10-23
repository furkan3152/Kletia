/**
 * The desk's pure model: departure options, accounts per lane, submission
 * routing, where a plan starts and ends, and the composer's checks.
 * Registry-driven: nothing here is hard-coded per network. Pure, so node
 * --test loads it (ported from the prototype `deskModel.mjs`).
 */
import {
  CHAINS,
  NETWORK_KEYS,
  formatAccountId,
  isNetworkKey,
  isSolanaAddress,
  resolveChain,
  type AccountId,
  type ChainNamespace,
  type NetworkKey,
} from "@kletia/core";

import { DELAYED_ABOVE_MS } from "../../site/art/boardFormat.ts";
import { DESK_COPY } from "../content/copy.ts";
import { containsSensitivePromptMaterial } from "../../../shared/security/promptSecrets.ts";
import { formatUsd, holdingLabels, type NetworkHoldings } from "./holdings.ts";

export type Lane = "production" | "testnet";
/** Where the money of the next task starts: Auto or one of the nine networks. */
export type Departure = "auto" | NetworkKey;
/** Networks with a legacy chat engine (`POST /api/intent`). */
export type LegacyNetwork = "base" | "arbitrum" | "arc";

export const LEGACY_NETWORKS: readonly LegacyNetwork[] = Object.freeze(["base", "arbitrum", "arc"]);

/** Per-browser departure choice; mirrored to `?from=`. */
export const DEPARTURE_STORAGE_KEY = "kletia-desk-departure";

/** Latency above which a running network is shown as delayed: the departure board's own limit (see boardFormat.ts for why 3 s). */
export const DELAYED_LATENCY_MS = DELAYED_ABOVE_MS;

export function isLegacyNetwork(value: unknown): value is LegacyNetwork {
  return typeof value === "string" && (LEGACY_NETWORKS as readonly string[]).includes(value);
}

/** A stored or linked departure (`?from=`, localStorage); anything unknown is ignored. */
export function parseDeparture(value: unknown): Departure | null {
  if (value === "auto") return "auto";
  return isNetworkKey(value) ? value : null;
}

export function laneOf(departure: Departure | null | undefined): Lane {
  return departure && departure !== "auto" && CHAINS[departure].lane === "testnet" ? "testnet" : "production";
}

// --- Departure board -------------------------------------------------------

export interface HealthReading {
  readonly ok: boolean;
  readonly latencyMs?: number | null;
}

export type DepartureStatus = "running" | "delayed" | "no-service" | "not-offered" | "unknown";

export interface DepartureOption {
  readonly key: NetworkKey;
  readonly name: string;
  readonly shortName: string;
  readonly lane: Lane;
  readonly namespace: ChainNamespace;
  readonly status: DepartureStatus;
  readonly walletConnected: boolean;
  /** Only a hint: a missing wallet never disables a row. */
  readonly walletHint: string | null;
  readonly holdings: NetworkHoldings | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}

export interface DepartureBoard {
  readonly auto: { readonly key: "auto"; readonly name: string; readonly description: string };
  readonly production: readonly DepartureOption[];
  readonly testnet: readonly DepartureOption[];
  /** The test yard is collapsed unless a testnet is the current departure. */
  readonly yardCollapsed: boolean;
}

/**
 * Every registry network as a departure option, production first, then the
 * test yard. Only two things disable a row: the deployment does not offer the
 * network (`GET /v1/networks` omits it) or its health reading is not ok.
 */
export function departureOptions({
  health = {},
  holdings = {},
  wallets = { evm: false, solana: false },
  offered = null,
  current = "auto",
}: {
  readonly health?: Readonly<Partial<Record<NetworkKey, HealthReading>>>;
  readonly holdings?: Readonly<Partial<Record<NetworkKey, NetworkHoldings>>>;
  readonly wallets?: { readonly evm?: boolean; readonly solana?: boolean };
  /** Network keys `GET /v1/networks` lists; null when unknown (every row stays offered). */
  readonly offered?: readonly NetworkKey[] | null;
  readonly current?: Departure;
} = {}): DepartureBoard {
  const copy = DESK_COPY.departure;
  const option = (key: NetworkKey): DepartureOption => {
    const chain = CHAINS[key];
    const reading = health[key];
    const needs = chain.namespace === "solana" ? "solana" : "evm";
    const notOffered = offered !== null && !offered.includes(key);
    const noService = !notOffered && reading?.ok === false;
    const status: DepartureStatus = notOffered
      ? "not-offered"
      : !reading
        ? "unknown"
        : !reading.ok
          ? "no-service"
          : (reading.latencyMs ?? 0) > DELAYED_LATENCY_MS
            ? "delayed"
            : "running";
    const disabledReason = notOffered ? copy.disabledNotOffered : noService ? copy.disabledNoService : null;
    const walletConnected = wallets[needs] === true;
    return {
      key,
      name: chain.name,
      shortName: chain.shortName,
      lane: chain.lane === "testnet" ? "testnet" : "production",
      namespace: chain.namespace,
      status,
      walletConnected,
      walletHint: walletConnected ? null : needs === "solana" ? copy.walletHintSolana : copy.walletHintEvm,
      holdings: holdings[key] ?? null,
      disabled: disabledReason !== null,
      disabledReason,
    };
  };
  const all = NETWORK_KEYS.map(option);
  return {
    auto: { key: "auto", name: copy.auto, description: copy.autoDescription },
    production: all.filter((entry) => entry.lane === "production"),
    testnet: all.filter((entry) => entry.lane === "testnet"),
    yardCollapsed: laneOf(current) !== "testnet",
  };
}

/** `GET /v1/health` networks as readings per network key. */
export function healthReadings(
  networks: readonly { readonly network: string; readonly ok: boolean; readonly latencyMs?: number }[] | null | undefined,
): Partial<Record<NetworkKey, HealthReading>> {
  const readings: Partial<Record<NetworkKey, HealthReading>> = {};
  for (const entry of networks ?? []) {
    if (isNetworkKey(entry.network)) readings[entry.network] = { ok: entry.ok === true, latencyMs: entry.latencyMs ?? null };
  }
  return readings;
}

/** Network keys `GET /v1/networks` offers (unknown keys are dropped). */
export function offeredNetworks(networks: readonly { readonly key: string }[] | null | undefined): NetworkKey[] | null {
  if (!networks) return null;
  return networks.map((network) => network.key).filter(isNetworkKey);
}

const STATUS_WORDS: Readonly<Record<DepartureStatus, string>> = {
  running: DESK_COPY.departure.status.running,
  delayed: DESK_COPY.departure.status.delayed,
  "no-service": DESK_COPY.departure.status.noService,
  "not-offered": DESK_COPY.departure.status.notOffered,
  unknown: DESK_COPY.departure.status.unknown,
};

export function departureStatusWord(status: DepartureStatus): string {
  return STATUS_WORDS[status];
}

/**
 * A row's accessible name, read like a sentence: "Base, production,
 * 120.4 USDC and 0.002 ETH, about 128 dollars, running". Testnets never
 * print dollars. The disabled reason is the row's description, not its name.
 */
export function departureRowLabel(option: DepartureOption): string {
  const copy = DESK_COPY.departure;
  const lane = option.lane === "testnet" ? copy.lanes.testnet : copy.lanes.production;
  const labels = holdingLabels(option.holdings);
  const balances = option.holdings === null ? "" : labels.length > 0 ? labels.join(" and ") : copy.empty;
  const value =
    option.lane === "testnet" || !option.holdings || option.holdings.totalUsd <= 0
      ? ""
      : copy.aboutDollars(String(Math.round(option.holdings.totalUsd)));
  return copy.rowLabel(option.name, lane, balances, value, departureStatusWord(option.status).toLowerCase());
}

/** The composer chip's caption (desktop): what the departure means right now. */
export function departureCaption({
  departure,
  holdings,
  walletsConnected,
  mostFundedNetwork,
}: {
  readonly departure: Departure;
  readonly holdings: NetworkHoldings | null;
  readonly walletsConnected: boolean;
  readonly mostFundedNetwork: NetworkKey | null;
}): string {
  const copy = DESK_COPY.departure;
  if (departure === "auto") {
    return walletsConnected && mostFundedNetwork ? copy.captionAutoMostFunds(CHAINS[mostFundedNetwork].shortName) : copy.captionAutoNoWallet;
  }
  if (laneOf(departure) === "testnet") return copy.captionTestYard;
  if (!holdings) return "";
  if (holdings.top.length === 0) return copy.captionEmpty;
  // Priced value first; a network holding only unpriced assets shows its largest holding.
  const usd = holdings.totalUsd > 0 ? formatUsd(holdings.totalUsd) : null;
  return copy.captionHere(usd ?? holdingLabels(holdings, 1)[0]!);
}

// --- Accounts ----------------------------------------------------------------

/**
 * Accounts sent to the planner: homed on the lane (and on the departure's EVM
 * chain when it has one), never on the chain the wallet happens to be on. The
 * engine re-homes accounts per step, so this only removes the dependency on
 * the wallet's current chain.
 */
export function accountsForLane(
  { evm, solana }: { readonly evm?: string | null; readonly solana?: string | null },
  lane: Lane,
  departure: Departure | null | undefined,
): AccountId[] {
  const depart = departure && departure !== "auto" ? CHAINS[departure] : null;
  const departOnLane = depart && (depart.lane === "testnet" ? "testnet" : "production") === lane ? depart : null;
  const evmHome: NetworkKey = departOnLane?.namespace === "eip155" ? departOnLane.key : lane === "testnet" ? "arc" : "base";
  const solanaHome: NetworkKey = lane === "testnet" ? "solana-devnet" : "solana";
  return [
    ...(evm ? [formatAccountId(evmHome, evm)] : []),
    ...(solana ? [formatAccountId(solanaHome, solana)] : []),
  ];
}

/** Fields a planner request carries for a departure. */
export function departureRequestFields(
  departure: Departure,
): { readonly sourceNetwork: Departure; readonly defaultNetwork?: NetworkKey } {
  return departure === "auto" ? { sourceNetwork: "auto" } : { sourceNetwork: departure, defaultNetwork: departure };
}

// --- Routing -----------------------------------------------------------------

const NETWORK_WORD =
  /\b(?:on|from|to|via|in|into|onto)\s+(arbitrum[\s-]+sepolia|arb[\s-]+sepolia|solana[\s-]+devnet|arc[\s-]+testnet|base[\s-]+mainnet|arbitrum[\s-]+one|op[\s-]+mainnet|polygon[\s-]+pos|base|arbitrum|arb|arc|solana|sol|devnet|ethereum|eth|optimism|op|polygon|matic)\b/giu;

/** Networks a sentence names after a preposition, in order (registry keys, read from the registry aliases). */
export function networksNamedIn(text: string): NetworkKey[] {
  const found: NetworkKey[] = [];
  for (const match of text.matchAll(NETWORK_WORD)) {
    const word = (match[1] ?? "").replace(/\s+/gu, " ").toLowerCase();
    // "arbitrum sepolia" is registered as "arbitrum-sepolia": try the hyphenated form as well.
    const chain = resolveChain(word) ?? resolveChain(word.replace(/ /gu, "-")) ?? (word === "eth" ? CHAINS.ethereum : null);
    if (chain && !found.includes(chain.key)) found.push(chain.key);
  }
  return found;
}

/** Words that ask about rates, not for a transaction. */
const RATE_WORD = /\b(?:rates?|yields?|apys?|aprs?|interest)\b/iu;
/** How a read-only question starts ("compare yield", "show live Aave rates", "what is the best USDC rate"). */
const QUESTION_START = /^(?:please\s+)?(?:compare|show|list|what(?:'s| is| are)?|which|where|check|find|see|get|tell me)\b/iu;
/** An action with an amount ("supply 10 USDC ... after checking the rate") is a transaction, not a question. */
const ACTION_WITH_AMOUNT = /\b(?:swap|bridge|send|deposit|supply|lend|stake|withdraw|buy|sell|borrow|repay|move|put)\s+(?:\$?\d|all\b|half\b|my\b)/iu;

/**
 * A read-only rate question: lending rates are read from `GET /v1/venues`
 * without a wallet, nothing is planned and nothing can be signed.
 */
export function isRateQuestion(text: string): boolean {
  const sentence = text.trim();
  if (!RATE_WORD.test(sentence) || ACTION_WITH_AMOUNT.test(sentence)) return false;
  return QUESTION_START.test(sentence) || /\bwithout preparing a transaction\b/iu.test(sentence);
}

export type SubmissionRoute =
  | { readonly engine: "platform" }
  /** A read-only rate question: answered from Kletia's venue list, no wallet needed. */
  | { readonly engine: "rates" }
  | { readonly engine: "network"; readonly network: LegacyNetwork; readonly why: "tool" | "fallback" }
  | { readonly engine: "offer"; readonly networks: readonly LegacyNetwork[] }
  | { readonly engine: "none"; readonly why: "refused" | "solana" | "network-without-engine" };

/**
 * Where a submission goes. A read-only rate question is answered from the
 * venue list; everything else goes to the platform first; a network engine only when the
 * platform said INTENT_UNSUPPORTED and the sentence (or the departure) names
 * Base, Arbitrum One or Arc, or a tool pinned the engine. Every other refusal
 * is final: it is a safety or input check, not a grammar gap.
 */
export function routeSubmission({
  text,
  departure = "auto",
  enginePin = null,
  platformError = null,
}: {
  readonly text: string;
  readonly departure?: Departure;
  readonly enginePin?: LegacyNetwork | null;
  readonly platformError?: string | null;
}): SubmissionRoute {
  // Reading rates needs no wallet and no network engine, whoever pinned one.
  if (!platformError && isRateQuestion(text)) return { engine: "rates" };
  if (enginePin) return { engine: "network", network: enginePin, why: "tool" };
  if (!platformError) return { engine: "platform" };
  if (platformError !== "INTENT_UNSUPPORTED") return { engine: "none", why: "refused" };
  const named = networksNamedIn(text);
  const touchesSolana =
    named.some((network) => CHAINS[network].namespace === "solana") ||
    [...text.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu)].some((match) => isSolanaAddress(match[0]));
  if (touchesSolana) return { engine: "none", why: "solana" };
  const target =
    named.find(isLegacyNetwork) ?? (named.length === 0 && isLegacyNetwork(departure) ? departure : null);
  if (named.some((network) => !isLegacyNetwork(network))) return { engine: "none", why: "network-without-engine" };
  return target ? { engine: "network", network: target, why: "fallback" } : { engine: "offer", networks: LEGACY_NETWORKS };
}

// --- Plans -------------------------------------------------------------------

interface StepLike {
  readonly index: number;
  readonly network: NetworkKey;
  readonly settlement?: { readonly destinationNetwork?: NetworkKey } | null;
}

/** Where a plan starts and ends (first step's network, last step's destination). */
export function journeyEnds(intent: { readonly steps: readonly StepLike[] }): { readonly from: NetworkKey; readonly to: NetworkKey } | null {
  const steps = [...intent.steps].sort((a, b) => a.index - b.index);
  const first = steps[0];
  const last = steps[steps.length - 1];
  return first && last ? { from: first.network, to: last.settlement?.destinationNetwork ?? last.network } : null;
}

/** `interpretation.departure` of a plan (core IntentInterpretation). */
export interface PlanDeparture {
  readonly network: NetworkKey;
  readonly chosen: "text" | "request" | "auto" | "inferred";
  readonly bridged?: boolean;
  readonly reason?: string;
}

export interface DepartureLine {
  readonly text: string;
  /** "notice": printed as the yellow notice (the plan departs elsewhere than chosen). */
  readonly tone: "plain" | "notice";
  /** change: offer "Change"; start-from-requested: re-plan with the chosen network as defaultNetwork only. */
  readonly action: "change" | "start-from-requested" | null;
}

/**
 * The ticket's departure line: what the plan actually uses. `holding` is
 * the balance that made Auto pick the network ("120.40 USDC"). An API
 * without `interpretation.departure` (older) is compared with the chosen
 * departure, so a plan that starts elsewhere is never silent.
 */
export function departureLine({
  requested,
  intent,
  holding = null,
}: {
  readonly requested: Departure;
  readonly intent: {
    readonly steps: readonly StepLike[];
    readonly interpretation?: { readonly departure?: PlanDeparture | null } | null;
  };
  readonly holding?: string | null;
}): DepartureLine | null {
  const copy = DESK_COPY.ticket.lines;
  const ends = journeyEnds(intent);
  const departure = intent.interpretation?.departure ?? null;
  if (!ends && !departure) return null;
  const network = departure?.network ?? ends!.from;
  const name = CHAINS[network].shortName;
  if (!departure) {
    if (requested !== "auto" && requested !== network) {
      return { text: copy.mismatch(name, CHAINS[requested].shortName), tone: "notice", action: "start-from-requested" };
    }
    return { text: copy.inferred(name), tone: "plain", action: null };
  }
  switch (departure.chosen) {
    case "auto":
      return { text: holding ? copy.auto(name, holding) : copy.autoNoHolding(name), tone: "plain", action: "change" };
    case "request": {
      const first = [...intent.steps].sort((a, b) => a.index - b.index)[0];
      const destination = departure.bridged ? first?.settlement?.destinationNetwork : undefined;
      return destination
        ? { text: copy.requestBridged(name, CHAINS[destination].shortName), tone: "plain", action: null }
        : { text: copy.request(name), tone: "plain", action: null };
    }
    case "text":
      return requested !== "auto" && requested !== network
        ? { text: copy.text(name, CHAINS[requested].shortName), tone: "notice", action: null }
        : { text: copy.inferred(name), tone: "plain", action: null };
    default:
      return { text: copy.inferred(name), tone: "plain", action: null };
  }
}

// --- Composer ----------------------------------------------------------------

/** Longest sentence the composer sends. */
export const COMPOSER_LIMIT = 500;

export type DeskView = "desk" | "tasks" | "holdings" | "tools" | "activity" | "dashboard";

export type ComposerVerdict =
  | { readonly kind: "empty" }
  | { readonly kind: "too-long"; readonly limit: number }
  | { readonly kind: "secret" }
  | { readonly kind: "placeholder"; readonly placeholder: string; readonly start: number; readonly end: number }
  | { readonly kind: "command"; readonly view: DeskView }
  | { readonly kind: "sentence"; readonly text: string };

/** Desk commands, matched exactly and only these. */
export const DESK_COMMANDS: Readonly<Record<string, DeskView>> = Object.freeze({
  "show my portfolio": "holdings",
  "show my balances": "holdings",
  "show my holdings": "holdings",
  "show my activity": "activity",
  "show my dashboard": "dashboard",
  "open tools": "tools",
});

/** Placeholders a template leaves for the user to replace ("[EDIT MAX USDC]", "<address>"). */
const PLACEHOLDER = /\[EDIT[^\]]*\]|<[a-z][a-z ]{0,30}>/iu;

/**
 * What the composer does with a sentence before anything leaves the browser:
 * length, secrets (refused, nothing stored), placeholders (blocked and
 * selected), desk commands (open a view), otherwise plan it.
 */
export function composerVerdict(raw: string): ComposerVerdict {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (text.length > COMPOSER_LIMIT) return { kind: "too-long", limit: COMPOSER_LIMIT };
  if (containsSensitivePromptMaterial(text)) return { kind: "secret" };
  const placeholder = PLACEHOLDER.exec(raw);
  if (placeholder) {
    return { kind: "placeholder", placeholder: placeholder[0], start: placeholder.index, end: placeholder.index + placeholder[0].length };
  }
  const command = DESK_COMMANDS[text.toLowerCase().replace(/\s+/gu, " ")];
  if (command) return { kind: "command", view: command };
  return { kind: "sentence", text };
}
