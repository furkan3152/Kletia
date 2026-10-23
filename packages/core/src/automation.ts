/**
 * Automations: rules that watch a condition and, when it holds, plan an
 * intent for the owner to sign (Kletia never signs). A run either waits in
 * the owner's inbox for a wallet signature, or is handed to a protocol-native
 * order provider that executes it without the owner online.
 *
 * Shared by the API (store, evaluator, routes), the SDK and the desk. Every
 * trigger is evaluated in UTC: schedules step a fixed number of hours, days or
 * weeks (or calendar months) from `startAt`, so daylight saving never moves a
 * run. A time zone is kept for display only; `planAutomationFromGoal` uses it
 * once to turn "every Monday at 09:00" into a UTC start.
 *
 * Price and balance triggers fire on a crossing, with hysteresis: after a
 * firing the trigger is disarmed until the value moves back past the
 * threshold by `hysteresisBps`, so a price hovering at the line fires once.
 * The first observation only arms (a condition already true at creation does
 * not fire until it is crossed again).
 */
import { isDecimalAmount } from "./amounts.js";
import { findAssetBySymbol } from "./assets.js";
import { parseAccountId, type AccountId } from "./caip.js";
import { isNetworkKey, type NetworkKey } from "./chains.js";
import type { IntentActionSpec, IntentConstraints, IntentGraph, IntentRequest, SourceNetwork } from "./intent.js";
import { WEEKDAYS, type Weekday } from "./policy.js";
import { getProtocol, type ProtocolId } from "./protocols.js";
import { validateIntentRequest, type ValidationIssue, type ValidationResult } from "./validation.js";

export const AUTOMATION_ID_PATTERN = /^au_[0-9a-f]{24}$/u;
export const AUTOMATION_RUN_ID_PATTERN = /^ar_[0-9a-f]{24}$/u;

export const AUTOMATION_LIMITS = Object.freeze({
  /** Live (active or paused) rules per owner. */
  perOwner: 50,
  creationsPerHour: 30,
  /** Largest `every.count`. */
  maxEvery: 366,
  maxRuns: 1_000,
  defaultHysteresisBps: 100,
  minHysteresisBps: 10,
  maxHysteresisBps: 5_000,
  maxCooldownSeconds: 30 * 86_400,
  /** Rules expire at most this long after creation (default: 180 days). */
  maxLifetimeDays: 366,
  defaultLifetimeDays: 180,
  maxLabel: 80,
  /** The evaluator's pass interval. */
  evaluateEveryMs: 60_000,
  /** Runs listed per request; inbox entries kept visible. */
  runsListed: 100,
  inboxDays: 7,
});

/* ==================================================================== types */

/** A project's API key, or a wallet signed in with SIWE / SIWS (desk users). */
export type AutomationOwner =
  | { readonly kind: "key"; readonly keyId: string; readonly projectId: string | null }
  | { readonly kind: "wallet"; readonly walletKind: "evm" | "solana"; readonly address: string };

export type ScheduleUnit = "hour" | "day" | "week" | "month";
export type CrossingDirection = "above" | "below";

export interface ScheduleTrigger {
  readonly kind: "schedule";
  readonly every: { readonly unit: ScheduleUnit; readonly count: number };
  /** First run, ISO UTC. */
  readonly startAt: string;
  /** No run after this instant (ISO UTC). */
  readonly endAt?: string;
  readonly maxRuns?: number;
  /** IANA zone the owner thinks in (display only; runs never shift with daylight saving). */
  readonly timezone?: string;
}

export interface PriceTrigger {
  readonly kind: "price";
  /** Asset symbol on `network` (priced by the oracles the Rule Book uses: Chainlink, Pyth, Jupiter). */
  readonly asset: string;
  readonly network: NetworkKey;
  readonly direction: CrossingDirection;
  /** USD per whole token, decimal string. */
  readonly priceUsd: string;
  readonly hysteresisBps?: number;
}

export interface BalanceTrigger {
  readonly kind: "balance";
  /** CAIP-10 account; the network is the account's. */
  readonly account: AccountId;
  readonly asset: string;
  readonly direction: CrossingDirection;
  /** Whole tokens, decimal string. */
  readonly amount: string;
  readonly hysteresisBps?: number;
}

export interface ApyTrigger {
  readonly kind: "apy";
  /** Underlying symbol, e.g. USDC. */
  readonly asset: string;
  /** Networks whose venues compete (one network: no bridge in the rebalance). */
  readonly networks: readonly NetworkKey[];
  /** Fire when the best venue beats the current one by at least this much. */
  readonly minDeltaBps: number;
  /** The venue the money is in now (YIELD_VENUES id); absent: not deposited yet. */
  readonly current?: string;
}

