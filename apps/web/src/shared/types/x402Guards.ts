/**
 * Runtime guards for Base x402 services, searches, MCP plans and
 * challenge evidence.
 */
import { getAddress, isAddress, parseUnits } from "viem";
import type {
  BaseMcpX402Plan,
  BaseX402ChallengeEvidence,
  BaseX402Search,
  BaseX402Service,
} from "./evidence.ts";
import {
  isBaseUsdcAddress,
  isCanonicalAddress,
  isExactUsdcPair,
  isObjectRecord,
  isPreparedResourceUrl,
  isPublicHttpsUrl,
  POSITIVE_USDC,
  UUID_V4,
} from "./guardPrimitives.ts";

export const isBaseX402Service = (value: unknown): value is BaseX402Service => {
  if (
    !isObjectRecord(value) ||
    !isPublicHttpsUrl(value.resource) ||
    typeof value.description !== "string" ||
    value.description.length > 280 ||
    typeof value.curated !== "boolean" ||
    typeof value.lastUpdated !== "string" ||
    !Number.isFinite(Date.parse(value.lastUpdated)) ||
    (value.method !== undefined &&
      value.method !== "GET" &&
      value.method !== "POST") ||
    !isPreparedResourceUrl(value.resource, value.requestUrl) ||
    value.scheme !== "exact" ||
    value.network !== "eip155:8453" ||
    !isBaseUsdcAddress(value.asset) ||
    !isCanonicalAddress(value.payTo) ||
    !isExactUsdcPair(value.amount, value.amountAtomic)
  ) {
    return false;
  }
  if (
    value.maxTimeoutSeconds !== undefined &&
    (typeof value.maxTimeoutSeconds !== "number" ||
      !Number.isInteger(value.maxTimeoutSeconds) ||
      value.maxTimeoutSeconds <= 0 ||
      value.maxTimeoutSeconds > 300)
  ) {
    return false;
  }
  return value.skillUrl === undefined || isPublicHttpsUrl(value.skillUrl);
};

export const isBaseX402Search = (value: unknown): value is BaseX402Search =>
  isObjectRecord(value) &&
  typeof value.query === "string" &&
  value.query.length >= 2 &&
  value.query.length <= 120 &&
  typeof value.curatedOnly === "boolean" &&
  isExactUsdcPair(value.maxPayment, value.maxPaymentAtomic) &&
  value.network === "eip155:8453" &&
  isBaseUsdcAddress(value.asset) &&
  typeof value.partialResults === "boolean" &&
  (value.method === "hybrid" ||
    value.method === "vector" ||
    value.method === "text");

export const isBaseMcpX402Plan = (value: unknown): value is BaseMcpX402Plan => {
  if (
    !isObjectRecord(value) ||
    value.version !== 1 ||
    value.network !== "base" ||
    value.chainId !== 8_453 ||
    typeof value.requestId !== "string" ||
    !UUID_V4.test(value.requestId) ||
    !isObjectRecord(value.initiate) ||
    value.initiate.tool !== "initiate_x402_request" ||
    !isPublicHttpsUrl(value.initiate.url) ||
    (value.initiate.method !== "GET" && value.initiate.method !== "POST") ||
    typeof value.initiate.maxPayment !== "string" ||
    !POSITIVE_USDC.test(value.initiate.maxPayment) ||
    parseUnits(value.initiate.maxPayment, 6) <= 0n ||
    !isObjectRecord(value.initiate.headers) ||
    !Object.values(value.initiate.headers).every(
      (header) => typeof header === "string" && header.length <= 200,
    ) ||
    !isObjectRecord(value.complete) ||
    value.complete.tool !== "complete_x402_request" ||
    value.complete.requestIdFrom !== "initiate_x402_request.requestId"
  ) {
    return false;
  }
  const headers = value.initiate.headers;
  const headerNames = Object.keys(headers).sort().join(",");
  if (
    headers.Accept !== "application/json" ||
    (value.initiate.method === "GET"
      ? headerNames !== "Accept" || value.initiate.body !== undefined
      : headerNames !== "Accept,Content-Type" ||
        headers["Content-Type"] !== "application/json" ||
        !isObjectRecord(value.initiate.body))
  ) {
    return false;
  }
  return (
    value.initiate.body === undefined ||
    new TextEncoder().encode(JSON.stringify(value.initiate.body)).byteLength <=
      4_096
  );
};

