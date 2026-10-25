/**
 * Solves one ordinary goal.
 */
import { CLARIFY_LIMITS, type Goal, type NetworkKey } from "@kletia/core";
import { assumption, clip, question } from "../clarify/copy.js";
import { cmp } from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type { Assumption, Option, WorkStep } from "../clarify/types.js";
import { EXACT_DELIVERY_PLANNED } from "./moves.js";
import { bestRatedStake, stakeProvidersOf } from "./yieldRank.js";
import {
  chooseRoute,
  confirmQuestion,
  crossingSourceQuestion,
  describeRoute,
  exceedsQuestion,
  fundsElsewhereQuestion,
  noRouteError,
  recipientQuestion,
  scopeDecision,
  typoQuestion,
} from "./decide.js";
import { expandRoute } from "./expand.js";
import {
  amountLabel,
  costLabel,
  networkLabel,
  SOLVER_CODES,
  solverWhy,
  usdLabel,
} from "./explain.js";
import { nodeMatchesAsset } from "./graph.js";
import { searchRoutes, type Route, type SearchSource } from "./search.js";
import {
  ask,
  type GoalEnv,
  refuse,
  type Step,
  symbolOf,
  user,
} from "./goalEnv.js";
import {
  classLabel,
  exposureChip,
  exposureOrder,
  isExposure,
  problemFor,
  recipientNetworks,
  yieldPreference,
} from "./problems.js";
import {
  type AmountPlan,
  exactNeed,
  holdingSources,
  lookalikeCovers,
  movedValue,
  positionSources,
  specFor,
  spendAmount,
  targetAmount,
  withoutSource,
} from "./sources.js";
import {
  deliverAll,
  type MovesFlag,
  movesMajority,
  solveMulti,
} from "./multi.js";
import { solveRebalance } from "./rebalance.js";
import {
  gasWarnings,
  receivingQuestion,
  solveDust,
  wantTarget,
} from "./dust.js";

/**
 * Exact delivery ("make sure alice.eth gets exactly 50 usdc on arbitrum"):
 * the stated amount is what the recipient receives, so it is what the final
 * transfer sends, paid in that asset.
 */
function exactlyGoal(env: GoalEnv): GoalEnv {
  const goal = env.goal;
  if (goal.kind !== "deliver" || goal.want.mode !== "exactly" || goal.want.amount?.t !== "exact" || goal.spend.amount) return env;
  const asset = goal.spend.asset ?? goal.want.asset;
  return { ...env, goal: { ...goal, spend: { ...goal.spend, amount: goal.want.amount, ...(asset ? { asset } : {}) } } };
}

/** "exit all my lending positions", "close everything on base": every position in scope, none named. */
function isExitAll(goal: Goal): boolean {
  const custody = goal.spend.from?.custody;
  if (goal.kind !== "exit" || (custody && custody.kind !== "wallet" && custody.protocol)) return false;
  if (goal.spend.amount && goal.spend.amount.t !== "max") return false;
  return goal.want.at?.custody.kind !== "venue" && goal.want.asset === undefined;
}

