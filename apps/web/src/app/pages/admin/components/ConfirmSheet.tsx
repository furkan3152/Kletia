import { TriangleAlert } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Button } from "../../../site/ui/Button";
import { TextField } from "../../../site/ui/Field";
import { Sheet } from "../../../site/ui/Sheet";
import { cx, TEXT_MUTED } from "../../../site/ui/styles";
import { StepUpNote } from "./StepUpNote";

/**
 * A confirmation for a dangerous step (admin design D.5): a red sheet that
 * says what cannot be undone and, when `phrase` is set, asks for it typed
 * exactly before the button arms.
 */
export function ConfirmSheet({
  open,
  onClose,
  title,
  warning,
  children,
  phrase,
  confirmLabel,
  onConfirm,
  busy = false,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly warning: string;
  readonly children?: React.ReactNode;
  readonly phrase?: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const armed = !phrase || typed.trim() === phrase;
  return (
    <Sheet open={open} onClose={onClose} title={title} side="right" phone="full" widthClassName="md:w-[30rem]">
      <div className="flex flex-col gap-4 p-5">
        <p className="flex items-start gap-2 border-[3px] border-[#B91C1C] bg-danger-bg p-3 text-sm font-bold text-danger">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {warning}
        </p>
        {children ? <div className={cx("flex flex-col gap-3 text-sm", TEXT_MUTED)}>{children}</div> : null}
        {phrase ? (
          <TextField
            label={`Type "${phrase}" to continue`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        <StepUpNote />
        <div className="flex flex-wrap gap-2">
          <Button variant="ink" onClick={onConfirm} disabled={!armed} loading={busy}>
            {confirmLabel}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
