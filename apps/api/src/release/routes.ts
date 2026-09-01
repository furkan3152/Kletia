import { Router } from "express";

import { readKletiaMvpReadiness } from "./mvpReadiness.js";

const router = Router();

router.get("/mvp-readiness", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const report = await readKletiaMvpReadiness();
  return res.status(report.ready ? 200 : 503).json({
    success: report.ready,
    ...report,
  });
});

export default router;
