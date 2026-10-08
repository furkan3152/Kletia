import { Moon, Sun } from "lucide-react";

import type { SiteTheme } from "./theme";
import { cx, FOCUS_RING, HARD_SHADOW_SM, INK_BORDER } from "./ui/styles";

export interface ThemeToggleProps {
  readonly theme: SiteTheme;
  readonly onToggle: () => void;
  readonly className?: string;
}

/** Light/dark switch for the site (stored under "kletia-site-theme"). */
export function ThemeToggle({ theme, onToggle, className }: ThemeToggleProps) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={dark}
      aria-label="Dark theme"
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={cx(
        "inline-flex h-11 w-11 shrink-0 items-center justify-center bg-white text-[#1A1A1A] transition-[transform,box-shadow] duration-100 hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none dark:bg-[#1A2841] dark:text-[#FFD60A] motion-reduce:transition-none",
        INK_BORDER,
        HARD_SHADOW_SM,
        FOCUS_RING,
        className,
      )}
    >
      {dark ? <Moon className="h-5 w-5" aria-hidden="true" /> : <Sun className="h-5 w-5" aria-hidden="true" />}
    </button>
  );
}
