/**
 * The journey over HTTP.
 *
 * - `POST /v1/intents?journey=true` (dry runs too) and
 *   `POST …/steps/{stepId}/prepare?journey=true` are served by the router
 *   with the engine's `journey` options; the journey is built on the preview
 *   returned next to it (`journey.basis.previewDigest === preview.digest`).
 *   `journeyReads=none` on create skips account reads (demo accounts).
 * - `GET /v1/intents/{id}/journey`: the journey of a stored intent on its
 *   latest preview. At most 30 reads per intent per minute (in-process,
 *   shared with the MCP `get_journey` tool), on top of the tier limit;
 *   `refresh=true` bypasses the 15 s result cache at most once per 10 s per
 *   intent; `reads=none` skips account reads.
 * - `POST /v1/intents/{id}/stop`: ends the intent at its current stop
 *   (engine `stopIntent`; 409 INTENT_IN_FLIGHT with Retry-After while a step
 *   is moving or holds a signable payload) and answers `{ intent, journey }`.
 *
 * There is deliberately no `?journey` flag on GET /v1/intents/{id} or POST
 * …/preview: clients fetch the journey with the plan and on step changes
 * only, which keeps polling inside the public tier (plan section 5).
 */
import type { Request } from "express";
import type { IntentGraph, Journey } from "@kletia/core";
import { getIntent, journeyFor, stopIntent } from "../index.js";
import { invalidRequest, queryParam } from "./context.js";
import { KeyWindowLimiter } from "./limits.js";

/** Journey reads per intent per minute. */
export const JOURNEY_READS_PER_INTENT_PER_MINUTE = 30;
/** One `refresh=true` per intent per this many seconds. */
export const JOURNEY_REFRESH_INTERVAL_SECONDS = 10;

/** GET …/journey and MCP get_journey, per intent id. */
export const journeyReadLimiter = new KeyWindowLimiter(JOURNEY_READS_PER_INTENT_PER_MINUTE, 60_000, "journey reads per intent per minute", 20_000, "");
/** `refresh=true`, per intent id. */
export const journeyRefreshLimiter = new KeyWindowLimiter(1, JOURNEY_REFRESH_INTERVAL_SECONDS * 1000, `journey refresh per intent every ${JOURNEY_REFRESH_INTERVAL_SECONDS} seconds`, 20_000, "");

/** Forgets both limiters' windows (tests). */
export function resetJourneyLimiters(): void {
  journeyReadLimiter.reset();
  journeyRefreshLimiter.reset();
}

export type JourneyReads = "live" | "none";

/** `live` (default) or `none` from the query parameter `name`; anything else is 400 INVALID_REQUEST. */
export function journeyReadsQuery(req: Request, name: string): JourneyReads | undefined {
  const value = queryParam(req, name, 8);
  if (value === undefined || value === "") return undefined;
  if (value === "live" || value === "none") return value;
  throw invalidRequest(`${name} must be live or none.`, [{ path: name, message: "Expected live or none." }]);
}

export interface JourneyReadOptions {
  readonly refresh?: boolean;
  readonly reads?: JourneyReads;
}

/**
 * The journey of a stored intent (rate limited per intent; 404
 * INTENT_NOT_FOUND for an unknown id). Limits are taken before anything is
 * read, so a refused request costs no RPC read.
 */
export async function readJourney(intentId: string, options: JourneyReadOptions = {}): Promise<Journey> {
  journeyReadLimiter.take(intentId);
  if (options.refresh) journeyRefreshLimiter.take(intentId);
  const intent = await getIntent(intentId);
  return journeyFor(intent, { ...(options.refresh ? { refresh: true } : {}), ...(options.reads ? { reads: options.reads } : {}) });
}

/** The journey of `intent` for a response next to it; null when it cannot be built (the intent is still returned). */
export async function journeyOrNull(intent: IntentGraph): Promise<Journey | null> {
  try {
    return await journeyFor(intent);
  } catch (error) {
    console.warn("[platform] journey failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** POST …/stop: the stopped intent (idempotent) and its journey. */
export async function stopWithJourney(intentId: string): Promise<{ intent: IntentGraph; journey: Journey | null }> {
  const intent = await stopIntent(intentId);
  return { intent, journey: await journeyOrNull(intent) };
}
