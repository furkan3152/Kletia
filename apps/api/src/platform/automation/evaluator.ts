/**
 * The automation evaluator: every minute on long-running hosts, one pass
 * over the active rules (least recently checked first). With Postgres only
 * one instance runs a pass (a transaction-scoped advisory lock held for the
 * pass); without, the single process does. The `(automation, window)`
 * uniqueness of runs makes a second runner harmless anyway.
 *
 * Per rule: expired → `expired`; a revoked owner key → paused
 * (`key_revoked`); otherwise observe the trigger (a failed read observes
 * nothing and never fires), persist its state, and on a firing claim the
 * window's run, then:
 *   1. cooldown → skipped;
 *   2. plan the intent as a dry run (the owner key's rule book applies);
 *   3. networks, protocols and USD caps (oracle-priced; unpriced inputs skip
 *      a rule that has a USD cap) → skipped with the reason;
 *   4. store the intent (the rule book applies again, caps per run);
 *   5. offer it to a native order provider, else wait for the owner's
 *      signature (`needs_signature`, the inbox).
 * Planning errors fail the run with their code. Kletia never signs.
 */
import {
  automationIntentRequest,
  evaluateApy,
  evaluateCrossing,
  evaluateIncoming,
  evaluateSchedule,
  getYieldVenue,
  nextScheduleSlot,
  type AutomationEventType,
  type AutomationRunStatus,
  type IntentActionSpec,
  type IntentGraph,
  type IntentRequest,
  type TriggerVerdict,
} from "@kletia/core";
import { createIntentDetailed, PlatformError, toPlatformError, type CreatedIntent, type CreateIntentOptions } from "../index.js";
import { isKeyRevoked } from "../http/auth.js";
import { randomHex } from "../http/secrets.js";
import { publishAutomationEvent } from "./events.js";
import { nativeProviderFor } from "./providers.js";
import { LIVE_AUTOMATION_READS, type AutomationReads } from "./reads.js";
import { automationStore, PostgresAutomationStore, type AutomationRecord, type AutomationRunRecord, type AutomationStore, type EvaluationRecord, type RunOutcome } from "./store.js";
import { microsFromUsd, toAutomationView } from "./views.js";

const PASS_LIMIT = 200;
const FIRING_STALE_MS = 15 * 60_000;
const RUN_RETENTION_MS = 90 * 86_400_000;

export type AutomationPlanner = (request: IntentRequest, options: CreateIntentOptions) => Promise<Pick<CreatedIntent, "intent">>;

export interface EvaluatorDeps {
  readonly store: AutomationStore;
  readonly reads: AutomationReads;
  readonly planner: AutomationPlanner;
  /** False when the owner can no longer act (a revoked key). */
  readonly ownerLive: (record: AutomationRecord) => Promise<boolean>;
}

export function liveEvaluatorDeps(): EvaluatorDeps {
  return {
    store: automationStore(),
    reads: LIVE_AUTOMATION_READS,
    planner: createIntentDetailed,
    ownerLive: async (record) => record.owner.kind !== "key" || !(await isKeyRevoked(record.owner.keyId)),
  };
}

export interface RuleEvaluation {
  readonly fired: boolean;
  readonly run: AutomationRunRecord | null;
}

const iso = (time: number) => new Date(time).toISOString();

/* ---------------------------------------------------------------- observe */

type Observation = TriggerVerdict & { readonly from?: string; readonly to?: string };

async function observe(record: AutomationRecord, now: number, reads: AutomationReads): Promise<Observation> {
  const { trigger, state } = record;
  switch (trigger.kind) {
    case "schedule":
      return evaluateSchedule(trigger, state, now);
    case "price": {
      const price = await reads.priceUsd(trigger.asset, trigger.network);
      return price === null ? { fire: false, state } : evaluateCrossing(trigger, Number(trigger.priceUsd), state, price, iso(now));
    }
    case "balance":
      return evaluateCrossing(trigger, Number(trigger.amount), state, await reads.balance(trigger.account, trigger.asset), iso(now));
    case "event":
      return evaluateIncoming(trigger, state, await reads.balance(trigger.account, trigger.asset), iso(now));
    case "apy":
      return evaluateApy(trigger, state, await reads.rates(trigger.asset, trigger.networks));
  }
}

