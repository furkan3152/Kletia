// Must stay the first import: loads .env and applies public defaults before
// any module reads process.env.
import "../shared/config/environment.js";
import express, { type Express } from "express";
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
import {
  createPlatformRouter,
  platformErrorHandler,
} from "../platform/http/index.js";

/**
 * Express composition root. Order is part of the security contract:
 *   helmet -> CORS (path-switched: /v1 public, everything else allowlisted)
 *   -> /v1 platform API (own 64 KB JSON parser, keys, tier limits, errors)
 *   -> JSON body -> /api/ limiter -> /api routers.
 */

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app: Express = express();

app.set("trust proxy", TRUST_PROXY_HOPS === 0 ? false : TRUST_PROXY_HOPS);

app.use(helmet());
app.use(createCorsMiddleware());
// The public developer API. Mounted before the global JSON parser so its own
// body limit and media-type checks apply; the /api/ limiter below does not
// cover /v1, which brings its own authentication and tier rate limits.
app.use(PLATFORM_API_PREFIX, createPlatformRouter(), platformErrorHandler);

app.use(express.json());

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

export { app };