/** An incoming transfer, observed as a balance increase between two reads. */
export interface EventTrigger {
  readonly kind: "event";
  readonly account: AccountId;
  readonly asset: string;
  /** Smallest increase that counts (whole tokens); default any. */
  readonly minAmount?: string;
}

export type AutomationTrigger = ScheduleTrigger | PriceTrigger | BalanceTrigger | ApyTrigger | EventTrigger;
export type AutomationTriggerKind = AutomationTrigger["kind"];
export const AUTOMATION_TRIGGER_KINDS: readonly AutomationTriggerKind[] = Object.freeze(["schedule", "price", "balance", "apy", "event"]);

/** The intent a run plans: a sentence or structured actions, with the accounts it spends from. */
export interface AutomationIntentAction {
  readonly kind: "intent";
  readonly text?: string;
  readonly actions?: readonly IntentActionSpec[];
  readonly accounts: readonly AccountId[];
  readonly sourceNetwork?: SourceNetwork;
  readonly constraints?: IntentConstraints;
}

/** `apy` triggers only: move the position to the best venue (or deposit `amount` when none exists yet). */
export interface AutomationRebalanceAction {
  readonly kind: "rebalance";
  readonly accounts: readonly AccountId[];
  readonly amount?: string;
}

export type AutomationAction = AutomationIntentAction | AutomationRebalanceAction;

export interface AutomationLimits {
  /** USD per run (oracle-priced inputs; an unpriced input skips the run). */
  readonly maxUsdPerRun?: string;
  /** USD across all runs of the rule. */
  readonly maxUsdTotal?: string;
  /** ISO UTC; filled at creation (default 180 days). */
  readonly expiresAt?: string;
  /** Least time between two runs. */
  readonly cooldownSeconds?: number;
  readonly networks?: readonly NetworkKey[];
  readonly protocols?: readonly ProtocolId[];
  /** Caps the plan's slippage per swap step. */
  readonly maxSlippageBps?: number;
}

/** What a client sends to create a rule. */
export interface AutomationDraft {
  readonly label?: string;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly limits?: AutomationLimits;
}

export type AutomationStatus = "active" | "paused" | "completed" | "expired";

/** Evaluator memory of a rule (server-written). */
export interface AutomationState {
  /** Crossing triggers: armed for the next crossing; absent before the first observation. */
  readonly armed?: boolean;
  /** Firings so far of a crossing, event or apy trigger: the idempotency window. */
  readonly epoch: number;
  /** Last observed value (price, balance, APY in bps). */
  readonly lastValue?: string;
  readonly observedAt?: string;
  /** Schedules: the last slot that fired (ISO). */
  readonly lastSlot?: string;
  /** Apy: the venue the last rebalance moved to. */
  readonly venue?: string;
}

/** How a fired run is executed: the owner signs, or a native order provider executes it. */
export type AutomationExecution = { readonly mode: "signature" } | { readonly mode: "native"; readonly provider: string };

export interface AutomationView {
  readonly id: string;
  readonly label: string | null;
  readonly owner: AutomationOwner;
  readonly trigger: AutomationTrigger;
  readonly action: AutomationAction;
  readonly limits: AutomationLimits & { readonly expiresAt: string };
  readonly status: AutomationStatus;
  /** Why it ended or paused itself (`max_runs`, `ended`, `expired`, `key_revoked`). */
  readonly statusReason: string | null;
  readonly state: AutomationState;
  readonly execution: AutomationExecution;
  readonly runs: number;
  readonly spentUsd: string;
  readonly lastRunAt: string | null;
  /** Schedules: the next slot; null otherwise or when none is left. */
  readonly nextRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AutomationRunStatus = "firing" | "prepared" | "needs_signature" | "skipped" | "failed";

export type AutomationSkipReason =
  | "cooldown"
  | "over_run_limit"
  | "over_total_limit"
  | "unpriced"
  | "network_not_allowed"
  | "protocol_not_allowed";

export interface AutomationRunView {
  readonly id: string;
  readonly automationId: string;
  /** Idempotency window: one run per window, ever. */
  readonly window: string;
  readonly status: AutomationRunStatus;
  /** Skip reason or failure code. */
  readonly reason: string | null;
  readonly message: string | null;
  /** What fired it: the slot, the observed value. */
  readonly observed: string | null;
  readonly intentId: string | null;
  readonly title: string | null;
  readonly notionalUsd: string | null;
  /** Native order provider that took the run, and its reference. */
  readonly provider: { readonly id: string; readonly reference: string } | null;
  readonly firedAt: string;
  readonly updatedAt: string;
}

export interface AutomationEventData {
  readonly automationId: string;
  /** Webhooks route by it (automations of wallet owners have no webhooks: their inbox only). */
  readonly ownerKeyId: string;
  readonly runId?: string;
  readonly intentId?: string;
  readonly status?: AutomationRunStatus | AutomationStatus;
  readonly reason?: string;
}

/* ===================================================== native order providers */

export type NativeOrderOutcome =
  | { readonly accepted: true; readonly reference: string }
  | { readonly accepted: false; readonly reason: string };

/**
 * A protocol-native order type (limit or recurring orders that execute
 * without the owner online). Providers are registered by the API; a rule a
 * provider supports shows `execution.mode: "native"` and each run is offered
 * to it before falling back to the owner's signature.
 */
export interface NativeOrderProvider {
  readonly id: string;
  supports(automation: AutomationView): boolean;
  execute(input: { readonly automation: AutomationView; readonly runId: string; readonly intent: IntentGraph }): Promise<NativeOrderOutcome>;
}

/* ================================================================ schedules */

const HOUR_MS = 3_600_000;
const STEP_MS: Readonly<Record<Exclude<ScheduleUnit, "month">, number>> = { hour: HOUR_MS, day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS };

function addUtcMonths(start: Date, months: number): number {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds());
}

