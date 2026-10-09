/**
 * The link watcher (links design §10.4), every 5 minutes on long-running
 * hosts: activates due pending links (`link.activated`), emits
 * `link.expired` and `link.exhausted` once, re-checks publishers' domain
 * files daily (100 links per run; a link whose file stops listing it
 * becomes unverified: seal, caps and blink change, `link.updated`),
 * releases stale use reservations, and prunes use rows 30 days after a
 * link expired and counters after 90 days. The use listener and the stats
 * flusher start with it.
 */
import { publishLinkEvent } from "./events.js";
import { effectiveLinkStatus, linkClock, linkDomainCheck, mutateLink, settleLink } from "./service.js";
import { startLinkStatsFlusher, statsRetentionCutoff } from "./stats.js";
import { linkStore, type LinkRecord } from "./store.js";
import { startLinkUseListener, sweepLinkUses } from "./uses.js";

const WATCH_INTERVAL_MS = 5 * 60_000;
const DOMAIN_CHECK_MS = 24 * 3_600_000;
const USE_RETENTION_MS = 30 * 86_400_000;

export interface LinkWatchReport {
  readonly activated: number;
  readonly expired: number;
  readonly exhausted: number;
  readonly domainChecks: number;
  readonly released: number;
}

async function watchOne(record: LinkRecord, now: number, report: { activated: number; expired: number; exhausted: number; domainChecks: number }): Promise<void> {
  let current = record;
  if (current.status === "pending") {
    const settled = await settleLink(current, now);
    if (settled.status === "active" && current.status === "pending") report.activated += 1;
    current = settled;
  }
  const status = effectiveLinkStatus(current, now);
  if (status === "expired" && !current.flags.expiredAnnounced) {
    const result = await mutateLink(current, (fresh) => (fresh.flags.expiredAnnounced ? null : { ...fresh, flags: { ...fresh.flags, expiredAnnounced: true } }));
    if (result) {
      publishLinkEvent("link.expired", { linkId: current.id, ownerKeyId: current.ownerKeyId, revision: current.revision });
      report.expired += 1;
      current = result.after;
    }
  }
  if (current.maxUses !== null && current.used >= current.maxUses && !current.flags.exhaustedAnnounced) {
    const result = await mutateLink(current, (fresh) => (fresh.flags.exhaustedAnnounced ? null : { ...fresh, flags: { ...fresh.flags, exhaustedAnnounced: true } }));
    if (result) {
      publishLinkEvent("link.exhausted", { linkId: current.id, ownerKeyId: current.ownerKeyId, revision: current.revision });
      report.exhausted += 1;
      current = result.after;
    }
  }
  const website = current.publisher.website;
  if (website && status !== "expired" && (current.publisher.checkedAt ?? "") < new Date(now - DOMAIN_CHECK_MS).toISOString()) {
    const verified = await linkDomainCheck(website, current.id, current.ownerKeyId).catch(() => false);
    report.domainChecks += 1;
    const lost = current.publisher.domainVerified && !verified;
    const result = await mutateLink(current, (fresh) => ({ ...fresh, publisher: { ...fresh.publisher, domainVerified: verified, checkedAt: new Date(now).toISOString() } }));
    if (result && (lost || (!current.publisher.domainVerified && verified))) {
      publishLinkEvent("link.updated", { linkId: current.id, ownerKeyId: current.ownerKeyId, revision: current.revision, reason: lost ? "domain_unverified" : "domain_verified" });
    }
  }
}

/** One watcher pass (also called by tests). Never throws. */
export async function watchLinks(now = linkClock(), limit = 100): Promise<LinkWatchReport> {
  const report = { activated: 0, expired: 0, exhausted: 0, domainChecks: 0, released: 0 };
  try {
    const due = await linkStore().listForWatch(now, new Date(now - DOMAIN_CHECK_MS).toISOString(), limit);
    for (const record of due) {
      await watchOne(record, now, report).catch((error: unknown) => {
        console.warn(`[platform] link watcher on ${record.id} failed:`, error instanceof Error ? error.message : error);
      });
    }
    report.released = await sweepLinkUses(now);
  } catch (error) {
    console.warn("[platform] link watcher failed:", error instanceof Error ? error.message : error);
  }
  return report;
}

/** Starts the watcher, the use listener and the stats flusher; returns a stop function. */
export function startLinkBackground(intervalMs = WATCH_INTERVAL_MS): () => void {
  const stopListener = startLinkUseListener();
  const stopFlusher = startLinkStatsFlusher();
  let lastPrune = 0;
  const timer = setInterval(() => {
    const now = linkClock();
    void watchLinks(now);
    if (now - lastPrune >= 24 * 3_600_000) {
      lastPrune = now;
      void linkStore()
        .prune(new Date(now - USE_RETENTION_MS).toISOString(), statsRetentionCutoff(now))
        .catch((error: unknown) => console.warn("[platform] link prune failed:", error instanceof Error ? error.message : error));
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    stopListener();
    stopFlusher();
  };
}
