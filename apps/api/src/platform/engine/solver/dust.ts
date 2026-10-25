/**
 * Dust sweeps, wanted targets, receiving-network questions and gas
 * warnings.
 */
import {
  CHAINS,
  CLARIFY_LIMITS,
  GOAL_LIMITS,
  NATIVE_FEE_RESERVE,
  type AssetSel,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { hasAccount, lane, NETWORK_ORDER } from "../clarify/catalog.js";
import { assumption, clip, question } from "../clarify/copy.js";
import {
  isDecimal,
  isPositive,
  parseDecimal,
  sub,
} from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type {
  Assumption,
  Option,
  Question,
  WorkStep,
} from "../clarify/types.js";
import type { EdgeKind } from "./costs.js";
import { ceilTo } from "./decide.js";
import { expandRoute } from "./expand.js";
import { amountLabel, costLabel, networkLabel, usdLabel } from "./explain.js";
import { nodeMatchesAsset, walletNodeId } from "./graph.js";
import { RANKING, sameAsset, searchRoutes, type Route } from "./search.js";
import {
  accountLane,
  ask,
  type GoalEnv,
  holdingOf,
  isStableSymbol,
  priceOf,
  refuse,
  sizeCheck,
  type Step,
  symbolOf,
  unitsToNumber,
  upper,
  user,
  walletNodeFor,
} from "./goalEnv.js";
import {
  classLabel,
  destinationQuestion,
  outputQuestion,
  type Problem,
} from "./problems.js";
import { specFor } from "./sources.js";
import { confirmMoves } from "./multi.js";

/**
 * Dust sweep (ABS010, ABS011): every holding worth at most
 * `spend.filter.maxUsdEach` (default $5) is converted into what is wanted on
 * the network named, when its route costs less than 20 % of its value. Gas
 * tokens stay; skipped holdings and unread networks are listed; every
 * conversion is confirmed with the list.
 */
export function solveDust(env: GoalEnv): Step {
  const { goal, snapshot, graph, pins } = env;
  const want = goal.want.asset;
  if (!want) return ask(outputQuestion(env));
  const network = goal.want.at?.network;
  if (!network) return ask(destinationQuestion(env, symbolOf(want) ?? classLabel(want) ?? "dust"));
  const cap = Number(goal.spend.filter?.maxUsdEach ?? GOAL_LIMITS.dustMaxUsdEach);
  if (!Number.isFinite(cap) || cap <= 0) throw refuse("Say the largest balance to sweep in dollars, for example \"sweep balances under $5 into usdc on base\".");
  const from = pins?.source ?? goal.spend.from?.network;
  const current = accountLane(env.ctx.accounts);
  const problem: Problem = {
    kinds: new Set<EdgeKind>(["swap", "bridge"]),
    isTarget: (node, source) => node.custody.kind === "wallet" && node.network === network && nodeMatchesAsset(node, want) && !sameAsset(node, source.node),
    excludeSatisfied: true,
  };
  const spec = specFor(env, problem);
  const skipped: string[] = [];
  const unread = new Set<NetworkKey>();
  const moves: { network: NetworkKey; label: string; steps: WorkStep[]; route: Route }[] = [];
  const ordered = [...snapshot.holdings].sort((a, b) => NETWORK_ORDER.indexOf(a.network) - NETWORK_ORDER.indexOf(b.network) || a.symbol.localeCompare(b.symbol));
  for (const holding of ordered) {
    if (!holding.asset || lane(holding.network) !== current || !hasAccount(env.ctx.accounts, holding.network)) continue;
    if (from && holding.network !== from) continue;
    const node = graph.nodes.get(walletNodeId(holding.network, holding.asset));
    if (!node || node.isNative || node.transferOnly) continue;
    if (node.network === network && nodeMatchesAsset(node, want)) continue;
    if (holding.status !== "known") {
      unread.add(holding.network);
      continue;
    }
    if (!isPositive(holding.formatted)) continue;
    const price = priceOf(snapshot, node);
    if (price === null) {
      skipped.push(`${node.symbol} on ${networkLabel(node.network)} (no price)`);
      continue;
    }
    const usd = holding.usd ?? Number(holding.formatted) * price;
    if (usd > cap) continue;
    const route = searchRoutes(spec([{ node, valueUsd: usd, amount: holding.formatted as string, status: "known", position: false }]))[0];
    if (!route) {
      skipped.push(`${node.symbol} on ${networkLabel(node.network)} (no route)`);
      continue;
    }
    if (route.feesUsd >= usd * DUST_MAX_FEE_SHARE) {
      skipped.push(`${node.symbol} on ${networkLabel(node.network)} (fees above 20%)`);
      continue;
    }
    const steps = expandRoute({ goal, route, amount: user({ t: "balance", bps: 10_000 } as ThreadAmount) });
    moves.push({ network: node.network, label: `${amountLabel(holding.formatted as string)} ${node.symbol} on ${networkLabel(node.network)}`, steps, route });
  }
  const wanted = symbolOf(want) ?? classLabel(want) ?? "it";
  const notes = [
    ...(skipped.length > 0 ? [`Skipped: ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ", ..." : ""}`] : []),
    ...(unread.size > 0 ? [`Kletia could not read ${[...unread].map(networkLabel).join(", ")}`] : []),
  ];
  if (moves.length === 0) throw refuse(`Nothing to sweep into ${wanted}: no holding worth $${cap} or less has a route that costs under 20% of it.${notes.length > 0 ? ` ${notes.join(". ")}.` : ""}`);
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  confirmMoves(steps);
  const chip = assumption(field(env.index, "amount"), clip(`Sweeps ${moves.length} small holding${moves.length === 1 ? "" : "s"} into ${wanted}`, 48), {}, "balance",
    clip(`Each worth $${cap} or less: ${moves.map((move) => move.label).join(", ")}. Gas tokens stay for network fees.${notes.length > 0 ? ` ${notes.join(". ")}.` : ""}`, 160), [], true);
  return { kind: "ready", steps, routes: moves.map((move) => move.route), assumptions: [chip] };
}

/** A dust conversion is skipped when its route costs this share of its value or more. */
const DUST_MAX_FEE_SHARE = 0.2;

/** A target the goal states (want side): the amount to land, read from a token amount, a USD amount or "enough for fees". */
interface WantTarget {
  readonly value: string;
  readonly assumptions: readonly Assumption[];
}

/**
 * The want-side target of a goal: a token amount; a USD amount
 * back-solved at the price of what is wanted; "enough for fees"
 * (`atLeast` with no amount) as Kletia's fee reserve for that network. With
 * `atLeast`, only the difference to what is already held there is moved;
 * a goal that is already met, or whose holding there cannot be read,
 * refuses. Null when the goal states no target (or spends a stated amount).
 */
export function wantTarget(env: GoalEnv, where: NetworkKey | undefined, chained: boolean): WantTarget | Question | null {
  const { goal, snapshot, graph } = env;
  if (chained || goal.spend.amount || env.pins?.amount) return null;
  const amount = goal.want.amount;
  const atLeast = goal.want.mode === "atLeast";
  const asset: AssetSel | undefined = goal.want.asset ?? (goal.kind === "fuel" ? { class: "gas" } : undefined);
  const chips: Assumption[] = [];
  const path = field(env.index, "amount");
  const node = asset && where ? walletNodeFor(graph, where, asset) : undefined;
  const symbol = node?.symbol ?? symbolOf(asset) ?? classLabel(asset) ?? "it";
  let value: string | null = null;
  if (amount?.t === "exact") value = amount.value;
  else if (amount?.t === "usd") {
    if (!node) return null;
    const stable = isStableSymbol(node.symbol) && node.category === "stablecoin";
    const price = stable ? 1 : priceOf(snapshot, node);
    if (price === null) throw refuse(`Kletia could not price ${node.symbol} right now; say the amount in ${node.symbol}, for example "get me 0.01 ${node.symbol} on ${where}".`);
    value = stable ? amount.value : ceilTo(Number(amount.value) / price, Math.min(node.decimals, 6));
    if (!stable) {
      chips.push(assumption(path, clip(`$${amountLabel(amount.value)} read as ${amountLabel(value)} ${node.symbol}`, 48), { amount: { t: "exact", value } }, "price",
        `At ${usdLabel(price)} per ${node.symbol}; the price can move before you sign.`, [], true));
    }
  } else if (atLeast && node?.isNative && where) {
    value = NATIVE_FEE_RESERVE[where];
    chips.push(assumption(path, clip(`Enough for fees: ${amountLabel(value)} ${node.symbol}`, 48), { amount: { t: "exact", value } }, "default",
      `Kletia's fee reserve on ${networkLabel(where)}: enough for several transactions at usual prices.`, [], true));
  }
  if (value === null) return null;
  if (!atLeast) return { value, assumptions: chips };
  if (!where || !node) return destinationQuestion(env, symbol);
  const holding = holdingOf(snapshot, node);
  if (holding?.status !== "known" || !isDecimal(holding.formatted)) {
    throw refuse(`Kletia could not read your ${node.symbol} on ${networkLabel(where)} right now, so it cannot tell how much to add. Say the amount to move instead.`);
  }
  const short = sub(value, holding.formatted);
  if (short <= 0n) throw refuse(`You already hold ${amountLabel(holding.formatted)} ${node.symbol} on ${networkLabel(where)}, at least the ${amountLabel(value)} you asked for. Nothing to move.`);
  const need = ceilTo(unitsToNumber(short), Math.min(node.decimals, 6));
  // One chip: the top-up, with what the target was read from (the fee reserve, a dollar amount) in its reason.
  const read = chips.map((chip) => chip.reason).join(" ");
  return {
    value: need,
    assumptions: [assumption(path, clip(`Tops up ${amountLabel(need)} ${node.symbol} on ${networkLabel(where)}`, 48), { amount: { t: "exact", value: need } }, "balance",
      clip(`You hold ${amountLabel(holding.formatted)} of the ${amountLabel(value)} ${node.symbol} you want there; Kletia adds the difference.${read ? ` ${read}` : ""}`, CLARIFY_LIMITS.why), [], true)],
  };
}

/**
 * Cheapest-path payment (ABS007, GOA040): the network a payment to
 * someone else lands on is purpose (I13). When the recipient does not imply
 * it (an Ethereum name or address), it is asked with what each network
 * would cost from the person's holdings, cheapest first; never a chip.
 */
export function receivingQuestion(env: GoalEnv, routes: readonly Route[], recipient: string): Question | null {
  const best = new Map<NetworkKey, Route>();
  for (const route of routes) if (!best.has(route.landing.network)) best.set(route.landing.network, route);
  if (best.size === 0) return null;
  const cost = (route: Route) => route.feesUsd + RANKING.timeUsdPerSecond * route.seconds;
  const ordered = [...best.values()].sort((a, b) => cost(a) - cost(b) || NETWORK_ORDER.indexOf(a.landing.network) - NETWORK_ORDER.indexOf(b.landing.network));
  const options: Option[] = ordered.slice(0, 8).map((route) => {
    const crosses = route.hops.some((hop) => hop.edge.kind === "bridge");
    const fee = costLabel(route.valueInUsd === null ? null : route.feesUsd, route.seconds);
    return {
      id: route.landing.network,
      label: networkLabel(route.landing.network),
      detail: clip(`${crosses ? `Bridges from ${networkLabel(route.source.node.network)}` : `From your ${route.source.node.symbol} there`} · ${fee}`, 96),
      value: { network: route.landing.network },
    };
  });
  const what = symbolOf(env.goal.want.asset) ?? symbolOf(env.goal.spend.asset) ?? "it";
  return question(field(env.index, "network"), "choice", "TRANSFER_NETWORK", clip(`Which network should ${recipient} receive the ${what} on? Cheapest first.`, 160),
    "An address may be used on only one network; sending on the wrong one can lose the funds. Kletia lists what each costs from your holdings.", options, true);
}

/** A step that runs after a bridge on a network where the person holds no gas. */
export function gasWarnings(env: GoalEnv, route: Route): Assumption[] {
  const out: Assumption[] = [];
  route.hops.forEach((hop, step) => {
    if (step === 0) return;
    const previous = route.hops[step - 1];
    if (previous?.edge.kind !== "bridge" || previous.edge.gasTopup) return;
    const network = hop.edge.network;
    const native = CHAINS[network].nativeAsset.symbol;
    const holding = env.snapshot.holdings.find((entry) => entry.network === network && upper(entry.symbol) === upper(native));
    if (holding?.status !== "known" || (holding.formatted !== undefined && isDecimal(holding.formatted) && parseDecimal(holding.formatted) > 0n)) return;
    out.push(assumption(field(env.index + step, "network"), clip(`No ${native} on ${networkLabel(network)} for fees`, 48), { network }, "balance",
      `The ${hop.edge.kind} on ${networkLabel(network)} needs ${native} for network fees; you hold none there.`, [], true));
  });
  return out;
}
