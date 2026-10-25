/**
 * The journey ledger model and remembered journey answers.
 */
import {
  openBlockers,
  type ConsequenceSeverity,
  type CustodyState,
  type HoldingRole,
  type Journey,
  type JourneyCertainty,
  type JourneyConsequence,
  type JourneyHolding,
  type JourneyLeg,
  type JourneyStop,
  type NetworkKey,
  type StopKind,
  type StopState,
} from "@kletia/core";
import {
  CERTAINTY_INFO,
  type CertaintyInfo,
  certaintyOf,
  cleanText,
  durationText,
  formatUsdAbs,
  httpsUrl,
  networkLabel,
  shortAddress,
  unsignedAmount,
} from "./text.js";
import { JOURNEY_HANDLE_IT_OPTION } from "./clarify.js";

/* =============================================================== journey */

/** The fare's certainty labels plus `observed` (seen on-chain; the strongest). */
export const JOURNEY_CERTAINTY_INFO: Readonly<Record<JourneyCertainty, CertaintyInfo>> = Object.freeze({
  observed: {
    label: "observed",
    spoken: "observed on-chain",
    sentence: "Observed: Kletia saw this amount on-chain.",
    shape: "square",
  },
  ...CERTAINTY_INFO,
});

function journeyCertaintyOf(value: unknown): JourneyCertainty {
  return value === "observed" ? "observed" : certaintyOf(value);
}

export type SeverityShape = "octagon" | "diamond" | "triangle" | "circle";

export interface SeveritySign {
  /** Fixed sign colours (never an appearance token): danger, warning or info. */
  readonly tone: "danger" | "warning" | "info";
  readonly shape: SeverityShape;
  /** Printed next to the shape: severity is never shape or colour alone. */
  readonly word: string;
  /** Read by screen readers before the notice title. */
  readonly spoken: string;
}

/**
 * Road signage for journey notices. Safety signage: not themable, the same
 * shapes and words in every host (the portal's status tones).
 */
export const SEVERITY_SIGNS: Readonly<Record<ConsequenceSeverity, SeveritySign>> = Object.freeze({
  block: Object.freeze({ tone: "danger", shape: "octagon", word: "Stop", spoken: "Stop, answer before the next signature" }),
  act: Object.freeze({ tone: "warning", shape: "diamond", word: "Act", spoken: "Action suggested" }),
  warn: Object.freeze({ tone: "warning", shape: "triangle", word: "Warning", spoken: "Warning" }),
  info: Object.freeze({ tone: "info", shape: "circle", word: "Info", spoken: "Information" }),
} as const);

const SEVERITY_ORDER: readonly ConsequenceSeverity[] = ["block", "act", "warn", "info"];

function severityRank(severity: unknown): number {
  const index = SEVERITY_ORDER.indexOf(severity as ConsequenceSeverity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

const STOP_KIND_LABEL: Readonly<Record<StopKind, string>> = Object.freeze({
  start: "Start",
  transit: "In transit",
  arrival: "Arrival",
  end: "End",
});

const STOP_STATE_LABEL: Readonly<Record<StopState, string>> = Object.freeze({
  upcoming: "Upcoming",
  current: "Now",
  passed: "Passed",
  skipped: "Skipped",
  failed: "Failed",
});

const VALUE_SOURCE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  "usd-par": "par",
  jupiter: "Jupiter",
  chainlink: "Chainlink",
  pyth: "Pyth",
  "venue-rate": "venue rate",
  testnet: "testnet, no value",
});

function custodyLabel(custody: CustodyState, stop: Pick<JourneyStop, "holder" | "venue">): string {
  switch (custody) {
    case "wallet":
      return stop.holder?.own ? "In your wallet" : "In a wallet you do not control";
    case "venue":
      return `At ${cleanText(stop.venue?.name ?? stop.holder?.label, 60) || "the venue"}`;
    case "provider":
      return `${cleanText(stop.holder?.label, 60) || "The provider"} holds it`;
    case "refund-due":
      return "Refund due";
    case "third-party":
      return "Paid out";
    default:
      return "Unknown: Kletia cannot tell where it is";
  }
}

