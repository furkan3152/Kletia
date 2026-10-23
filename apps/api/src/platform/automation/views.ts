/**
 * Public views of automations and runs. USD amounts are stored as integer
 * micro-dollars and shown as decimal strings with cents.
 */
import { latestScheduleSlot, nextScheduleSlot, type AutomationRunView, type AutomationView } from "@kletia/core";
import { nativeProviderFor } from "./providers.js";
import type { AutomationRecord, AutomationRunRecord } from "./store.js";

/** "12345678" micro-dollars → "12.35" (rounded up to the cent: a cap is never understated). */
export function usdFromMicros(micros: string | bigint): string {
  const cents = (BigInt(micros) + 9_999n) / 10_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/** Micro-dollars of a decimal USD string. */
export function microsFromUsd(usd: string): bigint {
  const [whole = "0", fraction = ""] = usd.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
}

/** A schedule's next run: the due slot not fired yet (now), else the next one; null when none is left or not active. */
function nextRunAt(record: AutomationRecord, now: number): string | null {
  const trigger = record.trigger;
  if (record.status !== "active" || trigger.kind !== "schedule") return null;
  const latest = latestScheduleSlot(trigger, now);
  const latestIso = latest ? new Date(latest.at).toISOString() : null;
  const endsBefore = trigger.endAt !== undefined && latest !== null && latest.at > Date.parse(trigger.endAt);
  if (latestIso && !endsBefore && (record.state.lastSlot === undefined || record.state.lastSlot < latestIso)) return latestIso;
  const next = nextScheduleSlot(trigger, now, record.runs);
  return next === null || next > Date.parse(record.limits.expiresAt) ? null : new Date(next).toISOString();
}

export function toAutomationView(record: AutomationRecord, now = Date.now()): AutomationView {
  const view: AutomationView = {
    id: record.id,
    label: record.label,
    owner: record.owner,
    trigger: record.trigger,
    action: record.action,
    limits: record.limits,
    status: record.status,
    statusReason: record.statusReason,
    state: record.state,
    execution: { mode: "signature" },
    runs: record.runs,
    spentUsd: usdFromMicros(record.spentUsdMicros),
    lastRunAt: record.lastRunAt,
    nextRunAt: nextRunAt(record, now),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  const provider = nativeProviderFor(view);
  return provider ? { ...view, execution: { mode: "native", provider: provider.id } } : view;
}

export function toRunView(run: AutomationRunRecord): AutomationRunView {
  return {
    id: run.id,
    automationId: run.automationId,
    window: run.window,
    status: run.status,
    reason: run.reason,
    message: run.message,
    observed: run.observed,
    intentId: run.intentId,
    title: run.title,
    notionalUsd: run.notionalUsdMicros === null ? null : usdFromMicros(run.notionalUsdMicros),
    provider: run.provider,
    firedAt: run.firedAt,
    updatedAt: run.updatedAt,
  };
}
