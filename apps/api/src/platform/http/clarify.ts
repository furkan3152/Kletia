/**
 * Clarify turns over Platform API v1: `POST /v1/intents?clarify=true` runs
 * one turn of the clarify engine (`clarifyTurn`) and the thread routes read
 * and delete the caller's Kletia-held threads. Without `clarify` the
 * endpoint is the strict planner, unchanged (router.ts never reaches this
 * module).
 *
 * Memory:
 * - Client-held (default): the response carries the whole thread blob
 *   (`kletia.thread/v1`, at most 16 KB) and the client sends it back as
 *   `thread`. The engine validates it and re-checks every value each turn.
 * - Kletia-held (`remember: true` on a first turn, then `threadId`): an API
 *   key is required (400 THREAD_REQUIRES_API_KEY on the public tier and for
 *   publishable keys); the response carries a ThreadRef. A later turn may
 *   leave out the request context (accounts, networks, constraints, metadata,
 *   clientReference): the thread keeps the last one sent, field by field.
 *   `expectedRev` (or `If-Match: "<rev>"`) refuses a thread that moved on
 *   (409 THREAD_CONFLICT); the stored update is conditional on the rev the
 *   turn read in any case.
 *
 * Statuses: needs_input 200; planned 201 when stored (200 with
 * Idempotent-Replayed when the intent's clientReference already existed) and
 * 200 on a dry run; cancelled 200; a refusal answers its catalogue status and
 * the thread (client-held or stored) is unchanged. Secrets in `text` or
 * `answer.text` are refused before anything is read, reserved or stored.
 */
import type { Request, RequestHandler, Response } from "express";
import {
  effectivePerps,
  THREAD_LIMITS,
  THREAD_STATUSES,
  isThreadId,
  type ClarifyThread,
  type IntentTurnRequest,
  type IntentTurnResponse,
  type Journey,
  type ThreadStatus,
} from "@kletia/core";
import { clarifyTurn, type ClarifyTurnOptions } from "../engine/clarify/index.js";
import { GRAMMAR_EXAMPLES } from "../engine/grammar.js";
import { JOURNEY_PLAN_DEADLINE_MS } from "../engine/journey/facts.js";
import { assertNoSecret } from "../engine/secretScreen.js";
import { PlatformError } from "../errors.js";
import { journeyFor } from "../index.js";
import { authOf, booleanQuery, integerQuery, invalidRequest, isRecord, pathParam, queryParam, type AuthContext } from "./context.js";
import { journeyReadsQuery } from "./journey.js";
import { readKeyChain } from "./policies/chain.js";
import { rememberIntentOwner } from "./owners.js";
import { readingAccess, type ReadingAccess } from "./reading.js";
import {
  decodeThreadCursor,
  encodeThreadCursor,
  openThreadLimitReached,
  threadDetailView,
  threadExpiry,
  threadNow,
  threadRef,
  threadStore,
  threadSummaryView,
  type ThreadContext,
  type ThreadDetailView,
  type ThreadRecord,
  type ThreadSummaryView,
} from "./threads.js";

/** The request context fields a Kletia-held thread keeps between turns. */
const CONTEXT_KEYS = ["accounts", "defaultNetwork", "sourceNetwork", "constraints", "metadata", "clientReference"] as const;

/* ------------------------------------------------------------- request flags */

/** `?clarify=true`: the request is a clarify turn. */
export function clarifyRequested(req: Request): boolean {
  return booleanQuery(req, "clarify");
}

/** Never throws: used by the idempotency middleware before the handler validates the query. */
function clarifyFlag(req: Request): boolean {
  const value: unknown = (req.query as Record<string, unknown>).clarify;
  return value === "true" || value === "1";
}

/** A clarify turn that creates or changes a Kletia-held thread (Idempotency-Key applies even to its dry runs). */
export function mutatesThread(req: Request): boolean {
  if (!clarifyFlag(req) || !isRecord(req.body)) return false;
  return req.body.threadId !== undefined || req.body.remember === true;
}

/**
 * Secrets first (before Idempotency-Key reserves anything): a clarify turn
 * whose `text` or `answer.text` carries secret material is refused with 400
 * MESSAGE_SECRET_REFUSED and nothing is stored, not even an idempotency row.
 */
export const screenClarifySecrets: RequestHandler = (req, _res, next) => {
  if (clarifyFlag(req) && isRecord(req.body)) {
    try {
      assertNoSecret(req.body.text, "text");
      assertNoSecret(isRecord(req.body.answer) ? req.body.answer.text : undefined, "answer.text");
    } catch (error) {
      next(error);
      return;
    }
  }
  next();
};

