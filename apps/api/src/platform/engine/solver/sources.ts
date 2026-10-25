/**
 * Holding and position sources and amount planning.
 */
import {
  GOAL_LIMITS,
  protocolTier,
  type AssetSel,
  type Goal,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  hasAccount,
  lane,
  LOOKALIKES,
  NETWORK_ORDER,
  transferOnly,
} from "../clarify/catalog.js";
import { assumption, clip, question } from "../clarify/copy.js";
import {
  cmp,
  isDecimal,
  parseDecimal,
  sub,
  formatDecimal,
} from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type { Assumption, Question, Slot } from "../clarify/types.js";
import { comparableApy } from "./yieldRank.js";
import { ceilTo, priceAmount, type GoalPins } from "./decide.js";
import {
  amountLabel,
  networkLabel,
  protocolName,
  SOLVER_CODES,
  solverWhy,
} from "./explain.js";
import { nodeMatchesAsset, walletNodeId, type GraphNode } from "./graph.js";
import {
  sameAsset,
  type Route,
  type SearchSource,
  type SearchSpec,
} from "./search.js";
import { usablePrice, type Snapshot } from "./snapshot.js";
import {
  accountLane,
  type GoalEnv,
  isStableSymbol,
  priceOf,
  symbolOf,
  upper,
  user,
} from "./goalEnv.js";
import type { Problem } from "./problems.js";

/* -------------------------------------------------------------- sources */

/** Holdings a goal may spend from (wallet nodes), with what is known about them. */
export function holdingSources(env: GoalEnv): SearchSource[] {
  const { goal, snapshot, graph, pins } = env;
  const from = pins?.source ?? goal.spend.from?.network;
  const asset: AssetSel | undefined = pins?.asset ? { symbol: pins.asset } : goal.spend.asset;
  const current = accountLane(env.ctx.accounts);
  const out: SearchSource[] = [];
  for (const holding of snapshot.holdings) {
    if (!holding.asset) continue;
    const node = graph.nodes.get(walletNodeId(holding.network, holding.asset));
    if (!node || lane(node.network) !== current || !hasAccount(env.ctx.accounts, node.network)) continue;
    if (from && node.network !== from) continue;
    if (asset && !nodeMatchesAsset(node, asset)) continue;
    if (node.transferOnly && goal.kind !== "deliver") continue;
    if (holding.status === "known") {
      if (!holding.formatted || !isDecimal(holding.formatted) || parseDecimal(holding.formatted) <= 0n) continue;
      const price = priceOf(snapshot, node);
      const value = holding.usd ?? (price !== null ? Number(holding.formatted) * price : null);
      if (!asset && (value === null || value < GOAL_LIMITS.dustUsd)) continue;
      if (asset && value !== null && value < GOAL_LIMITS.dustUsd && !from) continue;
      out.push({ node, valueUsd: value, amount: holding.formatted, status: "known", position: false });
    } else if (asset && from) {
      // Unknown is never zero: a named holding that could not be read stays a source (the policy asks the amount).
      out.push({ node, valueUsd: null, amount: null, status: "unknown", position: false });
    }
  }
  return out;
}

/** The same goal with no source network (said or pinned): where else the funds are. */
export function withoutSource(env: GoalEnv): GoalEnv {
  const { from: _from, ...spend } = env.goal.spend;
  const { source: _source, ...pins } = env.pins ?? {};
  return { ...env, goal: { ...env.goal, spend }, pins };
}

/** Positions an exit goal may leave (venue nodes) and the networks whose positions could not be read, or a question when none could. */
export function positionSources(env: GoalEnv): { readonly sources: SearchSource[]; readonly unread: NetworkKey[] } | Question {
  const { goal, snapshot, graph, pins } = env;
  const custody = goal.spend.from?.custody;
  const protocol = custody && custody.kind !== "wallet" ? custody.protocol : undefined;
  const from = pins?.source ?? goal.spend.from?.network;
  const asset = goal.spend.asset;
  const venueNodes = new Map<string, GraphNode>();
  for (const node of graph.nodes.values()) if (node.custody.kind === "venue") venueNodes.set(node.custody.venueId, node);
  const known: SearchSource[] = [];
  const unknown = new Set<NetworkKey>();
  for (const position of snapshot.positions) {
    if (protocol && position.protocol !== protocol) continue;
    if (from && position.network !== from) continue;
    const node = venueNodes.get(position.venue);
    if (!node || !hasAccount(env.ctx.accounts, node.network)) continue;
    if (asset && !nodeMatchesAsset(node, asset) && !(symbolOf(asset) && upper(symbolOf(asset) as string) === upper(position.symbol))) continue;
    if (position.status !== "known") {
      unknown.add(position.network);
      continue;
    }
    if (!position.formatted || !isDecimal(position.formatted) || parseDecimal(position.formatted) <= 0n) continue;
    known.push({ node, valueUsd: position.usd, amount: position.formatted, status: "known", position: true });
  }
  if (known.length > 0) return { sources: known, unread: NETWORK_ORDER.filter((network) => unknown.has(network)) };
  if (unknown.size > 0) {
    const networks = NETWORK_ORDER.filter((network) => unknown.has(network));
    const name = protocol ? protocolName(protocol) : "lending";
    return question(field(env.index, "network"), "choice", "NETWORK_AMBIGUOUS", `Which network is your ${name} position on?`, "Kletia could not read your positions right now.",
      networks.slice(0, 8).map((network) => ({ id: network, label: networkLabel(network), value: { network } })), true);
  }
  const what = [symbolOf(asset), protocol ? protocolName(protocol) : undefined].filter(Boolean).join(" ");
  throw new PlatformError("POSITION_EMPTY", clip(`You have no ${what ? `${what} ` : ""}position Kletia can withdraw${from ? ` on ${networkLabel(from)}` : ""}.`, 200), 422);
}

