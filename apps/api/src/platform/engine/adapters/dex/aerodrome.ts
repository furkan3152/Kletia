/**
 * Aerodrome (Base) and Velodrome (OP Mainnet) Slipstream swaps: one module,
 * design 3.3): one module, two sets of pins from DEX_DEPLOYMENTS; pools
 * accepted only when a pinned factory returns them. Placeholders: the
 * evm-swaps-and-feeds package replaces `null` with the adapters; the registry
 * skips them until then.
 */
import type { ProtocolAdapter } from "../types.js";

export const aerodromeAdapter: ProtocolAdapter | null = null;
export const velodromeAdapter: ProtocolAdapter | null = null;
