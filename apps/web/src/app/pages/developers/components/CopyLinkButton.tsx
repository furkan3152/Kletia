import { Check, Link2 } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "../../../site/ui/clipboard";
import { cx, FOCUS_RING } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";

export interface CopyLinkButtonProps {
  /** Absolute URL to copy. */
  readonly href: string;
  /** What the link points at, for the accessible name ("Copy link to …"). */
  readonly target: string;
  readonly className?: string;
  /** Hide the visible "Link" text (icon only). */
  readonly iconOnly?: boolean;
}

/** Copies a deep link and confirms with a toast (the toast is the live announcement). */
export function CopyLinkButton({ href, target, className, iconOnly = false }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (copied === 0) return undefined;
    const timer = window.setTimeout(() => setCopied(0), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const onClick = async () => {
    const ok = await copyText(href);
    if (ok) {
      setCopied((value) => value + 1);
      toast.success("Link copied", { id: "copy-link", description: href });
    } else {
      toast.error("Copy failed", { id: "copy-link", description: "Your browser blocked clipboard access." });
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Copy link to ${target}`}
      title={href}
      className={cx(
        "inline-flex min-h-9 min-w-9 items-center justify-center gap-1.5 border-2 border-control bg-[#FBFAF6] px-2 text-label uppercase text-[#121212] hover:bg-[#C6FF3A] dark:border-[#4A4A52] dark:bg-[#232327] dark:text-white dark:hover:bg-[#2A2A2E]",
        FOCUS_RING,
        className,
      )}
    >
      {copied ? (
        <Check key={copied} className="kl-stamp h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {iconOnly ? null : <span aria-hidden="true">{copied ? "Copied" : "Link"}</span>}
    </button>
  );
}
