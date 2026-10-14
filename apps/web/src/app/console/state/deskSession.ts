/**
 * The desk's task history in this tab (console design 3.8). The index lives in
 * sessionStorage under `kletia-desk-v1` as `{ v: 1, tasks }`: at most 20
 * tasks, finished ones dropped first, titles redacted the way chat history is
 * (`redactIntentForPersistentHistory`). The sentence a user typed never leaves
 * memory, and neither do questions or turns: a reload keeps what a task is,
 * not what was said.
 *
 * Each platform task keeps its own resume record under
 * `kletia-desk-intent:<taskId>` (the record format of
 * `shared/platform/intentSession.ts`). The first load also picks up a pending
 * Studio or Solana Ask record once: the record moves to the new task's key
 * unchanged (signing marks and references included, so a resume never signs
 * a submitted step again) and the old key is cleared.
 *
 * Every storage access goes through an injectable `TabStorage` whose default
 * is the guarded sessionStorage helpers, so a refused storage only means "no
 * history". Pure apart from that storage (node --test loads it).
 */
import { isNetworkKey, type NetworkKey } from "@kletia/core";

import { redactIntentForPersistentHistory } from "../../../shared/privacy/defaultIntentPrivacy.ts";
import {
  readSessionStorage,
  removeSessionStorage,
  writeSessionStorage,
} from "../../../shared/state/safeStorage.ts";
import { DESK_COPY } from "../content/copy.ts";
import { isLegacyNetwork, parseDeparture, type Departure, type Lane } from "./deskModel.ts";
import type { TaskEngine, TaskRecord, TaskStatus } from "./deskStore.ts";

export const DESK_SESSION_KEY = "kletia-desk-v1";
/** Tasks kept in the index; finished ones are dropped first. */
export const MAX_TASKS = 20;
/** Legacy resume keys picked up once by the desk (`intentSession.ts`). */
export const LEGACY_RESUME_KEYS = Object.freeze([
  { key: "kletia-studio-intent", origin: "studio" },
  { key: "kletia-solana-ask-intent", origin: "solana-ask" },
] as const);

export type TaskOrigin = (typeof LEGACY_RESUME_KEYS)[number]["origin"];

/** The resume record of one desk task (format of `intentSession.ts`). */
export function deskIntentSessionKey(taskId: string): string {
  return `kletia-desk-intent:${taskId}`;
}

export interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The guarded sessionStorage helpers: a refused storage reads as empty and never throws. */
export const tabStorage: TabStorage = Object.freeze({
  getItem: readSessionStorage,
  setItem: writeSessionStorage,
  removeItem: removeSessionStorage,
});

/** What the index keeps of a task. */
export interface TaskIndexEntry {
  readonly id: string;
  readonly createdAt: number;
  /** Redacted (amounts and recipients removed). */
  readonly title: string;
  readonly departure: Departure;
  readonly lane: Lane;
  readonly engine: TaskEngine;
  readonly intentId: string | null;
  readonly status: TaskStatus;
  readonly ends: { readonly from: NetworkKey; readonly to: NetworkKey } | null;
  readonly origin?: TaskOrigin;
}

export const TASK_STATUSES: readonly TaskStatus[] = Object.freeze([
  "planning",
  "preview",
  "question",
  "review",
  "executing",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "unsupported",
  "engine",
]);

const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["completed", "failed", "cancelled", "unsupported"]);
/** States whose intent can be picked up again after a reload (on demand, never automatically). */
const RESUMABLE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["review", "executing", "paused"]);

const TASK_ID = /^[A-Za-z0-9-]{8,64}$/u;
const INTENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/u;
const MAX_TITLE = 160;
/** Resume records older than this are ignored (`intentSession.ts`). */
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;

export function isFinishedStatus(status: TaskStatus): boolean {
  return FINISHED.has(status);
}

/** A task can be picked up after a reload when its intent was persisted and not finished. */
export function isResumable(entry: Pick<TaskIndexEntry, "status" | "intentId">): boolean {
  return entry.intentId !== null && RESUMABLE.has(entry.status);
}

/** The persisted title: redacted like chat history, one line, bounded. */
export function persistedTitle(title: string): string {
  const redacted = redactIntentForPersistentHistory(title.replace(/\s+/gu, " "));
  return redacted.length > MAX_TITLE ? `${redacted.slice(0, MAX_TITLE - 1)}…` : redacted;
}

export function toIndexEntry(task: TaskRecord): TaskIndexEntry {
  return {
    id: task.id,
    createdAt: task.createdAt,
    title: persistedTitle(task.title),
    departure: task.departure,
    lane: task.lane,
    engine: task.engine,
    intentId: task.intentId,
    status: task.status,
    ends: task.ends,
    ...(task.origin ? { origin: task.origin } : {}),
  };
}

/**
 * At most `MAX_TASKS`, newest kept: finished tasks go first (oldest first),
 * then the oldest of the rest. A task that is executing is never dropped.
 * Order of the kept tasks is unchanged.
 */
