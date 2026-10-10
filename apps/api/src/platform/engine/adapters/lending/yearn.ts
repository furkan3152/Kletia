/** Curated Yearn V3 vaults; no runtime address registration or main-app BYOC. */
import { createErc4626Adapter, erc4626Metrics } from "./erc4626.js";

export const yearnAdapter = createErc4626Adapter("yearn-v3", "Yearn V3");
export const yearnMetrics = erc4626Metrics;
