/**
 * Kletia Platform API v1: the public HTTP surface over the engine.
 *
 *   app.use("/v1", createPlatformRouter(), platformErrorHandler);
 *   const stop = startPlatformBackground();   // settlement poller + webhooks
 *
 * Contract: docs/platform/api-v1.md; machine-readable: GET /v1/openapi.json.
 *
 * Middleware order (security relevant): request id + no-store -> body size
 * and media type guards -> JSON body (64 KB) -> authentication (records a
 * rejected key without responding) -> tier rate limit (a rejected key counts
 * against the IP) -> reject failed credentials -> routes -> 404 -> errors.
 */
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router } from "express";
import { parseAccountId } from "@kletia/core";
import {
  cancelIntent,
  createIntent,
  getIntent,
  listIntents,
  prepareStep,
  quoteRoutes,
  readAccountPortfolio,
  refreshIntent,
  startSettlementPoller,
  submitStep,
  type SettlementPollerOptions,
} from "../index.js";
import { authenticate, enforceAuthentication, issueDeveloperKey, loadOperatorKeys, parseKeyRequest, requireApiKey } from "./auth.js";
import { assetRegistry, networkCapabilities, protocolRegistry } from "./catalog.js";
import {
  authOf,
  booleanQuery,
  cachePublicly,
  handle,
  HttpError,
  intentIdParam,
  integerQuery,
  invalidRequest,
  isRecord,
  parseReferencesBody,
  pathParam,
  queryParam,
  requestContext,
  sendError,
  stepIdParam,
  WEBHOOK_ID_PATTERN,
} from "./context.js";
import { startWebhookDispatcher, type WebhookTransport } from "./dispatcher.js";
import { readPlatformHealth } from "./health.js";
import { createKeyIssuanceLimiter, createTierLimiter } from "./limits.js";
import { openApiJson } from "./openapi.js";
import { rememberIntentOwner } from "./owners.js";
import { platformSecretStatus } from "./secrets.js";
import { streamIntentEvents, type StreamOptions } from "./sse.js";
import { createWebhook, deleteWebhook, listWebhooks } from "./webhooks.js";

export const MAX_BODY_BYTES = 64 * 1024;

type Method = "get" | "post" | "delete";

export interface PlatformRoute {
  readonly method: Method;
  /** Express path relative to the /v1 mount point. */
  readonly path: string;
  readonly auth: "public" | "key";
}

/** Every endpoint the router serves (also used to keep the OpenAPI document honest). */
export const PLATFORM_ROUTES: readonly PlatformRoute[] = Object.freeze([
  { method: "get", path: "/health", auth: "public" },
  { method: "get", path: "/networks", auth: "public" },
  { method: "get", path: "/protocols", auth: "public" },
  { method: "get", path: "/assets", auth: "public" },
  { method: "post", path: "/quotes", auth: "public" },
  { method: "get", path: "/portfolio/:accountId", auth: "public" },
  { method: "post", path: "/intents", auth: "public" },
  { method: "get", path: "/intents", auth: "key" },
  { method: "get", path: "/intents/:id", auth: "public" },
  { method: "post", path: "/intents/:id/steps/:stepId/prepare", auth: "public" },
  { method: "post", path: "/intents/:id/steps/:stepId/submit", auth: "public" },
  { method: "post", path: "/intents/:id/refresh", auth: "public" },
  { method: "post", path: "/intents/:id/cancel", auth: "public" },
  { method: "get", path: "/intents/:id/events", auth: "public" },
  { method: "post", path: "/webhooks", auth: "key" },
  { method: "get", path: "/webhooks", auth: "key" },
  { method: "delete", path: "/webhooks/:id", auth: "key" },
  { method: "post", path: "/keys", auth: "public" },
  { method: "get", path: "/openapi.json", auth: "public" },
] satisfies PlatformRoute[]);

export interface PlatformRouterOptions {
  /** SSE tuning (tests). Defaults: 15 s heartbeat, 30 min lifetime. */
  readonly stream?: StreamOptions;
}

/* ------------------------------------------------------------ guards */

