/**
 * Rebalance goals across networks and assets.
 */
import {
  CHAINS,
  GOAL_LIMITS,
  isNetworkKey,
  NATIVE_FEE_RESERVE,
  type AssetClass,
  type AssetSel,
  type ExposureAssetClass,
  type GoalTargets,
  type NetworkKey,
} from "@kletia/core";
import {
  BRIDGE_NETWORKS,
  hasAccount,
  lane,
  NETWORK_ORDER,
  SWAP_NETWORKS,
  USD_ORDER,
} from "../clarify/catalog.js";
import { assumption, clip, question } from "../clarify/copy.js";
import {
  isDecimal,
  isPositive,
  parseDecimal,
  formatDecimal,
} from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type { WorkStep } from "../clarify/types.js";
import { rebalancePlan, splitLabel, type RebalanceBucket } from "./abstract.js";
import type { EdgeKind } from "./costs.js";
import { expandRoute } from "./expand.js";
import {
  amountLabel,
  networkLabel,
  SOLVER_CODES,
  solverWhy,
} from "./explain.js";
import {
  nodeMatchesAsset,
  walletNodeId,
  type CapabilityGraph,
  type GraphNode,
} from "./graph.js";
import { sameAsset, searchRoutes, type Route } from "./search.js";
import {
  accountLane,
  ask,
  type GoalEnv,
  holdingOf,
  keySelection,
  priceOf,
  refuse,
  sizeCheck,
  type Step,
  symbolOf,
  targetsLabel,
  unitsForUsd,
  unitsToNumber,
  upper,
  usdUnits,
  walletNodeFor,
} from "./goalEnv.js";
import { classLabel, type Problem } from "./problems.js";
import { specFor } from "./sources.js";
import { confirmMoves } from "./multi.js";

/**
 * Rebalance (GOA045, ABS006, ABS019, ABS056): the scope's holdings are
 * read, each target key's share computed, and the fewest moves that bring
 * every key within max($1, 1 %) of its target are planned (bridges for the
 * network axis, swaps for the asset axis), gas reserves kept. Every amount
 * is computed, so every move is confirmed with the list. Unreadable or
 * unpriced holdings refuse (fail closed); "already balanced" refuses.
 */
export function solveRebalance(env: GoalEnv): Step {
  const targets = env.goal.targets;
  const example = "for example \"rebalance my USDC 50/50 between base and arbitrum\"";
  if (!targets || targets.weights.length === 0) throw refuse(`Say the split you want, ${example}.`);
  const sum = targets.weights.reduce((total, weight) => total + weight.bps, 0);
  if (sum !== 10_000 || targets.weights.some((weight) => !Number.isInteger(weight.bps) || weight.bps < 0)) throw refuse(`The shares must add up to 100%, ${example}.`);
  if (new Set(targets.weights.map((weight) => weight.key.toUpperCase())).size !== targets.weights.length) throw refuse(`Name each part of the split once, ${example}.`);
  return targets.axis === "network" ? rebalanceNetworks(env, targets) : rebalanceAssets(env, targets);
}

