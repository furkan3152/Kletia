import { Moon, Sun } from "lucide-react";

import type { SiteTheme } from "./theme";
import { cx, FOCUS_RING, HARD_SHADOW_SM, INK_BORDER } from "./ui/styles";

export interface ThemeToggleProps {
  readonly theme: SiteTheme;
  /** Receives the button centre (viewport px) so the theme can reveal from it. */
  readonly onToggle: (origin?: { x: number; y: number }) => void;
  readonly className?: string;
}

const ICON =
  "absolute h-5 w-5 transition-[transform,opacity] duration-240 ease-kl-snap motion-reduce:transition-none";

/** Light/dark switch for the site (stored under "kletia-site-theme"). Sun and moon swap with a quarter turn. */
export function ThemeToggle({ theme, onToggle, className }: ThemeToggleProps) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onToggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      aria-pressed={dark}
      aria-label="Dark theme"
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={cx(
        "relative inline-flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden bg-white text-[#1A1A1A] transition-[transform,box-shadow] duration-90 ease-kl-snap hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none dark:bg-[#1A2841] dark:text-[#FFD60A] motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        INK_BORDER,
        HARD_SHADOW_SM,
        FOCUS_RING,
        className,
      )}
    >
      <Sun className={cx(ICON, dark ? "rotate-90 scale-50 opacity-0" : "rotate-0 opacity-100")} aria-hidden="true" />
      <Moon className={cx(ICON, dark ? "rotate-0 opacity-100" : "-rotate-90 scale-50 opacity-0")} aria-hidden="true" />
    </button>
  );
}