function requiresApiKey(): PlatformError {
  return new PlatformError("THREAD_REQUIRES_API_KEY", "Remembered threads need a server API key. Send one, or hold the thread yourself and send it back in thread.", 400, [
    { path: "remember", message: "Requires an API key." },
  ]);
}

/** The key that may hold threads: a server key (developer, agent or operator), never the public tier or a publishable key. */
function threadOwner(auth: AuthContext): string {
  // Publishable keys (browser keys) only ever get client-held threads.
  if (!auth.keyId || (auth as { readonly keyKind?: string }).keyKind === "publishable") throw requiresApiKey();
  return auth.keyId;
}

function threadNotFound(): PlatformError {
  return new PlatformError("THREAD_NOT_FOUND", "Unknown thread: it expired, was deleted, or belongs to another key. Start a new one.", 404, [
    { path: "threadId", message: "Unknown thread." },
  ]);
}

function threadConflict(rev: number): PlatformError {
  return new PlatformError("THREAD_CONFLICT", `Another turn changed this thread (it is at revision ${rev}). Read it again and resend.`, 409, [
    { path: "expectedRev", message: "The thread moved on." },
  ], undefined, { rev });
}

/** `If-Match: "<rev>"` (quoted or bare, weak validators accepted); undefined when absent. */
function ifMatchRev(req: Request): number | undefined {
  const raw = req.get("if-match");
  if (raw === undefined) return undefined;
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/u.exec(raw);
  if (!match) throw invalidRequest("If-Match must be the thread revision, for example \"3\".", [{ path: "If-Match", message: "Expected a revision number." }]);
  return Number(match[1]);
}

/** The revision a Kletia-held turn expects (expectedRev or If-Match); both must agree. */
function expectedRevOf(req: Request, body: Record<string, unknown>): number | undefined {
  const header = ifMatchRev(req);
  const field = Number.isSafeInteger(body.expectedRev) ? (body.expectedRev as number) : undefined;
  if (header !== undefined && field !== undefined && header !== field) {
    throw invalidRequest("expectedRev and If-Match name different revisions.", [{ path: "expectedRev", message: "Differs from If-Match." }]);
  }
  return field ?? header;
}

/* ------------------------------------------------------------- responses */

/** What a Kletia-held thread keeps of a response: a planned turn keeps its sentence and chips, not the intent graph. */
function compactResponse(response: IntentTurnResponse, ref: ReturnType<typeof threadRef>, stored: boolean): Record<string, unknown> {
  if (response.status !== "planned") return { ...response, thread: ref };
  return {
    status: response.status,
    turn: response.turn,
    sentence: response.sentence,
    assumptions: response.assumptions,
    dryRun: !stored,
    ...(stored ? { intentId: response.intent.id } : {}),
    thread: ref,
  };
}

function summaryOf(response: IntentTurnResponse): string {
  if (response.status === "needs_input") return response.draft.summary;
  if (response.status === "planned") return response.sentence.slice(0, 200);
  return "Cancelled";
}

interface TurnFlags {
  readonly dryRun: boolean;
  readonly preview: boolean;
  readonly journey: boolean;
  readonly journeyReads?: "live" | "none";
}

function flagsOf(req: Request): TurnFlags {
  const journey = booleanQuery(req, "journey");
  const journeyReads = journeyReadsQuery(req, "journeyReads");
  return {
    dryRun: booleanQuery(req, "dryRun"),
    // The journey is built on the plan-stage preview, which it implies (as on the strict path).
    preview: booleanQuery(req, "preview") || journey,
    journey,
    ...(journeyReads ? { journeyReads } : {}),
  };
}

