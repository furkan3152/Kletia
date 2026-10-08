import { useMemo } from "react";

import { fetchOpenApi, type OpenApiDocument, type OpenApiOperation } from "../../../shared/platform/platformApi";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Badge } from "../../site/ui/Badge";
import { cx, HARD_SHADOW, INK_BORDER, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { STATIC_ENDPOINTS, type EndpointSummary, type HttpMethod } from "./devContent";

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const METHOD_CLASS: Record<HttpMethod, string> = {
  GET: "bg-[#14F195] text-[#0B1120]",
  POST: "bg-[#0052FF] text-white",
  PUT: "bg-[#FFD60A] text-[#1A1A1A]",
  PATCH: "bg-[#FFD60A] text-[#1A1A1A]",
  DELETE: "bg-[#FF5A5F] text-[#1A1A1A]",
};

function isOperation(value: unknown): value is OpenApiOperation {
  return typeof value === "object" && value !== null;
}

function fromOpenApi(document: OpenApiDocument): EndpointSummary[] {
  const rows: EndpointSummary[] = [];
  for (const [rawPath, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const operation = (item as Record<string, unknown>)[method.toLowerCase()];
      if (!isOperation(operation)) continue;
      const path = rawPath.startsWith("/v1") ? rawPath : `/v1${rawPath}`;
      const secured = Array.isArray(operation.security) && operation.security.some((entry) => Object.keys(entry).length > 0);
      rows.push({
        method,
        path,
        summary: operation.summary ?? operation.description ?? operation.operationId ?? "",
        auth: secured ? "key" : "public",
      });
    }
  }
  return rows;
}

/** Endpoint list rendered from GET /v1/openapi.json, with a static fallback. */
export function EndpointReference() {
  const spec = useApiResource("openapi", fetchOpenApi);
  const live = useMemo(() => (spec.data ? fromOpenApi(spec.data) : []), [spec.data]);
  const rows = live.length > 0 ? live : STATIC_ENDPOINTS;
  const source =
    live.length > 0
      ? `Live from /v1/openapi.json${spec.data?.info?.version ? ` · v${spec.data.info.version}` : ""}`
      : spec.status === "loading"
        ? "Loading /v1/openapi.json…"
        : "Static reference from docs/platform/api-v1.md (API unreachable)";

  return (
    <div className={cx("min-w-0", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-[#1A1A1A] px-4 py-3 dark:border-[#4B5563]"
        aria-live="polite"
      >
        <p className="text-xs font-bold">{source}</p>
        <Badge tone={live.length > 0 ? "green" : "yellow"}>{live.length > 0 ? "OpenAPI 3.1" : "Fallback"}</Badge>
      </div>
      <ul className="divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10">
        {rows.map((row) => (
          <li
            key={`${row.method} ${row.path}`}
            className="grid grid-cols-[4.5rem_1fr] items-start gap-x-3 gap-y-1 px-4 py-3 md:grid-cols-[4.5rem_minmax(0,22rem)_1fr_auto] md:items-center"
          >
            <span className={cx("w-fit px-1.5 py-0.5 text-center font-code text-[11px] font-bold", METHOD_CLASS[row.method])}>
              {row.method}
            </span>
            <code className="min-w-0 break-all font-code text-[13px] font-semibold">{row.path}</code>
            <p className={cx("col-start-2 text-sm md:col-start-auto", TEXT_MUTED)}>{row.summary}</p>
            <span className="col-start-2 md:col-start-auto">
              <Badge tone={row.auth === "key" ? "yellow" : "neutral"}>{row.auth === "key" ? "Key" : "Public"}</Badge>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