/** True when a look-alike of the source's asset on its network (USDbC for USDC on Base) covers `need` and could be used. */
export function lookalikeCovers(env: GoalEnv, source: SearchSource, need: string): boolean {
  const symbol = upper(source.node.symbol);
  const pair = LOOKALIKES.find((entry) => entry.network === source.node.network && (upper(entry.a) === symbol || upper(entry.b) === symbol));
  if (!pair) return false;
  const other = upper(pair.a) === symbol ? pair.b : pair.a;
  if (env.goal.kind !== "deliver" && transferOnly(source.node.network, other)) return false;
  const holding = env.snapshot.holdings.find((entry) => entry.network === source.node.network && upper(entry.symbol) === upper(other));
  return holding?.status === "known" && holding.formatted !== undefined && isDecimal(holding.formatted) && cmp(holding.formatted, need) >= 0;
}

/* -------------------------------------------------------------- amounts */

export interface AmountPlan {
  readonly slot?: Slot<ThreadAmount>;
  readonly assumption?: Assumption;
  readonly question?: Question;
}

/** The exact amount the person asked to spend (token units), when it is one; dollar amounts of a stablecoin count at par. */
export function exactNeed(goal: Goal, pins: GoalPins | undefined): string | null {
  const amount = pins?.amount ?? goal.spend.amount;
  if (!amount) return null;
  if (amount.t === "exact") return amount.value;
  if (amount.t === "usd") {
    const symbol = pins?.asset ?? symbolOf(goal.spend.asset);
    if (!symbol || isStableSymbol(symbol)) return amount.value;
  }
  return null;
}