function roleText(holding: Pick<JourneyHolding, "role" | "next">, legNumber: (legId: string) => number | null): string {
  const role: HoldingRole = holding.role;
  switch (role) {
    case "spent-next": {
      const number = holding.next ? legNumber(holding.next.legId) : null;
      const share = holding.next && holding.next.portionBps < 10_000 ? ` (${(holding.next.portionBps / 100).toFixed(holding.next.portionBps % 100 === 0 ? 0 : 2)} %)` : "";
      return number !== null ? `Spent by leg ${number}${share}` : `Spent by the next leg${share}`;
    }
    case "kept":
      return "Stays with you";
    case "gas":
      return "Kept for network fees";
    case "position":
      return "Your position";
    case "paid":
      return "Paid out";
    case "refund":
      return "Refund";
    default:
      return "";
  }
}

function clockText(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return `${new Date(time).toISOString().slice(11, 19)} UTC`;
}

function amountText(view: { readonly formatted?: unknown } | null | undefined, symbol: string): string | null {
  if (!view || typeof view.formatted !== "string" || !/^[+-]?[\d.]{1,80}$/u.test(view.formatted)) return null;
  return `${unsignedAmount(view.formatted)} ${symbol}`.trim();
}

export interface JourneyHoldingView {
  readonly symbol: string;
  /** "99.96 USDC". */
  readonly expected: string;
  /** The amount in the user's disfavour, when it differs from `expected`. */
  readonly atLeast: string | null;
  readonly certainty: JourneyCertainty;
  readonly certaintyInfo: CertaintyInfo;
  /** "$99.96"; null when unpriced (never "$0"). */
  readonly usd: string | null;
  /** "par", "Jupiter, 13:51:04 UTC", "unpriced". */
  readonly usdSource: string;
  readonly role: HoldingRole;
  readonly roleText: string;
  /** What the token is, when that is not obvious (receipts, liquid staking, bridged, custodial, unlisted). */
  readonly identity: string | null;
  /** A receipt's or share's conversion, e.g. "1 steakUSDC = 1.0474 USDC". */
  readonly basis: string | null;
}

export interface JourneyStopView {
  readonly id: string;
  readonly index: number;
  readonly kind: StopKind;
  readonly kindLabel: string;
  readonly network: NetworkKey;
  readonly networkName: string;
  readonly holderLabel: string;
  /** Full account (for a title or copying); null when the stop has none. */
  readonly account: string | null;
  readonly accountShort: string | null;
  readonly custody: CustodyState;
  readonly custodyLabel: string;
  readonly state: StopState;
  readonly stateLabel: string;
  /** The money is here now. */
  readonly here: boolean;
  readonly holdings: readonly JourneyHoldingView[];
  /** "about 20 s after your first signature", "about 12 s left". */
  readonly eta: string | null;
  readonly reachedAt: string | null;
  readonly evidenceUrl: string | null;
  /** "49.7794 USDC" when the stop holds two or more amounts of one token; null otherwise. */
  readonly total: string | null;
  /** The stop in words for screen readers: kind, network, holder, amounts (each with its role when there are several), total, custody. */
  readonly heading: string;
}

export interface JourneyLegView {
  readonly id: string;
  readonly number: number;
  readonly from: string;
  readonly to: string;
  readonly title: string;
  readonly venue: string;
  readonly networkName: string;
  readonly destinationName: string;
  readonly crossNetwork: boolean;
  /** "Relay · about 20 s · 1 signature". */
  readonly line: string;
  readonly status: string;
  readonly failure: string | null;
  readonly refund: string | null;
  readonly gasTopup: string | null;
  readonly tracking: { readonly url: string; readonly label: string } | null;
  /** The leg's other transactions (approvals), after `tracking` (its main transaction). */
  readonly moreTransactions: readonly { readonly url: string; readonly label: string }[];
}

