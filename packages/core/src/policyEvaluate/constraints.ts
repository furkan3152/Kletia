/**
 * Constraint narrowing and schedules.
 */
import type { IntentConstraints, IntentRequest } from "../intent.js";
import type { ProtocolId } from "../protocols.js";
import {
  policyTimeMinutes,
  WEEKDAYS,
  type PolicyDocument,
  type Weekday,
} from "../policy.js";
import {
  EXECUTABLE_PROTOCOLS,
  INTENT_DEFAULT_MAX_SECONDS,
  INTENT_DEFAULT_SLIPPAGE_BPS,
} from "./rules.js";

/**
 * Rewrites the request's constraints before planning so the auction picks
 * an allowed venue. Only constraints some rule book restricts are
 * touched; the post-plan evaluation stays authoritative.
 */
export function narrowConstraints(chain: readonly (PolicyDocument | null)[], request: IntentRequest): IntentRequest {
  const documents = chain.filter((document): document is PolicyDocument => document !== null);
  const constraints: IntentConstraints = request.constraints ?? {};
  const next: { -readonly [K in keyof IntentConstraints]: IntentConstraints[K] } = { ...constraints };
  const slippageLimits = documents.map((document) => document.limits?.maxSlippageBps).filter((value): value is number => value !== undefined);
  if (slippageLimits.length > 0) next.maxSlippageBps = Math.min(constraints.maxSlippageBps ?? INTENT_DEFAULT_SLIPPAGE_BPS, ...slippageLimits);
  const feeLimits = documents.map((document) => document.limits?.maxFeeUsd).filter((value): value is string => value !== undefined).map(Number);
  if (feeLimits.length > 0) next.maxFeeUsd = Math.min(...(constraints.maxFeeUsd !== undefined ? [constraints.maxFeeUsd] : []), ...feeLimits);
  const secondLimits = documents.map((document) => document.limits?.maxSeconds).filter((value): value is number => value !== undefined);
  if (secondLimits.length > 0) next.maxSeconds = Math.min(constraints.maxSeconds ?? INTENT_DEFAULT_MAX_SECONDS, ...secondLimits);
  const avoid = new Set<ProtocolId>(constraints.avoidProtocols ?? []);
  for (const document of documents) {
    for (const protocol of document.protocols?.deny ?? []) avoid.add(protocol);
    const allow = document.protocols?.allow;
    if (allow) for (const protocol of EXECUTABLE_PROTOCOLS) if (!allow.includes(protocol)) avoid.add(protocol);
  }
  if (avoid.size > (constraints.avoidProtocols?.length ?? 0)) next.avoidProtocols = [...avoid].sort();
  if (constraints.preferProtocols) next.preferProtocols = constraints.preferProtocols.filter((protocol) => !avoid.has(protocol));
  if (documents.some((document) => document.networks?.lanes && !document.networks.lanes.includes("testnet"))) next.allowTestnets = false;
  const changed = Object.keys(next).some((key) => (next as Record<string, unknown>)[key] !== (constraints as Record<string, unknown>)[key]);
  return changed ? { ...request, constraints: next } : request;
}

/* ================================================================ schedule */

export interface ScheduleState {
  readonly open: boolean;
  /** ISO time of the next opening or closing within 8 days; null when it never changes. */
  readonly nextChange: string | null;
  readonly timezone: string | null;
  /** Closed: seconds to the next opening (capped at 86,400); null when open or never opens. */
  readonly retryAfterSeconds: number | null;
  /** The time zone could not be evaluated (fail closed: treated as closed). */
  readonly error?: true;
}

const WEEKDAY_SHORT: Readonly<Record<string, number>> = Object.freeze({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 });

function localMinuteOfWeek(formatter: Intl.DateTimeFormat, time: number): number {
  const parts = formatter.formatToParts(new Date(time));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = WEEKDAY_SHORT[value("weekday")];
  const hour = Number(value("hour")) % 24;
  const minute = Number(value("minute"));
  if (day === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("Unexpected time format.");
  return day * 1_440 + hour * 60 + minute;
}

function openAt(schedule: NonNullable<PolicyDocument["schedule"]>, minuteOfWeek: number): boolean {
  const day = WEEKDAYS[Math.floor(minuteOfWeek / 1_440)] as Weekday;
  const minute = minuteOfWeek % 1_440;
  return schedule.windows.some((window) => window.days.includes(day) && minute >= (policyTimeMinutes(window.from) ?? 0) && minute < (policyTimeMinutes(window.to) ?? 0));
}

/**
 * Whether `now` falls in a window of the timetable, read in its IANA zone
 * through Intl (DST handled by Intl), and when that changes next (scan of at
 * most 8 days, resynchronised with Intl every 15 minutes).
 */
export function scheduleState(schedule: PolicyDocument["schedule"] | null | undefined, now: number | Date = Date.now()): ScheduleState {
  if (!schedule) return { open: true, nextChange: null, timezone: null, retryAfterSeconds: null };
  const time = now instanceof Date ? now.getTime() : now;
  let formatter: Intl.DateTimeFormat;
  let current: number;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    current = localMinuteOfWeek(formatter, time);
  } catch {
    return { open: false, nextChange: null, timezone: schedule.timezone, retryAfterSeconds: null, error: true };
  }
  const open = openAt(schedule, current);
  const startOfNextMinute = Math.floor(time / 60_000) * 60_000 + 60_000;
  let local = (current + 1) % 10_080;
  let nextChange: number | null = null;
  for (let step = 0; step < 8 * 1_440; step += 1) {
    const candidate = startOfNextMinute + step * 60_000;
    if (candidate % 900_000 === 0 || step === 0) local = localMinuteOfWeek(formatter, candidate);
    if (openAt(schedule, local) !== open) {
      nextChange = candidate;
      break;
    }
    local = (local + 1) % 10_080;
  }
  return {
    open,
    nextChange: nextChange === null ? null : new Date(nextChange).toISOString(),
    timezone: schedule.timezone,
    retryAfterSeconds: open || nextChange === null ? null : Math.min(86_400, Math.max(1, Math.ceil((nextChange - time) / 1_000))),
  };
}
