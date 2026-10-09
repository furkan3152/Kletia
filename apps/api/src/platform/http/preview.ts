/**
 * Asset-change preview over HTTP (asset-preview design V3, §8 and §9).
 *
 * - `POST /v1/intents/{id}/preview` recomputes the preview of a stored intent
 *   (stage `refresh`; `?quotes=refresh` re-quotes ready steps, which the
 *   engine limits to once per 20 s per intent). At most 6 recomputations per
 *   intent per minute (in-process, keyed by intent id, shared with MCP).
 * - `GET /v1/intents/{id}/preview` returns the last preview computed for the
 *   intent (any stage) while it is kept (30 minutes), else 404
 *   PREVIEW_NOT_FOUND.
 * - `POST /v1/intents?preview=true` and prepare (`payload.preview`, top-level
 *   `preview`) are served by the router with the helpers below.
 * - Storage: the engine's in-memory store, or Postgres
 *   `kletia_intent_previews` when KLETIA_DATABASE_URL is set, so a digest
 *   acknowledged on one instance is found on another. Previews are a cache:
 *   a failed write only costs a recomputation. Expired rows are pruned
 *   hourly by the background job.
 */
import type { Request } from "express";
import { PREVIEW_DIGEST_PATTERN, validatePreviewAck, type IntentPreview, type PreviewAck } from "@kletia/core";
import { configurePreviewStore, getIntent, getPreviewStore, MemoryPreviewStore, refreshIntentPreview, type PreviewStore } from "../index.js";
import { PlatformError } from "../errors.js";
import { HttpError, invalidRequest, isRecord, queryParam } from "./context.js";
import { dbQuery, platformDatabaseUrl } from "./db.js";

/** Recomputations per intent per minute (design §8.3). */
export const PREVIEWS_PER_INTENT_PER_MINUTE = 6;
const LIMIT_WINDOW_MS = 60_000;
const MAX_LIMITED_INTENTS = 20_000;
/** Previews larger than this are not stored (design §9): they are recomputed instead. */
export const MAX_STORED_PREVIEW_BYTES = 64 * 1024;
export const PREVIEW_PRUNE_INTERVAL_MS = 60 * 60_000;
/** Header set on prepare when an `acknowledgedPreview` was sent: `matched` or `unknown`. */
export const PREVIEW_ACK_HEADER = "Kletia-Preview-Ack";

/* ------------------------------------------------------------- Postgres */

const PREVIEW_SCHEMA = {
  name: "kletia_intent_previews",
  ddl: `
CREATE TABLE IF NOT EXISTS kletia_intent_previews (
  digest text PRIMARY KEY,
  intent_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('plan','prepare','refresh','indicative')),
  preview jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS kletia_intent_previews_intent_idx ON kletia_intent_previews (intent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kletia_intent_previews_expiry_idx ON kletia_intent_previews (expires_at);`,
} as const;

function isPreview(value: unknown): value is IntentPreview {
  return isRecord(value) && typeof value.digest === "string" && PREVIEW_DIGEST_PATTERN.test(value.digest) && typeof value.intentId === "string";
}

/** `kletia_intent_previews`: the latest preview per intent and every issued digest until it expires. */
export class PostgresPreviewStore implements PreviewStore {
  readonly kind = "postgres" as const;

  async put(preview: IntentPreview, ttlMs: number): Promise<void> {
    const json = JSON.stringify(preview);
    if (Buffer.byteLength(json, "utf8") > MAX_STORED_PREVIEW_BYTES) {
      throw new Error(`Preview ${preview.digest} is larger than ${MAX_STORED_PREVIEW_BYTES} bytes and is not stored.`);
    }
    // clock_timestamp(): two previews written by one transaction-less session still order by time.
    await dbQuery(
      PREVIEW_SCHEMA,
      `INSERT INTO kletia_intent_previews (digest, intent_id, stage, preview, created_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, clock_timestamp(), clock_timestamp() + ($5::bigint * interval '1 millisecond'))
       ON CONFLICT (digest) DO UPDATE SET stage = EXCLUDED.stage, preview = EXCLUDED.preview,
         created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
       WHERE kletia_intent_previews.intent_id = EXCLUDED.intent_id`,
      [preview.digest, preview.intentId, preview.stage, json, Math.max(1, Math.floor(ttlMs))],
    );
  }

  async byDigest(digest: string): Promise<IntentPreview | null> {
    if (!PREVIEW_DIGEST_PATTERN.test(digest)) return null;
    const result = await dbQuery<{ preview: unknown }>(
      PREVIEW_SCHEMA,
      "SELECT preview FROM kletia_intent_previews WHERE digest = $1 AND expires_at > now()",
      [digest],
    );
    const preview = result.rows[0]?.preview;
    return isPreview(preview) ? preview : null;
  }