/** Time (Unix ms) of slot `index` (0 = startAt). Months keep the start's day, clamped to short months. */
export function scheduleSlotTime(trigger: Pick<ScheduleTrigger, "every" | "startAt">, index: number): number {
  const start = Date.parse(trigger.startAt);
  if (trigger.every.unit === "month") return addUtcMonths(new Date(start), index * trigger.every.count);
  return start + index * trigger.every.count * STEP_MS[trigger.every.unit];
}

/** The latest slot at or before `now` (index and time), or null before the start. */
export function latestScheduleSlot(trigger: Pick<ScheduleTrigger, "every" | "startAt">, now: number): { readonly index: number; readonly at: number } | null {
  const start = Date.parse(trigger.startAt);
  if (!Number.isFinite(start) || now < start) return null;
  let index: number;
  if (trigger.every.unit === "month") {
    const from = new Date(start);
    const to = new Date(now);
    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
    index = Math.floor(months / trigger.every.count);
    while (index > 0 && scheduleSlotTime(trigger, index) > now) index -= 1;
  } else {
    index = Math.floor((now - start) / (trigger.every.count * STEP_MS[trigger.every.unit]));
  }
  return { index, at: scheduleSlotTime(trigger, index) };
}

/** The first slot strictly after `after` that the schedule still allows (endAt, maxRuns given `runs` so far); null when none. */
export function nextScheduleSlot(trigger: ScheduleTrigger, after: number, runs = 0): number | null {
  if (trigger.maxRuns !== undefined && runs >= trigger.maxRuns) return null;
  const latest = latestScheduleSlot(trigger, after);
  const next = latest === null ? Date.parse(trigger.startAt) : scheduleSlotTime(trigger, latest.index + 1);
  if (trigger.endAt !== undefined && next > Date.parse(trigger.endAt)) return null;
  return next;
}

/* ================================================================= triggers */

export interface TriggerVerdict {
  readonly fire: boolean;
  readonly state: AutomationState;
  /** One run per window (set when `fire`). */
  readonly window?: string;
  /** What fired it, for the run record. */
  readonly observed?: string;
}

/** A schedule fires once for the latest due slot (missed slots are not caught up). */
export function evaluateSchedule(trigger: ScheduleTrigger, state: AutomationState, now: number): TriggerVerdict {
  const slot = latestScheduleSlot(trigger, now);
  if (!slot) return { fire: false, state };
  if (trigger.endAt !== undefined && slot.at > Date.parse(trigger.endAt)) return { fire: false, state };
  const at = new Date(slot.at).toISOString();
  if (state.lastSlot !== undefined && state.lastSlot >= at) return { fire: false, state };
  return { fire: true, state: { ...state, lastSlot: at }, window: `slot:${at}`, observed: at };
}

/**
 * A crossing with hysteresis. `below`: fires when the value falls to the
 * threshold while armed; re-arms once it climbs back above threshold × (1 +
 * hysteresis). `above` mirrors it. The first observation only arms.
 */
export function evaluateCrossing(
  trigger: { readonly direction: CrossingDirection; readonly hysteresisBps?: number },
  threshold: number,
  state: AutomationState,
  value: number,
  observedAt: string,
): TriggerVerdict {
  const band = (trigger.hysteresisBps ?? AUTOMATION_LIMITS.defaultHysteresisBps) / 10_000;
  const below = trigger.direction === "below";
  const holds = below ? value <= threshold : value >= threshold;
  const rearms = below ? value >= threshold * (1 + band) : value <= threshold * (1 - band);
  const seen = { ...state, lastValue: String(value), observedAt };
  if (state.armed === undefined) return { fire: false, state: { ...seen, armed: !holds } };
  if (state.armed && holds) {
    const epoch = state.epoch + 1;
    return { fire: true, state: { ...seen, armed: false, epoch }, window: `cross:${epoch}`, observed: String(value) };
  }
  if (!state.armed && rearms) return { fire: false, state: { ...seen, armed: true } };
  return { fire: false, state: seen };
}