export interface JourneyNoticeOptionView {
  readonly id: string;
  readonly label: string;
  readonly effect: string;
  readonly recommended: boolean;
  /** Only `link` options carry one (https only). */
  readonly url: string | null;
}

export interface JourneyNoticeView {
  readonly id: string;
  readonly severity: ConsequenceSeverity;
  readonly sign: SeveritySign;
  readonly title: string;
  readonly detail: string;
  /** "Facts: Base RPC read at 13:51:04 UTC". */
  readonly source: string | null;
  readonly certainty: JourneyCertainty;
  readonly options: readonly JourneyNoticeOptionView[];
  /** Asked through the question card (block, or act with a recommendation). */
  readonly asks: boolean;
  /** The label of the option the user chose; null while unanswered. */
  readonly answer: string | null;
  /** A block without a valid answer: the next signature waits for it. */
  readonly blocking: boolean;
}

export type JourneyRouteItem =
  | { readonly type: "stop"; readonly stop: JourneyStopView }
  | { readonly type: "leg"; readonly leg: JourneyLegView };

export interface JourneyOutcomeLine {
  readonly stopId: string;
  readonly networkName: string;
  readonly holderLabel: string;
  readonly custodyLabel: string;
  /** "99.95 USDC". */
  readonly amount: string;
  readonly usd: string | null;
  readonly certainty: JourneyCertainty;
  readonly certaintyInfo: CertaintyInfo;
  /** "99.95 USDC in your wallet on Base (0xde4b…0d5e)". */
  readonly sentence: string;
}

export interface JourneyOutcome {
  /** "Where your money is now" (journey over) or "Your money is here" (waiting or stopped part way). */
  readonly title: string;
  readonly lines: readonly JourneyOutcomeLine[];
}

export interface JourneyModel {
  readonly stage: Journey["stage"];
  readonly digest: string;
  readonly header: {
    /** "Itinerary" or "Where your money is now". */
    readonly title: string;
    /** "2 legs · Solana → Base · about 40 s of network time". */
    readonly line: string;
  };
  readonly stops: readonly JourneyStopView[];
  readonly legs: readonly JourneyLegView[];
  /** Stops and legs in reading order (each leg after the stop it leaves). */
  readonly route: readonly JourneyRouteItem[];
  readonly notices: { readonly expanded: readonly JourneyNoticeView[]; readonly folded: readonly JourneyNoticeView[] };
  /** Open blockers: the next signature waits for an answer to each. */
  readonly blockers: readonly JourneyNoticeView[];
  /** Consequence ids whose prompt is still unanswered, in asking order (blocks first). */
  readonly prompts: readonly string[];
  /** Where the money is now and what the journey waits for, in one sentence. */
  readonly nowLine: string;
  readonly outcome: JourneyOutcome | null;
}

export interface JourneyModelOptions {
  /** Answers by consequence id → option id (only options the consequence offers count). */
  readonly answered?: Readonly<Record<string, string>>;
}

function legSeconds(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? durationText(seconds) : null;
}

function holdingView(holding: JourneyHolding, legNumber: (legId: string) => number | null): JourneyHoldingView | null {
  const symbol = cleanText(holding.asset?.symbol, 16) || "tokens";
  const expected = amountText(holding.expected, symbol);
  if (!expected) return null;
  const atLeastText = amountText(holding.atLeast, symbol);
  const certainty = journeyCertaintyOf(holding.certainty);
  const value = holding.value;
  const unpriced = !value || value.source === "unpriced" || value.expectedUsd === null || value.expectedUsd === undefined;
  const source = unpriced ? "unpriced" : VALUE_SOURCE_LABEL[value.source] ?? cleanText(value.source, 24);
  const at = !unpriced && value.source !== "usd-par" ? clockText(value.at) : null;
  const identityKind = holding.identity?.kind;
  const showIdentity = identityKind !== undefined && !["native", "issuer", "listed", "wrapped"].includes(identityKind);
  return {
    symbol,
    expected,
    atLeast: atLeastText && holding.atLeast.amount !== holding.expected.amount ? atLeastText : null,
    certainty,
    certaintyInfo: JOURNEY_CERTAINTY_INFO[certainty],
    usd: unpriced ? null : formatUsdAbs(value.expectedUsd),
    usdSource: at ? `${source}, ${at}` : source,
    role: holding.role,
    roleText: roleText(holding, legNumber),
    identity: showIdentity ? cleanText(holding.identity.label, 120) || null : null,
    basis: value && typeof value.basis === "string" ? cleanText(value.basis, 120) || null : null,
  };
}

