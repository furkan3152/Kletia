/**
 * Pure helpers for the health panels: millisecond and uptime formatting, and
 * which networks changed state between two real `/v1/health` answers (for the
 * polite announcements on /networks).
 */
import type { HealthReport } from "@kletia/sdk";

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