/* ------------------------------------------------------------------- plan */

/** The rebalance: withdraw everything from the current venue, bridge when the best is elsewhere, deposit at the best. */
function rebalanceActions(asset: string, from: string | undefined, to: string, amount: string | undefined): IntentActionSpec[] {
  const target = getYieldVenue(to);
  const source = from === undefined ? null : getYieldVenue(from);
  if (!target || (from !== undefined && !source)) throw new PlatformError("VENUE_UNKNOWN", `Venue ${(target ? from : to) ?? to} is not in the registry.`, 422);
  const actions: IntentActionSpec[] = [];
  if (source) {
    actions.push({ kind: "withdraw", network: source.network, from: asset, amount: "max", params: { venue: source.id } });
    if (source.network !== target.network) actions.push({ kind: "bridge", network: source.network, from: asset, toNetwork: target.network, amount: "max" });
  }
  actions.push({ kind: "deposit", network: target.network, from: asset, amount: source ? "max" : (amount ?? "0"), params: { venue: target.id } });
  return actions;
}

function requestFor(record: AutomationRecord, observation: Observation, runId: string): IntentRequest {
  const run = { automationId: record.id, runId };
  const { action, trigger } = record;
  if (action.kind === "intent") return automationIntentRequest(action, record.limits, run);
  if (trigger.kind !== "apy" || !observation.to) throw new PlatformError("INTERNAL_ERROR", "A rebalance needs an apy trigger.", 500);
  return automationIntentRequest({ kind: "intent", actions: rebalanceActions(trigger.asset, observation.from, observation.to, action.amount), accounts: action.accounts }, record.limits, run);
}

type Verdict = { readonly skip: RunOutcome["reason"]; readonly message: string } | null;

function scopeSkip(record: AutomationRecord, intent: IntentGraph): Verdict {
  const { networks, protocols } = record.limits;
  const outside = networks ? intent.steps.find((step) => !networks.includes(step.network)) : undefined;
  if (outside) return { skip: "network_not_allowed", message: `The plan uses ${outside.network}, outside this automation's networks.` };
  const protocol = protocols ? intent.steps.find((step) => !protocols.includes(step.protocol)) : undefined;
  if (protocol) return { skip: "protocol_not_allowed", message: `The plan uses ${protocol.protocol}, outside this automation's protocols.` };
  return null;
}

function usdSkip(record: AutomationRecord, notional: bigint | null): Verdict {
  const { maxUsdPerRun, maxUsdTotal } = record.limits;
  if (maxUsdPerRun === undefined && maxUsdTotal === undefined) return null;
  if (notional === null) return { skip: "unpriced", message: "An input of the plan has no fresh USD price, so the USD caps cannot be checked." };
  if (maxUsdPerRun !== undefined && notional > microsFromUsd(maxUsdPerRun)) return { skip: "over_run_limit", message: `The plan is worth more than ${maxUsdPerRun} USD.` };
  if (maxUsdTotal !== undefined && BigInt(record.spentUsdMicros) + notional > microsFromUsd(maxUsdTotal)) {
    return { skip: "over_total_limit", message: `This run would take the automation past ${maxUsdTotal} USD in total.` };
  }
  return null;
}

function skipped(verdict: NonNullable<Verdict>, notional: bigint | null = null): RunOutcome {
  return { status: "skipped", reason: verdict.skip, message: verdict.message, intentId: null, title: null, notionalUsdMicros: notional === null ? null : String(notional), provider: null };
}

