/**
 * Helpers of the intent widget: status tones, theme resolution, wallet and
 * error text, step ownership and the step row.
 */
import { useEffect, useState } from "react";
import {
  CHAINS,
  formatAmount,
  parseAccountId,
  type AccountId,
  type IntentGraph,
  type IntentStep,
  type SessionView,
  type StepStatus,
} from "@kletia/core";
import {
  KletiaApiError,
  KletiaExecutionError,
  isIntentTerminal,
} from "@kletia/sdk";
import { cleanText, isHttpsUrl } from "../review.js";
import type { KletiaIntentWidgetProps } from "./props.js";

/** Stored intent ids: `int_` + 32 lower-case hex. */
export const INTENT_ID = /^int_[0-9a-f]{32}$/u;

const STATUS_TONE: Partial<Record<StepStatus, "ok" | "bad" | "live">> = {
  settled: "ok",
  confirmed: "ok",
  failed: "bad",
  indeterminate: "bad",
  awaiting_signature: "live",
  submitted: "live",
  settling: "live",
};

export function useResolvedTheme(theme: KletiaIntentWidgetProps["theme"]): "light" | "dark" {
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

/** The wallet address of an account id ("eip155:8453:0x…" -> "0x…"): the one a reading consent binds to. */
export function walletOfAccount(account: string | undefined): string | null {
  if (!account) return null;
  const address = account.slice(account.lastIndexOf(":") + 1);
  return address.length >= 20 ? address : null;
}

/** A refusal the API marked as readable with model assistance (the project enabled it). */
export function readingOffered(error: unknown): boolean {
  return error instanceof KletiaApiError && error.code === "INTENT_UNSUPPORTED" && error.details?.modelReading === "available";
}

export function describeError(error: unknown): string {
  if (error instanceof KletiaExecutionError && error.references) {
    const count = error.references.length;
    const them = count === 1 ? "it" : "them";
    const sent = `Your wallet already sent ${count} transaction${count === 1 ? "" : "s"} for this step, but Kletia has not recorded ${them}`;
    return error.cause instanceof KletiaApiError && !error.cause.retryable
      ? `${sent}: ${error.cause.message} This step will not be signed again; check your wallet's activity and plan a new intent if needed.`
      : `${sent} yet. Resubmit reports ${them} without signing again.`;
  }
  if (error instanceof KletiaApiError && error.code === "CONTRACT_PENDING" && error.retryAfterSeconds !== null) {
    return pendingText(new Date(Date.now() + error.retryAfterSeconds * 1000));
  }
  if (error instanceof KletiaApiError) {
    const issue = error.issues[0];
    const message = issue ? `${error.message} (${issue.path || "request"}: ${issue.message})` : error.message;
    const hints = error.hints.slice(0, 3);
    return hints.length > 0 ? `${message} Try: ${hints.map((hint) => `“${hint}”`).join(", ")}.` : message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * A checkout whose contract registration is still in its activation delay:
 * when it opens, in local time and minutes from now.
 */
export function pendingText(opensAt: Date): string {
  const minutes = Math.max(1, Math.ceil((opensAt.getTime() - Date.now()) / 60_000));
  const clock = opensAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `This checkout opens at ${clock} (in ${minutes} min). Kletia waits before a newly registered contract can be used, so its owner is warned first.`;
}

/** The latest activation time among a session's pending registrations, while it is still ahead. */
export function sessionOpensAt(session: SessionView | null, now: number): Date | null {
  const times = (session?.warnings ?? [])
    .filter((warning) => warning.code === "CONTRACT_PENDING")
    .map((warning) => Date.parse(warning.activatesAt))
    .filter((time) => Number.isFinite(time) && time > now);
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}

/** The host of an origin, for text ("acme.example"); empty when it is not a URL. */
export function hostOf(origin: string): string {
  try {
    return cleanText(new URL(origin).host, 120);
  } catch {
    return "";
  }
}

/** Same wallet: EVM addresses on any chain (case-insensitive), Solana addresses exactly. */
function sameOwner(a: string, b: string): boolean {
  const left = parseAccountId(a);
  const right = parseAccountId(b);
  if (!left || !right || left.chain.namespace !== right.chain.namespace) return false;
  if (left.chain.namespace === "eip155") return left.address.toLowerCase() === right.address.toLowerCase();
  return left.chain.id === right.chain.id && left.address === right.address;
}

/** The first wallet step whose account is not one of the connected accounts. */
export function unboundStep(intent: IntentGraph, accounts: readonly AccountId[]): IntentStep | null {
  if (isIntentTerminal(intent)) return null;
  return (
    [...intent.steps]
      .sort((a, b) => a.index - b.index)
      .find((step) => step.mode === "wallet" && !["settled", "skipped", "submitted", "confirmed", "settling"].includes(step.status) && !accounts.some((account) => sameOwner(account, step.account))) ?? null
  );
}

export function StepRow({ step }: { step: IntentStep }) {
  const chain = CHAINS[step.network];
  // Only https explorer links are rendered; anything else (e.g. javascript:) is dropped.
  const evidence = [...step.evidence].reverse().find((item) => item.url && isHttpsUrl(item.url));
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
