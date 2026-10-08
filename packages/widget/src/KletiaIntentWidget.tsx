import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CHAINS,
  formatAmount,
  type AccountId,
  type IntentGraph,
  type IntentStep,
  type StepStatus,
} from "@kletia/core";
import {
  KletiaApiError,
  KletiaClient,
  executeIntent,
  type IntentSigners,
  type KletiaClientOptions,
} from "@kletia/sdk";
import { ensureWidgetStyles } from "./styles.js";

export const DEFAULT_WIDGET_EXAMPLES: readonly string[] = [
  "swap 1 SOL to USDC",
  "bridge 25 USDC from base to solana",
  "move 0.01 ETH from arbitrum to solana as SOL",
  "stake 1.5 SOL with jito",
];

export interface KletiaIntentWidgetProps {
  /** An existing client, or options to create one (keep `clientOptions` stable, e.g. with useMemo). */
  readonly client?: KletiaClient;
  readonly clientOptions?: KletiaClientOptions;
  /** CAIP-10 accounts the user controls. Required to plan. */
  readonly accounts: readonly AccountId[];
  /** Wallet signers. When omitted, the widget plans and reviews but does not execute. */
  readonly signers?: IntentSigners;
  readonly defaultText?: string;
  readonly examples?: readonly string[];
  readonly theme?: "light" | "dark" | "auto";
  readonly maxSlippageBps?: number;
  /** Opaque metadata attached to created intents (e.g. your order id). */
  readonly metadata?: Readonly<Record<string, string>>;
  readonly onIntentCreated?: (intent: IntentGraph) => void;
  readonly onUpdate?: (intent: IntentGraph) => void;
  readonly onComplete?: (intent: IntentGraph) => void;
  readonly onError?: (error: unknown) => void;
  readonly className?: string;
}

const STATUS_TONE: Partial<Record<StepStatus, "ok" | "bad" | "live">> = {
  settled: "ok",
  confirmed: "ok",
  failed: "bad",
  indeterminate: "bad",
  awaiting_signature: "live",
  submitted: "live",
  settling: "live",
};

