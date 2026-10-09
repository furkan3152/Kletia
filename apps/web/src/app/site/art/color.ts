/**
 * Colour maths for the art system (WCAG 2.1 relative luminance and contrast).
 * Pure and dependency-free so `node --test` can load it directly.
 */

/** Parses `#RGB` or `#RRGGBB` into 0-255 channels; null for anything else. */
export function parseHex(color: string): readonly [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(color.trim());
  if (!match) return null;
  const hex = match[1]!.length === 3 ? [...match[1]!].map((digit) => digit + digit).join("") : match[1]!;
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as unknown as readonly [
    number,
    number,
    number,
  ];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a hex colour (0 for black, 1 for white). */
export function relativeLuminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) throw new Error(`Not a hex colour: ${color}`);
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Dark text used on light line colours (the night-sky ink of the site). */
export const TEXT_ON_LIGHT = "#0B1120";
/** Light text used on dark line colours. */
export const TEXT_ON_DARK = "#FFFFFF";

/** Whichever of dark ink or white reads better on `background`. */
export function readableOn(background: string): string {
  return contrastRatio(background, TEXT_ON_LIGHT) >= contrastRatio(background, TEXT_ON_DARK) ? TEXT_ON_LIGHT : TEXT_ON_DARK;
}
