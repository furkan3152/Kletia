/** Key styles shared by <Key> and any element that should look like a key (router links). */
export type KeyTone = "default" | "lime" | "ink" | "magenta" | "flat";
export type KeySize = "md" | "sm";

export interface KeyStyle {
  /** default: a light keycap; lime: the one accent (the thing to press); ink: a dark key; magenta: short/danger; flat: no cap. */
  readonly tone?: KeyTone;
  /** md: 44 px (default); sm: 36 px (44 px on phones). */
  readonly size?: KeySize;
  /** A square key for one icon (give it an aria-label). */
  readonly square?: boolean;
}

/** The class list of a key, for elements that are not <button> (router links, labels). */
export function keyClass({ tone = "default", size = "md", square = false }: KeyStyle = {}, extra?: string): string {
  return ["k-key", tone !== "default" && `k-key--${tone}`, size === "sm" && "k-key--sm", square && "k-key--sq", extra].filter(Boolean).join(" ");
}