function rebalanceNetworks(env: GoalEnv, targets: GoalTargets): Step {
  const { goal, snapshot, graph } = env;
  const symbol = symbolOf(goal.spend.asset) ?? symbolOf(goal.want.asset);
  if (!symbol) throw refuse("Say one token to spread across networks, for example \"even out my USDC between base and arbitrum\".");
  const current = accountLane(env.ctx.accounts);
  const nodes = new Map<string, { node: GraphNode; held: string }>();
  const buckets: RebalanceBucket[] = [];
  for (const weight of targets.weights) {
    const network = weight.key;
    if (!isNetworkKey(network) || lane(network) !== current || !hasAccount(env.ctx.accounts, network) || !BRIDGE_NETWORKS.includes(network)) {
      throw refuse(`Kletia cannot move ${symbol} to "${network.slice(0, 24)}" for you. Name networks your accounts can use, such as base and arbitrum.`);
    }
    const node = walletNodeFor(graph, network, { symbol });
    if (!node) throw refuse(`Kletia does not list ${symbol} on ${networkLabel(network)}, so it cannot rebalance it there.`);
    const holding = holdingOf(snapshot, node);
    if (holding?.status !== "known" || !isDecimal(holding.formatted)) {
      throw refuse(`Kletia could not read your ${symbol} on ${networkLabel(network)} right now, so it cannot compute the split. Nothing is planned; try again in a moment.`);
    }
    nodes.set(network, { node, held: holding.formatted });
    buckets.push({ key: network, value: parseDecimal(holding.formatted) });
  }
  const first = [...nodes.values()][0]?.node as GraphNode;
  const price = priceOf(snapshot, first);
  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0n);
  const names = targets.weights.map((weight) => networkLabel(weight.key as NetworkKey)).join(" and ");
  if (total === 0n) throw refuse(`You hold no ${symbol} on ${names} to rebalance.`);
  const tolerance = [total / 100n, price ? unitsForUsd(1, price) : 0n].reduce((a, b) => (a > b ? a : b));
  const plan = rebalancePlan(buckets, targets.weights, tolerance, price ? unitsForUsd(GOAL_LIMITS.materialUsd, price) : 0n);
  if (plan.transfers.length === 0) throw refuse(`Your ${symbol} is already within 1% (or $1) of ${targetsLabel(targets, (key) => networkLabel(key as NetworkKey))}; nothing to move.`);
  const moves: { network: NetworkKey; label: string; steps: WorkStep[]; route: Route }[] = [];
  for (const transfer of plan.transfers) {
    const from = nodes.get(transfer.from) as { node: GraphNode; held: string };
    const to = transfer.to as NetworkKey;
    let value = transfer.value;
    if (from.node.isNative) {
      // The gas reserve stays; a split it keeps from being reached (beyond the tolerance) is refused, never planned short.
      const movable = parseDecimal(from.held) - parseDecimal(NATIVE_FEE_RESERVE[from.node.network]);
      if (movable < value) value = value - movable > tolerance ? 0n : movable;
    }
    const units = formatDecimal(value, Math.min(from.node.decimals, 18));
    if (value <= 0n || !isPositive(units)) {
      throw refuse(`Kletia keeps ${NATIVE_FEE_RESERVE[from.node.network]} ${symbol} on ${networkLabel(from.node.network)} for network fees, so it cannot move enough to reach that split.`);
    }
    const problem: Problem = {
      kinds: new Set<EdgeKind>(["bridge"]),
      isTarget: (node, source) => node.custody.kind === "wallet" && node.network === to && sameAsset(node, source.node),
      excludeSatisfied: false,
    };
    const valueUsd = price ? Number(units) * price : null;
    const route = searchRoutes(specFor(env, problem)([{ node: from.node, valueUsd, amount: from.held, status: "known", position: false }]))[0];
    if (!route) throw refuse(`Kletia found no route for ${symbol} from ${networkLabel(from.node.network)} to ${networkLabel(to)}, so it cannot rebalance it.`);
    const steps = expandRoute({ goal, route, amount: { v: { t: "exact", value: units }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_TARGET_AMOUNT) } });
    moves.push({ network: from.node.network, label: `${amountLabel(units)} ${symbol} ${networkLabel(from.node.network)} to ${networkLabel(to)}`, steps, route });
  }
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  confirmMoves(steps);
  const chip = assumption(field(env.index, "amount"), clip(`Rebalances ${symbol} ${splitLabel(targets.weights)}`, 48), {}, "balance",
    clip(`Moves ${moves.map((move) => move.label).join("; ")}. Targets: ${targetsLabel(targets, (key) => networkLabel(key as NetworkKey))}; within 1% or $1 counts as reached.`, 160), [], true);
  return { kind: "ready", steps, routes: moves.map((move) => move.route), assumptions: [chip] };
}

