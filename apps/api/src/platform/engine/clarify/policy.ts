/**
 * The sensitivity policy (rules R0-R14): for every step of a thread it
 * decides, slot by slot, whether to ask, assume (a chip) or refuse, using
 * only the wallet facts read for this turn. Purpose slots (who receives,
 * where it arrives, what to receive or spend, how much, the network a
 * transfer lands on) are asked; means slots (where a swap or deposit runs,
 * which vault, which staking provider) are assumed and shown.
 *
 * Pure and synchronous over (state, context, facts): it mutates only
 * `assumed` slots of the state it is given (so a kept assumption stays put
 * on later turns, R0) and throws PlatformError for what no question can fix.
 *
 * The modules live in ./policy/.
 */
export { EXACT_DELIVERY_PLANNED } from "../solver/moves.js";
export { crossingSymbols } from "./policy/networks.js";
export { contractClause } from "./policy/venues.js";
export type { PlacedAction, PolicyAnalysis } from "./policy/acks.js";
export * from "./policy/analyze.js";
