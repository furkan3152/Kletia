/**
 * The landing page shell with per-link meta tags (links design §5.2),
 * served at `GET /v1/links/{id}/page` and, through the static site's
 * rewrite, at `kletiaai.xyz/go/{id}`. Crawlers do not run JavaScript, so the
 * title, description, canonical, Open Graph and Twitter card tags are
 * injected between `<!--kletia:head-->` and `<!--/kletia:head-->` of the web
 * build's `go-shell.html`.
 *
 * - The shell is fetched from `${KLETIA_WEB_ORIGIN}/go-shell.html` (a real
 *   file, so no rewrite loop), at most 64 KB, both markers exactly once;
 *   cached 5 minutes, and the last good copy is kept in memory. No copy ever
 *   fetched: 503 LINK_PAGE_UNAVAILABLE with a tiny static page.
 * - Every value is HTML-escaped (`& < > " '`); nothing outside the markers
 *   changes; no script or inline JSON is generated. Every link is `noindex`.
 * - Unusable links (suspended, withdrawn, expired, unknown) get a neutral
 *   title and the void card.
 */
import { CHAINS, isLinkId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { effectiveLinkStatus, linkClock, loadLink } from "./service.js";
import { classifyVisit, countLink } from "./stats.js";
import type { LinkRecord } from "./store.js";

export const HEAD_START = "<!--kletia:head-->";
export const HEAD_END = "<!--/kletia:head-->";
const SHELL_MAX_BYTES = 64 * 1024;
const SHELL_TTL_MS = 5 * 60_000;
const SHELL_TIMEOUT_MS = 5_000;

/** Fetches the shell (tests substitute it). */
export type ShellFetcher = (url: string) => Promise<string>;

async function defaultFetcher(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(SHELL_TIMEOUT_MS), headers: { accept: "text/html" } });
  if (!response.ok) throw new Error(`shell answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > SHELL_MAX_BYTES) throw new Error("shell too large");
  const body = await response.arrayBuffer();
  if (body.byteLength > SHELL_MAX_BYTES) throw new Error("shell too large");
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

let fetcher: ShellFetcher = defaultFetcher;
let cached: { readonly html: string; readonly fetchedAt: number } | null = null;

/** Replaces the shell fetcher (tests); null restores fetch. Clears the cache. */
export function configureShellFetcher(next: ShellFetcher | null): void {
  fetcher = next ?? defaultFetcher;
  cached = null;
}

function validShell(html: string): boolean {
  return html.split(HEAD_START).length === 2 && html.split(HEAD_END).length === 2 && html.indexOf(HEAD_START) < html.indexOf(HEAD_END);
}

/** The current shell: fresh within 5 minutes, else refetched; the last good copy on failure; null when none ever loaded. */
export async function linkShell(now = Date.now()): Promise<string | null> {
  if (cached && now - cached.fetchedAt < SHELL_TTL_MS) return cached.html;
  try {
    const html = await fetcher(`${kletiaWebOrigin()}/go-shell.html`);
    if (Buffer.byteLength(html, "utf8") > SHELL_MAX_BYTES || !validShell(html)) throw new Error("shell markers missing or repeated");
    cached = { html, fetchedAt: now };
    return html;
  } catch (error) {
    console.warn("[platform] link page shell unavailable:", error instanceof Error ? error.message : error);
    return cached?.html ?? null;
  }
}

/** HTML attribute and text escaping (`& < > " '`). */
export function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

export interface PageMeta {
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly image: string;
  readonly imageAlt: string;
}

/** The meta block of a link page. */
export function metaFor(record: LinkRecord | null, id: string, now: number): PageMeta {
  const origin = kletiaWebOrigin();
  const url = `${origin}/go/${id}`;
  const usable = record !== null && !["deleted", "suspended", "expired"].includes(effectiveLinkStatus(record, now));
  if (!record || !usable) {
    return {
      title: "This link is no longer available | Kletia link",
      description: "This Kletia intent link is no longer available. Ask its publisher for a new one.",
      url,
      image: `${url}/card.png${record ? `?v=${record.revision}` : ""}`,
      imageAlt: "Kletia intent link ticket marked void.",
    };
  }
  const { definition, publisher } = record;
  const domainNote = publisher.domain ? `${publisher.domain}, ${publisher.domainVerified ? "verified" : "not verified"}` : "domain not verified";
  const first = definition.destination.actions[0];
  const network = first ? CHAINS[first.network].name : "";
  const description = `${definition.description ? `${definition.description} ` : ""}Published by ${publisher.name} (${domainNote}). ${network ? `Arrives on ${network}. ` : ""}You review and sign every step in your own wallet.`;
  return {
    title: `${definition.title} · ${publisher.name}`,
    description: description.slice(0, 400),
    url,
    image: `${url}/card.png?v=${record.revision}`,
    imageAlt: `Kletia intent link ticket: ${definition.title}, by ${publisher.name}, ${publisher.domainVerified ? "domain verified" : "domain not verified"}.`,
  };
}

/** The `<head>` block between the markers (every value escaped). */
export function headBlock(meta: PageMeta, documentTitle: string): string {
  const e = escapeHtml;
  return [
    HEAD_START,
    `<title>${e(documentTitle)}</title>`,
    `<meta name="description" content="${e(meta.description)}" />`,
    `<meta name="robots" content="noindex,nofollow" />`,
    `<link rel="canonical" href="${e(meta.url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Kletia" />`,
    `<meta property="og:title" content="${e(meta.title)}" />`,
    `<meta property="og:description" content="${e(meta.description)}" />`,
    `<meta property="og:url" content="${e(meta.url)}" />`,
    `<meta property="og:image" content="${e(meta.image)}" />`,
    `<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="600" />`,
    `<meta property="og:image:alt" content="${e(meta.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(meta.title)}" /><meta name="twitter:description" content="${e(meta.description)}" />`,
    `<meta name="twitter:image" content="${e(meta.image)}" />`,
    `<meta name="twitter:image:alt" content="${e(meta.imageAlt)}" />`,
    HEAD_END,
  ].join("\n    ");
}

/** Replaces the marked block exactly once (the rest of the shell is untouched). */
export function injectHead(shell: string, block: string): string {
  const start = shell.indexOf(HEAD_START);
  const end = shell.indexOf(HEAD_END);
  return `${shell.slice(0, start)}${block}${shell.slice(end + HEAD_END.length)}`;
}

/** Headers of the page route (overrides helmet's CSP and COOP on this route only). */
export const PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "X-Content-Type-Options": "nosniff",
});

const UNAVAILABLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="robots" content="noindex" /><title>Kletia is updating</title></head><body><p>Kletia is updating; reload in a minute.</p></body></html>`;

export interface RenderedPage {
  readonly status: number;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Renders the page of a link id (unknown and malformed ids answer 404 with
 * the neutral block; the SPA shows its 404 stop). Counts a page view or an
 * unfurl; the user agent is used for that and dropped.
 */
export async function renderLinkPage(id: string, userAgent: string | undefined): Promise<RenderedPage> {
  const now = linkClock();
  let record: LinkRecord | null = null;
  if (isLinkId(id)) record = await loadLink(id, now).catch(() => null);
  const shell = await linkShell();
  if (!shell) {
    const error = new PlatformError("LINK_PAGE_UNAVAILABLE", "The page shell could not be loaded. Retry shortly; the link itself is unaffected.", 503);
    return { status: error.status, html: UNAVAILABLE_HTML.replace("</body>", `<!-- ${error.code} --></body>`), headers: { ...PAGE_HEADERS, "Cache-Control": "no-store", "Retry-After": "60" } };
  }
  if (record) {
    const visit = classifyVisit(userAgent);
    countLink(record.id, visit.metric, { dimension: visit.dimension });
  }
  const meta = metaFor(record, isLinkId(id) ? id : "unknown", now);
  const documentTitle = record && meta.title !== metaFor(null, id, now).title ? `${meta.title} | Kletia link` : meta.title;
  const usable = record !== null && !["deleted", "suspended", "expired"].includes(effectiveLinkStatus(record, now));
  return { status: record ? (usable ? 200 : 410) : 404, html: injectHead(shell, headBlock(meta, documentTitle)), headers: PAGE_HEADERS };
}
