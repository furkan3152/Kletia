import { ERROR_CATEGORIES, errorCatalogRows, errorDocsUrl, resolveErrorCode, type KletiaErrorCategory } from "@kletia/core";
import type { ErrorCatalogResponse } from "@kletia/sdk";
import { RefreshCw, Search, X } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";

import { sdkSignal } from "../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { useRoute } from "../../routes/useRoute";
import { Badge } from "../../site/ui/Badge";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { CopyLinkButton } from "./components/CopyLinkButton";

interface ErrorRow {
  readonly code: string;
  readonly status: number | null;
  readonly otherStatuses?: readonly number[];
  readonly category: string;
  readonly retryable: boolean;
  readonly step?: boolean;
  readonly title: string;
  readonly remedy: string;
  readonly docs: string;
}

const CATEGORY_LABEL: Record<KletiaErrorCategory, string> = {
  request: "Request",
  authentication: "Authentication",
  permission: "Permission",
  not_found: "Not found",
  conflict: "Conflict",
  expired: "Expired",
  intent: "Intent",
  verification: "Verification",
  settlement: "Settlement",
  rate_limit: "Rate limit",
  upstream: "Upstream",
  unavailable: "Unavailable",
  internal: "Internal",
};

const ERROR_HASH = /^#error-([A-Z][A-Z0-9_]*)$/u;
const CATEGORY_PREVIEW = 4;

function categoryLabel(category: string): string {
  return (CATEGORY_LABEL as Record<string, string>)[category] ?? category;
}

function bundledRows(): ErrorRow[] {
  return errorCatalogRows().map((row) => ({ ...row, docs: errorDocsUrl(row.code) }));
}

function statusText(row: ErrorRow): string {
  if (row.status === null) return "step";
  return [row.status, ...(row.otherStatuses ?? [])].join(" / ");
}

function statusTone(row: ErrorRow): "neutral" | "yellow" | "red" | "purple" {
  if (row.status === null) return "purple";
  if (row.status >= 500) return "red";
  if (row.status === 429 || row.status === 409) return "yellow";
  return "neutral";
}

