// Must stay the first import: loads .env and applies public defaults before
// any module reads process.env.
import "../shared/config/environment.js";
import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";

import intentRoutes from "./routes/intent.js";
import workflowRoutes from "../cross-chain/routes.js";
import premiumRoutes from "../networks/base/routes/premium.js";
import alloraRoutes from "../integrations/allora/routes.js";
import paymasterRoutes from "../networks/base/routes/paymaster.js";
import webacyRoutes from "../integrations/webacy/routes.js";
import arcRoutes from "../networks/arc/routes.js";
import baseRoutes from "../networks/base/routes/protocols.js";
import baseMcpRoutes from "../networks/base/routes/mcp.js";
import baseX402BuyerRoutes from "../networks/base/routes/x402Buyer.js";
import arbitrumSepoliaRoutes from "../networks/arbitrum-sepolia/routes.js";
import solanaRoutes from "../networks/solana/routes.js";
import releaseRoutes from "../release/routes.js";
import healthRoutes from "./routes/health.js";
import onrampRoutes from "./routes/onramp.js";
import {
  requireArcNetwork,
  requireBaseNetwork,
  requireFixedBaseNetwork,
} from "../shared/http/network.js";
// Evaluated after every route module, then PORT/TRUST_PROXY_HOPS, then
// CORS_ORIGINS: the same validation order the API has always had.
import "../shared/config/productionEnvironment.js";
import { TRUST_PROXY_HOPS } from "../shared/config/serverRuntime.js";
import {
  PLATFORM_API_PREFIX,
  createCorsMiddleware,
} from "../shared/http/cors.js";
import { apiLimiter, premiumLimiter } from "../shared/http/rateLimits.js";

/**
 * Express composition root. Order is part of the security contract:
 *   helmet -> CORS (path-switched: /v1 public, everything else allowlisted)
 *   -> JSON body -> [/v1 platform API] -> /api/ limiter -> /api routers.
 */

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app: Express = express();

app.set("trust proxy", TRUST_PROXY_HOPS === 0 ? false : TRUST_PROXY_HOPS);

app.use(helmet());
app.use(createCorsMiddleware());
app.use(express.json());

// ── Platform API mount point ────────────────────────────────────────────
// The public developer API lives under PLATFORM_API_PREFIX ("/v1"). Mount it
// here, or call mountPlatformApi(app, router) once at startup:
//
//   app.use(PLATFORM_API_PREFIX, platformRouter);
//
// At this point /v1 already has helmet, the public /v1 CORS policy and JSON
// body parsing. The /api/ limiter below does not apply to /v1; the platform
// router brings its own authentication and rate limits.
// ────────────────────────────────────────────────────────────────────────

app.use("/api/", apiLimiter);
app.use("/api/premium", premiumLimiter, requireFixedBaseNetwork, premiumRoutes);
app.use("/api/allora", requireBaseNetwork, alloraRoutes);
app.use("/api/paymaster", requireFixedBaseNetwork, paymasterRoutes);
app.use("/api/webacy", webacyRoutes);
app.use("/api/arc", requireArcNetwork, arcRoutes);
app.use("/api/workflows", workflowRoutes);
app.use("/api/arbitrum-sepolia", arbitrumSepoliaRoutes);
app.use("/api/solana", solanaRoutes);
app.use("/api/release", releaseRoutes);
app.use("/api/base/x402-buyer", requireBaseNetwork, baseX402BuyerRoutes);
app.use("/api/base", requireBaseNetwork, baseRoutes);
app.use("/api/base-mcp", requireBaseNetwork, baseMcpRoutes);

// /health, /api/health, /api/health/{network}, /api/networks, /api/capabilities
app.use(healthRoutes);
// POST /api/intent, POST /api/intent/revalidate-recipient
app.use(intentRoutes);
// POST /api/onramp-token
app.use(onrampRoutes);

/**
 * Mounts the public platform API under /v1. Safe to call after the app is
 * composed: no /api route and no error handler matches /v1, so appending
 * gives the same precedence as mounting at the marked point above.
 */
export function mountPlatformApi(
  target: Express,
  router: RequestHandler,
): void {
  target.use(PLATFORM_API_PREFIX, router);
}

export { app };
