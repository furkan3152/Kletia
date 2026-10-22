import "../../site/art/journey.css";

import type { IntentGraph } from "@kletia/core";
import { AssumptionChips, ClarifyCard } from "@kletia/widget";
import { clarifyView } from "@kletia/widget/review";
import { ArrowRight, Braces, ChevronRight, Info } from "lucide-react";
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { Icon } from "../../site/art/Icon";
import { BlankTicket } from "../../site/art/Ticket";
import { IntentGraphView } from "../../site/intent/IntentGraphView";
import { JourneyPanel } from "../../site/intent/JourneyPanel";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Badge } from "../../site/ui/Badge";
import { Button, ButtonLink } from "../../site/ui/Button";
import { TextAreaField, TextField } from "../../site/ui/Field";
import { CopyButton } from "../../site/ui/CopyButton";
import { JsonView } from "../../site/ui/JsonView";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { toast } from "../../site/ui/toast";
import { PlanTicket } from "./PlanTicket";
import { ShareLinkButton } from "./ShareLinkButton";
import { StudioExamples } from "./StudioExamples";
import { STUDIO_DEFAULT_PROMPT, STUDIO_FALLBACK_EXAMPLES } from "./exampleGroups";
import { StudioSkeleton } from "./StudioSkeleton";
import { useStudioPlanner } from "./useStudioPlanner";
import type { TurnExchange } from "../../../shared/platform/platformApi";
import { PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";

export interface StudioWorkspaceProps {
  /** Prompt to start with (e.g. from `?q=`). When set, it is planned on mount. */
  readonly initialText?: string;
  /** Slot for controls under the plan summary, e.g. a wallet execute panel. */
  readonly renderActions?: (intent: IntentGraph) => React.ReactNode;
  /** Replaces the default "execution happens in the console" note. */
  readonly executionNote?: React.ReactNode;
}

/** Toast id shared by the plan-ready and planning-failed toasts (a new result replaces the old one). */
const PLAN_TOAST = "studio-plan";
/** Wait for the mobile auto-scroll before deciding whether the results are out of view. */
const OUT_OF_VIEW_CHECK_MS = 700;

function EmptyState() {
  return (
    <div className="pt-2 sm:pt-4 lg:[&_.kla-ticket-wrap]:-rotate-1">
      <BlankTicket
        title="Your ticket prints here."
        body="Pick an example or write your own. You get the legs, the venues, the minimum you receive on each leg and any warnings. Nothing is signed or stored."
      />
    </div>
  );
}

/** True on devices with a precise pointer: keyboard shortcuts are only offered there. */
function usePointerFine(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      try {
        const query = window.matchMedia("(pointer: fine)");
        query.addEventListener("change", onChange);
        return () => query.removeEventListener("change", onChange);
      } catch {
        return () => undefined;
      }
    },
    () => {
      try {
        return window.matchMedia("(pointer: fine)").matches;
      } catch {
        return false;
      }
    },
    () => false,
  );
}

