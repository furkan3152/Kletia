/**
 * Memory implementations of the Rule Book ports (policy design §6.7, §14.2):
 * single instance by definition. The spend ledger serialises reservations
 * per project with an async mutex (the Postgres ledger takes one advisory
 * lock per project), merges mutually exclusive exposures at their largest
 * amount and prunes rows older than 8 days. `windowUsage` and
 * `windowRetryAt` are the pure window arithmetic both ledgers share.
 */
import {
  POLICY_DECISION_GENESIS,
  policyDecisionChainHash,
  type PolicyChainLink,
  type PolicyDecision,
  type PolicyWindowUsage,
} from "@kletia/core";
import type {
  ExposureRecord,
  ExposureState,
  PolicyApprovalRecord,
  PolicyApprovalStore,
  PolicyDecisionDraft,
  PolicyDecisionLog,
  ScopeUsage,
  SpendLedger,
  SpendReservation,
  SpendReservationResult,
} from "./ports.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
/** Exposures are kept 8 days (one day beyond the weekly window). */
const RETENTION_MS = 8 * DAY_MS;

/** One counted group of a scope: exposures sharing an exclusive key count once (largest amount, latest time). */
export interface ExposureGroup {
  readonly key: string;
  readonly usdMicros: bigint;
  /** Unix ms of the group's latest exposure. */
  readonly at: number;
}

/** Day and week sums of counted groups at `now`. */
export function windowUsage(groups: readonly ExposureGroup[], now: number): PolicyWindowUsage {
  let day = 0n;
  let week = 0n;
  for (const group of groups) {
    if (group.at <= now - WEEK_MS) continue;
    week += group.usdMicros;
    if (group.at > now - DAY_MS) day += group.usdMicros;
  }
  return { dayUsdMicros: day, weekUsdMicros: week };
}

/**
 * Earliest unix ms at which `usage + delta ≤ cap` in a window, walking
 * counted groups out of it oldest first (design §6.4 Retry-After); capped
 * at 7 days ahead; null when even an empty window cannot hold `delta`.
 */
export function windowRetryAt(groups: readonly ExposureGroup[], capUsdMicros: bigint, deltaUsdMicros: bigint, windowMs: number, now: number): number | null {
  if (deltaUsdMicros > capUsdMicros) return null;
  const inWindow = groups.filter((group) => group.at > now - windowMs).sort((a, b) => a.at - b.at);
  let used = inWindow.reduce((sum, group) => sum + group.usdMicros, 0n);
  if (used + deltaUsdMicros <= capUsdMicros) return now;
  for (const group of inWindow) {
    used -= group.usdMicros;
    if (used + deltaUsdMicros <= capUsdMicros) return Math.min(group.at + windowMs + 1, now + WEEK_MS);
  }
  return now + WEEK_MS;
}

interface LedgerRow {
  readonly record: ExposureRecord;
  readonly scope: string;
  state: ExposureState;
  exclusiveKey: string | null;
}

export interface MemorySpendLedgerOptions {
  /** Current heads of the owner's chain, read under the project lock (P13); omitted: not checked. */
  readonly currentChain?: (ownerKeyId: string) => Promise<readonly PolicyChainLink[] | null>;
  /** Most rows kept (LRU). */
  readonly maxRows?: number;
}

function chainText(chain: readonly PolicyChainLink[]): string {
  return chain.map((link) => `${link.scope}:${link.id}:${link.version}:${link.hash}`).sort().join("|");
}

/** Per-key async mutex (one per project for reservations and policy writes). */
export class ProjectLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class MemorySpendLedger implements SpendLedger {
  readonly locks = new ProjectLocks();
  private readonly rows = new Map<string, LedgerRow>();
  private readonly maxRows: number;

  constructor(private readonly options: MemorySpendLedgerOptions = {}) {
    this.maxRows = Math.max(1_000, options.maxRows ?? 200_000);
  }

