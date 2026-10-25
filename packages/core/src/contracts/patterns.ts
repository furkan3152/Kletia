/**
 * Identifier patterns, registration limits and the review notices.
 */

/* ================================================================ identifiers */

/** Contract registration ids: `ct_` + 24 lower-case hex. */
export const CONTRACT_ID_PATTERN = /^ct_[0-9a-f]{24}$/u;
/** Session ids: `cs_` + 32 lower-case hex (128-bit capabilities). */
export const SESSION_ID_PATTERN = /^cs_[0-9a-f]{32}$/u;
/** Entry (action) ids inside one registration, e.g. `deposit`. */
export const CONTRACT_ENTRY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/u;
/** Natural-language aliases (`acme vault`). */
export const CONTRACT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9 .-]{1,39}$/u;
/** Natural-language verbs (`deposit`, `stake`). */
export const CONTRACT_VERB_PATTERN = /^[a-z]{2,16}$/u;
/** Labels of extra pinned addresses (`vault`, `router-v2`). */
export const CONTRACT_ADDRESS_LABEL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
/** User parameter names (`lockDays`). */
export const CONTRACT_PARAM_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/u;
/** `IntentActionSpec.contract`: a registration id or an alias (any case; the planner lower-cases it). */
export const CONTRACT_REFERENCE_PATTERN = /^(?:ct_[0-9a-f]{24}|[A-Za-z0-9][A-Za-z0-9 .-]{1,63})$/u;

export function isContractId(value: unknown): value is string {
  return typeof value === "string" && CONTRACT_ID_PATTERN.test(value);
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/* ===================================================================== limits */

/**
 * Limits of the BYOC surface. Values prefixed `default` are defaults of
 * operator settings (environment variables in the API).
 */
export const CONTRACT_LIMITS = Object.freeze({
  /** Registrations (not deleted) one API key may hold. */
  registrationsPerKey: 25,
  actionsPerRegistration: 10,
  abiItems: 40,
  /** Canonical JSON of a normalised definition, in UTF-8 bytes. */
  definitionBytes: 49_152,
  eventsPerAction: 3,
  paramsPerAction: 6,
  aliasesPerAction: 4,
  verbsPerAction: 4,
  /** Extra pinned EVM addresses (approval spenders, event emitters). */
  extraAddresses: 4,
  /** Allowlisted Solana programs. */
  programs: 6,
  payees: 2,
  /** Elements of a literal array argument. */
  arrayElements: 8,
  /** Inputs of one ABI item, and components of one tuple. */
  abiParameters: 32,
  /** Tuple nesting depth inside one ABI parameter. */
  abiNesting: 4,
  stringLiteralLength: 64,
  labelLength: 80,
  hrefLength: 512,
  /** `IntentActionSpec.contract` length. */
  referenceLength: 64,
  maxToleranceBps: 100,
  defaultToleranceBps: 10,
  /** Registrations, PATCH and reverify calls per key per hour. */
  registrationsPerHour: 20,
  /** `test` and `inspect` calls per key per minute (on top of the tier limit). */
  testsPerMinute: 20,
  activeSessionsPerKey: 1_000,
  sessionMinTtlSeconds: 60,
  sessionMaxTtlSeconds: 3_600,
  sessionDefaultTtlSeconds: 900,
  sessionMaxIntents: 100,
  sessionAllowedOrigins: 10,
  /** KLETIA_CONTRACT_STEP_MAX_USD. */
  defaultStepMaxUsd: 10_000,
  /** KLETIA_CONTRACT_UNVERIFIED_STEP_MAX_USD (integrator domain not verified). */
  defaultUnverifiedStepMaxUsd: 1_000,
  /** KLETIA_CONTRACT_KEY_DAILY_MAX_USD (priced notional counted at prepare). */
  defaultKeyDailyMaxUsd: 100_000,
  /** KLETIA_CONTRACT_ACTIVATION_DELAY_SECONDS (mainnet; testnets activate at once). */
  defaultActivationDelaySeconds: 900,
  /** `$deadline` = payload `expiresAt` + this many seconds. */
  deadlineSecondsAfterExpiry: 900,
  /** Simulated gas → transaction gas: `gasUsed × 1.25 + 25,000`. */
  gasMultiplierBps: 12_500,
  gasOverhead: 25_000,
  actionResponseBytes: 65_536,
  actionTimeoutMs: 8_000,
  /** `/.well-known/kletia.json` body cap. */
  domainFileBytes: 16_384,
  solanaMaxTransactionBytes: 1_232,
  solanaMaxComputeUnits: 1_400_000,
  /** Compute-unit limit × price cap (0.005 SOL). */
  solanaMaxPriorityFeeLamports: 5_000_000,
  solanaMaxHeapBytes: 262_144,
});

/** First notice of every ContractReview. */
export const CONTRACT_REVIEW_NOTICE =
  "Not audited by Kletia. Kletia checked the contract's code identity and simulated this transaction; it did not review the contract's logic.";

/** Intent warning added when a plan contains call or action steps. */
export const CUSTOM_CONTRACT_WARNING = "Custom contract steps run integrator code that Kletia has not audited.";

/** Domain verification file, served by the integrator's website. */
export const KLETIA_WELL_KNOWN_PATH = "/.well-known/kletia.json";
