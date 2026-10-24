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
 * reject failed credentials -> publishable keys: route allowlist, per-IP
 * budget, project origin rule -> routes (per route: key requirement, then
 * Idempotency-Key) -> 404 -> errors.
 */
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router } from "express";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { parseAccountId, PROJECT_LIMITS } from "@kletia/core";
import {
  cancelIntent,
  createIntentDetailed,
  getIntent,
  installNameResolvers,
  listIntents,
  listLendingMetrics,
  parsePortfolioAccounts,
  prepareStep,
  quoteRoutes,
  readAccountPortfolio,
  readAccountPortfolios,
  refreshIntent,
  startSettlementPoller,
  submitStep,
  type SettlementPollerOptions,
} from "../index.js";
import { apiKeyStore, authenticate, enforceAuthentication, keyKindOf, loadOperatorKeys, parseKeyRequest, requireApiKey, type KeyTier } from "./auth.js";
import { validateContractTestRequest } from "@kletia/core";
import { badgeStatus, badgeSvg, BADGE_CACHE_SECONDS, shieldsBadge } from "./badge.js";
import { mintReadingConsent } from "./reading.js";
import { clarifyRequested, deleteThread, getThread, handleIntentTurn, listThreads, mutatesThread, screenClarifySecrets } from "./clarify.js";
import { assetRegistry, networkCapabilities, protocolRegistry, venueFilter } from "./catalog.js";
import {
  authOf,
  booleanQuery,
  cachePublicly,
  contractIdParam,
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
  sessionIdParam,
  stepIdParam,
  WEBHOOK_ID_PATTERN,
} from "./context.js";
import {
  deleteContract,
  getContract,
  inspectContract,
  installContractDirectory,
  listContracts,
  operatorSuspend,
  parseContractListFilter,
  registerContract,
  reverifyContract,
  testContract,
  updateContract,
} from "./contracts.js";
import { startContractWatcher } from "./contractWatcher.js";
import { deliveryStore, listDeliveries, sendTestDelivery, startDeliveryPruner } from "./deliveries.js";
import { startWebhookDispatcher, webhookDeliveryTransport, WEBHOOK_USER_AGENT, type WebhookTransport } from "./dispatcher.js";
import { errorCatalogView } from "./errorsRoute.js";
import { startEventStreamBuffer, streamKeyEvents } from "./eventStream.js";
import { readPlatformHealth } from "./health.js";
import { idempotencyUnsupported, idempotent, startIdempotencyPruner } from "./idempotency.js";
import { journeyReadsQuery, readJourney, stopWithJourney } from "./journey.js";
import { issueKey, keyIdParam, listProjectKeys, parseRotateRequest, revokeKey, rotateKey } from "./keys.js";
import {
  createFlowSession,
  createPublishableGuard,
  createPublishableKey,
  deleteProjectLogo,
  getProject,
  installPublishableContractGuard,
  patchProject,
  publishableProfile,
  putProjectLogo,
  serveProjectLogo,
  verifyProjectDomain,
} from "./projects.js";
import { contractTestLimiter, contractWriteLimiter, createKeyIssuanceLimiter, createTierLimiter, takePortfolioReads } from "./limits.js";
import { mcpOriginGuard } from "./mcp/origin.js";
import { serveMcp } from "./mcp/server.js";
import { servedOpenApiJson } from "./openapi.js";
import { rememberIntentOwner } from "./owners.js";
import { assertNoPreviewBody, installPreviewStore, latestPreview, parsePrepareBody, parseQuotesQuery, PREVIEW_ACK_HEADER, recomputePreview, startPreviewPruner } from "./preview.js";
import { startReceiptEventBuffer } from "./receipts/events.js";
import { receiptHandlers } from "./receipts/handlers.js";
import { startReceiptIssuer, type ReceiptIssuerOptions } from "./receipts/issuer.js";
import { startReceiptLog } from "./receipts/log.js";
import { receiptSignerStatus } from "./receipts/signer.js";
import { forbidAgent } from "./policies/agentGuard.js";
import { policyHandlers } from "./policies/handlers.js";
import { installPolicyGate, startPolicyBackground } from "./policies/install.js";
import { parseUsageScope, subtreeUsage } from "./policies/usage.js";
import { linkHandlers } from "./links/handlers.js";
import { accountHandlers } from "./accounts/handlers.js";
import { automationHandlers } from "../automation/handlers.js";
import { startAutomationEvaluator } from "../automation/evaluator.js";
import { startDataSnapshotJob } from "../data/index.js";
import { orderHandlers } from "./orders/handlers.js";
import { perpsHandlers } from "./perps/handlers.js";
import { agentHandlers } from "./agents/handlers.js";
import { afterLinkSubmit, beforeLinkPrepare } from "./links/uses.js";
import { startLinkBackground } from "./links/watcher.js";
import { platformSecretStatus } from "./secrets.js";
import { createSession, createSessionIntent, getSession, startSessionPruner } from "./sessions.js";
import { streamIntentEvents, type StreamOptions } from "./sse.js";
import { startThreadPruner } from "./threads.js";
import { parseUsageWindow, startUsageFlusher, usageCounter, usageReport } from "./usage.js";
import { createWebhook, deleteWebhook, listWebhooks } from "./webhooks.js";
import { dataHandlers } from "./data.js";

