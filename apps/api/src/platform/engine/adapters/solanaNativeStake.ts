/**
 * Native SOL staking to a validator from a seed-derived stake account (protocols design 3.4).
 *
 * Adapter slot (protocols design 3.0, P0): the module and its place in
 * ADAPTERS exist so the venue package (P5) wires the adapter without touching
 * the registry. Until then it exports `null`, which the registry skips: the
 * protocol stays listed (GET /v1/protocols reports it as not executable) and
 * the planner refuses steps naming it.
 */
import type { ProtocolAdapter } from "./types.js";

export const solanaNativeStakeAdapter: ProtocolAdapter | null = null;
