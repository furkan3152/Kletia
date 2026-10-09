/**
 * Shared class recipes for the site's neo-brutalist UI. Kept in one place so
 * borders, shadows and focus rings stay identical across components.
 */

export const INK_BORDER = "border-[3px] border-[#1A1A1A] dark:border-[#4B5563]";
export const INK_BORDER_THIN = "border-2 border-[#1A1A1A] dark:border-[#4B5563]";
export const HARD_SHADOW = "shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]";
export const HARD_SHADOW_SM = "shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]";
export const HARD_SHADOW_LG = "shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569]";
export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] dark:focus-visible:outline-[#FFD60A]";
export const SURFACE = "bg-white dark:bg-[#131E32]";
export const SURFACE_MUTED = "bg-[#FBFAF7] dark:bg-[#0F1A2C]";
export const TEXT = "text-[#1A1A1A] dark:text-[#F1F5F9]";
export const TEXT_MUTED = "text-[#45464B] dark:text-[#A9B6C8]";
export const LABEL = "text-[11px] font-black uppercase tracking-[0.18em]";
export const CONTAINER = "mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8";

/*
 * Motion recipes (see src/app/site/motion and styles.css). The `shadow-hard*`
 * utilities read `--kl-shadow-ink`, so one class covers light and dark.
 */
/** Hover/focus-within lift: translate(-2px, -2px) and +2px shadow (pointer devices, motion allowed). */
export const LIFT = "kl-lift";
/** Cursor spotlight overlay; pair with `useSpotlight` for the cursor position. */
export const SPOTLIGHT = "kl-spotlight";
export const SHADOW_HARD = "shadow-hard";
export const SHADOW_HARD_SM = "shadow-hard-sm";
export const SHADOW_HARD_LG = "shadow-hard-lg";

export type ButtonVariant = "primary" | "accent" | "secondary" | "ink" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-[#0052FF] text-white hover:bg-[#0046DB]",
  accent: "bg-[#FFD60A] text-[#1A1A1A] hover:bg-[#FFE04D]",
  secondary:
    "bg-white text-[#1A1A1A] hover:bg-[#FFF7CC] dark:bg-[#1A2841] dark:text-white dark:hover:bg-[#22345A]",
  ink: "bg-[#1A1A1A] text-white hover:bg-black dark:bg-white dark:text-[#0B1120] dark:hover:bg-[#E2E8F0]",
  ghost:
    "bg-transparent text-[#1A1A1A] hover:bg-[#1A1A1A]/5 dark:text-white dark:hover:bg-white/10",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-9 gap-1.5 px-3 py-1.5 text-[11px]",
  md: "min-h-11 gap-2 px-4 py-2.5 text-xs",
  lg: "min-h-14 gap-2.5 px-6 py-3.5 text-sm",
};

/** Class list for a button-like element. */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra = "",
): string {
  // Press physics: hover lifts 2px into a 5px shadow, press pushes 3px into the
  // shadow. Reduced motion keeps the colour feedback without the hover travel.
  const shadow =
    variant === "ghost"
      ? ""
      : "shadow-hard-sm hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-hard-md active:translate-x-[3px] active:translate-y-[3px] active:shadow-none";
  return [
    "inline-flex select-none items-center justify-center whitespace-nowrap font-black uppercase tracking-[0.12em] transition-[transform,box-shadow,background-color] duration-90 ease-kl-snap disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-x-0 motion-reduce:hover:translate-y-0",
    INK_BORDER,
    VARIANTS[variant],
    SIZES[size],
    shadow,
    FOCUS_RING,
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
