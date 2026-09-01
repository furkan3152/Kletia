import { BrainCircuit, ChevronDown, PencilLine, ShieldCheck } from "lucide-react";
import type {
  IntentPrivacyDecisionOptionV1,
  IntentPrivacyDecisionV1,
} from "../../privacy/defaultIntentPrivacy";

const ICONS = {
  allow_ai_for_this_intent: BrainCircuit,
  allow_ai_for_session: BrainCircuit,
  open_private_composer: ShieldCheck,
  edit_intent: PencilLine,
} as const;

export function IntentPrivacyDecisionCard({
  decision,
  busy,
  onSelect,
}: {
  decision: IntentPrivacyDecisionV1;
  busy: boolean;
  onSelect: (option: IntentPrivacyDecisionOptionV1) => void;
}) {
  const sessionOption = decision.options.find(
    (option) => option.id === "allow_ai_for_session",
  );
  const editOption = decision.options.find((option) => option.id === "edit_intent");
  const advancedOptions = decision.options.filter(
    (option) =>
      option.id === "allow_ai_for_this_intent" ||
      option.id === "open_private_composer",
  );
  return (
    <section
      aria-labelledby="intent-privacy-decision-title"
      className="mx-auto mb-2 w-full max-w-4xl border-[3px] border-[#1A1A1A] bg-[#EDE7FF] p-3 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#231C3D] dark:text-white dark:shadow-[4px_4px_0_#475569] sm:p-4"
    >
      <div className="flex items-start gap-3 border-b-[3px] border-[#1A1A1A] pb-3 dark:border-[#64748B]">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#8B5CF6] text-white dark:border-[#94A3B8]">
          <BrainCircuit className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#5B35B5] dark:text-[#C4B5FD]">
            Smart intent parser
          </p>
          <h2
            id="intent-privacy-decision-title"
            className="mt-1 text-sm font-black leading-snug sm:text-base"
          >
            {decision.question}
          </h2>
          <p className="mt-2 text-xs font-bold leading-relaxed text-[#433D52] dark:text-[#D8D2E6]">No transaction has been prepared yet.</p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        {sessionOption ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSelect(sessionOption)}
            className="inline-flex min-h-12 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-[#8B5CF6] px-4 py-3 text-xs font-black uppercase text-white shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow] enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 enabled:active:shadow-none disabled:cursor-wait disabled:opacity-60 dark:border-[#94A3B8]"
          >
            <BrainCircuit className="h-5 w-5" aria-hidden="true" />
            {sessionOption.label}
          </button>
        ) : null}
        {editOption ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSelect(editOption)}
            className="inline-flex min-h-12 items-center justify-center gap-2 border-[3px] border-[#1A1A1A] bg-white px-4 py-3 text-xs font-black uppercase shadow-[3px_3px_0_#1A1A1A] disabled:cursor-wait disabled:opacity-60 dark:border-[#64748B] dark:bg-[#111C2F] dark:shadow-[3px_3px_0_#475569]"
          >
            <PencilLine className="h-4 w-4" aria-hidden="true" />
            Edit
          </button>
        ) : null}
      </div>

      <details className="mt-3 border-t-2 border-[#1A1A1A] pt-2 text-xs dark:border-[#64748B]">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-black">
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
          Privacy options
        </summary>
        <p className="mt-2 text-[10px] font-bold leading-relaxed text-gray-700 dark:text-slate-300">
          {decision.whyAsked}
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {advancedOptions.map((option) => {
            const Icon = ICONS[option.id];
            return (
              <button
                key={option.id}
                type="button"
                disabled={busy}
                onClick={() => onSelect(option)}
                className="border-[3px] border-[#1A1A1A] bg-white p-3 text-left shadow-[2px_2px_0_#1A1A1A] disabled:opacity-60 dark:border-[#64748B] dark:bg-[#111C2F] dark:shadow-[2px_2px_0_#475569]"
              >
                <span className="flex items-center gap-2 text-xs font-black uppercase"><Icon className="h-4 w-4" />{option.label}</span>
                <span className="mt-1 block text-[10px] font-bold leading-relaxed">{option.description}</span>
              </button>
            );
          })}
        </div>
      </details>
    </section>
  );
}
