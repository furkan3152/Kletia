/**
 * Frax Ether sfrxETH staking on Ethereum (protocols design 3.3).
 *
 * Adapter slot (protocols design 3.0, P0): the module and its place in
 * ADAPTERS exist so the venue package (P4) wires the adapter without touching
 * the registry. Until then it exports `null`, which the registry skips: the
 * protocol stays listed (GET /v1/protocols reports it as not executable) and
 * the planner refuses steps naming it.
 */
import type { ProtocolAdapter } from "../types.js";

export const fraxAdapter: ProtocolAdapter | null = null;
