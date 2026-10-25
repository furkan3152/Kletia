/**
 * Exit-all deliveries and multi-move goals confirmed with their moves.
 */
import {
  CHAINS,
  THREAD_LIMITS,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { planTooLarge } from "../routing/caps.js";
import { assumption, clip, question } from "../clarify/copy.js";
import {
  isDecimal,
  parseDecimal,
  portion,
  formatDecimal,
} from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type { Assumption, WorkStep } from "../clarify/types.js";
import { overCaps } from "./abstract.js";
import { chooseRoute, noRouteError } from "./decide.js";
import { expandRoute } from "./expand.js";
import { amountLabel, networkLabel } from "./explain.js";
import { capabilityGraph, walletNodeId, type GraphNode } from "./graph.js";
import {
  searchRoutes,
  type Route,
  type SearchSource,
  type SearchSpec,
} from "./search.js";
import type { Snapshot } from "./snapshot.js";
import {
  ask,
  type GoalEnv,
  priceOf,
  sizeCheck,
  type Step,
  upper,
  user,
} from "./goalEnv.js";

/** Transient markers on an expanded step (never stored): its computed amount moves most of a network's holdings, or it is a move of an abstract goal. */
export interface MovesFlag {
  movesMajority?: true;
  movesConfirm?: true;
}

/** True when `amount` of `node` is worth more than half of the known USD value held on its network, or a value is unknown. */
export function movesMajority(snapshot: Snapshot, node: GraphNode, amount: string): boolean {
  const price = priceOf(snapshot, node);
  if (price === null || !isDecimal(amount)) return true;
  const moved = Number(amount) * price;
  let total = 0;
  for (const holding of snapshot.holdings) {
    if (holding.network !== node.network || holding.status !== "known" || !holding.formatted || !isDecimal(holding.formatted) || parseDecimal(holding.formatted) <= 0n) continue;
    const listed = holding.asset ? capabilityGraph().nodes.get(walletNodeId(holding.network, holding.asset)) : undefined;
    const usd = holding.usd ?? (listed ? (priceOf(snapshot, listed) ?? null) : null);
    if (usd === null) return true;
    total += holding.usd ?? Number(holding.formatted) * usd;
  }
  return total <= 0 || moved > total / 2;
}

/**
 * Deliver-all: every known, positive holding on the network the
 * person named, paid to the recipient as one transfer each: tokens first, the
 * gas asset last (the policy keeps its fee reserve). The policy asks for the
 * receiving network rules and confirms every move with its amount.
 */
export function deliverAll(env: GoalEnv, recipient: string): Step {
  const { goal, snapshot } = env;
  const network = goal.spend.from?.network ?? goal.want.at?.network;
  if (!network) {
    const networks = [...new Set(snapshot.holdings.filter((holding) => holding.status === "known" && holding.formatted && isDecimal(holding.formatted) && parseDecimal(holding.formatted) > 0n).map((holding) => holding.network))];
    return ask(question(field(env.index, "network"), "choice", "SCOPE_AMBIGUOUS", `Which network's holdings should ${recipient} receive?`, "Each network is paid separately; Kletia does not pick for you.",
      networks.slice(0, 8).map((entry) => ({ id: entry, label: networkLabel(entry), value: { source: entry } })), true));
  }
  const native = CHAINS[network].nativeAsset.symbol.toUpperCase();
  const held = snapshot.holdings
    .filter((holding) => holding.network === network && holding.status === "known" && holding.formatted !== undefined && isDecimal(holding.formatted) && parseDecimal(holding.formatted) > 0n)
    .sort((a, b) => Number(upper(a.symbol) === native) - Number(upper(b.symbol) === native) || a.symbol.localeCompare(b.symbol));
  if (held.length === 0) throw noRouteError(goal);
  // Every holding is one transfer; more than one plan holds is refused with the list, never cut silently.
  const room = Math.max(0, THREAD_LIMITS.maxSteps - env.index);
  if (overCaps({ signatures: held.length, auctions: 0 }, room)) {
    throw planTooLarge({ signatures: held.length, auctions: 0, moves: held.map((holding) => `${amountLabel(holding.formatted as string)} ${holding.symbol} on ${networkLabel(network)} to ${recipient}`) });
  }
  const steps: WorkStep[] = held.map((holding) => ({
    kind: user("transfer" as const),
    from: user(holding.symbol),
    amount: user({ t: "balance", bps: 10_000 } as ThreadAmount),
    network: user(network),
    recipient: user(recipient),
  }));
  const assumptions = [assumption(field(env.index, "amount"), clip(`Sends ${steps.length} holdings on ${networkLabel(network)} to ${recipient}`, 48), {}, "balance",
    `Every token you hold on ${networkLabel(network)}, the gas token last with a little kept for network fees.`, [], true)];
  return { kind: "ready", steps, routes: [], assumptions };
}

/** Consolidate, or a possessive scope answered "all networks": one route per source, each moving all of it. */
export function solveMulti(env: GoalEnv, sources: readonly SearchSource[], spec: (list: readonly SearchSource[]) => SearchSpec, assumptions: Assumption[], exit?: { readonly unread: readonly NetworkKey[] }): Step {
  const { goal } = env;
  const ordered = [...sources].filter((source) => source.status === "known").sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || a.node.id.localeCompare(b.node.id));
  const routes: Route[] = [];
  const moves: { network: NetworkKey; label: string; steps: WorkStep[] }[] = [];
  const chips: Assumption[] = [];
  const stays: string[] = [];
  // "half my stablecoins": the same share of each holding.
  const bps = goal.spend.amount?.t === "portion" ? goal.spend.amount.bps : 10_000;
  const moved = (source: SearchSource): string => (source.amount === null ? "0" : bps === 10_000 ? source.amount : formatDecimal(portion(source.amount, bps), Math.min(source.node.decimals, 18)));
  for (const source of ordered) {
    const found = searchRoutes(spec([source]));
    const label = `${amountLabel(moved(source))} ${source.node.symbol} on ${networkLabel(source.node.network)}`;
    if (found.length === 0) {
      stays.push(label);
      continue;
    }
    const at = env.index + moves.reduce((sum, move) => sum + move.steps.length, 0);
    const choice = chooseRoute({ goal, index: at, routes: found, ...(env.pins ? { pins: env.pins } : {}), assetNamed: true, sourceNamed: true });
    if (choice.kind === "ask") {
      if (choice.questions.length === 0) {
        stays.push(label);
        continue;
      }
      return { kind: "ask", questions: choice.questions };
    }
    const expanded = expandRoute({
      goal,
      route: choice.route,
      amount: user(source.position ? { t: "position", bps } : { t: "balance", bps }),
      ...(goal.holder.t === "address" || goal.holder.t === "name" ? { recipient: goal.holder.value } : {}),
    });
    // Each source's first step names its own asset and network: it is independent of the previous route.
    routes.push(choice.route);
    moves.push({ network: source.node.network, label, steps: expanded });
    chips.push(...choice.assumptions.filter((entry) => !entry.id.endsWith(".network")));
  }
  if (routes.length === 0) throw noRouteError(goal);
  // More moves than one plan holds are asked (or refused), never cut silently.
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  assumptions.push(...chips);
  const where = goal.want.at?.network;
  if (exit) {
    confirmMoves(steps);
    const unread = exit.unread.length > 0 ? ` Kletia could not read ${exit.unread.map(networkLabel).join(", ")}; nothing there is withdrawn.` : "";
    assumptions.unshift(assumption(field(env.index, "amount"), clip(`Withdraws ${routes.length} position${routes.length === 1 ? "" : "s"}`, 48), {}, "position",
      clip(`Every position Kletia read: ${moves.map((move) => move.label).join(", ")}. Wallet tokens stay where they are.${unread}`, 160), [], true));
    return { kind: "ready", steps, routes, assumptions };
  }
  assumptions.unshift(assumption(field(env.index, "amount"), clip(`Moves ${routes.map((route) => `${amountLabel(moved(route.source))} ${route.source.node.symbol} from ${networkLabel(route.source.node.network)}`).join(", ")}`, 48),
    {}, "balance", clip(`${where ? `Everything that can reach ${networkLabel(where)}. ` : ""}${stays.length > 0 ? `Stays: ${stays.join(", ")} (no route or kept for network fees).` : "Gas tokens stay for network fees."}`, 160), [], true));
  return { kind: "ready", steps, routes, assumptions };
}

/* ------------------------------------------------------- abstract goals */

/** Every move of an abstract goal (rebalance, exit-all, dust sweep, top-up) is confirmed with the moves listed. */
export function confirmMoves(steps: readonly WorkStep[]): void {
  for (const step of steps) if (step.amount?.v.t !== "previous") (step as WorkStep & MovesFlag).movesConfirm = true;
}
