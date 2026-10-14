/**
 * Appearance tokens for the widget and the embed: the `kletia.appearance/v1`
 * shape, its validator, the resolver that turns it into `--kw-*` CSS
 * variables with contrast floors, and the compact query form the `/embed`
 * frame reads. One pure module, so the API, the `/embed` frame, the React
 * widget and the portal builder agree on one vocabulary.
 *
 * Fail closed: a colour that misses its contrast floor falls back to a safe
 * value, never the other way round. Only validated hex colours, clamped
 * integers and values looked up from fixed tables ever reach a CSS variable,
 * so no input can inject CSS. Safety signage (status colours, the fare's
 * ticket stock and plates, stamps, review notices, policy holds) has no token
 * and is never emitted.
 */

import type { ValidationIssue, ValidationResult } from "./validation.js";

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
  "--kw-focus",
] as const);
export type AppearanceVariable = (typeof APPEARANCE_PUBLIC_VARIABLES)[number];

/**
 * Variables that belong to safety surfaces. No appearance token maps to them
 * and `resolveAppearance` never emits them (tests assert it).
 */
export const APPEARANCE_FIXED_VARIABLES = Object.freeze([
  "--kw-ok", "--kw-warn", "--kw-bad", "--kw-ok-ink", "--kw-warn-ink", "--kw-bad-ink",
  "--kw-plate", "--kw-plate-ink", "--kw-stock", "--kw-stock-ink", "--kw-stock-muted", "--kw-receipt-ink",
] as const);

/** Stock colours per scheme (the values `styles.ts` of `@kletia/widget` declares). */
export const APPEARANCE_SCHEME_COLORS: Readonly<Record<"light" | "dark", {
  readonly paper: string; readonly ink: string; readonly muted: string; readonly line: string;
  readonly accent: string; readonly accentInk: string; readonly accentText: string; readonly chip: string;
}>> = Object.freeze({
  light: Object.freeze({ paper: "#FFFDF8", ink: "#141414", muted: "#5B5B5B", line: "#141414", accent: "#0052FF", accentInk: "#FFFFFF", accentText: "#0052FF", chip: "#F1EEE6" }),
  dark: Object.freeze({ paper: "#111827", ink: "#F4F4F5", muted: "#A1A1AA", line: "#4B5563", accent: "#0052FF", accentInk: "#FFFFFF", accentText: "#7EA6FF", chip: "#1F2937" }),
});

/** Inks the accent's text is picked from when none is given (or the given one fails contrast). */
export const APPEARANCE_ACCENT_INKS = Object.freeze(["#FFFFFF", "#141414"] as const);

const APPEARANCE_KEYS = new Set(["colorScheme", "light", "dark", "radius", "border", "shadow", "font", "density", "header"]);
const COLOR_KEYS: readonly (keyof AppearanceColors)[] = APPEARANCE_COLOR_KEYS;

type Rgb = readonly [number, number, number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "#RRGGBB" (upper case) from "#rrggbb" or "rrggbb"; null for anything else. */
export function normalizeAppearanceColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  return APPEARANCE_COLOR_PATTERN.test(hex) ? hex.toUpperCase() : null;
}

