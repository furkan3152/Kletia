/**
 * Live data for the home page, fetched once and shared by the stats band and
 * the live status panel (`useApiResource` has no cache: two components
 * calling it would make two requests).
 */
import { PROTOCOLS } from "@kletia/core";
import type { HealthReport, NetworkCapabilities } from "@kletia/sdk";
import type { ProtocolDescriptor } from "@kletia/core";

import { fetchHealth, fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { registryNetworks } from "../../../shared/platform/registry";
import { useApiResource, type ApiResource } from "../../../shared/platform/useApiResource";
import { intentKinds } from "../protocols/protocolStats";

export interface HomeData {
  readonly health: ApiResource<HealthReport>;
  readonly networks: ApiResource<NetworkCapabilities[]>;
  readonly protocols: ApiResource<ProtocolDescriptor[]>;
  /** True when /v1/networks answered with at least one network. */
  readonly liveNetworks: boolean;
  /** True when /v1/protocols answered with at least one protocol. */
  readonly liveProtocols: boolean;
  /** Protocol count: live when available, else the registry compiled into @kletia/core. */
  readonly protocolCount: number;
  /** Distinct intent kinds across networks (live, else registry). */
  readonly intentKindCount: number;
  /** Networks reporting a healthy RPC / networks reported (null until a health check succeeds). */
  readonly networksOnline: { readonly ok: number; readonly total: number } | null;
}

export function useHomeData(): HomeData {
  const health = useApiResource("health", fetchHealth);
  const networks = useApiResource("networks", fetchNetworks);
  const protocols = useApiResource("protocols", fetchProtocols);

  const liveNetworks = (networks.data?.length ?? 0) > 0;
  const liveProtocols = (protocols.data?.length ?? 0) > 0;
  const protocolCount = liveProtocols ? protocols.data!.length : PROTOCOLS.length;
  const intentKindCount = intentKinds(liveNetworks ? networks.data! : registryNetworks()).length;
  const report = health.status === "success" ? health.data : undefined;
  const entries = Array.isArray(report?.networks) ? report.networks : null;
  const networksOnline = entries ? { ok: entries.filter((entry) => entry.ok).length, total: entries.length } : null;

  return { health, networks, protocols, liveNetworks, liveProtocols, protocolCount, intentKindCount, networksOnline };
}
