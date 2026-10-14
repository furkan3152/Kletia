/**
 * Rows of the Links list and the facts of a link page (portal design 4.4.6,
 * P-07, P-08, P-22): the status and the publisher as `statusTones` entries
 * (an unverified publisher is a warning, never danger; a withdrawn link is
 * neutral), plain counters that show "–" when the API did not report them
 * (never a zero the page did not read), and a pending countdown next to its
 * absolute UTC time. Pure, so the node tests load it directly.
 */
import { LINK_ID_PATTERN, type LinkOwnerView } from "@kletia/core";

import { toneFor, type StatusEntry } from "../../../site/ui/statusTones.ts";
import { durationText, formatUsd } from "../portal/portalFormat.ts";

export type LinkRowInput = Pick<
  LinkOwnerView,
  "id" | "status" | "title" | "publisher" | "funding" | "destination" | "activatesAt" | "expiresAt" | "uses" | "pausedReason" | "suspendedReason" | "stats"
>;

export interface LinkRowModel {
  readonly id: string;
  readonly title: string;
  readonly status: StatusEntry;
  readonly publisher: string;
  readonly publisherStatus: StatusEntry;
  /** Networks a visitor may start from. */
  readonly from: readonly string[];
  /** The network the money arrives on. */
  readonly to: string;
  /** Plain counters for the list (7 days): "–" when unread. */
  readonly views: string;
  readonly intents: string;
  readonly completed: string;
  readonly volume: string;
  /** `activates 14:05 UTC, in 12 min`, why it is paused or suspended, or null. */
  readonly detail: string | null;
}

const pad = (value: number) => String(value).padStart(2, "0");

function countdown(activatesAt: string | null, now: number): string {
  const at = activatesAt ? Date.parse(activatesAt) : Number.NaN;
  if (!Number.isFinite(at)) return "waiting for activation";
  const date = new Date(at);
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? `activates ${clock}, in ${durationText(seconds)}` : `activating now (due ${clock})`;
}

const REASONS: Readonly<Record<string, string>> = {
  publisher: "paused by you",
  recipient_changed: "a pinned recipient name now resolves elsewhere",
  contract_changed: "a pinned contract has a newer revision",
  domain_unverified: "the domain file no longer lists it",
  abuse_reports: "paused after abuse reports",
};

function reason(text: string | null): string | null {
  if (!text) return null;
  if (text.startsWith("operator:")) return `by the operator: ${text.slice("operator:".length).trim() || "no reason given"}`;
  return REASONS[text] ?? text.replace(/_/gu, " ");
}

/** A counter as read, or "–" when the API did not report the link's counters. */
export function counterText(stats: LinkOwnerView["stats"] | null | undefined, metric: "pageView" | "intent" | "completed" | "quote"): string {
  if (!stats) return "–";
  const value = stats[metric];
  return (typeof value === "number" && Number.isFinite(value) ? value : 0).toLocaleString("en-US");
}

export function linkRowModel(link: LinkRowInput, now: number): LinkRowModel {
  let detail: string | null = null;
  if (link.status === "pending") detail = countdown(link.activatesAt, now);
  else if (link.status === "paused") detail = reason(link.pausedReason) ?? "paused";
  else if (link.status === "suspended") detail = reason(link.suspendedReason) ?? "suspended";
  return {
    id: link.id,
    title: link.title,
    status: toneFor("link", link.status),
    publisher: link.publisher.name,
    publisherStatus: toneFor("link-publisher", link.publisher.domainVerified ? "verified" : "unverified"),
    from: [...link.funding.networks],
    to: link.destination.network,
    views: counterText(link.stats, "pageView"),
    intents: counterText(link.stats, "intent"),
    completed: counterText(link.stats, "completed"),
    volume: link.stats ? formatUsd(link.stats.volumeUsd ?? "0") : "–",
    detail,
  };
}

/** Link ids as the API issues them. */
export const LINK_ID = LINK_ID_PATTERN;

export type LinkFilter = "" | "active" | "pending" | "paused" | "suspended" | "deleted";

const FILTERS: readonly LinkFilter[] = ["", "active", "pending", "paused", "suspended", "deleted"];

/** `?status=` of the list; anything else is every link. */
export function linkFilterOf(search: URLSearchParams): LinkFilter {
  const value = search.get("status") ?? "";
  return FILTERS.includes(value as LinkFilter) ? (value as LinkFilter) : "";
}
