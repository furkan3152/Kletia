/**
 * The portal bar's API status, read from GET /v1/health. Pure: the
 * polling hook is usePortalHealth.ts; the node tests load this file
 * directly.
 */
import type { HealthReport } from "@kletia/sdk";

import type { StatusTone } from "../../../site/ui/statusTones.ts";

export type ApiReadStatus = "idle" | "loading" | "success" | "error";

export type PortalHealthState = "checking" | "ok" | "slow" | "degraded" | "down" | "unreachable";

export interface PortalHealthView {
  readonly state: PortalHealthState;
  readonly tone: StatusTone;
  /** Short pill text: "API ok · 9/9", "7/9 networks", "API unreachable". */
  readonly label: string;
  /** One sentence for screen readers and the pill's title. */
  readonly detail: string;
  readonly networksUp: number | null;
  readonly networksTotal: number | null;
}

/** A response slower than this reads as "slow" even when every network answers. */
export const SLOW_HEALTH_MS = 3_000;
export const HEALTH_POLL_MS = 60_000;

const TONE: Readonly<Record<PortalHealthState, StatusTone>> = {
  checking: "neutral",
  ok: "success",
  slow: "warning",
  degraded: "warning",
  down: "danger",
  unreachable: "danger",
};

function view(state: PortalHealthState, label: string, detail: string, up: number | null = null, total: number | null = null): PortalHealthView {
  return { state, tone: TONE[state], label, detail, networksUp: up, networksTotal: total };
}

/**
 * What the pill says. A report never turns into zeros it did not contain:
 * without one the state is "checking" (nothing read yet) or "unreachable".
 */
export function classifyHealth(input: {
  readonly report: Pick<HealthReport, "status" | "networks"> | null | undefined;
  readonly status: ApiReadStatus;
  readonly error: { readonly status: number; readonly unreachable: boolean } | null;
  readonly latencyMs: number | null;
}): PortalHealthView {
  const { report, status, error, latencyMs } = input;
  if (error && (status === "error" || !report)) {
    return view("unreachable", "API unreachable", "The Kletia API is not answering from this browser.");
  }
  if (!report || !Array.isArray(report.networks)) {
    return view("checking", "Checking API", "Checking whether the Kletia API answers.");
  }
  const total = report.networks.length;
  const up = report.networks.filter((network) => network?.ok === true).length;
  const counts = `${up}/${total}`;
  if (report.status === "down" || (total > 0 && up === 0)) {
    return view("down", `${counts} networks`, `The API answers, but none of its ${total} networks do.`, up, total);
  }
  if (report.status === "degraded" || up < total) {
    return view("degraded", `${counts} networks`, `The API answers; ${up} of ${total} networks answer.`, up, total);
  }
  if (latencyMs !== null && latencyMs > SLOW_HEALTH_MS) {
    return view("slow", `API slow · ${counts}`, `The API answers slowly (${Math.round(latencyMs / 100) / 10} s); all ${total} networks answer.`, up, total);
  }
  return view("ok", `API ok · ${counts}`, `The API and all ${total} networks answer.`, up, total);
}
