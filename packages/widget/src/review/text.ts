/**
 * Text and number helpers shared by every review model, and the
 * certainty labels.
 */
import {
  CHAINS,
  formatPreviewAmount,
  isNetworkKey,
  type Certainty,
} from "@kletia/core";

/* ================================================================== text */

// C0/C1 controls, bidirectional overrides and isolates, zero-width marks.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]+/gu;

/** Text an integrator, venue or API controls, safe to print in a text node: no controls or direction overrides, bounded length. */
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_TEXT, " ").replace(/\s{2,}/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The URL when it is an absolute https URL without credentials, else null. */
export function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function isHttpsUrl(value: unknown): value is string {
  return httpsUrl(value) !== null;
}

/** `0x5eed…c0de` for long addresses; the full value belongs in a title or next to it. */
export function shortAddress(value: string, head = 6, tail = 4): string {
  const address = value.slice(value.lastIndexOf(":") + 1);
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function networkLabel(network: string): string {
  return isNetworkKey(network) ? CHAINS[network].name : cleanText(network, 40);
}

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Absolute USD for display: "$100.00", "<$0.01", "$0.00"; null when unpriced. */
export function formatUsdAbs(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 0.005) return "<$0.01";
  return usd2.format(absolute);
}

/** "-100" / "+95.4773" → "100" / "95.4773", with thousands separators. */
export function unsignedAmount(formatted: string): string {
  const body = formatted.replace(/^[+-]/u, "");
  const [whole = "0", fraction] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function unitsText(units: string | undefined | null, decimals: number): string | null {
  if (typeof units !== "string" || !/^-?\d{1,78}$/u.test(units)) return null;
  return unsignedAmount(formatPreviewAmount(units, decimals));
}

export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(1)} h`;
}

/* ============================================================ certainty */

/** `square` is the journey's `observed` (seen on-chain); the fare never prints it. */
export type CertaintyShape = "dot" | "half" | "diamond" | "ring" | "dashed" | "square";

export interface CertaintyInfo {
  /** Printed next to a number, e.g. "simulated". */
  readonly label: string;
  /** Read aloud with the number, e.g. "simulated with funds a bridge delivers". */
  readonly spoken: string;
  /** One sentence for the legend. */
  readonly sentence: string;
  /** Glyph shape: the label is never carried by colour alone. */
  readonly shape: CertaintyShape;
}

export const CERTAINTY_INFO: Readonly<Record<Certainty, CertaintyInfo>> = Object.freeze({
  simulated: {
    label: "simulated",
    spoken: "simulated",
    sentence: "Simulated: the exact transactions, run against current state.",
    shape: "dot",
  },
  "simulated-assumed-funds": {
    label: "simulated, funds assumed",
    spoken: "simulated with funds a bridge delivers",
    sentence: "Simulated with funds a bridge has not delivered yet. It is simulated again before you sign it.",
    shape: "half",
  },
  "venue-minimum": {
    label: "venue minimum",
    spoken: "the venue's committed minimum",
    sentence: "Venue minimum: the floor the venue committed to. Kletia checks it on arrival.",
    shape: "diamond",
  },
  quoted: {
    label: "quoted",
    spoken: "quoted by the venue, not simulated",
    sentence: "Quoted: the venue's quote, not simulated.",
    shape: "ring",
  },
  estimated: {
    label: "estimated",
    spoken: "estimated",
    sentence: "Estimated: derived from other numbers, not simulated.",
    shape: "dashed",
  },
});

export const CERTAINTIES: readonly Certainty[] = ["simulated", "simulated-assumed-funds", "venue-minimum", "quoted", "estimated"];

export function certaintyOf(value: unknown): Certainty {
  return CERTAINTIES.includes(value as Certainty) ? (value as Certainty) : "estimated";
}
