import express from "express";

export const BASE_AGENT_UNAVAILABLE = Object.freeze({
  success: false,
  status: "unavailable",
  code: "AGENT_OWNERSHIP_AUTH_REQUIRED",
  message:
    "Base Agent is unavailable until signed wallet ownership and per-action authorization are implemented.",
  decision: "blocked",
  network: "base",
  chainId: 8453,
  retryable: false,
});

const router = express.Router();

router.use((_req, res) => {
  res.status(503).json(BASE_AGENT_UNAVAILABLE);
});

export const agentRoutes = router;
