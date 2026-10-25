/**
 * Store selection, callers and visibility, delayed activation, mutation
 * and suspension.
 */
import { reservedIntegratorName, type ContractDefinition } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { apiKeyStore } from "../auth.js";
import { HttpError, type AuthContext } from "../context.js";
import { platformDatabaseUrl } from "../db.js";
import { clock, iso, nextTimestamp, publish } from "./events.js";
import {
  ConcurrentChange,
  type ContractEntry,
  type ContractRecord,
  type ContractRevision,
  type ContractStore,
  LIFTABLE_SUSPENSIONS,
} from "./records.js";
import { MemoryContractStore } from "./memoryStore.js";
import { PostgresContractStore } from "./postgresStore.js";

let store: ContractStore | null = null;

export function contractStore(): ContractStore {
  store ??= platformDatabaseUrl() ? new PostgresContractStore() : new MemoryContractStore();
  return store;
}

export function contractStoreKind(): "memory" | "postgres" {
  return contractStore().kind;
}

/* ============================================================ key context */

const PROJECT_CACHE_MS = 15_000;
const projects = new Map<string, { readonly projectId: string | null; readonly expiresAt: number }>();

/** Project of a key id (null for operator and unknown keys), cached 15 s like verified keys. */
async function projectOf(keyId: string): Promise<string | null> {
  const now = Date.now();
  const cached = projects.get(keyId);
  if (cached && cached.expiresAt > now) return cached.projectId;
  const projectId = (await apiKeyStore().findById(keyId))?.projectId ?? null;
  projects.delete(keyId);
  projects.set(keyId, { projectId, expiresAt: now + PROJECT_CACHE_MS });
  while (projects.size > 20_000) {
    const oldest = projects.keys().next().value;
    if (oldest === undefined) break;
    projects.delete(oldest);
  }
  return projectId;
}

/** The AuthContext of a key id outside an HTTP request (MCP tools), with its project. */
export async function keyContext(tier: AuthContext["tier"], keyId: string): Promise<AuthContext> {
  const projectId = await projectOf(keyId);
  return { tier, keyId, ...(projectId ? { projectId } : {}) };
}

export interface Caller {
  readonly keyId: string;
  readonly projectId: string | null;
}

export function reader(auth: AuthContext): Caller {
  if (!auth.keyId) throw new HttpError(401, "API_KEY_REQUIRED", "Contract registrations require an API key.");
  return { keyId: auth.keyId, projectId: auth.projectId ?? null };
}

/** Changing registrations requires the key's current secret (same rule as key management). */
export function writer(auth: AuthContext): Caller {
  const caller = reader(auth);
  if (auth.viaPreviousSecret) {
    throw new PlatformError("KEY_SECRET_ROTATED", "This secret was rotated and only authenticates until its grace window ends. Register and change contracts with the current secret.", 403);
  }
  return caller;
}

/** Whether `caller` may read and use a registration (owner, or project-visible in the caller's project). */
export function visibleTo(record: ContractRecord, caller: Caller): boolean {
  if (record.status === "deleted") return false;
  if (record.ownerKeyId === caller.keyId) return true;
  return record.visibility === "project" && record.projectId !== null && record.projectId === caller.projectId;
}

/* ============================================================ activation */

export function needsDomain(definition: ContractDefinition): boolean {
  return reservedIntegratorName(definition.integrator.name) !== null;
}

/** The record after its pending revision activates, or null when it cannot activate yet. */
export function activated(entry: ContractEntry, now: number): ContractRecord | null {
  const { record, pending } = entry;
  if (record.status === "deleted" || !pending || record.pendingRevision === null || record.activatesAt === null) return null;
  if (Date.parse(record.activatesAt) > now) return null;
  if (needsDomain(pending.definition) && !record.verification.domain.verified) return null;
  const lift = record.status === "pending" || (record.status === "suspended" && LIFTABLE_SUSPENSIONS.has(record.suspendedReason ?? ""));
  return {
    ...record,
    status: lift ? "active" : record.status,
    suspendedReason: lift ? null : record.suspendedReason,
    activeRevision: record.pendingRevision,
    pendingRevision: null,
    activatesAt: null,
    visibility: pending.definition.visibility ?? "private",
    updatedAt: nextTimestamp(record.updatedAt, now),
  };
}

/** Activates a due pending revision (exactly one instance wins and emits the events). Returns the fresh entry. */
export async function settle(entry: ContractEntry): Promise<ContractEntry> {
  const now = clock();
  const next = activated(entry, now);
  if (!next) return entry;
  if (!(await contractStore().update(next, entry.record.updatedAt))) return (await contractStore().get(entry.record.id)) ?? entry;
  const revision = next.activeRevision ?? next.revision;
  if (next.status === "active") publish("contract.activated", next, revision);
  if (entry.record.status === "suspended" && next.status === "active") publish("contract.reactivated", next, revision);
  return { record: next, active: entry.pending, pending: null };
}

/** Activates every due pending revision (watcher); returns how many activated. */
export async function activateDueContracts(limit = 200): Promise<number> {
  let count = 0;
  for (const entry of await contractStore().listDue(iso(clock()), limit)) {
    const settled = await settle(entry);
    if (settled.record.activeRevision !== entry.record.activeRevision) count += 1;
  }
  return count;
}

/** Re-reads an entry until a read-modify-write lands (optimistic concurrency, bounded). */
export async function mutate(
  id: string,
  change: (entry: ContractEntry) => Promise<{ record: ContractRecord; insert?: ContractRevision; replace?: ContractRevision } | null>,
): Promise<{ before: ContractEntry; after: ContractEntry } | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await contractStore().get(id);
    if (!current) return null;
    const entry = await settle(current);
    const next = await change(entry);
    if (!next) return { before: entry, after: entry };
    if (await contractStore().update(next.record, entry.record.updatedAt, { ...(next.insert ? { insert: next.insert } : {}), ...(next.replace ? { replace: next.replace } : {}) })) {
      const after = await contractStore().get(id);
      return { before: entry, after: after ?? entry };
    }
  }
  throw new ConcurrentChange();
}

/** Suspends a registration (idempotent; the first reason is kept). Emits `contract.suspended` once. */
export async function suspendContract(id: string, reason: string, detail?: string): Promise<ContractEntry | null> {
  const result = await mutate(id, async (entry) => {
    if (entry.record.status === "deleted" || entry.record.status === "suspended") return null;
    return { record: { ...entry.record, status: "suspended", suspendedReason: reason, updatedAt: nextTimestamp(entry.record.updatedAt, clock()) } };
  });
  if (!result) return null;
  if (result.before.record.status !== "suspended" && result.after.record.status === "suspended") {
    if (detail) console.warn(`[platform] contract ${id} suspended (${reason}): ${detail.slice(0, 300)}`);
    publish("contract.suspended", result.after.record, result.after.record.activeRevision ?? result.after.record.revision, reason);
  }
  return result.after;
}