/** An incoming transfer: the balance grew by at least `minAmount` (any increase without it) since the last read. */
export function evaluateIncoming(trigger: EventTrigger, state: AutomationState, balance: number, observedAt: string): TriggerVerdict {
  const seen = { ...state, lastValue: String(balance), observedAt };
  if (state.lastValue === undefined) return { fire: false, state: seen };
  const increase = balance - Number(state.lastValue);
  const minimum = trigger.minAmount !== undefined ? Number(trigger.minAmount) : 0;
  if (increase <= 0 || increase < minimum) return { fire: false, state: seen };
  const epoch = state.epoch + 1;
  return { fire: true, state: { ...seen, epoch }, window: `in:${epoch}`, observed: String(increase) };
}

export interface VenueRate {
  readonly venue: string;
  readonly network: NetworkKey;
  readonly apyBps: number;
}

/**
 * Best venue against the current one. Fires when there is no position yet,
 * or the best beats the current venue by `minDeltaBps`. An unreadable
 * current venue never fires (unknown is not "worse").
 */
export function evaluateApy(trigger: ApyTrigger, state: AutomationState, rates: readonly VenueRate[]): TriggerVerdict & { readonly from?: string; readonly to?: string } {
  const best = [...rates].sort((a, b) => b.apyBps - a.apyBps || a.venue.localeCompare(b.venue))[0];
  if (!best) return { fire: false, state };
  const current = state.venue ?? trigger.current;
  const seen = { ...state, lastValue: String(best.apyBps) };
  if (current === best.venue) return { fire: false, state: seen };
  if (current !== undefined) {
    const now = rates.find((rate) => rate.venue === current);
    if (!now || best.apyBps - now.apyBps < trigger.minDeltaBps) return { fire: false, state: seen };
  }
  const epoch = state.epoch + 1;
  return {
    fire: true,
    state: { ...seen, epoch, venue: best.venue },
    window: `apy:${epoch}`,
    observed: `${current ?? "none"} -> ${best.venue} (${best.apyBps} bps)`,
    ...(current !== undefined ? { from: current } : {}),
    to: best.venue,
  };
}

/* =============================================================== validation */

const IANA_ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/u;
const SYMBOL = /^[A-Za-z0-9.$-]{1,16}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoTime(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function positiveDecimal(value: unknown): value is string {
  return isDecimalAmount(value) && Number(value) > 0;
}

function intIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return IANA_ZONE.test(zone);
  } catch {
    return false;
  }
}

function account(value: unknown, path: string, issues: ValidationIssue[]): AccountId | null {
  const parsed = parseAccountId(value);
  if (!parsed) issues.push({ path, message: "Expected a CAIP-10 account id." });
  return parsed ? parsed.id : null;
}

function assetOn(network: NetworkKey | null, value: unknown, path: string, issues: ValidationIssue[]): string | null {
  if (typeof value !== "string" || !SYMBOL.test(value)) {
    issues.push({ path, message: "Expected an asset symbol such as USDC." });
    return null;
  }
  if (network && !findAssetBySymbol(network, value)) issues.push({ path, message: `${value} is not a listed asset on ${network}.` });
  return value.toUpperCase();
}

function hysteresis(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (!intIn(value, AUTOMATION_LIMITS.minHysteresisBps, AUTOMATION_LIMITS.maxHysteresisBps)) {
    issues.push({ path, message: `Between ${AUTOMATION_LIMITS.minHysteresisBps} and ${AUTOMATION_LIMITS.maxHysteresisBps} bps.` });
  }
  return value as number;
}

function direction(value: unknown, path: string, issues: ValidationIssue[]): CrossingDirection {
  if (value !== "above" && value !== "below") issues.push({ path, message: "Expected above or below." });
  return value === "above" ? "above" : "below";
}