/** The symbol a class key is bought as on `network`: the largest holding of the class there, else Kletia's default member. */
function outputSymbol(graph: CapabilityGraph, network: NetworkKey, selection: AssetSel, held: readonly { readonly node: GraphNode; readonly usd: number }[]): string | null {
  if ("symbol" in selection) return walletNodeFor(graph, network, selection)?.symbol ?? null;
  const owned = held.filter((entry) => nodeMatchesAsset(entry.node, selection)).sort((a, b) => b.usd - a.usd)[0];
  if (owned) return owned.node.symbol;
  const cls = selection.class as AssetClass | ExposureAssetClass;
  const defaults: Record<AssetClass | ExposureAssetClass, readonly string[]> = {
    "usd-stable": ["USDC", ...USD_ORDER],
    "any-stable": ["USDC", ...USD_ORDER],
    eth: [CHAINS[network].nativeAsset.symbol === "ETH" ? "ETH" : "WETH", "WETH"],
    sol: ["SOL"],
    gas: [CHAINS[network].nativeAsset.symbol],
    "eth-lst": ["wstETH"],
    "sol-lst": ["JitoSOL"],
    btc: ["cbBTC"],
  };
  for (const symbol of defaults[cls]) {
    const node = walletNodeFor(graph, network, { symbol });
    if (node && nodeMatchesAsset(node, selection)) return node.symbol;
  }
  return null;
}