  async latest(intentId: string): Promise<IntentPreview | null> {
    const result = await dbQuery<{ preview: unknown }>(
      PREVIEW_SCHEMA,
      `SELECT preview FROM kletia_intent_previews WHERE intent_id = $1 AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [intentId],
    );
    const preview = result.rows[0]?.preview;
    return isPreview(preview) ? preview : null;
  }

  async prune(before: string): Promise<void> {
    if (!Number.isFinite(Date.parse(before))) return;
    await dbQuery(PREVIEW_SCHEMA, "DELETE FROM kletia_intent_previews WHERE expires_at <= $1", [before]);
  }
}

let installed: PostgresPreviewStore | null = null;

/**
 * Installs the Postgres preview store when KLETIA_DATABASE_URL is set (once
 * per process; a store an embedder configured is left alone unless it is the
 * engine default). Without a database the engine's memory store stays.
 */
export function installPreviewStore(): void {
  if (!platformDatabaseUrl()) return;
  const current = getPreviewStore();
  if (installed && current === installed) return;
  if ((current as { kind?: unknown }).kind === "postgres") return;
  installed = new PostgresPreviewStore();
  configurePreviewStore(installed);
}

/** `memory`, `postgres` or `custom` (an embedder's store), for health. */
export function previewStoreKind(): "memory" | "postgres" | "custom" {
  const store = getPreviewStore();
  if (store instanceof PostgresPreviewStore) return "postgres";
  return store instanceof MemoryPreviewStore ? "memory" : "custom";
}

/** Hourly removal of expired previews (memory or Postgres). Returns a stop function. */
export function startPreviewPruner(intervalMs = PREVIEW_PRUNE_INTERVAL_MS): () => void {
  const run = () => {
    getPreviewStore()
      .prune(new Date().toISOString())
      .catch((error: unknown) => console.warn("[platform] preview pruning failed:", error instanceof Error ? error.message : error));
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ---------------------------------------------------------------- limits */

/** A fixed window per intent id: at most `limit` recomputations a minute (HTTP and MCP share it). */
export class IntentPreviewLimiter {
  private readonly windows = new Map<string, { count: number; readonly startedAt: number }>();

  constructor(readonly limit = PREVIEWS_PER_INTENT_PER_MINUTE, readonly windowMs = LIMIT_WINDOW_MS) {}

  take(intentId: string, now = Date.now()): void {
    let window = this.windows.get(intentId);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { count: 0, startedAt: now };
      this.windows.delete(intentId);
      this.windows.set(intentId, window);
      while (this.windows.size > MAX_LIMITED_INTENTS) {
        const oldest = this.windows.keys().next().value;
        if (oldest === undefined) break;
        this.windows.delete(oldest);
      }
    }
    if (window.count >= this.limit) {
      const seconds = Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000));
      throw new HttpError(429, "RATE_LIMITED", `At most ${this.limit} preview recomputations per intent per minute. Retry in ${seconds}s, or read the last one with GET.`, {
        headers: { "Retry-After": String(seconds) },
      });
    }
    window.count += 1;
  }

  reset(): void {
    this.windows.clear();
  }
}

export const previewLimiter = new IntentPreviewLimiter();

/* --------------------------------------------------------------- service */

/** `quotes=refresh` re-quotes ready steps; absent or `cached` re-simulates what the plan already fetched. */
export function parseQuotesQuery(req: Request): boolean {
  const quotes = queryParam(req, "quotes", 16);
  if (quotes === undefined || quotes === "" || quotes === "cached") return false;
  if (quotes === "refresh") return true;
  throw invalidRequest("quotes must be refresh or cached.", [{ path: "quotes", message: "Expected refresh or cached." }]);
}

/** POST …/preview takes no body (an empty JSON object is accepted). */
export function assertNoPreviewBody(body: unknown): void {
  if (body === undefined || body === null || (isRecord(body) && Object.keys(body).length === 0)) return;
  throw invalidRequest("POST /v1/intents/{id}/preview takes no body; use ?quotes=refresh to re-quote.", [{ path: "", message: "Unexpected body." }]);
}

/** Recomputes the preview of a stored intent (rate limited per intent). */
export async function recomputePreview(intentId: string, refreshQuotes: boolean): Promise<IntentPreview> {
  previewLimiter.take(intentId);
  return refreshIntentPreview(intentId, { refreshQuotes });
}

/** The last preview of a stored intent; 404 INTENT_NOT_FOUND / PREVIEW_NOT_FOUND. */
export async function latestPreview(intentId: string): Promise<IntentPreview> {
  await getIntent(intentId);
  const preview = await getPreviewStore().latest(intentId);
  if (!preview || preview.intentId !== intentId) {
    throw new PlatformError("PREVIEW_NOT_FOUND", "No preview is kept for this intent. Compute one with POST /v1/intents/{id}/preview, or create the intent with ?preview=true.", 404);
  }
  return preview;
}

/** The optional prepare body `{ "acknowledgedPreview": "sha256:…" }` (prepare had no body before; `{}` and no body stay valid). */
export function parsePrepareBody(body: unknown): PreviewAck {
  const parsed = validatePreviewAck(body);
  if (!parsed.ok) throw invalidRequest("The prepare body is invalid: send nothing, {} or { \"acknowledgedPreview\": \"sha256:…\" }.", parsed.issues);
  return parsed.value;
}