/** The first step's amount for a spend amount said (or none: the policy asks). */
export function spendAmount(env: GoalEnv, route: Route): AmountPlan {
  const { goal, pins, snapshot } = env;
  const source = route.source;
  const path = field(env.index, "amount");
  if (pins?.amount) return { slot: { v: pins.amount, by: "answer" } };
  const said = goal.spend.amount;
  if (!said) return {};
  const symbol = source.node.symbol;
  switch (said.t) {
    case "exact":
      return { slot: user({ t: "exact", value: said.value }) };
    case "usd": {
      if (isStableSymbol(symbol) && source.node.category === "stablecoin") return { slot: user({ t: "exact", value: said.value }) };
      const priced = priceAmount({ index: env.index, usd: said.value, symbol, decimals: source.node.decimals, price: usablePrice(snapshot, source.node.asset) });
      if (!priced) {
        return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${symbol}?`, `Kletia could not price ${symbol} right now; say the amount in ${symbol}.`, [], true, `Amount in ${symbol}`) };
      }
      return { slot: { v: { t: "exact", value: priced.value }, by: "assumed", why: solverWhy(SOLVER_CODES.PRICE_USD) }, assumption: { ...priced.assumption, source: "price" } };
    }
    case "portion":
      return { slot: user(source.position ? { t: "position", bps: said.bps } : { t: "balance", bps: said.bps }) };
    case "max":
      return { slot: user(source.position ? { t: "position", bps: 10_000 } : { t: "balance", bps: 10_000 }) };
    case "previous":
      return { slot: user({ t: "previous", bps: 10_000 }) };
    case "allBut": {
      if (source.amount === null) {
        return { question: question(path, "amount", "AMOUNT_BALANCE_UNKNOWN", `How much ${symbol}?`, "Kletia cannot read your balance; say an exact amount.", [], true, `Amount in ${symbol}`) };
      }
      const left = sub(source.amount, said.keep);
      if (left <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `You hold ${amountLabel(source.amount)} ${symbol}, not more than the ${amountLabel(said.keep)} to keep.`, 422, [{ path, message: "Balance too small." }]);
      const value = formatDecimal(left, Math.min(source.node.decimals, 18));
      return {
        slot: { v: { t: "exact", value }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_SCOPE) },
        assumption: assumption(path, `All but ${amountLabel(said.keep)} ${symbol}: ${amountLabel(value)}`, { amount: { t: "exact", value } }, "balance",
          `You hold ${amountLabel(source.amount)} ${symbol} on ${networkLabel(source.node.network)}.`, [], true),
      };
    }
  }
}

/**
 * Back-solving a target ("get me 0.01 ETH on Arbitrum"): moving the same
 * asset spends the target itself (fees come out of what arrives, shown);
 * another asset is priced, divided by the route's fee shares and given a 1%
 * buffer. Null when a price is missing.
 */
export function targetAmount(snapshot: Snapshot, route: Route, target: string): { value: string; same: boolean; wantUsd?: number; sourceUsd?: number } | null {
  const last = route.hops[route.hops.length - 1]?.to ?? route.source.node;
  if (sameAsset(route.source.node, last)) return { value: target, same: true };
  const wantUsd = priceOf(snapshot, last);
  const sourceUsd = priceOf(snapshot, route.source.node);
  if (wantUsd === null || sourceUsd === null || sourceUsd <= 0) return null;
  const kept = route.hops.reduce((share, hop) => share * (1 - hop.edge.feeBps / 10_000), 1);
  const units = ((Number(target) * wantUsd) / sourceUsd / Math.max(kept, 0.5)) * 1.01;
  return { value: ceilTo(units, Math.min(route.source.node.decimals, 6)), same: false, wantUsd, sourceUsd };
}

/** The USD value a goal moves, when the amount said (or the target) and a price tell it; null otherwise. */
export function movedValue(env: GoalEnv, target: string | null): number | null {
  const { goal, snapshot, graph } = env;
  const amount = env.pins?.amount ?? goal.spend.amount;
  if (amount?.t === "usd") return Number(amount.value);
  const priceOfSel = (selection: AssetSel | undefined, network: NetworkKey | undefined): number | null => {
    if (!selection) return null;
    for (const node of graph.nodes.values()) {
      if (node.custody.kind !== "wallet" || (network && node.network !== network) || !nodeMatchesAsset(node, selection)) continue;
      const price = priceOf(snapshot, node);
      if (price !== null) return price;
    }
    return null;
  };
  if (amount?.t === "exact") {
    const price = priceOfSel(env.pins?.asset ? { symbol: env.pins.asset } : goal.spend.asset, goal.spend.from?.network);
    return price === null ? null : Number(amount.value) * price;
  }
  if (target) {
    if (goal.want.amount?.t === "usd") return Number(goal.want.amount.value);
    const price = priceOfSel(goal.want.asset, goal.want.at?.network);
    return price === null ? null : Number(target) * price;
  }
  return null;
}

/* ------------------------------------------------------------ one goal */

/** The search spec of a goal's problem over a list of sources (the goal's verb, constraints, rates and gas prices). */
export function specFor(env: GoalEnv, problem: Problem): (list: readonly SearchSource[]) => SearchSpec {
  const { goal } = env;
  const gasPrices = new Map<NetworkKey, number | null>();
  for (const node of env.graph.nodes.values()) {
    if (node.isNative && node.custody.kind === "wallet" && !gasPrices.has(node.network)) gasPrices.set(node.network, priceOf(env.snapshot, node));
  }
  return (list) => ({
    graph: env.graph,
    sources: list,
    isTarget: problem.isTarget,
    kinds: problem.kinds,
    ...(goal.op && goal.op !== "call" && goal.op !== "action" && problem.kinds.has(goal.op) ? { op: goal.op } : {}),
    ...(problem.allowBridge === false ? { allowBridge: false } : {}),
    ...(problem.finalTransfer ? { finalTransfer: true } : {}),
    accounts: env.ctx.accounts,
    ...(goal.constraints.via ? { via: goal.constraints.via } : {}),
    ...(goal.constraints.avoid ? { avoid: goal.constraints.avoid } : {}),
    ...(goal.constraints.prefer ? { prefer: goal.constraints.prefer } : {}),
    // Routes count a venue's smoothed rate only when it passes the comparison checks, never the current rate.
    apy: (venueId) => {
      const entry = env.snapshot.apy.get(venueId);
      return entry ? comparableApy(entry, protocolTier(entry.protocol, entry.network)) : null;
    },
    gasAssetUsd: (network) => gasPrices.get(network) ?? null,
    ...(env.ctx.gasPriceWei ? { gasPriceWei: env.ctx.gasPriceWei } : {}),
  });
}
