/**
 * Kletia line icons: path data for the <Icon> component. One drawing rule for
 * all of them:
 *   - 24 px grid, 2 px stroke in currentColor, square caps, mitred joins;
 *   - one solid "plate" in the second ink, printed 1.5 px down and right of
 *     the shape it belongs to, like a two-colour job slightly off register.
 * Dependency-free so `node --test` can load it directly.
 */

export const ICON_NAMES = [
  "swap",
  "bridge",
  "lend",
  "withdraw",
  "stake",
  "transfer",
  "name",
  "verify",
  "webhook",
  "sdk",
  "embed",
  "contract",
  "key",
  "route",
  "ticket",
  "board",
  "shield",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Circle as a path, so every glyph stays a single <path>. */
const o = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

/** Line work, drawn in currentColor. */
export const ICON_STROKES: Readonly<Record<IconName, string>> = {
  swap: "M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4",
  bridge: "M2 15h20M7 4v15M17 4v15M7 6c2 5 8 5 10 0M2 11c2.5 0 4-2 5-5M17 6c1 3 2.5 5 5 5M12 9.8V15",
  lend: `${o(12, 5, 3)}M12 10v7M9 14l3 3 3-3M3 12h5M16 12h5M3 12v9h18v-9`,
  withdraw: "M12 17V4M8.5 7.5 12 4l3.5 3.5M3 12h5M16 12h5M3 12v9h18v-9",
  stake: "M9 8V5.5a3 3 0 0 1 6 0V8M6 8h13v4H6zM4 12h13v4H4zM6 16h13v4H6z",
  transfer: `${o(5, 12, 2.5)}M8 12h10M14 8l4 4-4 4M21 5v14`,
  name: `M3 6h11l7 6-7 6H3z${o(14.5, 12, 1.5)}M6 10h4M6 14h3`,
  verify: `${o(12, 4.5, 2.5)}M10.5 7v4M13.5 7v4M5 11h14v5H5zM4 20h16`,
  webhook: "M12 2v10a4.5 4.5 0 1 1-4.5 4.5M7.5 16.5 5.5 14M16.5 4.5a4 4 0 0 1 0 5M19 2a7.5 7.5 0 0 1 0 10",
  sdk: "M3 9h18v11H3zM8.5 9V5.5h7V9M3 13.5h7M14 13.5h7M10 12h4v3h-4z",
  embed: "M3 4h18v16H3zM3 8h18M7 11.5h10v5H7zM5.5 6h1M8.5 6h1",
  contract: `M5 2h10l4 4v16H5zM15 2v4h4M8 9h8M8 12h8M8 15h3${o(15, 17.5, 2)}`,
  key: `${o(7, 12, 4)}M11 12h11M18 12v4M21 12v3`,
  route: `M3 18h5l8-12h5${o(3, 18, 1.5)}${o(21, 6, 1.5)}M11 10.5l1.8 1.2`,
  ticket: "M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4zM15 6v2M15 11v2M15 16v2M6 10h6M6 14h4",
  board: "M2 6h20v12H2zM5 10h4M11 10h8M5 14h4M11 14h5M7 2v4M17 2v4",
  shield: "M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5zM8 12h8",
};

/** Second-ink plates, already offset by 1.5 px. */
export const ICON_PLATES: Readonly<Record<IconName, string>> = {
  swap: o(13.5, 13.5, 5),
  bridge: "M3.5 16.5h20v4h-20z",
  lend: "M4.5 13.5h18v9h-18z",
  withdraw: "M4.5 13.5h18v9h-18z",
  stake: "M5.5 13.5h13v4h-13z",
  transfer: o(6.5, 13.5, 3),
  name: "M4.5 7.5h11l7 6-7 6h-11z",
  verify: "M6.5 12.5h14v5h-14z",
  webhook: o(13.5, 18, 4),
  sdk: "M4.5 10.5h18v11h-18z",
  embed: "M8.5 13h10v5h-10z",
  contract: o(16.5, 19, 2.8),
  key: o(8.5, 13.5, 4),
  route: o(4.5, 19.5, 3),
  ticket: "M16.5 7.5h6v12h-6z",
  board: "M3.5 7.5h20v12h-20z",
  shield: "M13.5 3.5l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11v-6z",
};

export function isIconName(value: unknown): value is IconName {
  return typeof value === "string" && (ICON_NAMES as readonly string[]).includes(value);
}

/* Registry protocol categories (ProtocolCategory in @kletia/core) as pictograms and sign words. */
const CATEGORY_ICONS: Readonly<Record<string, IconName>> = {
  "dex-aggregator": "swap",
  dex: "swap",
  bridge: "bridge",
  "intent-network": "bridge",
  lending: "lend",
  yield: "lend",
  "liquid-staking": "stake",
  naming: "name",
  payments: "transfer",
  "token-program": "transfer",
  security: "shield",
  data: "board",
  custom: "contract",
};

const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  "dex-aggregator": "Swap",
  dex: "Swap",
  bridge: "Bridge",
  "intent-network": "Bridge",
  lending: "Lending",
  yield: "Yield",
  "liquid-staking": "Staking",
  naming: "Names",
  payments: "Payments",
  "token-program": "Transfers",
  security: "Security",
  data: "Data",
  custom: "Your contract",
};

/** Pictogram for a registry protocol category ("route" for a category this table does not know yet). */
export function categoryIcon(category: string): IconName {
  return CATEGORY_ICONS[category] ?? "route";
}

/** Short sign word for a registry protocol category, e.g. "Lending". */
export function categoryWord(category: string): string {
  return CATEGORY_WORDS[category] ?? category.replace(/-/gu, " ").replace(/^./u, (first) => first.toUpperCase());
}
