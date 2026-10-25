/**
 * Bring your own contract (BYOC): the specification an integrator registers
 * to plug its own EVM contract (ABI actions) or Solana program (through a
 * Solana Actions endpoint) into Kletia intents.
 *
 * Fund safety rules this module encodes, so the API, the SDK, the CLI and the
 * developer portal report identical issues before anything touches a network:
 *
 * - Kletia never builds arbitrary calldata. Every argument of a registered
 *   function is bound to a declared source (`$amount`, `$account`, ...) or a
 *   literal fixed at registration, and the engine encodes the call itself.
 * - Approvals, permits, transfers, ownership, upgrades, multicall and execute
 *   functions are refused by selector and by name, whatever the ABI claims.
 * - `bytes` arguments only accept the empty literal `0x`; `bytes[]` and
 *   `function` arguments are refused, so no calldata can be smuggled.
 * - Receiver-like address arguments must bind to the user (`$account` or
 *   `$recipient`), so a deposit can never be credited to the integrator.
 * - Tokens, routers, Permit2, Multicall3, precompiles and system contracts can
 *   never be a target (`deniedTargetReason`).
 *
 * On-chain checks (code-hash and proxy pins, simulation, verification of
 * landed transactions) live in the API engine; this module only holds the
 * static rules and the shared types.
 *
 * The modules live in ./contracts/.
 */
export * from "./contracts/patterns.js";
export * from "./contracts/types.js";
export * from "./contracts/reviewTypes.js";
export {
  BENEFICIARY_ARG_PATTERN,
  FORBIDDEN_FUNCTION_NAMES,
  FORBIDDEN_NAME_PREFIXES,
  FORBIDDEN_SELECTORS,
  eventTopic,
  forbiddenFunctionReason,
  functionSelector,
  isBeneficiaryArgName,
} from "./contracts/forbidden.js";
export type { ForbiddenSelector } from "./contracts/forbidden.js";
export {
  APPROVAL_RESET_TOKENS,
  RESERVED_CONTRACT_PHRASES,
  RESERVED_INTEGRATOR_NAMES,
  hostMatches,
  needsApprovalReset,
  reservedContractPhrase,
  reservedIntegratorName,
} from "./contracts/reserved.js";
export { SOLANA_ACTION_BUILTIN_PROGRAMS, deniedTargetReason } from "./contracts/targets.js";
export {
  abiItemDisplaySignature,
  abiItemSignature,
  bindingReviewSource,
  canonicalAbiType,
  classifyAbiFunction,
} from "./contracts/abi.js";
export {
  domainFileListsContract,
  domainFileListsLink,
  domainFileListsProject,
  normalizeWebOrigin,
  resolveContractAsset,
} from "./contracts/origins.js";
export { CONTRACT_ISSUE_PRECEDENCE, primaryContractIssueCode } from "./contracts/issues.js";
export type {
  ContractIssueCode,
  ContractValidationIssue,
  ContractValidationOptions,
  ContractValidationResult,
} from "./contracts/issues.js";
export * from "./contracts/definitions.js";