function rgbOf(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hexOf(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio of two "#RRGGBB" colours (1 to 21). Invalid colours give 1. */
export function contrastRatio(a: string, b: string): number {
  const left = normalizeAppearanceColor(a);
  const right = normalizeAppearanceColor(b);
  if (!left || !right) return 1;
  const [hi, lo] = [luminance(left), luminance(right)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `from` mixed `share` (0..1) of the way toward `to`. */
function mix(from: string, to: string, share: number): string {
  const a = rgbOf(from);
  const b = rgbOf(to);
  return hexOf([a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share]);
}

/** The candidate with the highest contrast against `background`. */
function bestOf(candidates: readonly string[], background: string): string {
  return candidates.reduce((best, next) => (contrastRatio(next, background) > contrastRatio(best, background) ? next : best));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
}

/** Numbers and numeric strings ("12", "12px"); null for anything else. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(-?\d{1,5}(?:\.\d{1,3})?)(?:px)?\s*$/u.exec(value);
  return match ? Number(match[1]) : null;
}

export type AppearanceValidation = ValidationResult<KletiaAppearance> & { readonly warnings: readonly AppearanceWarning[] };

/**
 * Validates an appearance object (API project defaults, widget props, the
 * portal builder). Strict about shape: unknown keys, invalid colours and
 * unknown enum values (a font Kletia does not ship, for example) are issues.
 * Radius and border outside their range are clamped with a
 * `VALUE_OUT_OF_RANGE` warning. Colours come back as "#RRGGBB".
 */
export function validateAppearance(input: unknown): AppearanceValidation {
  const issues: ValidationIssue[] = [];
  const warnings: AppearanceWarning[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "appearance", message: "Must be an object." }], warnings };
  const out: { -readonly [K in keyof KletiaAppearance]: KletiaAppearance[K] } = {};
  for (const key of Object.keys(input)) {
    if (!APPEARANCE_KEYS.has(key)) issues.push({ path: `appearance.${key.slice(0, 40)}`, message: "Unknown appearance field." });
  }
  const enumField = <T extends string>(key: "colorScheme" | "shadow" | "font" | "density" | "header", values: readonly T[]): T | undefined => {
    const value = input[key];
    if (value === undefined) return undefined;
    const known = oneOf(values, value);
    if (!known) issues.push({ path: `appearance.${key}`, message: `Must be one of ${values.join(", ")}.` });
    return known ?? undefined;
  };
  const colorScheme = enumField("colorScheme", APPEARANCE_COLOR_SCHEMES);
  if (colorScheme) out.colorScheme = colorScheme;
  for (const scheme of ["light", "dark"] as const) {
    const palette = input[scheme];
    if (palette === undefined) continue;
    if (!isRecord(palette)) {
      issues.push({ path: `appearance.${scheme}`, message: "Must be an object of colours." });
      continue;
    }
    const colors: { -readonly [K in keyof AppearanceColors]: string } = {};
    for (const key of Object.keys(palette)) {
      const name = key as keyof AppearanceColors;
      if (!COLOR_KEYS.includes(name)) {
        issues.push({ path: `appearance.${scheme}.${key.slice(0, 40)}`, message: `Unknown colour; use ${COLOR_KEYS.join(", ")}.` });
        continue;
      }
      const raw = palette[key];
      const color = typeof raw === "string" && APPEARANCE_COLOR_PATTERN.test(raw) ? normalizeAppearanceColor(raw) : null;
      if (!color) {
        issues.push({ path: `appearance.${scheme}.${key}`, message: "Must be a colour written #RRGGBB." });
        continue;
      }
      colors[name] = color;
    }
    if (Object.keys(colors).length > 0) out[scheme] = colors;
  }
  for (const [key, min, max] of [["radius", APPEARANCE_LIMITS.radiusMin, APPEARANCE_LIMITS.radiusMax], ["border", APPEARANCE_LIMITS.borderMin, APPEARANCE_LIMITS.borderMax]] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path: `appearance.${key}`, message: `Must be a number from ${min} to ${max}.` });
      continue;
    }
    const clamped = clampInteger(value, min, max);
    if (clamped !== value) {
      warnings.push({ code: "VALUE_OUT_OF_RANGE", path: `appearance.${key}`, message: `Kept within ${min}-${max}.`, fallback: String(clamped) });
    }
    if (key === "radius") out.radius = clamped;
    else out.border = clamped as 1 | 2 | 3;
  }
  const shadow = enumField("shadow", APPEARANCE_SHADOWS);
  if (shadow) out.shadow = shadow;
  const font = enumField("font", APPEARANCE_FONTS);
  if (font) out.font = font;
  const density = enumField("density", APPEARANCE_DENSITIES);
  if (density) out.density = density;
  const header = enumField("header", APPEARANCE_HEADERS);
  if (header) out.header = header;
  return issues.length > 0 ? { ok: false, issues, warnings } : { ok: true, value: out, warnings };
}

type SchemeColors = (typeof APPEARANCE_SCHEME_COLORS)["light"];

