import { Router } from "express";
import {
  BaseX402IntentError,
  discoverBaseX402Services,
} from "../intent/x402.js";
import {
  BaseX402AttestationRegistryError,
  readBaseX402AttestationRegistryStatus,
  verifyBaseX402AttestationClaim,
} from "../intent/x402AttestationRegistry.js";
import { NETWORKS } from "../../../config/networks.js";

const router = Router();

function requiredBodyString(
  value: unknown,
  field: "query" | "maxPayment",
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BaseX402IntentError(
      `X402_DISCOVERY_${field.toUpperCase()}_INVALID`,
      `${field} boş olmayan tek bir metin değeri olmalıdır.`,
    );
  }
  return value.trim();
}

function bodyCuratedOnly(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  throw new BaseX402IntentError(
    "X402_DISCOVERY_CURATED_ONLY_INVALID",
    "curatedOnly yalnızca JSON boolean olabilir.",
  );
}

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.get("/x402/services", (_req, res) => {
  res.setHeader("Allow", "POST");
  return res.status(405).json({
    success: false,
    code: "X402_DISCOVERY_POST_REQUIRED",
    message:
      "x402 keşif sorguları URL kayıtlarına sızmaması için POST JSON ile gönderilmelidir.",
    network: "base",
    chainId: NETWORKS.base.chainId,
  });
});

router.get("/x402/attestations/status", async (_req, res) => {
  try {
    const data = await readBaseX402AttestationRegistryStatus();
    return res.json({
      success: true,
      network: "base",
      chainId: NETWORKS.base.chainId,
      data,
    });
  } catch (error) {
    const known = error instanceof BaseX402AttestationRegistryError;
    return res.status(known ? error.statusCode : 503).json({
      success: false,
      code: known ? error.code : "X402_ATTESTATION_REGISTRY_UNAVAILABLE",
      message: "Kletia supplemental x402 attestation registry is unavailable.",
      network: "base",
      chainId: NETWORKS.base.chainId,
      data: {
        status: "unavailable",
        available: false,
        semantics: {
          canonicalDiscovery: "Coinbase CDP Bazaar",
          registryRole: "supplemental_claim_attestation",
          claimProofRequired: true,
          affectsPaymentAuthorization: false,
          writeActionsExposed: false,
        },
      },
    });
  }
});

router.get("/x402/attestations/verify", (_req, res) => {
  res.setHeader("Allow", "POST");
  return res.status(405).json({
    success: false,
    code: "X402_ATTESTATION_VERIFY_POST_REQUIRED",
    message: "x402 attestation claim proofs must be submitted as POST JSON.",
    network: "base",
    chainId: NETWORKS.base.chainId,
  });
});

router.post("/x402/attestations/verify", async (req, res) => {
  try {
    const data = await verifyBaseX402AttestationClaim(req.body);
    return res.json({
      success: true,
      network: "base",
      chainId: NETWORKS.base.chainId,
      data,
    });
  } catch (error) {
    const known = error instanceof BaseX402AttestationRegistryError;
    return res.status(known ? error.statusCode : 503).json({
      success: false,
      code: known ? error.code : "X402_ATTESTATION_REGISTRY_UNAVAILABLE",
      message: known
        ? error.message
        : "Kletia supplemental x402 attestation registry is unavailable.",
      network: "base",
      chainId: NETWORKS.base.chainId,
    });
  }
});

router.post("/x402/services", async (req, res) => {
  try {
    if (
      req.body === null ||
      typeof req.body !== "object" ||
      Array.isArray(req.body)
    ) {
      throw new BaseX402IntentError(
        "X402_DISCOVERY_BODY_INVALID",
        "x402 keşif isteği bir JSON nesnesi olmalıdır.",
      );
    }
    const result = await discoverBaseX402Services({
      query: requiredBodyString(req.body.query, "query"),
      maxPayment: requiredBodyString(req.body.maxPayment, "maxPayment"),
      curatedOnly: bodyCuratedOnly(req.body.curatedOnly),
    });
    return res.json({
      success: true,
      network: "base",
      chainId: NETWORKS.base.chainId,
      data: result,
    });
  } catch (error) {
    const known = error instanceof BaseX402IntentError;
    return res.status(known ? error.statusCode : 502).json({
      success: false,
      code: known ? error.code : "X402_BAZAAR_UNAVAILABLE",
      message: known
        ? error.message
        : "CDP Bazaar servis araması şu anda kullanılamıyor.",
      network: "base",
      chainId: NETWORKS.base.chainId,
    });
  }
});

export default router;
