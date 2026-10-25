/**
 * Base lending markets: live snapshots of Aave, Moonwell, Compound and
 * ERC-4626 markets, verified lending routes and opportunities. The modules
 * live in ./markets/.
 */
export type { BaseLendingOpportunity } from "./markets/snapshots.js";
export * from "./markets/routes.js";