/** The palette a scheme uses: its own, or (dark without one) the light palette's accent only. */
function paletteFor(appearance: KletiaAppearance, scheme: "light" | "dark"): AppearanceColors {
  const own = scheme === "light" ? appearance.light : appearance.dark;
  if (own) return own;
  if (scheme === "dark" && appearance.light) {
    const { accent, accentInk } = appearance.light;
    return { ...(accent !== undefined ? { accent } : {}), ...(accentInk !== undefined ? { accentInk } : {}) };
  }
  return {};
}

function resolveColors(palette: AppearanceColors, scheme: "light" | "dark", warnings: AppearanceWarning[]): Record<string, string> {
  const stock: SchemeColors = APPEARANCE_SCHEME_COLORS[scheme];
  const read = (key: keyof AppearanceColors): string | null => {
    const raw = palette[key];
    if (raw === undefined) return null;
    const color = normalizeAppearanceColor(raw);
    if (!color) warnings.push({ code: "COLOR_INVALID", path: `${scheme}.${key}`, message: "Not a #RRGGBB colour; ignored." });
    return color;
  };
  const given = { surface: read("surface"), ink: read("ink"), line: read("line"), accent: read("accent"), accentInk: read("accentInk") };
  if (!given.surface && !given.ink && !given.line && !given.accent && !given.accentInk) return {};
  const { textContrast, uiContrast } = APPEARANCE_LIMITS;
  const vars: Record<string, string> = {};

  let surface = given.surface ?? stock.paper;
  let ink = given.ink ?? stock.ink;
  if (contrastRatio(ink, surface) < textContrast) {
    const better = bestOf(APPEARANCE_FALLBACK_INKS, surface);
    if (contrastRatio(better, surface) >= textContrast) {
      warnings.push({ code: "CONTRAST_LOW", path: `${scheme}.ink`, message: "Body text was too faint on this surface; a readable ink is used.", fallback: better });
      ink = better;
    } else {
      warnings.push({ code: "CONTRAST_LOW", path: `${scheme}.surface`, message: "No readable ink exists on this surface; the stock surface and ink are used.", fallback: stock.paper });
      surface = stock.paper;
      ink = stock.ink;
    }
  }
  const customBase = surface !== stock.paper || ink !== stock.ink;
  if (customBase) {
    vars["--kw-paper"] = surface;
    vars["--kw-ink"] = ink;
    // Muted text: ink mixed toward the surface, then raised toward ink until it is readable.
    let share: number = APPEARANCE_LIMITS.mutedMix;
    let muted = mix(ink, surface, share);
    while (contrastRatio(muted, surface) < textContrast && share > 0) {
      share = Math.max(0, share - 0.05);
      muted = mix(ink, surface, share);
    }
    vars["--kw-muted"] = muted;
    vars["--kw-chip"] = mix(surface, ink, APPEARANCE_LIMITS.chipMix);
  }

  let line = given.line ?? (customBase ? ink : stock.line);
  if (given.line && contrastRatio(line, surface) < uiContrast) {
    warnings.push({ code: "CONTRAST_LOW", path: `${scheme}.line`, message: "Borders were too faint on this surface; the ink colour is used.", fallback: ink });
    line = ink;
  }
  if (line !== stock.line || customBase) vars["--kw-line"] = line;

  let accent = given.accent ?? stock.accent;
  let accentInk = given.accentInk ?? null;
  if (accentInk && contrastRatio(accentInk, accent) < textContrast) {
    warnings.push({ code: "CONTRAST_LOW", path: `${scheme}.accentInk`, message: "Text on the accent was too faint; a readable one is used." });
    accentInk = null;
  }
  if (!accentInk) {
    const picked = bestOf(APPEARANCE_ACCENT_INKS, accent);
    if (contrastRatio(picked, accent) >= textContrast) {
      accentInk = picked;
    } else {
      warnings.push({ code: "CONTRAST_LOW", path: `${scheme}.accent`, message: "No text is readable on this accent; the stock accent is used.", fallback: stock.accent });
      accent = stock.accent;
      accentInk = stock.accentInk;
    }
  }
  if (accent !== stock.accent || accentInk !== stock.accentInk || customBase) {
    vars["--kw-accent"] = accent;
    vars["--kw-accent-ink"] = accentInk;
  }
  if (accent !== stock.accent || customBase) {
    // Links use the accent only where it is readable as text; the focus ring only where it is visible.
    vars["--kw-accent-text"] = contrastRatio(accent, surface) >= textContrast ? accent : ink;
    vars["--kw-focus"] = contrastRatio(accent, surface) >= uiContrast ? accent : ink;
  }
  return vars;
}