const bodyGuards: RequestHandler = (req, res, next) => {
  const length = Number(req.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    sendError(req, res, new HttpError(413, "PAYLOAD_TOO_LARGE", `Request bodies are limited to ${MAX_BODY_BYTES / 1024} KB.`));
    return;
  }
  const hasBody = req.get("transfer-encoding") !== undefined || (Number.isFinite(length) && length > 0);
  if (hasBody && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE")) {
    // `false` means a body is present with another media type (or none declared).
    if (req.is(["application/json", "application/*+json"]) === false) {
      sendError(req, res, new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send request bodies as application/json."));
      return;
    }
  }
  next();
};

interface BodyParserError {
  readonly type: string;
  readonly status?: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return isRecord(error) && typeof error.type === "string" && (typeof error.status === "number" || typeof error.statusCode === "number");
}

/**
 * Error handler for /v1. Also exported so an app that parses JSON globally
 * before mounting the router can format body-parser failures on /v1 too:
 * `app.use("/v1", createPlatformRouter(), platformErrorHandler)`.
 */
export const platformErrorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (isBodyParserError(error)) {
    switch (error.type) {
      case "entity.parse.failed":
        sendError(req, res, new HttpError(400, "INVALID_JSON", "The request body is not valid JSON (objects and arrays only)."));
        return;
      case "entity.too.large":
        sendError(req, res, new HttpError(413, "PAYLOAD_TOO_LARGE", `Request bodies are limited to ${MAX_BODY_BYTES / 1024} KB.`));
        return;
      case "charset.unsupported":
      case "encoding.unsupported":
        sendError(req, res, new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send request bodies as UTF-8 application/json."));
        return;
      default:
        sendError(req, res, new HttpError(400, "INVALID_REQUEST_BODY", "The request body could not be read."));
        return;
    }
  }
  sendError(req, res, error);
};

function methodNotAllowed(allowed: readonly Method[]): RequestHandler {
  const allow = [...new Set(allowed.flatMap((method) => (method === "get" ? ["GET", "HEAD"] : [method.toUpperCase()])))].join(", ");
  return (req, res) => {
    sendError(req, res, new HttpError(405, "METHOD_NOT_ALLOWED", `${req.method} is not allowed on this path. Allowed: ${allow}.`, {
      headers: { Allow: allow },
    }));
  };
}

const notFound: RequestHandler = (req, res) => {
  sendError(req, res, new HttpError(404, "NOT_FOUND", `No route for ${req.method} /v1${req.path}. See GET /v1/openapi.json.`));
};

/* ------------------------------------------------------------ helpers */

/** Accepts the flat engine shape or the SDK's nested `{ from: {network, asset, amount}, to: {network, asset} }`. */
function normalizeQuoteBody(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.from)) return body;
  const from = body.from;
  const to = isRecord(body.to) ? body.to : {};
  return {
    network: from.network,
    from: from.asset,
    amount: from.amount,
    to: to.asset,
    ...(to.network !== undefined && to.network !== from.network ? { toNetwork: to.network } : {}),
    ...(body.account !== undefined ? { account: body.account } : {}),
    ...(body.recipient !== undefined ? { recipient: body.recipient } : {}),
    ...(body.slippageBps !== undefined ? { slippageBps: body.slippageBps } : {}),
  };
}

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function keyId(req: Request): string {
  const id = authOf(req).keyId;
  if (!id) throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an API key.");
  return id;
}

/* ------------------------------------------------------------ handlers */

