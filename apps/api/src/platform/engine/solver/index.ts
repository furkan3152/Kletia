/**
 * The Goal solver: `solveGoals(goals, snapshot, ctx)`
 * turns Goals the reader could not lower into ordinary clarify steps,
 * chips and questions.
 *
 *   for each goal, in order:
 *     D9 typo, D1 recipient          asked before anything is searched
 *     sources                        holdings (or positions, or the previous goal's landing)
 *     D2 amount above the balance    asked
 *     D4 possessive scope            asked, or one network (chip), or every network
 *     search (search.ts)             beam search over the capability graph, ranked
 *     D0, D3, D5-D8 (decide.ts)      refuse / ask / pick and show
 *     amounts                        said, priced (D11) or back-solved for a target
 *     expansion (expand.ts)          WorkStep[] with provenance
 *     D12 / D13                      confirm a reading from word order or the LLM layer
 *
 * Abstract goals: rebalance targets, dust sweeps, exit-all,
 * atLeast top-ups, exact deliveries, exposure classes, USD targets and the
 * receiving network of a payment asked with each network's cost; every move
 * Kletia computes for them is confirmed with the moves listed, and more moves
 * than one plan holds are asked or refused, never cut.
 *
 * Goals after the first one that asks are left pending (the policy asks at
 * most two questions a turn). Pure and synchronous over the snapshot read
 * for this turn (snapshot.ts) and the capability graph; nothing is read,
 * signed or sent here. A goal no route can serve throws PlatformError (D0),
 * like the policy does for what no question can fix.
 */
import { THREAD_LIMITS, type Goal } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import type { Assumption, Question, WorkStep } from "../clarify/types.js";
import { capabilityGraph } from "./graph.js";
import type { Landing, Route } from "./search.js";
import type { Snapshot } from "./snapshot.js";
import {
  type GoalEnv,
  type GoalOutcome,
  MAX_QUESTIONS,
  type SolveContext,
  type SolveResult,
} from "./goalEnv.js";
import { solveGoal } from "./solveGoal.js";

export { SOLVER_CODES, solverWhy } from "./explain.js";
export type { GoalPins, GoalReadNotes } from "./decide.js";
export { pickCandidates, searchRoutes, type Dimension, type Landing, type Route, type RouteHop, type SearchSource, type SearchSpec } from "./search.js";
export { expandRoute } from "./expand.js";
export { landingOf } from "./search.js";
export type { Snapshot } from "./snapshot.js";
export { readNotesOf } from "./goalEnv.js";
export type { GoalOutcome, GoalStatus, SolveContext, SolveResult } from "./goalEnv.js";
export type { MovesFlag } from "./multi.js";

/* ---------------------------------------------------------------- entry */

/**
 * Solves `goals` over this turn's `snapshot`: their steps (with provenance),
 * chips and at most two questions. Throws PlatformError for a goal no route
 * can serve and no question can fix (D0).
 */
export function solveGoals(goals: readonly Goal[], snapshot: Snapshot, ctx: SolveContext): SolveResult {
  const graph = ctx.graph ?? capabilityGraph();
  const outcomes: GoalOutcome[] = [];
  const steps: WorkStep[] = [];
  const assumptions: Assumption[] = [];
  let questions: Question[] = [];
  let index = ctx.index ?? 0;
  goals.forEach((goal, position) => {
    if (questions.length > 0) {
      outcomes.push({ goal: position, status: "pending", steps: [], routes: [], landings: [], questions: [], assumptions: [] });
      return;
    }
    const after = goal.chain?.after ?? (goal.spend.amount?.t === "previous" && position > 0 ? position - 1 : undefined);
    let previous: GoalEnv["previous"];
    if (after !== undefined) {
      const outcome = outcomes[after];
      if (!outcome || outcome.status !== "ready") {
        outcomes.push({ goal: position, status: "pending", steps: [], routes: [], landings: [], questions: [], assumptions: [] });
        return;
      }
      if (outcome.routes.length !== 1) {
        throw new PlatformError("INTENT_UNSUPPORTED", "\"It\" refers to money moved in several transfers; say which asset and network to use.", 422, [{ path: "text", message: "Ambiguous reference." }]);
      }
      previous = { route: outcome.routes[0] as Route, outcome };
    }
    const env: GoalEnv = {
      goal: normalizeGoal(goal),
      position,
      index,
      ...(ctx.reads?.[position] ? { notes: ctx.reads[position] } : {}),
      ...(ctx.pins?.[position] ? { pins: ctx.pins[position] } : {}),
      snapshot,
      graph,
      ctx,
      ...(previous ? { previous } : {}),
    };
    const result = solveGoal(env);
    if (result.kind === "ask") {
      questions = result.questions.slice(0, MAX_QUESTIONS);
      const routes = result.routes ?? [];
      outcomes.push({ goal: position, status: "ask", steps: result.steps ?? [], routes, landings: landingsOf(routes), questions, assumptions: [] });
      return;
    }
    if (index + result.steps.length > THREAD_LIMITS.maxSteps) {
      throw new PlatformError("INTENT_UNSUPPORTED", `A task has at most ${THREAD_LIMITS.maxSteps} steps; split it into smaller tasks.`, 422, [{ path: "text", message: "Too many steps." }]);
    }
    outcomes.push({ goal: position, status: "ready", steps: result.steps, routes: result.routes, landings: landingsOf(result.routes), questions: [], assumptions: result.assumptions });
    steps.push(...result.steps);
    assumptions.push(...result.assumptions);
    index += result.steps.length;
  });
  const seen = new Set<string>();
  const unique = assumptions.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
  const ordered = [...unique.filter((entry) => entry.material), ...unique.filter((entry) => !entry.material)];
  return { steps, assumptions: ordered, questions, outcomes };
}

/**
 * "consolidate my USDC on Base": a lone "on <network>" fills both sides (F3),
 * but a consolidation or a move never spends from where it lands.
 */
function normalizeGoal(goal: Goal): Goal {
  const from = goal.spend.from;
  if ((goal.kind === "consolidate" || goal.kind === "relocate") && from?.network && from.network === goal.want.at?.network && from.custody.kind === "wallet") {
    const { from: _from, ...spend } = goal.spend;
    return { ...goal, spend };
  }
  return goal;
}

/** Where the money lands after each step of the routes (the predicted journey). */
function landingsOf(routes: readonly Route[]): Landing[] {
  return routes.flatMap((route) => route.hops.map((hop) => hop.landing));
}
