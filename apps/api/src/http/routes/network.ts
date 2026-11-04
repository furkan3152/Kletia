import { Router, type Request, type Response } from "express";

/**
 * GET /api/network/lykia: a tiny cached relay of Lykia's public status for
 * the site's network pages (kletiaai.xyz/network).
 *
 * Why it exists: Lykia's GET /v1/stats answers with
 * `Access-Control-Allow-Origin: *`, but its GET /v1/health sends no CORS
 * header, so a browser on kletiaai.xyz cannot read it. This route reads both
 * from the server, keeps the parsed answer for a minute, and returns only the
 * fields the board prints. It takes no input, so it cannot be pointed
 * anywhere else; the upstream origin is fixed below.
 */

export const LYKIA_ORIGIN = "https://lykia-api-akdogan1.vercel.app";
export const LYKIA_PROXY_TIMEOUT_MS = 4_000;
export const LYKIA_PROXY_TTL_MS = 60_000;
export const LYKIA_PROXY_FAILURE_TTL_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

type Fetcher = (input: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<globalThis.Response>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
const text = (value: unknown, max = 40): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);

/** The stats fields the board shows, in Lykia's own shape (so the site parses one format). */
export function pickStats(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const onchain = isRecord(body.onchain) ? body.onchain : {};
  const ecosystem = isRecord(body.ecosystem) ? body.ecosystem : {};
  const routed = isRecord(body.routed) ? body.routed : {};
  const contracts = Array.isArray(onchain.contracts)
    ? onchain.contracts
        .filter(isRecord)
        .slice(0, 8)
        .map((entry) => ({ name: text(entry.name, 48), address: text(entry.address, 42) }))
    : [];
  return {
    environment: text(body.environment),
    onchain: { contracts, accountsCreated: count(onchain.accountsCreated) },
    routed: { intents: count(routed.intents) },
    ecosystem: { protocols: count(ecosystem.protocols), verified: count(ecosystem.verified), routable: count(ecosystem.routable) },
    at: text(body.at),
  };
}

/** The health fields the board shows: status, version and the Arc mainnet reading. */
export function pickHealth(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const networks = isRecord(body.networks) ? body.networks : {};
  const arc = isRecord(networks["arc-mainnet"]) ? networks["arc-mainnet"] : {};
  const status = body.status === "ok" || body.status === "degraded" || body.status === "down" ? body.status : null;
  return {
    status,
    version: text(body.version, 16),
    environment: text(body.environment),
    networks: {
      "arc-mainnet": {
        reachable: typeof arc.reachable === "boolean" ? arc.reachable : null,
        head: count(arc.head),
        latencyMs: count(arc.latencyMs),
      },
    },
  };
}

export interface LykiaRelayAnswer {
  readonly stats: Record<string, unknown> | null;
  readonly health: Record<string, unknown> | null;
  readonly fetchedAt: string;
}

async function readJson(fetcher: Fetcher, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetcher(`${LYKIA_ORIGIN}${path}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) throw new Error("upstream body too large");
  return JSON.parse(body) as unknown;
}

/** One cached relay: concurrent callers share one upstream request. */
export function createLykiaRelay(options: { readonly fetcher?: Fetcher; readonly now?: () => number } = {}) {
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let cached: { answer: LykiaRelayAnswer; until: number } | null = null;
  let inflight: Promise<LykiaRelayAnswer> | null = null;

  return function read(): Promise<LykiaRelayAnswer> {
    if (cached && now() < cached.until) return Promise.resolve(cached.answer);
    if (inflight) return inflight;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LYKIA_PROXY_TIMEOUT_MS);
    inflight = Promise.allSettled([readJson(fetcher, "/v1/stats", controller.signal), readJson(fetcher, "/v1/health", controller.signal)])
      .then(([stats, health]) => {
        const answer: LykiaRelayAnswer = {
          stats: stats.status === "fulfilled" ? pickStats(stats.value) : null,
          health: health.status === "fulfilled" ? pickHealth(health.value) : null,
          fetchedAt: new Date(now()).toISOString(),
        };
        const ok = answer.stats !== null || answer.health !== null;
        cached = { answer, until: now() + (ok ? LYKIA_PROXY_TTL_MS : LYKIA_PROXY_FAILURE_TTL_MS) };
        return answer;
      })
      .finally(() => {
        clearTimeout(timer);
        inflight = null;
      });
    return inflight;
  };
}

const relay = createLykiaRelay();

export function lykiaRelayHandler(read: () => Promise<LykiaRelayAnswer>) {
  return async (_req: Request, res: Response) => {
    const answer = await read();
    const ok = answer.stats !== null || answer.health !== null;
    res.setHeader("Cache-Control", ok ? "public, max-age=60" : "no-store");
    res.status(ok ? 200 : 502).json({ success: ok, source: LYKIA_ORIGIN, ...answer });
  };
}

const router = Router();
router.get("/api/network/lykia", lykiaRelayHandler(relay));

export default router;
