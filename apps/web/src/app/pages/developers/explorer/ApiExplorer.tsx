import { ArrowDownRight, KeyRound, Link2, Play, RefreshCw, ShieldAlert, Square, WandSparkles } from "lucide-react";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";

import { PLATFORM_ORIGIN, type PlatformError } from "../../../../shared/platform/kletiaClient";
import { Link } from "../../../routes/Link";
import { useRoute } from "../../../routes/useRoute";
import { prefersReducedMotion } from "../../../site/motion/useReducedMotion";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { CopyLinkButton } from "../components/CopyLinkButton";
import { MethodBadge } from "../components/MethodBadge";
import { ApiKeyField } from "../keys/ApiKeyField";
import { useSessionKey } from "../keys/sessionKey";
import { snippetTabs } from "./codegen";
import { ExplorerNetworkError, newIdempotencyKey, sendExplorerRequest } from "./http";
import {
  acceptHeader,
  collectIds,
  defaultParamValues,
  groupOperations,
  IDEMPOTENCY_HEADER,
  resolveRequest,
  type CollectedIds,
  type ExplorerOperation,
} from "./operations";
import { QuickStart } from "./QuickStart";
import type { QuickStartPreset } from "./quickStartPresets";
import { RequestEditor, type RequestDraft } from "./RequestEditor";
import { ResponseViewer, type ExplorerResult } from "./ResponseViewer";
import { validateAgainstSchema } from "./schema";

export type SpecSource =
  | { readonly state: "live"; readonly version: string | null }
  | { readonly state: "loading" }
  | { readonly state: "fallback"; readonly error: PlatformError | null };

export interface ApiExplorerProps {
  readonly operations: readonly ExplorerOperation[];
  readonly source: SpecSource;
  readonly onReloadSpec: () => void;
}

const DEFAULT_OPERATION = "createIntent";
const OP_HASH = /^#op-([A-Za-z0-9_-]+)$/u;

/** `/v1/intents/{id}/steps/{stepId}/prepare` → `/intents/{id}/…/prepare` (the full path is the title). */
function shortPath(path: string): string {
  const bare = path.replace(/^\/v1/u, "");
  if (bare.length <= 24) return bare;
  const segments = bare.split("/").filter(Boolean);
  return segments.length > 3 ? `/${segments.slice(0, 2).join("/")}/…/${segments[segments.length - 1]}` : bare;
}

function operationFromHash(hash: string): string | null {
  return OP_HASH.exec(hash)?.[1] ?? null;
}

function initialDraft(operation: ExplorerOperation): RequestDraft {
  return {
    values: defaultParamValues(operation),
    bodyText: operation.body ? JSON.stringify(operation.body.examples[0]?.value ?? {}, null, 2) : "",
    example: 0,
    idempotencyKey: "",
  };
}

function SourceBadge({ source, count, onReload }: { source: SpecSource; count: number; onReload: () => void }) {
  if (source.state === "live") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs font-bold">
        <Badge tone="green">Live</Badge>
        <span>
          OpenAPI 3.1 from /v1/openapi.json{source.version ? ` · v${source.version}` : ""} · {count} operations
        </span>
      </p>
    );
  }
  if (source.state === "loading") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs font-bold" role="status">
        <Badge tone="neutral">Loading</Badge>
        <span>Reading /v1/openapi.json… the bundled reference is shown meanwhile.</span>
      </p>
    );
  }
  const notServed = source.error?.status === 404;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs font-bold" role="status">
      <Badge tone="yellow">Offline reference</Badge>
      <span>
        {notServed
          ? "This backend does not serve Platform API v1 (404). Showing the bundled reference."
          : "The API is unreachable. Showing the bundled reference; requests will fail until it is back."}
      </span>
      <button
        type="button"
        onClick={onReload}
        className={cx("inline-flex items-center gap-1 underline decoration-2 underline-offset-2", FOCUS_RING)}
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        Retry
      </button>
    </p>
  );
}

