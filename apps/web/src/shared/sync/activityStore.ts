import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { explorerTxUrl, isNetworkKey, type NetworkKey } from "@kletia/core";

import { safeLocalStorage } from "../state/safeStorage";
import { emitActivityRecorded, kletiaBus } from "./bus";

export type ActivityStatus = "pending" | "confirmed" | "failed";

export interface ActivityEntry {
  readonly id: string;
  readonly network: NetworkKey;
  readonly title: string;
  readonly status: ActivityStatus;
  /** Transaction hash (EVM) or signature (Solana). */
  readonly reference?: string;
  /** Explorer link; only https URLs are kept. */
  readonly url?: string;
  /** ISO-8601 timestamp of the first observation. */
  readonly at: string;
}

export interface ActivityInput {
  readonly id: string;
  readonly network: NetworkKey;
  readonly title: string;
  readonly status?: ActivityStatus;
  readonly reference?: string;
  readonly url?: string;
  readonly at?: string;
}

export type ActivityPatch = Partial<
  Pick<ActivityEntry, "status" | "title" | "reference" | "url">
>;

interface ActivityState {
  readonly entries: readonly ActivityEntry[];
  /** Insert or merge an entry (newest first, capped at MAX_ACTIVITY_ENTRIES). */
  upsert: (input: ActivityInput) => void;
  update: (id: string, patch: ActivityPatch) => void;
  clear: (networks?: readonly NetworkKey[]) => void;
}

export const ACTIVITY_STORAGE_KEY = "kletia-activity";
export const MAX_ACTIVITY_ENTRIES = 100;
const STATUSES: readonly ActivityStatus[] = ["pending", "confirmed", "failed"];

const clip = (value: string, max: number) => value.trim().slice(0, max);

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeEntry(value: unknown): ActivityEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id.trim() ||
    candidate.id.length > 200 ||
    !isNetworkKey(candidate.network) ||
    typeof candidate.title !== "string" ||
    !candidate.title.trim() ||
    !STATUSES.includes(candidate.status as ActivityStatus) ||
    typeof candidate.at !== "string" ||
    !Number.isFinite(Date.parse(candidate.at))
  ) {
    return null;
  }
  const reference =
    typeof candidate.reference === "string" &&
    /^[A-Za-z0-9]{16,128}$/u.test(candidate.reference)
      ? candidate.reference
      : undefined;
  const url = safeUrl(candidate.url);
  return {
    id: clip(candidate.id, 200),
    network: candidate.network,
    title: clip(candidate.title, 160),
    status: candidate.status as ActivityStatus,
    at: new Date(Date.parse(candidate.at)).toISOString(),
    ...(reference ? { reference } : {}),
    ...(url ? { url } : {}),
  };
}

function sanitizeEntries(value: unknown): ActivityEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: ActivityEntry[] = [];
  for (const raw of value) {
    const entry = sanitizeEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length >= MAX_ACTIVITY_ENTRIES) break;
  }
  return entries;
}

function mergeEntry(
  existing: ActivityEntry | undefined,
  input: ActivityInput,
): ActivityEntry | null {
  const url =
    safeUrl(input.url) ??
    existing?.url ??
    (input.reference ? safeUrl(explorerTxUrl(input.network, input.reference)) : undefined);
  return sanitizeEntry({
    id: input.id,
    network: input.network,
    title: input.title || existing?.title,
    status: input.status ?? existing?.status ?? "confirmed",
    reference: input.reference ?? existing?.reference,
    url,
    at: existing?.at ?? input.at ?? new Date().toISOString(),
  });
}

export const useActivityStore = create<ActivityState>()(
  persist(
    (set) => ({
      entries: [],
      upsert: (input) =>
        set((state) => {
          const existing = state.entries.find((entry) => entry.id === input.id);
          const merged = mergeEntry(existing, input);
          if (!merged) return state;
          const rest = state.entries.filter((entry) => entry.id !== input.id);
          return {
            entries: existing
              ? state.entries.map((entry) => (entry.id === input.id ? merged : entry))
              : [merged, ...rest].slice(0, MAX_ACTIVITY_ENTRIES),
          };
        }),
      update: (id, patch) =>
        set((state) => {
          const existing = state.entries.find((entry) => entry.id === id);
          if (!existing) return state;
          const merged = mergeEntry(existing, {
            ...existing,
            ...patch,
            id,
            network: existing.network,
          });
          if (!merged) return state;
          return {
            entries: state.entries.map((entry) => (entry.id === id ? merged : entry)),
          };
        }),
      clear: (networks) =>
        set((state) => ({
          entries: networks
            ? state.entries.filter((entry) => !networks.includes(entry.network))
            : [],
        })),
    }),
    {
      name: ACTIVITY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ entries: state.entries }),
      migrate: (persisted) => ({
        entries: sanitizeEntries(
          persisted && typeof persisted === "object"
            ? (persisted as { entries?: unknown }).entries
            : undefined,
        ),
      }),
      merge: (persisted, current) => ({
        ...current,
        entries: sanitizeEntries(
          persisted && typeof persisted === "object"
            ? (persisted as { entries?: unknown }).entries
            : undefined,
        ),
      }),
    },
  ),
);

/**
 * Record an activity entry and announce it on the bus so other features (and
 * other open panels) can react. Re-recording the same id merges the entry.
 */
export function recordActivity(input: ActivityInput): void {
  useActivityStore.getState().upsert(input);
  const stored = useActivityStore
    .getState()
    .entries.find((entry) => entry.id === input.id);
  if (!stored) return;
  emitActivityRecorded({
    id: stored.id,
    network: stored.network,
    title: stored.title,
    ...(stored.reference ? { reference: stored.reference } : {}),
    ...(stored.url ? { url: stored.url } : {}),
  });
}

export function updateActivity(id: string, patch: ActivityPatch): void {
  useActivityStore.getState().update(id, patch);
}

// Activity announced by any feature (including ones that do not import this
// store) lands in the feed. Existing entries keep their status.
kletiaBus.on("activity.recorded", (payload) => {
  useActivityStore.getState().upsert({
    id: payload.id,
    network: payload.network,
    title: payload.title,
    ...(payload.reference ? { reference: payload.reference } : {}),
    ...(payload.url ? { url: payload.url } : {}),
  });
});
