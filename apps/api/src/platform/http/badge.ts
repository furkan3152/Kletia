/**
 * GET /v1/status/badge: API status as a flat SVG badge, or as a shields.io
 * endpoint document (`?format=shields`, for
 * https://img.shields.io/endpoint?url=<encoded badge url>).
 *
 * The status comes from the health report (cached for 10 s, one RPC probe
 * per network): every network healthy → operational, some → degraded,
 * none → down. The badge text is fixed per status; nothing from the request
 * or a provider is ever rendered.
 */
import { readPlatformHealth } from "./health.js";

export type BadgeStatus = "operational" | "degraded" | "down";

const COLORS: Readonly<Record<BadgeStatus, { readonly hex: string; readonly shields: string }>> = {
  operational: { hex: "#2e9b5f", shields: "brightgreen" },
  degraded: { hex: "#d68a1a", shields: "orange" },
  down: { hex: "#c8423b", shields: "red" },
};

const LABEL = "kletia api";
export const BADGE_CACHE_SECONDS = 60;

export async function badgeStatus(): Promise<BadgeStatus> {
  try {
    const health = await readPlatformHealth();
    return health.status === "ok" ? "operational" : health.status === "degraded" ? "degraded" : "down";
  } catch {
    return "down";
  }
}

export function shieldsBadge(status: BadgeStatus): { schemaVersion: 1; label: string; message: string; color: string; cacheSeconds: number } {
  return { schemaVersion: 1, label: LABEL, message: status, color: COLORS[status].shields, cacheSeconds: 300 };
}

/** Approximate rendered width of 11 px Verdana text (the shields.io flat style). */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[mw]/u.test(char) ? 10 : /[il.:]/u.test(char) ? 3.5 : char === " " ? 3.5 : 7;
  return Math.ceil(width);
}

/** Flat badge SVG; only fixed strings are rendered. */
export function badgeSvg(status: BadgeStatus): string {
  const left = textWidth(LABEL) + 12;
  const right = textWidth(status) + 12;
  const total = left + right;
  const color = COLORS[status].hex;
  const title = `${LABEL}: ${status}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`,
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${left / 2}" y="14">${LABEL}</text>`,
    `<text x="${left + right / 2}" y="14">${status}</text>`,
    `</g></svg>`,
  ].join("");
}