function scheduleTrigger(input: Record<string, unknown>, issues: ValidationIssue[]): ScheduleTrigger {
  const every = isRecord(input.every) ? input.every : {};
  const unit = every.unit;
  if (unit !== "hour" && unit !== "day" && unit !== "week" && unit !== "month") issues.push({ path: "trigger.every.unit", message: "Expected hour, day, week or month." });
  if (!intIn(every.count, 1, AUTOMATION_LIMITS.maxEvery)) issues.push({ path: "trigger.every.count", message: `An integer from 1 to ${AUTOMATION_LIMITS.maxEvery}.` });
  const start = isoTime(input.startAt);
  if (start === null) issues.push({ path: "trigger.startAt", message: "Expected an ISO UTC time." });
  const end = input.endAt === undefined ? undefined : isoTime(input.endAt);
  if (end === null || (end !== undefined && start !== null && end <= start)) issues.push({ path: "trigger.endAt", message: "Expected an ISO UTC time after startAt." });
  if (input.maxRuns !== undefined && !intIn(input.maxRuns, 1, AUTOMATION_LIMITS.maxRuns)) issues.push({ path: "trigger.maxRuns", message: `An integer from 1 to ${AUTOMATION_LIMITS.maxRuns}.` });
  if (input.timezone !== undefined && (typeof input.timezone !== "string" || !knownZone(input.timezone))) issues.push({ path: "trigger.timezone", message: "Expected an IANA time zone." });
  return {
    kind: "schedule",
    every: { unit: unit as ScheduleUnit, count: every.count as number },
    startAt: start === null ? "" : new Date(start).toISOString(),
    ...(typeof end === "number" ? { endAt: new Date(end).toISOString() } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns as number } : {}),
    ...(typeof input.timezone === "string" ? { timezone: input.timezone } : {}),
  };
}

function networksOf(value: unknown, path: string, issues: ValidationIssue[]): NetworkKey[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 9 || !value.every(isNetworkKey)) {
    issues.push({ path, message: "Expected a non-empty list of network keys." });
    return [];
  }
  return [...new Set(value as NetworkKey[])];
}

function validateTrigger(input: unknown, issues: ValidationIssue[]): AutomationTrigger | null {
  if (!isRecord(input)) {
    issues.push({ path: "trigger", message: "Expected an object." });
    return null;
  }
  switch (input.kind) {
    case "schedule":
      return scheduleTrigger(input, issues);
    case "price": {
      const network = isNetworkKey(input.network) ? input.network : null;
      if (!network) issues.push({ path: "trigger.network", message: "Expected a network key." });
      if (!positiveDecimal(input.priceUsd)) issues.push({ path: "trigger.priceUsd", message: "Expected a positive decimal string." });
      const hysteresisBps = hysteresis(input.hysteresisBps, "trigger.hysteresisBps", issues);
      return {
        kind: "price",
        asset: assetOn(network, input.asset, "trigger.asset", issues) ?? "",
        network: network ?? "base",
        direction: direction(input.direction, "trigger.direction", issues),
        priceUsd: String(input.priceUsd),
        ...(hysteresisBps !== undefined ? { hysteresisBps } : {}),
      };
    }
    case "balance": {
      const owner = account(input.account, "trigger.account", issues);
      if (!positiveDecimal(input.amount) && input.amount !== "0") issues.push({ path: "trigger.amount", message: "Expected a decimal string." });
      const hysteresisBps = hysteresis(input.hysteresisBps, "trigger.hysteresisBps", issues);
      return {
        kind: "balance",
        account: owner ?? ("" as AccountId),
        asset: assetOn(owner ? parseAccountId(owner)?.chain.key ?? null : null, input.asset, "trigger.asset", issues) ?? "",
        direction: direction(input.direction, "trigger.direction", issues),
        amount: String(input.amount),
        ...(hysteresisBps !== undefined ? { hysteresisBps } : {}),
      };
    }
    case "apy": {
      const networks = networksOf(input.networks, "trigger.networks", issues);
      if (!intIn(input.minDeltaBps, 1, 10_000)) issues.push({ path: "trigger.minDeltaBps", message: "An integer from 1 to 10000." });
      if (input.current !== undefined && (typeof input.current !== "string" || input.current.length > 120)) issues.push({ path: "trigger.current", message: "Expected a venue id." });
      return {
        kind: "apy",
        asset: assetOn(null, input.asset, "trigger.asset", issues) ?? "",
        networks,
        minDeltaBps: input.minDeltaBps as number,
        ...(typeof input.current === "string" ? { current: input.current } : {}),
      };
    }
    case "event": {
      const owner = account(input.account, "trigger.account", issues);
      if (input.minAmount !== undefined && !positiveDecimal(input.minAmount)) issues.push({ path: "trigger.minAmount", message: "Expected a positive decimal string." });
      return {
        kind: "event",
        account: owner ?? ("" as AccountId),
        asset: assetOn(owner ? parseAccountId(owner)?.chain.key ?? null : null, input.asset, "trigger.asset", issues) ?? "",
        ...(typeof input.minAmount === "string" ? { minAmount: input.minAmount } : {}),
      };
    }
    default:
      issues.push({ path: "trigger.kind", message: `Expected one of ${AUTOMATION_TRIGGER_KINDS.join(", ")}.` });
      return null;
  }
}

