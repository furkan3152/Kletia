/**
 * Expansion: a chosen route becomes ordinary clarify steps (`WorkStep[]`),
 * so the existing policy, canonical sentence, round-trip check, departure
 * rules, planner and journey run unchanged and the solver can never emit a
 * step the grammar cannot say.
 *
 * Provenance:
 * - a value the person said keeps `by: "user"`;
 * - a value the solver chose is `by: "assumed"` with `why: { source, code }`
 *   (SOLVER_SOURCE, SOLVER_VENUE_APY, SOLVER_TARGET_AMOUNT, PRICE_USD) where
 *   the policy uses the slot as given (asset, amount, venue, destination);
 * - where the policy would re-decide an assumed slot on its own (the network
 *   a step runs on, the staking provider: R0 stickiness and the default
 *   provider rule), the route's value is `by: "derived"` and the solver's
 *   own chip explains it, so the policy neither overrides nor re-explains it;
 * - every step after the first spends all of the previous one's output
 *   (`amount: { t: "previous", bps: 10000 }`), exactly as the clarify layer
 *   renders "then deposit it".
 *
 * A bridge or DEX is never pinned unless the person named it (`via`): the
 * planner's auction chooses the venue (D8).
 */
import { protocolExecutesKind, type Goal, type ThreadAmount } from "@kletia/core";
import { VAULT_PROTOCOLS, venuesOn } from "../clarify/catalog.js";
import type { Slot, WorkStep } from "../clarify/types.js";
import { SOLVER_CODES, solverWhy, type SolverCode } from "./explain.js";
import type { Route, RouteHop } from "./search.js";

export interface ExpandInput {
  readonly goal: Goal;
  readonly route: Route;
  /** The first step's amount; undefined leaves it open (the policy asks). */
  readonly amount?: Slot<ThreadAmount>;
  /** Deliveries: the recipient as said (an address or a name). */
  readonly recipient?: string;
  /** The first step spends the previous goal's output (its network then follows the previous landing). */
  readonly chained?: boolean;
}

const user = <T>(v: T): Slot<T> => ({ v, by: "user" });
const derived = <T>(v: T): Slot<T> => ({ v, by: "derived" });
const assumed = <T>(v: T, code: SolverCode): Slot<T> => ({ v, by: "assumed", why: solverWhy(code) });

const upper = (value: string | undefined) => value?.trim().toUpperCase();

function saidSymbol(goal: Goal, side: "spend" | "want"): string | undefined {
  const asset = goal[side].asset;
  return asset && "symbol" in asset ? asset.symbol : undefined;
}

/** True when the person named this symbol for this side (case-insensitive, registry aliases aside). */
function said(goal: Goal, side: "spend" | "want", symbol: string): boolean {
  return upper(saidSymbol(goal, side)) === upper(symbol);
}

/** The protocol the person named for this step kind (`via`, or the venue they named). */
function namedProtocol(goal: Goal, hop: RouteHop): string | undefined {
  if (hop.edge.kind === "deposit") {
    const custody = goal.want.at?.custody;
    return custody?.kind === "venue" ? custody.protocol : undefined;
  }
  if (hop.edge.kind === "withdraw") {
    const custody = goal.spend.from?.custody;
    return custody && custody.kind !== "wallet" ? custody.protocol : undefined;
  }
  return goal.constraints.via?.find((protocol) => protocolExecutesKind(protocol, hop.edge.kind) && (protocol === hop.edge.protocol || protocol === hop.edge.adapterId));
}

function networkSlot(goal: Goal, hop: RouteHop, index: number): Slot<NonNullable<WorkStep["network"]>["v"]> {
  const network = hop.edge.network;
  const named = index === 0 ? goal.spend.from?.network ?? (goal.want.at?.network === network && hop.edge.kind !== "bridge" ? network : undefined) : undefined;
  return named === network ? user(network) : derived(network);
}

/** The clarify steps of one route (see the module comment for provenance). */
export function expandRoute(input: ExpandInput): WorkStep[] {
  const { goal, route } = input;
  const steps: WorkStep[] = [];
  route.hops.forEach((hop, index) => {
    const kind = hop.edge.kind;
    const step: WorkStep = { kind: goal.op === kind ? user(kind) : derived(kind) };
    const first = index === 0;
    const dependent = !first || input.chained === true;
    // Where the step runs. A chained first step follows the previous landing (the policy reads it from there).
    if (kind !== "stake" || !dependent) step.network = networkSlot(goal, hop, index);
    // What it spends.
    if (first && input.amount) step.amount = input.amount;
    else if (!first) step.amount = derived({ t: "previous", bps: 10_000 });
    if (first && !input.chained) {
      const symbol = kind === "stake" ? hop.provider?.input ?? hop.from.symbol : hop.from.symbol;
      step.from = said(goal, "spend", symbol) || (kind === "deposit" && said(goal, "spend", hop.from.symbol)) ? user(symbol) : assumed(symbol, SOLVER_CODES.SOLVER_SOURCE);
    }
    switch (kind) {
      case "swap":
        step.to = said(goal, "want", hop.to.symbol) ? user(hop.to.symbol) : derived(hop.to.symbol);
        break;
      case "bridge": {
        step.toNetwork = goal.want.at?.network === hop.edge.destinationNetwork ? user(hop.edge.destinationNetwork) : assumed(hop.edge.destinationNetwork, SOLVER_CODES.SOLVER_BRIDGE);
        if (upper(hop.to.symbol) !== upper(hop.from.symbol)) step.to = said(goal, "want", hop.to.symbol) ? user(hop.to.symbol) : derived(hop.to.symbol);
        break;
      }
      case "stake": {
        const provider = hop.provider;
        if (provider) {
          const named = goal.want.asset && "symbol" in goal.want.asset && upper(goal.want.asset.symbol) === upper(provider.symbol);
          step.provider = named ? user(provider.id) : derived(provider.id);
        }
        break;
      }
      case "deposit":
      case "withdraw": {
        const venue = hop.venue;
        if (!venue) break;
        const named = namedProtocol(goal, hop);
        step.protocol = named === venue.protocol ? user(venue.protocol) : assumed(venue.protocol, SOLVER_CODES.SOLVER_VENUE_APY);
        const wallet = kind === "deposit" ? hop.from.symbol : hop.to.symbol;
        if (VAULT_PROTOCOLS.includes(venue.protocol) && venuesOn(venue.network, kind, venue.protocol, wallet).length > 1) {
          const custody = kind === "deposit" ? goal.want.at?.custody : goal.spend.from?.custody;
          const vault = custody?.kind === "venue" ? custody.vault : undefined;
          step.vault = vault && vault.toLowerCase() === venue.slug.toLowerCase() ? user(venue.slug) : assumed(venue.slug, SOLVER_CODES.SOLVER_VENUE_APY);
        }
        break;
      }
      case "transfer":
        if (input.recipient) step.recipient = user(input.recipient);
        break;
    }
    // A protocol the person named for a swap or bridge ("via across").
    if ((kind === "swap" || kind === "bridge") && namedProtocol(goal, hop)) step.protocol = user(namedProtocol(goal, hop) as string);
    steps.push(step);
  });
  return steps;
}
