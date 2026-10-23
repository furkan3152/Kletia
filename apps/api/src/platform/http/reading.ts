/**
 * Model-assisted reading over the HTTP layer: who may use it,
 * who may confirm it, and the consent tokens the desk and the embed card mint.
 *
 * - The server switch (`KLETIA_MODEL_READING`) must be `on`; `eval` is the
 *   admin eval only.
 * - Server keys (project, agent, operator): the project setting
 *   `modelReading: "enabled"` plus the request flag `modelReading: "on"`.
 * - Browsers (the first-party desk without a key, or a publishable key of an
 *   enabled project from one of its allowed origins): the request flag plus a
 *   consent token; a `session` token covers only text the person typed
 *   (`textOrigin: "typed"`) in the first-party desk.
 * - The public tier from any other origin never gets it.
 * - A confirm of a model reading is accepted only with a `confirm` token bound
 *   to the wallet and thread (minted by the confirm card, never for a server
 *   key), otherwise CONFIRM_AUTHORITY_REQUIRED (turn.ts).
 */
import type { Request } from "express";
import type { IntentTurnRequest } from "@kletia/core";
import { issueReadingConsentToken, verifyReadingConsentToken, type ReadingConsentScope } from "../../shared/intent/semanticConsent.js";
import { readingLayer } from "../engine/reading/index.js";
import type { TurnContext } from "../engine/clarify/types.js";
import { PlatformError } from "../errors.js";
import { authOf, isRecord, type AuthContext } from "./context.js";
import { projectAllowsOrigin, projectReadingEnabled } from "./projects.js";
import { kletiaWebOrigin } from "./webOrigin.js";

export interface ReadingAccess {
  /** The hook, only when the switch, eligibility and consent all allow it. */
  readonly reader?: TurnContext["reader"];
  readonly confirmAuthority: NonNullable<TurnContext["confirmAuthority"]>;
  /** The caller could opt in (refusals then say `details.modelReading: "available"`). */
  readonly available: boolean;
  /** Families of an agreed reading (for `interpretation.modelReading`). */
  readonly families: number;
}

/** Single-use `once` tokens already spent (process memory; they expire in 10 minutes anyway). */
const spent = new Map<string, number>();

function spend(token: string): boolean {
  const now = Date.now();
  for (const [key, at] of spent) if (now - at > 15 * 60 * 1_000) spent.delete(key);
  if (spent.has(token)) return false;
  spent.set(token, now);
  return true;
}

function serverKey(auth: AuthContext): boolean {
  return auth.keyId !== undefined && auth.keyKind !== "publishable";
}

function firstParty(req: Request): boolean {
  const origin = req.get("origin");
  return origin !== undefined && origin === kletiaWebOrigin();
}

async function browserEligible(req: Request, auth: AuthContext): Promise<boolean> {
  if (auth.keyKind === "publishable" && auth.projectId) {
    return (await projectReadingEnabled(auth.projectId)) && (await projectAllowsOrigin(auth.projectId, req.get("origin")));
  }
  return auth.keyId === undefined && firstParty(req);
}

/** The wallet a consent is bound to: the address of the request's first account ("eip155:8453:0x…" -> "0x…"). */
function walletOf(body: IntentTurnRequest): string | null {
  const first: unknown = (body.accounts ?? [])[0];
  if (typeof first !== "string") return null;
  const address = first.slice(first.lastIndexOf(":") + 1);
  return address.length >= 20 ? address : null;
}

function threadIdOf(body: Record<string, unknown>): string | undefined {
  if (typeof body.threadId === "string") return body.threadId;
  const thread = body.thread;
  return isRecord(thread) && typeof thread.id === "string" ? thread.id : undefined;
}

