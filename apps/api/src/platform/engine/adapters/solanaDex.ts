/**
 * Named Solana venues (protocols design 3.11): swaps on one owner-checked
 * Raydium, Orca or Meteora pool, routed through the Jupiter program and
 * served only when the request names the venue (`explicitOnly`).
 * Placeholders: the solana-venues package replaces `null` with the adapters;
 * the registry skips them until then.
 */
import type { ProtocolAdapter } from "./types.js";

export const raydiumAdapter: ProtocolAdapter | null = null;
export const orcaAdapter: ProtocolAdapter | null = null;
export const meteoraAdapter: ProtocolAdapter | null = null;
