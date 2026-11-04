/**
 * Live figures from Lykia's public API.
 *
 * CORS, checked 2026-11-04: Lykia's GET /v1/stats answers with
 * `Access-Control-Allow-Origin: *`, but GET /v1/health sends no CORS header,
 * so a browser on kletiaai.xyz cannot read it. The page therefore asks
 * Kletia's own API, `GET /api/network/lykia`, a tiny relay that reads both
 * endpoints server side and caches them for a minute
 * (apps/api/src/http/routes/network.ts; docs/ecosystem.md). If the relay
 * cannot be reached, the page reads /v1/stats directly (CORS allows it) and
 * shows no Arc reading rather than a guess.
 *
 * Short timeout, one shared in-flight request, and a cache (memory plus
 * sessionStorage for a minute) so the landing section, /network and the line
 * page share one answer. A failure is cached too, briefly. Imports use
 * explicit `.ts` extensions so `node --test` can load this module.
 */
import { parseLykiaHealth, parseLykiaStats, LYKIA_API, type LykiaLive } from "./networkData.ts";

export const LYKIA_TIMEOUT_MS = 4500;
export const LYKIA_CACHE_MS = 60_000;
export const LYKIA_FAILURE_CACHE_MS = 15_000;
const STORAGE_KEY = "kletia-network-lykia";

type Fetcher = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

let memory: LykiaLive | null = null;
let inflight: Promise<LykiaLive> | null = null;

/** True while a cached answer may still be shown without asking again. */
export function isFresh(entry: LykiaLive | null, now: number): entry is LykiaLive {
  if (!entry || entry.at === null || entry.state === "loading") return false;
  const ttl = entry.state === "live" ? LYKIA_CACHE_MS : LYKIA_FAILURE_CACHE_MS;
  return now - entry.at >= 0 && now - entry.at < ttl;
}

function readStored(): LykiaLive | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LykiaLive;
    return parsed && (parsed.state === "live" || parsed.state === "offline") && typeof parsed.at === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function store(entry: LykiaLive) {
  memory = entry;
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Storage blocked: the memory copy still serves this page.
  }
}

async function getJson(fetcher: Fetcher, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("answered with an error");
  return response.json();
}

/** Path of the relay on Kletia's API. */
export const LYKIA_RELAY_PATH = "/api/network/lykia";

/** Stats and health from the relay's answer (each null when missing). */
export function fromRelay(body: unknown): { stats: ReturnType<typeof parseLykiaStats>; health: ReturnType<typeof parseLykiaHealth> } {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return { stats: record.stats ? parseLykiaStats(record.stats) : null, health: record.health ? parseLykiaHealth(record.health) : null };
}

/** The cached answer if it is fresh, otherwise null. */
export function cachedLykia(now = Date.now()): LykiaLive | null {
  if (isFresh(memory, now)) return memory;
  const stored = readStored();
  if (isFresh(stored, now)) {
    memory = stored;
    return stored;
  }
  return null;
}

/**
 * Reads the relay (then /v1/stats directly if needed), one timeout for all.
 * Either answer is enough to be "live"; neither is "offline". Never throws.
 */
export function loadLykia(options: { readonly fetcher?: Fetcher; readonly now?: () => number; readonly force?: boolean; readonly relayOrigin?: string | null } = {}): Promise<LykiaLive> {
  const now = options.now ?? Date.now;
  if (!options.force) {
    const cached = cachedLykia(now());
    if (cached) return Promise.resolve(cached);
  }
  if (inflight) return inflight;
  const fetcher = options.fetcher ?? (globalThis.fetch?.bind(globalThis) as Fetcher | undefined);
  if (!fetcher) return Promise.resolve({ state: "offline", stats: null, health: null, at: now() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LYKIA_TIMEOUT_MS);
  const relayUrl = options.relayOrigin ? `${options.relayOrigin.replace(/\/+$/u, "")}${LYKIA_RELAY_PATH}` : null;
  const read = async (): Promise<LykiaLive> => {
    let stats: LykiaLive["stats"] = null;
    let health: LykiaLive["health"] = null;
    if (relayUrl) {
      try {
        ({ stats, health } = fromRelay(await getJson(fetcher, relayUrl, controller.signal)));
      } catch {
        // The relay is down or unreachable: fall back to what the browser may read itself.
      }
    }
    if (!stats && !controller.signal.aborted) {
      try {
        stats = parseLykiaStats(await getJson(fetcher, `${LYKIA_API}/v1/stats`, controller.signal));
      } catch {
        // No figures from this browser.
      }
    }
    return { state: stats || health ? "live" : "offline", stats, health, at: now() };
  };
  inflight = read()
    .then((entry) => {
      store(entry);
      return entry;
    })
    .finally(() => {
      clearTimeout(timer);
      inflight = null;
    });
  return inflight;
}

/** Tests only: forget the cache. */
export function resetLykiaCache() {
  memory = null;
  inflight = null;
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}
