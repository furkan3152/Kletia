/**
 * SPL stake pool deposits: Jito (JitoSOL) and Sanctum SPL pools (JupSOL) (protocols design 3.4).
 *
 * Adapter slot (protocols design 3.0, P0): the module and its place in
 * ADAPTERS exist so the venue package (P5) wires the adapter without touching
 * the registry. Until then it exports `null`, which the registry skips: the
 * protocol stays listed (GET /v1/protocols reports it as not executable) and
 * stake steps naming it keep running through Jupiter routes as before.
 */
import type { ProtocolAdapter } from "./types.js";

export const jitoStakePoolAdapter: ProtocolAdapter | null = null;
export const sanctumStakePoolAdapter: ProtocolAdapter | null = null;
