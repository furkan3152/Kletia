/**
 * Intent link routes (links design §3.1, §5, §6, §8): CRUD with the
 * publisher key, public visitor quotes and intents, the page shell and the
 * share card (served through the static site's rewrite), Solana Actions,
 * abuse reports and the operator's suspension and blink approval.
 *
 * Limits on top of the tier limiter: 60 creations an hour per key; quotes
 * 20 a minute per IP and 300 per link; visitor intents 10 a minute per IP
 * and 120 per link; reports 5 an hour per IP; blink POSTs 10 a minute per
 * IP; the page and the card 600 a minute per link (and exempt from the
 * per-IP tier limit: through the rewrite every request arrives from the
 * static host's addresses).
 */
import type { Request, RequestHandler, Response } from "express";
import { LINK_LIMITS } from "@kletia/core";
import { requireApiKey } from "../auth.js";
import { authOf, handle, integerQuery, linkIdParam, pathParam, queryParam } from "../context.js";
import { idempotent } from "../idempotency.js";
import { clientIp, KeyWindowLimiter } from "../limits.js";
import { forbidAgent } from "../policies/agentGuard.js";
import { kletiaWebOrigin } from "../webOrigin.js";
import { ACTION_VERSION, ACTIONS_CORS_HEADERS, actionFailure, blinkChain, blinkMetadata, blinkNext, blinkTransaction } from "./blinks.js";
import { cardHost, linkCard, type CardVariant } from "./card.js";
import { renderLinkPage } from "./page.js";
import {
  approveBlink,
  createLink,
  createLinkIntent,
  deleteLink,
  getLinkView,
  linkAccountLimiter,
  linkClock,
  linkCreationLimiter,
  linkStats,
  listLinks,
  loadLink,
  patchLink,
  quoteLink,
  reportLink,
  suspendLink,
} from "./service.js";

/* ------------------------------------------------------------ limiters */

const quotePerIp = new KeyWindowLimiter(LINK_LIMITS.quotePerMinutePerIp, 60_000, "link quotes per minute from one address", 20_000, "");
const quotePerLink = new KeyWindowLimiter(LINK_LIMITS.quotePerMinutePerLink, 60_000, "quotes per minute of one link", 20_000, "");
const intentsPerIp = new KeyWindowLimiter(LINK_LIMITS.intentsPerMinutePerIp, 60_000, "link intents per minute from one address", 20_000, "");
const intentsPerLink = new KeyWindowLimiter(LINK_LIMITS.intentsPerMinutePerLink, 60_000, "intents per minute of one link", 20_000, "");
const reportsPerIp = new KeyWindowLimiter(LINK_LIMITS.reportsPerHourPerIp, 60 * 60_000, "link reports per hour from one address", 20_000, "");
const blinkPostsPerIp = new KeyWindowLimiter(LINK_LIMITS.blinkPostPerMinutePerIp, 60_000, "blink transactions per minute from one address", 20_000, "");
const pagePerLink = new KeyWindowLimiter(LINK_LIMITS.pagePerMinutePerLink, 60_000, "page and card requests per minute of one link", 20_000, "");

/** Resets every link limiter (tests). */
export function resetLinkLimiters(): void {
  for (const limiter of [quotePerIp, quotePerLink, intentsPerIp, intentsPerLink, reportsPerIp, blinkPostsPerIp, pagePerLink, linkCreationLimiter, linkAccountLimiter]) limiter.reset();
}

export { isLinkAssetPath } from "../limits.js";

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

/* -------------------------------------------------------------- actions */

function actionHeaders(res: Response, chain: string): void {
  for (const [name, value] of Object.entries(ACTIONS_CORS_HEADERS)) res.setHeader(name, value);
  res.setHeader("X-Action-Version", ACTION_VERSION);
  res.setHeader("X-Blockchain-Ids", chain);
}

