import express from "express";
import rateLimit from "express-rate-limit";
import { advanceWorkflow, resumeWorkflow } from "./workflow.js";

const router = express.Router();

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.use(
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

router.post("/advance", async (req, res) => {
  try {
    const result = await advanceWorkflow({
      workflowToken: req.body?.workflowToken,
      userAddress: req.body?.userAddress,
      txHash: req.body?.txHash,
      authorizationNonce: req.body?.authorizationNonce,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ success: true, ...result });
  } catch (error) {
    const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
    const statusCode = Number.isInteger(candidate.statusCode)
      ? Number(candidate.statusCode)
      : 500;
    const code = typeof candidate.code === "string" ? candidate.code : "WORKFLOW_ERROR";
    const message = statusCode >= 500
      ? "Workflow verification is temporarily unavailable."
      : typeof candidate.message === "string"
        ? candidate.message
        : "Workflow request was rejected.";
    return res.status(statusCode).json({ success: false, code, message });
  }
});

router.post("/resume", async (req, res) => {
  try {
    const result = await resumeWorkflow({
      workflowToken: req.body?.workflowToken,
      userAddress: req.body?.userAddress,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ success: true, ...result });
  } catch (error) {
    const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
    const statusCode = Number.isInteger(candidate.statusCode)
      ? Number(candidate.statusCode)
      : 500;
    const code = typeof candidate.code === "string" ? candidate.code : "WORKFLOW_ERROR";
    const message = statusCode >= 500
      ? "Workflow verification is temporarily unavailable."
      : typeof candidate.message === "string"
        ? candidate.message
        : "Workflow request was rejected.";
    res.setHeader("Cache-Control", "no-store");
    return res.status(statusCode).json({ success: false, code, message });
  }
});

export default router;
