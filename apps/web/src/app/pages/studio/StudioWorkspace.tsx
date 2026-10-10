import type { IntentGraph } from "@kletia/core";
import { ArrowRight, Braces, ChevronRight, Info } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "../../site/art/Icon";
import { BlankTicket } from "../../site/art/Ticket";
import { IntentGraphView } from "../../site/intent/IntentGraphView";
import { prefersReducedMotion } from "../../site/motion/useReducedMotion";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Badge } from "../../site/ui/Badge";
import { Button, ButtonLink } from "../../site/ui/Button";
import { TextAreaField, TextField } from "../../site/ui/Field";
import { JsonView } from "../../site/ui/JsonView";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { toast } from "../../site/ui/toast";
import { PlanTicket } from "./PlanTicket";
import { ShareLinkButton } from "./ShareLinkButton";
import { StudioExamples } from "./StudioExamples";
import { STUDIO_DEFAULT_PROMPT, STUDIO_FALLBACK_EXAMPLES } from "./exampleGroups";
import { StudioSkeleton } from "./StudioSkeleton";
import { useStudioPlanner } from "./useStudioPlanner";

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
  const resultsRef = useRef<HTMLDivElement>(null);
  const autoPlanned = useRef(false);

  useEffect(() => {
    if (!initialText || autoPlanned.current) return;
    autoPlanned.current = true;
    void submit(initialText);
  }, [initialText, submit]);

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
  useEffect(() => {
    if (planStatus === "loading") {
      toast.dismiss(PLAN_TOAST);
      return undefined;
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
  }, [planStatus, planData, planError, showResults]);
  useEffect(() => () => toast.dismiss(PLAN_TOAST), []);

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:gap-12">
      <div className="flex min-w-0 flex-col gap-6">
        <form onSubmit={onSubmit} noValidate className={cx("flex min-w-0 flex-col gap-5 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)} aria-label="Plan an intent">
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
            placeholder="swap 0.1 SOL to USDC on solana"
            hint="Plain English. Press Ctrl/⌘ + Enter to plan."
            error={studio.textError}
            mono
            spellCheck={false}
          />

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

          <Button type="submit" size="lg" loading={plan.status === "loading"}>
            <Icon name="ticket" size={20} className="[--kla-plate:#FFD60A]" />
            Print the plan
          </Button>
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
        <p className="sr-only" role="status">
          {plan.status === "loading"
            ? "Planning intent"
            : plan.status === "success"
              ? `Plan ready with ${plan.data?.steps.length ?? 0} steps`
              : plan.status === "error"
                ? "Planning failed"
                : ""}
        </p>
        {plan.status === "idle" ? <EmptyState /> : null}
        {plan.status === "loading" ? <StudioSkeleton prompt={studio.text.trim()} /> : null}
        {plan.status === "error" && plan.error ? (
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
        {plan.status === "success" && plan.data ? (
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
            <PlanTicket intent={plan.data} />
            <IntentGraphView intent={plan.data} actions={renderActions?.(plan.data)} entrance />
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
