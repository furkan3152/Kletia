/**
 * Automation routes under /v1/automations (mounted by router.ts through
 * PLATFORM_ROUTES). Owner: the presented API key, else a Kletia account
 * session (`Kletia-Account-Session`, first-party origin: the desk), else
 * 401 AUTOMATION_OWNER_REQUIRED. Agent keys create, change and resume
 * automations only with `permissions.automations` in their rule book;
 * pausing and deleting are always allowed.
 *
 * Limits on top of the tier limiter: 30 creations an hour per owner, 50 live
 * automations per owner.
 */
import type { Request, RequestHandler, Response } from "express";
import { ACCOUNT_SESSION_HEADER, AUTOMATION_LIMITS, type AutomationOwner } from "@kletia/core";
import { PlatformError } from "../index.js";
import { requireAccountOrigin, requireAccountSession, accountSessionOf } from "../http/accounts/auth.js";
import { authOf, handle, integerQuery, pathParam } from "../http/context.js";
import { idempotent } from "../http/idempotency.js";
import { assertAgentPermission } from "../http/policies/agentGuard.js";
import {
  automationInbox,
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomationRuns,
  listAutomations,
  patchAutomation,
  setAutomationPaused,
} from "./service.js";

const owners = new WeakMap<Request, AutomationOwner>();

function ownerOf(req: Request): AutomationOwner {
  const owner = owners.get(req);
  if (!owner) throw new PlatformError("AUTOMATION_OWNER_REQUIRED", "Send an API key, or a wallet session from the Kletia desk.", 401);
  return owner;
}

/** Resolves the owner: an API key, else a first-party wallet session. */
const resolveOwner: RequestHandler = (req, res, next) => {
  const auth = authOf(req);
  if (auth.keyId) {
    owners.set(req, { kind: "key", keyId: auth.keyId, projectId: auth.projectId ?? null });
    next();
    return;
  }
  if (!req.get(ACCOUNT_SESSION_HEADER)) {
    next(new PlatformError("AUTOMATION_OWNER_REQUIRED", "Send an API key, or a wallet session from the Kletia desk.", 401));
    return;
  }
  requireAccountOrigin(req, res, (originError?: unknown) => {
    if (originError) {
      next(originError);
      return;
    }
    requireAccountSession(req, res, (sessionError?: unknown) => {
      if (sessionError) {
        next(sessionError);
        return;
      }
      const { wallet } = accountSessionOf(req);
      owners.set(req, { kind: "wallet", walletKind: wallet.walletKind, address: wallet.address });
      next();
    });
  });
};

/** Creating, changing and resuming need `permissions.automations` on agent keys. */
const agentMayAutomate: RequestHandler = (req, _res, next) => {
  assertAgentPermission(authOf(req), "automations").then(() => next(), next);
};

const idParam = (req: Request) => pathParam(req, "id");

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function automationHandlers(): Record<string, RequestHandler[]> {
  return {
    "post /automations": [
      resolveOwner,
      agentMayAutomate,
      idempotent({ route: "POST /automations" }),
      handle(async (req, res) => {
        sendJson(res, 201, { automation: await createAutomation(ownerOf(req), req.body) });
      }),
    ],
    "get /automations": [
      resolveOwner,
      handle(async (req, res) => {
        sendJson(res, 200, { automations: await listAutomations(ownerOf(req)) });
      }),
    ],
    "get /automations/inbox": [
      resolveOwner,
      handle(async (req, res) => {
        sendJson(res, 200, { runs: await automationInbox(ownerOf(req)) });
      }),
    ],
    "get /automations/:id": [
      resolveOwner,
      handle(async (req, res) => {
        sendJson(res, 200, { automation: await getAutomation(ownerOf(req), idParam(req)) });
      }),
    ],
    "patch /automations/:id": [
      resolveOwner,
      agentMayAutomate,
      handle(async (req, res) => {
        sendJson(res, 200, { automation: await patchAutomation(ownerOf(req), idParam(req), req.body) });
      }),
    ],
    "delete /automations/:id": [
      resolveOwner,
      handle(async (req, res) => {
        await deleteAutomation(ownerOf(req), idParam(req));
        res.status(204).end();
      }),
    ],
    "post /automations/:id/pause": [
      resolveOwner,
      handle(async (req, res) => {
        sendJson(res, 200, { automation: await setAutomationPaused(ownerOf(req), idParam(req), true) });
      }),
    ],
    "post /automations/:id/resume": [
      resolveOwner,
      agentMayAutomate,
      handle(async (req, res) => {
        sendJson(res, 200, { automation: await setAutomationPaused(ownerOf(req), idParam(req), false) });
      }),
    ],
    "get /automations/:id/runs": [
      resolveOwner,
      handle(async (req, res) => {
        sendJson(res, 200, { runs: await listAutomationRuns(ownerOf(req), idParam(req), integerQuery(req, "limit", 20, 1, AUTOMATION_LIMITS.runsListed)) });
      }),
    ],
  };
}