function validateAction(input: unknown, trigger: AutomationTrigger | null, issues: ValidationIssue[]): AutomationAction | null {
  if (!isRecord(input)) {
    issues.push({ path: "action", message: "Expected an object." });
    return null;
  }
  if (input.kind === "rebalance") {
    if (trigger && trigger.kind !== "apy") issues.push({ path: "action.kind", message: "rebalance needs an apy trigger." });
    const accounts = Array.isArray(input.accounts) ? input.accounts.map((value, index) => account(value, `action.accounts[${index}]`, issues)) : [];
    if (accounts.length === 0 || accounts.length > 6) issues.push({ path: "action.accounts", message: "Give 1 to 6 CAIP-10 accounts." });
    if (input.amount !== undefined && !positiveDecimal(input.amount)) issues.push({ path: "action.amount", message: "Expected a positive decimal string." });
    if (trigger?.kind === "apy" && trigger.current === undefined && input.amount === undefined) {
      issues.push({ path: "action.amount", message: "Without a current venue, say how much to deposit." });
    }
    return { kind: "rebalance", accounts: accounts.filter((value): value is AccountId => value !== null), ...(typeof input.amount === "string" ? { amount: input.amount } : {}) };
  }
  if (input.kind !== "intent") {
    issues.push({ path: "action.kind", message: "Expected intent or rebalance." });
    return null;
  }
  if (trigger?.kind === "apy") issues.push({ path: "action.kind", message: "apy triggers take a rebalance action." });
  const { kind: _kind, ...request } = input;
  const parsed = validateIntentRequest(request);
  if (!parsed.ok) {
    for (const issue of parsed.issues) issues.push({ path: issue.path ? `action.${issue.path}` : "action", message: issue.message });
    return null;
  }
  const value = parsed.value;
  if (value.accounts.length === 0) issues.push({ path: "action.accounts", message: "Give the accounts the runs spend from." });
  if (value.metadata !== undefined || value.clientReference !== undefined) issues.push({ path: "action", message: "metadata and clientReference are set by Kletia for every run." });
  return {
    kind: "intent",
    ...(value.text !== undefined ? { text: value.text } : {}),
    ...(value.actions !== undefined ? { actions: value.actions } : {}),
    accounts: value.accounts,
    ...(value.sourceNetwork !== undefined ? { sourceNetwork: value.sourceNetwork } : {}),
    ...(value.constraints !== undefined ? { constraints: value.constraints } : {}),
  };
}

function validateLimits(input: unknown, now: number, issues: ValidationIssue[]): AutomationLimits & { readonly expiresAt: string } {
  const limits = input === undefined ? {} : isRecord(input) ? input : null;
  const fallback = new Date(now + AUTOMATION_LIMITS.defaultLifetimeDays * 86_400_000).toISOString();
  if (!limits) {
    issues.push({ path: "limits", message: "Expected an object." });
    return { expiresAt: fallback };
  }
  for (const field of ["maxUsdPerRun", "maxUsdTotal"] as const) {
    if (limits[field] !== undefined && !positiveDecimal(limits[field])) issues.push({ path: `limits.${field}`, message: "Expected a positive decimal string (USD)." });
  }
  const expires = limits.expiresAt === undefined ? Date.parse(fallback) : isoTime(limits.expiresAt);
  if (expires === null || expires <= now || expires > now + AUTOMATION_LIMITS.maxLifetimeDays * 86_400_000) {
    issues.push({ path: "limits.expiresAt", message: `An ISO UTC time within ${AUTOMATION_LIMITS.maxLifetimeDays} days.` });
  }
  if (limits.cooldownSeconds !== undefined && !intIn(limits.cooldownSeconds, 0, AUTOMATION_LIMITS.maxCooldownSeconds)) issues.push({ path: "limits.cooldownSeconds", message: "Seconds, at most 30 days." });
  const networks = limits.networks === undefined ? undefined : networksOf(limits.networks, "limits.networks", issues);
  const protocols = limits.protocols;
  if (protocols !== undefined && (!Array.isArray(protocols) || protocols.length === 0 || protocols.length > 64 || !protocols.every((id) => typeof id === "string" && getProtocol(id as ProtocolId)))) {
    issues.push({ path: "limits.protocols", message: "Expected a non-empty list of protocol ids (GET /v1/protocols)." });
  }
  if (limits.maxSlippageBps !== undefined && !intIn(limits.maxSlippageBps, 1, 5_000)) issues.push({ path: "limits.maxSlippageBps", message: "An integer from 1 to 5000." });
  return {
    ...(typeof limits.maxUsdPerRun === "string" ? { maxUsdPerRun: limits.maxUsdPerRun } : {}),
    ...(typeof limits.maxUsdTotal === "string" ? { maxUsdTotal: limits.maxUsdTotal } : {}),
    expiresAt: new Date(expires ?? Date.parse(fallback)).toISOString(),
    ...(typeof limits.cooldownSeconds === "number" ? { cooldownSeconds: limits.cooldownSeconds } : {}),
    ...(networks ? { networks } : {}),
    ...(Array.isArray(protocols) ? { protocols: [...new Set(protocols as ProtocolId[])] } : {}),
    ...(typeof limits.maxSlippageBps === "number" ? { maxSlippageBps: limits.maxSlippageBps } : {}),
  };
}

