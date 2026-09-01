import express from "express";
import rateLimit from "express-rate-limit";
import { readStellarPathQuote, readStellarPortfolio, readStellarReadiness } from "./service.js";
import { STELLAR_TESTNET } from "./config.js";
import {
  readArchivedTransactionEvents,
  readStellarArchiveCoverage,
  readStellarEventArchiveStatus,
} from "./eventArchive.js";
import { readStellarProtocolManifest } from "./protocolManifest.js";
import { readStellarPolicyRegistryManifest } from "./policyRegistryManifest.js";
import { readStellarPolicyRegistryReadiness } from "./policyRegistryReadiness.js";
import { readStellarConfidentialReferenceManifest } from "./confidentialReferenceManifest.js";
import { readStellarPrivatePaymentsReadiness } from "./privatePaymentsManifest.js";
import {
  readStellarMppReadiness,
  stellarMppChargeMiddleware,
} from "./mpp.js";
import { readStellarControlPlaneV2Readiness } from "./controlPlaneV2Readiness.js";
import { readStellarSolverMarketReadiness } from "./solverMarketReadiness.js";
import {
  readStellarPasskeyAccountReadiness,
  relayStellarPasskeyTransaction,
} from "./passkeyAccounts.js";
import { interpretStellarIntent } from "./intentParser.js";
import {
  compareStellarLastMileRoutes,
  readStellarLastMileReadiness,
} from "./lastMile.js";
import { readStellarPaymentCenterProviderManifests } from "./paymentCenterProviders.js";
import {
  assertPaymentCenterSessionHeader,
  completeStellarPaymentCenterSep45,
  createStellarPaymentCenterFirmQuote,
  createStellarPaymentCenterHostedWithdrawal,
  createStellarPaymentCenterSession,
  prepareStellarPaymentCenterSep45Challenge,
  readStellarPaymentCenterSession,
  refreshStellarPaymentCenterWithdrawalStatus,
  submitStellarPaymentCenterWithdrawalTransfer,
} from "./payment-center/service.js";

