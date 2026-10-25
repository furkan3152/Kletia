/**
 * Network status for the departure board: `GET /v1/networks` once and
 * `GET /v1/health` every minute while the tab is visible. A failed read
 * keeps the last reading; nothing here disables a network except an
 * explicit `ok: false` or a network the deployment omits.
 */
import { useEffect, useState } from "react";
import { isNetworkKey, type NetworkKey } from "@kletia/core";

import { getKletiaClient } from "../../../shared/platform/kletiaClient";
import { fetchHealth, fetchNetworks } from "../../../shared/platform/platformApi";
import { actionsByNetwork, type NetworkActions } from "../content/starters";
import { healthReadings, offeredNetworks, type HealthReading } from "../state/deskModel";

export const HEALTH_INTERVAL_MS = 60_000;

export interface NetworkStatus {
  readonly health: Readonly<Partial<Record<NetworkKey, HealthReading>>>;
  /** Network keys the deployment offers; null until `GET /v1/networks` answered. */
  readonly offered: readonly NetworkKey[] | null;
  /** Action kinds per network (starters); null until known. */
  readonly actions: NetworkActions;
  /** When health was last read (ISO); null before the first reading. */
  readonly healthAt: string | null;
  /** Latest block (EVM) or slot (Solana) per network from the last health read (the machine's LCD). */
  readonly heights: Readonly<Partial<Record<NetworkKey, string>>>;
  /** The API process uptime from the last health read; null before it. */
  readonly uptimeSeconds: number | null;
}

const EMPTY: NetworkStatus = { health: {}, offered: null, actions: null, healthAt: null, heights: {}, uptimeSeconds: null };

/** Block heights by network from a health report (unknown keys and missing heights are dropped). */
export function healthHeights(networks: readonly { readonly network: string; readonly height?: string }[] | null | undefined): Partial<Record<NetworkKey, string>> {
  const heights: Partial<Record<NetworkKey, string>> = {};
  for (const entry of networks ?? []) {
    if (isNetworkKey(entry.network) && typeof entry.height === "string" && /^\d+$/u.test(entry.height)) heights[entry.network] = entry.height;
  }
  return heights;
}

export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(EMPTY);

  useEffect(() => {
    const controller = new AbortController();
    let client: ReturnType<typeof getKletiaClient>;
    try {
      client = getKletiaClient();
    } catch {
      return () => controller.abort();
    }
    fetchNetworks(client, controller.signal).then(
      (networks) => {
        if (controller.signal.aborted) return;
        setStatus((current) => ({ ...current, offered: offeredNetworks(networks), actions: actionsByNetwork(networks) }));
      },
      () => undefined,
    );
    let timer = 0;
    const readHealth = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        fetchHealth(client, controller.signal).then(
          (report) => {
            if (controller.signal.aborted) return;
            setStatus((current) => ({
              ...current,
              health: healthReadings(report.networks),
              healthAt: new Date().toISOString(),
              heights: healthHeights(report.networks),
              uptimeSeconds: typeof report.uptimeSeconds === "number" ? report.uptimeSeconds : null,
            }));
          },
          () => undefined,
        );
      }
      timer = window.setTimeout(readHealth, HEALTH_INTERVAL_MS);
    };
    readHealth();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  return status;
}
