/**
 * The /networks H1 states the live status (portal design S-10): "All 9
 * networks are running", "Solana is slow", "2 networks are not answering",
 * "Status unavailable". Pure: it reads one GET /v1/health answer (or none)
 * and uses the departure board's own thresholds, so the headline and the
 * board never disagree.
 */
import { CHAINS, isNetworkKey } from "@kletia/core";

import { DELAYED_ABOVE_MS } from "../../site/art/boardFormat.ts";

export type StatusTone = "ok" | "slow" | "down" | "unknown" | "checking";

export interface StatusHeadline {
  readonly text: string;
  readonly tone: StatusTone;
}

interface Reading {
  readonly network: string;
  readonly ok?: boolean | null;
  readonly latencyMs?: number | null;
}

export interface HeadlineInput {
  /** "loading" before the first answer, "success" with a report, anything else when the API did not answer. */
  readonly status: "idle" | "loading" | "success" | "error";
  readonly report?: { readonly networks?: readonly Reading[] | null } | null;
}

function nameOf(key: string): string {
  return isNetworkKey(key) ? CHAINS[key].name : key;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The headline for one health answer. Down beats slow; a network without a reading is not counted as running. */
export function statusHeadline(input: HeadlineInput): StatusHeadline {
  const readings = Array.isArray(input.report?.networks) ? input.report.networks : null;
  if (!readings) {
    return input.status === "loading" || input.status === "idle"
      ? { text: "Checking every network", tone: "checking" }
      : { text: "Status unavailable", tone: "unknown" };
  }
  const answered = readings.filter((reading) => reading.ok === true || reading.ok === false);
  if (answered.length === 0) return { text: "Status unavailable", tone: "unknown" };
  const down = answered.filter((reading) => reading.ok === false);
  if (down.length > 0) {
    return {
      text: down.length === 1 ? `${nameOf(down[0]!.network)} is not answering` : `${down.length} networks are not answering`,
      tone: "down",
    };
  }
  const slow = answered.filter((reading) => typeof reading.latencyMs === "number" && reading.latencyMs > DELAYED_ABOVE_MS);
  if (slow.length > 0) {
    return {
      text: slow.length === 1 ? `${nameOf(slow[0]!.network)} is slow` : `${slow.length} networks are slow`,
      tone: "slow",
    };
  }
  const silent = readings.length - answered.length;
  if (silent > 0) {
    return { text: `${answered.length} of ${readings.length} ${plural(readings.length, "network", "networks")} answered`, tone: "unknown" };
  }
  return {
    text: answered.length === 1 ? `${nameOf(answered[0]!.network)} is running` : `All ${answered.length} networks are running`,
    tone: "ok",
  };
}
