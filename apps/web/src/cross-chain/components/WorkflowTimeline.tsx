import { CheckCircle2, CircleDashed, Loader2, ShieldAlert } from "lucide-react";
import type { WorkflowPlanV1 } from "../../shared/types";

export function WorkflowTimeline({ plan }: { plan: WorkflowPlanV1 }) {
  return (
    <section className="mt-4 w-full border-[3px] border-[#1A1A1A] bg-[#DDF5FF] p-3 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] sm:p-4">
      <div className="flex items-center justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-2">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em]">WorkflowPlanV1</p>
          <h3 className="text-sm font-black uppercase">Staged cross-chain execution</h3>
        </div>
        <span className="border-2 border-[#1A1A1A] bg-white px-2 py-1 text-[9px] font-black uppercase">
          HF floor 1.5
        </span>
      </div>
      <div className="mt-3 space-y-2">
        {plan.steps.map((step, index) => {
          const completed = ["confirmed", "filled", "ready"].includes(step.status);
          const failed = ["failed", "refunded", "indeterminate"].includes(step.status);
          const active = index === plan.currentStepIndex;
          const Icon = failed ? ShieldAlert : completed ? CheckCircle2 : active ? Loader2 : CircleDashed;
          return (
            <div key={step.id} className={`flex gap-3 border-2 border-[#1A1A1A] p-2 ${active ? "bg-[#FFF36D]" : "bg-white"}`}>
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${active && !failed && !completed ? "animate-spin" : ""}`} strokeWidth={3} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-black uppercase">
                  <span>{index + 1}. {step.action.replace(/_/gu, " ")}</span>
                  <span>{step.network} · {step.status}</span>
                </div>
                <p className="mt-1 break-words text-[10px] font-bold">
                  {step.amount} {step.tokenIn || "asset"}
                  {step.tokenOut ? ` → ${step.tokenOut}` : ""}
                  {step.protocol ? ` · ${step.protocol}` : ""}
                  {step.action === "gas_acquire" && step.maxPayment
                    ? ` · max ${step.maxPayment} USDC`
                    : ""}
                </p>
                {step.readResult?.kind === "borrow_capacity" && (
                  <div className="mt-2 border-2 border-[#1A1A1A] bg-[#D9F99D] p-2 text-[10px] font-black">
                    SAFE ADDITIONAL BORROW: {step.readResult.safeAmount} {step.readResult.asset}
                    <span className="mt-1 block text-[9px] font-bold">
                      Aave V3 · target HF {step.readResult.targetHealthFactor} · block {step.readResult.observedAtBlock} · read-only
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[9px] font-bold leading-relaxed">
        Same-chain wallet batches may be atomic. Cross-chain steps are checkpointed and have no global rollback. Every financial step requires a fresh wallet approval.
      </p>
    </section>
  );
}