export const MAX_BODY_BYTES = 64 * 1024;

type Method = "get" | "post" | "put" | "patch" | "delete";

export interface PlatformRoute {
  readonly method: Method;
  /** Express path relative to the /v1 mount point. */
  readonly path: string;
  /** `operator`: an operator API key (developer keys are refused). */
  readonly auth: "public" | "key" | "operator";
  /**
   * Open to publishable keys (integrator design 4.8): the public tier's
   * operations, owned intents, flow sessions and the project profile. Every
   * other route answers 403 PUBLISHABLE_KEY_FORBIDDEN to a publishable key.
   */
  readonly publishable?: true;
}

/** Every endpoint the router serves (also used to keep the OpenAPI document honest). */
export const PLATFORM_ROUTES: readonly PlatformRoute[] = Object.freeze([
  { method: "get", path: "/health", auth: "public", publishable: true },
  { method: "get", path: "/networks", auth: "public", publishable: true },
  { method: "get", path: "/protocols", auth: "public", publishable: true },
  { method: "get", path: "/assets", auth: "public", publishable: true },
  { method: "get", path: "/venues", auth: "public", publishable: true },
  { method: "post", path: "/quotes", auth: "public", publishable: true },
  { method: "get", path: "/portfolio", auth: "public", publishable: true },
  { method: "get", path: "/portfolio/:accountId", auth: "public", publishable: true },
  { method: "get", path: "/data/portfolio", auth: "public", publishable: true },
  { method: "get", path: "/data/positions", auth: "public", publishable: true },
  { method: "get", path: "/data/history", auth: "key", publishable: true },
  { method: "get", path: "/data/markets/yields", auth: "public", publishable: true },
  { method: "get", path: "/data/markets/prices", auth: "public", publishable: true },
  { method: "get", path: "/data/markets/status", auth: "public", publishable: true },
  { method: "get", path: "/data/export", auth: "public", publishable: true },
  // On-chain history (data/transactions.ts): an API key's named addresses, or a desk wallet session's tracked set.
  { method: "get", path: "/data/transactions", auth: "public", publishable: true },
  { method: "get", path: "/data/transactions/:id", auth: "public", publishable: true },
  { method: "get", path: "/data/pnl", auth: "public", publishable: true },
  { method: "get", path: "/data/snapshots", auth: "public", publishable: true },
  { method: "get", path: "/data/summary", auth: "public", publishable: true },
  // Tracking opt-in: a desk wallet session (first-party origin) only.
  { method: "get", path: "/data/tracking", auth: "public" },
  { method: "post", path: "/data/tracking", auth: "public" },
  { method: "delete", path: "/data/tracking", auth: "public" },
  { method: "post", path: "/intents", auth: "public", publishable: true },
  // Model-assisted reading consent (design A.7.6): browser callers only; server keys are refused in the handler.
  { method: "post", path: "/reading-consent", auth: "public", publishable: true },
  // ?owner=key_…: a key of the caller's subtree (agent or publishable keys).
  { method: "get", path: "/intents", auth: "key" },
  { method: "get", path: "/intents/:id", auth: "public", publishable: true },
  { method: "post", path: "/intents/:id/steps/:stepId/prepare", auth: "public", publishable: true },
  { method: "post", path: "/intents/:id/steps/:stepId/submit", auth: "public", publishable: true },
  { method: "post", path: "/intents/:id/refresh", auth: "public", publishable: true },
  { method: "post", path: "/intents/:id/cancel", auth: "public", publishable: true },
  { method: "get", path: "/intents/:id/events", auth: "public", publishable: true },
  // Journey (journey design 7.1): the itinerary of a stored intent, and ending it at its current stop.
  { method: "get", path: "/intents/:id/journey", auth: "public", publishable: true },
  { method: "post", path: "/intents/:id/stop", auth: "public", publishable: true },
  { method: "post", path: "/intents/:id/preview", auth: "public", publishable: true },
  { method: "get", path: "/intents/:id/preview", auth: "public", publishable: true },
  { method: "get", path: "/intents/:id/receipt", auth: "public", publishable: true },
  { method: "get", path: "/intents/:id/receipts", auth: "public", publishable: true },
  { method: "post", path: "/intents/:id/receipt/shares", auth: "public", publishable: true },
  { method: "get", path: "/intents/:id/receipt/shares", auth: "public", publishable: true },
  { method: "delete", path: "/intents/:id/receipt/shares/:shareId", auth: "public", publishable: true },
  { method: "delete", path: "/intents/:id/receipt/disclosures", auth: "public", publishable: true },
  // Before /receipts/:receiptId, which would otherwise capture "keys" and "log".
  { method: "get", path: "/receipts/keys", auth: "public", publishable: true },
  { method: "get", path: "/receipts/log", auth: "public", publishable: true },
  { method: "get", path: "/receipts/log/inclusion", auth: "public", publishable: true },
  { method: "get", path: "/receipts/log/:seq", auth: "public", publishable: true },
  { method: "post", path: "/receipts/log/:seq/anchor", auth: "operator" },
  { method: "get", path: "/receipts/:receiptId", auth: "public", publishable: true },
  { method: "get", path: "/receipts/:receiptId/status", auth: "public", publishable: true },
  { method: "get", path: "/receipts/:receiptId/shares/:shareId", auth: "public", publishable: true },
  { method: "post", path: "/webhooks", auth: "key" },
  { method: "get", path: "/webhooks", auth: "key" },
  { method: "delete", path: "/webhooks/:id", auth: "key" },
  { method: "post", path: "/webhooks/:id/test", auth: "key" },
  { method: "get", path: "/webhooks/:id/deliveries", auth: "key" },
  // The key's events as Server-Sent Events, routed like its webhooks (integrator design 4.6).
  { method: "get", path: "/events", auth: "key" },
  { method: "post", path: "/keys", auth: "public" },
  { method: "get", path: "/keys", auth: "key" },
  { method: "post", path: "/keys/:id/rotate", auth: "key" },
  { method: "delete", path: "/keys/:id", auth: "key" },
  { method: "patch", path: "/keys/:id", auth: "key" },
  // Rule Book (policy design §11.1): agent keys, rule books, simulator, decisions, spend, approvals.
  { method: "post", path: "/keys/:id/children", auth: "key" },
  { method: "get", path: "/keys/:id/policy", auth: "key" },
  { method: "put", path: "/keys/:id/policy", auth: "key" },
  { method: "delete", path: "/keys/:id/policy", auth: "key" },
  { method: "delete", path: "/keys/:id/policy/pending", auth: "key" },
  { method: "get", path: "/keys/:id/policy/versions", auth: "key" },
  { method: "get", path: "/projects/current/policy", auth: "key" },
  { method: "put", path: "/projects/current/policy", auth: "key" },
  { method: "delete", path: "/projects/current/policy", auth: "key" },
  { method: "delete", path: "/projects/current/policy/pending", auth: "key" },
  { method: "post", path: "/policy/validate", auth: "public", publishable: true },
  { method: "post", path: "/policy/evaluate", auth: "key" },
  { method: "get", path: "/policy/decisions", auth: "key" },
  { method: "get", path: "/policy/decisions/:id", auth: "key" },
  { method: "get", path: "/policy/spend", auth: "key" },
  { method: "get", path: "/policy/approvals", auth: "key" },
  // The id is the capability; deciding takes a project key or a listed wallet's signature.
  { method: "get", path: "/policy/approvals/:id", auth: "public", publishable: true },
  { method: "post", path: "/policy/approvals/:id/approve", auth: "public" },
  { method: "post", path: "/policy/approvals/:id/reject", auth: "public" },
  { method: "get", path: "/usage", auth: "key" },
  // Intent links (links design §3.1): CRUD with the publisher key; visitors quote and create intents publicly.
  { method: "post", path: "/links", auth: "key" },
  { method: "get", path: "/links", auth: "key" },
  { method: "get", path: "/links/:id", auth: "public", publishable: true },
  { method: "patch", path: "/links/:id", auth: "key" },
  { method: "delete", path: "/links/:id", auth: "key" },
  { method: "post", path: "/links/:id/quote", auth: "public", publishable: true },
  { method: "post", path: "/links/:id/intents", auth: "public", publishable: true },
  { method: "get", path: "/links/:id/stats", auth: "key" },
  { method: "get", path: "/links/:id/card.png", auth: "public", publishable: true },
  { method: "get", path: "/links/:id/page", auth: "public", publishable: true },
  { method: "post", path: "/links/:id/report", auth: "public", publishable: true },
  { method: "post", path: "/links/:id/suspend", auth: "operator" },
  { method: "post", path: "/links/:id/blink-approval", auth: "operator" },
  // Solana Actions (links design §6); actions.json is served by the web origin.
  { method: "get", path: "/blinks/:id", auth: "public", publishable: true },
  { method: "post", path: "/blinks/:id", auth: "public", publishable: true },
  { method: "post", path: "/blinks/:id/next", auth: "public", publishable: true },
  // Automations (automation/): the API key's own, or (without a key) a desk wallet session's.
  { method: "post", path: "/automations", auth: "public" },
  { method: "get", path: "/automations", auth: "public" },
  // Before /automations/:id, which would otherwise capture "inbox".
  { method: "get", path: "/automations/inbox", auth: "public" },
  { method: "get", path: "/automations/:id", auth: "public" },
  { method: "patch", path: "/automations/:id", auth: "public" },
  { method: "delete", path: "/automations/:id", auth: "public" },
  { method: "post", path: "/automations/:id/pause", auth: "public" },
  { method: "post", path: "/automations/:id/resume", auth: "public" },
  { method: "get", path: "/automations/:id/runs", auth: "public" },
  { method: "post", path: "/contracts", auth: "key" },
  { method: "get", path: "/contracts", auth: "key" },
  // Before /contracts/:id, which would otherwise capture "inspect".
  { method: "get", path: "/contracts/inspect", auth: "key" },
  { method: "get", path: "/contracts/:id", auth: "key" },
  { method: "patch", path: "/contracts/:id", auth: "key" },
  { method: "delete", path: "/contracts/:id", auth: "key" },
  { method: "post", path: "/contracts/:id/test", auth: "key" },
  { method: "post", path: "/contracts/:id/reverify", auth: "key" },
  { method: "post", path: "/contracts/:id/suspend", auth: "operator" },
  // A publishable key sends only { flow, hostOrigin } (projects.ts).
  { method: "post", path: "/sessions", auth: "key", publishable: true },
  { method: "get", path: "/sessions/:id", auth: "public", publishable: true },
  { method: "post", path: "/sessions/:id/intents", auth: "public", publishable: true },
  // Kletia-held clarify threads (clarify design §6.1): the key's own, read and deleted by id.
  { method: "get", path: "/threads", auth: "key" },
  { method: "get", path: "/threads/:id", auth: "key" },
  { method: "delete", path: "/threads/:id", auth: "key" },
  // Projects (integrator design 4.8): settings, domain proof, publishable keys, logo, the publishable profile.
  { method: "get", path: "/projects/current", auth: "key" },
  { method: "patch", path: "/projects/current", auth: "key" },
  { method: "post", path: "/projects/current/domain/verify", auth: "key" },
  { method: "post", path: "/projects/current/publishable-keys", auth: "key" },
  { method: "put", path: "/projects/current/logo", auth: "key" },
  { method: "delete", path: "/projects/current/logo", auth: "key" },
  { method: "get", path: "/projects/:projectId/logo/:file", auth: "public", publishable: true },
  { method: "get", path: "/publishable/profile", auth: "key", publishable: true },
  // Developer accounts (accounts/): wallet sign-in, then the wallet's projects and their keys (Kletia-Account-Session).
  { method: "post", path: "/accounts/nonce", auth: "public" },
  { method: "post", path: "/accounts/session", auth: "public" },
  { method: "get", path: "/accounts/session", auth: "public" },
  { method: "delete", path: "/accounts/session", auth: "public" },
  { method: "get", path: "/accounts/activity", auth: "public" },
  { method: "get", path: "/accounts/projects", auth: "public" },
  { method: "post", path: "/accounts/projects", auth: "public" },
  // The presented project key (X-Kletia-Key) proves control of its project.
  { method: "post", path: "/accounts/projects/claim", auth: "key" },
  { method: "get", path: "/accounts/projects/:projectId/keys", auth: "public" },
  { method: "post", path: "/accounts/projects/:projectId/keys", auth: "public" },
  { method: "post", path: "/accounts/projects/:projectId/keys/:keyId/rotate", auth: "public" },
  { method: "delete", path: "/accounts/projects/:projectId/keys/:keyId", auth: "public" },
  // Native protocol orders (orders/): Jupiter Trigger and Recurring, CoW Protocol limit and TWAP.
  { method: "post", path: "/orders/quote", auth: "public", publishable: true },
  { method: "post", path: "/orders/prepare", auth: "public", publishable: true },
  { method: "post", path: "/orders/submit", auth: "public", publishable: true },
  { method: "get", path: "/orders", auth: "public", publishable: true },
  { method: "get", path: "/orders/:id", auth: "public", publishable: true },
  { method: "post", path: "/orders/:id/cancel", auth: "public", publishable: true },
  // Perps (perps design): venue markets, positions, quotes, unsigned payloads and the relay of user-signed Hyperliquid actions.
  { method: "get", path: "/perps/markets", auth: "public", publishable: true },
  { method: "get", path: "/perps/positions", auth: "public", publishable: true },
  { method: "post", path: "/perps/quote", auth: "public", publishable: true },
  { method: "post", path: "/perps/prepare", auth: "public", publishable: true },
  { method: "post", path: "/perps/submit", auth: "public", publishable: true },
  // Sub-agents (agents/): requests by main agents, owner-wallet or project-key decisions, the one-time claim.
  { method: "get", path: "/agents/tree", auth: "key" },
  { method: "get", path: "/agents/pending", auth: "public" },
  { method: "post", path: "/agents/:id/subagents", auth: "key" },
  { method: "get", path: "/agents/:id/subagents", auth: "key" },
  { method: "post", path: "/agents/:id/revoke", auth: "key" },
  { method: "post", path: "/agents/:id/pause", auth: "key" },
  { method: "get", path: "/agents/requests/:id", auth: "key" },
  { method: "post", path: "/agents/requests/:id/challenge", auth: "public" },
  { method: "post", path: "/agents/requests/:id/approve", auth: "public" },
  { method: "post", path: "/agents/requests/:id/deny", auth: "public" },
  { method: "post", path: "/agents/requests/:id/claim", auth: "key" },
  { method: "get", path: "/errors", auth: "public", publishable: true },
  { method: "post", path: "/mcp", auth: "public" },
  { method: "get", path: "/status/badge", auth: "public", publishable: true },
  { method: "get", path: "/openapi.json", auth: "public", publishable: true },
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

/** PUT /v1/projects/current/logo takes raw PNG or WebP bytes (projects/logo.ts checks them). */
const LOGO_UPLOAD_PATH = /^\/projects\/current\/logo\/?$/iu;

function isLogoUpload(req: Request): boolean {
  return req.method === "PUT" && LOGO_UPLOAD_PATH.test(req.path) && typeof req.is(["image/png", "image/webp"]) === "string";
}

const logoBody = express.raw({ type: ["image/png", "image/webp"], limit: PROJECT_LIMITS.logoBytes });

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
    if (req.is(["application/json", "application/*+json"]) === false && !isLogoUpload(req)) {
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

/**
 * `GET /v1/intents?owner=key_…`: the key whose intents the caller may list:
 * itself, or an agent or publishable key below it (project keys: any such key
 * of their project; agent keys: their descendants). Anything else is 404
 * KEY_NOT_FOUND (never revealing foreign keys).
 */
async function subtreeOwner(req: Request, owner: string): Promise<string> {
  const id = keyIdParam(owner);
  const auth = authOf(req);
  const caller = keyId(req);
  if (id === caller) return id;
  const record = auth.projectId ? await apiKeyStore().findById(id) : null;
  const below = record !== null && record.projectId === auth.projectId && keyKindOf(record) !== "project"
    && (auth.keyKind !== "agent" || (record.lineage ?? []).includes(caller));
  if (!below) throw new HttpError(404, "KEY_NOT_FOUND", "No agent or publishable key with this id in your subtree.");
  return id;
}

/** A dry run is side-effect free, so Idempotency-Key is ignored for it (unless it changes a Kletia-held thread). */
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
    "get /venues": [
      handle(async (req, res) => {
        const filter = venueFilter(queryParam(req, "network"), queryParam(req, "protocol", 40));
        const listing = await listLendingMetrics(filter);
        cachePublicly(res);
        sendJson(res, 200, listing);
      }),
    ],
    "get /openapi.json": [
      handle((_req, res) => {
        cachePublicly(res);
        res.status(200).type("application/json").send(servedOpenApiJson());
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
        const { name, sandbox } = parseKeyRequest(req.body);
        // Without a key: a new project. With a developer key: a sibling in the caller's project.
        sendJson(res, 201, { key: await issueKey(authOf(req), name, { sandbox }) });
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
        const scope = parseUsageScope(req);
        const report = await usageReport({ keyId: keyId(req), tier: auth.tier as KeyTier }, window, tierLimiter);
        // scope=subtree: per-key attribution of the caller's subtree (Rule Book §8.4).
        sendJson(res, 200, scope === "subtree" ? { ...report, subtree: await subtreeUsage(auth, window) } : report);
      }),
    ],
    "post /mcp": [mcpOriginGuard, serveMcp],
    "post /contracts": [
      requireApiKey,
      forbidAgent("registerContracts"),
      idempotent({ route: "POST /contracts" }),
      contractWriteLimiter.middleware(),
      handle(async (req, res) => {
        sendJson(res, 201, { contract: await registerContract(authOf(req), req.body) });
      }),
    ],
    "get /contracts": [
      requireApiKey,
      handle(async (req, res) => {
        const filter = parseContractListFilter({
          network: queryParam(req, "network"),
          vm: queryParam(req, "vm", 8),
          status: queryParam(req, "status", 16),
        });
        sendJson(res, 200, { contracts: await listContracts(authOf(req), filter) });
      }),
    ],
    "get /contracts/inspect": [
      requireApiKey,
      contractTestLimiter.middleware(),
      handle(async (req, res) => {
        const inspection = await inspectContract({
          network: queryParam(req, "network"),
          address: queryParam(req, "address", 64),
          programs: queryParam(req, "programs", 400),
        });
        sendJson(res, 200, { inspection });
      }),
    ],
    "get /contracts/:id": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { contract: await getContract(authOf(req), contractIdParam(req)) });
      }),
    ],
    "patch /contracts/:id": [
      requireApiKey,
      forbidAgent("registerContracts"),
      idempotent({ route: "PATCH /contracts/:id" }),
      contractWriteLimiter.middleware(),
      handle(async (req, res) => {
        sendJson(res, 200, { contract: await updateContract(authOf(req), contractIdParam(req), req.body) });
      }),
    ],
    "delete /contracts/:id": [
      requireApiKey,
      forbidAgent("registerContracts"),
      handle(async (req, res) => {
        await deleteContract(authOf(req), contractIdParam(req));
        res.status(204).end();
      }),
    ],
    "post /contracts/:id/test": [
      requireApiKey,
      contractTestLimiter.middleware(),
      handle(async (req, res) => {
        const id = contractIdParam(req);
        const parsed = validateContractTestRequest(req.body);
        if (!parsed.ok) throw invalidRequest("The test request is invalid.", parsed.issues);
        sendJson(res, 200, { test: await testContract(authOf(req), id, parsed.value) });
      }),
    ],
    "post /contracts/:id/reverify": [
      requireApiKey,
      forbidAgent("registerContracts"),
      idempotent({ route: "POST /contracts/:id/reverify" }),
      contractWriteLimiter.middleware(),
      handle(async (req, res) => {
        sendJson(res, 200, { contract: await reverifyContract(authOf(req), contractIdParam(req)) });
      }),
    ],
    "post /contracts/:id/suspend": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { contract: await operatorSuspend(authOf(req), contractIdParam(req), req.body) });
      }),
    ],
    "post /sessions": [
      requireApiKey,
      forbidAgent("sessions"),
      idempotent({ route: "POST /sessions" }),
      handle(async (req, res) => {
        const auth = authOf(req);
        // Publishable keys start single-use sessions from the project's stored flows only.
        const session = auth.keyKind === "publishable" ? await createFlowSession(auth, req.body) : await createSession(auth, req.body);
        sendJson(res, 201, { session });
      }),
    ],
    "get /projects/current": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { project: await getProject(authOf(req)) });
      }),
    ],
    "patch /projects/current": [
      requireApiKey,
      handle(async (req, res) => {
        const project = await patchProject(authOf(req), req.get("if-match"), req.body);
        res.setHeader("ETag", `"${project.hash}"`);
        sendJson(res, 200, { project });
      }),
    ],
    "post /projects/current/domain/verify": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { project: await verifyProjectDomain(authOf(req)) });
      }),
    ],
    "post /projects/current/publishable-keys": [
      requireApiKey,
      idempotent({ route: "POST /projects/current/publishable-keys", secret: true }),
      handle(async (req, res) => {
        sendJson(res, 201, { key: await createPublishableKey(authOf(req), req.body) });
      }),
    ],
    "put /projects/current/logo": [
      requireApiKey,
      logoBody,
      handle(async (req, res) => {
        sendJson(res, 200, { project: await putProjectLogo(authOf(req), req.body, req.get("content-type")) });
      }),
    ],
    "delete /projects/current/logo": [
      requireApiKey,
      handle(async (req, res) => {
        await deleteProjectLogo(authOf(req));
        res.status(204).end();
      }),
    ],
    "get /projects/:projectId/logo/:file": [
      handle(async (req, res) => {
        await serveProjectLogo(res, pathParam(req, "projectId"), pathParam(req, "file"));
      }),
    ],
    "get /publishable/profile": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { profile: await publishableProfile(authOf(req)) });
      }),
    ],
    "get /sessions/:id": [
      handle(async (req, res) => {
        sendJson(res, 200, { session: await getSession(sessionIdParam(req)) });
      }),
    ],
    "post /sessions/:id/intents": [
      handle(async (req, res) => {
        const { intent, replayed } = await createSessionIntent(sessionIdParam(req), req.body);
        if (replayed) res.setHeader("Idempotent-Replayed", "true");
        sendJson(res, replayed ? 200 : 201, { intent });
      }),
    ],
    "post /quotes": [
      handle(async (req, res) => {
        // The engine accepts both the flat body and the nested SDK body (including from.account / to.recipient).
        sendJson(res, 200, await quoteRoutes(req.body));
      }),
    ],
    "get /portfolio": [
      handle(async (req, res) => {
        // ?accounts=a,b,…: at most 12 CAIP-10 accounts, request order kept, duplicates removed.
        const raw = queryParam(req, "accounts", 4_096);
        const accounts = parsePortfolioAccounts(raw === undefined || raw === "" ? [] : raw.split(","));
        const positions = booleanQuery(req, "positions");
        // One tier unit (the tier limiter) plus one unit per account of the per-IP read budget.
        takePortfolioReads(req, accounts.length);
        sendJson(res, 200, await readAccountPortfolios(accounts, { positions }));
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
        const positions = booleanQuery(req, "positions");
        sendJson(res, 200, await readAccountPortfolio(account.id, { positions }));
      }),
    ],
    "post /intents": [
      // ?clarify=true: secrets in a turn are refused before Idempotency-Key reserves anything.
      screenClarifySecrets,
      // A clarify turn that creates or changes a Kletia-held thread honours Idempotency-Key even as a dry run.
      idempotent({ route: "POST /intents", applies: (req) => !isDryRun(req) || mutatesThread(req) }),
      handle(async (req, res) => {
        // ?clarify=true: one clarify turn (clarify.ts); without it the strict planner below, unchanged.
        if (clarifyRequested(req)) {
          await handleIntentTurn(req, res);
          return;
        }
        const dryRun = booleanQuery(req, "dryRun");
        // ?preview=true: also the plan-stage asset-change preview (never stored in the intent).
        const withPreview = booleanQuery(req, "preview");
        // ?journey=true: also the journey, built on that preview (which it implies); journeyReads=none skips account reads.
        const withJourney = booleanQuery(req, "journey");
        const journeyReads = journeyReadsQuery(req, "journeyReads");
        const owner = authOf(req).keyId;
        // Publishable-owned intents count in the publishable key's own spend windows (integrator 4.8).
        const browserOwned = authOf(req).keyKind === "publishable";
        const { intent, replayed, preview, journey } = await createIntentDetailed(req.body, {
          ...(owner ? { ownerKeyId: owner } : {}),
          ...(browserOwned ? { exposureScope: "owner" as const } : {}),
          dryRun,
          ...(withPreview ? { preview: true } : {}),
          ...(withJourney ? { journey: true, ...(journeyReads ? { journeyReads } : {}) } : {}),
        });
        const body = { intent, ...(preview ? { preview } : {}), ...(withJourney ? { journey: journey ?? null } : {}) };
        if (dryRun) {
          sendJson(res, 200, body);
          return;
        }
        rememberIntentOwner(intent.id, owner);
        // A repeated clientReference returns the intent stored by the earlier request.
        if (replayed) res.setHeader("Idempotent-Replayed", "true");
        sendJson(res, replayed ? 200 : 201, body);
      }),
    ],
    "post /reading-consent": [
      handle(async (req, res) => {
        sendJson(res, 200, await mintReadingConsent(req));
      }),
    ],
    "get /threads": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, await listThreads(req));
      }),
    ],
    "get /threads/:id": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, await getThread(req));
      }),
    ],
    "delete /threads/:id": [
      requireApiKey,
      handle(async (req, res) => {
        await deleteThread(req);
        res.status(204).end();
      }),
    ],
    "get /intents": [
      requireApiKey,
      handle(async (req, res) => {
        const limit = integerQuery(req, "limit", 20, 1, 100);
        const owner = queryParam(req, "owner", 40);
        sendJson(res, 200, { intents: await listIntents(owner === undefined || owner === "" ? keyId(req) : await subtreeOwner(req, owner), limit) });
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
        // Optional { acknowledgedPreview }: a materially worse payload is refused with 409 PREVIEW_CHANGED.
        const options = parsePrepareBody(req.body);
        // ?journey=true: the journey at signing time, on the prepare-stage preview.
        const withJourney = booleanQuery(req, "journey");
        // Link intents: status rules and, at the first prepare, the atomic use reservation.
        const hold = await beforeLinkPrepare(id);
        let prepared: Awaited<ReturnType<typeof prepareStep>>;
        try {
          prepared = await prepareStep(id, stepId, { ...options, ...(withJourney ? { journey: true } : {}) });
        } catch (error) {
          await hold?.failed();
          throw error;
        }
        hold?.succeeded();
        const { intent, payload, preview, previewAck, journey } = prepared;
        if (previewAck) res.setHeader(PREVIEW_ACK_HEADER, previewAck);
        sendJson(res, 200, {
          payload,
          intent,
          ...(preview ? { preview } : {}),
          ...(previewAck ? { previewAck } : {}),
          ...(withJourney ? { journey: journey ?? null } : {}),
        });
      }),
    ],
    "post /intents/:id/steps/:stepId/submit": [
      idempotent({ route: "POST /intents/:id/steps/:stepId/submit" }),
      handle(async (req, res) => {
        const id = intentIdParam(req);
        const stepId = stepIdParam(req);
        const references = parseReferencesBody(req.body);
        const intent = await submitStep(id, stepId, references);
        // A link intent's use is consumed at its first submit.
        await afterLinkSubmit(intent);
        sendJson(res, 200, { intent });
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
    "get /intents/:id/journey": [
      handle(async (req, res) => {
        const id = intentIdParam(req);
        const refresh = booleanQuery(req, "refresh");
        const reads = journeyReadsQuery(req, "reads");
        sendJson(res, 200, { journey: await readJourney(id, { refresh, ...(reads ? { reads } : {}) }) });
      }),
    ],
    "post /intents/:id/stop": [
      idempotent({ route: "POST /intents/:id/stop" }),
      handle(async (req, res) => {
        // Stopping never moves money; 409 INTENT_IN_FLIGHT (Retry-After) while a step is moving or signable.
        sendJson(res, 200, await stopWithJourney(intentIdParam(req)));
      }),
    ],
    "post /intents/:id/preview": [
      handle(async (req, res) => {
        const id = intentIdParam(req);
        const refreshQuotes = parseQuotesQuery(req);
        assertNoPreviewBody(req.body);
        sendJson(res, 200, { preview: await recomputePreview(id, refreshQuotes) });
      }),
    ],
    "get /intents/:id/preview": [
      handle(async (req, res) => {
        sendJson(res, 200, { preview: await latestPreview(intentIdParam(req)) });
      }),
    ],
    ...receiptHandlers(),
    ...policyHandlers(),
    ...linkHandlers(),
    ...accountHandlers(),
    ...dataHandlers(),
    ...automationHandlers(),
    ...orderHandlers(),
    ...perpsHandlers(),
    ...agentHandlers(),
    "post /webhooks": [
      requireApiKey,
      forbidAgent("webhooks"),
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
      forbidAgent("webhooks"),
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
      forbidAgent("webhooks"),
      handle(async (req, res) => {
        const delivery = await sendTestDelivery(keyId(req), webhookIdParam(req), webhookDeliveryTransport(), WEBHOOK_USER_AGENT);
        sendJson(res, 200, { delivery });
      }),
    ],
    "get /events": [
      requireApiKey,
      handle(async (req, res) => {
        await streamKeyEvents(req, res, options.stream);
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
  // Recipient-name resolvers (ENS, Basenames, SNS) register here rather than
  // in a long-running entry point so serverless hosts get them too; idempotent.
  installNameResolvers();
  // The engine resolves integrator contract registrations through this directory (idempotent).
  installContractDirectory();
  // Publishable keys never resolve registrations themselves (flow sessions use the flow's saver).
  installPublishableContractGuard();
  // Previews persist in Postgres when a database is configured; receipt events are buffered for SSE replay.
  installPreviewStore();
  startReceiptEventBuffer();
  // Recent routed events for GET /v1/events resumption (Last-Event-ID).
  startEventStreamBuffer();
  // Boot-time configuration: operator key hashes and the webhook sealing key.
  loadOperatorKeys();
  platformSecretStatus();
  // Receipt keys are checked (and problems logged) at boot, not at the first issuance.
  receiptSignerStatus();
  // Rule Book: the engine evaluates every keyed plan and prepare through this layer's stores (idempotent).
  installPolicyGate();

  const router = express.Router({ caseSensitive: false, strict: false });
  router.use(requestContext);
  router.use(bodyGuards);
  router.use(express.json({ limit: MAX_BODY_BYTES, strict: true, type: ["application/json", "application/*+json"] }));
  router.use(authenticate);
  router.use(usageCounter);
  const tierLimiter = createTierLimiter();
  router.use(tierLimiter);
  router.use(enforceAuthentication);
  // Publishable keys: only the routes marked `publishable`, the per-IP budget and the project's origins.
  router.use(createPublishableGuard(PLATFORM_ROUTES.filter((route) => route.publishable === true)));

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
  /** Receipt issuer tuning (tests, embedders): collector, clock, intervals. */
  readonly receipts?: ReceiptIssuerOptions;
}

let stopBackground: (() => void) | null = null;

/**
 * Starts the settlement poller, the webhook dispatcher, the usage flusher,
 * the contract pin watcher, the receipt issuer and transparency log, the
 * automation evaluator, the data snapshot job, and the
 * hourly pruning of idempotency records, delivery logs, expired sessions,
 * previews and clarify threads, once per process. Returns an idempotent stop function. Call it on long-running
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
    startContractWatcher(),
    startSessionPruner(),
    startThreadPruner(),
    startPreviewPruner(),
    startReceiptIssuer(options.receipts),
    startReceiptLog(),
    startPolicyBackground(),
    startLinkBackground(),
    startAutomationEvaluator(),
    startDataSnapshotJob(),
  ];
  const stop = () => {
    if (stopBackground !== stop) return;
    stopBackground = null;
    for (const stopOne of stoppers) stopOne();
  };
  stopBackground = stop;
  return stop;
}