function handlers(options: PlatformRouterOptions): Record<string, RequestHandler[]> {
  const keyLimiter = createKeyIssuanceLimiter();
  return {
    "get /health": [
      handle(async (_req, res) => {
        sendJson(res, 200, await readPlatformHealth());
      }),
    ],
    "get /networks": [
      handle((_req, res) => {
        cachePublicly(res);
        sendJson(res, 200, { networks: networkCapabilities() });
      }),
    ],
    "get /protocols": [
      handle((_req, res) => {
        cachePublicly(res);
        sendJson(res, 200, { protocols: protocolRegistry() });
      }),
    ],
    "get /assets": [
      handle((req, res) => {
        const assets = assetRegistry(queryParam(req, "network"));
        cachePublicly(res);
        sendJson(res, 200, { assets });
      }),
    ],
    "get /openapi.json": [
      handle((_req, res) => {
        cachePublicly(res);
        res.status(200).type("application/json").send(openApiJson());
      }),
    ],
    "post /keys": [
      keyLimiter,
      handle(async (req, res) => {
        const { name } = parseKeyRequest(req.body);
        sendJson(res, 201, { key: await issueDeveloperKey(name) });
      }),
    ],
    "post /quotes": [
      handle(async (req, res) => {
        sendJson(res, 200, await quoteRoutes(normalizeQuoteBody(req.body)));
      }),
    ],
    "get /portfolio/:accountId": [
      handle(async (req, res) => {
        const account = parseAccountId(pathParam(req, "accountId"));
        if (!account) {
          throw invalidRequest("accountId must be a CAIP-10 account such as solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<address>.", [
            { path: "accountId", message: "Invalid CAIP-10 account id." },
          ]);
        }
        sendJson(res, 200, await readAccountPortfolio(account.id));
      }),
    ],
    "post /intents": [
      handle(async (req, res) => {
        const dryRun = booleanQuery(req, "dryRun");
        const owner = authOf(req).keyId;
        const startedAt = Date.now();
        const intent = await createIntent(req.body, { ...(owner ? { ownerKeyId: owner } : {}), dryRun });
        if (dryRun) {
          sendJson(res, 200, { intent });
          return;
        }
        rememberIntentOwner(intent.id, owner);
        // A clientReference replay returns the stored intent, created before this request.
        const replayed = Date.parse(intent.createdAt) < startedAt;
        if (replayed) res.setHeader("Idempotent-Replayed", "true");
        sendJson(res, replayed ? 200 : 201, { intent });
      }),
    ],
    "get /intents": [
      requireApiKey,
      handle(async (req, res) => {
        const limit = integerQuery(req, "limit", 20, 1, 100);
        sendJson(res, 200, { intents: await listIntents(keyId(req), limit) });
      }),
    ],
    "get /intents/:id": [
      handle(async (req, res) => {
        sendJson(res, 200, { intent: await getIntent(intentIdParam(req)) });
      }),
    ],
    "post /intents/:id/steps/:stepId/prepare": [
      handle(async (req, res) => {
        const id = intentIdParam(req);
        const stepId = stepIdParam(req);
        const { intent, payload } = await prepareStep(id, stepId);
        sendJson(res, 200, { payload, intent });
      }),
    ],
    "post /intents/:id/steps/:stepId/submit": [
      handle(async (req, res) => {
        const id = intentIdParam(req);
        const stepId = stepIdParam(req);
        const references = parseReferencesBody(req.body);
        sendJson(res, 200, { intent: await submitStep(id, stepId, references) });
      }),
    ],
    "post /intents/:id/refresh": [
      handle(async (req, res) => {
        sendJson(res, 200, { intent: await refreshIntent(intentIdParam(req)) });
      }),
    ],
    "post /intents/:id/cancel": [
      handle(async (req, res) => {
        sendJson(res, 200, { intent: await cancelIntent(intentIdParam(req)) });
      }),
    ],
    "get /intents/:id/events": [
      handle(async (req, res) => {
        await streamIntentEvents(req, res, options.stream);
      }),
    ],
    "post /webhooks": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 201, { webhook: await createWebhook(keyId(req), req.body) });
      }),
    ],
    "get /webhooks": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { webhooks: await listWebhooks(keyId(req)) });
      }),
    ],
    "delete /webhooks/:id": [
      requireApiKey,
      handle(async (req, res) => {
        const id = pathParam(req, "id");
        if (!WEBHOOK_ID_PATTERN.test(id)) {
          throw invalidRequest("Webhook ids look like wh_ followed by 24 hex characters.", [{ path: "id", message: "Invalid webhook id." }]);
        }
        await deleteWebhook(keyId(req), id);
        res.status(204).end();
      }),
    ],
  };
}

/* ------------------------------------------------------------ router */

/** Builds the /v1 router. Mount it at "/v1". */
export function createPlatformRouter(options: PlatformRouterOptions = {}): Router {
  // Boot-time configuration: operator key hashes and the webhook sealing key.
  loadOperatorKeys();
  platformSecretStatus();

  const router = express.Router({ caseSensitive: false, strict: false });
  router.use(requestContext);
  router.use(bodyGuards);
  router.use(express.json({ limit: MAX_BODY_BYTES, strict: true, type: ["application/json", "application/*+json"] }));
  router.use(authenticate);
  router.use(createTierLimiter());
  router.use(enforceAuthentication);

  const table = handlers(options);
  const byPath = new Map<string, PlatformRoute[]>();
  for (const route of PLATFORM_ROUTES) byPath.set(route.path, [...(byPath.get(route.path) ?? []), route]);
  for (const [path, routes] of byPath) {
    const chain = router.route(path);
    for (const route of routes) {
      const stack = table[`${route.method} ${route.path}`];
      if (!stack) throw new Error(`No handler for ${route.method.toUpperCase()} ${route.path}.`);
      chain[route.method](...stack);
    }
    chain.all(methodNotAllowed(routes.map((route) => route.method)));
  }

  router.use(notFound);
  router.use(platformErrorHandler);
  return router;
}

/* ------------------------------------------------------------ background */

export interface PlatformBackgroundOptions {
  readonly poller?: SettlementPollerOptions;
  /** Override webhook delivery (tests). Defaults to signed HTTPS POSTs. */
  readonly webhookTransport?: WebhookTransport;
}

let stopBackground: (() => void) | null = null;

/**
 * Starts the settlement poller and the webhook dispatcher once per process.
 * Returns an idempotent stop function. Call it on long-running hosts only
 * (not in serverless request handlers).
 */
export function startPlatformBackground(options: PlatformBackgroundOptions = {}): () => void {
  if (stopBackground) return stopBackground;
  const stopPoller = startSettlementPoller(options.poller);
  const stopDispatcher = startWebhookDispatcher(options.webhookTransport);
  const stop = () => {
    if (stopBackground !== stop) return;
    stopBackground = null;
    stopPoller();
    stopDispatcher();
  };
  stopBackground = stop;
  return stop;
}