function useResolvedTheme(theme: KletiaIntentWidgetProps["theme"]): "light" | "dark" {
  const [prefersDark, setPrefersDark] = useState(false);
  useEffect(() => {
    if (theme !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(query.matches);
    const listener = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, [theme]);
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return prefersDark ? "dark" : "light";
}

function describeError(error: unknown): string {
  if (error instanceof KletiaApiError) {
    const issue = error.issues[0];
    const message = issue ? `${error.message} (${issue.path || "request"}: ${issue.message})` : error.message;
    const hints = error.hints.slice(0, 3);
    return hints.length > 0 ? `${message} Try: ${hints.map((hint) => `“${hint}”`).join(", ")}.` : message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

function StepRow({ step }: { step: IntentStep }) {
  const chain = CHAINS[step.network];
  const evidence = [...step.evidence].reverse().find((item) => item.url);
  return (
    <li className="kw-step">
      <div className="kw-step-top">
        <span className="kw-step-title">{step.title}</span>
        <span className="kw-status" data-tone={STATUS_TONE[step.status] ?? undefined}>
          {step.status.replace(/_/gu, " ")}
        </span>
      </div>
      <span className="kw-net">
        <span className="kw-dot" style={{ background: chain.color }} aria-hidden="true" />
        {chain.shortName} · {step.protocol}
        {step.settlement?.destinationNetwork
          ? ` → ${CHAINS[step.settlement.destinationNetwork].shortName}`
          : ""}
      </span>
      {step.input || step.expectedOutput ? (
        <span className="kw-io">
          {step.input ? (
            <>
              <strong>{formatAmount(step.input.formatted)}</strong> {step.input.symbol}
            </>
          ) : null}
          {step.input && step.expectedOutput ? " → " : null}
          {step.expectedOutput ? (
            <>
              ~<strong>{formatAmount(step.expectedOutput.formatted)}</strong> {step.expectedOutput.symbol}
            </>
          ) : null}
          {step.minimumOutput ? ` (min ${formatAmount(step.minimumOutput.formatted)})` : null}
        </span>
      ) : null}
      {step.warnings?.map((warning) => (
        <span key={warning} className="kw-warn">
          {warning}
        </span>
      ))}
      {step.failure ? <span className="kw-warn">{step.failure.message}</span> : null}
      {evidence?.url ? (
        <a className="kw-link" href={evidence.url} target="_blank" rel="noreferrer noopener">
          View on explorer
        </a>
      ) : null}
    </li>
  );
}

/**
 * Drop-in intent widget. Plans a natural-language intent through the Kletia
 * API, shows the reviewed step graph and, when wallet signers are provided,
 * executes it step by step.
 */
export function KletiaIntentWidget(props: KletiaIntentWidgetProps) {
  const {
    accounts,
    signers,
    examples = DEFAULT_WIDGET_EXAMPLES,
    theme = "auto",
    maxSlippageBps,
    metadata,
    onIntentCreated,
    onUpdate,
    onComplete,
    onError,
    className,
  } = props;
  const client = useMemo(
    () => props.client ?? new KletiaClient(props.clientOptions),
    [props.client, props.clientOptions],
  );
  const resolvedTheme = useResolvedTheme(theme);
  const textId = useId();
  const [text, setText] = useState(props.defaultText ?? "");
  const [intent, setIntent] = useState<IntentGraph | null>(null);
  const [phase, setPhase] = useState<"idle" | "planning" | "executing">("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    ensureWidgetStyles();
    return () => abortRef.current?.abort();
  }, []);

  const plan = async () => {
    if (!text.trim() || accounts.length === 0) return;
    setPhase("planning");
    setError(null);
    setIntent(null);
    try {
      const created = await client.intents.create({
        text: text.trim(),
        accounts,
        ...(maxSlippageBps ? { constraints: { maxSlippageBps } } : {}),
        ...(metadata ? { metadata } : {}),
      });
      setIntent(created);
      onIntentCreated?.(created);
    } catch (caught) {
      setError(describeError(caught));
      onError?.(caught);
    } finally {
      setPhase("idle");
    }
  };

  const execute = async () => {
    if (!intent || !signers) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("executing");
    setError(null);
    try {
      const final = await executeIntent(client, intent, signers, {
        signal: controller.signal,
        onUpdate: (next) => {
          setIntent(next);
          onUpdate?.(next);
        },
      });
      setIntent(final);
      onComplete?.(final);
    } catch (caught) {
      setError(describeError(caught));
      onError?.(caught);
      void client.intents.get(intent.id).then(setIntent).catch(() => undefined);
    } finally {
      setPhase("idle");
    }
  };

  const busy = phase !== "idle";
  const finished = intent ? ["completed", "failed", "partially_completed", "cancelled", "expired"].includes(intent.status) : false;

  return (
    <section
      className={`kw-root${className ? ` ${className}` : ""}`}
      data-theme={resolvedTheme}
      aria-label="Kletia intent"
    >
      <div className="kw-head">
        <span className="kw-brand">
          Klet<b>ia</b> intents
        </span>
        <span className="kw-lane">{accounts.length} account{accounts.length === 1 ? "" : "s"}</span>
      </div>
      <label className="kw-label" htmlFor={textId}>
        What should happen?
      </label>
      <textarea
        id={textId}
        className="kw-textarea"
        value={text}
        maxLength={1000}
        placeholder="bridge 25 USDC from base to solana then swap half to JitoSOL"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void plan();
        }}
      />
      <div className="kw-chips">
        {examples.map((example) => (
          <button key={example} type="button" className="kw-chip" onClick={() => setText(example)}>
            {example}
          </button>
        ))}
      </div>
      <div className="kw-row">
        <button
          type="button"
          className="kw-btn"
          disabled={busy || !text.trim() || accounts.length === 0}
          onClick={() => void plan()}
        >
          {phase === "planning" ? "Planning…" : "Plan"}
        </button>
        <button
          type="button"
          className="kw-btn kw-primary"
          disabled={busy || !intent || !signers || finished}
          onClick={() => void execute()}
          title={signers ? undefined : "Connect wallets to execute"}
        >
          {phase === "executing" ? "Executing…" : "Execute"}
        </button>
      </div>
      <div aria-live="polite">
        {error ? <div className="kw-error">{error}</div> : null}
        {intent ? (
          <>
            <div className="kw-summary">
              <h3>{intent.summary.title}</h3>
              <div className="kw-meta">
                <span>Status: {intent.status.replace(/_/gu, " ")}</span>
                <span>{intent.summary.signaturesRequired} signature(s)</span>
                {intent.summary.totalFeesUsd !== undefined ? (
                  <span>Fees ≈ ${intent.summary.totalFeesUsd.toFixed(2)}</span>
                ) : null}
                {intent.summary.estimatedSeconds !== undefined ? (
                  <span>ETA ≈ {Math.max(1, Math.round(intent.summary.estimatedSeconds))}s</span>
                ) : null}
              </div>
            </div>
            <ol className="kw-steps">
              {intent.steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </ol>
          </>
        ) : null}
      </div>
      <div className="kw-foot">
        <span>Non-custodial · your wallet signs every step</span>
        <a className="kw-link" href="https://kletiaai.xyz" target="_blank" rel="noreferrer noopener">
          Kletia
        </a>
      </div>
    </section>
  );
}

export default KletiaIntentWidget;
