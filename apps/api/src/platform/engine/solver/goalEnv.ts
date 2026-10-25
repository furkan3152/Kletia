/**
 * Solver context and results, the per-goal environment (GoalEnv), solver
 * steps and the helpers every goal shape uses: prices, lanes, holdings,
 * sizes.
 */
import {
  ASSET_CLASSES,
  EXPOSURE_ASSET_CLASSES,
  THREAD_LIMITS,
  type AssetSel,
  type Goal,
  type GoalTargets,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { isUsdWord, laneOf, USD_ORDER } from "../clarify/catalog.js";
import { planTooLarge } from "../routing/caps.js";
import { clip } from "../clarify/copy.js";
import { parseDecimal, formatDecimal } from "../clarify/decimal.js";
import type { Assumption, Question, Slot, WorkStep } from "../clarify/types.js";
import type { GoalNotes } from "../goal/frames.js";
import { overCaps, planSize, planTooLargeQuestion } from "./abstract.js";
import type { GoalPins, GoalReadNotes } from "./decide.js";
import { networkLabel } from "./explain.js";
import {
  nodeMatchesAsset,
  type CapabilityGraph,
  type GraphNode,
} from "./graph.js";
import type { Landing, Route } from "./search.js";
import {
  usablePrice,
  type Snapshot,
  type SnapshotHolding,
} from "./snapshot.js";

/* ------------------------------------------------------------------ types */

export interface SolveContext {
  /** The request's accounts (a step needs one of its network's family). */
  readonly accounts: readonly string[];
  /** The action index of the first step these goals expand into (default 0). */
  readonly index?: number;
  /** Per goal: what the reader noted (order-only roles, possessive scope, typos). */
  readonly reads?: readonly (GoalReadNotes | undefined)[];
  /** Per goal: answers and chip changes from earlier turns. */
  readonly pins?: readonly (GoalPins | undefined)[];
  /** The capability graph (default: the active adapters' memoised graph). */
  readonly graph?: CapabilityGraph;
  /** Live gas prices (wei) per EVM network, when the caller read them (ranking only). */
  readonly gasPriceWei?: Readonly<Partial<Record<NetworkKey, bigint>>>;
}

export type GoalStatus = "ready" | "ask" | "pending";

export interface GoalOutcome {
  /** The goal's index in the list. */
  readonly goal: number;
  readonly status: GoalStatus;
  /** The expanded steps (ready; also kept for a confirm question, D12/D13). */
  readonly steps: readonly WorkStep[];
  /** The chosen route (one, or one per source for consolidate / all-networks scope). */
  readonly routes: readonly Route[];
  /** Where the money lands after each step. */
  readonly landings: readonly Landing[];
  readonly questions: readonly Question[];
  readonly assumptions: readonly Assumption[];
}

export interface SolveResult {
  /** Steps of the goals that are ready, in order, up to the first goal that asks. */
  readonly steps: readonly WorkStep[];
  /** Chips of those goals, material first. */
  readonly assumptions: readonly Assumption[];
  /** At most two questions, of the first goal that asks. */
  readonly questions: readonly Question[];
  readonly outcomes: readonly GoalOutcome[];
}

/** The decision-table notes of a goal the frames read (orderOnly D12, possessive D4, typo D9). */
export function readNotesOf(read: { readonly notes: Pick<GoalNotes, "orderOnly" | "possessive" | "typo"> }): GoalReadNotes {
  return {
    ...(read.notes.orderOnly ? { orderOnly: true } : {}),
    ...(read.notes.possessive ? { possessive: true } : {}),
    ...(read.notes.typo ? { typo: read.notes.typo } : {}),
  };
}

/* ---------------------------------------------------------------- helpers */

export const MAX_QUESTIONS = 2;
export const upper = (value: string) => value.trim().toUpperCase();
export const symbolOf = (asset: AssetSel | undefined): string | undefined => (asset && "symbol" in asset ? asset.symbol : undefined);
export const isStableSymbol = (symbol: string) => USD_ORDER.includes(upper(symbol)) || isUsdWord(symbol);
export const user = <T>(v: T): Slot<T> => ({ v, by: "user" });

export interface GoalEnv {
  readonly goal: Goal;
  readonly position: number;
  /** Action index of this goal's first step. */
  readonly index: number;
  readonly notes?: GoalReadNotes;
  readonly pins?: GoalPins;
  readonly snapshot: Snapshot;
  readonly graph: CapabilityGraph;
  readonly ctx: SolveContext;
  /** The landing of the goal this one spends from (chain / "it"). */
  readonly previous?: { readonly route: Route; readonly outcome: GoalOutcome };
}

export type Step =
  | { readonly kind: "ask"; readonly questions: readonly Question[]; readonly steps?: readonly WorkStep[]; readonly routes?: readonly Route[] }
  | { readonly kind: "ready"; readonly steps: readonly WorkStep[]; readonly routes: readonly Route[]; readonly assumptions: readonly Assumption[] };

export const ask = (...questions: (Question | null)[]): Step => ({ kind: "ask", questions: questions.filter((entry): entry is Question => entry !== null) });

export function priceOf(snapshot: Snapshot, node: GraphNode): number | null {
  const price = usablePrice(snapshot, node.asset);
  if (price) return price.usd;
  return isStableSymbol(node.symbol) && node.category === "stablecoin" ? 1 : null;
}

export function accountLane(accounts: readonly string[]): "mainnet" | "testnet" {
  return laneOf(accounts);
}

/** Fail closed: an abstract goal Kletia cannot compute exactly is refused with what to say instead, never guessed. */
export function refuse(message: string, note = "Not planned."): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", clip(message, 200), 422, [{ path: "text", message: note }]);
}

