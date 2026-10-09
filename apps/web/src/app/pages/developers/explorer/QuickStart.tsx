import { cx, FOCUS_RING, HARD_SHADOW_SM, INK_BORDER, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { QUICK_START, type QuickStartPreset } from "./quickStartPresets";

export interface QuickStartProps {
  readonly activeId: string | null;
  readonly onPick: (preset: QuickStartPreset) => void;
}

/** Six one-click requests that load a preset into the explorer. */
export function QuickStart({ activeId, onPick }: QuickStartProps) {
  return (
    <div>
      <p className={cx(LABEL, "mb-3", TEXT_MUTED)}>Quick start: load a request</p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {QUICK_START.map((preset, index) => {
          const active = preset.id === activeId;
          return (
            <li key={preset.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onPick(preset)}
                aria-pressed={active}
                className={cx(
                  "kl-lift group flex h-full w-full min-w-0 items-start gap-3 p-3 text-left transition-colors",
                  INK_BORDER,
                  HARD_SHADOW_SM,
                  active ? "bg-[#FFF7CC] dark:bg-[#22345A]" : "bg-white hover:bg-[#FBFAF7] dark:bg-[#131E32] dark:hover:bg-[#1A2841]",
                  FOCUS_RING,
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center border-2 border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A] dark:border-[#4B5563]"
                >
                  <preset.icon className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-sm font-bold">
                    <span className="font-code text-[10px] text-[#45464B] dark:text-[#A9B6C8]">{String(index + 1).padStart(2, "0")}</span>
                    {preset.title}
                  </span>
                  <span className={cx("text-xs leading-snug", TEXT_MUTED)}>{preset.description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