/** "1.1 KB": the size of the thread blob the client holds and sends back. */
function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function curlOf(exchange: TurnExchange): string {
  const body = exchange.requestText.replace(/'/gu, "'\\''");
  return `curl -sS -X POST '${PLATFORM_ORIGIN}${exchange.path}' \\\n  -H 'content-type: application/json' \\\n  -d '${body}'`;
}

/**
 * The API exchange of the last turn, exactly as sent and received: the
 * response tab prints the body byte for byte, the request tab the body
 * Studio sent, with the thread's size and a curl.
 */
function ExchangePanel({ exchanges }: { readonly exchanges: readonly TurnExchange[] }) {
  const baseId = useId();
  const [tab, setTab] = useState<"response" | "request">("response");
  const last = exchanges[exchanges.length - 1];
  if (!last) return null;
  const body = last.body as { readonly status?: unknown; readonly thread?: unknown } | null;
  const status = typeof body?.status === "string" ? body.status : null;
  const thread = body && typeof body.thread === "object" && body.thread !== null ? (body.thread as { readonly rev?: unknown }) : null;
  const threadBytes = thread ? new TextEncoder().encode(JSON.stringify(thread)).length : 0;
  const tabs = [
    { id: "response" as const, label: "Response" },
    { id: "request" as const, label: "Request" },
  ];
  return (
    <section aria-labelledby={`${baseId}-h`} className={cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER, SURFACE)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${baseId}-h`} className={LABEL}>
          API exchange{exchanges.length > 1 ? ` · turn ${exchanges.length}` : ""}
        </h3>
        <CopyButton text={curlOf(last)} label="Copy curl" appearance="light" />
      </div>
      <p className="break-all font-code text-xs font-bold">
        POST {last.path} · {last.status}
        {status ? ` ${status}` : ""}
        {thread ? ` · thread rev ${String(thread.rev ?? "?")} · client-held · ${sizeText(threadBytes)}` : ""}
      </p>
      <div role="tablist" aria-label="API exchange" className="grid grid-cols-2 border-2 border-[#1A1A1A] dark:border-[#4B5563]">
        {tabs.map((entry, index) => (
          <button
            key={entry.id}
            id={`${baseId}-tab-${entry.id}`}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const next = tabs[(index + 1) % tabs.length]!;
              setTab(next.id);
              document.getElementById(`${baseId}-tab-${next.id}`)?.focus();
            }}
            className={cx(
              "min-h-11 px-2 text-xs font-black uppercase tracking-[0.1em]",
              index > 0 && "border-l-2 border-[#1A1A1A] dark:border-[#4B5563]",
              tab === entry.id ? "bg-[#1A1A1A] text-white dark:bg-[#FFD60A] dark:text-[#1A1A1A]" : "bg-white text-[#1A1A1A] dark:bg-[#0B1120] dark:text-[#E2E8F0]",
              FOCUS_RING,
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`}>
        <JsonView value={tab === "response" ? last.responseText : last.requestText} label={tab === "response" ? "response body" : "request body"} />
      </div>
    </section>
  );
}

function isOutOfView(element: Element | null): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.bottom <= 0 || rect.top >= window.innerHeight;
}

/**
 * Studio composer plus the planned graph. Wallet-free: StudioPage passes
 * `renderActions` to launch the lazily loaded wallet execution panel.
 */
