/**
 * Native order routes (/v1/orders): quote, prepare, list, status, cancel and
 * submit. Public like intent prepare and submit: a preparation id is a
 * capability, and nothing moves without the owner's signature, which submit
 * checks against the stored preparation before relaying it.
 *
 * Each call reaches Jupiter or the CoW orderbook, so on top of the tier
 * limiter one address may quote, prepare or cancel 30 times and list 60
 * times a minute.
 */
import type { RequestHandler, Response } from "express";
import {
  cancelNativeOrder,
  listNativeOrders,
  orderStatus,
  parseOrderNetwork,
  parseOwners,
  prepareNativeOrder,
  quoteNativeOrder,
  submitNativeOrder,
} from "../../orders/index.js";
import { handle, pathParam, queryParam } from "../context.js";
import { idempotent } from "../idempotency.js";
import { clientIp, KeyWindowLimiter } from "../limits.js";

export const ORDER_BUILDS_PER_MINUTE_PER_IP = 30;
export const ORDER_LISTS_PER_MINUTE_PER_IP = 60;

const buildsPerIp = new KeyWindowLimiter(ORDER_BUILDS_PER_MINUTE_PER_IP, 60_000, "order quotes and preparations per minute from one address", 20_000, "");
const listsPerIp = new KeyWindowLimiter(ORDER_LISTS_PER_MINUTE_PER_IP, 60_000, "order lists per minute from one address", 20_000, "");

/** Resets the order limiters (tests). */
export function resetOrderLimiters(): void {
  buildsPerIp.reset();
  listsPerIp.reset();
}

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

const build: RequestHandler = (req, _res, next) => {
  buildsPerIp.take(clientIp(req));
  next();
};

export function orderHandlers(): Record<string, RequestHandler[]> {
  return {
    "post /orders/quote": [
      build,
      handle(async (req, res) => {
        sendJson(res, 200, await quoteNativeOrder(req.body));
      }),
    ],
    "post /orders/prepare": [
      build,
      handle(async (req, res) => {
        sendJson(res, 200, await prepareNativeOrder(req.body));
      }),
    ],
    "post /orders/submit": [
      // A repeat of the relayed submission is answered from the preparation itself (replayed: true).
      idempotent({ route: "POST /orders/submit" }),
      handle(async (req, res) => {
        const { order, replayed } = await submitNativeOrder(req.body);
        if (replayed) res.setHeader("Idempotent-Replayed", "true");
        sendJson(res, 200, { order });
      }),
    ],
    "get /orders": [
      (req, _res, next) => {
        listsPerIp.take(clientIp(req));
        next();
      },
      handle(async (req, res) => {
        const owners = parseOwners(queryParam(req, "owner", 600));
        sendJson(res, 200, await listNativeOrders(owners, parseOrderNetwork(queryParam(req, "network", 16))));
      }),
    ],
    "get /orders/:id": [
      handle(async (req, res) => {
        sendJson(res, 200, { order: await orderStatus(pathParam(req, "id"), queryParam(req, "owner", 200)) });
      }),
    ],
    "post /orders/:id/cancel": [
      build,
      handle(async (req, res) => {
        sendJson(res, 200, await cancelNativeOrder(pathParam(req, "id"), req.body));
      }),
    ],
  };
}
