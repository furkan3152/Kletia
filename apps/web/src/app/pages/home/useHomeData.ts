/**
 * Live data for the home page, fetched once and shared by its sections
 * (`useApiResource` has no cache: two components calling it would make two
 * requests).
 */
import type { HealthReport, NetworkCapabilities } from "@kletia/sdk";
import type { ProtocolDescriptor } from "@kletia/core";

import { fetchHealth, fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { useApiResource, type ApiResource } from "../../../shared/platform/useApiResource";

export interface HomeData {
  readonly health: ApiResource<HealthReport>;
  readonly networks: ApiResource<NetworkCapabilities[]>;
  readonly protocols: ApiResource<ProtocolDescriptor[]>;
  /** True when /v1/networks answered with at least one network. */
  readonly liveNetworks: boolean;
  /** True when /v1/protocols answered with at least one protocol. */
  readonly liveProtocols: boolean;
}

export function useHomeData(): HomeData {
  const health = useApiResource("health", fetchHealth);
  const networks = useApiResource("networks", fetchNetworks);
  const protocols = useApiResource("protocols", fetchProtocols);

  const liveNetworks = (networks.data?.length ?? 0) > 0;
  const liveProtocols = (protocols.data?.length ?? 0) > 0;

  return { health, networks, protocols, liveNetworks, liveProtocols };
}
