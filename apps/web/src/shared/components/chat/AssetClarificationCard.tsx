import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clock3, Loader2 } from "lucide-react";
import type {
  EntityClarification,
  EntityClarificationOption,
} from "../../types";
import { currentEpochMs } from "../../utils/time";

type Props = {
  clarification: EntityClarification;
  expiresAt: number;
  status: "pending" | "submitting" | "resolved" | "blocked" | "expired";
  disabled?: boolean;
  onSelect: (option: EntityClarificationOption) => void;
};

const shortAddress = (address: string): string =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;

export function AssetClarificationCard({
  clarification,
  expiresAt,
  status,
  disabled = false,
  onSelect,
}: Props) {
  const [now, setNow] = useState(currentEpochMs);

  useEffect(() => {
    if (status !== "pending" && status !== "submitting") return;
    const timer = window.setInterval(() => setNow(currentEpochMs()), 1_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const expired = now >= expiresAt || status === "expired";
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const selectionDisabled = disabled || expired || status !== "pending";

  return (
    <div className="mt-4 w-full border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] sm:w-80 md:w-[450px] md:p-4">
      <div className="flex items-start justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-2">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.16em]">
            {clarification.kind === "workflow"
              ? "Workflow decision checkpoint"
              : "Secure token settlement"}</div>
          {clarification.reference && (
            <div className="mt-1 break-all text-[10px] font-bold">
              Detected expression: {clarification.reference}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-[2px] border-[#1A1A1A] bg-white px-2 py-1 text-[9px] font-black uppercase">
          <Clock3 className="h-3 w-3" />
          {expired ? "Expired" : `${remainingSeconds}s`}
        </div>
      </div>

      <p className="mt-3 text-xs font-black leading-relaxed md:text-sm">
        {clarification.question}
      </p>

      {clarification.options.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {clarification.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={selectionDisabled}
              onClick={() => onSelect(option)}
              className="flex w-full items-center justify-between gap-3 border-[3px] border-[#1A1A1A] bg-white p-3 text-left shadow-[3px_3px_0_#1A1A1A] transition-all enabled:hover:-translate-y-0.5 enabled:hover:bg-[#BFF7FF] enabled:active:translate-y-0 enabled:active:shadow-none disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-black">
                  {option.label}
                </span>
                <span className="mt-0.5 block text-[10px] font-bold uppercase">
                  {option.symbol} · {option.trustLabel.replace(/_/gu, " ")}
                </span>
                {option.address && (
                  <span className="mt-1 block font-mono text-[9px] font-bold">
                    {shortAddress(option.address)}
                  </span>
                )}
              </span>
              {status === "submitting" ? (
                <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
              ) : status === "resolved" ? (
                <Check className="h-5 w-5 shrink-0" />
              ) : (
                <span className="shrink-0 border-[2px] border-[#1A1A1A] bg-[#0052FF] px-2 py-1 text-[9px] font-black uppercase text-white">
                  Select
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-3 flex gap-2 border-[3px] border-[#1A1A1A] bg-white p-3 text-xs font-bold">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          No candidate found. Enter the token symbol or full contract address in the message box.
        </div>
      )}

      {(expired || status === "blocked") && (
        <p className="mt-3 border-t-[2px] border-[#1A1A1A] pt-2 text-[10px] font-black">
          This selection is no longer available. Rewrite the intent to create an updated portfolio and proof of security.
        </p>
      )}
    </div>
  );
}