export function solveGoal(input: GoalEnv): Step {
  const env = exactlyGoal(input);
  const { goal, notes, pins } = env;
  // D9, D1: before anything is searched.
  const typo = typoQuestion(notes, env.index);
  if (typo && !pins?.asset) return ask(typo);
  const recipient = recipientQuestion(goal, env.index);
  if (recipient) return ask(recipient);
  // "send everything on base to alice.eth" is a payment of every holding there to the recipient, never a
  // consolidation into the person's own account (one transfer per asset; the policy confirms every move).
  if (goal.kind === "consolidate" && (goal.holder.t === "address" || goal.holder.t === "name")) return deliverAll(env, goal.holder.value);
  // Abstract goals with their own arithmetic: rebalance targets and dust sweeps.
  if (goal.kind === "rebalance") return solveRebalance(env);
  if (goal.kind === "consolidate" && goal.spend.filter) return solveDust(env);

  const problem = problemFor(env);
  if (!("kinds" in problem)) return ask(problem);

  // Sources: the previous goal's landing, positions, or holdings.
  const chained = env.previous !== undefined;
  // The want-side target: a token amount, USD back-solved, "enough for fees", or only the difference (atLeast).
  const wantSaid = wantTarget(env, goal.want.at?.network ?? problem.where, chained);
  if (wantSaid && "reason" in wantSaid) return ask(wantSaid);
  // "exactly": the recipient receives the stated amount. Until exact delivery across networks is planned, only
  // funds already on the receiving network can pay it.
  const exactly = goal.kind === "deliver" && goal.want.mode === "exactly";
  const receiving = goal.want.at?.network ?? (recipientNetworks(goal, env.ctx.accounts)?.length === 1 ? recipientNetworks(goal, env.ctx.accounts)?.[0] : undefined);
  let sources: SearchSource[];
  let unread: NetworkKey[] = [];
  if (env.previous) {
    const landing = env.previous.route.landing;
    const node = env.graph.nodes.get(env.previous.route.hops[env.previous.route.hops.length - 1]?.to.id ?? env.previous.route.source.node.id);
    if (!node) throw noRouteError(goal);
    sources = [{ node, valueUsd: env.previous.route.valueOutUsd, amount: null, status: "unknown", position: landing.place.custody.kind === "venue" }];
  } else if (goal.kind === "exit" || goal.spend.from?.custody.kind === "position") {
    const positions = positionSources(env);
    if (!("sources" in positions)) return ask(positions);
    sources = positions.sources;
    unread = positions.unread;
  } else {
    sources = holdingSources(env);
  }
  if (exactly && receiving && !EXACT_DELIVERY_PLANNED && !chained) {
    const need = exactNeed(goal, pins);
    const there = sources.filter((source) => source.node.network === receiving);
    const covering = there.filter((source) => source.status === "known" && source.amount !== null && need !== null && cmp(source.amount, need) >= 0);
    if (covering.length === 0) {
      const held = there.find((source) => source.amount !== null)?.amount ?? "0";
      const what = symbolOf(goal.spend.asset) ?? "it";
      throw refuse(`${goal.holder.t === "name" || goal.holder.t === "address" ? goal.holder.value.slice(0, 42) : "The recipient"} receives exactly ${need ? amountLabel(need) : "that"} ${what} on ${networkLabel(receiving)} only from ${what} already there, and you hold ${amountLabel(held)}. Move ${what} to ${networkLabel(receiving)} first, then send.`);
    }
    sources = covering;
  }
  if (problem.excludeSatisfied) sources = sources.filter((source) => !problem.isTarget(source.node, source));
  // Converting into an asset already held: those holdings are not what is spent ("convert my stablecoins to USDC").
  const wanted = goal.want.asset;
  if (goal.kind === "convert" && wanted && !symbolOf(goal.spend.asset)) sources = sources.filter((source) => !nodeMatchesAsset(source.node, wanted));
  if (goal.kind === "consolidate" && !goal.spend.asset && !pins?.asset) sources = sources.filter((source) => !source.node.isNative);

  const symbol = pins?.asset ?? symbolOf(goal.spend.asset) ?? classLabel(goal.spend.asset) ?? sources[0]?.node.symbol ?? symbolOf(goal.want.asset) ?? "funds";
  // Exit-all: one withdraw per position in scope; networks whose positions could not be read are named and asked
  // about, never treated as empty.
  const exitAll = !chained && isExitAll(goal);
  if (exitAll && unread.length > 0 && pins?.scope !== "all") {
    return ask(question(field(env.index, "network"), "confirm", "SCOPE_AMBIGUOUS",
      clip(`Kletia could not read your positions on ${unread.map(networkLabel).join(", ")}. Withdraw from the ${sources.length} it read?`, 160),
      "Positions Kletia could not read are not withdrawn; you can ask again for them later.",
      [{ id: "all", label: clip(`Withdraw the ${sources.length} Kletia read`, 48), value: { target: "all" } }, { id: "cancel", label: "No, rewrite it", value: { target: "cancel" } }], false));
  }

  // D2: an exact amount above every known balance.
  const need = chained ? null : exactNeed(goal, pins);
  if (need && sources.length > 0 && !pins?.amount) {
    const named = pins?.source ?? goal.spend.from?.network;
    const elsewhere = named ? holdingSources(withoutSource(env)).filter((source) => source.node.network !== named) : [];
    // D10 before D2: a look-alike on the same network that covers the amount is the policy's ASSET_LOOKALIKE question.
    const lookalike = sources.some((source) => lookalikeCovers(env, source, need));
    const exceeds = lookalike ? null : exceedsQuestion({ index: env.index, symbol: sources[0]?.node.symbol ?? symbol, need, sources, elsewhere });
    if (exceeds) return ask(exceeds);
    sources = sources.filter((source) => source.status !== "known" || source.amount === null || cmp(source.amount, need) >= 0 || lookalikeCovers(env, source, need));
  }

  // D4: a possessive scope over several networks.
  const assumptions: Assumption[] = [...(wantSaid && !("reason" in wantSaid) ? wantSaid.assumptions : [])];
  // One position read and nothing unread is an ordinary withdraw; several (or some unread) are an exit-all's moves.
  let multi = goal.kind === "consolidate" || (exitAll && (sources.length > 1 || unread.length > 0));
  const possessive = notes?.possessive === true || goal.spend.amount?.t === "max";
  if (!multi && !chained && possessive && !goal.spend.from?.network && !pins?.source && goal.spend.asset && new Set(sources.map((source) => source.node.network)).size > 1) {
    const scope = scopeDecision({ index: env.index, symbol, sources, ...(pins?.scope ? { pinned: pins.scope } : {}) });
    if (scope.kind === "ask") return ask(scope.question);
    if (scope.kind === "all") multi = true;
    else {
      sources = sources.filter((source) => source.node.network === scope.network);
      if (scope.assumption) assumptions.push(scope.assumption);
    }
  }
  // A class spent whole or in part ("all my stables on base", "half my stablecoins") is every holding of the class
  // in scope, never the one a route search prefers; several holdings are several moves (the policy confirms them).
  const classSpend = goal.spend.asset !== undefined && "class" in goal.spend.asset && !pins?.asset;
  const shareSaid = goal.spend.amount?.t === "max" || goal.spend.amount?.t === "portion";
  if (!multi && !chained && classSpend && shareSaid && new Set(sources.map((source) => source.node.id)).size > 1) multi = true;

  const spec = specFor(env, problem);

  if (multi) return solveMulti(env, sources, spec, assumptions, exitAll ? { unread } : undefined);

  // Fees are charged on what moves, not on the whole holding.
  const target = wantSaid && !("reason" in wantSaid) ? wantSaid.value : null;
  const movedUsd = movedValue(env, target);
  if (movedUsd !== null) sources = sources.map((source) => ({ ...source, valueUsd: source.valueUsd === null ? movedUsd : Math.min(source.valueUsd, movedUsd) }));
  else if (goal.spend.amount?.t === "portion") {
    const bps = goal.spend.amount.bps;
    sources = sources.map((source) => ({ ...source, valueUsd: source.valueUsd === null ? null : (source.valueUsd * bps) / 10_000 }));
  }

  let routes = sources.length > 0 ? searchRoutes(spec(sources)) : [];

  // Back-solve a target amount; keep the routes whose source covers it.
  const required = new Map<Route, ReturnType<typeof targetAmount>>();
  if (target) {
    const all = routes;
    for (const route of routes) required.set(route, targetAmount(env.snapshot, route, target));
    routes = routes.filter((route) => {
      const amount = required.get(route);
      return !amount || route.source.amount === null || cmp(route.source.amount, amount.value) >= 0;
    });
    if (routes.length === 0 && all.length > 0) {
      // The person named where or what to spend, or only the wanted asset itself can pay: the amount is the question (D2).
      const sameOnly = all.every((route) => required.get(route)?.same === true);
      if (goal.spend.from?.network || pins?.source || goal.spend.asset || sameOnly) {
        const routeSources = [...new Map(all.map((route) => [route.source.node.id, route.source])).values()];
        // The shortfall is in what pays: the source amount the target needs, not the target itself (0.1 SOL paid in USDC).
        const needs = all.map((route) => required.get(route)?.value).filter((value): value is string => value !== undefined);
        const need = needs.length > 0 ? needs.reduce((low, value) => (cmp(value, low) < 0 ? value : low)) : target;
        const exceeds = exceedsQuestion({ index: env.index, symbol: routeSources[0]?.node.symbol ?? symbol, need, sources: routeSources, elsewhere: [] });
        if (exceeds) return ask(exceeds);
      }
      const options: Option[] = [];
      const seen = new Set<string>();
      for (const route of all) {
        const key = `${route.source.node.network}:${route.source.node.symbol}`;
        if (seen.has(key) || options.length >= 8) continue;
        seen.add(key);
        options.push({ id: key, label: clip(`Pay with ${route.source.node.symbol} on ${networkLabel(route.source.node.network)}`, 48), detail: route.source.amount ? `You hold ${amountLabel(route.source.amount)} (not enough)` : "Balance unknown", value: { asset: route.source.node.symbol, source: route.source.node.network } });
      }
      return ask(question(field(env.index, "from"), "choice", "INPUT_ASSET_MISSING", `None of your holdings covers ${amountLabel(target)} ${symbolOf(goal.want.asset) ?? ""}. Which should pay, with a smaller target?`.replace(" .", "."),
        "Kletia only plans what your balances cover.", options, true));
    }
  }

  // D0: nothing can run the goal.
  if (routes.length === 0) {
    const named = pins?.source ?? goal.spend.from?.network;
    if (named || goal.spend.asset) {
      const relaxed = holdingSources(withoutSource(env))
        .filter((source) => source.node.network !== named && (!need || source.amount === null || cmp(source.amount, need) >= 0))
        .filter((source) => !problem.excludeSatisfied || !problem.isTarget(source.node, source));
      const elsewhere = relaxed.length > 0 && named ? searchRoutes(spec(relaxed)) : [];
      const funds = fundsElsewhereQuestion({ index: env.index, symbol, from: named, routes: elsewhere });
      if (funds) return ask(funds);
    }
    throw noRouteError(goal);
  }

  // The receiving network of a payment to someone else is purpose (I13): asked with each network's cost when the
  // recipient does not imply it ("cheapest way to send 50 usdc to alice.eth").
  if (goal.kind === "deliver" && !chained && !goal.want.at?.network && (goal.holder.t === "address" || goal.holder.t === "name") && (recipientNetworks(goal, env.ctx.accounts) ?? []).length > 1) {
    const asked = receivingQuestion(env, routes, goal.holder.value);
    if (asked) return ask(asked);
  }
  // Exposure classes: the liquid staking token with the best compared 7-day rate for its risk leads.
  if (isExposure(goal.want.asset)) routes = exposureOrder(env, routes);

  const choice = chooseRoute({
    goal,
    index: env.index,
    routes,
    ...(pins ? { pins } : {}),
    assetNamed: goal.spend.asset !== undefined || pins?.asset !== undefined || chained,
    sourceNamed: goal.spend.from?.network !== undefined || pins?.source !== undefined || chained,
    bestStake: (input) => {
      const readings = env.snapshot.stakes?.get(input);
      return readings && readings.length > 0 ? bestRatedStake(stakeProvidersOf(input), readings, yieldPreference(goal)) : undefined;
    },
  });
  if (choice.kind === "ask") {
    if (choice.questions.length === 0) throw noRouteError(goal);
    return { kind: "ask", questions: choice.questions };
  }
  const route = choice.route;
  // A crossing to a network the person said (or the recipient implies), from a holding on a network
  // they did not name, is asked; moving money they asked to move (relocate, consolidate) or a means choice is a chip.
  const sourceNamed = goal.spend.from?.network !== undefined || pins?.source !== undefined || chained;
  const destinationSaid = goal.want.at?.network !== undefined || (goal.kind === "deliver" && (recipientNetworks(goal, env.ctx.accounts) ?? []).length === 1);
  // A top-up ("prepare 100 usdc on optimism") names no source either: asked like any other crossing.
  const movesSaid = (goal.kind === "relocate" || goal.kind === "consolidate") && goal.want.mode !== "atLeast";
  if (!sourceNamed && destinationSaid && !movesSaid && route.hops.some((hop) => hop.edge.kind === "bridge")) {
    const to = goal.want.at?.network ?? route.landing.network;
    const asked = crossingSourceQuestion({ index: env.index, symbol: route.source.node.symbol, to, routes: routes.filter((entry) => entry.hops.some((hop) => hop.edge.kind === "bridge")) });
    if (asked) return ask(asked);
  }
  assumptions.push(...choice.assumptions);
  const exposure = exposureChip(env, route, routes);
  if (exposure) assumptions.push(exposure);

  // The first step's amount: said, priced (D11), back-solved, or left for the policy to ask.
  let amount: AmountPlan;
  if (chained) amount = { slot: user({ t: "previous", bps: 10_000 }) };
  else if (target) {
    const solved = required.get(route) ?? targetAmount(env.snapshot, route, target);
    const wantSymbol = route.landing.symbol;
    if (!solved) {
      amount = { question: question(field(env.index, "amount"), "amount", "AMOUNT_MISSING", `How much ${route.source.node.symbol} should pay for ${amountLabel(target)} ${wantSymbol}?`, `Kletia could not price ${route.source.node.symbol} or ${wantSymbol} right now.`, [], true, `Amount in ${route.source.node.symbol}`) };
    } else {
      amount = {
        slot: { v: { t: "exact", value: solved.value }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_TARGET_AMOUNT) },
        assumption: assumption(field(env.index, "amount"),
          solved.same ? `Moves ${amountLabel(solved.value)} ${route.source.node.symbol}` : `${amountLabel(solved.value)} ${route.source.node.symbol} for ${amountLabel(target)} ${wantSymbol}`,
          { amount: { t: "exact", value: solved.value } }, solved.same ? "default" : "price",
          solved.same
            ? `${route.valueInUsd === null ? "Fees" : `Fees (${costLabel(route.feesUsd, route.seconds)})`} come out of what arrives.`
            : `At ${usdLabel(solved.wantUsd as number)} per ${wantSymbol} and ${usdLabel(solved.sourceUsd as number)} per ${route.source.node.symbol}, plus fees and a 1% buffer.`,
          [], !solved.same),
      };
    }
  } else amount = spendAmount(env, route);
  if (amount.question) return ask(amount.question);
  if (amount.assumption) {
    // One amount chip: what the goal's target says (a top-up, "enough for fees", a dollar target) leads, the
    // back-solved price detail follows.
    const own = assumptions.findIndex((entry) => entry.id === amount.assumption?.id);
    if (own >= 0) {
      const lead = assumptions[own] as Assumption;
      assumptions.splice(own, 1);
      const reason = lead.source === "price" ? amount.assumption.reason : `${lead.reason} ${amount.assumption.reason}`;
      assumptions.unshift({ ...amount.assumption, label: lead.label, reason: clip(reason, CLARIFY_LIMITS.why) });
    } else assumptions.unshift(amount.assumption);
  }

  const steps = expandRoute({
    goal,
    route,
    ...(amount.slot ? { amount: amount.slot } : {}),
    ...(goal.holder.t === "address" || goal.holder.t === "name" ? { recipient: goal.holder.value } : {}),
    chained,
  });
  // A target amount Kletia computed that moves more than half of what the source network holds (by USD)
  // is confirmed with the move listed; unknown values count as more (fail closed).
  if (target && amount.slot?.v.t === "exact" && steps[0]) {
    if (movesMajority(env.snapshot, route.source.node, amount.slot.v.value)) (steps[0] as WorkStep & MovesFlag).movesMajority = true;
  }
  assumptions.push(...gasWarnings(env, route));

  // D12 / D13: confirm a reading from word order or the LLM layer.
  const amountSaid = amount.slot?.v.t === "exact" ? amount.slot.v.value : undefined;
  const confirm = confirmQuestion({ goal, ...(notes ? { notes } : {}), ...(pins ? { pins } : {}), index: env.index, summary: describeRoute(route, amountSaid) });
  if (confirm) return { kind: "ask", questions: [confirm], steps, routes: [route] };
  return { kind: "ready", steps, routes: [route], assumptions };
}
