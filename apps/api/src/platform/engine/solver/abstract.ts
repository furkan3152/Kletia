/**
 * Arithmetic of the abstract goals (intent design A.6) and the plan-size
 * count (C.7): what a rebalance moves, where a conversion lands when the
 * person named no network, and when a goal expands into more moves than one
 * plan may hold. The solver (`index.ts`) turns the results into routes,
 * steps, chips and questions.
 *
 * Pure: every function reads only its arguments; amounts are 18-digit
 * fixed-point bigints (`clarify/decimal.ts`), never floats.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";
import { question } from "../clarify/copy.js";
import { field } from "../clarify/edits.js";
import type { Option, Question } from "../clarify/types.js";
import { MAX_PLAN_AUCTIONS, MAX_PLAN_SIGNATURES } from "../routing/caps.js";

/* ------------------------------------------------------------ rebalance */

/** What one target key (a network, a symbol or a class) holds now, in one unit for every key. */
export interface RebalanceBucket {
  readonly key: string;
  readonly value: bigint;
}

/** One move of a rebalance: `value` from the key with too much to the key with too little. */
export interface RebalanceTransfer {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
}

export interface RebalanceTarget {
  readonly key: string;
  readonly target: bigint;
  readonly current: bigint;
}

export interface RebalancePlan {
  readonly total: bigint;
  readonly targets: readonly RebalanceTarget[];
  /** Empty when every key is already within the tolerance of its target. */
  readonly transfers: readonly RebalanceTransfer[];
}

/**
 * The fewest moves that bring every key within `tolerance` of its share of
 * the total (design A.6: within max($1, 1 %)). Keys with too much pay the
 * keys with too little, the largest differences first (greedy matching, a
 * minimal number of moves for two keys and close to it otherwise); a move
 * below `minimum` is skipped (GOAL_LIMITS.materialUsd). Buckets whose key
 * has no weight have a target of zero ("go 100 % stablecoins": everything
 * else is sold). Deterministic: ties go by key order.
 */
export function rebalancePlan(buckets: readonly RebalanceBucket[], weights: readonly { readonly key: string; readonly bps: number }[], tolerance: bigint, minimum: bigint): RebalancePlan {
  const current = new Map<string, bigint>();
  for (const bucket of buckets) current.set(bucket.key, (current.get(bucket.key) ?? 0n) + (bucket.value > 0n ? bucket.value : 0n));
  for (const weight of weights) if (!current.has(weight.key)) current.set(weight.key, 0n);
  const total = [...current.values()].reduce((sum, value) => sum + value, 0n);
  const bpsOf = new Map(weights.map((weight) => [weight.key, BigInt(Math.max(0, Math.round(weight.bps)))]));
  const keys = [...current.keys()].sort();
  const targets: RebalanceTarget[] = keys.map((key) => ({ key, current: current.get(key) as bigint, target: (total * (bpsOf.get(key) ?? 0n)) / 10_000n }));
  const surplus = targets.map((entry) => ({ key: entry.key, left: entry.current - entry.target })).filter((entry) => entry.left > tolerance);
  const deficit = targets.map((entry) => ({ key: entry.key, left: entry.target - entry.current })).filter((entry) => entry.left > tolerance);
  const order = (a: { key: string; left: bigint }, b: { key: string; left: bigint }) => (a.left === b.left ? (a.key < b.key ? -1 : 1) : a.left > b.left ? -1 : 1);
  surplus.sort(order);
  deficit.sort(order);
  const transfers: RebalanceTransfer[] = [];
  let i = 0;
  let j = 0;
  while (i < surplus.length && j < deficit.length) {
    const give = surplus[i] as { key: string; left: bigint };
    const take = deficit[j] as { key: string; left: bigint };
    const value = give.left < take.left ? give.left : take.left;
    if (value >= minimum && value > 0n) transfers.push({ from: give.key, to: take.key, value });
    give.left -= value;
    take.left -= value;
    if (give.left <= 0n) i += 1;
    if (take.left <= 0n) j += 1;
  }
  return { total, targets, transfers };
}

