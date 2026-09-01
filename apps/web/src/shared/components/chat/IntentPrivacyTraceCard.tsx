import { BrainCircuit, ChevronDown, Eye, ShieldCheck } from "lucide-react";

import type { IntentPrivacyTraceV1 } from "../../privacy/intentPrivacyTrace";

const readable = (value: string): string =>
  value.replace(/_/gu, " ").replace(/^./u, (letter) => letter.toUpperCase());

export function IntentPrivacyTraceCard({
  trace,
}: {
  trace: IntentPrivacyTraceV1;
}) {
  const aiDisclosed = trace.semantic.promptDisclosureToModelProviderOccurred;
  const aiInfluenced = trace.semantic.modelInfluencedCurrentPlan;
  const aiSummary = aiDisclosed
    ? "Smart parser used with permission"
    : aiInfluenced
      ? "Using your active smart-parser session"
      : "Local parser · no AI request";
  const ledgerPublic =
    trace.executionBoundary.ledgerVisibility ===
    "route_specific_public_settlement";

  return (
    <details className="mt-4 border-[3px] border-[#1A1A1A] bg-[#EDE7FF] text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#231C3D] dark:text-white dark:shadow-[3px_3px_0_#475569]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#8B5CF6]">
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <strong className="block text-[10px] font-black uppercase tracking-[0.14em]">
              Privacy
            </strong>
            <span className="block truncate text-[10px] font-bold text-[#554C66] dark:text-[#D8D2E6]">
              {aiSummary}{ledgerPublic ? " · Public if signed" : ""}
            </span>
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
      </summary>

      <div className="grid gap-2 border-t-[3px] border-[#1A1A1A] p-3 text-[10px] font-bold dark:border-[#64748B] sm:grid-cols-2">
        <div className="border-[2px] border-[#1A1A1A] bg-white p-2.5 dark:border-[#64748B] dark:bg-[#111C2F]">
          <span className="flex items-center gap-1 font-black uppercase">
            <Eye className="h-4 w-4" aria-hidden="true" /> Planning disclosure
          </span>
          <p className="mt-1 leading-relaxed">
            The Kletia API received this legacy prompt. Application logs store
            only request metadata; clarification context is memory-only and
            expires.
          </p>
        </div>
        <div className="border-[2px] border-[#1A1A1A] bg-white p-2.5 dark:border-[#64748B] dark:bg-[#111C2F]">
          <span className="flex items-center gap-1 font-black uppercase">
            <BrainCircuit className="h-4 w-4" aria-hidden="true" /> Semantic boundary
          </span>
          <p className="mt-1 leading-relaxed">
            {aiDisclosed
              ? "AI interpretation was explicitly authorized for this request; signing and calldata remain deterministic."
              : aiInfluenced
                ? "No new model request was made for this turn, but the plan still depends on semantic context disclosed under an earlier consent in this short-lived clarification session."
                : "No semantic-model prompt disclosure influenced this plan; deterministic parsing remained active."}
          </p>
        </div>
        <div className="border-[2px] border-[#1A1A1A] bg-white p-2.5 leading-relaxed dark:border-[#64748B] dark:bg-[#111C2F] sm:col-span-2">
          <strong className="font-black uppercase">Execution boundary</strong>
          <p className="mt-1">
            {ledgerPublic
              ? "If approved, route-specific amounts, recipients and timing are public on the selected chain and protocol."
              : trace.executionBoundary.ledgerVisibility === "public_queries"
                ? "No financial transaction is prepared, but public RPC or data providers can observe query metadata."
                : "No ledger operation is attached to this response."}
          </p>
          {trace.inputBoundary.detectedFieldClasses.length > 0 ? (
            <p className="mt-1">
              Detected classes: {trace.inputBoundary.detectedFieldClasses.map(readable).join(" · ")}
            </p>
          ) : null}
          <p className="mt-1 font-mono text-[9px]">
            {trace.traceSha256.slice(0, 18)}… · unsigned diagnostic
          </p>
        </div>
      </div>
    </details>
  );
}
