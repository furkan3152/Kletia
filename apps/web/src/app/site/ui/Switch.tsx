import React, { useId } from "react";

import { cx, FOCUS_RING, TEXT_MUTED } from "./styles";

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** Visible label: the switch's accessible name. */
  readonly label: React.ReactNode;
  /** One line under the label, read as the switch's description. */
  readonly description?: React.ReactNode;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * An on/off control: `role="switch"` with `aria-checked`, a track in the
 * control colour (3:1 in both themes) and a knob whose place, not only its
 * colour, shows the state. Used by auto-refresh and the motion setting.
 */
export function Switch({ checked, onChange, label, description, disabled = false, className }: SwitchProps) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={description ? descriptionId : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "group inline-flex min-h-11 items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-60",
        FOCUS_RING,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "relative inline-flex h-6 w-11 shrink-0 items-center border-[3px] border-control transition-colors duration-150 motion-reduce:transition-none",
          checked ? "bg-accent" : "bg-surface",
        )}
      >
        <span
          className={cx(
            "absolute top-[1px] h-4 w-4 border-2 border-control transition-transform duration-150 ease-kl-snap motion-reduce:transition-none",
            checked ? "translate-x-[22px] bg-white" : "translate-x-[1px] bg-[#1A1A1A] dark:bg-[#F1F5F9]",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-bold">{label}</span>
        {description ? (
          // Hidden from the name (the label alone names the switch), read as its description.
          <span id={descriptionId} aria-hidden="true" className={cx("text-xs", TEXT_MUTED)}>
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}
