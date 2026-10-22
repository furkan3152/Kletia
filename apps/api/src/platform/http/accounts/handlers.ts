/**
 * Developer account routes under /v1/accounts (mounted by router.ts through
 * PLATFORM_ROUTES). Every route needs a first-party Origin; every route but
 * the sign-in pair needs the `Kletia-Account-Session` header.
 *
 * Limits on top of the public tier limit: sign-in messages and sign-in
 * attempts 10 a minute per address; reads 120 and changes 20 a minute per
 * session; new projects 5 an hour per wallet (projects.ts).
 */
import { ACCOUNT_LIMITS } from "@kletia/core";
import type { Request, RequestHandler, Response } from "express";
import { requireApiKey } from "../auth.js";
import { handle, pathParam } from "../context.js";
import { parseRotateRequest } from "../keys.js";
import { clientIp, KeyWindowLimiter } from "../limits.js";
import { accountSessionOf, issueSignInNonce, originOf, requireAccountOrigin, requireAccountSession, sessionView, signIn, signOut } from "./auth.js";
import {
  claimOwnedProject,
  createOwnedProject,
  issueOwnedKey,
  listActivity,
  listOwnedKeys,
  listOwnedProjects,
  projectCreations,
  revokeOwnedKey,
  rotateOwnedKey,
} from "./projects.js";

const noncesPerIp = new KeyWindowLimiter(ACCOUNT_LIMITS.noncesPerMinutePerIp, 60_000, "sign-in messages per minute from one address", 20_000, "");
const signInsPerIp = new KeyWindowLimiter(ACCOUNT_LIMITS.signInsPerMinutePerIp, 60_000, "sign-in attempts per minute from one address", 20_000, "");
const readsPerSession = new KeyWindowLimiter(ACCOUNT_LIMITS.readsPerMinutePerSession, 60_000, "account reads per minute", 20_000, " per session");
const writesPerSession = new KeyWindowLimiter(ACCOUNT_LIMITS.writesPerMinutePerSession, 60_000, "account changes per minute", 20_000, " per session");

/** Resets every account limiter (tests). */
export function resetAccountLimiters(): void {
  for (const limiter of [noncesPerIp, signInsPerIp, readsPerSession, writesPerSession, projectCreations]) limiter.reset();
}

function perIp(limiter: KeyWindowLimiter): RequestHandler {
  return (req, _res, next) => {
    try {
      limiter.take(clientIp(req));
      next();
    } catch (error) {
      next(error);
    }
  };
}

function perSession(limiter: KeyWindowLimiter): RequestHandler {
  return (req, _res, next) => {
    try {
      limiter.take(accountSessionOf(req).idHash);
      next();
    } catch (error) {
      next(error);
    }
  };
}

const read = [requireAccountOrigin, requireAccountSession, perSession(readsPerSession)];
const write = [requireAccountOrigin, requireAccountSession, perSession(writesPerSession)];

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

const projectParam = (req: Request) => pathParam(req, "projectId");

export function accountHandlers(): Record<string, RequestHandler[]> {
  return {
    "post /accounts/nonce": [
      requireAccountOrigin,
      perIp(noncesPerIp),
      handle(async (req, res) => {
        sendJson(res, 201, await issueSignInNonce(originOf(req), req.body));
      }),
    ],
    "post /accounts/session": [
      requireAccountOrigin,
      perIp(signInsPerIp),
      handle(async (req, res) => {
        sendJson(res, 201, await signIn(req, req.body));
      }),
    ],
    "get /accounts/session": [
      ...read,
      handle((req, res) => {
        sendJson(res, 200, { session: sessionView(accountSessionOf(req).record) });
      }),
    ],
    "delete /accounts/session": [
      requireAccountOrigin,
      requireAccountSession,
      handle(async (req, res) => {
        await signOut(req);
        res.status(204).end();
      }),
    ],
    "get /accounts/activity": [
      ...read,
      handle(async (req, res) => {
        sendJson(res, 200, { activity: await listActivity(req) });
      }),
    ],
    "get /accounts/projects": [
      ...read,
      handle(async (req, res) => {
        sendJson(res, 200, { projects: await listOwnedProjects(req) });
      }),
    ],
    "post /accounts/projects": [
      ...write,
      handle(async (req, res) => {
        sendJson(res, 201, await createOwnedProject(req, req.body));
      }),
    ],
    "post /accounts/projects/claim": [
      ...write,
      requireApiKey,
      handle(async (req, res) => {
        const result = await claimOwnedProject(req);
        sendJson(res, result.claimed ? 201 : 200, result);
      }),
    ],
    "get /accounts/projects/:projectId/keys": [
      ...read,
      handle(async (req, res) => {
        sendJson(res, 200, { keys: await listOwnedKeys(req, projectParam(req)) });
      }),
    ],
    "post /accounts/projects/:projectId/keys": [
      ...write,
      handle(async (req, res) => {
        sendJson(res, 201, { key: await issueOwnedKey(req, projectParam(req), req.body) });
      }),
    ],
    "post /accounts/projects/:projectId/keys/:keyId/rotate": [
      ...write,
      handle(async (req, res) => {
        const { graceSeconds } = parseRotateRequest(req.body);
        sendJson(res, 200, { key: await rotateOwnedKey(req, projectParam(req), pathParam(req, "keyId"), graceSeconds) });
      }),
    ],
    "delete /accounts/projects/:projectId/keys/:keyId": [
      ...write,
      handle(async (req, res) => {
        await revokeOwnedKey(req, projectParam(req), pathParam(req, "keyId"));
        res.status(204).end();
      }),
    ],
  };
}
