/**
 * Shared class recipes for the site's UI (Card machine). Kept in one place so
 * borders, shadows and focus rings stay identical across components. Colours
 * come from the semantic tokens in styles.css wherever a role exists for
 * them.
 */

/**
 * Decorative rules and object outlines. Card machine: hairlines, no heavy ink; the
 * slab (2 px ink + hard offset) is reserved for the printed card, the composer and the ticket.
 */
export const INK_BORDER = "border border-[var(--k-line-2)]";
export const INK_BORDER_THIN = "border border-[var(--k-line-2)]";
/** The slab: only the card, the composer and the trade ticket. */
export const SLAB = "border-2 border-[var(--k-slab-line)] shadow-slab";
/**
 * Borders of inputs, selects, buttons, tabs and toggles: at least 3:1 against
 * the page and panels in both themes (WCAG 1.4.11).
 */
export const CONTROL_BORDER = "border-[1.5px] border-control";
/** Raised objects: the Card machine's soft object shadow (the HARD_ names date from the hard-offset style). */
export const HARD_SHADOW = "shadow-obj";
export const HARD_SHADOW_SM = "shadow-obj";
export const HARD_SHADOW_LG = "shadow-obj";
export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-focus";
export const SURFACE = "bg-surface";
export const TEXT = "text-fg";
export const TEXT_MUTED = "text-muted";
/** Field labels, table headers, pills and group labels: 12 px, 0.08em, uppercase (the type floor). */
export const LABEL = "text-label uppercase";
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

export type ButtonVariant = "primary" | "accent" | "secondary" | "ink" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

// Card machine keys (kit/Key.tsx is the React twin): a keycap with a 4 px bottom edge
// that travels 3 px in 60 ms when pressed (.kl-key in styles.css). Lime is the one accent and
// carries ink text.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "kl-key kl-key--lime",
  accent: "kl-key kl-key--lime",
  secondary: "kl-key",
  ink: "kl-key kl-key--ink",
  ghost: "rounded-key border border-transparent bg-transparent text-[var(--k-ink)] hover:bg-[var(--k-panel-2)]",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-9 gap-1.5 rounded-[8px] px-3 py-1.5 text-[13.5px]",
  md: "min-h-11 gap-2 rounded-key px-4 py-2.5 text-[14.5px]",
  lg: "min-h-14 gap-2.5 rounded-[12px] px-6 py-3.5 text-base",
};

/** Class list for a button-like element. */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra = "",
): string {
  return [
    "inline-flex select-none items-center justify-center whitespace-nowrap font-semibold disabled:pointer-events-none disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
    FOCUS_RING,
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
