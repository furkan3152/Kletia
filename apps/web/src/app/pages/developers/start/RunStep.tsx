import { Check, Play, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PLATFORM_ORIGIN } from "../../../../shared/platform/kletiaClient";
import { Link } from "../../../routes/Link";
import { Button } from "../../../site/ui/Button";
import { CodeBlock } from "../../../site/ui/CodeBlock";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../../site/ui/styles";
import { ExplorerNetworkError, sendExplorerRequest } from "../explorer/http";
import { firstCallCurl, firstCallPlan, summarizeRun, type RunSummary } from "./startModel";

type RunState =
  | { readonly state: "idle" }
  | { readonly state: "running" }
  | { readonly state: "done"; readonly summary: RunSummary; readonly code: string | null; readonly message: string | null }
  | { readonly state: "failed"; readonly message: string };

const LINK = cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING);

/**
 * Station three: the first call, shown as curl with $KLETIA_API_KEY, and Run,
 * which sends exactly that dry run from this browser (with the key in
 * memory, or on the public tier for sandbox keys and without a key). The
 * result is one line: status, time, steps and what arrives.
 */
export function RunStep({ apiKey, lane, account }: { readonly apiKey: string; readonly lane: "testnet" | "production" | "any" | null; readonly account: string }) {
  const plan = firstCallPlan({ apiOrigin: PLATFORM_ORIGIN, account, key: apiKey, lane });
  const [run, setRun] = useState<RunState>({ state: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRun({ state: "running" });
    try {
      const exchange = await sendExplorerRequest({ method: plan.method, url: plan.url, headers: plan.headers, body: plan.body }, controller.signal);
      if (controller.signal.aborted) return;
      const requestId = exchange.headers.find(([name]) => name === "x-request-id")?.[1] ?? null;
      const summary = summarizeRun({ status: exchange.status, latencyMs: exchange.latencyMs, body: exchange.body, requestId });
      const error =
        exchange.body && typeof exchange.body === "object" && "error" in exchange.body
          ? ((exchange.body as { error?: { code?: unknown; message?: unknown } }).error ?? null)
          : null;
      setRun({
        state: "done",
        summary,
        code: typeof error?.code === "string" ? error.code : null,
        message: typeof error?.message === "string" ? error.message : null,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setRun({ state: "failed", message: error instanceof ExplorerNetworkError ? error.message : "The API did not answer." });
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <CodeBlock code={firstCallCurl(PLATFORM_ORIGIN, account, plan.tier)} language="bash" label="The first call" filename="terminal" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button onClick={() => void start()} loading={run.state === "running"} className="max-sm:w-full">
          <Play className="h-4 w-4" aria-hidden="true" />
          Run
        </Button>
        <span className={cx("text-xs", TEXT_MUTED)}>Dry run {plan.label}: nothing is stored, nothing is signed.</span>
      </div>
      <div aria-live="polite" className="min-w-0">
        {run.state === "done" ? (
          <div className={cx("flex min-w-0 flex-col gap-1.5 border-l-[6px] px-3 py-2 text-sm", run.summary.ok ? "border-success bg-success-bg" : "border-warning bg-warning-bg")}>
            <p className="flex min-w-0 items-start gap-2 font-bold">
              {run.summary.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 break-words">{run.summary.line}</span>
            </p>
            {run.message ? <p className="text-fg">{run.message}</p> : null}
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {run.summary.requestId ? <span className="break-all font-code">X-Request-Id {run.summary.requestId}</span> : null}
              {run.code ? (
                <Link to={`/developers/errors#error-${run.code}`} className={LINK}>
                  What {run.code} means
                </Link>
              ) : null}
              <Link to="/developers/api/createIntent" className={LINK}>
                Open in the API explorer
              </Link>
            </p>
          </div>
        ) : run.state === "failed" ? (
          <p className="border-l-[6px] border-danger bg-danger-bg px-3 py-2 text-sm font-bold">{run.message}</p>
        ) : null}
      </div>
    </div>
  );
}
