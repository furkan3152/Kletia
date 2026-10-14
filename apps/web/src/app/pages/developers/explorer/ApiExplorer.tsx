import { ArrowDownRight, Code2, KeyRound, Link2, Play, RefreshCw, Square } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { PLATFORM_ORIGIN, type PlatformError } from "../../../../shared/platform/kletiaClient";
import { navigate } from "../../../routes/history";
import { Link } from "../../../routes/Link";
import { prefersReducedMotion } from "../../../site/motion/useReducedMotion";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { CopyLinkButton } from "../components/CopyLinkButton";
import { MethodBadge } from "../components/MethodBadge";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { usePortal } from "../shell/portalContext";
import { GET_KEY_HREF } from "../shell/portalRoutes";
import { snippetTabs } from "./codegen";
import { ExamplesMenu } from "./ExamplesMenu";
import { operationHref, resolveExplorerOperation } from "./explorerRoute";
import { ExplorerNetworkError, newIdempotencyKey, sendExplorerRequest } from "./http";
import { OperationTree } from "./OperationTree";
import {
  acceptHeader,
  collectIds,
  defaultParamValues,
  IDEMPOTENCY_HEADER,
  resolveRequest,
  type CollectedIds,
  type ExplorerOperation,
} from "./operations";
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
  /** The operationId from the path, or null on `/developers/api`. */
  readonly param: string | null;
}

function initialDraft(operation: ExplorerOperation): RequestDraft {
  return {
    values: defaultParamValues(operation),
    bodyText: operation.body ? JSON.stringify(operation.body.examples[0]?.value ?? {}, null, 2) : "",
    example: 0,
    idempotencyKey: "",
  };
}

interface BodyState {
  readonly parsed: unknown;
  readonly error: string | null;
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}

function readBody(operation: ExplorerOperation, bodyText: string): BodyState {
  if (!operation.body) return { parsed: undefined, error: null, issues: [] };
  const text = bodyText.trim();
  if (!text) return { parsed: undefined, error: operation.body.required ? "This operation needs a JSON body." : null, issues: [] };
  try {
    const parsed: unknown = JSON.parse(text);
    return { parsed, error: null, issues: validateAgainstSchema(operation.body.schema, parsed, "", 6) };
  } catch (error) {
    return { parsed: undefined, error: `Not valid JSON: ${(error as Error).message}`, issues: [] };
  }
}

function treeCaption(source: SpecSource, count: number): string {
  if (source.state === "live") return `Live · ${count} operations`;
  if (source.state === "loading") return `Loading · ${count} bundled`;
  return `Bundled reference · ${count} operations`;
}

function SourceLine({ source, count, onReload }: { source: SpecSource; count: number; onReload: () => void }) {
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
        <span>Reading /v1/openapi.json; the bundled reference is shown meanwhile.</span>
      </p>
    );
  }
  const notServed = source.error?.status === 404;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs font-bold" role="status">
      <Badge tone="yellow">Bundled reference</Badge>
      <span>
        {notServed
          ? `This backend does not serve Platform API v1 (404). ${count} operations in the bundled reference; requests are off.`
          : `${count} operations in the bundled reference. Requests fail until the API answers, so sending is off.`}
      </span>
      <button type="button" onClick={onReload} className={cx("inline-flex min-h-9 items-center gap-1 underline decoration-2 underline-offset-2", FOCUS_RING)}>
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        Retry
      </button>
    </p>
  );
}

const NOTICE_TONE = {
  warn: "border-[#FFD60A] bg-[#FFF7CC] text-[#1A1A1A] dark:bg-[#2B2610] dark:text-[#FDF3C4]",
  info: "border-[#0052FF] bg-[#EEF3FF] text-[#1A1A1A] dark:border-[#7EA6FF] dark:bg-[#111C33] dark:text-[#DCE6FF]",
} as const;

/**
 * The OpenAPI-driven API explorer (portal design 4.4.3): the operation tree,
 * then the request and the response side by side from 1440 px (stacked
 * below). The operation is the path's; the key is the portal bar's, sent
 * only when "Send the key" is on; snippets read $KLETIA_API_KEY, never the
 * key. Nothing here signs: prepare returns unsigned payloads.
 */
