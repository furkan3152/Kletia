/**
 * Perps routes under /v1/perps (mounted by router.ts through
 * PLATFORM_ROUTES): markets, positions, quote, prepare and the relay of a
 * Hyperliquid action the user signed. Public and publishable like quotes;
 * with an API key, the key's Rule Book chain decides (agent keys are refused
 * unless their rule book sets perps.enabled). Nothing here signs.
 */
import { effectivePerps, type PerpsPolicyView } from "@kletia/core";
import type { Request, RequestHandler, Response } from "express";
import { DEFAULT_PERPS_POLICY, listPerpsMarkets, preparePerps, quotePerps, readPerpsPositions, submitPerps } from "../../perps/service.js";
import { PlatformError } from "../../errors.js";
import { authOf, handle, queryParam } from "../context.js";
import { readKeyChain } from "../policies/chain.js";

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

/** Perps rights of the caller: the key's Rule Book chain, or the project defaults without a key. */
async function perpsPolicy(req: Request): Promise<PerpsPolicyView> {
  const keyId = authOf(req).keyId;
  if (!keyId) return DEFAULT_PERPS_POLICY;
  const chain = await readKeyChain(keyId);
  if (!chain || !chain.keyActive) throw new PlatformError("PERPS_POLICY_DENIED", "This key (or one of its ancestors) is revoked or expired.", 403);
  return effectivePerps(chain.levels);
}

export function perpsHandlers(): Record<string, RequestHandler[]> {
  return {
    "get /perps/markets": [
      handle(async (_req, res) => {
        sendJson(res, 200, await listPerpsMarkets());
      }),
    ],
    "get /perps/positions": [
      handle(async (req, res) => {
        const account = queryParam(req, "account", 200);
        if (!account) throw new PlatformError("INVALID_REQUEST", "Send ?account=<CAIP-10 id>.", 400, [{ path: "account", message: "Required." }]);
        sendJson(res, 200, await readPerpsPositions(account));
      }),
    ],
    "post /perps/quote": [
      handle(async (req, res) => {
        sendJson(res, 200, await quotePerps(req.body, await perpsPolicy(req)));
      }),
    ],
    "post /perps/prepare": [
      handle(async (req, res) => {
        sendJson(res, 200, { prepared: await preparePerps(req.body, await perpsPolicy(req)) });
      }),
    ],
    "post /perps/submit": [
      handle(async (req, res) => {
        sendJson(res, 200, await submitPerps(req.body, await perpsPolicy(req)));
      }),
    ],
  };
}
