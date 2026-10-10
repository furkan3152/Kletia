import { KeyRound } from "lucide-react";

import { Link } from "../../../routes/Link";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../../site/ui/styles";
import { ApiKeyField } from "../keys/ApiKeyField";
import { useSessionKey } from "../keys/sessionKey";

export interface NeedKeyProps {
  /** "list and register your contracts". */
  readonly purpose: string;
  /** Agent keys work here too (read their own subtree). */
  readonly agentKeys?: boolean;
  readonly className?: string;
}

/**
 * Shown by a portal panel while no usable key is in memory. The field is the
 * same in-memory key as the key manager (never stored), so loading it here
 * loads it for every panel on the page.
 */
export function NeedKey({ purpose, agentKeys = false, className }: NeedKeyProps) {
  const { key } = useSessionKey();
  const partial = key.length > 0;
  return (
    <div className={cx("flex min-w-0 flex-col gap-4 border-[3px] border-dashed border-[#1A1A1A]/40 p-4 dark:border-white/20 sm:p-5", className)}>
      <p className="flex items-start gap-2 text-sm leading-relaxed">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          {partial ? (
            <>
              That is not a complete {agentKeys ? "developer or agent key" : "developer key"}.{" "}
              {agentKeys ? "Paste a kl_dev_ or kl_agt_ key" : "Paste a kl_dev_ key"} to {purpose}.
            </>
          ) : (
            <>
              Load a {agentKeys ? "developer or agent key" : "developer key"} to {purpose}. It stays in this tab&apos;s memory only.{" "}
              <Link to="/developers#keys" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
                Issue a key
              </Link>{" "}
              if you have none.
            </>
          )}
        </span>
      </p>
      <ApiKeyField label="Key for this panel" compact className="max-w-xl" />
      <p className={cx("text-xs", TEXT_MUTED)}>The key manager, the Rule Book, contracts and links all share this one key in memory.</p>
    </div>
  );
}