/** "50 / 50", "60 / 40", "100 %": the split as the chip shows it. */
export function splitLabel(weights: readonly { readonly bps: number }[]): string {
  if (weights.length === 1) return "100%";
  return weights.map((weight) => `${Math.round(weight.bps / 100)}`).join("/");
}

/* ---------------------------------------------------------- home network */

/**
 * Where a conversion lands when the person named no network for what they
 * want (RF3, design A.6 "convert on the home network"): the network the
 * money is on when it lists the wanted asset there; otherwise the networks
 * of the lane that list it (one: that one, Solana for SOL; several: asked).
 */
export function homeNetworks(input: { readonly from: NetworkKey | undefined; readonly listed: readonly NetworkKey[] }): NetworkKey[] {
  if (input.from && input.listed.includes(input.from)) return [input.from];
  const lane = input.from ? CHAINS[input.from].lane : undefined;
  return input.listed.filter((network) => lane === undefined || CHAINS[network].lane === lane);
}

/* ------------------------------------------------------------ plan size */

export interface PlanSize {
  /** Wallet signatures (one per step; the planner adds approvals and counts exactly). */
  readonly signatures: number;
  /** Venue auctions (swaps and bridges). */
  readonly auctions: number;
}

/** The size of a list of steps as the decision layer counts it before planning (C.7). */
export function planSize(kinds: readonly (string | undefined)[]): PlanSize {
  return { signatures: kinds.length, auctions: kinds.filter((kind) => kind === "swap" || kind === "bridge").length };
}

/** True when a plan of this size passes either cap (8 wallet signatures, 12 auctions). */
export function overCaps(size: PlanSize, maxSteps: number = MAX_PLAN_SIGNATURES): boolean {
  return size.signatures > Math.min(maxSteps, MAX_PLAN_SIGNATURES) || size.auctions > MAX_PLAN_AUCTIONS;
}

/**
 * PLAN_TOO_LARGE (C.7, seam S7 on the decision side): a goal that expands
 * into more moves than one plan holds is asked, listing the moves, never cut
 * silently. Each option keeps the moves from one network (when that subset
 * fits); "No, rewrite it" cancels. Null when no network's moves fit alone
 * (the caller refuses).
 */
export function planTooLargeQuestion(input: {
  readonly index: number;
  readonly moves: readonly { readonly network: NetworkKey; readonly label: string; readonly steps: number; readonly auctions: number }[];
  readonly room: number;
  readonly networkLabel: (network: NetworkKey) => string;
}): Question | null {
  const perNetwork = new Map<NetworkKey, { steps: number; auctions: number; count: number }>();
  for (const move of input.moves) {
    const entry = perNetwork.get(move.network) ?? { steps: 0, auctions: 0, count: 0 };
    perNetwork.set(move.network, { steps: entry.steps + move.steps, auctions: entry.auctions + move.auctions, count: entry.count + 1 });
  }
  const options: Option[] = [...perNetwork.entries()]
    .filter(([, entry]) => !overCaps({ signatures: entry.steps, auctions: entry.auctions }, input.room))
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .map(([network, entry]) => ({
      id: network,
      label: `Only the ${entry.count} from ${input.networkLabel(network)}`.slice(0, 48),
      detail: `${entry.steps} wallet signature${entry.steps === 1 ? "" : "s"}`,
      value: { source: network },
    }));
  if (options.length === 0) return null;
  options.push({ id: "cancel", label: "No, rewrite it", value: { target: "cancel" } });
  const steps = input.moves.reduce((sum, move) => sum + move.steps, 0);
  const listed = input.moves.slice(0, 6).map((move) => move.label).join("; ");
  return question(field(input.index, "network"), "choice", "PLAN_TOO_LARGE",
    `This needs ${input.moves.length} moves (${steps} wallet signatures); one plan holds at most ${Math.min(input.room, MAX_PLAN_SIGNATURES)}. Which should Kletia plan now?`,
    `Moves: ${listed}${input.moves.length > 6 ? "; ..." : ""}.`, options, false);
}