/** What this request may do with model-assisted reading. Never throws for a bad token: it is simply no consent. */
export async function readingAccess(req: Request, body: unknown): Promise<ReadingAccess> {
  const auth = authOf(req);
  const layer = readingLayer();
  const none: ReadingAccess = { confirmAuthority: "api", available: false, families: layer.families };
  if (!isRecord(body)) return none;
  const request = body as unknown as IntentTurnRequest;
  const wallet = walletOf(request);
  const threadId = threadIdOf(body);
  // Who may confirm: a wallet-bound confirm token for this thread, from a browser caller.
  let confirmAuthority: ReadingAccess["confirmAuthority"] = "api";
  if (!serverKey(auth) && wallet && threadId && typeof request.consent === "string") {
    const verified = verifyReadingConsentToken(request.consent, { wallet, threadId });
    if (verified?.scope === "confirm") confirmAuthority = "token";
  }
  if (layer.switch !== "on" || typeof request.text !== "string") return { ...none, confirmAuthority };
  if (serverKey(auth)) {
    const enabled = auth.projectId ? await projectReadingEnabled(auth.projectId) : false;
    if (!enabled) return { ...none, confirmAuthority };
    if (request.modelReading !== "on") return { ...none, confirmAuthority, available: true };
    return { reader: layer.hookFor({ scope: `key:${auth.keyId}:${threadId ?? "new"}`, project: auth.projectId ?? auth.keyId }), confirmAuthority, available: true, families: layer.families };
  }
  if (!(await browserEligible(req, auth)) || !wallet) return { ...none, confirmAuthority };
  if (request.modelReading !== "on" || typeof request.consent !== "string") return { ...none, confirmAuthority, available: true };
  const verified = verifyReadingConsentToken(request.consent, { wallet, text: request.text });
  const typedDesk = request.textOrigin === "typed" && firstParty(req) && auth.keyId === undefined;
  const ok = verified !== null && ((verified.scope === "once" && spend(request.consent)) || (verified.scope === "session" && typedDesk));
  if (!ok) return { ...none, confirmAuthority, available: true };
  return {
    reader: layer.hookFor({ scope: `wallet:${wallet.toLowerCase()}:${verified.bind}`, ...(auth.projectId ? { project: auth.projectId } : {}) }),
    confirmAuthority,
    available: true,
    families: layer.families,
  };
}

/**
 * POST /v1/reading-consent: mints a reading consent token for a browser
 * caller (the first-party desk, or an enabled project's publishable key from
 * an allowed origin). Server keys are refused, so an agent can never confirm
 * a model reading on the person's behalf.
 */
export async function mintReadingConsent(req: Request): Promise<{ token: string; expiresAt: string; scope: ReadingConsentScope }> {
  const auth = authOf(req);
  if (serverKey(auth)) {
    throw new PlatformError("CONFIRM_AUTHORITY_REQUIRED", "Only the person can consent to or confirm a model-assisted reading, from the Kletia desk or an enabled embed.", 403, [
      { path: "authorization", message: "Server keys cannot mint reading consent." },
    ]);
  }
  if (readingLayer().switch !== "on" || !(await browserEligible(req, auth))) {
    throw new PlatformError("CONFIRM_AUTHORITY_REQUIRED", "Model-assisted reading is not available here: it is offered in the Kletia desk and in embeds of projects that enabled it.", 403, [{ path: "origin", message: "Not eligible." }]);
  }
  const body: unknown = req.body;
  const issues: { path: string; message: string }[] = [];
  if (!isRecord(body)) throw new PlatformError("INVALID_REQUEST", "The consent request is invalid.", 400, [{ path: "", message: "Expected an object." }]);
  const scope = body.scope;
  if (scope !== "once" && scope !== "session" && scope !== "confirm") issues.push({ path: "scope", message: "Must be once, session or confirm." });
  if (typeof body.wallet !== "string" || body.wallet.length < 20 || body.wallet.length > 128) issues.push({ path: "wallet", message: "The wallet address the consent is bound to." });
  if (scope === "once" && (typeof body.text !== "string" || body.text.length === 0 || body.text.length > 1_000)) issues.push({ path: "text", message: "The message this consent covers." });
  if (scope === "confirm" && (typeof body.threadId !== "string" || body.threadId.length > 64)) issues.push({ path: "threadId", message: "The thread whose reading is confirmed." });
  if (scope === "session" && !(firstParty(req) && auth.keyId === undefined)) issues.push({ path: "scope", message: "Session consent is offered in the Kletia desk only." });
  if (issues.length > 0) throw new PlatformError("INVALID_REQUEST", "The consent request is invalid.", 400, issues);
  const issued = issueReadingConsentToken({
    scope: scope as ReadingConsentScope,
    wallet: body.wallet as string,
    ...(typeof body.text === "string" ? { text: body.text } : {}),
    ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
  });
  return { token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString(), scope: scope as ReadingConsentScope };
}
