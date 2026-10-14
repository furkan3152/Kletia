/**
 * The journey of an intent (journey design §5 engine entry point): reads the
 * facts (facts.ts) and builds the journey with core `buildJourney`, on the
 * preview the caller hands over (create, prepare, refresh) or else the
 * store's latest one (recomputed as a `refresh` preview when older than 60 s
 * and the intent is not terminal).
 *
 * Results are cached for 15 s, keyed by (intent id, updatedAt, preview
 * digest, reads), in a memory LRU of 5,000 entries; nothing is persisted (a
 * journey is always recomputable). `refresh` bypasses the cache and the fact
 * caches' results are re-read through holdings.
 */
import { buildJourney, type IntentGraph, type IntentPreview, type Journey } from "@kletia/core";
import { getPreviewStore, previewIntent } from "../preview/index.js";
import { JOURNEY_GET_DEADLINE_MS, readJourneyFacts } from "./facts.js";

export interface JourneyOptions {
  /** The preview to build on (create / prepare / refresh); else the store's latest for the intent. */
  readonly preview?: IntentPreview | null;
  /** `none` skips every account read (demo accounts, link pages before a wallet connects). */
  readonly reads?: "live" | "none";
  /** Bypass the result cache (rate limited by the HTTP layer). */
  readonly refresh?: boolean;
  /** Fact deadline (2.5 s at plan, 4 s on a GET: the default). */
  readonly deadlineMs?: number;
}

export const JOURNEY_CACHE_TTL_MS = 15_000;
const JOURNEY_CACHE_LIMIT = 5_000;
/** A stored preview older than this is recomputed for a non-terminal intent. */
const PREVIEW_STALE_MS = 60_000;
const TERMINAL = new Set(["completed", "partially_completed", "failed", "expired", "cancelled"]);

const cache = new Map<string, { readonly journey: Journey; readonly at: number }>();

/** Forgets cached journeys (tests). */
export function resetJourneyCaches(): void {
  cache.clear();
}

function remember(key: string, journey: Journey): void {
  cache.delete(key);
  cache.set(key, { journey, at: Date.now() });
  while (cache.size > JOURNEY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function previewFor(graph: IntentGraph, options: JourneyOptions): Promise<IntentPreview | null> {
  if (options.preview !== undefined) return options.preview;
  const stored = await getPreviewStore().latest(graph.id).catch(() => null);
  const stale = !stored || Date.now() - Date.parse(stored.computedAt) > PREVIEW_STALE_MS;
  if (!stale || TERMINAL.has(graph.status)) return stored;
  try {
    return await previewIntent(graph, { stage: "refresh" });
  } catch {
    return stored;
  }
}

/** The journey of `graph` (journey design §3.3, §5). Never throws for RPC trouble: unread facts become "unknown" consequences. */
export async function journeyFor(graph: IntentGraph, options: JourneyOptions = {}): Promise<Journey> {
  const preview = await previewFor(graph, options);
  const reads = options.reads ?? "live";
  const key = `${graph.id}|${graph.updatedAt}|${preview?.digest ?? "none"}|${reads}`;
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < JOURNEY_CACHE_TTL_MS) return cached.journey;
  const now = Date.now();
  const facts = await readJourneyFacts(graph, preview, { reads, deadlineMs: options.deadlineMs ?? JOURNEY_GET_DEADLINE_MS, now });
  const journey = buildJourney(graph, preview, facts, now);
  remember(key, journey);
  return journey;
}