export function capTasks<T extends Pick<TaskIndexEntry, "id" | "createdAt" | "status">>(
  tasks: readonly T[],
  limit = MAX_TASKS,
): { readonly kept: readonly T[]; readonly dropped: readonly T[] } {
  if (tasks.length <= limit) return { kept: tasks, dropped: [] };
  const byAge = [...tasks].filter((task) => task.status !== "executing").sort((a, b) => a.createdAt - b.createdAt);
  const order = [...byAge.filter((task) => isFinishedStatus(task.status)), ...byAge.filter((task) => !isFinishedStatus(task.status))];
  const dropIds = new Set(order.slice(0, tasks.length - limit).map((task) => task.id));
  return {
    kept: tasks.filter((task) => !dropIds.has(task.id)),
    dropped: tasks.filter((task) => dropIds.has(task.id)),
  };
}

export function serializeTaskIndex(tasks: readonly TaskRecord[]): string {
  const entries = capTasks(tasks.map(toIndexEntry)).kept;
  return JSON.stringify({ v: 1, tasks: entries });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEngine(value: unknown): TaskEngine | null {
  if (!isRecord(value)) return null;
  if (value.kind === "platform") return { kind: "platform" };
  if (value.kind === "network" && isLegacyNetwork(value.network) && (value.why === "tool" || value.why === "fallback" || value.why === "offer")) {
    return { kind: "network", network: value.network, why: value.why };
  }
  return null;
}

function parseEntry(value: unknown): TaskIndexEntry | null {
  if (!isRecord(value)) return null;
  const { id, createdAt, title, lane, intentId, status, ends, origin } = value;
  const departure = parseDeparture(value.departure);
  const engine = parseEngine(value.engine);
  if (typeof id !== "string" || !TASK_ID.test(id)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (typeof title !== "string" || title.length > MAX_TITLE * 2) return null;
  if (!departure || !engine) return null;
  if (lane !== "production" && lane !== "testnet") return null;
  if (intentId !== null && (typeof intentId !== "string" || !INTENT_ID.test(intentId))) return null;
  if (typeof status !== "string" || !(TASK_STATUSES as readonly string[]).includes(status)) return null;
  let parsedEnds: TaskIndexEntry["ends"] = null;
  if (ends !== null && ends !== undefined) {
    if (!isRecord(ends) || !isNetworkKey(ends.from) || !isNetworkKey(ends.to)) return null;
    parsedEnds = { from: ends.from, to: ends.to };
  }
  const knownOrigin = LEGACY_RESUME_KEYS.find((entry) => entry.origin === origin)?.origin;
  return {
    id,
    createdAt,
    // Redacted again on the way in: the index is tab storage another script could have written.
    title: persistedTitle(title),
    departure,
    lane,
    engine,
    intentId: intentId as string | null,
    status: status as TaskStatus,
    ends: parsedEnds,
    ...(knownOrigin ? { origin: knownOrigin } : {}),
  };
}

/** The index as stored; malformed entries and duplicates are dropped, the cap is applied. */
export function parseTaskIndex(raw: string | null): TaskIndexEntry[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.tasks)) return [];
  const seen = new Set<string>();
  const entries: TaskIndexEntry[] = [];
  for (const candidate of value.tasks.slice(0, MAX_TASKS * 2)) {
    const entry = parseEntry(candidate);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return [...capTasks(entries).kept];
}

export function readTaskIndex(storage: TabStorage = tabStorage): TaskIndexEntry[] {
  return parseTaskIndex(storage.getItem(DESK_SESSION_KEY));
}

export function writeTaskIndex(tasks: readonly TaskRecord[], storage: TabStorage = tabStorage): void {
  storage.setItem(DESK_SESSION_KEY, serializeTaskIndex(tasks));
}

/** The intent id of a legacy resume record that is still worth picking up, or null. */
function legacyRecordIntent(raw: string | null, now: number): string | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.v !== 1) return null;
    if (typeof value.intentId !== "string" || !INTENT_ID.test(value.intentId)) return null;
    if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt) || now - value.savedAt > MAX_RECORD_AGE_MS) return null;
    return value.intentId;
  } catch {
    return null;
  }
}

/**
 * Picks up a pending Studio or Solana Ask resume record once: each becomes a
 * paused task ("Picked up from Studio") whose resume key holds the record
 * unchanged, and the old key is cleared. A record for an intent the desk
 * already tracks is only cleared; an expired or malformed one is cleared too.
 */
export function importLegacyResumeRecords({
  existing,
  storage = tabStorage,
  newId,
  now = Date.now(),
}: {
  readonly existing: readonly Pick<TaskIndexEntry, "intentId">[];
  readonly storage?: TabStorage;
  readonly newId: () => string;
  readonly now?: number;
}): TaskIndexEntry[] {
  const imported: TaskIndexEntry[] = [];
  for (const { key, origin } of LEGACY_RESUME_KEYS) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const intentId = legacyRecordIntent(raw, now);
    const known = intentId !== null && [...existing, ...imported].some((entry) => entry.intentId === intentId);
    if (intentId !== null && !known) {
      const id = newId();
      storage.setItem(deskIntentSessionKey(id), raw);
      imported.push({
        id,
        createdAt: now,
        title: origin === "studio" ? DESK_COPY.tasks.pickedUpFromStudio : DESK_COPY.tasks.pickedUpFromAsk,
        departure: "auto",
        lane: "production",
        engine: { kind: "platform" },
        intentId,
        status: "paused",
        ends: null,
        origin,
      });
    }
    storage.removeItem(key);
  }
  return imported;
}

/** A fresh task id (uuid v4), also the legacy thread id and the resume key suffix. */
export function createTaskId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
