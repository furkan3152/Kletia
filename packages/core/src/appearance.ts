/**
 * Appearance tokens for the widget and the embed (integrator design §4.2):
 * the `kletia.appearance/v1` shape and the constants its resolver uses.
 * Types and constants only; the validator and resolver (contrast checks,
 * CSS variables, query form) land with the integrator packages and read
 * these constants, so the API, the `/embed` frame, the React widget and the
 * portal builder agree on one vocabulary.
 */

export const APPEARANCE_SCHEMA = "kletia.appearance/v1";

export const APPEARANCE_FONTS = Object.freeze(["inter", "system", "serif", "mono", "rounded"] as const);
export type AppearanceFont = (typeof APPEARANCE_FONTS)[number];

/** Font stacks per font token: local stacks only, never a remote font URL. */
export const APPEARANCE_FONT_STACKS: Readonly<Record<AppearanceFont, string>> = Object.freeze({
  inter: 'Inter, "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  rounded: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
});

export const APPEARANCE_COLOR_SCHEMES = Object.freeze(["light", "dark", "auto"] as const);
export type AppearanceColorScheme = (typeof APPEARANCE_COLOR_SCHEMES)[number];
export const APPEARANCE_SHADOWS = Object.freeze(["hard", "soft", "none"] as const);
export type AppearanceShadow = (typeof APPEARANCE_SHADOWS)[number];
export const APPEARANCE_DENSITIES = Object.freeze(["comfortable", "compact"] as const);
export type AppearanceDensity = (typeof APPEARANCE_DENSITIES)[number];
export const APPEARANCE_HEADERS = Object.freeze(["kletia", "brand", "none"] as const);
export type AppearanceHeader = (typeof APPEARANCE_HEADERS)[number];

/** "#RRGGBB" (six hex digits, either case). */
export const APPEARANCE_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/u;

export interface AppearanceColors {
  /** "#RRGGBB": primary button, focus ring, links. */
  readonly accent?: string;
  /** Text on accent (default: whichever of #FFFFFF/#141414 contrasts more). */
  readonly accentInk?: string;
  /** Widget background. */
  readonly surface?: string;
  /** Body text. */
  readonly ink?: string;
  /** Borders. */
  readonly line?: string;
}

export const APPEARANCE_COLOR_KEYS = Object.freeze(["accent", "accentInk", "surface", "ink", "line"] as const);

export interface KletiaAppearance {
  readonly colorScheme?: AppearanceColorScheme;
  readonly light?: AppearanceColors;
  readonly dark?: AppearanceColors;
  /** 0..16 px (default 0). */
  readonly radius?: number;
  /** Default 3 (inner elements: border - 1, min 1). */
  readonly border?: 1 | 2 | 3;
  /** Default hard. */
  readonly shadow?: AppearanceShadow;
  /** Default inter (no remote font URLs, ever). */
  readonly font?: AppearanceFont;
  /** Default comfortable. */
  readonly density?: AppearanceDensity;
  /** "brand" needs a verified project profile (projects phase). */
  readonly header?: AppearanceHeader;
}

export const APPEARANCE_WARNING_CODES = Object.freeze(["COLOR_INVALID", "CONTRAST_LOW", "VALUE_OUT_OF_RANGE", "UNKNOWN_VALUE"] as const);
export type AppearanceWarningCode = (typeof APPEARANCE_WARNING_CODES)[number];

export interface AppearanceWarning {
  readonly code: AppearanceWarningCode;
  readonly path: string;
  readonly message: string;
  readonly fallback?: string;
}

/** What the resolver returns: public CSS variables, the header actually shown and any fallbacks taken. */
export interface ResolvedAppearance {
  readonly vars: Readonly<Record<string, string>>;
  readonly header: AppearanceHeader;
  readonly warnings: readonly AppearanceWarning[];
}

/** Defaults: the stock widget, pixel-identical to the pre-token styles. */
export const APPEARANCE_DEFAULTS = Object.freeze({
  colorScheme: "light",
  radius: 0,
  border: 3,
  shadow: "hard",
  font: "inter",
  density: "comfortable",
  header: "kletia",
} as const satisfies Required<Omit<KletiaAppearance, "light" | "dark">>);

export const APPEARANCE_LIMITS = Object.freeze({
  radiusMin: 0,
  radiusMax: 16,
  borderMin: 1,
  borderMax: 3,
  /** WCAG 1.4.3: text against its background. */
  textContrast: 4.5,
  /** WCAG 1.4.11: borders and the focus ring against the surface. */
  uiContrast: 3,
  /** Muted ink: ink mixed this share toward the surface, then raised until it meets textContrast. */
  mutedMix: 0.35,
  /** Chip background: surface mixed this share toward ink. */
  chipMix: 0.06,
});

/** Fallback inks when a custom ink fails contrast (the better of the two is taken). */
export const APPEARANCE_FALLBACK_INKS = Object.freeze(["#141414", "#F4F4F5"] as const);

/** Padding, gap and text size (px) per density; buttons keep min-height 44px. */
export const APPEARANCE_DENSITY_METRICS: Readonly<Record<AppearanceDensity, { readonly pad: number; readonly gap: number; readonly text: number }>> =
  Object.freeze({
    comfortable: Object.freeze({ pad: 16, gap: 8, text: 15 }),
    compact: Object.freeze({ pad: 12, gap: 6, text: 14 }),
  });

/** Box shadows per shadow token. */
export const APPEARANCE_SHADOW_VALUES: Readonly<Record<AppearanceShadow, string>> = Object.freeze({
  hard: "4px 4px 0 var(--kw-line)",
  soft: "0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .08)",
  none: "none",
});

/**
 * The public CSS variables (the documented escape hatch); every other
 * `--kw-*` variable is internal. Status colours, plates, ticket stock, review
 * notices, policy and receipt stamps are never themable.
 */
export const APPEARANCE_PUBLIC_VARIABLES = Object.freeze([
  "--kw-paper", "--kw-ink", "--kw-muted", "--kw-line", "--kw-accent", "--kw-accent-ink", "--kw-accent-text", "--kw-chip",
  "--kw-radius", "--kw-border", "--kw-border-inner", "--kw-shadow", "--kw-font", "--kw-pad", "--kw-gap", "--kw-text",
] as const);
export type AppearanceVariable = (typeof APPEARANCE_PUBLIC_VARIABLES)[number];
