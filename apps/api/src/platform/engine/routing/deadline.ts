/**
 * Request deadline of planning. `POST /v1/intents` planning runs under one
 * overall deadline (15 s by default) that every stage reads: each stage gets
 * the remaining budget, never more, and when the budget is spent the request
 * fails closed with PLAN_TIMEOUT (504). The deadline travels with the async
 * context (AsyncLocalStorage), so adapters and auctions deep in the call
 * tree see it without new parameters; a nested deadline never extends the
 * one around it.
 *
 * Expiry rejects the request at once. Work already started (a venue quote
 * in flight) is not cancelled, but its result is ignored.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PlatformError } from "../../errors.js";

/** Overall planning budget of one request. */
export const PLAN_DEADLINE_MS = 15_000;

export interface Deadline {
  /** Unix ms at which the budget is spent. */
  readonly at: number;
  /** What the stage was started for (diagnostics only). */
  readonly label: string;
}

const storage = new AsyncLocalStorage<Deadline>();

let planDeadlineMs = PLAN_DEADLINE_MS;

/** Overrides the planning budget (tests, embedders); `null` restores PLAN_DEADLINE_MS. */
export function configurePlanDeadline(ms: number | null): void {
  planDeadlineMs = ms === null ? PLAN_DEADLINE_MS : Math.max(1, Math.floor(ms));
}

/** The configured planning budget in ms. */
export function planDeadlineBudgetMs(): number {
  return planDeadlineMs;
}

/** The deadline of the current async context, if any. */
export function currentDeadline(): Deadline | null {
  return storage.getStore() ?? null;
}

/** Milliseconds left in the current context (Infinity without a deadline; never negative). */
export function remainingMs(now: number = Date.now()): number {
  const deadline = currentDeadline();
  return deadline ? Math.max(0, deadline.at - now) : Number.POSITIVE_INFINITY;
}

/** `capMs` limited by the remaining budget (a stage never gets more than what is left). */
export function budgetMs(capMs: number, now: number = Date.now()): number {
  return Math.max(0, Math.min(capMs, remainingMs(now)));
}

/** The refusal of a spent budget. */
export function planTimeout(label?: string): PlatformError {
  return new PlatformError(
    "PLAN_TIMEOUT",
    `Planning did not finish within ${Math.round(planDeadlineMs / 1000)} s${label ? ` (${label})` : ""}. Venues did not quote in time; retry shortly, or ask for fewer steps or networks.`,
    504,
  );
}

/** Throws PLAN_TIMEOUT when the current context's budget is spent. */
export function assertWithinDeadline(label?: string, now: number = Date.now()): void {
  const deadline = currentDeadline();
  if (deadline && now >= deadline.at) throw planTimeout(label ?? deadline.label);
}

/**
 * Runs `task` under a deadline `ms` from now (never later than an enclosing
 * deadline). The returned promise rejects with PLAN_TIMEOUT when the budget
 * is spent before the task settles; a later rejection of the task is
 * swallowed (its result is no longer wanted).
 */
export async function withDeadline<T>(ms: number, label: string, task: () => Promise<T>, now: number = Date.now()): Promise<T> {
  const outer = currentDeadline();
  const at = Math.min(now + Math.max(0, ms), outer?.at ?? Number.POSITIVE_INFINITY);
  const deadline: Deadline = { at, label: outer && outer.at <= now + ms ? outer.label : label };
  if (at <= now) throw planTimeout(deadline.label);
  const running = storage.run(deadline, task);
  running.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(planTimeout(deadline.label)), Math.max(0, at - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs `task` under the configured planning budget (PLAN_DEADLINE_MS unless configured). */
export function withPlanDeadline<T>(task: () => Promise<T>): Promise<T> {
  return withDeadline(planDeadlineMs, "planning", task);
}

/**
 * Races `promise` against `timeoutMs` (capped by the remaining budget): the
 * timeout rejects with `onTimeout()`; a spent request budget rejects with
 * PLAN_TIMEOUT. Used for per-venue quote timeouts.
 */
export async function raceBudget<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  promise.catch(() => undefined);
  const remaining = remainingMs();
  const limit = Math.min(timeoutMs, remaining);
  if (!Number.isFinite(limit)) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(limit < timeoutMs ? planTimeout(currentDeadline()?.label) : onTimeout()), Math.max(0, limit));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