export function StudioWorkspace({ initialText = "", renderActions, executionNote }: StudioWorkspaceProps) {
  const studio = useStudioPlanner(initialText || STUDIO_DEFAULT_PROMPT);
  const { plan, submit } = studio;
  const pointerFine = usePointerFine();
  const response = plan.response;
  const clarify = response ? clarifyView(response) : null;
  const card = clarify?.card ?? null;
  const resultsRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The plan or its error renders below the form on narrow screens: bring either into view.
    // A prompt that fails the local checks shows its error in the form instead.
    const willPlan = Boolean(studio.text.trim()) && !studio.evmError && !studio.solanaError;
    void submit().then((result) => {
      if ((result || willPlan) && window.matchMedia?.("(max-width: 1023px)").matches) {
        resultsRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      }
    });
  };

  const unsupported = plan.status === "error" && plan.error?.code === "INTENT_UNSUPPORTED";

  // Preview accounts live in a disclosure that is forced open while either
  // field holds a value or an error, so nothing that affects the plan hides.
  const accountsInUse = Boolean(studio.evmAddress.trim() || studio.solanaAddress.trim());
  const accountsInvalid = Boolean(studio.evmError || studio.solanaError);
  const accountsForced = accountsInUse || accountsInvalid;
  const [accountsOpen, setAccountsOpen] = useState(false);

  // The toast's Retry runs the latest submit without re-running the toast effect on every keystroke.
  const submitRef = useRef(submit);
  useLayoutEffect(() => {
    submitRef.current = submit;
  });

  // `?q=` plans once per mount, with no "already planned" ref: StrictMode's
  // simulated unmount aborts the first request (useApiAction aborts on
  // unmount), and the remount must plan again instead of waiting forever.
  // Typing never re-runs it: submit is read through the ref and the effect
  // depends on the initial text only.
  useEffect(() => {
    if (initialText) void submitRef.current(initialText);
  }, [initialText]);

  const showResults = useCallback(() => {
    const results = resultsRef.current;
    if (!results) return;
    results.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    results.focus({ preventScroll: true });
  }, []);

  // Toasts are secondary: only when the results column is out of view (phones,
  // or a chip far up the page). The inline result and error panel stay primary,
  // and the sr-only status below already announces both, so toasts are silent.
  const { status: planStatus, data: planData, error: planError } = plan;
  const asking = planStatus === "success" && response?.status === "needs_input";
  useEffect(() => {
    if (planStatus === "loading") {
      toast.dismiss(PLAN_TOAST);
      return undefined;
    }
    if (planStatus === "success" && asking) {
      const timer = window.setTimeout(() => {
        if (!isOutOfView(resultsRef.current)) return;
        toast.success("Kletia has a question", { id: PLAN_TOAST, action: { label: "Show it", onClick: showResults }, silent: true });
      }, OUT_OF_VIEW_CHECK_MS);
      return () => window.clearTimeout(timer);
    }
    if (planStatus === "success" && planData) {
      const steps = planData.steps.length;
      const signatures = planData.summary.signaturesRequired;
      const timer = window.setTimeout(() => {
        if (!isOutOfView(resultsRef.current)) return;
        toast.success("Plan ready", {
          id: PLAN_TOAST,
          description: `${steps} step${steps === 1 ? "" : "s"} · ${signatures} signature${signatures === 1 ? "" : "s"}`,
          action: { label: "Show plan", onClick: showResults },
          silent: true,
        });
      }, OUT_OF_VIEW_CHECK_MS);
      return () => window.clearTimeout(timer);
    }
    if (planStatus === "error" && planError) {
      const timer = window.setTimeout(() => {
        if (!isOutOfView(resultsRef.current)) return;
        toast.error("Planning failed", {
          id: PLAN_TOAST,
          description: planError.message,
          // Retrying only helps transient failures; anything else needs the explanation in the panel.
          action: planError.retryable
            ? { label: "Retry", onClick: () => void submitRef.current() }
            : { label: "Show details", onClick: showResults },
          silent: true,
        });
      }, OUT_OF_VIEW_CHECK_MS);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [asking, planStatus, planData, planError, showResults]);
  useEffect(() => () => toast.dismiss(PLAN_TOAST), []);

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:gap-12">
      <div className="flex min-w-0 flex-col gap-6">
        <form ref={formRef} onSubmit={onSubmit} noValidate className={cx("flex min-w-0 flex-col gap-5 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)} aria-label="Plan an intent">
          <TextAreaField
            label="Where should the money go?"
            rows={3}
            value={studio.text}
            onChange={(event) => studio.setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="bridge 25 USDC from base to solana"
            hint={pointerFine ? "Plain English. Press Ctrl/⌘ + Enter to plan." : "Plain English. Kletia asks when something is missing."}
            error={studio.textError}
            mono
            spellCheck={false}
          />

          {/* The button sits right under the text: reachable without scrolling on phones. */}
          <Button type="submit" size="lg" loading={plan.status === "loading"}>
            <Icon name="ticket" size={20} className="[--kla-plate:#FFD60A]" />
            Plan this route
          </Button>

          <StudioExamples text={studio.text} onPick={(example) => void submit(example)} />

          <details
            className={cx("kl-details border-[3px] border-dashed border-[#1A1A1A]/30 dark:border-white/15")}
            open={accountsOpen || accountsForced}
            onToggle={(event) => {
              const element = event.currentTarget;
              // While a field holds a value or an error the panel stays open.
              if (!element.open && accountsForced) {
                element.open = true;
                return;
              }
              setAccountsOpen(element.open);
            }}
          >
            <summary
              className={cx(
                "flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 [&::-webkit-details-marker]:hidden",
                LABEL,
                FOCUS_RING,
              )}
            >
              <ChevronRight className="kl-details-chevron h-4 w-4 shrink-0" aria-hidden="true" />
              Preview accounts
              <span className={cx("ml-auto text-[10px] tracking-[0.14em]", TEXT_MUTED)}>
                {accountsInvalid ? "Check address" : accountsInUse ? "In use" : "Optional"}
              </span>
            </summary>
            <div className="flex flex-col gap-4 px-4 pb-4 pt-1">
              <TextField
                label="EVM address (optional)"
                value={studio.evmAddress}
                onChange={(event) => studio.setEvmAddress(event.target.value)}
                placeholder="0x000000000000000000000000000000000000dEaD"
                error={studio.evmError}
                autoComplete="off"
                spellCheck={false}
                mono
              />
              <TextField
                label="Solana address (optional)"
                value={studio.solanaAddress}
                onChange={(event) => studio.setSolanaAddress(event.target.value)}
                placeholder="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
                error={studio.solanaError}
                autoComplete="off"
                spellCheck={false}
                mono
              />
              <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
                Empty fields use demo preview accounts. A dry run reads balances and quotes for planning only; it never
                moves funds.
              </p>
            </div>
          </details>
        </form>

        <div className="flex gap-3 border-[3px] border-[#1A1A1A] bg-[#EAF0FF] p-4 text-sm text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#14213D] dark:text-[#E2E8F0]">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true" />
          <div className="flex flex-col gap-3">
            {executionNote ?? (
              <p>
                <strong>Read-only preview.</strong> A dry run never signs or moves funds; execute the plan with your own
                wallets.
              </p>
            )}
            <ButtonLink to="/app" size="sm" variant="secondary" className="self-start">
              Open the console
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </ButtonLink>
          </div>
        </div>
      </div>

      <div
        ref={resultsRef}
        tabIndex={-1}
        className="min-w-0 scroll-mt-28 focus:outline-none"
        aria-live="polite"
        aria-busy={plan.status === "loading"}
      >
        {/* The plan region's headings start at h2. */}
        <h2 className="sr-only">Your plan</h2>
        <p className="sr-only" role="status">
          {plan.status === "loading"
            ? "Planning intent"
            : asking
              ? clarify?.announcement ?? "Kletia has a question"
              : plan.status === "success" && plan.data
                ? `Plan ready with ${plan.data.steps.length} steps`
                : plan.status === "success" && response?.status === "cancelled"
                  ? "Cancelled"
                  : plan.status === "error"
                    ? "Planning failed"
                    : ""}
        </p>
        {plan.status === "idle" ? <EmptyState /> : null}
        {plan.status === "loading" && !response ? <StudioSkeleton prompt={studio.text.trim()} /> : null}
        {/* One question card: the API exchange stays beside it. */}
        {card && (plan.status === "success" || plan.status === "loading" || plan.status === "error") ? (
          <div className="mb-6 flex flex-col gap-4">
            {plan.status === "error" && plan.error ? <ApiErrorPanel error={plan.error} title="Kletia could not use that answer" /> : null}
            <div className="kla-qcard" data-kind="clarify">
              <ClarifyCard
                key={card.id}
                question={card}
                pending={studio.pending}
                dismissLabel="New sentence"
                onAnswer={(answer) =>
                  void studio.answer(
                    "optionId" in answer
                      ? { question: answer.questionId ?? card.questions?.[0]?.id ?? card.id, option: answer.optionId }
                      : { question: answer.questionId ?? card.questions?.[0]?.id ?? card.id, text: answer.text },
                  )
                }
                onDismiss={() => {
                  studio.reset();
                  formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                }}
              />
            </div>
            <ExchangePanel exchanges={studio.exchanges} />
          </div>
        ) : null}
        {plan.status === "success" && response?.status === "cancelled" ? (
          <div className="flex flex-col gap-4">
            <p className={cx("p-4 text-sm font-semibold", INK_BORDER, SURFACE)}>Cancelled. Write a new sentence to plan again.</p>
            <ExchangePanel exchanges={studio.exchanges} />
          </div>
        ) : null}
        {plan.status === "error" && plan.error && !card ? (
          <div className="flex flex-col gap-5">
            <ApiErrorPanel
              error={plan.error}
              title={unsupported ? "Kletia could not interpret that intent" : "Planning failed"}
              onRetry={() => void submit()}
            />
            {unsupported ? (
              <div className={cx("kl-rise p-5", INK_BORDER, SURFACE)} style={{ ["--kl-i" as string]: 1 }}>
                <p className={LABEL}>Try a supported phrasing</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {STUDIO_FALLBACK_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => void submit(example)}
                      className={cx("border-2 border-[#1A1A1A] bg-white px-2 py-1 font-code text-[11px] transition-colors duration-150 hover:bg-[#FFD60A] dark:border-[#4B5563] dark:bg-[#0B1120] dark:hover:bg-[#1A2841]", FOCUS_RING)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {(plan.status === "success" || (plan.status === "loading" && plan.data) || (plan.status === "error" && plan.data)) && plan.data && !card ? (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="yellow">Dry run</Badge>
              {studio.accounts.evmIsPreview || studio.accounts.solanaIsPreview ? (
                <Badge tone="outline">Preview accounts</Badge>
              ) : null}
              {plan.latencyMs !== null ? (
                <span className="font-code text-xs text-[#45464B] dark:text-[#A9B6C8]">planned in {plan.latencyMs} ms</span>
              ) : null}
              {plan.data.request.text ? (
                <span className="ml-auto">
                  <ShareLinkButton text={plan.data.request.text} />
                </span>
              ) : null}
            </div>
            {plan.status === "error" && plan.error ? <ApiErrorPanel error={plan.error} title="Kletia could not change the plan" /> : null}
            {response?.status === "planned" && response.assumptions.length > 0 ? (
              <div className="kla-qcard">
                <AssumptionChips assumptions={response.assumptions} onChange={(id, option) => void studio.changeAssumption(id, option)} disabled={plan.status === "loading"} />
              </div>
            ) : null}
            <PlanTicket intent={plan.data} />
            {/* The itinerary under the ticket: demo accounts are never read. */}
            {response?.status === "planned" && response.journey && response.journey.intentId === plan.data.id ? (
              <JourneyPanel journey={response.journey} phase="review" headingLevel={3} />
            ) : null}
            {/*
              The card drops in, but its counts are printed as they are: an animated count starts at 0 and
              waits until it is scrolled into view, so a plan below the fold read "Steps 0 · Signatures 0".
            */}
            <div className="kl-drop min-w-0">
              <IntentGraphView intent={plan.data} actions={renderActions?.(plan.data)} />
            </div>
            <ExchangePanel exchanges={studio.exchanges} />
            <details className={cx("kl-details group", INK_BORDER, SURFACE)}>
              <summary
                className={cx(
                  "flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-xs font-black uppercase tracking-[0.14em] [&::-webkit-details-marker]:hidden",
                  FOCUS_RING,
                )}
              >
                <Braces className="h-4 w-4" aria-hidden="true" />
                Raw IntentGraph JSON
                <ChevronRight className="kl-details-chevron ml-auto h-4 w-4" aria-hidden="true" />
              </summary>
              <div className="border-t-[3px] border-[#1A1A1A] p-3 dark:border-[#4B5563]">
                <JsonView value={plan.data} label="IntentGraph JSON" />
              </div>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}
