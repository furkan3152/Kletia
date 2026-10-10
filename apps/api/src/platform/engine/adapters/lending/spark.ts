/** SparkLend's canonical Ethereum pool, supplied and withdrawn without custody. */
import { createPoolLendingAdapter, aaveMetrics } from "../aaveV3.js";

export const sparkAdapter = createPoolLendingAdapter("spark", "SparkLend");
export const sparkMetrics = aaveMetrics;
