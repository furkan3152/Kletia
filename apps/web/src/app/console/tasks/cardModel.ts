/**
 * The printed plan card's model (Card machine): pure, so node --test loads it. Everything here
 * reads the real plan (the intent graph, its fare and the executor's step phases); nothing is made
 * up and nothing runs ahead of the chain.
 *
 * - `routeStops`: the networks and venues the plan touches, in order (cartridges and stations),
 *   only those: a Base swap is "Base, Uniswap"; a bridge and swap "Base, Across, Arbitrum, Uniswap".
 * - `routeGeometry`: where each stop sits on the card's 360 x 150 art window, and each step's
 *   segment (the rail its coin rides).
 * - `cardFacts`: the three facts on the front (you pay, you get at least, total fees from
 *   `totalFeesUsd`, the same total the review and the fare print).
 * - `legProgress`: how far each step's coin has travelled: 0 until a wallet signed and the step
 *   is in flight, part way while the chain works, 1 only when the API says the step settled.
 * - `cardPhase`: which face of the machine the card shows (dry, review, signing, settled, jam).
 */
import { totalFeesUsd, type AssetAmount } from "@kletia/core";

import { displayDecimal, formatUsd, protocolName } from "../../site/intent/format.ts";
import { networkIcon, type IconName } from "../../kit/iconPaths.ts";

/* ---------- shapes the model reads (subsets of IntentGraph / IntentPreview) ---------- */
export interface CardStepLike {
  readonly id: string;
  readonly index: number;
  readonly kind: string;
  readonly title: string;
  readonly network: string;
  readonly protocol: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  readonly input?: AssetAmount;
  readonly expectedOutput?: AssetAmount;
  readonly minimumOutput?: AssetAmount;
  readonly estimatedSeconds?: number;
  readonly references?: readonly unknown[];
  readonly settlement?: { readonly kind: string; readonly destinationNetwork?: string } | null;
}

export interface CardIntentLike {
  readonly id: string;
  readonly status: string;
  readonly expiresAt?: string;
  readonly steps: readonly CardStepLike[];
  readonly summary: {
    readonly title: string;
    readonly inputs: readonly AssetAmount[];
    readonly outputs: readonly AssetAmount[];
    readonly totalFeesUsd?: number;
    readonly estimatedSeconds?: number;
    readonly signaturesRequired: number;
  };
  readonly interpretation?: {
    readonly routes?: readonly { readonly steps: readonly string[]; readonly venues: readonly string[]; readonly reason: string; readonly compared: readonly unknown[] }[];
  };
}

export interface CardPreviewLike {
  readonly intentId: string;
  readonly totals: { readonly networkFeesUsd: number | null; readonly venueFeesUsd: number | null; readonly extraCostsUsd: number | null };
}

const NETWORK_NAMES: Readonly<Record<string, string>> = {
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "OP",
  polygon: "Polygon",
  solana: "Solana",
  arc: "Arc",
  "arbitrum-sepolia": "Arb Sepolia",
  "solana-devnet": "Sol Devnet",
};

/** A short station name: "Uniswap V3" prints as "Uniswap", "Circle CCTP V2" as "CCTP". */
export function shortVenue(protocol: string): string {
  const name = protocolName(protocol);
  if (/cctp/iu.test(name)) return "CCTP";
  const first = name.split(/\s+/u)[0] ?? name;
  return first.length > 10 ? `${first.slice(0, 9)}…` : first;
}

