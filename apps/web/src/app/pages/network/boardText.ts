import type { HealthReport } from "@kletia/sdk";

import type { ApiResource } from "../../../shared/platform/useApiResource";
import { formatBoardClock } from "../../site/art/boardFormat";
import type { KletiaReading, LykiaLive } from "./networkData";

/** "14:02 UTC" for the board clock: the time of the latest live answer, or a state word. */
export function boardClock(live: LykiaLive): string {
  if (live.state === "loading") return "--:-- UTC";
  if (live.state === "offline" || live.at === null) return "OFFLINE";
  return formatBoardClock(new Date(live.at));
}

/** The note under the board: where the live reading comes from, said plainly. */
export function boardNote(live: LykiaLive): string {
  if (live.state === "live") return "Coast Line readings come live from Lykia's public API (GET /v1/health and /v1/stats), relayed by Kletia's API and cached for a minute. Elyia is on testnet and has no public API yet.";
  if (live.state === "loading") return "Asking Lykia's public API for the Coast Line's latest reading.";
  return "Lykia's API did not answer from this browser in time, so the Coast Line shows no reading. Nothing on this board is estimated.";
}

/** Kletia's own row: networks answering in its GET /v1/health. */
export function kletiaReading(health: ApiResource<HealthReport>): KletiaReading {
  const report = health.status === "success" ? health.data : undefined;
  if (report?.networks?.length) {
    return { state: "live", ok: report.networks.filter((entry) => entry.ok).length, total: report.networks.length };
  }
  return { state: health.status === "loading" ? "loading" : "offline" };
}

