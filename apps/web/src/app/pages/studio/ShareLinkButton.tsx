import { Check, Link2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../site/ui/Button";
import { copyText } from "../../site/ui/clipboard";
import { toast } from "../../site/ui/toast";

/** Studio link that re-plans `text` on open (`/studio?q=…`). Only the prompt goes into it, never the preview addresses. */
function studioShareUrl(text: string): string {
  return `${window.location.origin}/studio?q=${encodeURIComponent(text.trim().slice(0, 500))}`;
}

/**
 * "Copy link" for the plan on screen. The toast confirms it (and announces
 * it politely); the button itself flips to a stamped check for two seconds.
 */
export function ShareLinkButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(0);
  const [showCheck, setShowCheck] = useState(false);

  useEffect(() => {
    if (!showCheck) return undefined;
    const timer = window.setTimeout(() => setShowCheck(false), 2000);
    return () => window.clearTimeout(timer);
  }, [showCheck, copied]);

  const onCopy = async () => {
    const ok = await copyText(studioShareUrl(text));
    if (ok) {
      setCopied((count) => count + 1);
      setShowCheck(true);
      toast.success("Link copied", {
        id: "studio-link",
        description: "Opening it plans the same intent in Studio. It contains the prompt only.",
      });
    } else {
      toast.error("Copy failed", { id: "studio-link", description: "Your browser blocked clipboard access." });
    }
  };

  return (
    <Button variant="ghost" size="sm" onClick={() => void onCopy()}>
      {showCheck ? (
        <Check key={copied} className="kl-stamp h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Copy link
    </Button>
  );
}
