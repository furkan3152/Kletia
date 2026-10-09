/**
 * Pure helpers behind `Monogram`: protocol initials and category colours.
 * Kletia renders its own monograms instead of third-party logos. Node-safe.
 */

export interface MonogramLetters {
  /** One or two uppercase characters. */
  readonly letters: string;
  /** Lower-case version tag such as "v3", when the name carries one. */
  readonly version?: string;
}

const VERSION = /^v\d+$/iu;
const SEPARATORS = /[\s/·\-–—_]+/u;
const LETTER = /\p{L}/u;

/**
 * "Uniswap V3" → UN + v3, "Kletia Intent Router V2" → KI + v2,
 * "Jupiter / Sanctum LSTs" → JS, "Jupiter" → JU, "x402 payments" → XP.
 */
export function monogramFor(name: string): MonogramLetters {
  const tokens = name.split(SEPARATORS).filter(Boolean);
  const versionToken = tokens.find((token) => VERSION.test(token));
  const words = tokens.filter((token) => !VERSION.test(token) && LETTER.test(token));
  const version = versionToken ? versionToken.toLowerCase() : undefined;
  let letters: string;
  if (words.length >= 2) {
    letters = words
      .slice(0, 2)
      .map((word) => word.match(/\p{L}/u)![0])
      .join("");
  } else if (words.length === 1) {
    letters = Array.from(words[0]!.matchAll(/\p{L}/gu), (match) => match[0])
      .slice(0, 2)
      .join("");
  } else {
    letters = "?";
  }
  return version ? { letters: letters.toUpperCase(), version } : { letters: letters.toUpperCase() };
}

export interface CategoryColor {
  readonly bg: string;
  /** Text colour on `bg` (≥ 4.5:1). */
  readonly fg: string;
  /** Dark-theme overrides when the light colour would vanish on navy. */
  readonly darkBg?: string;
  readonly darkFg?: string;
}

const CATEGORY_BG: Readonly<Record<string, string>> = Object.freeze({
  "dex-aggregator": "#0052FF",
  dex: "#28A0F0",
  bridge: "#9945FF",
  "intent-network": "#7C3AED",
  lending: "#14F195",
  "liquid-staking": "#5CF2B4",
  yield: "#FFD60A",
  naming: "#93B4FF",
  payments: "#FFB020",
  security: "#FF5A5F",
  data: "#C4A1FF",
  "token-program": "#1A1A1A",
});

const UNKNOWN_BG = "#4B5563";
const LIGHT_TEXT = "#FFFFFF";
const DARK_TEXT = "#0B1120";

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#RRGGBB` colour (0 for unparseable input). */
export function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match) return 0;
  const value = Number.parseInt(match[1]!, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#RRGGBB` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White or navy ink, whichever reads better on `bg`. */
export function readableOn(bg: string): string {
  return contrastRatio(bg, LIGHT_TEXT) >= contrastRatio(bg, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

/** Tile colours for a protocol category; unknown categories get slate with white text. */
export function categoryColor(category: string): CategoryColor {
  const bg = CATEGORY_BG[category] ?? UNKNOWN_BG;
  const color: CategoryColor = { bg, fg: readableOn(bg) };
  if (category === "token-program") return { ...color, darkBg: "#E2E8F0", darkFg: readableOn("#E2E8F0") };
  return color;
}

/** Known category ids (others render as slate). */
export const MONOGRAM_CATEGORIES: readonly string[] = Object.freeze(Object.keys(CATEGORY_BG));