/** The journey of a planned turn on its preview; null when it could not be built (never a failed turn). */
async function journeyOf(response: IntentTurnResponse, flags: TurnFlags): Promise<Journey | null> {
  if (response.status !== "planned") return null;
  try {
    return await journeyFor(response.intent, { preview: response.preview ?? null, reads: flags.journeyReads ?? "live", deadlineMs: JOURNEY_PLAN_DEADLINE_MS });
  } catch (error) {
    console.warn("[platform] clarify journey failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function send(res: Response, response: IntentTurnResponse, flags: TurnFlags, owner: string | undefined, thread: ClarifyThread | ReturnType<typeof threadRef>): Promise<void> {
  const body: Record<string, unknown> = { ...response, thread };
  if (response.status !== "planned") {
    res.status(200).json(body);
    return;
  }
  if (flags.journey) body.journey = await journeyOf(response, flags);
  if (flags.dryRun) {
    res.status(200).json(body);
    return;
  }
  rememberIntentOwner(response.intent.id, owner);
  // A repeated clientReference (a retried commit turn) returns the intent stored by the earlier request.
  if (response.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(response.replayed ? 200 : 201).json(body);
}

/* ------------------------------------------------------------- the turn */

/**
 * clarifyTurn, with the strict planner's example sentences as `hints` on an
 * INTENT_UNSUPPORTED refusal that carries none (as POST /v1/intents gives
 * them), so a client or an agent can show what Kletia reads.
 */
export async function runClarifyTurn(request: IntentTurnRequest, options: ClarifyTurnOptions): Promise<IntentTurnResponse> {
  try {
    return await clarifyTurn(request, options);
  } catch (error) {
    if (error instanceof PlatformError && error.code === "INTENT_UNSUPPORTED" && !error.hints) {
      throw new PlatformError(error.code, error.message, error.status, error.issues, GRAMMAR_EXAMPLES, error.details);
    }
    throw error;
  }
}

/**
 * The caller's perps rights for perps hand-offs (round 9): the key's Rule Book chain (agent keys have perps off
 * unless their rule book sets perps.enabled; a revoked chain has none), or the project defaults without a key.
 */
export async function perpsOption(owner: string | undefined): Promise<Pick<ClarifyTurnOptions, "perps">> {
  if (!owner) return {};
  const chain = await readKeyChain(owner);
  if (!chain || !chain.keyActive) return { perps: { enabled: false, maxLeverage: 1, venues: [], reason: "This key (or one of its ancestors) is revoked or expired." } };
  return { perps: effectivePerps(chain.levels) };
}

function engineOptions(owner: string | undefined, flags: TurnFlags, thread: ClarifyThread | null, access?: ReadingAccess): ClarifyTurnOptions {
  return {
    ...(access?.reader ? { reader: access.reader } : {}),
    ...(access ? { confirmAuthority: access.confirmAuthority, modelReadingAvailable: access.available, modelFamilies: access.families } : {}),
    ...(owner ? { ownerKeyId: owner } : {}),
    ...(flags.dryRun ? { dryRun: true } : {}),
    ...(flags.preview ? { preview: true } : {}),
    ...(flags.journey ? { journey: true } : {}),
    thread,
  };
}

function contextOf(source: Record<string, unknown>, fallback: ThreadContext | null): ThreadContext {
  const context: Record<string, unknown> = { ...(fallback ?? {}) };
  for (const key of CONTEXT_KEYS) if (source[key] !== undefined) context[key] = source[key];
  return context as unknown as ThreadContext;
}

function intentsAfter(previous: readonly string[], response: IntentTurnResponse, stored: boolean): string[] {
  if (response.status !== "planned" || !stored || previous.includes(response.intent.id)) return [...previous];
  return [...previous, response.intent.id].slice(-THREAD_LIMITS.intentsPerThread);
}

/** POST /v1/intents?clarify=true. */
export async function handleIntentTurn(req: Request, res: Response): Promise<void> {
  const flags = flagsOf(req);
  const auth = authOf(req);
  const body: unknown = req.body;
  // Secrets first (the engine screens again): nothing is read, loaded or stored for such a turn.
  if (isRecord(body)) {
    assertNoSecret(body.text, "text");
    assertNoSecret(isRecord(body.answer) ? body.answer.text : undefined, "answer.text");
  }
  // Model-assisted reading: switch, eligibility and consent first (nothing is read or sent without them).
  const access = await readingAccess(req, body);
  if (!isRecord(body) || (body.threadId === undefined && body.remember !== true)) {
    // Client-held thread (or none yet): the engine validates the request and the blob.
    const response = await runClarifyTurn(body as unknown as IntentTurnRequest, { ...engineOptions(auth.keyId, flags, null, access), ...(await perpsOption(auth.keyId)) });
    await send(res, response, flags, auth.keyId, response.thread);
    return;
  }
  const owner = threadOwner(auth);
  const store = threadStore();
  const now = threadNow();
  const nowIso = new Date(now).toISOString();

  if (body.threadId === undefined) {
    // remember: true on a first turn: a new Kletia-held thread (cap checked before planning, and again on insert).
    if (body.thread !== undefined) throw invalidRequest("Only a first turn creates a remembered thread.", [{ path: "remember", message: "Send remember on a first turn only." }]);
    if ((await store.countOpen(owner, nowIso)) >= THREAD_LIMITS.openPerKey) throw openThreadLimitReached();
    const response = await runClarifyTurn(body as unknown as IntentTurnRequest, { ...engineOptions(owner, flags, null, access), ...(await perpsOption(owner)) });
    const blob = response.thread as ClarifyThread;
    const stored = response.status === "planned" && !flags.dryRun;
    const record: ThreadRecord = {
      id: blob.id,
      ownerKeyId: owner,
      rev: blob.rev,
      status: blob.status,
      thread: blob,
      context: contextOf(body, null),
      lastResponse: null,
      intents: intentsAfter([], response, stored),
      summary: summaryOf(response),
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: threadExpiry(nowIso, nowIso),
    };
    const ref = threadRef(record);
    await store.create({ ...record, lastResponse: compactResponse(response, ref, stored) }, THREAD_LIMITS.openPerKey, nowIso);
    await send(res, response, flags, owner, ref);
    return;
  }

  // A later turn on a Kletia-held thread.
  if (!isThreadId(body.threadId)) {
    throw invalidRequest("The clarify turn is invalid.", [{ path: "threadId", message: "Must be th_ followed by 24 base32 characters." }]);
  }
  const current = await store.get(body.threadId);
  if (!current || current.ownerKeyId !== owner || current.expiresAt <= nowIso) throw threadNotFound();
  const expected = expectedRevOf(req, body);
  if (expected !== undefined && expected !== current.rev) throw threadConflict(current.rev);
  const context = contextOf(body, current.context);
  // The stored context fills what this turn left out; expectedRev is the HTTP layer's (checked above).
  const { expectedRev: _expectedRev, ...rest } = body;
  const request = { ...context, ...rest } as unknown as IntentTurnRequest;
  const response = await runClarifyTurn(request, { ...engineOptions(owner, flags, current.thread, access), ...(await perpsOption(owner)) });
  const blob = response.thread as ClarifyThread;
  const stored = response.status === "planned" && !flags.dryRun;
  const next: ThreadRecord = {
    ...current,
    rev: blob.rev,
    status: blob.status,
    thread: blob,
    context,
    intents: intentsAfter(current.intents, response, stored),
    summary: summaryOf(response),
    updatedAt: nowIso,
    expiresAt: threadExpiry(current.createdAt, nowIso),
  };
  const ref = threadRef(next);
  // Conditional on the revision this turn read: of two concurrent turns only one applies.
  if (!(await store.update({ ...next, lastResponse: compactResponse(response, ref, stored) }, current.rev))) {
    const latest = await store.get(current.id);
    throw threadConflict(latest?.rev ?? current.rev);
  }
  await send(res, response, flags, owner, ref);
}

/* ------------------------------------------------------------- thread routes */

function threadIdParam(req: Request): string {
  const id = pathParam(req, "id");
  if (!isThreadId(id)) throw invalidRequest("Thread ids look like th_ followed by 24 base32 characters.", [{ path: "id", message: "Invalid thread id." }]);
  return id;
}

/** GET /v1/threads?status=&limit=&cursor=: the key's threads that have not expired, most recently used first. */
export async function listThreads(req: Request): Promise<{ threads: ThreadSummaryView[]; nextCursor: string | null }> {
  const owner = threadOwner(authOf(req));
  const status = queryParam(req, "status", 16);
  if (status !== undefined && status !== "" && !(THREAD_STATUSES as readonly string[]).includes(status)) {
    throw invalidRequest(`status must be one of ${THREAD_STATUSES.join(", ")}.`, [{ path: "status", message: "Unknown status." }]);
  }
  const rawCursor = queryParam(req, "cursor", 200);
  const cursor = rawCursor ? decodeThreadCursor(rawCursor) : null;
  if (rawCursor && !cursor) throw invalidRequest("cursor must be the nextCursor of a previous page.", [{ path: "cursor", message: "Invalid cursor." }]);
  const limit = integerQuery(req, "limit", 20, 1, 100);
  const page = await threadStore().list(
    owner,
    { limit, ...(status ? { status: status as ThreadStatus } : {}), ...(cursor ? { cursor } : {}) },
    new Date(threadNow()).toISOString(),
  );
  return { threads: page.records.map(threadSummaryView), nextCursor: page.next ? encodeThreadCursor(page.next) : null };
}

async function ownThread(req: Request): Promise<ThreadRecord> {
  const owner = threadOwner(authOf(req));
  const id = threadIdParam(req);
  const record = await threadStore().get(id);
  if (!record || record.ownerKeyId !== owner || record.expiresAt <= new Date(threadNow()).toISOString()) throw threadNotFound();
  return record;
}

/** GET /v1/threads/{id}. */
export async function getThread(req: Request): Promise<ThreadDetailView> {
  return threadDetailView(await ownThread(req));
}

/** DELETE /v1/threads/{id}: the row is gone at once. */
export async function deleteThread(req: Request): Promise<void> {
  const record = await ownThread(req);
  if (!(await threadStore().delete(record.ownerKeyId, record.id))) throw threadNotFound();
}

