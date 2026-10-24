/**
 * Prediction-market routes under /v1/predictions (mounted by router.ts
 * through PLATFORM_ROUTES): markets, one market, quote, prepare, the venue
 * sign-in, the relay of a signed order, open orders and cancels, positions
 * and redemption. Public and publishable like perps; with an API key, the
 * key's Rule Book chain decides (agent keys are refused unless their rule
 * book sets predictions.enabled). Nothing here signs. Sessions travel in
 * request bodies only (never URLs), and nothing logs them.
 */
import { effectivePredictions, type PredictionPolicyView } from "@kletia/core";
import type { Request, RequestHandler, Response } from "express";
import {
  cancelPredictionOrder,
  DEFAULT_PREDICTIONS_POLICY,
  getPredictionMarket,
  listPredictionMarkets,
  listPredictionOrders,
  predictionSession,
  preparePrediction,
  prepareRedeem,
  quotePrediction,
  readPredictionPositions,
  submitPrediction,
} from "../../predictions/service.js";
import { PlatformError } from "../../errors.js";
import { authOf, handle, queryParam } from "../context.js";
import { readKeyChain } from "../policies/chain.js";

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

/** Prediction rights of the caller: the key's Rule Book chain, or the project defaults without a key. */
async function predictionsPolicy(req: Request): Promise<PredictionPolicyView> {
  const keyId = authOf(req).keyId;
  if (!keyId) return DEFAULT_PREDICTIONS_POLICY;
  const chain = await readKeyChain(keyId);
  if (!chain || !chain.keyActive) throw new PlatformError("PREDICTION_POLICY_DENIED", "This key (or one of its ancestors) is revoked or expired.", 403);
  return effectivePredictions(chain.levels);
}

function marketIdParam(req: Request): string {
  const id = req.params.id;
  if (typeof id !== "string" || !/^(?:\d{1,20}|0x[0-9a-fA-F]{64})$/u.test(id)) {
    throw new PlatformError("PREDICTION_MARKET_NOT_FOUND", "Use a market id from GET /v1/predictions/markets, or a condition id from positions.", 404);
  }
  return id;
}

export function predictionHandlers(): Record<string, RequestHandler[]> {
  return {
    "get /predictions/markets": [
      handle(async (req, res) => {
        sendJson(res, 200, await listPredictionMarkets({ q: queryParam(req, "q", 200) ?? null, category: queryParam(req, "category", 32) ?? null, sort: queryParam(req, "sort", 16) ?? null }));
      }),
    ],
    "get /predictions/markets/:id": [
      handle(async (req, res) => {
        sendJson(res, 200, await getPredictionMarket(marketIdParam(req)));
      }),
    ],
    "get /predictions/positions": [
      handle(async (req, res) => {
        sendJson(res, 200, await readPredictionPositions({ account: queryParam(req, "account", 200) ?? null, holder: queryParam(req, "holder", 64) ?? null }));
      }),
    ],
    "post /predictions/quote": [
      handle(async (req, res) => {
        sendJson(res, 200, await quotePrediction(req.body, await predictionsPolicy(req)));
      }),
    ],
    "post /predictions/prepare": [
      handle(async (req, res) => {
        sendJson(res, 200, { prepared: await preparePrediction(req.body, await predictionsPolicy(req)) });
      }),
    ],
    "post /predictions/session": [
      handle(async (req, res) => {
        sendJson(res, 200, await predictionSession(req.body, await predictionsPolicy(req)));
      }),
    ],
    "post /predictions/submit": [
      handle(async (req, res) => {
        sendJson(res, 200, await submitPrediction(req.body, await predictionsPolicy(req)));
      }),
    ],
    "post /predictions/orders": [
      handle(async (req, res) => {
        sendJson(res, 200, await listPredictionOrders(req.body, await predictionsPolicy(req)));
      }),
    ],
    "post /predictions/orders/cancel": [
      handle(async (req, res) => {
        sendJson(res, 200, await cancelPredictionOrder(req.body, await predictionsPolicy(req)));
      }),
    ],
    "post /predictions/redeem": [
      handle(async (req, res) => {
        sendJson(res, 200, { prepared: await prepareRedeem(req.body, await predictionsPolicy(req)) });
      }),
    ],
  };
}