function actionQuery(req: Request): { amount?: string; asset?: string; intent?: string; step?: string; t?: string } {
  const out: Record<string, string> = {};
  for (const name of ["amount", "asset", "intent", "step", "t"]) {
    const value = queryParam(req, name, 64);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Wraps an Actions handler: errors are `ActionError { message }` with the API code's status. */
function actionRoute(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    fn(req, res).catch((error: unknown) => {
      const failure = actionFailure(error);
      actionHeaders(res, "");
      res.removeHeader("X-Blockchain-Ids");
      if (!res.headersSent) res.status(failure.status).json({ message: failure.message });
    });
  };
}

/* --------------------------------------------------------------- table */

export function linkHandlers(): Record<string, RequestHandler[]> {
  return {
    "post /links": [
      requireApiKey,
      forbidAgent("links"),
      idempotent({ route: "POST /links" }),
      handle(async (req, res) => {
        sendJson(res, 201, { link: await createLink(authOf(req), req.body) });
      }),
    ],
    "get /links": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { links: await listLinks(authOf(req), queryParam(req, "status", 16), integerQuery(req, "limit", 50, 1, 200)) });
      }),
    ],
    "get /links/:id": [
      handle(async (req, res) => {
        sendJson(res, 200, { link: await getLinkView(authOf(req), linkIdParam(req)) });
      }),
    ],
    "patch /links/:id": [
      requireApiKey,
      forbidAgent("links"),
      idempotent({ route: "PATCH /links/:id" }),
      handle(async (req, res) => {
        sendJson(res, 200, { link: await patchLink(authOf(req), linkIdParam(req), req.body) });
      }),
    ],
    "delete /links/:id": [
      requireApiKey,
      forbidAgent("links"),
      handle(async (req, res) => {
        await deleteLink(authOf(req), linkIdParam(req));
        res.status(204).end();
      }),
    ],
    "post /links/:id/quote": [
      handle(async (req, res) => {
        const id = linkIdParam(req);
        quotePerIp.take(clientIp(req));
        quotePerLink.take(id);
        const { intent, preview, cached } = await quoteLink(id, req.body);
        if (cached) res.setHeader("Kletia-Quote-Cache", "hit");
        sendJson(res, 200, { intent, preview });
      }),
    ],
    "post /links/:id/intents": [
      handle(async (req, res) => {
        const id = linkIdParam(req);
        intentsPerIp.take(clientIp(req));
        intentsPerLink.take(id);
        const { intent, preview, replayed } = await createLinkIntent(id, req.body);
        if (replayed) res.setHeader("Idempotent-Replayed", "true");
        sendJson(res, replayed ? 200 : 201, { intent, preview });
      }),
    ],
    "get /links/:id/stats": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { stats: await linkStats(authOf(req), linkIdParam(req), queryParam(req, "window", 8)) });
      }),
    ],
    "get /links/:id/card.png": [
      handle(async (req, res) => {
        const id = linkIdParam(req);
        pagePerLink.take(id);
        const variantRaw = queryParam(req, "variant", 8) ?? "wide";
        const variant: CardVariant = variantRaw === "square" ? "square" : "wide";
        const now = linkClock();
        const record = await loadLink(id, now);
        const { png, etag } = linkCard(record, variant, now, cardHost(kletiaWebOrigin()));
        const version = queryParam(req, "v", 12);
        res.setHeader("ETag", etag);
        res.setHeader("Cache-Control", version === String(record.revision) ? "public, max-age=86400, immutable" : "public, max-age=300");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Content-Security-Policy", "default-src 'none'");
        if (req.get("if-none-match") === etag) {
          res.status(304).end();
          return;
        }
        res.status(200).type("image/png").send(png);
      }),
    ],
    "get /links/:id/page": [
      handle(async (req, res) => {
        const id = pathParam(req, "id");
        if (/^lk_[0-9a-f]{24}$/u.test(id)) pagePerLink.take(id);
        const page = await renderLinkPage(id, req.get("user-agent"));
        for (const [name, value] of Object.entries(page.headers)) res.setHeader(name, value);
        res.status(page.status).send(page.html);
      }),
    ],
    "post /links/:id/report": [
      handle(async (req, res) => {
        const id = linkIdParam(req);
        reportsPerIp.take(clientIp(req));
        await reportLink(id, req.body);
        res.status(204).end();
      }),
    ],
    "post /links/:id/suspend": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { link: await suspendLink(authOf(req), linkIdParam(req), req.body) });
      }),
    ],
    "post /links/:id/blink-approval": [
      requireApiKey,
      handle(async (req, res) => {
        sendJson(res, 200, { link: await approveBlink(authOf(req), linkIdParam(req), req.body) });
      }),
    ],
    "get /blinks/:id": [
      actionRoute(async (req, res) => {
        const { status, body, chain } = await blinkMetadata(pathParam(req, "id"));
        actionHeaders(res, chain);
        res.setHeader("Cache-Control", status === 200 ? "public, max-age=60" : "no-store");
        res.status(status).json(body);
      }),
    ],
    "post /blinks/:id": [
      actionRoute(async (req, res) => {
        blinkPostsPerIp.take(clientIp(req));
        const id = pathParam(req, "id");
        const transaction = await blinkTransaction(id, actionQuery(req), req.body);
        actionHeaders(res, await blinkChain(id));
        res.status(200).json(transaction);
      }),
    ],
    "post /blinks/:id/next": [
      actionRoute(async (req, res) => {
        const id = pathParam(req, "id");
        const next = await blinkNext(id, actionQuery(req), req.body);
        actionHeaders(res, await blinkChain(id));
        res.status(200).json(next);
      }),
    ],
  };
}
