/**
 * Validation of an x402 challenge against its resource.
 */
import { formatUnits, getAddress, isAddress } from "viem";
import { TOKENS } from "../../contracts.js";
import { NETWORKS } from "../../../../shared/config/networks.js";
import {
  BASE_CAIP_NETWORK,
  USDC_DECIMALS,
  x402ChallengeSchema,
} from "./constants.js";
import {
  type BaseX402ChallengeEvidence,
  BaseX402IntentError,
} from "./types.js";
import {
  decodePaymentRequiredHeader,
  paymentCap,
  publicHttpsUrl,
  requiredQueryParams,
  sameX402Resource,
} from "./preflight.js";

export function validateBaseX402Challenge(input: {
  readonly requestUrl: unknown;
  readonly maxPayment: unknown;
  readonly statusCode: number;
  readonly paymentRequired: unknown;
  readonly body?: string;
  readonly observedAt?: string;
}): BaseX402ChallengeEvidence {
  const requestUrl = publicHttpsUrl(input.requestUrl);
  const cap = paymentCap(input.maxPayment);
  if (input.statusCode !== 402) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_REQUIRED",
      "x402 resource did not return a verifiable HTTP 402 response without payment.",
      502,
    );
  }
  const challenge = x402ChallengeSchema.safeParse(
    decodePaymentRequiredHeader(input.paymentRequired),
  );
  if (!challenge.success) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 PAYMENT-REQUIRED v2 envelope is invalid.",
      502,
    );
  }
  let resourceUrl: URL;
  try {
    resourceUrl = publicHttpsUrl(challenge.data.resource.url);
  } catch {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_RESOURCE_MISMATCH",
      "Resource URL in x402 payment envelope does not match the active request.",
      502,
    );
  }
  if (!sameX402Resource(requestUrl, resourceUrl)) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_RESOURCE_MISMATCH",
      "Resource URL in x402 payment envelope does not match the active request.",
      502,
    );
  }

  const requirement = challenge.data.accepts.find((candidate) => {
    if (
      candidate.scheme !== "exact" ||
      candidate.network !== BASE_CAIP_NETWORK ||
      !/^(?:0|[1-9]\d*)$/u.test(candidate.amount) ||
      !isAddress(candidate.asset) ||
      !isAddress(candidate.payTo)
    ) {
      return false;
    }
    try {
      return (
        getAddress(candidate.asset) === getAddress(TOKENS.USDC) &&
        getAddress(candidate.payTo) !==
          "0x0000000000000000000000000000000000000000" &&
        BigInt(candidate.amount) > 0n &&
        BigInt(candidate.amount) <= cap.atomic &&
        (candidate.maxTimeoutSeconds === undefined ||
          candidate.maxTimeoutSeconds <= 300)
      );
    } catch {
      return false;
    }
  });
  if (!requirement) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_POLICY_MISMATCH",
      "x402 payment requirement does not match Base Mainnet, USDC, exact scheme, or user cap.",
    );
  }
  const requiredParams = requiredQueryParams(input.body || "");
  const missingParams = requiredParams.filter(
    (key) => !requestUrl.searchParams.get(key)?.trim(),
  );
  if (missingParams.length > 0) {
    throw new BaseX402IntentError(
      "X402_REQUIRED_INPUT_MISSING",
      `The x402 call requires the following mandatory URL parameters before payment: ${missingParams.join(", ")}. Resend the intent specifying the parameters explicitly.`,
    );
  }
  const observedAt = input.observedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new BaseX402IntentError(
      "X402_CHALLENGE_INVALID",
      "x402 payment preflight time is invalid.",
      502,
    );
  }
  return {
    policyVersion: "kletia_x402_challenge_v1",
    status: "verified",
    method: "GET",
    sourceRequestUrl: requestUrl.toString(),
    requestUrl: requestUrl.toString(),
    resourceUrl: resourceUrl.toString(),
    network: BASE_CAIP_NETWORK,
    chainId: NETWORKS.base.chainId,
    scheme: "exact",
    asset: getAddress(requirement.asset),
    payTo: getAddress(requirement.payTo),
    amountAtomic: requirement.amount,
    amount: formatUnits(BigInt(requirement.amount), USDC_DECIMALS),
    maxPayment: cap.decimal,
    ...(requirement.maxTimeoutSeconds === undefined
      ? {}
      : { maxTimeoutSeconds: requirement.maxTimeoutSeconds }),
    requiredParams,
    observedAt: new Date(observedAt).toISOString(),
  };
}

export function safeDescription(value: unknown): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 280);
  return normalized || "CDP Bazaar x402 resource";
}

export function sanitizeSkillUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return publicHttpsUrl(value).toString();
  } catch {
    return undefined;
  }
}