export const isBaseX402ChallengeEvidence = (
  value: unknown,
  plan?: BaseMcpX402Plan,
  expectedUserAddress?: string,
): value is BaseX402ChallengeEvidence => {
  if (
    !isObjectRecord(value) ||
    value.policyVersion !== "kletia_x402_challenge_v1" ||
    value.status !== "verified" ||
    value.method !== "GET" ||
    !isPublicHttpsUrl(value.sourceRequestUrl) ||
    !isPublicHttpsUrl(value.requestUrl) ||
    !isPublicHttpsUrl(value.resourceUrl) ||
    value.network !== "eip155:8453" ||
    value.chainId !== 8_453 ||
    value.scheme !== "exact" ||
    !isBaseUsdcAddress(value.asset) ||
    !isCanonicalAddress(value.payTo) ||
    value.payTo === "0x0000000000000000000000000000000000000000" ||
    !isExactUsdcPair(value.amount, value.amountAtomic) ||
    typeof value.maxPayment !== "string" ||
    !POSITIVE_USDC.test(value.maxPayment) ||
    !Array.isArray(value.requiredParams) ||
    value.requiredParams.length > 20 ||
    !value.requiredParams.every(
      (parameter) =>
        typeof parameter === "string" &&
        /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(parameter),
    ) ||
    new Set(value.requiredParams).size !== value.requiredParams.length ||
    typeof value.observedAt !== "string"
  ) {
    return false;
  }

  try {
    if (
      parseUnits(value.amount, 6) > parseUnits(value.maxPayment, 6) ||
      parseUnits(value.maxPayment, 6) <= 0n
    ) {
      return false;
    }
    const observedAt = Date.parse(value.observedAt);
    const now = Date.now();
    if (
      !Number.isFinite(observedAt) ||
      observedAt > now + 60_000 ||
      observedAt < now - 10 * 60_000
    ) {
      return false;
    }
    const maxTimeoutSeconds = value.maxTimeoutSeconds;
    if (
      maxTimeoutSeconds !== undefined &&
      (typeof maxTimeoutSeconds !== "number" ||
        !Number.isSafeInteger(maxTimeoutSeconds) ||
        maxTimeoutSeconds < 1 ||
        maxTimeoutSeconds > 300)
    ) {
      return false;
    }

    const sourceUrl = new URL(value.sourceRequestUrl);
    const requestUrl = new URL(value.requestUrl);
    const resourceUrl = new URL(value.resourceUrl);
    if (
      sourceUrl.hash ||
      requestUrl.hash ||
      resourceUrl.hash ||
      sourceUrl.origin !== requestUrl.origin ||
      sourceUrl.pathname !== requestUrl.pathname ||
      requestUrl.origin !== resourceUrl.origin ||
      requestUrl.pathname !== resourceUrl.pathname ||
      (resourceUrl.search && resourceUrl.search !== requestUrl.search) ||
      value.requiredParams.some(
        (parameter) => !requestUrl.searchParams.get(parameter)?.trim(),
      )
    ) {
      return false;
    }

    if (value.walletInputBinding !== undefined) {
      if (
        !isObjectRecord(value.walletInputBinding) ||
        (value.walletInputBinding.parameter !== "address" &&
          value.walletInputBinding.parameter !== "wallet") ||
        value.walletInputBinding.source !== "active_user_address" ||
        !isCanonicalAddress(value.walletInputBinding.value) ||
        !expectedUserAddress ||
        !isAddress(expectedUserAddress) ||
        getAddress(value.walletInputBinding.value) !==
          getAddress(expectedUserAddress) ||
        sourceUrl.searchParams.has(value.walletInputBinding.parameter) ||
        !value.requiredParams.includes(value.walletInputBinding.parameter)
      ) {
        return false;
      }
      const expectedRequestUrl = new URL(sourceUrl);
      expectedRequestUrl.searchParams.set(
        value.walletInputBinding.parameter,
        value.walletInputBinding.value,
      );
      if (expectedRequestUrl.toString() !== requestUrl.toString()) {
        return false;
      }
    } else if (sourceUrl.toString() !== requestUrl.toString()) {
      return false;
    }

    if (
      plan &&
      (plan.network !== "base" ||
        plan.chainId !== 8_453 ||
        plan.initiate.method !== "GET" ||
        plan.initiate.url !== value.requestUrl ||
        plan.initiate.maxPayment !== value.maxPayment)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
};
