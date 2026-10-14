/**
 * One GET /v1/health read for the whole portal: when the portal opens, then
 * every 60 s while the tab is visible. The shell owns it, so pages never
 * poll on their own.
 */
import type { HealthReport } from "@kletia/sdk";
import { useEffect, useMemo, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { classifyHealth, HEALTH_POLL_MS, type PortalHealthView } from "./healthModel";

export interface PortalHealth extends PortalHealthView {
  readonly retry: () => void;
}

/** One health read for the whole portal, refreshed every minute while the tab is visible. */
export function usePortalHealth(): PortalHealth {
  const [round, setRound] = useState(0);
  const health = useApiResource<HealthReport>(`portal-health:${round}`, (client, signal) => client.health({ signal: sdkSignal(signal) }));
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (Date.now() - last < HEALTH_POLL_MS - 1_000) return;
      last = Date.now();
      setRound((value) => value + 1);
    };
    const timer = window.setInterval(refresh, HEALTH_POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const { data, status, error, latencyMs, reload } = health;
  return useMemo(
    () => ({ ...classifyHealth({ report: data ?? null, status, error, latencyMs }), retry: reload }),
    [data, status, error, latencyMs, reload],
  );
}
