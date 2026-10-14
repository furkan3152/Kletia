import { useEffect, useMemo } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import type { PortalPageProps } from "../shell/portalRoutes";
import { ApiExplorer, type SpecSource } from "./ApiExplorer";
import { rememberLiveOperations } from "./liveSpec";
import { operationsFromOpenApi } from "./operations";
import type { OpenApiDoc } from "./schema";
import { STATIC_OPERATIONS } from "./staticOperations";

/**
 * API explorer (`/developers/api`, `/developers/api/<operationId>`): every
 * operation from the OpenAPI document the API serves, or the bundled
 * reference while it loads or when the API is unreachable. The path names
 * the operation; an unknown id shows the default with a notice.
 */
export default function ExplorerPage({ param }: PortalPageProps) {
  const spec = useApiResource<OpenApiDoc>("openapi", (client, signal) =>
    client.request<OpenApiDoc>("GET", "/openapi.json", undefined, { signal: sdkSignal(signal) }),
  );
  const liveOperations = useMemo(() => (spec.data ? operationsFromOpenApi(spec.data) : []), [spec.data]);
  // The search palette lists what the explorer read, without asking the API again.
  useEffect(() => rememberLiveOperations(liveOperations), [liveOperations]);
  const operations = liveOperations.length > 0 ? liveOperations : STATIC_OPERATIONS;
  const source: SpecSource =
    liveOperations.length > 0
      ? { state: "live", version: spec.data?.info?.version ?? null }
      : spec.status === "loading" || spec.status === "idle"
        ? { state: "loading" }
        : { state: "fallback", error: spec.error };

  return (
    <>
      <PortalPageHeader
        title="API explorer"
        intro="Every operation in Platform API v1, generated from the OpenAPI document the API serves. Requests go to the real API, planning defaults to a dry run, and prepare returns unsigned payloads only."
        className="pb-6"
      />
      <ApiExplorer operations={operations} source={source} onReloadSpec={spec.reload} param={param} />
    </>
  );
}