const router = express.Router();
const passkeyRelayLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "STELLAR_PASSKEY_RELAY_RATE_LIMITED",
    message: "The Testnet passkey relay request limit was reached. Try again shortly.",
  },
});
const lastMileQuoteLimiter = rateLimit({
  windowMs: 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "STELLAR_LAST_MILE_RATE_LIMITED",
    message: "The live payout quote limit was reached. Try again shortly.",
  },
});
const paymentCenterSessionLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "PAYMENT_CENTER_SESSION_RATE_LIMITED",
    message: "The Payment Center session limit was reached. Try again shortly.",
  },
});
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use(rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

const LAB_ROUTE_PREFIXES = [
  "/private-payments",
  "/confidential-reference",
  "/policy-registry",
  "/control-plane-v2",
  "/solver-market",
  "/protocol-manifest",
  "/archive",
  "/mpp",
] as const;
router.use((req, res, next) => {
  const isLabRoute = LAB_ROUTE_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`),
  );
  if (
    isLabRoute &&
    process.env.STELLAR_LABS_ENABLED?.trim().toLowerCase() !== "true"
  ) {
    return res.status(404).json({
      success: false,
      code: "STELLAR_LAB_DISABLED",
      message: "This research surface is not part of the Stellar Payment Center release.",
    });
  }
  return next();
});

function sendError(res: express.Response, error: unknown) {
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(candidate.statusCode) ? Number(candidate.statusCode) : 500;
  const safeOperationalCodes = new Set([
    "SEP45_ANCHOR_INDETERMINATE",
    "SEP38_FIRM_QUOTE_INDETERMINATE",
    "SEP24_SESSION_INDETERMINATE",
  ]);
  const code =
    typeof candidate.code === "string"
      ? candidate.code
      : "STELLAR_SERVICE_ERROR";
  return res.status(statusCode).json({
    success: false,
    code,
    message:
      statusCode >= 500 && !safeOperationalCodes.has(code)
        ? "Stellar service is temporarily unavailable."
        : typeof candidate.message === "string"
          ? candidate.message
          : "Stellar request was rejected.",
  });
}

router.get("/readiness", async (_req, res) => {
  try {
    const [readiness, passkeyAccounts] = await Promise.all([
      readStellarReadiness(),
      readStellarPasskeyAccountReadiness(),
    ]);
    const ready = readiness.status === "ready";
    return res.status(ready ? 200 : 503).json({
      success: ready,
      ...readiness,
      contracts: {
        usdcSac: STELLAR_TESTNET.usdc.sac,
        cctp: STELLAR_TESTNET.cctp,
      },
      capabilities: {
        lastMilePayments: readStellarLastMileReadiness(),
        passkeyAccounts,
        classicStellar: {
          portfolio: "available",
          payment: "available_with_freighter",
          sdex: "available_with_freighter",
        },
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
});

const paymentCenterReadinessHandler: express.RequestHandler = (_req, res) => {
  try {
    const readiness = readStellarLastMileReadiness();
    return res.status(readiness.paymentCore === "discovery_configured" ? 200 : 503).json({
      success: readiness.paymentCore === "discovery_configured",
      lastMile: readiness,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

const paymentCenterProvidersHandler: express.RequestHandler = (_req, res) => {
  return res.json({
    success: true,
    schemaVersion: "kletia_stellar_payment_providers_v1",
    providers: readStellarPaymentCenterProviderManifests(),
  });
};

const paymentCenterQuoteHandler: express.RequestHandler = async (req, res) => {
  try {
    const result = await compareStellarLastMileRoutes(req.body);
    return res.json({ success: result.candidates.length > 0, ...result });
  } catch (error) {
    return sendError(res, error);
  }
};

router.get("/payment-center/readiness", paymentCenterReadinessHandler);
router.get("/payment-center/providers", paymentCenterProvidersHandler);
router.post(
  "/payment-center/quotes/indicative",
  lastMileQuoteLimiter,
  paymentCenterQuoteHandler,
);
router.post(
  "/payment-center/sessions",
  paymentCenterSessionLimiter,
  async (req, res) => {
    try {
      const result = await createStellarPaymentCenterSession(req.body);
      res.setHeader("X-Kletia-Payment-Session", result.sessionToken);
      res.setHeader("Access-Control-Expose-Headers", "X-Kletia-Payment-Session");
      return res.status(201).json({ success: true, session: result.session });
    } catch (error) {
      return sendError(res, error);
    }
  },
);
router.get("/payment-center/sessions/:sessionId", async (req, res) => {
  try {
    const session = await readStellarPaymentCenterSession({
      sessionId: String(req.params.sessionId),
      sessionToken: assertPaymentCenterSessionHeader(
        req.header("X-Kletia-Payment-Session"),
      ),
    });
    return res.json({ success: true, session });
  } catch (error) {
    return sendError(res, error);
  }
});
router.post(
  "/payment-center/sessions/:sessionId/sep45/challenge",
  paymentCenterSessionLimiter,
  async (req, res) => {
    try {
      const result = await prepareStellarPaymentCenterSep45Challenge({
        sessionId: String(req.params.sessionId),
        sessionToken: assertPaymentCenterSessionHeader(
          req.header("X-Kletia-Payment-Session"),
        ),
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendError(res, error);
    }
  },
);
router.post(
  "/payment-center/sessions/:sessionId/sep45/complete",
  paymentCenterSessionLimiter,
  async (req, res) => {
    try {
      const session = await completeStellarPaymentCenterSep45({
        sessionId: String(req.params.sessionId),
        sessionToken: assertPaymentCenterSessionHeader(
          req.header("X-Kletia-Payment-Session"),
        ),
        signedAuthorizationEntries: req.body?.authorizationEntries,
      });
      return res.json({ success: true, session });
    } catch (error) {
      return sendError(res, error);
    }
  },
);
router.post(
  "/payment-center/sessions/:sessionId/quotes/firm",
  paymentCenterSessionLimiter,
  async (req, res) => {
    try {
      const session = await createStellarPaymentCenterFirmQuote({
        sessionId: String(req.params.sessionId),
        sessionToken: assertPaymentCenterSessionHeader(
          req.header("X-Kletia-Payment-Session"),
        ),
      });
      return res.status(201).json({ success: true, session });
    } catch (error) {
      return sendError(res, error);
    }
  },
);
router.post(
  "/payment-center/sessions/:sessionId/sep24/withdrawal",
  paymentCenterSessionLimiter,
  async (req, res) => {
    try {
      const result = await createStellarPaymentCenterHostedWithdrawal({
        sessionId: String(req.params.sessionId),
        sessionToken: assertPaymentCenterSessionHeader(
          req.header("X-Kletia-Payment-Session"),
        ),
      });
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      return sendError(res, error);
    }
  },
);
router.get(
  "/payment-center/sessions/:sessionId/sep24/transaction",
  paymentCenterSessionLimiter,
  async (req, res) => {
    try {
      const session = await refreshStellarPaymentCenterWithdrawalStatus({
        sessionId: String(req.params.sessionId),
        sessionToken: assertPaymentCenterSessionHeader(
          req.header("X-Kletia-Payment-Session"),
        ),
      });
      return res.json({ success: true, session });
    } catch (error) {
      return sendError(res, error);
    }
  },
);
router.post(
  "/payment-center/sessions/:sessionId/sep24/transfer-evidence",
  paymentCenterSessionLimiter,
  async (req, res) => {
    try {
      const session = await submitStellarPaymentCenterWithdrawalTransfer({
        sessionId: String(req.params.sessionId),
        sessionToken: assertPaymentCenterSessionHeader(
          req.header("X-Kletia-Payment-Session"),
        ),
        transactionHash: req.body?.transactionHash,
      });
      return res.json({ success: true, session });
    } catch (error) {
      return sendError(res, error);
    }
  },
);

// One-release compatibility facade. New clients use /payment-center/*; these
// aliases remain read-only and cannot silently acquire execution behavior.
router.use("/last-mile", (_req, res, next) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Thu, 01 Oct 2026 00:00:00 GMT");
  next();
});
router.get("/last-mile/readiness", paymentCenterReadinessHandler);
router.get("/last-mile/providers", paymentCenterProvidersHandler);
router.post(
  "/last-mile/quote",
  lastMileQuoteLimiter,
  paymentCenterQuoteHandler,
);

router.get("/passkey/readiness", async (_req, res) => {
  try {
    const readiness = await readStellarPasskeyAccountReadiness();
    return res.status(readiness.ready ? 200 : 503).json({
      success: readiness.ready,
      passkeyAccounts: readiness,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/passkey/relay", passkeyRelayLimiter, async (req, res) => {
  try {
    const result = await relayStellarPasskeyTransaction(req.body);
    return res.status(result.statusCode).json(result.body);
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/private-payments/readiness", async (_req, res) => {
  try {
    const privatePayments = await readStellarPrivatePaymentsReadiness();
    const ready = privatePayments.readiness.xlmLifecycle === "available";
    return res.status(ready ? 200 : 503).json({
      success: ready,
      privatePayments,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/confidential-reference", (_req, res) => {
  // HTTP 200 means the documentary manifest is available. The manifest's
  // signableRuntimeAllowed field remains the only execution verdict and is
  // deliberately false until Kletia's own proof/runtime gates pass.
  return res.json({
    success: true,
    confidentialToken: readStellarConfidentialReferenceManifest(),
  });
});

router.get("/policy-registry/manifest", (_req, res) => {
  return res.json({
    success: true,
    policyRegistryManifest: readStellarPolicyRegistryManifest(),
  });
});

router.get("/policy-registry/readiness", async (_req, res) => {
  try {
    const readiness = await readStellarPolicyRegistryReadiness();
    return res.status(readiness.ready ? 200 : 503).json({
      success: readiness.ready,
      policyRegistry: readiness,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/control-plane-v2/readiness", async (_req, res) => {
  try {
    const readiness = await readStellarControlPlaneV2Readiness();
    return res.status(readiness.ready ? 200 : 503).json({
      success: readiness.ready,
      controlPlaneV2: readiness,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/solver-market/readiness", async (_req, res) => {
  try {
    const readiness = await readStellarSolverMarketReadiness("testnet");
    return res.status(readiness.ready ? 200 : 503).json({
      success: readiness.ready,
      solverMarket: readiness,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/protocol-manifest", async (_req, res) => {
  try {
    const manifest = await readStellarProtocolManifest();
    return res.status(manifest.executionSurfaceOpen ? 200 : 503).json({
      success: manifest.executionSurfaceOpen,
      protocolManifest: manifest,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/archive/status", async (_req, res) => {
  try {
    return res.json({ success: true, archive: await readStellarEventArchiveStatus() });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/archive/coverage", async (_req, res) => {
  try {
    const readiness = await readStellarReadiness();
    const archiveCoverage = await readStellarArchiveCoverage({
      rpcOldestLedger: readiness.rpcOldestLedger,
      rpcLatestLedger: readiness.rpcLatestLedger,
    });
    return res.json({ success: true, archiveCoverage });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/archive/transactions/:hash", async (req, res) => {
  try {
    return res.json({
      success: true,
      archive: await readArchivedTransactionEvents(req.params.hash),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/portfolio/:account", async (req, res) => {
  try {
    return res.json({ success: true, portfolio: await readStellarPortfolio(req.params.account) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get("/mpp/readiness", async (_req, res) => {
  try {
    const readiness = await readStellarMppReadiness();
    return res.status(readiness.ready ? 200 : 503).json({
      success: readiness.ready,
      mpp: readiness,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get(
  "/mpp/capability-report",
  (req, res, next) => {
    try {
      return stellarMppChargeMiddleware()(req, res, next);
    } catch (error) {
      return sendError(res, error);
    }
  },
  async (_req, res) => {
    const [readiness, protocolManifest] = await Promise.all([
      readStellarReadiness(),
      readStellarProtocolManifest(),
    ]);
    return res.json({
      success: true,
      schemaVersion: "kletia_stellar_mpp_capability_report_v1",
      network: "stellar:testnet",
      observedAt: new Date().toISOString(),
      readiness,
      protocolManifest,
      settlement: "verified_by_official_stellar_mpp_charge",
      mockData: false,
    });
  },
);

router.post("/quote", async (req, res) => {
  try {
    const allowedFields = new Set(["mode", "assetIn", "assetOut", "amount"]);
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => !allowedFields.has(key))
    ) {
      throw Object.assign(
        new Error(
          "Stellar quote requests accept only mode, assetIn, assetOut and amount; account identity is not required.",
        ),
        { code: "STELLAR_QUOTE_FIELDS_INVALID", statusCode: 400 },
      );
    }
    return res.json({ success: true, quote: await readStellarPathQuote(req.body || {}) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post("/intent/interpret", async (req, res) => {
  try {
    const allowedFields = new Set(["prompt", "semanticConsent"]);
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).some((key) => !allowedFields.has(key)) ||
      req.body.semanticConsent !== true
    ) {
      throw Object.assign(
        new Error("Smart Stellar interpretation requires explicit browser-session consent."),
        { code: "STELLAR_SEMANTIC_CONSENT_REQUIRED", statusCode: 409 },
      );
    }
    const intent = await interpretStellarIntent(req.body.prompt);
    return res.json({
      success: true,
      schemaVersion: "kletia_stellar_semantic_intent_response_v1",
      intent,
      semanticModelUsed: true,
      transactionPrepared: false,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