export function ApiExplorer({ operations, source, onReloadSpec, param }: ApiExplorerProps) {
  const { key } = useSessionKey();
  const { openKeyMenu } = usePortal();
  const keyKind = portalKeyKind(key);
  const { operation, notice: routeNotice } = resolveExplorerOperation(operations, param);

  const [drafts, setDrafts] = useState<Record<string, RequestDraft>>({});
  const draft = drafts[operation.id] ?? initialDraft(operation);
  const updateDraft = (next: Partial<RequestDraft>) =>
    setDrafts((previous) => ({ ...previous, [operation.id]: { ...(previous[operation.id] ?? initialDraft(operation)), ...next } }));

  const [sendKey, setSendKey] = useState(true);
  const [results, setResults] = useState<Record<string, ExplorerResult>>({});
  const [collected, setCollected] = useState<CollectedIds | null>(null);
  // One in-flight request per operation; a new send aborts only its own predecessor.
  const controllersRef = useRef(new Map<string, AbortController>());
  const responseRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
    };
  }, []);

  const withKey = keyKind !== null && sendKey;
  const resolved = resolveRequest(operation, draft.values);
  const accept = acceptHeader(operation);

  // Body: parsed JSON (undefined when there is none) or a parse error.
  const bodyState = readBody(operation, draft.bodyText);

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
  if (routeNotice) notices.push({ tone: "warn", text: routeNotice });
  if (operation.auth === "key" && keyKind === null) {
    notices.push({
      tone: "warn",
      text: key ? (
        <>The key in this tab is not a Kletia key, so operations that need one are off. Load another key from the key menu.</>
      ) : (
        <>
          Needs a key: without one the API answers 401.{" "}
          <button type="button" onClick={openKeyMenu} className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
            Load a key
          </button>{" "}
          or{" "}
          <Link to={GET_KEY_HREF} className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
            get one
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
    notices.push({ tone: "info", text: "Prepare re-quotes on every call and is never replayed. It returns unsigned payloads: signing happens in the user's wallet." });
  }

  const offline = source.state === "fallback";
  const blocked = offline
    ? "The API is not answering, so requests are off. Retry above when it is back."
    : operation.auth === "key" && keyKind === null && key
      ? "Load a developer or agent key to send this request."
      : resolved.missing.length > 0
        ? `Fill ${resolved.missing.join(" and ")} first.`
        : bodyState.error;
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

  const pickPreset = (item: QuickStartPreset) => {
    const target = operations.find((candidate) => candidate.id === item.operationId);
    if (!target) return;
    const base = initialDraft(target);
    setDrafts((previous) => ({
      ...previous,
      [target.id]: {
        ...base,
        values: { ...base.values, ...(item.values ?? {}) },
        bodyText: item.body !== undefined ? JSON.stringify(item.body, null, 2) : base.bodyText,
      },
    }));
    if (target.id !== operation.id || param !== target.id) navigate(operationHref(target.id));
  };

  const deepLink = `${typeof window === "undefined" ? "" : window.location.origin}${operationHref(operation.id)}`;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SourceLine source={source} count={operations.length} onReload={onReloadSpec} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 lg:sticky lg:top-[140px] lg:max-h-[calc(100dvh-160px)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
          <OperationTree operations={operations} selectedId={operation.id} caption={treeCaption(source, operations.length)} />
        </div>

        <div className="grid min-w-0 gap-6 min-[1440px]:grid-cols-2 min-[1440px]:items-start">
          <section aria-labelledby="explorer-request" className={cx("flex min-w-0 flex-col gap-5 p-4 sm:p-5", INK_BORDER, SURFACE)}>
            <header className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <h2 id="explorer-request" className={cx(LABEL, TEXT_MUTED)}>
                  Request
                </h2>
                <div className="flex items-center gap-2">
                  <ExamplesMenu available={(preset) => operations.some((item) => item.id === preset.operationId)} onPick={pickPreset} />
                  <CopyLinkButton href={deepLink} target={`${operation.method} ${operation.path}`} />
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <MethodBadge method={operation.method} className="!text-code-s" />
                <p className="min-w-0 break-all font-code text-body font-bold">{operation.path}</p>
              </div>
              <p className="font-display text-title font-bold leading-tight">{operation.summary}</p>
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={operation.auth === "key" ? "yellow" : "neutral"}>{operation.auth === "key" ? "Key required" : "Public"}</Badge>
                {operation.idempotent ? <Badge tone="purple">Idempotency-Key</Badge> : null}
                <span className={cx("inline-flex items-center gap-1.5 font-code text-code-s", TEXT_MUTED)}>
                  <Link2 className="h-3 w-3" aria-hidden="true" />
                  {operation.id}
                </span>
              </p>
              {operation.description ? (
                <details className="kl-details group text-sm">
                  <summary className={cx("inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs font-bold", FOCUS_RING)}>
                    <ArrowDownRight className="kl-details-chevron h-3.5 w-3.5" aria-hidden="true" />
                    About this operation
                  </summary>
                  <p className={cx("mt-1 max-w-3xl leading-relaxed", TEXT_MUTED)}>{operation.description}</p>
                </details>
              ) : null}
            </header>

            {notices.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {notices.map((notice, index) => (
                  <li key={index} className={cx("border-l-[6px] px-3 py-2 text-sm", NOTICE_TONE[notice.tone])}>
                    {notice.text}
                  </li>
                ))}
              </ul>
            ) : null}

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
              <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t-2 border-dashed border-line bg-surface px-4 py-3 sm:-mx-5 sm:px-5 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:pb-0">
                <p className="min-w-0 break-all font-code text-code-s">
                  <span className="font-bold">{operation.method}</span> {PLATFORM_ORIGIN}
                  {resolved.pathAndQuery}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button type="submit" size="lg" loading={loading} disabled={Boolean(blocked)} className="max-sm:w-full">
                    <Play className="h-4 w-4" aria-hidden="true" />
                    Send
                  </Button>
                  {loading ? (
                    <Button variant="secondary" onClick={() => controllersRef.current.get(operation.id)?.abort()}>
                      <Square className="h-4 w-4" aria-hidden="true" />
                      Stop
                    </Button>
                  ) : null}
                  {keyKind ? (
                    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-bold">
                      <input type="checkbox" checked={sendKey} onChange={(event) => setSendKey(event.target.checked)} className="h-4 w-4 accent-[#0052FF]" />
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                      Send the key <span className="font-code text-code-s font-normal">{maskKey(key)}</span>
                    </label>
                  ) : (
                    <span className={cx("text-xs", TEXT_MUTED)}>Public tier: 30 requests a minute per IP.</span>
                  )}
                </div>
                {blocked ? (
                  <p className="text-xs font-bold text-danger" role="status">
                    {blocked}
                  </p>
                ) : null}
              </div>
            </form>
          </section>

          <section aria-labelledby="explorer-response" className="flex min-w-0 flex-col gap-6 min-[1440px]:sticky min-[1440px]:top-[140px]">
            <div ref={responseRef} className="flex min-w-0 scroll-mt-40 flex-col gap-3" aria-live="polite" aria-busy={loading}>
              <h2 id="explorer-response" className={cx(LABEL, TEXT_MUTED)}>
                Response
              </h2>
              <ResponseViewer result={result} origin={PLATFORM_ORIGIN} onRetry={() => void send()} />
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <h2 className={cx(LABEL, "flex items-center gap-2", TEXT_MUTED)}>
                <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
                Code
              </h2>
              <CodeBlock tabs={tabs} label={`Snippets for ${operation.id}`} maxHeightClassName="max-h-96" />
              <p className={cx("text-xs", TEXT_MUTED)}>
                Requests go straight from this browser to <span className="break-all font-code">{PLATFORM_ORIGIN}</span>. Snippets read{" "}
                <code className="font-code">$KLETIA_API_KEY</code>, never the key in this tab.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
