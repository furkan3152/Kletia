import { randomUUID } from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import jwt, { type JwtHeader } from "jsonwebtoken";
import { getAddress } from "viem";

import { NETWORKS } from "../../shared/config/networks.js";
import { requireFixedBaseNetwork } from "../../shared/http/network.js";

/**
 * POST /api/onramp-token: issues a Coinbase Onramp session token for one
 * Base destination wallet. Server-side CDP credentials sign a short-lived
 * ES256 JWT; the provider response is size-bounded and never echoed.
 */

const onrampLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "ONRAMP_RATE_LIMITED",
    message: "Onramp request limit exceeded. Please try again later.",
  },
});

const MAX_ONRAMP_RESPONSE_BYTES = 64 * 1024;
const MAX_ONRAMP_TOKEN_LENGTH = 16 * 1024;

const router = Router();

router.post(
  "/api/onramp-token",
  onrampLimiter,
  requireFixedBaseNetwork,
  async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    try {
      const allowedBodyFields = new Set(["address", "network", "chainId"]);
      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => !allowedBodyFields.has(key))
      ) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ONRAMP_REQUEST",
          message: "Onramp request contains unsupported fields.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }
      if (typeof req.body.address !== "string") {
        return res.status(400).json({
          success: false,
          code: "INVALID_ADDRESS",
          message: "The address field is required.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }
      const destinationAddress = getAddress(req.body.address);

      const keyName = process.env.CDP_API_KEY_NAME?.trim();
      const keySecret = process.env.CDP_API_KEY_PRIVATE_KEY?.replace(
        /\\n/g,
        "\n",
      );
      if (!keyName || !keySecret) {
        return res.status(503).json({
          success: false,
          code: "ONRAMP_NOT_CONFIGURED",
          message: "Coinbase onramp server credentials are not configured.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }

      const requestMethod = "POST";
      const requestPath = "/onramp/v1/token";
      const jwtHeader: JwtHeader & { nonce: string } = {
        alg: "ES256",
        kid: keyName,
        nonce: randomUUID(),
      };
      const authorizationToken = jwt.sign(
        {
          iss: "cdp",
          nbf: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 120,
          sub: keyName,
          uri: `${requestMethod} api.developer.coinbase.com${requestPath}`,
        },
        keySecret,
        {
          algorithm: "ES256",
          keyid: keyName,
          header: jwtHeader,
        },
      );

      const response = await fetch(
        `https://api.developer.coinbase.com${requestPath}`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${authorizationToken}`,
          },
          body: JSON.stringify({
            destination_wallets: [
              { address: destinationAddress, blockchains: ["base"] },
            ],
          }),
          signal: AbortSignal.timeout(12_000),
        },
      );

      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_ONRAMP_RESPONSE_BYTES
      ) {
        throw new Error("onramp_response_too_large");
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_ONRAMP_RESPONSE_BYTES) {
        throw new Error("onramp_response_too_large");
      }
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("onramp_invalid_json");
      }

      if (!response.ok) {
        console.error("[CDP ONRAMP] Provider rejected token request:", {
          status: response.status,
        });
        return res.status(502).json({
          success: false,
          code: "ONRAMP_PROVIDER_REJECTED",
          message: "Failed to create Coinbase onramp session.",
          network: "base",
          chainId: NETWORKS.base.chainId,
        });
      }
      const onrampToken =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>).token
          : undefined;
      if (
        typeof onrampToken !== "string" ||
        onrampToken.length < 1 ||
        onrampToken.length > MAX_ONRAMP_TOKEN_LENGTH
      ) {
        throw new Error("onramp_invalid_token");
      }

      return res.json({
        success: true,
        status: "success",
        token: onrampToken,
        network: "base",
        chainId: NETWORKS.base.chainId,
      });
    } catch (error: any) {
      console.error("[CDP ONRAMP] Token request failed:", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      const invalidAddress = error?.name === "InvalidAddressError";
      const timedOut = error?.name === "TimeoutError";
      const statusCode = invalidAddress ? 400 : timedOut ? 504 : 502;
      const code = invalidAddress
        ? "INVALID_ADDRESS"
        : timedOut
          ? "ONRAMP_PROVIDER_TIMEOUT"
          : "ONRAMP_TOKEN_ERROR";
      const message = invalidAddress
        ? "Invalid wallet address."
        : timedOut
          ? "Coinbase onramp timed out."
          : "Coinbase onramp session could not be securely verified.";
      return res.status(statusCode).json({
        success: false,
        code,
        message,
        network: "base",
        chainId: NETWORKS.base.chainId,
      });
    }
  },
);

export default router;
