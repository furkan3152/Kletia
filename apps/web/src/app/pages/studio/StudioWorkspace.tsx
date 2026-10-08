import type { IntentGraph } from "@kletia/core";
import { ArrowRight, Braces, Info, Sparkles, Workflow } from "lucide-react";
import React, { useEffect, useRef } from "react";

import { IntentGraphView } from "../../site/intent/IntentGraphView";
import { INTENT_EXAMPLES } from "../../site/snippets";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Badge } from "../../site/ui/Badge";
import { Button, ButtonLink } from "../../site/ui/Button";
import { TextAreaField, TextField } from "../../site/ui/Field";
import { JsonView } from "../../site/ui/JsonView";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { useStudioPlanner } from "./useStudioPlanner";

export interface StudioWorkspaceProps {
  /** Prompt to start with (e.g. from `?q=`). When set, it is planned on mount. */
  readonly initialText?: string;
  /** Slot for controls under the plan summary, e.g. a wallet execute panel. */
  readonly renderActions?: (intent: IntentGraph) => React.ReactNode;
  /** Replaces the default "execution happens in the console" note. */
  readonly executionNote?: React.ReactNode;
}

function EmptyState() {
  return (
    <div className={cx("kl-dot-backdrop flex min-h-[28rem] flex-col items-center justify-center gap-6 p-8 text-center", INK_BORDER, SURFACE)}>
      <span className="flex h-16 w-16 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[4px_4px_0_#475569]">
        <Workflow className="h-8 w-8" aria-hidden="true" />
      </span>
      <div className="max-w-md">
        <h2 className="font-display text-2xl font-bold tracking-[-0.02em]">Your intent graph appears here</h2>
        <p className={cx("mt-2 text-sm leading-relaxed", TEXT_MUTED)}>
          Pick an example or type an outcome. Kletia compiles it into network-bound steps with live quotes, fees,
          output floors and warnings. Nothing is signed or persisted.
        </p>
      </div>
      <ol className="grid w-full max-w-lg gap-2 text-left font-code text-xs sm:grid-cols-3">
        {["1 · compile text", "2 · bind accounts", "3 · quote each step"].map((item) => (
          <li key={item} className="border-2 border-[#1A1A1A] bg-white px-3 py-2 dark:border-[#4B5563] dark:bg-[#0B1120]">
            {item}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className={cx("h-40 animate-pulse bg-white/70 motion-reduce:animate-none dark:bg-[#131E32]", INK_BORDER)} />
      <div className="grid gap-6 md:grid-cols-2">
        <div className={cx("h-72 animate-pulse bg-white/70 motion-reduce:animate-none dark:bg-[#131E32]", INK_BORDER)} />
        <div className={cx("h-72 animate-pulse bg-white/70 motion-reduce:animate-none dark:bg-[#131E32] md:mt-24", INK_BORDER)} />
      </div>
    </div>
  );
}

/**
 * Studio composer plus the planned graph. Wallet-free: a wallet-aware page can
 * wrap this in WalletProviders and pass `renderActions` to add execution.
 */
export function StudioWorkspace({ initialText = "", renderActions, executionNote }: StudioWorkspaceProps) {
  const studio = useStudioPlanner(initialText || INTENT_EXAMPLES[2]!);
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
    void submit().then((result) => {
      if (result && window.matchMedia?.("(max-width: 1023px)").matches) {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  };

  const unsupported = plan.status === "error" && plan.error?.code === "INTENT_UNSUPPORTED";

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:gap-12">
      <div className="flex flex-col gap-6">
        <form onSubmit={onSubmit} noValidate className={cx("flex flex-col gap-5 p-5 sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)} aria-label="Plan an intent">
          <TextAreaField
            label="Intent"
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
            hint="Plain English. Press Ctrl/⌘ + Enter to plan."
            error={studio.textError}
            mono
            spellCheck={false}
          />

          <div>
            <p className={cx(LABEL, "mb-2 text-[#1A1A1A] dark:text-[#E2E8F0]")} id="studio-examples-label">
              Examples
            </p>
            <div role="group" aria-labelledby="studio-examples-label" className="flex flex-wrap gap-2">
              {INTENT_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => void submit(example)}
                  className={cx(
                    "border-2 border-[#1A1A1A] px-2 py-1 text-left font-code text-[11px] transition-colors dark:border-[#4B5563]",
                    studio.text === example
                      ? "bg-[#FFD60A] text-[#1A1A1A]"
                      : "bg-white text-[#1A1A1A] hover:bg-[#FFF7CC] dark:bg-[#0B1120] dark:text-[#E2E8F0] dark:hover:bg-[#1A2841]",
                    FOCUS_RING,
                  )}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          <fieldset className="flex flex-col gap-4 border-[3px] border-dashed border-[#1A1A1A]/30 p-4 dark:border-white/15">
            <legend className={cx(LABEL, "px-1")}>Preview accounts</legend>
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
          </fieldset>

          <Button type="submit" size="lg" disabled={plan.status === "loading"}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {plan.status === "loading" ? "Planning…" : "Plan intent"}
          </Button>
        </form>

        <div className="flex gap-3 border-[3px] border-[#1A1A1A] bg-[#EAF0FF] p-4 text-sm text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#14213D] dark:text-[#E2E8F0]">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#0052FF] dark:text-[#7EA6FF]" aria-hidden="true" />
          <div className="flex flex-col gap-3">
            {executionNote ?? (
              <p>
                <strong>Read-only preview.</strong> Execution with connected wallets happens in the console today and is
                coming to Studio.
              </p>
            )}
            <ButtonLink to="/app" size="sm" variant="secondary" className="self-start">
              Launch app
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </ButtonLink>
          </div>
        </div>
      </div>

      <div ref={resultsRef} className="min-w-0 scroll-mt-28" aria-live="polite" aria-busy={plan.status === "loading"}>
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
        {plan.status === "loading" ? <LoadingState /> : null}
        {plan.status === "error" && plan.error ? (
          <div className="flex flex-col gap-5">
            <ApiErrorPanel
              error={plan.error}
              title={unsupported ? "Kletia could not interpret that intent" : "Planning failed"}
              onRetry={() => void submit()}
            />
            {unsupported ? (
              <div className={cx("p-5", INK_BORDER, SURFACE)}>
                <p className={LABEL}>Try a supported phrasing</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {INTENT_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => void submit(example)}
                      className={cx("border-2 border-[#1A1A1A] bg-white px-2 py-1 font-code text-[11px] hover:bg-[#FFD60A] dark:border-[#4B5563] dark:bg-[#0B1120] dark:hover:bg-[#1A2841]", FOCUS_RING)}
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
            </div>
            <IntentGraphView intent={plan.data} actions={renderActions?.(plan.data)} />
            <details className={cx("group", INK_BORDER, SURFACE)}>
              <summary
                className={cx(
                  "flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-xs font-black uppercase tracking-[0.14em] [&::-webkit-details-marker]:hidden",
                  FOCUS_RING,
                )}
              >
                <Braces className="h-4 w-4" aria-hidden="true" />
                Raw IntentGraph JSON
                <span aria-hidden="true" className="ml-auto transition-transform group-open:rotate-90">
                  ▸
                </span>
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