/** The icon drawn for a venue (own drawings, never logos); the step kind when there is none. */
export function venueIcon(protocol: string, kind: string): IconName {
  const id = protocol.toLowerCase();
  if (id.includes("across")) return "across";
  if (id.includes("uniswap")) return "uni";
  if (id.includes("relay")) return "relay";
  if (id.includes("cctp") || id.includes("circle")) return "cctp";
  if (id.includes("aave")) return "aave";
  if (id.includes("gmx")) return "gmx";
  if (id.includes("jupiter")) return "jup";
  if (id.includes("aerodrome")) return "aero";
  if (id.includes("lido")) return "lido";
  if (id.includes("polymarket")) return "poly";
  if (id.includes("hyperliquid")) return "hl";
  if (kind === "bridge") return "bridge";
  if (kind === "swap") return "swap";
  if (kind === "transfer" || kind === "send") return "send";
  if (kind === "deposit" || kind === "stake") return "earn";
  return "block";
}

export function sortedSteps<T extends { readonly index: number }>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => a.index - b.index);
}

/* ---------- route ---------- */
export interface RouteStop {
  readonly kind: "network" | "venue";
  /** Network key or protocol id. */
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
}

export interface RouteLeg {
  readonly stepId: string;
  /** Stop indexes the step's coin rides through, in order (at least two). */
  readonly stops: readonly number[];
}

export interface RoutePlan {
  readonly stops: readonly RouteStop[];
  readonly legs: readonly RouteLeg[];
}

/**
 * The stops a plan touches, in order, and each step's leg over them. A network appears again only
 * when the money comes back to it after another network (it never repeats back to back).
 */
export function routeStops(intent: Pick<CardIntentLike, "steps">): RoutePlan {
  const stops: RouteStop[] = [];
  /** The network each stop stands on (a venue stands on its step's network). */
  const on: string[] = [];
  const legs: RouteLeg[] = [];
  const push = (stop: RouteStop, network: string): number => {
    stops.push(stop);
    on.push(network);
    return stops.length - 1;
  };
  const network = (key: string): RouteStop => ({ kind: "network", key, label: NETWORK_NAMES[key] ?? key, icon: networkIcon(key) });
  for (const step of sortedSteps(intent.steps)) {
    // The money starts where the last stop left it when that stop is on this network.
    const last = stops.length - 1;
    const from = last >= 0 && on[last] === step.network ? last : push(network(step.network), step.network);
    const venue = push({ kind: "venue", key: step.protocol, label: shortVenue(step.protocol), icon: venueIcon(step.protocol, step.kind) }, step.network);
    const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
    if (destination && destination !== step.network) {
      const arrival = push(network(destination), destination);
      legs.push({ stepId: step.id, stops: [from, venue, arrival] });
    } else {
      legs.push({ stepId: step.id, stops: [from, venue] });
    }
  }
  return { stops, legs };
}

export interface PlacedStop extends RouteStop {
  /** Centre on the 360 x 150 art window. */
  readonly x: number;
  readonly y: number;
  /** Half width of the drawn node (cartridge or station), where rails start and end. */
  readonly half: number;
}

export interface RouteGeometry {
  readonly stops: readonly PlacedStop[];
  /** One rail per pair of neighbouring stops ("M x y H x"). */
  readonly rails: readonly string[];
  /** Per step: the path its coin rides (centre to centre) and its length. */
  readonly legs: readonly { readonly stepId: string; readonly d: string; readonly from: number; readonly to: number }[];
  /** Cartridge size (smaller when many stops share the window). */
  readonly cart: { readonly w: number; readonly h: number };
  readonly stationR: number;
}

export const ART = Object.freeze({ width: 360, height: 150, y: 72 });

/** Where every stop sits: spread evenly between the window's margins, rails edge to edge. */
export function routeGeometry(plan: RoutePlan): RouteGeometry {
  const count = plan.stops.length;
  const crowded = count > 4;
  const cart = crowded ? { w: 50, h: 44 } : { w: 64, h: 52 };
  const stationR = crowded ? 11 : 13;
  const margin = cart.w / 2 + 12;
  const span = ART.width - margin * 2;
  const stops = plan.stops.map((stop, index) => ({
    ...stop,
    x: count === 1 ? ART.width / 2 : Math.round(margin + (span * index) / (count - 1)),
    y: ART.y,
    half: stop.kind === "network" ? cart.w / 2 : stationR,
  }));
  const rails: string[] = [];
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const a = stops[index]!;
    const b = stops[index + 1]!;
    rails.push(`M${a.x + a.half} ${ART.y} H${b.x - b.half}`);
  }
  const legs = plan.legs.map((leg) => {
    const first = stops[leg.stops[0]!]!;
    const last = stops[leg.stops[leg.stops.length - 1]!]!;
    return { stepId: leg.stepId, d: `M${first.x} ${ART.y} H${last.x}`, from: first.x, to: last.x };
  });
  return { stops, rails, legs, cart, stationR };
}

