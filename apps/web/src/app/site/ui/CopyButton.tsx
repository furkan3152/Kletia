import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "./clipboard";
import { cx, FOCUS_RING } from "./styles";
import { toast } from "./toast";

export interface CopyButtonProps {
  readonly text: string;
  /** Accessible label, e.g. "Copy TypeScript snippet". */
  readonly label?: string;
  readonly className?: string;
  /** Visual style: on dark code chrome or on a light surface. */
  readonly appearance?: "dark" | "light";
  /**
   * How the result is announced: "inline" (own polite live region, default)
   * or "toast" (a toast instead, and no inline live region, so it is never
   * announced twice).
   */
  readonly notify?: "inline" | "toast";
}

/** Copy-to-clipboard button with an announced confirmation. */
export function CopyButton({ text, label = "Copy", className, appearance = "dark", notify = "inline" }: CopyButtonProps) {
  const [state, setState] = useState<{ readonly status: "idle" | "copied" | "failed"; readonly count: number }>({
    status: "idle",
    count: 0,
  });

  useEffect(() => {
    if (state.status === "idle") return undefined;
    const timer = window.setTimeout(() => setState((current) => ({ ...current, status: "idle" })), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const onCopy = async () => {
    const ok = await copyText(text);
    setState((current) => ({ status: ok ? "copied" : "failed", count: current.count + 1 }));
    if (notify === "toast") {
      if (ok) toast.success("Copied to clipboard", { id: "copy" });
      else toast.error("Copy failed", { id: "copy", description: "Your browser blocked clipboard access." });
    }
  };

  const status = state.status;
  return (
    <button
      type="button"
      onClick={onCopy}
      className={cx(
        "inline-flex min-h-9 items-center gap-1.5 border-2 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] transition-colors",
        appearance === "dark"
          ? "border-white/25 bg-white/5 text-white hover:border-[#FFD60A] hover:text-[#FFD60A]"
          : "border-[#1A1A1A] bg-white text-[#1A1A1A] hover:bg-[#FFD60A] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:hover:bg-[#22345A]",
        FOCUS_RING,
        className,
      )}
    >
      {status === "copied" ? (
        <Check key={state.count} className="kl-stamp h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span aria-hidden="true">{status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}</span>
      <span className="sr-only">{label}</span>
      {notify === "inline" ? (
        <span className="sr-only" role="status" aria-live="polite">
          {status === "copied" ? "Copied to clipboard" : status === "failed" ? "Copy failed" : ""}
        </span>
      ) : null}
    </button>
  );
}