/** The error catalog from GET /v1/errors (bundled @kletia/core copy offline), with search and #error-CODE anchors. */
export function ErrorsReference() {
  const searchId = useId();
  const live = useApiResource<ErrorCatalogResponse>("errors", (client, signal) =>
    client.request<ErrorCatalogResponse>("GET", "/errors", undefined, { signal: sdkSignal(signal) }),
  );
  const rows: readonly ErrorRow[] = useMemo(() => {
    const fromApi = live.data?.errors;
    return Array.isArray(fromApi) && fromApi.length > 0 ? fromApi : bundledRows();
  }, [live.data]);
  const fromApi = Boolean(live.data?.errors?.length);

  const { location } = useRoute();
  const target = ERROR_HASH.exec(location.hash)?.[1] ?? null;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [retryableOnly, setRetryableOnly] = useState(false);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [seenLocation, setSeenLocation] = useState<number | null>(null);
  if (seenLocation !== location.key) {
    setSeenLocation(location.key);
    // A link to one error clears the filters so its row is on the page.
    if (target) {
      setQuery("");
      setCategory("all");
      setRetryableOnly(false);
    }
  }

  const deferred = useDeferredValue(query);
  const needle = deferred.trim().toLowerCase();
  const family = /^[A-Z][A-Z0-9_]+$/u.test(deferred.trim()) ? resolveErrorCode(deferred.trim()) : null;
  const familyHint = family && family !== deferred.trim() ? family : null;

  const filtered = rows.filter((row) => {
    if (category !== "all" && row.category !== category) return false;
    if (retryableOnly && !row.retryable) return false;
    if (!needle) return true;
    if (familyHint && row.code === familyHint) return true;
    return (
      row.code.toLowerCase().includes(needle) ||
      row.title.toLowerCase().includes(needle) ||
      row.remedy.toLowerCase().includes(needle) ||
      String(row.status ?? "step").includes(needle)
    );
  });

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  const categories = [
    ...ERROR_CATEGORIES.filter((item) => counts.has(item)),
    ...[...counts.keys()].filter((item) => !(ERROR_CATEGORIES as readonly string[]).includes(item)),
  ];
  const grouped = categories
    .map((item) => ({ category: item, rows: filtered.filter((row) => row.category === item) }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold" aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={fromApi ? "green" : live.status === "loading" ? "neutral" : "yellow"}>
              {fromApi ? "Live" : live.status === "loading" ? "Loading" : "Bundled"}
            </Badge>
            {fromApi
              ? `GET /v1/errors · ${rows.length} codes`
              : live.status === "loading"
                ? `Reading /v1/errors… showing the ${rows.length} codes bundled with @kletia/core`
                : `The API is unreachable: showing the ${rows.length} codes bundled with @kletia/core`}
          </p>
          {!fromApi && live.status === "error" ? (
            <button type="button" onClick={live.reload} className={cx("inline-flex items-center gap-1 underline decoration-2 underline-offset-2", FOCUS_RING)}>
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Retry
            </button>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={searchId} className={cx(LABEL, "text-[#1A1A1A] dark:text-[#E2E8F0]")}>
            Search codes, titles and fixes
          </label>
          <div className="relative flex min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#45464B] dark:text-[#A9B6C8]" aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="INTENT_UNSUPPORTED, 409, slippage, RELAY_UNAVAILABLE…"
              autoComplete="off"
              spellCheck={false}
              className={cx(
                "min-h-11 w-full min-w-0 border-[3px] border-[#1A1A1A] bg-white py-2 pl-9 pr-10 text-[15px] text-[#1A1A1A] placeholder:text-[#6B7280] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#F1F5F9] dark:placeholder:text-[#64748B]",
                FOCUS_RING,
              )}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className={cx("absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center", FOCUS_RING)}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {familyHint ? (
            <p className="text-xs">
              <code className="font-code font-bold">{deferred.trim()}</code> is a provider code: it means{" "}
              <Link to={`/developers#error-${familyHint}`} className={cx("font-code font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                {familyHint}
              </Link>
              .
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Category">
          {["all", ...categories].map((item) => {
            const selected = category === item;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={selected}
                onClick={() => setCategory(item)}
                className={cx(
                  "inline-flex min-h-8 items-center gap-1.5 border-2 border-[#1A1A1A] px-2 text-[11px] font-bold dark:border-[#4B5563]",
                  selected ? "bg-[#1A1A1A] text-white dark:bg-[#FFD60A] dark:text-[#1A1A1A]" : "bg-white hover:bg-[#FFF7CC] dark:bg-[#0B1120] dark:hover:bg-[#1A2841]",
                  FOCUS_RING,
                )}
              >
                {item === "all" ? "All" : categoryLabel(item)}
                <span className="font-code text-[10px] opacity-75">{item === "all" ? rows.length : counts.get(item)}</span>
              </button>
            );
          })}
          <label className="ml-auto inline-flex min-h-9 cursor-pointer items-center gap-2 text-xs font-bold">
            <input type="checkbox" checked={retryableOnly} onChange={(event) => setRetryableOnly(event.target.checked)} className="h-4 w-4 accent-[#0052FF]" />
            Retryable only
          </label>
        </div>
        <p className={cx("text-xs", TEXT_MUTED)} role="status">
          {filtered.length === rows.length ? `${rows.length} codes.` : `${filtered.length} of ${rows.length} codes match.`} Branch on{" "}
          <code className="font-code">error.code</code>, never on the message. <span className="font-bold">Step</span> codes appear as{" "}
          <code className="font-code">step.failure.code</code> on an intent, not as HTTP errors.
        </p>
      </div>

      {target && !rows.some((row) => row.code === target) ? (
        <p
          id={`error-${target}`}
          tabIndex={-1}
          className="kl-attn-ring kl-attn-ring--once scroll-mt-40 border-l-[6px] border-[#FFD60A] bg-[#FFF7CC] px-4 py-3 text-sm text-[#1A1A1A] outline-none dark:bg-[#2B2610] dark:text-[#FDF3C4] lg:scroll-mt-28"
        >
          <code className="font-code font-bold">{target}</code>{" "}
          {resolveErrorCode(target) && resolveErrorCode(target) !== target ? (
            <>
              is a provider code: it means{" "}
              <Link to={`/developers#error-${resolveErrorCode(target)}`} className={cx("font-code font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                {resolveErrorCode(target)}
              </Link>
              .
            </>
          ) : (
            "is not in this catalog. Search for part of it below, or check the API version."
          )}
        </p>
      ) : null}
      {grouped.length === 0 ? (
        <p className={cx("border-[3px] border-dashed border-[#1A1A1A]/30 p-6 text-center text-sm dark:border-white/15", TEXT_MUTED)}>
          No code matches “{deferred}”. Try a status such as 422, or part of a code.
        </p>
      ) : (
        grouped.map((group) => {
          // Long categories show a few codes until expanded; a search, a filter or a link to one code shows them all.
          const open = needle !== "" || category !== "all" || expanded.includes(group.category) || group.rows.some((row) => row.code === target);
          const shown = open || group.rows.length <= CATEGORY_PREVIEW + 2 ? group.rows : group.rows.slice(0, CATEGORY_PREVIEW);
          return (
            <section key={group.category} aria-label={`${categoryLabel(group.category)} errors`} className="min-w-0">
              <h3 className={cx(LABEL, "mb-2 flex items-center gap-2")}>
                {categoryLabel(group.category)}
                <span className={cx("font-code text-[10px]", TEXT_MUTED)}>{group.rows.length}</span>
              </h3>
              <ul className={cx("min-w-0 divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10", INK_BORDER, SURFACE)}>
                {shown.map((row) => {
                  const targeted = row.code === target;
                  return (
                    <li
                      key={row.code}
                      id={`error-${row.code}`}
                      tabIndex={-1}
                      className={cx(
                        "grid min-w-0 scroll-mt-40 lg:scroll-mt-28 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 px-3 py-2.5 outline-none sm:px-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto]",
                        targeted && "kl-attn-ring kl-attn-ring--once bg-[#FFF7CC] dark:bg-[#22345A]",
                      )}
                    >
                      <div className="flex min-w-0 flex-col items-start gap-1">
                        <code className="max-w-full break-all font-code text-[12.5px] font-bold">{row.code}</code>
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={statusTone(row)}>{statusText(row)}</Badge>
                          <Badge tone={row.retryable ? "green" : "outline"}>{row.retryable ? "Retry" : "No retry"}</Badge>
                          {row.step && row.status !== null ? <Badge tone="purple">Step</Badge> : null}
                        </span>
                      </div>
                      <CopyLinkButton href={row.docs} target={row.code} iconOnly className="col-start-2 row-start-1 self-start md:col-start-3" />
                      <div className="col-span-2 min-w-0 text-sm md:col-span-1 md:col-start-2 md:row-start-1">
                        <p className="font-bold">{row.title}</p>
                        <p className={cx("leading-relaxed", TEXT_MUTED)}>{row.remedy}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {shown.length < group.rows.length ? (
                <button
                  type="button"
                  onClick={() => setExpanded((previous) => [...previous, group.category])}
                  className={cx("mt-2 inline-flex min-h-9 items-center text-xs font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}
                >
                  Show all {group.rows.length} {categoryLabel(group.category).toLowerCase()} codes
                </button>
              ) : null}
            </section>
          );
        })
      )}
    </div>
  );
}

