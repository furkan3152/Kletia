import { PenLine } from "lucide-react";

import { cx, TEXT_MUTED } from "../../../site/ui/styles";
import { STEP_UP_NOTE } from "../model/confirm";

/** The one-line notice before a write: the session's wallet signs a confirmation first. */
export function StepUpNote({ className }: { readonly className?: string }) {
  return (
    <p className={cx("flex items-start gap-2 text-sm", TEXT_MUTED, className)}>
      <PenLine className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {STEP_UP_NOTE}
    </p>
  );
}