/** The snapshot holding of a wallet node. */
export function holdingOf(snapshot: Snapshot, node: GraphNode): SnapshotHolding | undefined {
  return snapshot.holdings.find((holding) => holding.network === node.network && holding.asset === node.asset);
}

/** The wallet node of `selection` on `network` (listed, not transfer-only), the first in build order. */
export function walletNodeFor(graph: CapabilityGraph, network: NetworkKey, selection: AssetSel): GraphNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.network === network && node.custody.kind === "wallet" && !node.transferOnly && nodeMatchesAsset(node, selection)) return node;
  }
  return undefined;
}

/** USD as an 18-digit fixed-point bigint (the rebalance arithmetic's unit for the asset axis). */
export const usdUnits = (usd: number): bigint => (Number.isFinite(usd) && usd > 0 ? parseDecimal(usd.toFixed(6)) : 0n);
/** Token units worth `usd` at `price`, as an 18-digit fixed-point bigint. */
export const unitsForUsd = (usd: number, price: number): bigint => (price > 0 ? parseDecimal((usd / price).toFixed(12)) : 0n);
export const unitsToNumber = (value: bigint): number => Number(formatDecimal(value, 12));

/** What the rebalance chips say about the targets ("Base 50%, Arbitrum One 50%"). */
export function targetsLabel(targets: GoalTargets, name: (key: string) => string): string {
  return targets.weights.map((weight) => `${name(weight.key)} ${Math.round(weight.bps / 100)}%`).join(", ");
}

/** A target key read as an asset: a class name (ASSET_CLASSES and the exposure classes) or a listed symbol. */
export function keySelection(key: string): AssetSel {
  const classes: readonly string[] = [...ASSET_CLASSES, ...EXPOSURE_ASSET_CLASSES];
  return classes.includes(key) ? ({ class: key } as AssetSel) : { symbol: key };
}

/** The moves one plan may hold: within the step limit left in the thread and the plan-size caps. */
export function sizeCheck(env: GoalEnv, moves: readonly { readonly network: NetworkKey; readonly label: string; readonly steps: readonly WorkStep[] }[]): Question | null {
  const steps = moves.flatMap((move) => move.steps);
  const room = Math.max(0, THREAD_LIMITS.maxSteps - env.index);
  if (!overCaps(planSize(steps.map((step) => step.kind?.v)), room)) return null;
  const listed = moves.map((move) => ({ network: move.network, label: move.label, steps: move.steps.length, auctions: planSize(move.steps.map((step) => step.kind?.v)).auctions }));
  const asked = planTooLargeQuestion({ index: env.index, moves: listed, room, networkLabel });
  if (asked && !env.goal.spend.from?.network && !env.pins?.source) return asked;
  throw planTooLarge({ signatures: steps.length, auctions: planSize(steps.map((step) => step.kind?.v)).auctions, moves: listed.map((move) => move.label) });
}
