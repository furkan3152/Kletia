import { resolveErrorCode } from "@kletia/core";
import { ArrowDownRight, CircleAlert, Clock, Gauge, Repeat2, WifiOff } from "lucide-react";
import React, { useId, useRef, useState } from "react";

import { Link } from "../../../routes/Link";
import { Badge, type BadgeTone } from "../../../site/ui/Badge";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { CopyButton } from "../../../site/ui/CopyButton";
import { JsonView } from "../../../site/ui/JsonView";
import { cx, FOCUS_RING, INK_BORDER_THIN, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { nextTabIndex } from "../../../site/ui/tabKeys";
import { errorEnvelope, parseRateLimit, type ExplorerExchange, type StreamFrame } from "./http";

export type ExplorerResult =
  | { readonly state: "loading" }
  | { readonly state: "done"; readonly exchange: ExplorerExchange }
  | { readonly state: "failed"; readonly kind: "timeout" | "network" | "aborted"; readonly message: string };

const READABLE_HEADERS = ["x-request-id", "ratelimit", "ratelimit-policy", "retry-after", "idempotent-replayed", "mcp-session-id", "mcp-protocol-version"];

function statusTone(status: number): BadgeTone {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "blue";
  return "green";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function header(exchange: ExplorerExchange, name: string): string | null {
  return exchange.headers.find(([key]) => key === name)?.[1] ?? null;
}

function RateLimitMeter({ exchange }: { readonly exchange: ExplorerExchange }) {
  const rate = parseRateLimit(exchange.headers);
  if (!rate || rate.remaining === null) return null;
  const limit = rate.limit ?? null;
  const used = limit !== null ? Math.max(0, limit - rate.remaining) : null;
  const percent = limit ? Math.min(100, Math.round(((used ?? 0) / limit) * 100)) : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-x-2 font-code text-[11px]">
        <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="font-bold">
          {rate.remaining}
          {limit !== null ? `/${limit}` : ""} left
        </span>
        {rate.policy ? <span className={TEXT_MUTED}>{rate.policy} tier</span> : null}
        {rate.resetSeconds !== null ? <span className={TEXT_MUTED}>· window resets in {rate.resetSeconds} s</span> : null}
      </p>
      {limit !== null ? (
        <div
          className="h-2 w-full max-w-56 border-2 border-[#1A1A1A] bg-white dark:border-[#4B5563] dark:bg-[#0B1120]"
          role="img"
          aria-label={`${used} of ${limit} requests used in this window`}
        >
          <div
            className={cx("h-full", percent > 85 ? "bg-[#FF5A5F]" : percent > 60 ? "bg-[#FFD60A]" : "bg-[#4ADE80]")}
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function StreamFrames({ frames, truncated }: { readonly frames: readonly StreamFrame[]; readonly truncated: boolean }) {
  if (frames.length === 0) {
    return <p className={cx("text-sm", TEXT_MUTED)}>The stream opened but sent no events within 8 seconds.</p>;
  }
  return (
    <ol className="flex max-h-[28rem] flex-col gap-2 overflow-auto pr-1" aria-label="Stream events">
      {frames.map((frame, index) => {
        let data: unknown = frame.data;
        try {
          data = JSON.parse(frame.data);
        } catch {
          // Plain text frame.
        }
        const type =
          frame.event ?? (typeof data === "object" && data !== null && "type" in data ? String((data as { type: unknown }).type) : "message");
        return (
          <li key={`${frame.id ?? index}-${index}`} className="kl-rise flex min-w-0 flex-col gap-1" style={{ "--kl-i": Math.min(index, 8) } as React.CSSProperties}>
            <p className="flex flex-wrap items-center gap-2 font-code text-[11px]">
              <Badge tone="blue">{type}</Badge>
              {frame.id ? <span className={TEXT_MUTED}>id: {frame.id}</span> : null}
            </p>
            <JsonView value={data} label={`Event ${index + 1}`} maxHeightClassName="max-h-60" />
          </li>
        );
      })}
      {truncated ? (
        <li className={cx("text-xs", TEXT_MUTED)}>The explorer stopped reading after 8 seconds or 40 events; the stream itself keeps going.</li>
      ) : null}
    </ol>
  );
}

type ViewTab = "body" | "headers";

/** Status line, rate-limit state, request id, error explanation and the body or headers of one exchange. */
function ExchangeView({ exchange }: { readonly exchange: ExplorerExchange }) {
  const baseId = useId();
  const [tab, setTab] = useState<ViewTab>("body");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestId = header(exchange, "x-request-id");
  const replayed = header(exchange, "idempotent-replayed") === "true";
  const retryAfter = header(exchange, "retry-after");
  const error = errorEnvelope(exchange.body);
  // The catalog entry to link to: the one error.docs names, else the code's family (RELAY_UNAVAILABLE → PROVIDER_UNAVAILABLE).
  const errorAnchor = error ? (/#error-([A-Z0-9_]+)$/u.exec(error.docs ?? "")?.[1] ?? resolveErrorCode(error.code) ?? error.code) : null;
  const isSvg = exchange.contentType?.includes("image/svg+xml") ?? false;
  const tabs: readonly { id: ViewTab; label: string }[] = [
    { id: "body", label: exchange.frames ? `Events (${exchange.frames.length})` : "Body" },
    { id: "headers", label: `Headers (${exchange.headers.length})` },
  ];
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, tabs.length);
    if (next === null) return;
    event.preventDefault();
    setTab(tabs[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="kl-rise flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 font-code text-xs">
        <Badge key={exchange.seq} tone={statusTone(exchange.status)} className="kl-stamp !text-[11px]">
          {exchange.status} {exchange.statusText || ""}
        </Badge>
        <span className={cx("inline-flex items-center gap-1 px-1.5 py-0.5", INK_BORDER_THIN)}>
          <Clock className="h-3 w-3" aria-hidden="true" />
          {exchange.latencyMs} ms
        </span>
        <span className={cx("px-1.5 py-0.5", INK_BORDER_THIN)}>{formatBytes(exchange.sizeBytes)}</span>
        {exchange.contentType ? <span className={TEXT_MUTED}>{exchange.contentType.split(";")[0]}</span> : null}
        {replayed ? (
          <Badge tone="purple" title="Idempotent-Replayed: true">
            <Repeat2 className="mr-1 inline h-3 w-3" aria-hidden="true" />
            Replayed
          </Badge>
        ) : null}
        {retryAfter ? <Badge tone="yellow">Retry-After {retryAfter} s</Badge> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <RateLimitMeter exchange={exchange} />
        {requestId ? (
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate font-code text-[11px]" title={requestId}>
              <span className={TEXT_MUTED}>X-Request-Id </span>
              {requestId}
            </p>
            <CopyButton text={requestId} label="Copy request id" appearance="light" notify="toast" />
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="flex flex-col gap-2 border-l-[6px] border-[#B91C1C] bg-[#FFE4E4] p-3 text-[#1A1A1A] dark:border-[#FCA5A5] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <code className="font-code font-bold">{error.code}</code>
            <span>{error.message}</span>
          </p>
          {error.hints && error.hints.length > 0 ? (
            <p className="text-xs">
              The grammar understands, for example: {error.hints.slice(0, 3).map((hint) => `“${hint}”`).join(", ")}
            </p>
          ) : null}
          <Link
            to={`/developers#error-${errorAnchor}`}
            className={cx("inline-flex w-fit items-center gap-1 text-xs font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}
          >
            What {errorAnchor} means and what to do
            <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      <div role="tablist" aria-label="Response view" className="flex gap-1 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        {tabs.map((item, index) => {
          const selected = item.id === tab;
          return (
            <button
              key={item.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${baseId}-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cx(
                "-mb-[3px] min-h-10 border-[3px] border-b-0 px-3 text-[11px] font-black uppercase tracking-[0.12em]",
                selected
                  ? "border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#4B5563]"
                  : "border-transparent text-[#45464B] hover:text-[#1A1A1A] dark:text-[#A9B6C8] dark:hover:text-white",
                FOCUS_RING,
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-${tab}`} className="min-w-0">
        {tab === "headers" ? (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 font-code text-[12px]">
            {exchange.headers.map(([name, value]) => (
              <React.Fragment key={name}>
                <dt className={cx("break-all", READABLE_HEADERS.includes(name) ? "font-bold" : TEXT_MUTED)}>{name}</dt>
                <dd className="break-all">{value}</dd>
              </React.Fragment>
            ))}
            <dt className="col-span-2 mt-2 font-sans text-xs text-[#45464B] dark:text-[#A9B6C8]">
              Browsers expose only the headers the API lists in Access-Control-Expose-Headers, plus a few safe ones.
            </dt>
          </dl>
        ) : exchange.frames ? (
          <StreamFrames frames={exchange.frames} truncated={exchange.truncated} />
        ) : exchange.status === 204 || exchange.bodyText === "" ? (
          <p className={cx("text-sm", TEXT_MUTED)}>No content.</p>
        ) : isSvg ? (
          <div className="flex flex-col gap-3">
            <div className={cx("flex items-center justify-center bg-white p-4", INK_BORDER_THIN)}>
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(exchange.bodyText)}`} alt="Status badge returned by the API" />
            </div>
            <CodeBlock code={exchange.bodyText} language="html" label="SVG source" filename="badge.svg" maxHeightClassName="max-h-60" />
          </div>
        ) : (
          <JsonView value={exchange.body} label={`Response body, ${exchange.method} ${exchange.url}`} maxHeightClassName="max-h-[32rem]" />
        )}
      </div>
    </div>
  );
}

export interface ResponseViewerProps {
  readonly result: ExplorerResult | null;
  readonly origin: string;
  readonly onRetry: () => void;
}

/** The response pane of the explorer: idle hint, waiting state, failure or the exchange. */
export function ResponseViewer({ result, origin, onRetry }: ResponseViewerProps) {
  if (!result) {
    return (
      <p className="border-[3px] border-dashed border-[#1A1A1A]/30 px-4 py-5 text-center text-sm text-[#45464B] dark:border-white/15 dark:text-[#A9B6C8]">
        Send the request to see the live response from <span className="break-all font-code">{origin}</span>.
      </p>
    );
  }
  if (result.state === "loading") {
    return (
      <div role="status" className="kl-hatch kl-loop relative overflow-hidden border-[3px] border-dashed border-[#1A1A1A]/40 px-4 py-5 text-center text-sm font-bold dark:border-white/20">
        <span className="relative">Waiting for the API…</span>
      </div>
    );
  }
  if (result.state === "failed") {
    return (
      <div
        role="alert"
        className="kl-rise flex flex-col gap-3 border-[3px] border-[#1A1A1A] bg-[#FFE4E4] p-4 text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]"
      >
        <p className="flex items-start gap-2 font-display text-lg font-bold leading-tight">
          <WifiOff className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          {result.kind === "timeout" ? "No response in time" : result.kind === "aborted" ? "Request cancelled" : "No response"}
        </p>
        <p className="text-sm">{result.message}</p>
        <p className="text-xs">
          The snippets below still work from your own terminal or server. Status of the hosted API:{" "}
          <Link to="/networks" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
            Networks
          </Link>
          .
        </p>
        {result.kind !== "aborted" ? (
          <button
            type="button"
            onClick={onRetry}
            className={cx(
              "w-fit border-2 border-current px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] hover:bg-white/40",
              FOCUS_RING,
            )}
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  }
  return <ExchangeView key={result.exchange.seq} exchange={result.exchange} />;
}

export function ResponseLabel() {
  return <p className={cx(LABEL, TEXT_MUTED)}>Response</p>;
}
