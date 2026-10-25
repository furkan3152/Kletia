/**
 * Live readouts for the home page (tape, cartridge bay, hero stat), formatted from the
 * GET /v1/health report. Pure and dependency-free (node --test loads it directly).
 *
 * Rule: the live site never shows a sample value as live. Without a
 * report every readout says so ("checking", "status unavailable"), never a typed number.
 */

/** The fields of a NetworkHealth entry this page reads. */
export interface NetReading {
  readonly network: string;
  readonly name?: string;
  readonly environment?: string;
  readonly ok: boolean;
  readonly latencyMs?: number;
  /** Latest block (EVM) or slot (Solana), as a decimal string. */
  readonly height?: string;
}

/** The fields of a HealthReport this page reads. */
export interface HealthLike {
  readonly status?: string;
  readonly version?: string;
  readonly time?: string;
  readonly uptimeSeconds?: number;
  readonly networks?: readonly NetReading[];
}

export type LiveState = "loading" | "live" | "unavailable";

/** What the page knows from GET /v1/health right now. */
export interface HomeLive {
  readonly state: LiveState;
  readonly report: HealthLike | null;
  /** When the report was read (epoch ms). */
  readonly at: number | null;
}

export interface TapeItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Lamp: on (answering), off (no reading), bad (did not answer). */
  readonly lamp: "on" | "off" | "bad";
}

const GROUP = /\B(?=(\d{3})+(?!\d))/gu;

/** "23481207" -> "23,481,207"; anything that is not a whole number is returned as is. */
export function groupDigits(value: string): string {
  return /^\d+$/u.test(value) ? value.replace(GROUP, ",") : value;
}

/** Solana networks report slots, EVM networks blocks. */
export function heightLabel(network: string, height: string | undefined): string | null {
  if (!height) return null;
  return `${network.startsWith("solana") ? "slot" : "block"} ${groupDigits(height)}`;
}

/** "212 ms" (rounded), "1.4 s" from a second up; null without a reading. */
export function latencyLabel(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** "3 d 4 h", "5 h 12 m", "42 m"; null without a reading. */
export function uptimeLabel(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} d ${hours % 24} h`;
  if (hours > 0) return `${hours} h ${minutes % 60} m`;
  return `${minutes} m`;
}

/** Readings by network key. */
export function readingsByKey(report: HealthLike | null | undefined): Map<string, NetReading> {
  const map = new Map<string, NetReading>();
  for (const entry of report?.networks ?? []) if (entry && typeof entry.network === "string") map.set(entry.network, entry);
  return map;
}

/** How many of `keys` answered the last check (null without a report). */
export function answering(report: HealthLike | null | undefined, keys: readonly string[]): { readonly ok: number; readonly total: number } | null {
  if (!report || !Array.isArray(report.networks)) return null;
  const readings = readingsByKey(report);
  return { ok: keys.filter((key) => readings.get(key)?.ok === true).length, total: keys.length };
}

/** One cartridge's readout lines (two short lines) and its lamp. */
export function cartridgeReadout(network: string, reading: NetReading | undefined, state: LiveState): { readonly lines: readonly string[]; readonly lamp: "on" | "off" | "bad"; readonly status: string } {
  if (state === "loading") return { lines: ["checking…", ""], lamp: "off", status: "checking" };
  if (state === "unavailable" || !reading) return { lines: ["no reading", ""], lamp: "off", status: "no reading" };
  if (!reading.ok) return { lines: ["no answer", ""], lamp: "bad", status: "no service" };
  return {
    lines: [`RPC ${latencyLabel(reading.latencyMs) ?? "—"}`, heightLabel(network, reading.height) ?? ""],
    lamp: "on",
    status: "running",
  };
}

/**
 * The tape: one item per network in `order` (name, round trip, height), then the API itself.
 * Loading and unavailable states print one honest item instead of numbers.
 */
export function tapeItems(report: HealthLike | null | undefined, state: LiveState, order: readonly { readonly key: string; readonly name: string }[]): TapeItem[] {
  if (state === "loading") return [{ key: "loading", label: "Network status", value: "checking GET /v1/health…", lamp: "off" }];
  if (state === "unavailable" || !report) {
    return [{ key: "down", label: "Network status", value: "status unavailable: the API did not answer from this browser", lamp: "bad" }];
  }
  const readings = readingsByKey(report);
  const items: TapeItem[] = [];
  for (const { key, name } of order) {
    const reading = readings.get(key);
    if (!reading) {
      items.push({ key, label: name, value: "no reading", lamp: "off" });
      continue;
    }
    if (!reading.ok) {
      items.push({ key, label: name, value: "did not answer", lamp: "bad" });
      continue;
    }
    const parts = [latencyLabel(reading.latencyMs) ? `RPC ${latencyLabel(reading.latencyMs)}` : null, heightLabel(key, reading.height)].filter(Boolean);
    items.push({ key, label: name, value: parts.join(" · ") || "answering", lamp: "on" });
  }
  const api = [report.status ? report.status : null, report.version ? `v${report.version.replace(/^v/u, "")}` : null, uptimeLabel(report.uptimeSeconds) ? `up ${uptimeLabel(report.uptimeSeconds)}` : null].filter(Boolean);
  items.push({ key: "api", label: "Kletia API", value: api.join(" · ") || "answering", lamp: report.status === "ok" ? "on" : report.status ? "bad" : "off" });
  return items;
}

/** "12:04 UTC" from an ISO time or epoch ms; null when unparsable. */
export function utcClock(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}