async function fire(record: AutomationRecord, observation: Observation, run: AutomationRunRecord, now: number, deps: EvaluatorDeps): Promise<RunOutcome> {
  const cooldown = record.limits.cooldownSeconds;
  if (cooldown && record.lastRunAt && Date.parse(record.lastRunAt) + cooldown * 1000 > now) {
    return skipped({ skip: "cooldown", message: `The last run was less than ${cooldown} seconds ago.` });
  }
  try {
    const request = requestFor(record, observation, run.id);
    const owner = record.owner.kind === "key" ? { ownerKeyId: record.owner.keyId } : {};
    const dry = (await deps.planner(request, { ...owner, dryRun: true })).intent;
    const scope = scopeSkip(record, dry);
    if (scope) return skipped(scope);
    const notional = await deps.reads.notionalUsdMicros(dry).catch(() => null);
    const usd = usdSkip(record, notional);
    if (usd) return skipped(usd, notional);
    const { intent } = await deps.planner(request, owner);
    const base = { reason: null, message: null, intentId: intent.id, title: intent.summary.title, notionalUsdMicros: notional === null ? null : String(notional) };
    const provider = nativeProviderFor(toAutomationView(record, now));
    if (provider) {
      const outcome = await provider.execute({ automation: toAutomationView(record, now), runId: run.id, intent }).catch((error: unknown) => ({
        accepted: false as const,
        reason: error instanceof Error ? error.message.slice(0, 200) : "provider failed",
      }));
      if (outcome.accepted) return { ...base, status: "prepared", provider: { id: provider.id, reference: outcome.reference } };
      return { ...base, status: "needs_signature", message: `${provider.id} declined: ${outcome.reason}`.slice(0, 300), provider: null };
    }
    return { ...base, status: "needs_signature", provider: null };
  } catch (error) {
    const failure = toPlatformError(error);
    return { status: "failed", reason: failure.code, message: failure.message.slice(0, 300), intentId: null, title: null, notionalUsdMicros: null, provider: null };
  }
}

const RUN_EVENTS: Readonly<Record<Exclude<AutomationRunStatus, "firing">, AutomationEventType>> = {
  prepared: "automation.fired",
  needs_signature: "automation.fired",
  skipped: "automation.skipped",
  failed: "automation.failed",
};

/** A schedule ends after its last allowed run or past its end. */
function scheduleEnd(record: AutomationRecord, runs: number, now: number): EvaluationRecord["status"] | undefined {
  const trigger = record.trigger;
  if (trigger.kind !== "schedule") return undefined;
  if (trigger.maxRuns !== undefined && runs >= trigger.maxRuns) return { status: "completed", reason: "max_runs" };
  if (nextScheduleSlot(trigger, now, runs) === null && evaluateSchedule(trigger, record.state, now).fire === false) return { status: "completed", reason: "ended" };
  return undefined;
}

/* ---------------------------------------------------------------- evaluate */

async function end(record: AutomationRecord, deps: EvaluatorDeps, checkedAt: string, status: NonNullable<EvaluationRecord["status"]>): Promise<RuleEvaluation> {
  await deps.store.recordEvaluation(record.id, { state: record.state, checkedAt, status });
  publishAutomationEvent("automation.updated", record.owner, { automationId: record.id, status: status.status, reason: status.reason });
  return { fired: false, run: null };
}