  /** Every row (tests and the operator view). */
  snapshot(): readonly { readonly record: ExposureRecord; readonly scope: string; readonly state: ExposureState; readonly exclusiveKey: string | null }[] {
    return [...this.rows.values()].map((row) => ({ record: row.record, scope: row.scope, state: row.state, exclusiveKey: row.exclusiveKey }));
  }

  private prune(now: number): void {
    for (const [key, row] of this.rows) if (row.record.createdAt <= now - RETENTION_MS) this.rows.delete(key);
    while (this.rows.size > this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
  }

  /** Counted groups of a scope at `now`, optionally with a hypothetical extra row. */
  groups(scope: string, now: number, extra?: { readonly record: ExposureRecord; readonly exclusiveKey: string | null }): ExposureGroup[] {
    const groups = new Map<string, { usdMicros: bigint; at: number }>();
    const add = (record: ExposureRecord, exclusiveKey: string | null) => {
      if (record.createdAt <= now - WEEK_MS) return;
      const key = exclusiveKey ?? record.id;
      const known = groups.get(key);
      groups.set(key, {
        usdMicros: known && known.usdMicros > record.usdMicros ? known.usdMicros : record.usdMicros,
        at: known && known.at > record.createdAt ? known.at : record.createdAt,
      });
    };
    for (const row of this.rows.values()) if (row.scope === scope && row.state !== "dead") add(row.record, row.exclusiveKey);
    if (extra) add(extra.record, extra.exclusiveKey);
    return [...groups].map(([key, value]) => ({ key, ...value }));
  }

  async usage(scopes: readonly string[], now: number): Promise<ReadonlyMap<string, PolicyWindowUsage>> {
    return new Map(scopes.map((scope) => [scope, windowUsage(this.groups(scope, now), now)]));
  }

  async reserve(reservation: SpendReservation): Promise<SpendReservationResult> {
    const { exposure, now } = reservation;
    return this.locks.run(exposure.projectId, async () => {
      if (this.options.currentChain) {
        const current = await this.options.currentChain(exposure.ownerKeyId);
        if (current === null || chainText(current) !== chainText(reservation.chain)) return { ok: false, reason: "chain_changed" } as const;
      }
      this.prune(now);
      const replayed = reservation.scopes.length > 0 && reservation.scopes.every((scope) => this.rows.has(`${exposure.id}|${scope}`));
      const usage: ScopeUsage[] = [];
      for (const cap of reservation.caps) {
        const before = this.groups(cap.scope, now);
        const after = replayed ? before : this.groups(cap.scope, now, { record: exposure, exclusiveKey: exposure.exclusiveKey });
        const used = windowUsage(before, now);
        const next = windowUsage(after, now);
        for (const [window, limit, prior, total, windowMs] of [
          ["24h", cap.dailyUsdMicros, used.dayUsdMicros, next.dayUsdMicros, DAY_MS],
          ["7d", cap.weeklyUsdMicros, used.weekUsdMicros, next.weekUsdMicros, WEEK_MS],
        ] as const) {
          if (limit === undefined) continue;
          usage.push({ scope: cap.scope, window, usedUsdMicros: total, capUsdMicros: limit, deltaUsdMicros: total - prior });
          if (!replayed && total > limit) {
            return {
              ok: false,
              reason: "cap",
              scope: cap.scope,
              window,
              usage,
              // Upper-bound delta (the whole exposure): the hint is never too early.
              retryAt: windowRetryAt(before, limit, exposure.usdMicros, windowMs, now),
            } as const;
          }
        }
      }
      if (!replayed) {
        for (const scope of reservation.scopes) {
          const key = `${exposure.id}|${scope}`;
          if (!this.rows.has(key)) this.rows.set(key, { record: exposure, scope, state: "open", exclusiveKey: exposure.exclusiveKey });
        }
      }
      return { ok: true, replayed, usage } as const;
    });
  }

  async abort(exposureId: string): Promise<void> {
    for (const row of this.rows.values()) if (row.record.id === exposureId && row.state === "open") row.state = "dead";
  }

  async land(input: { readonly intentId: string; readonly stepId: string; readonly quoteBinding: string | null; readonly now: number }): Promise<readonly ExposureRecord[]> {
    const landed = new Map<string, ExposureRecord>();
    for (const row of this.rows.values()) {
      const record = row.record;
      if (record.intentId !== input.intentId || record.stepId !== input.stepId) continue;
      const match = input.quoteBinding === null ? row.state === "open" : record.quoteBinding === input.quoteBinding;
      if (!match) continue;
      // A verified payload is never dead, whatever a reaper concluded.
      row.state = "landed";
      landed.set(record.id, record);
    }
    return [...landed.values()];
  }

  async recordLanded(exposure: ExposureRecord, scopes: readonly string[]): Promise<void> {
    await this.locks.run(exposure.projectId, async () => {
      for (const scope of scopes) {
        const key = `${exposure.id}|${scope}`;
        if (!this.rows.has(key)) this.rows.set(key, { record: exposure, scope, state: "landed", exclusiveKey: exposure.exclusiveKey });
      }
    });
  }

  async expire(intentId: string, stepId: string, height: bigint): Promise<number> {
    const expired = new Set<string>();
    for (const row of this.rows.values()) {
      const record = row.record;
      if (record.intentId !== intentId || record.stepId !== stepId || row.state !== "open" || record.validUntilHeight === null) continue;
      if (BigInt(record.validUntilHeight) < height) {
        row.state = "dead";
        expired.add(record.id);
      }
    }
    return expired.size;
  }

  async clearExclusive(exclusiveKey: string): Promise<void> {
    for (const row of this.rows.values()) if (row.exclusiveKey === exclusiveKey) row.exclusiveKey = null;
  }
}

/** Hash-chained decision log per project (gapless `seq` in one process). */
export class MemoryDecisionLog implements PolicyDecisionLog {
  private readonly heads = new Map<string, { seq: number; chainHash: string }>();
  private readonly records: PolicyDecision[] = [];

