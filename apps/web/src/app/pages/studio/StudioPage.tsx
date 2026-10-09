import type { IntentGraph } from "@kletia/core";
import { ArrowDown, History, PenLine } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { LazyBoundary } from "../../../shared/components/LazyBoundary";
import { readIntentSession, STUDIO_INTENT_SESSION_KEY } from "../../../shared/platform/intentSession";
import { useRoute } from "../../routes/useRoute";
import { Button } from "../../site/ui/Button";
import { Skeleton, SkeletonGroup, SkeletonText } from "../../site/ui/Skeleton";
import { CONTAINER, cx, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { StudioWorkspace } from "./StudioWorkspace";

// Wallet runtimes (wagmi, RainbowKit, Wallet Standard) load only when the
// user asks to execute, or when this tab has an intent to resume.
const loadExecutionPanel = () => import("./StudioExecutionPanel");
const StudioExecutionPanel = React.lazy(loadExecutionPanel);

function readPromptParam(search: string): string {
  try {
    return (new URLSearchParams(search).get("q") ?? "").slice(0, 500);
  } catch {
    return "";
  }
}

/** Placeholder with the panel's own shape: header, wallets column and the plan column. */
function PanelFallback() {
  return (
    <SkeletonGroup label="Loading wallets" className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Loading wallets…</p>
          <Skeleton className="h-9 w-2/3 max-w-md" />
          <Skeleton className="h-3 w-1/3 max-w-xs border-2" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:gap-10">
        <div className={cx("flex flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
          <div className="flex items-center gap-3">
            <Skeleton surface="card" className="h-8 w-8" />
            <Skeleton surface="card" className="h-5 w-40" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton surface="card" className="h-11 w-36" />
            <Skeleton surface="card" className="h-11 w-36" />
          </div>
          <SkeletonText surface="card" lines={2} />
        </div>
        <div className={cx("kl-dot-backdrop flex flex-col gap-3 p-5", INK_BORDER, SURFACE)}>
          <div className="flex items-center gap-3">
            <Skeleton surface="card" className="h-8 w-8" />
            <Skeleton surface="card" className="h-5 w-48" />
          </div>
          <SkeletonText surface="card" lines={3} />
        </div>
      </div>
    </SkeletonGroup>
  );
}

function PanelFailed({ reload }: { reload: () => void }) {
  return (
    <div role="alert" className={cx("flex flex-col gap-3 p-5", INK_BORDER, SURFACE)}>
      <p className="font-display text-xl font-bold">The wallet panel could not load</p>
      <p className={cx("text-sm", TEXT_MUTED)}>
        Nothing was signed. Check your connection and reload; an intent that was already running can be resumed after the
        reload.
      </p>
      <Button size="sm" onClick={reload} className="self-start">
        Reload
      </Button>
    </div>
  );
}

function ExecuteLauncher({
  intent,
  open,
  locked,
  onLaunch,
}: {
  intent: IntentGraph;
  open: boolean;
  locked: boolean;
  onLaunch: (intent: IntentGraph) => void;
}) {
  const signatures = intent.summary.signaturesRequired;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className={cx("text-sm", TEXT_MUTED)}>
        {open
          ? "This plan is open in the execution panel below."
          : `Ready to run it? Kletia plans it again with your own accounts, then your wallet signs ${signatures} time${
              signatures === 1 ? "" : "s"
            }.`}
      </p>
      <Button
        onClick={() => onLaunch(intent)}
        onMouseEnter={() => void loadExecutionPanel().catch(() => undefined)}
        onFocus={() => void loadExecutionPanel().catch(() => undefined)}
        disabled={locked}
        title={locked ? "Finish or stop the current execution first" : undefined}
        className="shrink-0"
      >
        {open ? <ArrowDown className="h-4 w-4" aria-hidden="true" /> : <PenLine className="h-4 w-4" aria-hidden="true" />}
        {open ? "Go to execution" : "Execute with my wallets"}
      </Button>
    </div>
  );
}

/**
 * Intent Studio: dry-run planning with a live graph, plus wallet execution
 * through a lazily loaded panel (StudioExecutionPanel).
 */
export default function StudioPage() {
  const { location } = useRoute();
  const [initialText] = useState(() => readPromptParam(location.search));
  const [resumeIntentId, setResumeIntentId] = useState<string | null>(
    () => readIntentSession(STUDIO_INTENT_SESSION_KEY)?.intentId ?? null,
  );
  const [target, setTarget] = useState<IntentGraph | null>(null);
  const [busy, setBusy] = useState(false);
  // The header banner points at a resumable intent until the user acts on it.
  const [resumeNoticed, setResumeNoticed] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const panelOpen = Boolean(target || resumeIntentId);

  const launch = useCallback(
    (intent: IntentGraph) => {
      if (busy && target?.id !== intent.id) return;
      setTarget(intent);
      setFocusToken((value) => value + 1);
    },
    [busy, target?.id],
  );

  const onBusyChange = useCallback((next: boolean) => {
    setBusy(next);
    if (next) setResumeNoticed(true);
  }, []);

  const close = useCallback(() => {
    setTarget(null);
    setResumeIntentId(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (focusToken === 0) return undefined;
    let frame = 0;
    let attempts = 0;
    const focusHeading = () => {
      const heading = document.getElementById("studio-execute-heading");
      if (heading) {
        panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        heading.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      if (attempts < 240) frame = window.requestAnimationFrame(focusHeading);
    };
    focusHeading();
    return () => window.cancelAnimationFrame(frame);
  }, [focusToken]);

  return (
    <>
      <header className="kl-grid-backdrop border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "flex flex-col gap-6 py-8 sm:py-12 lg:py-10")}>
          <div className="max-w-3xl lg:max-w-none">
            <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Intent Studio</p>
            <h1 className="mt-3 text-balance font-display text-[clamp(2.4rem,6.5vw,4.5rem)] font-bold leading-[0.95] tracking-[-0.045em] lg:mt-4 lg:text-[3.25rem] lg:leading-none">
              Type an outcome. <span className="text-[#9945FF]">See the plan.</span>
            </h1>
            <p className={cx("mt-4 max-w-2xl text-base leading-relaxed sm:text-lg lg:mt-3 lg:max-w-none lg:text-base", TEXT_MUTED)}>
              Studio compiles your words (<code className="font-code text-[0.9em]">POST /v1/intents?dryRun=true</code>) into
              a graph of steps, outputs, fees and timing; then your own wallets execute it.
            </p>
            {resumeIntentId && !target && !resumeNoticed ? (
              <div
                role="status"
                className={cx("kl-rise mt-6 flex flex-col gap-3 bg-[#FFF3B0] p-4 text-[#1A1A1A] sm:flex-row sm:items-center sm:justify-between", INK_BORDER, HARD_SHADOW)}
              >
                <p className="flex items-center gap-2 text-sm font-bold">
                  <History className="h-4 w-4 shrink-0" aria-hidden="true" />
                  This tab was executing an intent before it reloaded.
                </p>
                <Button
                  size="sm"
                  variant="ink"
                  onClick={() => {
                    setResumeNoticed(true);
                    setFocusToken((value) => value + 1);
                  }}
                  className="shrink-0"
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  Pick it up
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className={cx(CONTAINER, "flex flex-col gap-12 py-8 sm:py-12 lg:py-10")}>
        <StudioWorkspace
          initialText={initialText}
          renderActions={(intent) => (
            <ExecuteLauncher intent={intent} open={target?.id === intent.id} locked={busy && target?.id !== intent.id} onLaunch={launch} />
          )}
          executionNote={
            <p>
              <strong>Plan first, sign second.</strong> The preview is a dry run. Executing plans the intent again with
              the wallets you connect and asks you to confirm before any signature.
            </p>
          }
        />
        {panelOpen ? (
          <section
            ref={panelRef}
            id="execute"
            aria-labelledby="studio-execute-heading"
            className={cx("kl-rise scroll-mt-28 p-4 sm:p-6 lg:p-8", INK_BORDER, HARD_SHADOW, "bg-[#EDE9DF] dark:bg-[#0E1729]")}
          >
            <LazyBoundary fallback={(reload) => <PanelFailed reload={reload} />}>
              <React.Suspense fallback={<PanelFallback />}>
                <StudioExecutionPanel
                  preview={target}
                  resumeIntentId={target ? null : resumeIntentId}
                  onClose={close}
                  onBusyChange={onBusyChange}
                />
              </React.Suspense>
            </LazyBoundary>
          </section>
        ) : null}
      </div>
    </>
  );
}
