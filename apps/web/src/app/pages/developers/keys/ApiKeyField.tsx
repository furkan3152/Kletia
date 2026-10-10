import { Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "../../../site/ui/Badge";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { maskKey, portalKeyKind, useSessionKey } from "./sessionKey";

export interface ApiKeyFieldProps {
  readonly className?: string;
  /** Visible label (default "API key"). */
  readonly label?: string;
  readonly compact?: boolean;
}

/**
 * Masked API key input bound to the in-memory session key. Not inside a form
 * and marked for password managers to ignore, so the browser never offers
 * to save it.
 */
export function ApiKeyField({ className, label = "API key", compact = false }: ApiKeyFieldProps) {
  const id = useId();
  const { key, setKey, clear } = useSessionKey();
  const [visible, setVisible] = useState(false);
  const shapeWarning = key && !portalKeyKind(key) && !key.startsWith("kl_");
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className={cx(LABEL, "inline-flex items-center gap-1.5 text-[#1A1A1A] dark:text-[#E2E8F0]")}>
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </label>
        {key ? (
          <Badge tone="yellow" title="Held in this tab's memory only" className="!tracking-[0.08em]">
            <span className="font-code normal-case">{maskKey(key)}</span> in memory
          </Badge>
        ) : (
          <Badge tone="neutral">Public tier</Badge>
        )}
      </div>
      <div className="flex min-w-0">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="kl_dev_… (optional)"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-bwignore=""
          data-form-type="other"
          aria-describedby={`${id}-hint`}
          className={cx(
            "min-h-11 w-full min-w-0 border-[3px] border-r-0 border-[#1A1A1A] bg-white px-3 py-2 font-code text-[13px] text-[#1A1A1A] placeholder:text-[#6B7280] dark:border-[#4B5563] dark:bg-[#0B1120] dark:text-[#F1F5F9] dark:placeholder:text-[#64748B]",
            FOCUS_RING,
            "focus-visible:-outline-offset-4",
          )}
        />
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-pressed={visible}
          aria-label={visible ? "Hide key" : "Show key"}
          className={cx(
            "inline-flex min-h-11 w-11 shrink-0 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#F1EFE8] text-[#1A1A1A] hover:bg-[#FFD60A] dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white dark:hover:bg-[#22345A]",
            key ? "border-r-0" : "",
            FOCUS_RING,
          )}
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
        {key ? (
          <button
            type="button"
            onClick={() => {
              clear();
              setVisible(false);
            }}
            aria-label="Forget key"
            className={cx(
              "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 border-[3px] border-[#1A1A1A] bg-white px-3 text-[10px] font-black uppercase tracking-[0.14em] text-[#1A1A1A] hover:bg-[#FFE4E4] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white dark:hover:bg-[#2A1215]",
              FOCUS_RING,
            )}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className={compact ? "sr-only sm:not-sr-only" : ""}>Forget</span>
          </button>
        ) : null}
      </div>
      <p id={`${id}-hint`} className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
        {shapeWarning ? (
          <span className="font-bold text-[#B91C1C] dark:text-[#FCA5A5]">That does not look like a Kletia key (kl_dev_… or kl_agt_…). </span>
        ) : null}
        Kept in this tab&apos;s memory only: never stored, never put in a snippet, gone on reload. Paste a key here only on a
        device you trust, and keep production keys on your server.
      </p>
    </div>
  );
}