/**
 * Turns an appearance into the widget's public CSS variables for one scheme.
 * Without an appearance (or with one that only repeats the defaults) no
 * variable is emitted and the stock styles apply unchanged. Values that are
 * not valid are ignored with a warning, so this is safe on unvalidated input.
 * `header: "brand"` needs `brandVerified` (a verified project profile); it
 * falls back to the Kletia header otherwise.
 */
export function resolveAppearance(appearance: KletiaAppearance | undefined, scheme: "light" | "dark", options: { readonly brandVerified?: boolean } = {}): ResolvedAppearance {
  const warnings: AppearanceWarning[] = [];
  const vars: Record<string, string> = {};
  if (!appearance || !isRecord(appearance)) return { vars, header: APPEARANCE_DEFAULTS.header, warnings };
  Object.assign(vars, resolveColors(paletteFor(appearance, scheme), scheme, warnings));
  const radius = numberOf(appearance.radius);
  if (radius !== null) vars["--kw-radius"] = `${clampInteger(radius, APPEARANCE_LIMITS.radiusMin, APPEARANCE_LIMITS.radiusMax)}px`;
  const border = numberOf(appearance.border);
  if (border !== null) {
    const width = clampInteger(border, APPEARANCE_LIMITS.borderMin, APPEARANCE_LIMITS.borderMax);
    vars["--kw-border"] = `${width}px`;
    vars["--kw-border-inner"] = `${Math.max(1, width - 1)}px`;
  }
  const shadow = oneOf(APPEARANCE_SHADOWS, appearance.shadow);
  if (shadow) vars["--kw-shadow"] = APPEARANCE_SHADOW_VALUES[shadow];
  const font = oneOf(APPEARANCE_FONTS, appearance.font);
  if (font) vars["--kw-font"] = APPEARANCE_FONT_STACKS[font];
  const density = oneOf(APPEARANCE_DENSITIES, appearance.density);
  if (density) {
    const metrics = APPEARANCE_DENSITY_METRICS[density];
    vars["--kw-pad"] = `${metrics.pad}px`;
    vars["--kw-gap"] = `${metrics.gap}px`;
    vars["--kw-text"] = `${metrics.text}px`;
  }
  let header = oneOf(APPEARANCE_HEADERS, appearance.header) ?? APPEARANCE_DEFAULTS.header;
  if (header === "brand" && !options.brandVerified) {
    warnings.push({ code: "UNKNOWN_VALUE", path: "header", message: "The brand header needs a verified project; the Kletia header is shown.", fallback: "kletia" });
    header = "kletia";
  }
  return { vars, header, warnings };
}

/** Query parameter of each colour: light palette under the plain name, dark with a `-dark` suffix. */
const COLOR_PARAMS: readonly (readonly [keyof AppearanceColors, string])[] = [
  ["accent", "accent"], ["accentInk", "accent-ink"], ["surface", "surface"], ["ink", "ink"], ["line", "line"],
];

/** Every query parameter the appearance uses, for the `/embed` frame and `<kletia-intent>`. */
export const APPEARANCE_PARAMS = Object.freeze([
  ...COLOR_PARAMS.map(([, name]) => name),
  ...COLOR_PARAMS.map(([, name]) => `${name}-dark`),
  "radius", "border", "shadow", "font", "density", "header",
]);

/**
 * The compact query form of an appearance (`accent=0052FF&radius=8`).
 * Colours drop the "#"; invalid values are left out. `colorScheme` travels
 * in the frame's own `theme` parameter.
 */