export type ValidatedAutomationDraft = Required<Pick<AutomationDraft, "trigger" | "action">> & {
  readonly label?: string;
  readonly limits: AutomationLimits & { readonly expiresAt: string };
};

/** Validates a create request (limits filled: expiresAt defaults to 180 days after `now`). */
export function validateAutomationDraft(input: unknown, now = Date.now()): ValidationResult<ValidatedAutomationDraft> {
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  const issues: ValidationIssue[] = [];
  const known = new Set(["label", "trigger", "action", "limits"]);
  for (const key of Object.keys(input)) if (!known.has(key)) issues.push({ path: key, message: "Unknown field." });
  const label = input.label;
  if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > AUTOMATION_LIMITS.maxLabel)) {
    issues.push({ path: "label", message: `Up to ${AUTOMATION_LIMITS.maxLabel} characters.` });
  }
  const trigger = validateTrigger(input.trigger, issues);
  const action = validateAction(input.action, trigger, issues);
  const limits = validateLimits(input.limits, now, issues);
  if (issues.length > 0 || !trigger || !action) return { ok: false, issues };
  return { ok: true, value: { ...(typeof label === "string" ? { label: label.trim() } : {}), trigger, action, limits } };
}

/** Validates a PATCH body: `label` and `limits` only (the trigger and action of a rule never change). */
export function validateAutomationPatch(input: unknown, now = Date.now()): ValidationResult<{ readonly label?: string | null; readonly limits?: AutomationLimits & { readonly expiresAt: string } }> {
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "Request body must be an object." }] };
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(input)) if (key !== "label" && key !== "limits") issues.push({ path: key, message: "Only label and limits change; create a new automation for another trigger or action." });
  const label = input.label;
  if (label !== undefined && label !== null && (typeof label !== "string" || !label.trim() || label.length > AUTOMATION_LIMITS.maxLabel)) {
    issues.push({ path: "label", message: `Up to ${AUTOMATION_LIMITS.maxLabel} characters, or null.` });
  }
  const limits = input.limits === undefined ? undefined : validateLimits(input.limits, now, issues);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      ...(label !== undefined ? { label: typeof label === "string" ? label.trim() : null } : {}),
      ...(limits ? { limits } : {}),
    },
  };
}

/** The intent request one run plans (the run's ids ride in metadata and clientReference). */
export function automationIntentRequest(
  action: AutomationIntentAction,
  limits: Pick<AutomationLimits, "maxSlippageBps">,
  run: { readonly automationId: string; readonly runId: string },
): IntentRequest {
  const slippage = [action.constraints?.maxSlippageBps, limits.maxSlippageBps].filter((value): value is number => value !== undefined);
  const constraints = slippage.length > 0 ? { ...action.constraints, maxSlippageBps: Math.min(...slippage) } : action.constraints;
  return {
    ...(action.text !== undefined ? { text: action.text } : {}),
    ...(action.actions !== undefined ? { actions: action.actions } : {}),
    accounts: action.accounts,
    ...(action.sourceNetwork !== undefined ? { sourceNetwork: action.sourceNetwork } : {}),
    ...(constraints ? { constraints } : {}),
    metadata: { automationId: run.automationId, automationRunId: run.runId },
    clientReference: `automation:${run.runId}`,
  };
}

/* ======================================================= sentence reader hook */

/** A typed trigger the sentence reader produces ("every Monday", "if SOL drops below 120"). */
export type AutomationGoalTrigger =
  | {
    readonly kind: "every";
    readonly unit: ScheduleUnit;
    readonly count?: number;
    /** Weekly: the day; first run on the next one. */
    readonly weekday?: Weekday;
    /** Monthly: the day of the month (1-31). */
    readonly dayOfMonth?: number;
    /** "HH:MM" in `timezone` (default 09:00 UTC). */
    readonly at?: string;
    readonly timezone?: string;
    readonly maxRuns?: number;
  }
  | { readonly kind: "price"; readonly asset: string; readonly network: NetworkKey; readonly direction: CrossingDirection; readonly priceUsd: string }
  | { readonly kind: "balance"; readonly asset: string; readonly account: AccountId; readonly direction: CrossingDirection; readonly amount: string }
  | { readonly kind: "best-yield"; readonly asset: string; readonly networks: readonly NetworkKey[]; readonly minDeltaBps?: number; readonly current?: string }
  | { readonly kind: "incoming"; readonly asset: string; readonly account: AccountId; readonly minAmount?: string };

