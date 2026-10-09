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
 * rejected key without responding) -> usage counter (keyed requests, on
 * finish) -> tier rate limit (a rejected key counts against the IP) ->
 * reject failed credentials -> routes (per route: key requirement, then
 * Idempotency-Key) -> 404 -> errors.
 */
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router } from "express";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { parseAccountId } from "@kletia/core";
import {
  cancelIntent,
  createIntentDetailed,
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
import { authenticate, enforceAuthentication, loadOperatorKeys, parseKeyRequest, requireApiKey, type KeyTier } from "./auth.js";
import { badgeStatus, badgeSvg, BADGE_CACHE_SECONDS, shieldsBadge } from "./badge.js";
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
import { deliveryStore, listDeliveries, sendTestDelivery, startDeliveryPruner } from "./deliveries.js";
import { startWebhookDispatcher, webhookDeliveryTransport, WEBHOOK_USER_AGENT, type WebhookTransport } from "./dispatcher.js";
import { errorCatalogView } from "./errorsRoute.js";
import { readPlatformHealth } from "./health.js";
import { idempotencyUnsupported, idempotent, startIdempotencyPruner } from "./idempotency.js";
import { issueKey, keyIdParam, listProjectKeys, parseRotateRequest, revokeKey, rotateKey } from "./keys.js";
import { createKeyIssuanceLimiter, createTierLimiter } from "./limits.js";
import { mcpOriginGuard } from "./mcp/origin.js";
import { serveMcp } from "./mcp/server.js";
import { openApiJson } from "./openapi.js";
import { rememberIntentOwner } from "./owners.js";
import { platformSecretStatus } from "./secrets.js";
import { streamIntentEvents, type StreamOptions } from "./sse.js";
import { parseUsageWindow, startUsageFlusher, usageCounter, usageReport } from "./usage.js";
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
  { method: "post", path: "/webhooks/:id/test", auth: "key" },
  { method: "get", path: "/webhooks/:id/deliveries", auth: "key" },
  { method: "post", path: "/keys", auth: "public" },
  { method: "get", path: "/keys", auth: "key" },
  { method: "post", path: "/keys/:id/rotate", auth: "key" },
  { method: "delete", path: "/keys/:id", auth: "key" },
  { method: "get", path: "/usage", auth: "key" },
  { method: "get", path: "/errors", auth: "public" },
  { method: "post", path: "/mcp", auth: "public" },
  { method: "get", path: "/status/badge", auth: "public" },
  { method: "get", path: "/openapi.json", auth: "public" },
] satisfies PlatformRoute[]);

export interface PlatformRouterOptions {
  /** SSE tuning (tests). Defaults: 15 s heartbeat, 30 min lifetime. */
  readonly stream?: StreamOptions;
}

/* ------------------------------------------------------------ guards */

function tooLarge(): HttpError {
  return new HttpError(413, "PAYLOAD_TOO_LARGE", `Request bodies are limited to ${MAX_BODY_BYTES / 1024} KB.`);
}

/**
 * Size of a body an upstream (app-wide) JSON parser already consumed, when the
 * client streamed it without Content-Length. Re-serialising is bounded by that
 * parser's own limit.
 */