  constructor(private readonly maxRecords = 100_000) {}

  async append(draft: PolicyDecisionDraft): Promise<PolicyDecision> {
    const head = this.heads.get(draft.projectId) ?? { seq: 0, chainHash: POLICY_DECISION_GENESIS };
    const seq = head.seq + 1;
    const chainHash = policyDecisionChainHash(head.chainHash, draft);
    const decision: PolicyDecision = { ...draft, seq, prevHash: head.chainHash, chainHash };
    this.heads.set(draft.projectId, { seq, chainHash });
    this.records.push(decision);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    return decision;
  }

  /** Decisions of a project, oldest first. */
  list(projectId: string): readonly PolicyDecision[] {
    return this.records.filter((decision) => decision.projectId === projectId);
  }
}

/** One hold per intent. */
export class MemoryApprovalStore implements PolicyApprovalStore {
  private readonly byIntent = new Map<string, PolicyApprovalRecord>();

  async forIntent(intentId: string): Promise<PolicyApprovalRecord | undefined> {
    return this.byIntent.get(intentId);
  }

  async create(record: PolicyApprovalRecord): Promise<PolicyApprovalRecord> {
    const existing = this.byIntent.get(record.intentId);
    if (existing) return existing;
    this.byIntent.set(record.intentId, record);
    while (this.byIntent.size > 20_000) {
      const oldest = this.byIntent.keys().next().value;
      if (oldest === undefined) break;
      this.byIntent.delete(oldest);
    }
    return record;
  }

  /** Records a decision (single winner: only a pending, unexpired approval changes). */
  async decide(approvalId: string, status: "approved" | "rejected", at: number = Date.now()): Promise<PolicyApprovalRecord | null> {
    for (const [intentId, record] of this.byIntent) {
      if (record.id !== approvalId) continue;
      if (record.status !== "pending" || Date.parse(record.expiresAt) <= at) return null;
      const next: PolicyApprovalRecord = { ...record, status, decidedAt: new Date(at).toISOString() };
      this.byIntent.set(intentId, next);
      return next;
    }
    return null;
  }
}
