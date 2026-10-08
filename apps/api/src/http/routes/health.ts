import { Router } from "express";

import { readFeatureCapabilities } from "../../release/capabilities.js";
import {
  NETWORKS,
  getPublicNetworkDescriptor,
  type NetworkId,
} from "../../shared/config/networks.js";
import {
  enabledNetworkIds,
  readNetworkHealth,
} from "../../shared/observability/networkHealth.js";

/**
 * Liveness, readiness and discovery:
 *   GET /api/capabilities      feature switchboard (live / needs_configuration)
 *   GET /api/networks          public network descriptors
 *   GET /health                process liveness only (no RPC)
 *   GET /api/health/{network}  RPC attestation for one network
 *   GET /api/health            RPC attestation for every enabled network
 */
const router = Router();

router.get("/api/capabilities", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=30");
  res.json({ success: true, ...readFeatureCapabilities() });
});

router.get("/api/networks", (_req, res) => {
  res.json({
    success: true,
    defaultNetwork: "base",
    networks: Object.values(NETWORKS).map(getPublicNetworkDescriptor),
  });
});

router.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    status: "alive",
    service: "kletia-omni-engine",
  });
});

router.get(["/api/health/base", "/api/health/arc", "/api/health/arbitrum"], async (req, res) => {
  const network: NetworkId = req.path.endsWith("/arc")
    ? "arc"
    : req.path.endsWith("/arbitrum")
      ? "arbitrum"
      : "base";
  const check = await readNetworkHealth(network);
  res.setHeader("Cache-Control", "no-store");
  return res.status(check.status === "ok" ? 200 : 503).json({
    success: check.status === "ok",
    status: check.status === "ok" ? "ready" : "unavailable",
    service: "kletia-omni-engine",
    check,
  });
});

router.get("/api/health", async (_req, res) => {
  const checks = await Promise.all(
    enabledNetworkIds().map((network) =>
      readNetworkHealth(network),
    ),
  );
  const readyCount = checks.filter((check) => check.status === "ok").length;
  const fullyReady = readyCount === checks.length;
  res.setHeader("Cache-Control", "no-store");
  return res.status(readyCount > 0 ? 200 : 503).json({
    success: readyCount > 0,
    status: fullyReady ? "ready" : readyCount > 0 ? "degraded" : "unavailable",
    service: "kletia-omni-engine",
    checks,
  });
});

export default router;