/** The action half: the sentence to plan at every run (or structured actions), or "keep it in the best yield". */
export type AutomationGoalAction =
  | { readonly kind: "intent"; readonly text?: string; readonly actions?: readonly IntentActionSpec[] }
  | { readonly kind: "rebalance"; readonly amount?: string };

export interface AutomationGoalContext {
  readonly now: number;
  /** The owner's accounts (the runs spend from them). */
  readonly accounts: readonly AccountId[];
  readonly limits?: AutomationLimits;
  readonly label?: string;
}

/** Offset (ms) of `zone` from UTC at `time` (positive east of Greenwich). */
function zoneOffset(zone: string, time: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(time));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(time / 1000) * 1000;
}

/** The first UTC instant at or after `now` that is `at` local time in `zone` on a matching day. */
function firstStart(goal: Extract<AutomationGoalTrigger, { kind: "every" }>, now: number): string {
  const zone = goal.timezone ?? "UTC";
  const [hours, minutes] = (goal.at ?? "09:00").split(":").map(Number) as [number, number];
  const local = new Date(now + zoneOffset(zone, now));
  for (let day = 0; day < 400; day += 1) {
    const candidateLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hours, minutes);
    const candidate = candidateLocal - zoneOffset(zone, candidateLocal);
    const date = new Date(candidateLocal);
    const weekdayOk = goal.weekday === undefined || WEEKDAYS[(date.getUTCDay() + 6) % 7] === goal.weekday;
    const dayOk = goal.dayOfMonth === undefined || date.getUTCDate() === Math.min(goal.dayOfMonth, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate());
    if (candidate >= now && weekdayOk && dayOk) return new Date(candidate).toISOString();
  }
  return new Date(now).toISOString();
}

function goalTrigger(goal: AutomationGoalTrigger, now: number): unknown {
  switch (goal.kind) {
    case "every":
      return {
        kind: "schedule",
        every: { unit: goal.unit, count: goal.count ?? 1 },
        startAt: firstStart(goal, now),
        ...(goal.maxRuns !== undefined ? { maxRuns: goal.maxRuns } : {}),
        ...(goal.timezone ? { timezone: goal.timezone } : {}),
      };
    case "best-yield":
      return { kind: "apy", asset: goal.asset, networks: goal.networks, minDeltaBps: goal.minDeltaBps ?? 50, ...(goal.current ? { current: goal.current } : {}) };
    case "incoming":
      return { kind: "event", asset: goal.asset, account: goal.account, ...(goal.minAmount ? { minAmount: goal.minAmount } : {}) };
    default:
      return goal;
  }
}

/**
 * Typed entry point for the sentence reader: a trigger and an action it read
 * from "buy $50 of ETH every Monday" become a validated draft for
 * POST /v1/automations (same issues as the API reports).
 */
export function planAutomationFromGoal(
  goal: { readonly trigger: AutomationGoalTrigger; readonly action: AutomationGoalAction },
  context: AutomationGoalContext,
): ValidationResult<ValidatedAutomationDraft> {
  const action = goal.action.kind === "rebalance"
    ? { kind: "rebalance", accounts: context.accounts, ...(goal.action.amount ? { amount: goal.action.amount } : {}) }
    : { kind: "intent", ...(goal.action.text ? { text: goal.action.text } : {}), ...(goal.action.actions ? { actions: goal.action.actions } : {}), accounts: context.accounts };
  return validateAutomationDraft(
    {
      ...(context.label ? { label: context.label } : {}),
      trigger: goalTrigger(goal.trigger, context.now),
      action,
      ...(context.limits ? { limits: context.limits } : {}),
    },
    context.now,
  );
}

/** Sentence shapes the reader maps onto `planAutomationFromGoal` (examples; tests keep them valid). */
export const AUTOMATION_SENTENCE_SHAPES: readonly { readonly sentence: string; readonly goal: { readonly trigger: AutomationGoalTrigger; readonly action: AutomationGoalAction } }[] = Object.freeze([
  {
    sentence: "buy $50 of ETH every Monday",
    goal: { trigger: { kind: "every", unit: "week", weekday: "mon" }, action: { kind: "intent", text: "buy $50 of ETH" } },
  },
  {
    sentence: "if SOL drops below 120 sell half",
    goal: { trigger: { kind: "price", asset: "SOL", network: "solana", direction: "below", priceUsd: "120" }, action: { kind: "intent", text: "sell half of my SOL for USDC" } },
  },
  {
    sentence: "every month send 100 USDC to vitalik.eth",
    goal: { trigger: { kind: "every", unit: "month", dayOfMonth: 1 }, action: { kind: "intent", text: "send 100 USDC to vitalik.eth" } },
  },
  {
    sentence: "keep my USDC in the best yield",
    goal: { trigger: { kind: "best-yield", asset: "USDC", networks: ["base"] }, action: { kind: "rebalance", amount: "100" } },
  },
]);