/** The route as words for the art window's label ("Route: Base, Across bridge, Arbitrum, Uniswap"). */
export function routeLabel(plan: RoutePlan): string {
  return `Route: ${plan.stops.map((stop) => (stop.kind === "venue" ? protocolName(stop.key) : stop.label)).join(", ")}`;
}

/* ---------- facts ---------- */
function amountText(amount: AssetAmount | undefined, direction: "down" | "up" = "down"): string | null {
  if (!amount) return null;
  return `${displayDecimal(amount.formatted, direction)} ${amount.symbol}`;
}

/** The steps no other step builds on: what you end up holding comes out of them. */
export function leafSteps<T extends CardStepLike>(steps: readonly T[]): T[] {
  return sortedSteps(steps).filter((step) => !steps.some((other) => other.dependsOn.includes(step.id)));
}

export interface CardFacts {
  /** "25 USDC on Base becomes" */
  readonly from: string | null;
  /** What you end up with ("12.4945 USDC + 0.005355 ETH"). */
  readonly title: string;
  readonly pay: string;
  readonly atLeast: string;
  readonly fees: string;
}

/**
 * The front of the card. "You get at least" are the guaranteed minimums of the last steps (the
 * review's "Minimum received", the same rule); fees are `totalFeesUsd` (fare totals when the fare
 * belongs to this plan, the plan's estimate otherwise).
 */
export function cardFacts(intent: CardIntentLike, preview: CardPreviewLike | null, networkOf: (key: string) => string = (key) => NETWORK_NAMES[key] ?? key): CardFacts {
  const steps = sortedSteps(intent.steps);
  const inputs = intent.summary.inputs.map((input) => amountText(input, "up")).filter((value): value is string => Boolean(value));
  const outputs = intent.summary.outputs.map((output) => amountText(output)).filter((value): value is string => Boolean(value));
  const minimums = leafSteps(steps)
    .map((step) => amountText(step.minimumOutput))
    .filter((value): value is string => Boolean(value));
  const fare = preview && preview.intentId === intent.id ? preview : null;
  const fees = formatUsd(totalFeesUsd({ summary: intent.summary, preview: fare }));
  const first = steps[0];
  const from = inputs.length > 0 && first ? `${inputs.join(" + ")} on ${networkOf(first.network)} becomes` : null;
  return {
    from,
    title: outputs.join(" + ") || intent.summary.title,
    pay: inputs.join(" + ") || "not quoted",
    atLeast: minimums.join(" + ") || "not quoted",
    fees: fees ?? "not quoted",
  };
}

