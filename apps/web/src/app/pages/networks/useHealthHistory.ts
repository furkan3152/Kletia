/**
 * Latency samples per network for this page session, plus the pure helpers
 * LatencyBar and the status panels share. Only real `/v1/health` answers are
 * recorded: nothing is invented, nothing is persisted.
 */
import type { HealthReport } from "@kletia/sdk";
import { useState } from "react";

export const HISTORY_LENGTH = 12;
/** Latency that fills the bar completely (log scale). */
export const LATENCY_CEILING_MS = 2000;

export type LatencyTone = "fast" | "ok" | "slow";

export const LATENCY_COLORS: Readonly<Record<LatencyTone, string>> = {
  fast: "#14F195",
  ok: "#FFD60A",
  slow: "#FF5A5F",
};

export function latencyTone(ms: number): LatencyTone {
  if (ms < 200) return "fast";
  if (ms < 600) return "ok";
  return "slow";
}

/** Bar fill in [0, 1]: `min(1, log10(ms) / log10(2000))`; sub-millisecond values show a sliver. */
export function latencyScale(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const value = Math.log10(Math.max(1, ms)) / Math.log10(LATENCY_CEILING_MS);
  return Math.max(0.04, Math.min(1, value));
}

export function formatMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}

/** "1d 4h", "3h 12m", "45s". */
export function formatUptime(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

export type HealthHistory = Readonly<Record<string, readonly number[]>>;

/** Appends one report's latencies (newest last, at most 12 per network). */
export function appendHealthSample(history: HealthHistory, report: HealthReport): HealthHistory {
  const next: Record<string, readonly number[]> = { ...history };
  const networks = Array.isArray(report.networks) ? report.networks : [];
  for (const entry of networks) {
    if (!entry || typeof entry.network !== "string") continue;
    const ms = entry.latencyMs;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) continue;
    next[entry.network] = [...(history[entry.network] ?? []), ms].slice(-HISTORY_LENGTH);
  }
  return next;
}

/**
 * Keeps the last 12 latency samples per network from successful health
 * checks seen by this component. `report` must be the fresh value of a
 * successful check (not stale data kept during an error).
 */
export function useHealthHistory(report: HealthReport | undefined, updatedAt: number | null): HealthHistory {
  const [state, setState] = useState<{ readonly at: number | null; readonly history: HealthHistory }>({
    at: null,
    history: {},
  });
  if (report && updatedAt !== null && updatedAt !== state.at) {
    const next = { at: updatedAt, history: appendHealthSample(state.history, report) };
    setState(next);
    return next.history;
  }
  return state.history;
}

export interface HealthChange {
  readonly network: string;
  readonly ok: boolean;
}

/** Networks whose RPC state flipped between two reports. */
export function healthChanges(previous: HealthReport | undefined, current: HealthReport): HealthChange[] {
  if (!previous) return [];
  const before = new Map((previous.networks ?? []).map((entry) => [entry.network, entry.ok]));
  const changes: HealthChange[] = [];
  for (const entry of current.networks ?? []) {
    const was = before.get(entry.network);
    if (was !== undefined && was !== entry.ok) changes.push({ network: entry.network, ok: entry.ok });
  }
  return changes;
}
