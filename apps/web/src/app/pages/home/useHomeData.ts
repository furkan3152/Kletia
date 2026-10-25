/**
 * Live data for the home page: GET /v1/health, fetched once after the first paint and shared by
 * the tape, the hero's "answering now" and the cartridge bay (`useApiResource` has no cache: two
 * components calling it would make two requests). Counts of networks and protocols come from the
 * registry compiled into @kletia/core, so the copy never shifts when the answer arrives.
 */
import type { HealthReport } from "@kletia/sdk";

import { fetchHealth } from "../../../shared/platform/platformApi";
import { useApiResource, type ApiResource } from "../../../shared/platform/useApiResource";

export interface HomeData {
  readonly health: ApiResource<HealthReport>;
}

export function useHomeData(): HomeData {
  const health = useApiResource("health", fetchHealth);
  return { health };
}
