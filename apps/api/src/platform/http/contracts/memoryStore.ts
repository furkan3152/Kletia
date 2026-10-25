/**
 * In-memory contract store.
 */
import {
  ConcurrentChange,
  type ContractEntry,
  contractExists,
  contractLimitReached,
  type ContractRecord,
  type ContractRevision,
  type ContractStore,
  type RevisionSummary,
} from "./records.js";

interface MemoryContract {
  record: ContractRecord;
  readonly revisions: Map<number, ContractRevision>;
}

export class MemoryContractStore implements ContractStore {
  readonly kind = "memory" as const;
  private readonly contracts = new Map<string, MemoryContract>();
  private readonly spends = new Map<string, { usd: number; prepared: number }>();

  constructor(private readonly maxContracts = 10_000) {}

  private entry(item: MemoryContract): ContractEntry {
    const { record } = item;
    return {
      record,
      active: record.activeRevision === null ? null : (item.revisions.get(record.activeRevision) ?? null),
      pending: record.pendingRevision === null ? null : (item.revisions.get(record.pendingRevision) ?? null),
    };
  }

  async create(record: ContractRecord, revision: ContractRevision, maxPerOwner: number): Promise<void> {
    const owned = [...this.contracts.values()].filter((item) => item.record.ownerKeyId === record.ownerKeyId && item.record.status !== "deleted");
    if (owned.some((item) => item.record.network === record.network && item.record.target === record.target)) throw contractExists();
    if (owned.length >= maxPerOwner) throw contractLimitReached(maxPerOwner);
    if (this.contracts.has(record.id)) throw new ConcurrentChange();
    this.contracts.set(record.id, { record, revisions: new Map([[revision.revision, revision]]) });
    while (this.contracts.size > this.maxContracts) {
      const oldest = this.contracts.keys().next().value;
      if (oldest === undefined) break;
      this.contracts.delete(oldest);
    }
  }

  async get(id: string): Promise<ContractEntry | null> {
    const item = this.contracts.get(id);
    return item ? this.entry(item) : null;
  }

  async listVisible(ownerKeyId: string, projectId: string | null): Promise<ContractEntry[]> {
    return [...this.contracts.values()]
      .filter(({ record }) =>
        record.status !== "deleted" &&
        (record.ownerKeyId === ownerKeyId || (projectId !== null && record.projectId === projectId && record.visibility === "project")),
      )
      .sort((a, b) => (a.record.createdAt < b.record.createdAt ? -1 : a.record.createdAt > b.record.createdAt ? 1 : 0))
      .slice(0, 200)
      .map((item) => this.entry(item));
  }

  async listDue(now: string, limit: number): Promise<ContractEntry[]> {
    return [...this.contracts.values()]
      .filter(({ record }) => record.status !== "deleted" && record.pendingRevision !== null && record.activatesAt !== null && record.activatesAt <= now)
      .sort((a, b) => ((a.record.activatesAt ?? "") < (b.record.activatesAt ?? "") ? -1 : 1))
      .slice(0, limit)
      .map((item) => this.entry(item));
  }

  async listForWatch(limit: number): Promise<ContractEntry[]> {
    return [...this.contracts.values()]
      .filter(({ record }) => record.status === "active" || record.status === "pending")
      .sort((a, b) => {
        const left = a.record.pinsCheckedAt ?? "";
        const right = b.record.pinsCheckedAt ?? "";
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .slice(0, limit)
      .map((item) => this.entry(item));
  }

  async update(
    record: ContractRecord,
    expectedUpdatedAt: string,
    revisions: { readonly insert?: ContractRevision; readonly replace?: ContractRevision } = {},
  ): Promise<boolean> {
    const item = this.contracts.get(record.id);
    if (!item || item.record.updatedAt !== expectedUpdatedAt) return false;
    if (revisions.insert && item.revisions.has(revisions.insert.revision)) return false;
    if (revisions.replace && !item.revisions.has(revisions.replace.revision)) return false;
    if (revisions.insert) item.revisions.set(revisions.insert.revision, revisions.insert);
    if (revisions.replace) item.revisions.set(revisions.replace.revision, revisions.replace);
    item.record = record;
    return true;
  }

  async history(id: string, limit: number): Promise<RevisionSummary[]> {
    const item = this.contracts.get(id);
    if (!item) return [];
    return [...item.revisions.values()]
      .sort((a, b) => b.revision - a.revision)
      .slice(0, limit)
      .map((revision) => ({ revision: revision.revision, definitionHash: revision.definitionHash, createdAt: revision.createdAt }));
  }

  async counts(ownerKeyId: string): Promise<{ registered: number; suspended: number }> {
    let registered = 0;
    let suspended = 0;
    for (const { record } of this.contracts.values()) {
      if (record.ownerKeyId !== ownerKeyId || record.status === "deleted") continue;
      registered += 1;
      if (record.status === "suspended") suspended += 1;
    }
    return { registered, suspended };
  }

  async addSpend(ownerKeyId: string, day: string, usd: number, capUsd: number): Promise<boolean> {
    const key = `${ownerKeyId}\u0000${day}`;
    const current = this.spends.get(key) ?? { usd: 0, prepared: 0 };
    if (current.usd + usd > capUsd) return false;
    this.spends.set(key, { usd: current.usd + usd, prepared: current.prepared + 1 });
    while (this.spends.size > 50_000) {
      const oldest = this.spends.keys().next().value;
      if (oldest === undefined) break;
      this.spends.delete(oldest);
    }
    return true;
  }

  async spend(ownerKeyId: string, day: string): Promise<{ usd: number; prepared: number }> {
    return this.spends.get(`${ownerKeyId}\u0000${day}`) ?? { usd: 0, prepared: 0 };
  }
}
