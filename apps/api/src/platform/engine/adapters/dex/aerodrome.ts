/**
 * Aerodrome (Base) and Velodrome (OP Mainnet) Slipstream swaps (protocols
 * design 3.3): one module, two sets of pins from DEX_DEPLOYMENTS. Every
 * pinned factory (Aerodrome has three) and tick spacing is quoted by that
 * deployment's own QuoterV2; the best pool wins and its deployment is
 * recorded, so prepare calls only that deployment's SwapRouter (and approves
 * only it). Pools are accepted only when a pinned factory returns them;
 * classic (solidly) pools and gauge contracts are never used.
 */
import type { ProtocolAdapter } from "../types.js";
import { createConcentratedAdapter } from "./concentrated.js";

export const aerodromeAdapter: ProtocolAdapter | null = createConcentratedAdapter({ id: "aerodrome", label: "Aerodrome" });
export const velodromeAdapter: ProtocolAdapter | null = createConcentratedAdapter({ id: "velodrome", label: "Velodrome" });
