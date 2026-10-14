/**
 * Rule Book engine: the gate interface the service calls, the
 * conservative USD oracle, facts, refusals, execution helpers, the
 * storage ports with memory implementations, the reference gate, and the
 * headroom of a key's chain (`policyHeadroom`).
 */
import type { PolicyDocument } from "@kletia/core";
import type { PolicyChainSource as HeadroomChains, SpendLedger as HeadroomLedger } from "./ports.js";

export {
  configurePolicyGate,
  NO_POLICY_GATE,
  policyGate,
  policyGateActive,
  type ExposureHandle,
  type PayloadClearanceInput,
  type PayloadExposure,
  type PlanGuard,
  type PolicyGate,
  type VerificationReconcileInput,
} from "./gate.js";
export {
  configurePolicyPricing,
  notionalUsdMicros,
  policyPrice,
  policyPrices,
  PRICE_SCALE,
  quoteUsdNumber,
  readPriceSource,
  resetPolicyPricing,
  toUsd18,
  usd18FromNumber,
  type PolicyPricingTransport,
  type PriceQuote,
  type PriceReading,
} from "./pricing.js";
export {
  ASSET_PRICE_SOURCES,
  CHAINLINK_FEEDS,
  CHAINLINK_GRACE_SECONDS,
  JUPITER_MAX_SLOT_LAG,
  JUPITER_MIN_LIQUIDITY_USD,
  JUPITER_MINTS,
  listedAsset,
  priceSourcesFor,
  type ChainlinkFeed,
  type JupiterFeed,
  type PriceSource,
} from "./feeds.js";
export {
  policyFactsDetailed,
  policyFactsFromGraph,
  policyNeedsPricing,
  stepExposureUsdMicros,
  type DetailedFacts,
  type FactsOptions,
} from "./facts.js";
export { policyError, policyErrorDetails, policyRefusalMessage, type PolicyApprovalReference, type PolicyErrorDetails, type PolicyRefusalCode } from "./errors.js";
export { configurePolicyReads, exclusiveKeyNonce, payloadExposure, pinNonces, solanaBlockHeight, type PolicyChainReads } from "./execution.js";
export { publishPolicyEvent, subscribePolicyEvents, type PolicyEvent } from "./events.js";
export type {
  ApproverRequirement,
  ExposureRecord,
  ExposureState,
  PolicyApprovalRecord,
  PolicyApprovalStore,
  PolicyChainLevel,
  PolicyChainSnapshot,
  PolicyChainSource,
  PolicyDecisionDraft,
  PolicyDecisionLog,
  ScopeCap,
  ScopeUsage,
  SpendLedger,
  SpendReservation,
  SpendReservationResult,
} from "./ports.js";
export {
  DAY_MS,
  MemoryApprovalStore,
  MemoryDecisionLog,
  MemorySpendLedger,
  ProjectLocks,
  WEEK_MS,
  windowRetryAt,
  windowUsage,
  type ExposureGroup,
  type MemorySpendLedgerOptions,
} from "./memory.js";
export {
  chainGoverns,
  createRuleBookGate,
  newApprovalId,
  newDecisionId,
  type PolicySimulation,
  type PolicySimulationInput,
  type RuleBookGate,
  type RuleBookGateOptions,
} from "./ruleBookGate.js";

/* ------------------------------------------------------------ headroom */

/** Rolling 24 h / 7 d remainder of one capped scope of a key's chain. */
export interface ScopeHeadroom {
  readonly scope: string;
  readonly dailyRemainingUsd: string | null;
  readonly weeklyRemainingUsd: string | null;
}

/**
 * What a key may still move under its Rule Book chain (journey facts R6, MCP
 * `get_policy`): per scope remainders, and the tightest of them with the
 * tightest per-step and per-intent caps and the owner's schedule.
 */
export interface PolicyHeadroom {
  readonly scopes: readonly ScopeHeadroom[];
  readonly perStepUsd: string | null;
  readonly perIntentUsd: string | null;
  readonly dailyRemainingUsd: string | null;
  readonly weeklyRemainingUsd: string | null;
  /** The innermost rule book's schedule (null: always open). */
  readonly schedule: PolicyDocument["schedule"] | null;
}

/** Where the chain and the spend usage come from (installed by the HTTP layer with its stores). */
export interface PolicyHeadroomSources {
  readonly chains: HeadroomChains;
  readonly ledger: () => Pick<HeadroomLedger, "usage">;
}

let headroomSources: PolicyHeadroomSources | null = null;

/** Installs the chain and ledger reads `policyHeadroom` uses; null removes them (no headroom known). */
export function configurePolicyHeadroom(sources: PolicyHeadroomSources | null): void {
  headroomSources = sources;
}

function usdText(micros: bigint): string {
  return `${micros / 1_000_000n}.${((micros % 1_000_000n) / 10_000n).toString().padStart(2, "0")}`;
}

function capMicros(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function tightest(values: readonly (string | undefined)[]): string | null {
  let best: bigint | null = null;
  for (const value of values) {
    if (value === undefined) continue;
    const micros = capMicros(value);
    if (best === null || micros < best) best = micros;
  }
  return best === null ? null : usdText(best);
}

/**
 * Headroom of `keyId`'s chain: rolling 24 h / 7 d remainders of every capped
 * scope (usage from the spend ledger), plus the tightest caps. Null when the
 * key is unknown or no sources are installed. Throws when a store cannot be
 * read (callers treat the fact as unknown).
 */
export async function policyHeadroom(keyId: string, sources: PolicyHeadroomSources | null = headroomSources): Promise<PolicyHeadroom | null> {
  if (!sources) return null;
  const chain = await sources.chains.chain(keyId);
  if (!chain) return null;
  const capped = chain.levels.filter((level) => level.policy?.caps?.dailyUsd !== undefined || level.policy?.caps?.weeklyUsd !== undefined);
  const usage = capped.length > 0 ? await sources.ledger().usage(capped.map((level) => level.id), Date.now()) : new Map();
  const scopes: ScopeHeadroom[] = capped.map((level) => {
    const used = usage.get(level.id) ?? { dayUsdMicros: 0n, weekUsdMicros: 0n };
    const caps = level.policy?.caps ?? {};
    const left = (cap: string | undefined, spent: bigint) => (cap === undefined ? null : usdText(capMicros(cap) > spent ? capMicros(cap) - spent : 0n));
    return { scope: level.id, dailyRemainingUsd: left(caps.dailyUsd, used.dayUsdMicros), weeklyRemainingUsd: left(caps.weeklyUsd, used.weekUsdMicros) };
  });
  const policies = chain.levels.map((level) => level.policy).filter((policy): policy is PolicyDocument => policy !== null);
  const schedule = [...policies].reverse().find((policy) => policy.schedule)?.schedule ?? null;
  return {
    scopes,
    perStepUsd: tightest(policies.map((policy) => policy.caps?.perStepUsd)),
    perIntentUsd: tightest(policies.map((policy) => policy.caps?.perIntentUsd)),
    dailyRemainingUsd: tightest(scopes.map((scope) => scope.dailyRemainingUsd ?? undefined)),
    weeklyRemainingUsd: tightest(scopes.map((scope) => scope.weeklyRemainingUsd ?? undefined)),
    schedule,
  };
}