function rebalanceAssets(env: GoalEnv, targets: GoalTargets): Step {
  const { goal, snapshot, graph, pins } = env;
  const current = accountLane(env.ctx.accounts);
  const keys = targets.weights.map((weight) => ({ key: weight.key, selection: keySelection(weight.key) }));
  // One key at 100% ("go 100% stablecoins on base"): every other holding in scope is sold into it.
  const everything = targets.weights.length === 1;
  const matches = (node: GraphNode) => keys.findIndex((entry) => nodeMatchesAsset(node, entry.selection));
  let network = targets.scope?.network ?? goal.want.at?.network ?? pins?.source ?? goal.spend.from?.network;
  if (!network) {
    const held = NETWORK_ORDER.filter((candidate) => lane(candidate) === current && hasAccount(env.ctx.accounts, candidate) && SWAP_NETWORKS.includes(candidate) &&
      snapshot.holdings.some((holding) => {
        if (holding.network !== candidate || holding.status !== "known" || !isPositive(holding.formatted) || !holding.asset) return false;
        const node = graph.nodes.get(walletNodeId(candidate, holding.asset));
        return node !== undefined && (everything || matches(node) >= 0);
      }));
    if (held.length === 0) throw refuse("You hold nothing Kletia can rebalance into that split. Name the network and the tokens, for example \"rebalance to 50/50 eth usdc on arbitrum\".");
    if (held.length > 1) {
      return ask(question(field(env.index, "network"), "choice", "SCOPE_AMBIGUOUS", "Which network should Kletia rebalance?", "Each network is rebalanced on its own; Kletia does not pick for you.",
        held.slice(0, 8).map((entry) => ({ id: entry, label: networkLabel(entry), value: { network: entry } })), true));
    }
    network = held[0] as NetworkKey;
  }
  const scope = network;
  if (lane(scope) !== current || !hasAccount(env.ctx.accounts, scope) || !SWAP_NETWORKS.includes(scope)) throw refuse(`Kletia cannot swap on ${networkLabel(scope)} for your accounts.`);
  for (const entry of keys) {
    if ("symbol" in entry.selection && !walletNodeFor(graph, scope, entry.selection)) throw refuse(`Kletia does not list ${entry.key.slice(0, 16)} on ${networkLabel(scope)}.`);
  }
  const entries: { node: GraphNode; amount: string; price: number; usd: number; key: string }[] = [];
  for (const holding of snapshot.holdings) {
    if (holding.network !== scope || !holding.asset) continue;
    const node = graph.nodes.get(walletNodeId(scope, holding.asset));
    if (!node || node.transferOnly) continue;
    const keyIndex = matches(node);
    if (keyIndex < 0 && !everything) continue;
    if (holding.status !== "known" || !isDecimal(holding.formatted)) {
      throw refuse(`Kletia could not read your ${node.symbol} on ${networkLabel(scope)} right now, so it cannot compute the split. Nothing is planned; try again in a moment.`);
    }
    if (!isPositive(holding.formatted)) continue;
    const price = priceOf(snapshot, node);
    if (price === null) throw refuse(`Kletia could not price ${node.symbol} right now, so it cannot compute the split. Nothing is planned; try again in a moment.`);
    const usd = Number(holding.formatted) * price;
    if (keyIndex < 0 && usd < GOAL_LIMITS.dustUsd) continue;
    entries.push({ node, amount: holding.formatted, price, usd, key: keyIndex >= 0 ? (keys[keyIndex] as { key: string }).key : `other:${node.symbol}` });
  }
  const buckets: RebalanceBucket[] = entries.map((entry) => ({ key: entry.key, value: usdUnits(entry.usd) }));
  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0n);
  const label = (key: string) => (key.startsWith("other:") ? key.slice(6) : classLabel(keySelection(key)) ?? key);
  if (total === 0n) throw refuse(`You hold nothing on ${networkLabel(scope)} to rebalance into ${targetsLabel(targets, label)}.`);
  const tolerance = [total / 100n, usdUnits(1)].reduce((a, b) => (a > b ? a : b));
  const plan = rebalancePlan(buckets, targets.weights, tolerance, usdUnits(GOAL_LIMITS.materialUsd));
  if (plan.transfers.length === 0) throw refuse(`Your holdings on ${networkLabel(scope)} are already within 1% (or $1) of ${targetsLabel(targets, label)}; nothing to move.`);
  const used = new Map<GraphNode, number>();
  const moves: { network: NetworkKey; label: string; steps: WorkStep[]; route: Route }[] = [];
  for (const transfer of plan.transfers) {
    const target = keys.find((entry) => entry.key === transfer.to);
    const out = target ? outputSymbol(graph, scope, target.selection, entries) : null;
    if (!out) throw refuse(`Kletia cannot buy ${label(transfer.to)} on ${networkLabel(scope)}.`);
    let remaining = unitsToNumber(transfer.value);
    const sources = entries.filter((entry) => entry.key === transfer.from).sort((a, b) => b.usd - a.usd || a.node.id.localeCompare(b.node.id));
    for (const source of sources) {
      if (remaining < GOAL_LIMITS.materialUsd) break;
      const reserve = source.node.isNative ? Number(NATIVE_FEE_RESERVE[scope]) : 0;
      const movableUnits = Math.max(0, Number(source.amount) - reserve) - (used.get(source.node) ?? 0);
      const takeUsd = Math.min(remaining, movableUnits * source.price);
      if (takeUsd < GOAL_LIMITS.materialUsd) continue;
      const whole = takeUsd >= movableUnits * source.price - 1e-9 && reserve === 0 && !used.has(source.node);
      const units = whole ? source.amount : formatDecimal(unitsForUsd(takeUsd, source.price), Math.min(source.node.decimals, 6));
      if (!isPositive(units)) continue;
      const problem: Problem = {
        kinds: new Set<EdgeKind>(["swap"]),
        isTarget: (node, from) => node.custody.kind === "wallet" && node.network === scope && upper(node.symbol) === upper(out) && !sameAsset(node, from.node),
        allowBridge: false,
        excludeSatisfied: false,
      };
      const route = searchRoutes(specFor(env, problem)([{ node: source.node, valueUsd: takeUsd, amount: source.amount, status: "known", position: false }]))[0];
      if (!route) throw refuse(`Kletia found no swap from ${source.node.symbol} to ${out} on ${networkLabel(scope)}, so it cannot rebalance.`);
      const steps = expandRoute({ goal, route, amount: { v: { t: "exact", value: units }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_TARGET_AMOUNT) } });
      moves.push({ network: scope, label: `${amountLabel(units)} ${source.node.symbol} to ${out}`, steps, route });
      used.set(source.node, (used.get(source.node) ?? 0) + Number(units));
      remaining -= takeUsd;
    }
    // What the gas reserves keep from moving must stay within the tolerance, or the split is refused, never planned short.
    if (remaining > unitsToNumber(tolerance)) throw refuse(`Kletia keeps gas for network fees on ${networkLabel(scope)}, so it cannot reach ${targetsLabel(targets, label)} there.`);
  }
  if (moves.length === 0) throw refuse(`Kletia keeps gas for network fees on ${networkLabel(scope)}, so nothing is left to move for that split.`);
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  confirmMoves(steps);
  const chip = assumption(field(env.index, "amount"), clip(`Rebalances ${networkLabel(scope)} to ${splitLabel(targets.weights)}`, 48), {}, "balance",
    clip(`Swaps ${moves.map((move) => move.label).join("; ")}. Targets: ${targetsLabel(targets, label)} by USD value; within 1% or $1 counts as reached; gas for fees stays.`, 160), [], true);
  return { kind: "ready", steps, routes: moves.map((move) => move.route), assumptions: [chip] };
}
