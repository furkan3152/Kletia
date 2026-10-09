/**
 * Departure board rows from a GET /v1/health report. Rows follow the
 * @kletia/core registry (production lines, then the test yard); a network the
 * API reports but this bundle does not know is returned separately so the
 * page can still mention it.
 */
import type { HealthReport } from "@kletia/sdk";

import { boardStatus, lineFor, PRODUCTION_LINES, YARD_LINES, type BoardRow } from "../../site/art";
import type { ApiResource } from "../../../shared/platform/useApiResource";

type NetworkHealth = HealthReport["networks"][number];

export interface BoardData {
  readonly rows: BoardRow[];
  /** Readings for networks the registry in this bundle does not know. */
  readonly unknown: NetworkHealth[];
  /** True once a report arrived (live timings on the board). */
  readonly live: boolean;
  /** First load still running: rows read "Checking". */
  readonly loading: boolean;
}

export function boardData(health: ApiResource<HealthReport>): BoardData {
  const report = health.status === "success" ? health.data : health.data ?? undefined;
  const entries = Array.isArray(report?.networks) ? report.networks : [];
  const byKey = new Map<string, NetworkHealth>();
  const unknown: NetworkHealth[] = [];
  for (const entry of entries) {
    const line = lineFor(entry.network);
    if (line) byKey.set(line.key, entry);
    else unknown.push(entry);
  }
  const loading = health.status === "loading" && !report;
  const rows = [...PRODUCTION_LINES, ...YARD_LINES].map((line): BoardRow => {
    const entry = byKey.get(line.key);
    return {
      line,
      latencyMs: typeof entry?.latencyMs === "number" ? entry.latencyMs : null,
      status: boardStatus(entry ?? null, { loading }),
    };
  });
  return { rows, unknown, live: Boolean(report), loading };
}
