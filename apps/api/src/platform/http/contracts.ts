/**
 * Contract registrations ("bring your own contract"): integrators
 * register their own EVM contracts (ABI actions) and Solana Actions
 * endpoints (program allowlists) under their API key, and intents created
 * with that key can call them.
 *
 * This module holds the store (memory, or Postgres `kletia_contracts`,
 * `kletia_contract_revisions` and `kletia_contract_spend` when
 * KLETIA_DATABASE_URL is set), the registration pipeline, the handlers of
 * /v1/contracts, the contract webhook events, and the engine's
 * `ContractDirectory` (installed by the router like the name resolvers).
 *
 * Fund safety rules enforced here (the engine enforces the per-step ones):
 * - The definition is validated statically by @kletia/core
 *   (`validateContractDefinition`): forbidden functions, argument and event
 *   bindings, reserved names and aliases, deny lists. The normalised
 *   definition is what is stored and hashed.
 * - On-chain identity is pinned at registration (code hash, proxy
 *   implementation; Solana program data, deploy slot, upgrade authority);
 *   not-deployed targets, EIP-7702 delegated accounts and proxies that cannot
 *   be pinned (or that Sourcify resolves differently) are refused.
 * - Mainnet registrations and security-relevant revisions activate only after
 *   KLETIA_CONTRACT_ACTIVATION_DELAY_SECONDS (default 900) and announce
 *   themselves with `contract.registered`; integrator names that use a
 *   reserved brand also wait for domain verification.
 * - A registration is usable only by its owning key, or by keys of the same
 *   project when `visibility: "project"`; foreign and unknown ids are
 *   indistinguishable (404 CONTRACT_NOT_FOUND here, CONTRACT_UNKNOWN when
 *   planning). The calling key, the registration owner and their ancestors
 *   must remain live (unrevoked, unexpired, in the registration's project);
 *   the directory reads them fresh again at plan and at prepare.
 * - Any anomaly the engine reports (pins changed, outcome mismatch, program
 *   changed) suspends the registration until the integrator re-verifies; an
 *   operator suspension can only be lifted by an operator.
 * - Kill switch KLETIA_CONTRACTS_ENABLED=false: registration, tests, planning
 *   and preparing return 503 CONTRACTS_DISABLED; verification of submitted
 *   steps continues.
 *
 * The modules live in ./contracts/.
 */
export { configureContractClock, contractNow, subscribeContractEvents } from "./contracts/events.js";
export type { ContractEvent } from "./contracts/events.js";
export { assertContractsEnabled, definitionHashOf } from "./contracts/records.js";
export type {
  ContractEntry,
  ContractRecord,
  ContractRevision,
  ContractStore,
  RevisionSummary,
  StoredContractStatus,
} from "./contracts/records.js";
export * from "./contracts/memoryStore.js";
export * from "./contracts/postgresStore.js";
export {
  activateDueContracts,
  contractStore,
  contractStoreKind,
  keyContext,
  suspendContract,
} from "./contracts/lifecycle.js";
export { validateDefinition } from "./contracts/validation.js";
export * from "./contracts/handlers.js";
export * from "./contracts/inspect.js";
export * from "./contracts/directory.js";
export * from "./contracts/watch.js";