function OperationNav({
  operations,
  selectedId,
  onSelect,
}: {
  operations: readonly ExplorerOperation[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const selectId = useId();
  const groups = useMemo(() => groupOperations(operations), [operations]);
  return (
    <>
      <div className="flex flex-col gap-1.5 p-4 lg:hidden">
        <label htmlFor={selectId} className={cx(LABEL, "text-[#1A1A1A] dark:text-[#E2E8F0]")}>
          Operation ({operations.length})
        </label>
        <select
          id={selectId}
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
          className={cx(
            "min-h-11 w-full min-w-0 cursor-pointer border-[3px] border-[#1A1A1A] bg-white px-3 py-2 font-code text-[13px] font-semibold text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#F1F5F9]",
            FOCUS_RING,
          )}
        >
          {groups.map((group) => (
            <optgroup key={group.tag} label={group.tag}>
              {group.operations.map((operation) => (
                <option key={operation.id} value={operation.id}>
                  {operation.method} {operation.path.replace(/^\/v1/u, "")}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <nav aria-label="Operations" className="hidden overflow-y-auto overscroll-contain lg:sticky lg:top-24 lg:block lg:max-h-[calc(100vh-7rem)]">
        {groups.map((group) => (
          <div key={group.tag} className="border-b-2 border-[#1A1A1A]/10 pb-2 last:border-b-0 dark:border-white/10">
            <p className={cx(LABEL, "sticky top-0 z-[1] bg-[#F1EFE8] px-3 py-2 !text-[10px] dark:bg-[#0F1A2C]", TEXT_MUTED)}>{group.tag}</p>
            <ul>
              {group.operations.map((operation) => {
                const selected = operation.id === selectedId;
                return (
                  <li key={operation.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(operation.id)}
                      aria-current={selected ? "true" : undefined}
                      title={`${operation.method} ${operation.path}: ${operation.summary}`}
                      className={cx(
                        "flex min-h-9 w-full min-w-0 items-center gap-2 border-l-[4px] px-2.5 py-1.5 text-left font-code text-[11.5px] transition-colors",
                        selected
                          ? "border-[#0052FF] bg-white font-bold dark:border-[#FFD60A] dark:bg-[#131E32]"
                          : "border-transparent hover:bg-white/70 dark:hover:bg-[#131E32]/70",
                        FOCUS_RING,
                        "focus-visible:-outline-offset-2",
                      )}
                    >
                      <MethodBadge method={operation.method} className="min-w-[2.9rem] !text-[9px]" />
                      <span className="min-w-0 flex-1 truncate">{shortPath(operation.path)}</span>
                      {operation.auth === "key" ? (
                        <KeyRound className="h-3 w-3 shrink-0 text-[#45464B] dark:text-[#A9B6C8]" aria-label="Needs an API key" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}

/**
 * The OpenAPI-driven API explorer: every operation, generated parameter
 * forms, a JSON body editor with schema hints, an in-memory API key,
 * Idempotency-Key, a response viewer and "copy as" snippets.
 */
export function ApiExplorer({ operations, source, onReloadSpec }: ApiExplorerProps) {
  const { key } = useSessionKey();
  const { location } = useRoute();
  const hashOperation = operationFromHash(location.hash);
  const [selectedId, setSelectedId] = useState(() => hashOperation ?? DEFAULT_OPERATION);
  const [seenLocation, setSeenLocation] = useState(location.key);
  if (seenLocation !== location.key) {
    setSeenLocation(location.key);
    if (hashOperation && hashOperation !== selectedId) setSelectedId(hashOperation);
  }

  const operation =
    operations.find((item) => item.id === selectedId) ??
    operations.find((item) => item.id === DEFAULT_OPERATION) ??
    operations[0]!;

  const [drafts, setDrafts] = useState<Record<string, RequestDraft>>({});
  const draft = drafts[operation.id] ?? initialDraft(operation);
  const updateDraft = (next: Partial<RequestDraft>) =>
    setDrafts((previous) => ({ ...previous, [operation.id]: { ...(previous[operation.id] ?? initialDraft(operation)), ...next } }));

  const [sendKey, setSendKey] = useState(true);
  const [results, setResults] = useState<Record<string, ExplorerResult>>({});
  const [collected, setCollected] = useState<CollectedIds | null>(null);
  const [preset, setPreset] = useState<string | null>(null);
  // One in-flight request per operation; a new send aborts only its own predecessor.
  const controllersRef = useRef(new Map<string, AbortController>());
  const panelRef = useRef<HTMLDivElement | null>(null);
  const responseRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
    };
  }, []);

  const withKey = Boolean(key) && sendKey;
  const resolved = resolveRequest(operation, draft.values);
  const accept = acceptHeader(operation);

  // Body: parsed JSON (undefined when there is none) or a parse error.
  const bodyState = useMemo(() => {
    if (!operation.body) return { parsed: undefined as unknown, error: null as string | null, issues: [] as { path: string; message: string }[] };
    const text = draft.bodyText.trim();
    if (!text) {
      return { parsed: undefined, error: operation.body.required ? "This operation needs a JSON body." : null, issues: [] };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return { parsed, error: null, issues: validateAgainstSchema(operation.body.schema, parsed, "", 6) };
    } catch (error) {
      return { parsed: undefined, error: `Not valid JSON: ${(error as Error).message}`, issues: [] };
    }
  }, [operation, draft.bodyText]);

  const idempotencyKey = operation.idempotent && draft.idempotencyKey ? draft.idempotencyKey : null;
  const tabs = snippetTabs({
    operation,
    origin: PLATFORM_ORIGIN,
    values: draft.values,
    body: bodyState.parsed,
    ...(bodyState.parsed === undefined && draft.bodyText.trim() ? { bodyText: draft.bodyText.trim() } : {}),
    withKey: withKey || operation.auth === "key",
    idempotencyKey,
    accept,
  });

  const notices: { tone: "warn" | "info"; text: React.ReactNode }[] = [];
  if (operation.auth === "key" && !key) {
    notices.push({
      tone: "warn",
      text: (
        <>
          Needs an API key: without one the API answers 401. Paste a key above, or{" "}
          <Link to="/developers#keys" className="font-bold underline decoration-2 underline-offset-2">
            issue one
          </Link>
          .
        </>
      ),
    });
  }
  if (idempotencyKey && !withKey) {
    notices.push({ tone: "warn", text: "Idempotency-Key needs an API key: without one the API answers 400 IDEMPOTENCY_KEY_REQUIRES_API_KEY." });
  }
  if (idempotencyKey && operation.id === "createIntent" && ["true", "1"].includes(draft.values.dryRun ?? "")) {
    notices.push({ tone: "info", text: "Dry runs ignore Idempotency-Key; turn dryRun off to store the intent and see a replay." });
  }
  if (operation.id === "prepareStep") {
    notices.push({ tone: "info", text: "Prepare re-quotes on every call and is never replayed. Signing happens in the user's wallet, never here." });
  }

  const blocked = resolved.missing.length > 0 ? `Fill ${resolved.missing.join(" and ")} first.` : bodyState.error;
  const result = results[operation.id] ?? null;
  const loading = result?.state === "loading";

  const send = async () => {
    if (blocked) return;
    const target = operation;
    const controllers = controllersRef.current;
    controllers.get(target.id)?.abort();
    const controller = new AbortController();
    controllers.set(target.id, controller);
    const isCurrent = () => controllers.get(target.id) === controller;
    setResults((previous) => ({ ...previous, [target.id]: { state: "loading" } }));
    const headers: [string, string][] = [["accept", accept]];
    if (withKey) headers.push(["authorization", `Bearer ${key}`]);
    if (idempotencyKey) headers.push([IDEMPOTENCY_HEADER.toLowerCase(), idempotencyKey]);
    for (const [name, value] of resolved.headers) headers.push([name, value]);
    const body = target.body && bodyState.parsed !== undefined ? JSON.stringify(bodyState.parsed) : undefined;
    if (body !== undefined) headers.push(["content-type", "application/json"]);
    try {
      const exchange = await sendExplorerRequest(
        { method: target.method, url: `${PLATFORM_ORIGIN}${resolved.pathAndQuery}`, headers, ...(body !== undefined ? { body } : {}) },
        controller.signal,
      );
      if (!isCurrent()) return;
      setResults((previous) => ({ ...previous, [target.id]: { state: "done", exchange } }));
      if (exchange.ok) setCollected((previous) => collectIds(exchange.body, previous));
    } catch (error) {
      if (!isCurrent()) return;
      const failure = error instanceof ExplorerNetworkError ? error : new ExplorerNetworkError("network", "No response.");
      setResults((previous) => ({ ...previous, [target.id]: { state: "failed", kind: failure.kind, message: failure.message } }));
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void send();
    const element = responseRef.current;
    if (element && element.getBoundingClientRect().top > window.innerHeight - 120) {
      element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
    }
  };

  const select = (id: string) => {
    setSelectedId(id);
    setPreset(null);
  };

  const pickPreset = (item: QuickStartPreset) => {
    const target = operations.find((candidate) => candidate.id === item.operationId);
    if (!target) return;
    setSelectedId(target.id);
    setPreset(item.id);
    const base = initialDraft(target);
    setDrafts((previous) => ({
      ...previous,
      [target.id]: {
        ...base,
        values: { ...base.values, ...(item.values ?? {}) },
        bodyText: item.body !== undefined ? JSON.stringify(item.body, null, 2) : base.bodyText,
      },
    }));
    const panel = panelRef.current;
    if (panel) {
      panel.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      panel.focus({ preventScroll: true });
    }
  };

  const deepLink = `${typeof window === "undefined" ? "" : window.location.origin}/developers#op-${operation.id}`;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <QuickStart activeId={preset} onPick={pickPreset} />

      <div id="reference" className={cx("min-w-0 scroll-mt-36 lg:scroll-mt-28", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-col gap-4 border-b-[3px] border-[#1A1A1A] bg-[#F1EFE8] p-4 dark:border-[#4B5563] dark:bg-[#0F1A2C] sm:p-5">
          <SourceBadge source={source} count={operations.length} onReload={onReloadSpec} />
          <div className="grid gap-4 md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] md:items-start">
            <ApiKeyField compact />
            <div className={cx("flex flex-col gap-2 text-xs leading-relaxed", TEXT_MUTED)}>
              <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#B91C1C] dark:text-[#FCA5A5]" aria-hidden="true" />
                <span>
                  Requests go straight from this browser to <span className="break-all font-code">{PLATFORM_ORIGIN}</span>. Public
                  operations work without a key (30 requests/min per IP). Snippets always read{" "}
                  <code className="font-code">KLETIA_API_KEY</code> instead of the key you paste.
                </span>
              </p>
              {key ? (
                <label className="inline-flex min-h-9 w-fit cursor-pointer items-center gap-2 font-bold text-[#1A1A1A] dark:text-white">
                  <input
                    type="checkbox"
                    checked={sendKey}
                    onChange={(event) => setSendKey(event.target.checked)}
                    className="h-4 w-4 accent-[#0052FF]"
                  />
                  Send the key with requests
                </label>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid min-w-0 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
          <div className="min-w-0 border-b-[3px] border-[#1A1A1A] bg-[#FBFAF7] dark:border-[#4B5563] dark:bg-[#0F1A2C] lg:border-b-0 lg:border-r-[3px]">
            <OperationNav operations={operations} selectedId={operation.id} onSelect={select} />
          </div>

          <div ref={panelRef} tabIndex={-1} className="flex min-w-0 flex-col gap-6 p-4 outline-none sm:p-6">
            <header className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <MethodBadge method={operation.method} className="!text-[11px]" />
                <h3 id={`op-${operation.id}`} className="min-w-0 scroll-mt-40 break-all font-code text-base font-bold sm:text-lg">
                  {operation.path}
                </h3>
                <Badge tone={operation.auth === "key" ? "yellow" : "neutral"}>{operation.auth === "key" ? "Key required" : "Public"}</Badge>
                {operation.idempotent ? <Badge tone="purple">Idempotency-Key</Badge> : null}
                <span className="ml-auto">
                  <CopyLinkButton href={deepLink} target={`${operation.method} ${operation.path}`} />
                </span>
              </div>
              <p className="font-display text-xl font-bold leading-tight">{operation.summary}</p>
              {operation.description ? (
                <details className="kl-details group text-sm">
                  <summary className={cx("inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs font-bold", FOCUS_RING)}>
                    <ArrowDownRight className="kl-details-chevron h-3.5 w-3.5" aria-hidden="true" />
                    About this operation
                  </summary>
                  <p className={cx("mt-1 max-w-3xl leading-relaxed", TEXT_MUTED)}>{operation.description}</p>
                </details>
              ) : null}
              <p className={cx("flex items-center gap-1.5 font-code text-[11px]", TEXT_MUTED)}>
                <Link2 className="h-3 w-3" aria-hidden="true" />
                operationId: {operation.id}
              </p>
            </header>

            <form onSubmit={onSubmit} noValidate className="flex min-w-0 flex-col gap-5" aria-label={`Request for ${operation.method} ${operation.path}`}>
              <RequestEditor
                operation={operation}
                draft={draft}
                onChange={updateDraft}
                bodyError={bodyState.error}
                bodyIssues={bodyState.issues}
                collected={collected}
                withKey={withKey}
                onNewIdempotencyKey={() => updateDraft({ idempotencyKey: newIdempotencyKey() })}
              />

              {notices.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {notices.map((notice, index) => (
                    <li
                      key={index}
                      className={cx(
                        "border-l-[6px] px-3 py-2 text-sm",
                        notice.tone === "warn"
                          ? "border-[#FFD60A] bg-[#FFF7CC] text-[#1A1A1A] dark:bg-[#2B2610] dark:text-[#FDF3C4]"
                          : "border-[#0052FF] bg-[#EEF3FF] text-[#1A1A1A] dark:border-[#7EA6FF] dark:bg-[#111C33] dark:text-[#DCE6FF]",
                      )}
                    >
                      {notice.text}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="flex flex-col gap-3 border-t-2 border-dashed border-[#1A1A1A]/20 pt-4 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between">
                <p className="min-w-0 break-all font-code text-[12px]">
                  <span className="font-bold">{operation.method}</span> {PLATFORM_ORIGIN}
                  {resolved.pathAndQuery}
                </p>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {loading ? (
                    <Button variant="secondary" onClick={() => controllersRef.current.get(operation.id)?.abort()}>
                      <Square className="h-4 w-4" aria-hidden="true" />
                      Stop
                    </Button>
                  ) : null}
                  <Button type="submit" size="lg" loading={loading} disabled={Boolean(blocked)}>
                    <Play className="h-4 w-4" aria-hidden="true" />
                    Send request
                  </Button>
                </div>
              </div>
              {blocked ? (
                <p className="text-xs font-bold text-[#B91C1C] dark:text-[#FCA5A5]" role="status">
                  {blocked}
                </p>
              ) : null}
            </form>

            <div ref={responseRef} className="flex min-w-0 scroll-mt-40 flex-col gap-3" aria-live="polite" aria-busy={loading}>
              <p className={cx(LABEL, TEXT_MUTED)}>Response</p>
              <ResponseViewer result={result} origin={PLATFORM_ORIGIN} onRetry={() => void send()} />
            </div>

            <div className="flex min-w-0 flex-col gap-3">
              <p className={cx(LABEL, "flex items-center gap-2", TEXT_MUTED)}>
                <WandSparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Copy as
              </p>
              <CodeBlock tabs={tabs} label={`Snippets for ${operation.id}`} maxHeightClassName="max-h-80" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
