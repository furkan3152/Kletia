import { useMemo } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiExplorer, type SpecSource } from "../explorer/ApiExplorer";
import { operationsFromOpenApi } from "../explorer/operations";
import type { OpenApiDoc } from "../explorer/schema";
import { STATIC_OPERATIONS } from "../explorer/staticOperations";
import { AnchorScope } from "../shell/AnchorScope";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import type { PortalPageProps } from "../shell/portalRoutes";

/**
 * API explorer (`/developers/api`, `/developers/api/<operationId>`): every
 * operation from the OpenAPI document the API serves, or the bundled
 * reference when it is unreachable. The explorer still picks its operation
 * from an `#op-` anchor, so the path's operationId is handed to it as one.
 */
export default function ExplorerPage({ param }: PortalPageProps) {
  const spec = useApiResource<OpenApiDoc>("openapi", (client, signal) =>
    client.request<OpenApiDoc>("GET", "/openapi.json", undefined, { signal: sdkSignal(signal) }),
  );
  const liveOperations = useMemo(() => (spec.data ? operationsFromOpenApi(spec.data) : []), [spec.data]);
  const operations = liveOperations.length > 0 ? liveOperations : STATIC_OPERATIONS;
  const source: SpecSource =
    liveOperations.length > 0
      ? { state: "live", version: spec.data?.info?.version ?? null }
      : spec.status === "loading"
        ? { state: "loading" }
        : { state: "fallback", error: spec.error };

  return (
    <>
      <PortalPageHeader
        title="API explorer"
        intro="Every operation in Platform API v1, generated from the OpenAPI document the API serves. Requests go to the real API, planning defaults to a dry run, and nothing is signed here."
      />
      <AnchorScope hash={param ? `#op-${param}` : null}>
        <ApiExplorer operations={operations} source={source} onReloadSpec={spec.reload} />
      </AnchorScope>
    </>
  );
}
