/**
 * Link analytics without personal data (links design §7): additive daily
 * counters per link (`metric`, optional `dimension`), aggregated in process
 * and flushed every 30 s (or after the request on hosts without the
 * background flusher). Page requests are classified as a crawler `unfurl`
 * (by family) or a `pageView` from the user agent, which is then dropped;
 * nothing per visitor is ever written.
 */
import { LINK_METRICS, type LinkMetric, type LinkStats, type LinkStatsTotals } from "@kletia/core";
import { linkStore, type LinkStatRow } from "./store.js";

export const LINK_STATS_FLUSH_INTERVAL_MS = 30_000;
const MAX_PENDING = 20_000;
const STATS_RETENTION_DAYS = 90;

const pending = new Map<string, LinkStatRow>();
let flusher: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let immediate = false;

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Counts one event of a link (`dimension`: `network:asset`, crawler family or report reason). */
export function countLink(linkId: string, metric: LinkMetric | "volumeUsdMicros", options: { readonly dimension?: string; readonly count?: number; readonly usdMicros?: number; readonly now?: number } = {}): void {
  const row: LinkStatRow = {
    linkId,
    day: dayOf(options.now ?? Date.now()),
    metric,
    dimension: (options.dimension ?? "").slice(0, 80),
    count: options.count ?? 1,
    usdMicros: options.usdMicros ?? 0,
  };
  const key = `${row.linkId}|${row.day}|${row.metric}|${row.dimension}`;
  const known = pending.get(key);
  if (!known && pending.size >= MAX_PENDING) return;
  pending.set(key, known ? { ...known, count: known.count + row.count, usdMicros: known.usdMicros + row.usdMicros } : row);
  if (!flusher && !immediate) {
    immediate = true;
    setImmediate(() => {
      immediate = false;
      void flushLinkStats();
    });
  }
}

async function writeStats(): Promise<void> {
  for (let round = 0; round < 10 && pending.size > 0; round += 1) {
    const rows = [...pending.values()];
    pending.clear();
    try {
      await linkStore().addStats(rows);
    } catch (error) {
      console.warn(`[platform] link stats flush failed; ${rows.length} counters dropped:`, error instanceof Error ? error.message : error);
    }
  }
}

/** Writes pending counters; concurrent calls share one flush; never throws. */
export function flushLinkStats(): Promise<void> {
  flushing ??= Promise.resolve()
    .then(() => writeStats())
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

export function startLinkStatsFlusher(intervalMs = LINK_STATS_FLUSH_INTERVAL_MS): () => void {
  if (flusher) clearInterval(flusher);
  const timer = setInterval(() => void flushLinkStats(), intervalMs);
  timer.unref?.();
  flusher = timer;
  return () => {
    clearInterval(timer);
    if (flusher === timer) flusher = null;
    void flushLinkStats();
  };
}

/* ------------------------------------------------------- crawlers */

const CRAWLERS: readonly (readonly [RegExp, string])[] = [
  [/Twitterbot/iu, "x"],
  [/facebookexternalhit|Facebot/iu, "meta"],
  [/Slackbot/iu, "slack"],
  [/Discordbot/iu, "discord"],
  [/TelegramBot/iu, "telegram"],
  [/LinkedInBot/iu, "linkedin"],
  [/WhatsApp/iu, "whatsapp"],
  [/Googlebot|bingbot/iu, "search"],
];

/** `unfurl` with a crawler family, or `pageView`. The user agent is not kept. */
export function classifyVisit(userAgent: string | undefined): { readonly metric: "unfurl" | "pageView"; readonly dimension: string } {
  const agent = userAgent ?? "";
  for (const [pattern, family] of CRAWLERS) if (pattern.test(agent)) return { metric: "unfurl", dimension: family };
  return { metric: "pageView", dimension: "" };
}

/* --------------------------------------------------------- report */

export const LINK_STATS_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type LinkStatsWindow = keyof typeof LINK_STATS_WINDOWS;

function usdText(micros: number): string {
  return (Math.floor(micros / 10_000) / 100).toFixed(2);
}

function totalsOf(rows: readonly LinkStatRow[]): LinkStatsTotals {
  const totals: Partial<Record<LinkMetric, number>> = {};
  let volume = 0;
  for (const row of rows) {
    if (row.metric === "volumeUsdMicros") {
      volume += row.usdMicros;
      continue;
    }
    totals[row.metric] = (totals[row.metric] ?? 0) + row.count;
  }
  return { ...totals, ...(volume > 0 ? { volumeUsd: usdText(volume) } : {}) };
}

/** GET /v1/links/{id}/stats: totals, daily series, by source, conversion ratios. */
export async function linkStatsReport(linkId: string, window: LinkStatsWindow, now = Date.now()): Promise<LinkStats> {
  await flushLinkStats();
  const since = dayOf(now - (LINK_STATS_WINDOWS[window] - 1) * 86_400_000);
  const rows = await linkStore().readStats(linkId, since);
  // Every day of the window, oldest first (days without counts are empty).
  const days = Array.from({ length: LINK_STATS_WINDOWS[window] }, (_, index) => dayOf(now - (LINK_STATS_WINDOWS[window] - 1 - index) * 86_400_000));
  const sources = [...new Set(rows.filter((row) => row.dimension.includes(":")).map((row) => row.dimension))].sort();
  const totals = totalsOf(rows);
  const ratio = (numerator: number | undefined, denominator: number | undefined) =>
    denominator && denominator > 0 ? Math.round(((numerator ?? 0) / denominator) * 10_000) / 10_000 : null;
  return {
    linkId,
    window,
    totals,
    daily: days.map((day) => ({ day, ...totalsOf(rows.filter((row) => row.day === day)) })),
    bySource: sources.map((source) => ({ source, ...totalsOf(rows.filter((row) => row.dimension === source)) })),
    conversion: { intentPerPageView: ratio(totals.intent, totals.pageView), completedPerIntent: ratio(totals.completed, totals.intent) },
  };
}

/** Stats rows older than the retention (watcher). */
export function statsRetentionCutoff(now = Date.now()): string {
  return new Date(now - STATS_RETENTION_DAYS * 86_400_000).toISOString();
}

export function isLinkMetric(value: string): value is LinkMetric {
  return (LINK_METRICS as readonly string[]).includes(value);
}
