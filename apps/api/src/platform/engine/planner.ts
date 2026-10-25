/**
 * Intent planner: IntentRequest -> IntentGraph.
 *
 * 1. Validate the request; compile text with the deterministic grammar or
 *    accept structured actions; apply the departure (`sourceNetwork`,
 *    departure.ts) unless the clarify layer already applied one.
 * 2. Normalise actions (kinds, networks, amounts, capital lane).
 * 3. Resolve assets, accounts, recipients (names through the resolver hook)
 *    and, for deposit / withdraw, the registry venue; bind each step to an
 *    adapter (respecting prefer/avoid constraints) and quote it. Cross-network
 *    steps run a venue auction (auction.ts); other steps take the first
 *    adapter that quotes.
 *    Same-network swaps with several candidate venues run the auction too.
 * 4. Chain dependent amounts from the previous step's guaranteed minimum
 *    (amount flow F1), recorded as `step.funding`; a funded step that spends
 *    the network's gas asset keeps a gas reserve when the account holds too
 *    little gas there (F6). Legs arriving on a network named in
 *    `constraints.gasOnArrival` are served only by venues that deliver gas
 *    with the fill (Relay today).
 * 5. Merge "bridge then swap everything on the destination" into a single
 *    cross-network swap when a venue quotes it.
 * 6. Assemble steps, edges, summary and warnings; enforce fee limits; validate.
 *
 * The modules live in ./planner/.
 */
export {
  DEFAULT_SLIPPAGE_BPS,
  INTENT_TTL_MS,
  LENDING_PROTOCOLS,
  MAX_INTENT_TTL_MS,
  isGrammarRefusal,
} from "./planner/shared.js";
export * from "./planner/normalize.js";
export type { NormalizedAction, PlanInterpretation, PlanOptions } from "./planner/types.js";
export { configureGasReserveReader } from "./planner/gasReserve.js";
export type { GasReserveFacts, GasReserveReader } from "./planner/gasReserve.js";
export { contractPhrases, summarize } from "./planner/build.js";
export * from "./planner/planIntent.js";
export * from "./planner/stepActions.js";
