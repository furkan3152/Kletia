/**
 * SparkLend supply and withdraw on the pinned Ethereum reserves (Aave V3
 * fork, protocols design 3.9). The Aave-family adapter runs it under its
 * own protocol id: SparkLend venues only, SparkLend titles and Pool proofs,
 * and the pinned PoolAddressesProvider must report the venue's Pool and data
 * provider. The Pool (revision 4) has no getVirtualUnderlyingBalance, so
 * exit liquidity is the aToken's underlying cash.
 */
import { aaveMetrics, createAaveFamilyAdapter } from "../aaveV3.js";
import type { ProtocolAdapter } from "../types.js";

export const sparklendAdapter: ProtocolAdapter | null = createAaveFamilyAdapter("sparklend", "SparkLend");
export const sparklendMetrics = aaveMetrics;