/** The band label: what the plan does ("Bridge + swap", "Swap", "Deposit"). */
export function cardType(intent: Pick<CardIntentLike, "steps">): string {
  const words: string[] = [];
  for (const step of sortedSteps(intent.steps)) {
    const word = step.kind === "transfer" ? "send" : step.kind;
    if (!words.includes(word)) words.push(word);
  }
  const text = words.slice(0, 3).join(" + ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Plan";
}

/** Kletia's sentence about the route: the planner's own reason for the first leg that compared routes. */
export function routeReason(intent: CardIntentLike): string | null {
  const routes = intent.interpretation?.routes ?? [];
  const reason = routes.find((route) => route.reason)?.reason ?? null;
  return reason ? reason.slice(0, 220) : null;
}

/** How many routes the planner weighed (each leg's winner plus what it compared); null when unknown. */
export function routesCompared(intent: CardIntentLike): number | null {
  const routes = intent.interpretation?.routes;
  if (!routes || routes.length === 0) return null;
  return routes.reduce((sum, route) => sum + 1 + route.compared.length, 0);
}

/* ---------- progress ---------- */
const IN_FLIGHT = new Set(["submitted", "settling"]);
const FAILED = new Set(["failed", "indeterminate"]);

export type LegState = "queued" | "wallet" | "moving" | "done" | "failed";

export interface LegProgress {
  readonly stepId: string;
  readonly state: LegState;
  /** 0..1 of the leg's rail the coin has travelled (never 1 before the API says settled). */
  readonly travelled: number;
}

/**
 * Each step's coin, from the API status and the executor's local phase: queued, waiting on the
 * wallet ("wallet"), in flight after a signature ("moving", half way: the chain has it, the
 * destination does not yet), done (settled or confirmed) or failed.
 */
export function legProgress(steps: readonly CardStepLike[], phases: Readonly<Record<string, string>> = {}): readonly LegProgress[] {
  return sortedSteps(steps).map((step) => {
    const phase = phases[step.id];
    const crossing = step.settlement?.kind === "cross-network";
    if (FAILED.has(step.status)) return { stepId: step.id, state: "failed", travelled: 0 };
    // A crossing is done when it settled on the other side; "confirmed" there means the source chain only.
    const done = step.status === "settled" || step.status === "skipped" || (step.status === "confirmed" && !crossing);
    if (done && phase !== "confirming") return { stepId: step.id, state: "done", travelled: 1 };
    if (phase === "confirming" || IN_FLIGHT.has(step.status) || step.status === "confirmed") {
      return { stepId: step.id, state: "moving", travelled: step.status === "settling" || step.status === "confirmed" ? 0.7 : 0.45 };
    }
    if (phase === "signing" || phase === "preparing" || step.status === "awaiting_signature") return { stepId: step.id, state: "wallet", travelled: 0 };
    return { stepId: step.id, state: "queued", travelled: 0 };
  });
}

/** 0..1 for the signing bar: settled steps count whole, a step in flight counts half. */
export function signedShare(progress: readonly LegProgress[]): number {
  if (progress.length === 0) return 0;
  const sum = progress.reduce((total, leg) => total + (leg.state === "done" ? 1 : leg.state === "moving" ? 0.5 : 0), 0);
  return Math.min(1, sum / progress.length);
}

export type CardPhase = "dry" | "review" | "signing" | "settled" | "stopped";

/** The card's phase from the execution's status (dry: no stored plan yet). Settled only when the API completed the intent. */
export function cardPhase(execution: { readonly status: string; readonly intentStatus: string | null } | null): CardPhase {
  if (!execution || !execution.intentStatus) return "dry";
  if (execution.intentStatus === "completed" && execution.status === "completed") return "settled";
  switch (execution.status) {
    case "review":
    case "planning":
    case "idle":
      return "review";
    case "executing":
    case "paused":
      return "signing";
    default:
      return "stopped";
  }
}

/** True when the card's quotes ran out (`expiresAt` passed) before anything was signed. */
export function quoteExpired(intent: Pick<CardIntentLike, "expiresAt">, now: number): boolean {
  const at = intent.expiresAt ? Date.parse(intent.expiresAt) : Number.NaN;
  return Number.isFinite(at) && at <= now;
}

/** "Planned in 2.6 s · 14 routes compared": the folded thinking line. */
export function plannedLine(ms: number, compared: number | null, verb = "Planned"): string {
  const seconds = ms < 10_000 ? (Math.max(ms, 100) / 1000).toFixed(1) : String(Math.round(ms / 1000));
  return compared && compared > 1 ? `${verb} in ${seconds} s · ${compared} routes compared` : `${verb} in ${seconds} s`;
}
