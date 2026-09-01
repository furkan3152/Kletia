import express from "express";
import rateLimit from "express-rate-limit";
import {
  ARBITRUM_SEPOLIA,
  ARBITRUM_SEPOLIA_MVP_ENABLED,
  assertArbitrumSepoliaReadiness,
} from "./config.js";
import {
  prepareArbitrumSepoliaSupply,
  prepareArbitrumSepoliaWithdraw,
  readArbitrumSepoliaBorrowCapacity,
  readArbitrumSepoliaPortfolio,
} from "./service.js";

const router = express.Router();
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

function sendError(res: express.Response, error: unknown) {
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(candidate.statusCode) ? Number(candidate.statusCode) : 500;
  return res.status(statusCode).json({
    success: false,
    code: typeof candidate.code === "string" ? candidate.code : "ARBITRUM_SEPOLIA_ERROR",
    message:
      statusCode >= 500
        ? "Arbitrum Sepolia service is temporarily unavailable."
        : typeof candidate.message === "string"
          ? candidate.message
          : "Arbitrum Sepolia request was rejected.",
  });
}

const publicNetworkManifest = Object.freeze({
  id: ARBITRUM_SEPOLIA.id,
  chainId: ARBITRUM_SEPOLIA.chainId,
  explorerUrl: ARBITRUM_SEPOLIA.explorerUrl,
  usdc: ARBITRUM_SEPOLIA.usdc,
  cctp: ARBITRUM_SEPOLIA.cctp,
  aave: ARBITRUM_SEPOLIA.aave,
});

router.get("/config", (_req, res) =>
  res.json({
    success: true,
    enabled: ARBITRUM_SEPOLIA_MVP_ENABLED,
    network: publicNetworkManifest,
  }),
);
router.get("/readiness", async (_req, res) => {
  try {
    await assertArbitrumSepoliaReadiness();
    return res.json({
      success: true,
      status: "ready",
      network: publicNetworkManifest,
      mockData: false,
    });
  } catch (error) {
    return sendError(res, error);
  }
});
router.get("/portfolio/:account", async (req, res) => {
  try {
    return res.json({ success: true, portfolio: await readArbitrumSepoliaPortfolio(req.params.account) });
  } catch (error) {
    return sendError(res, error);
  }
});
router.get("/borrow-capacity/:account", async (req, res) => {
  try {
    return res.json({ success: true, result: await readArbitrumSepoliaBorrowCapacity(req.params.account) });
  } catch (error) {
    return sendError(res, error);
  }
});
router.post("/prepare/supply", async (req, res) => {
  try {
    return res.json({ success: true, route: await prepareArbitrumSepoliaSupply(req.body || {}) });
  } catch (error) {
    return sendError(res, error);
  }
});
router.post("/prepare/withdraw", async (req, res) => {
  try {
    return res.json({
      success: true,
      route: await prepareArbitrumSepoliaWithdraw(req.body || {}),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