function preParsedBodyBytes(req: Request): number {
  const parsed: unknown = req.body;
  if (parsed === undefined || parsed === null || typeof parsed !== "object") return 0;
  try {
    return Buffer.byteLength(JSON.stringify(parsed), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const bodyGuards: RequestHandler = (req, res, next) => {
  const length = Number(req.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    sendError(req, res, tooLarge());
    return;
  }
  if (req.get("content-length") === undefined && preParsedBodyBytes(req) > MAX_BODY_BYTES) {
    sendError(req, res, tooLarge());
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
        sendError(req, res, tooLarge());
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

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function keyId(req: Request): string {
  const id = authOf(req).keyId;
  if (!id) throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an API key.");
  return id;
}

function webhookIdParam(req: Request): string {
  const id = pathParam(req, "id");
  if (!WEBHOOK_ID_PATTERN.test(id)) {
    throw invalidRequest("Webhook ids look like wh_ followed by 24 hex characters.", [{ path: "id", message: "Invalid webhook id." }]);
  }
  return id;
}

/** A dry run is side-effect free, so Idempotency-Key is ignored for it. */
function isDryRun(req: Request): boolean {
  const value: unknown = (req.query as Record<string, unknown>).dryRun;
  return value === "true" || value === "1";
}

/* ------------------------------------------------------------ handlers */

function handlers(options: PlatformRouterOptions, tierLimiter: RateLimitRequestHandler): Record<string, RequestHandler[]> {
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
    "get /errors": [
      handle((_req, res) => {
        cachePublicly(res, 300);
        sendJson(res, 200, errorCatalogView());
      }),
    ],
    "get /status/badge": [
      handle(async (req, res) => {
        const format = queryParam(req, "format", 8) ?? "svg";
        if (format !== "svg" && format !== "shields") {
          throw invalidRequest("format must be svg or shields.", [{ path: "format", message: "Expected svg or shields." }]);
        }
        const status = await badgeStatus();
        cachePublicly(res, BADGE_CACHE_SECONDS);
        if (format === "shields") {
          sendJson(res, 200, shieldsBadge(status));
          return;
        }
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
        // Meant to be embedded on other sites (READMEs, status pages).
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.status(200).type("image/svg+xml; charset=utf-8").send(badgeSvg(status));
      }),
    ],
    "post /keys": [
      idempotent({ route: "POST /keys", secret: true }),
      keyLimiter,
      handle(async (req, res) => {
        const { name } = parseKeyRequest(req.body);
        // Without a key: a new project. With a developer key: a sibling in the caller's project.
        sendJson(res, 201, { key: await issueKey(authOf(req), name) });
      }),
    ],
    "get /keys": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { keys: await listProjectKeys(authOf(req)) });
      }),
    ],
    "post /keys/:id/rotate": [
      requireApiKey,
      idempotent({ route: "POST /keys/:id/rotate", secret: true }),
      handle(async (req, res) => {
        const id = keyIdParam(pathParam(req, "id"));
        const { graceSeconds } = parseRotateRequest(req.body);
        sendJson(res, 200, { key: await rotateKey(authOf(req), id, graceSeconds) });
      }),
    ],
    "delete /keys/:id": [
      requireApiKey,
      handle(async (req, res) => {
        await revokeKey(authOf(req), keyIdParam(pathParam(req, "id")));
        res.status(204).end();
      }),
    ],
    "get /usage": [
      requireApiKey,
      handle(async (req, res) => {
        const auth = authOf(req);
        const window = parseUsageWindow(req);
        sendJson(res, 200, await usageReport({ keyId: keyId(req), tier: auth.tier as KeyTier }, window, tierLimiter));
      }),
    ],
    "post /mcp": [mcpOriginGuard, serveMcp],
    "post /quotes": [
      handle(async (req, res) => {
        // The engine accepts both the flat body and the nested SDK body (including from.account / to.recipient).
        sendJson(res, 200, await quoteRoutes(req.body));
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
      idempotent({ route: "POST /intents", applies: (req) => !isDryRun(req) }),
      handle(async (req, res) => {
        const dryRun = booleanQuery(req, "dryRun");
        const owner = authOf(req).keyId;
        const { intent, replayed } = await createIntentDetailed(req.body, { ...(owner ? { ownerKeyId: owner } : {}), dryRun });
        if (dryRun) {
          sendJson(res, 200, { intent });
          return;
        }
        rememberIntentOwner(intent.id, owner);
        // A repeated clientReference returns the intent stored by the earlier request.
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
      idempotencyUnsupported,
      handle(async (req, res) => {
        const id = intentIdParam(req);
        const stepId = stepIdParam(req);
        const { intent, payload } = await prepareStep(id, stepId);
        sendJson(res, 200, { payload, intent });
      }),
    ],
    "post /intents/:id/steps/:stepId/submit": [
      idempotent({ route: "POST /intents/:id/steps/:stepId/submit" }),
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
      idempotent({ route: "POST /intents/:id/cancel" }),
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
      idempotent({ route: "POST /webhooks", secret: true }),
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
        const id = webhookIdParam(req);
        await deleteWebhook(keyId(req), id);
        // The delivery log goes with the webhook (best effort; it is pruned after 7 days regardless).
        await deliveryStore()
          .deleteForWebhook(id)
          .catch((error: unknown) => console.warn("[platform] webhook delivery log cleanup failed:", error instanceof Error ? error.message : error));
        res.status(204).end();
      }),
    ],
    "post /webhooks/:id/test": [
      requireApiKey,
      handle(async (req, res) => {
        const delivery = await sendTestDelivery(keyId(req), webhookIdParam(req), webhookDeliveryTransport(), WEBHOOK_USER_AGENT);
        sendJson(res, 200, { delivery });
      }),
    ],
    "get /webhooks/:id/deliveries": [
      requireApiKey,
      handle(async (req, res) => {
        const id = webhookIdParam(req);
        const limit = integerQuery(req, "limit", 20, 1, 100);
        sendJson(res, 200, { deliveries: await listDeliveries(keyId(req), id, limit) });
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
  router.use(usageCounter);
  const tierLimiter = createTierLimiter();
  router.use(tierLimiter);
  router.use(enforceAuthentication);

  const table = handlers(options, tierLimiter);
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
 * Starts the settlement poller, the webhook dispatcher, the usage flusher
 * and the hourly pruning of idempotency records and delivery logs, once per
 * process. Returns an idempotent stop function. Call it on long-running
 * hosts only (not in serverless request handlers; there usage is written
 * per request and expired rows wait for a long-running instance).
 */
export function startPlatformBackground(options: PlatformBackgroundOptions = {}): () => void {
  if (stopBackground) return stopBackground;
  const stoppers = [
    startSettlementPoller(options.poller),
    startWebhookDispatcher(options.webhookTransport),
    startUsageFlusher(),
    startIdempotencyPruner(),
    startDeliveryPruner(),
  ];
  const stop = () => {
    if (stopBackground !== stop) return;
    stopBackground = null;
    for (const stopOne of stoppers) stopOne();
  };
  stopBackground = stop;
  return stop;
}