export function appearanceToParams(appearance: KletiaAppearance): [string, string][] {
  const out: [string, string][] = [];
  for (const [scheme, suffix] of [["light", ""], ["dark", "-dark"]] as const) {
    const palette = appearance[scheme];
    if (!palette) continue;
    for (const [key, name] of COLOR_PARAMS) {
      const color = normalizeAppearanceColor(palette[key]);
      if (color) out.push([`${name}${suffix}`, color.slice(1)]);
    }
  }
  const radius = numberOf(appearance.radius);
  if (radius !== null) out.push(["radius", String(clampInteger(radius, APPEARANCE_LIMITS.radiusMin, APPEARANCE_LIMITS.radiusMax))]);
  const border = numberOf(appearance.border);
  if (border !== null) out.push(["border", String(clampInteger(border, APPEARANCE_LIMITS.borderMin, APPEARANCE_LIMITS.borderMax))]);
  for (const [key, values] of [["shadow", APPEARANCE_SHADOWS], ["font", APPEARANCE_FONTS], ["density", APPEARANCE_DENSITIES], ["header", APPEARANCE_HEADERS]] as const) {
    const value = oneOf<string>(values, appearance[key]);
    if (value) out.push([key, value]);
  }
  return out;
}

/**
 * Reads the appearance from a query string. Lenient: invalid colours
 * (including anything that is not six hex digits, such as `red;}` or
 * `url(…)`) and unknown values are dropped with a warning; radius and border
 * are clamped. Unknown parameters are ignored.
 */
export function appearanceFromParams(query: URLSearchParams): { appearance: KletiaAppearance; warnings: AppearanceWarning[] } {
  const warnings: AppearanceWarning[] = [];
  const out: { -readonly [K in keyof KletiaAppearance]: KletiaAppearance[K] } = {};
  for (const [scheme, suffix] of [["light", ""], ["dark", "-dark"]] as const) {
    const colors: { -readonly [K in keyof AppearanceColors]: string } = {};
    for (const [key, name] of COLOR_PARAMS) {
      const raw = query.get(`${name}${suffix}`);
      if (raw === null) continue;
      const color = normalizeAppearanceColor(raw);
      if (color) colors[key] = color;
      else warnings.push({ code: "COLOR_INVALID", path: `${name}${suffix}`, message: "Not six hex digits; ignored." });
    }
    if (Object.keys(colors).length > 0) out[scheme] = colors;
  }
  for (const [key, min, max] of [["radius", APPEARANCE_LIMITS.radiusMin, APPEARANCE_LIMITS.radiusMax], ["border", APPEARANCE_LIMITS.borderMin, APPEARANCE_LIMITS.borderMax]] as const) {
    const raw = query.get(key);
    if (raw === null) continue;
    const value = numberOf(raw);
    if (value === null) {
      warnings.push({ code: "UNKNOWN_VALUE", path: key, message: "Not a number; ignored." });
      continue;
    }
    const clamped = clampInteger(value, min, max);
    if (clamped !== value) warnings.push({ code: "VALUE_OUT_OF_RANGE", path: key, message: `Kept within ${min}-${max}.`, fallback: String(clamped) });
    if (key === "radius") out.radius = clamped;
    else out.border = clamped as 1 | 2 | 3;
  }
  const enumParam = <T extends string>(key: string, values: readonly T[]): T | undefined => {
    const raw = query.get(key);
    if (raw === null) return undefined;
    const value = oneOf(values, raw.trim().toLowerCase());
    if (!value) warnings.push({ code: "UNKNOWN_VALUE", path: key, message: `Use ${values.join(", ")}; ignored.` });
    return value ?? undefined;
  };
  const shadow = enumParam("shadow", APPEARANCE_SHADOWS);
  if (shadow) out.shadow = shadow;
  const font = enumParam("font", APPEARANCE_FONTS);
  if (font) out.font = font;
  const density = enumParam("density", APPEARANCE_DENSITIES);
  if (density) out.density = density;
  const header = enumParam("header", APPEARANCE_HEADERS);
  if (header) out.header = header;
  return { appearance: out, warnings };
}
