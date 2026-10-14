import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { cx, FOCUS_RING, INK_BORDER, TEXT_MUTED } from "../../../site/ui/styles";
import { QUICK_START, type QuickStartPreset } from "./quickStartPresets";

export interface ExamplesMenuProps {
  /** Presets whose operation exists in the current document. */
  readonly available: (preset: QuickStartPreset) => boolean;
  readonly onPick: (preset: QuickStartPreset) => void;
}

/**
 * "Examples" in the request pane (portal design P-16): ready requests that
 * load an operation with its parameters and body. The Overview owns the
 * first call; these are for exploring.
 */
export function ExamplesMenu({ available, onPick }: ExamplesMenuProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const presets = QUICK_START.filter(available);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (presets.length === 0) return null;
  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className={cx("inline-flex min-h-11 items-center gap-1.5 border-[3px] border-control bg-surface px-3 text-sm font-bold", FOCUS_RING)}
      >
        Examples
        <ChevronDown className={cx("h-4 w-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={menuId} className={cx("absolute right-0 z-30 mt-2 flex w-[min(22rem,calc(100vw-2rem))] flex-col bg-surface p-1 shadow-hard", INK_BORDER)}>
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(preset);
                }}
                className={cx("flex w-full min-w-0 items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2", FOCUS_RING)}
              >
                <preset.icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-bold">{preset.title}</span>
                  <span className={cx("text-xs leading-snug", TEXT_MUTED)}>{preset.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
