import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "./clipboard";
import { cx, FOCUS_RING } from "./styles";

export interface CopyButtonProps {
  readonly text: string;
  /** Accessible label, e.g. "Copy TypeScript snippet". */
  readonly label?: string;
  readonly className?: string;
  /** Visual style: on dark code chrome or on a light surface. */
  readonly appearance?: "dark" | "light";
}

/** Copy-to-clipboard button with an announced confirmation. */
export function CopyButton({ text, label = "Copy", className, appearance = "dark" }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      onClick={async () => setState((await copyText(text)) ? "copied" : "failed")}
      className={cx(
        "inline-flex min-h-9 items-center gap-1.5 border-2 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] transition-colors",
        appearance === "dark"
          ? "border-white/25 bg-white/5 text-white hover:border-[#FFD60A] hover:text-[#FFD60A]"
          : "border-[#1A1A1A] bg-white text-[#1A1A1A] hover:bg-[#FFD60A] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:hover:bg-[#22345A]",
        FOCUS_RING,
        className,
      )}
    >
      {state === "copied" ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span aria-hidden="true">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
      <span className="sr-only">{label}</span>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}