/** Exact sum of decimal amount strings ("24.8897" + "24.8897" = "49.7794"); null when one is not a plain amount. */
export function sumDecimalAmounts(amounts: readonly string[]): string | null {
  let scale = 0;
  for (const amount of amounts) {
    if (!/^\d{1,60}(?:\.\d{1,40})?$/u.test(amount)) return null;
    scale = Math.max(scale, amount.split(".")[1]?.length ?? 0);
  }
  let total = 0n;
  for (const amount of amounts) {
    const [whole, fraction = ""] = amount.split(".");
    total += BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  }
  const digits = total.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? digits.slice(digits.length - scale).replace(/0+$/u, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

/** "49.7794 USDC" when a stop holds two or more amounts of one token; null otherwise. */
function stopTotal(stop: JourneyStop): string | null {
  const holdings = (stop.holdings ?? []).filter((holding) => typeof holding.expected?.formatted === "string");
  if (holdings.length < 2) return null;
  const symbols = new Set(holdings.map((holding) => cleanText(holding.asset?.symbol, 16) || "tokens"));
  const assets = new Set(holdings.map((holding) => holding.asset?.asset));
  if (symbols.size !== 1 || assets.size !== 1) return null;
  const sum = sumDecimalAmounts(holdings.map((holding) => String(holding.expected.formatted).replace(/^\+/u, "")));
  return sum ? `${unsignedAmount(sum)} ${[...symbols][0]}` : null;
}

function stopView(stop: JourneyStop, here: boolean, legNumber: (legId: string) => number | null): JourneyStopView {
  const network = stop.network;
  const networkName = networkLabel(network);
  const holderLabel = cleanText(stop.holder?.label, 60) || (stop.holder?.own ? "Your wallet" : "Unknown holder");
  const account = typeof stop.holder?.account === "string" ? stop.holder.account : null;
  const holdings = (stop.holdings ?? []).map((holding) => holdingView(holding, legNumber)).filter((view): view is JourneyHoldingView => view !== null);
  const label = custodyLabel(stop.custody, stop);
  let eta: string | null = null;
  if (stop.eta) {
    if (typeof stop.eta.remainingSeconds === "number" && stop.state !== "passed") eta = `${durationText(stop.eta.remainingSeconds)} left`;
    else if (stop.state === "upcoming" && stop.eta.afterFirstSignatureSeconds > 0) eta = `${durationText(stop.eta.afterFirstSignatureSeconds)} after your first signature`;
  }
  const kindLabel = STOP_KIND_LABEL[stop.kind] ?? "Stop";
  // Several amounts at one stop are each named by their role, and one token's amounts get a total.
  const labelled = holdings.length > 1;
  const amounts = holdings
    .map((holding) => `${labelled && holding.roleText ? `${holding.roleText}: ` : ""}${holding.expected}, ${holding.certaintyInfo.spoken}${holding.atLeast ? `, at least ${holding.atLeast}` : ""}`)
    .join("; ");
  const total = stopTotal(stop);
  const heading = [`${kindLabel}: ${networkName}`, holderLabel, amounts, total ? `total ${total}` : "", label, here ? "you are here" : ""].filter(Boolean).join(", ");
  return {
    id: stop.id,
    index: stop.index,
    kind: stop.kind,
    kindLabel,
    network,
    networkName,
    holderLabel,
    account: account ? cleanText(account, 200) : null,
    accountShort: account ? shortAddress(account) : null,
    custody: stop.custody,
    custodyLabel: label,
    state: stop.state,
    stateLabel: STOP_STATE_LABEL[stop.state] ?? "",
    here,
    holdings,
    eta,
    reachedAt: clockText(stop.reachedAt),
    evidenceUrl: httpsUrl(stop.evidence?.url)?.href ?? null,
    total,
    heading,
  };
}

function legView(leg: JourneyLeg, number: number): JourneyLegView {
  const venue = cleanText(leg.venue?.name, 60) || cleanText(leg.venue?.protocol, 40) || "Venue";
  const signatures = typeof leg.signatures === "number" && leg.signatures > 0 ? `${leg.signatures} signature${leg.signatures === 1 ? "" : "s"}` : "";
  const seconds = legSeconds(leg.seconds);
  const topup = leg.gasTopup ? amountText(leg.gasTopup.amount, cleanText(leg.gasTopup.asset?.symbol, 16)) : null;
  const tracking = leg.tracking ? httpsUrl(leg.tracking.url) : null;
  return {
    id: leg.id,
    number,
    from: leg.from,
    to: leg.to,
    title: cleanText(leg.title, 120),
    venue,
    networkName: networkLabel(leg.network),
    destinationName: networkLabel(leg.destinationNetwork),
    crossNetwork: leg.network !== leg.destinationNetwork,
    line: [venue, seconds, signatures].filter(Boolean).join(" · "),
    status: typeof leg.status === "string" ? leg.status.replace(/_/gu, " ") : "",
    failure: leg.failure ? cleanText(leg.failure.message, 240) || null : null,
    refund: leg.refund ? cleanText(leg.refund.label, 240) || null : null,
    gasTopup: topup ? `Gas delivered with the fill: ${topup}${formatUsdAbs(leg.gasTopup?.usd) ? ` (${formatUsdAbs(leg.gasTopup?.usd)})` : ""}` : null,
    tracking: tracking ? { url: tracking.href, label: cleanText(leg.tracking?.label, 60) || "Track" } : null,
    moreTransactions: (leg.transactions ?? []).slice(1, 8).flatMap((link) => {
      const url = httpsUrl(link.url);
      return url ? [{ url: url.href, label: cleanText(link.label, 80) || "Transaction" }] : [];
    }),
  };
}

/** Whether `answer` is one of the options the consequence offers. */
function validAnswer(consequence: JourneyConsequence, answer: string | undefined): boolean {
  return answer !== undefined && consequence.options.some((option) => option.id === answer);
}

function noticeView(consequence: JourneyConsequence, answered: Readonly<Record<string, string>>): JourneyNoticeView {
  const severity = SEVERITY_ORDER.includes(consequence.severity) ? consequence.severity : "info";
  const answer = answered[consequence.id];
  const chosen = validAnswer(consequence, answer) ? consequence.options.find((option) => option.id === answer) ?? null : null;
  const source = cleanText(consequence.source, 160);
  return {
    id: consequence.id,
    severity,
    sign: SEVERITY_SIGNS[severity],
    title: cleanText(consequence.title, 160),
    detail: cleanText(consequence.detail, 400),
    source: source ? `Facts: ${source}` : null,
    certainty: journeyCertaintyOf(consequence.certainty),
    options: consequence.options.map((option) => {
      const url = option.action?.type === "link" ? httpsUrl(option.action.url)?.href ?? null : null;
      return { id: option.id, label: cleanText(option.label, 60), effect: cleanText(option.effect, 240), recommended: option.recommended === true, url };
    }),
    asks: Boolean(consequence.prompt) && (severity === "block" || severity === "act"),
    answer: chosen ? cleanText(chosen.label, 60) : null,
    blocking: severity === "block" && !chosen,
  };
}

function lowerFirst(text: string): string {
  return /^(Your|A|An|The|In|At)\b/u.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}

/** "your Base wallet", or the holder with its network when the label does not name it. */
function placeText(stop: Pick<JourneyStopView, "holderLabel" | "networkName">): string {
  const holder = lowerFirst(stop.holderLabel);
  return holder.includes(stop.networkName) ? holder : `${holder} on ${stop.networkName}`;
}

function outcomeOf(journey: Journey, stops: readonly JourneyStopView[]): JourneyOutcome | null {
  const failed = journey.legs.some((leg) => leg.status === "failed");
  const waiting = journey.now?.waitingFor === "decision";
  if (journey.stage !== "final" && !failed && !waiting) return null;
  const nowIds = new Set(journey.now?.stopIds ?? []);
  let chosen = stops.filter((stop) => nowIds.has(stop.id));
  if (chosen.length === 0) chosen = stops.filter((stop) => stop.state === "current");
  if (chosen.length === 0 && journey.stage === "final") chosen = stops.filter((stop) => stop.kind === "end" && stop.state !== "skipped");
  const lines: JourneyOutcomeLine[] = [];
  for (const stop of chosen) {
    for (const holding of stop.holdings) {
      const where = stop.custody === "wallet"
        ? `in ${placeText(stop)}${stop.accountShort ? ` ${stop.accountShort}` : ""}`
        : `${lowerFirst(stop.custodyLabel)} on ${stop.networkName}`;
      lines.push({
        stopId: stop.id,
        networkName: stop.networkName,
        holderLabel: stop.holderLabel,
        custodyLabel: stop.custodyLabel,
        amount: holding.expected,
        usd: holding.usd,
        certainty: holding.certainty,
        certaintyInfo: holding.certaintyInfo,
        sentence: `${holding.expected} ${where}${stop.reachedAt && holding.certainty === "observed" ? `, observed ${stop.reachedAt}` : ""}`,
      });
    }
  }
  const over = journey.stage === "final" && !(failed && journey.now?.waitingFor === "decision");
  return { title: over ? "Where your money is now" : "Your money is here", lines };
}

function nowLineOf(journey: Journey, stops: readonly JourneyStopView[], legs: readonly JourneyLegView[]): string {
  const now = journey.now;
  const here = stops.find((stop) => now?.stopIds?.includes(stop.id));
  const leg = legs.find((entry) => entry.id === now?.legId);
  switch (now?.waitingFor) {
    case "signature":
      return here
        ? `You are here: ${placeText(here)}.${leg ? ` Next: leg ${leg.number} needs your signature.` : ""}`
        : leg ? `Next: leg ${leg.number} needs your signature.` : "Waiting for your signature.";
    case "settlement": {
      const transit = stops.find((stop) => stop.kind === "transit" && stop.state === "current") ?? here;
      return `${leg ? `In transit with ${leg.venue}` : "In transit"}${transit?.eta ? ` · ${transit.eta}` : ""}.`;
    }
    case "decision":
      return "Kletia waits for your decision before anything else is signed.";
    default:
      return journey.legs.some((entry) => entry.status === "failed") ? "The journey stopped. Nothing more will be signed." : journey.stage === "final" ? "Journey complete." : "Nothing to sign right now.";
  }
}

/**
 * The journey as display data: the route in reading order, notices by
 * severity (folded past the first few), the open blockers, the prompts
 * still to ask, a "now" sentence and, once it is over or waits on a
 * decision, where the money is. Pure; every string is cleaned and only
 * https links survive.
 */
export function journeyModel(journey: Journey, options: JourneyModelOptions = {}): JourneyModel {
  const answered = options.answered ?? {};
  const legsSorted = [...(journey.legs ?? [])].sort((a, b) => a.index - b.index);
  const numberOf = new Map(legsSorted.map((leg, position) => [leg.id, position + 1]));
  const legNumber = (legId: string) => numberOf.get(legId) ?? null;
  const nowIds = new Set(journey.now?.stopIds ?? []);
  const stops = [...(journey.stops ?? [])].sort((a, b) => a.index - b.index).map((stop) => stopView(stop, nowIds.has(stop.id), legNumber));
  const legs = legsSorted.map((leg, position) => legView(leg, position + 1));
  const route: JourneyRouteItem[] = [];
  const placed = new Set<string>();
  for (const stop of stops) {
    route.push({ type: "stop", stop });
    for (const leg of legs) {
      if (leg.from === stop.id && !placed.has(leg.id)) {
        route.push({ type: "leg", leg });
        placed.add(leg.id);
      }
    }
  }
  for (const leg of legs) if (!placed.has(leg.id)) route.push({ type: "leg", leg });

  const consequences = [...(journey.consequences ?? [])]
    .map((consequence, position) => ({ consequence, position }))
    .sort((a, b) => severityRank(a.consequence.severity) - severityRank(b.consequence.severity) || a.position - b.position)
    .map(({ consequence }) => consequence);
  const views = consequences.map((consequence) => noticeView(consequence, answered));
  const expanded: JourneyNoticeView[] = [];
  const folded: JourneyNoticeView[] = [];
  views.forEach((view, position) => {
    const consequence = consequences[position] as JourneyConsequence;
    // A block is never folded: it gates the next signature.
    if (view.severity === "block" || !consequence.collapsed) expanded.push(view);
    else folded.push(view);
  });
  const open = new Set(openBlockers(journey, answered).map((consequence) => consequence.id));
  const blockers = views.filter((view) => view.severity === "block" && open.has(view.id));
  const prompts = views.filter((view) => view.asks && view.answer === null && answered[view.id] === undefined).map((view) => view.id);

  const networks: string[] = [];
  for (const stop of stops) if (networks[networks.length - 1] !== stop.networkName) networks.push(stop.networkName);
  const seconds = legsSorted.reduce((sum, leg) => sum + (typeof leg.seconds === "number" && leg.seconds > 0 ? leg.seconds : 0), 0);
  const line = [
    `${legs.length} leg${legs.length === 1 ? "" : "s"}`,
    networks.join(" → "),
    seconds > 0 ? `${durationText(seconds)} of network time` : "",
  ].filter(Boolean).join(" · ");
  const outcome = outcomeOf(journey, stops);
  return {
    stage: journey.stage,
    digest: typeof journey.digest === "string" ? journey.digest : "",
    header: { title: journey.stage === "final" ? "Where your money is now" : "Itinerary", line },
    stops,
    legs,
    route,
    notices: { expanded, folded },
    blockers,
    prompts,
    nowLine: nowLineOf(journey, stops, legs),
    outcome,
  };
}

/** A stable key of a consequence's facts: an answer is asked again only when its facts changed. */
export function consequenceFactsKey(consequence: Pick<JourneyConsequence, "facts" | "severity">): string {
  const facts = consequence.facts ?? {};
  return `${consequence.severity}|${Object.keys(facts).sort().map((key) => `${key}=${facts[key]}`).join("&")}`;
}

/** One remembered answer to a journey prompt, with the facts it answered. */
export interface JourneyAnswerMemory {
  readonly option: string;
  readonly facts: string;
}

/**
 * The answers still valid for this journey: the option must still be
 * offered and the consequence's facts must be the ones the user answered
 * (when they changed, the prompt is asked again).
 */
export function validJourneyAnswers(journey: Journey | null | undefined, memory: Readonly<Record<string, JourneyAnswerMemory>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const consequence of journey?.consequences ?? []) {
    const remembered = memory[consequence.id];
    if (!remembered || remembered.facts !== consequenceFactsKey(consequence)) continue;
    const offered = consequence.options.some((option) => option.id === remembered.option) || (remembered.option === JOURNEY_HANDLE_IT_OPTION && !consequence.options.some((option) => option.action?.type === "acknowledge"));
    if (offered) out[consequence.id] = remembered.option;
  }
  return out;
}