/** One rule, once (also called by tests). */
export async function evaluateAutomation(record: AutomationRecord, now: number, deps: EvaluatorDeps): Promise<RuleEvaluation> {
  const checkedAt = iso(now);
  if (record.status !== "active") return { fired: false, run: null };
  if (Date.parse(record.limits.expiresAt) <= now) return end(record, deps, checkedAt, { status: "expired", reason: "expired" });
  if (!(await deps.ownerLive(record))) return end(record, deps, checkedAt, { status: "paused", reason: "key_revoked" });
  let observation: Observation;
  try {
    observation = await observe(record, now, deps.reads);
  } catch (error) {
    console.warn(`[platform] automation ${record.id} could not read its trigger:`, error instanceof Error ? error.message : error);
    observation = { fire: false, state: record.state };
  }
  if (!observation.fire || !observation.window) {
    const ended = scheduleEnd(record, record.runs, now);
    if (ended) return end(record, deps, checkedAt, ended);
    await deps.store.recordEvaluation(record.id, { state: observation.state, checkedAt });
    return { fired: false, run: null };
  }
  const claimed = await deps.store.claimRun({
    id: `ar_${randomHex(12)}`, automationId: record.id, ownerRef: record.ownerRef, window: observation.window, status: "firing", reason: null, message: null,
    observed: observation.observed ?? null, intentId: null, title: null, notionalUsdMicros: null, provider: null, firedAt: checkedAt, updatedAt: checkedAt,
  });
  if (!claimed) {
    // Another evaluator fired this window: only the trigger's progress is kept.
    await deps.store.recordEvaluation(record.id, { state: observation.state, checkedAt });
    return { fired: false, run: null };
  }
  const outcome = await fire(record, observation, claimed, now, deps);
  await deps.store.finishRun(claimed.id, outcome, checkedAt);
  const planned = outcome.status === "needs_signature" || outcome.status === "prepared";
  const runs = record.runs + (planned ? 1 : 0);
  const status = planned ? scheduleEnd({ ...record, state: observation.state }, runs, now) : undefined;
  await deps.store.recordEvaluation(record.id, {
    state: observation.state,
    checkedAt,
    ...(planned ? { fired: { at: checkedAt, usdMicros: outcome.notionalUsdMicros ?? "0" } } : {}),
    ...(status ? { status } : {}),
  });
  publishAutomationEvent(RUN_EVENTS[outcome.status as Exclude<AutomationRunStatus, "firing">], record.owner, {
    automationId: record.id,
    runId: claimed.id,
    status: outcome.status,
    ...(outcome.intentId ? { intentId: outcome.intentId } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  });
  if (status) publishAutomationEvent("automation.updated", record.owner, { automationId: record.id, status: status.status, reason: status.reason });
  return { fired: planned, run: { ...claimed, ...outcome, updatedAt: checkedAt } };
}

/* -------------------------------------------------------------------- pass */

export interface AutomationPassReport {
  readonly evaluated: number;
  readonly fired: number;
  readonly interrupted: number;
}

/** Fails runs left `firing` by an interrupted pass (a crash between claim and finish). */
async function sweepInterrupted(store: AutomationStore, now: number): Promise<number> {
  const stale = await store.staleFiring(iso(now - FIRING_STALE_MS), 100);
  for (const run of stale) {
    await store.finishRun(run.id, { status: "failed", reason: "INTERNAL_ERROR", message: "The evaluation was interrupted before the run finished.", intentId: null, title: null, notionalUsdMicros: null, provider: null }, iso(now));
  }
  return stale.length;
}

/** One pass over the active rules (also called by tests). Never throws. */
export async function runAutomationPass(now = Date.now(), deps: EvaluatorDeps = liveEvaluatorDeps()): Promise<AutomationPassReport> {
  let evaluated = 0;
  let fired = 0;
  let interrupted = 0;
  try {
    interrupted = await sweepInterrupted(deps.store, now);
    for (const record of await deps.store.listActive(PASS_LIMIT)) {
      evaluated += 1;
      const result = await evaluateAutomation(record, now, deps).catch((error: unknown) => {
        console.warn(`[platform] automation ${record.id} evaluation failed:`, error instanceof Error ? error.message : error);
        return { fired: false, run: null };
      });
      if (result.fired) fired += 1;
    }
  } catch (error) {
    console.warn("[platform] automation pass failed:", error instanceof Error ? error.message : error);
  }
  return { evaluated, fired, interrupted };
}

/** Starts the evaluator (leader-only with Postgres) and the daily run pruning; returns a stop function. */
export function startAutomationEvaluator(intervalMs = 60_000): () => void {
  let running = false;
  let lastPrune = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const store = automationStore();
      const pass = async () => {
        await runAutomationPass();
      };
      if (store instanceof PostgresAutomationStore) await store.withLeaderLock(pass);
      else await pass();
      const now = Date.now();
      if (now - lastPrune >= 86_400_000) {
        lastPrune = now;
        await store.pruneRuns(iso(now - RUN_RETENTION_MS));
      }
    } catch (error) {
      console.warn("[platform] automation evaluator failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
