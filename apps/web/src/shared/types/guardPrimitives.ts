/**
 * Primitive runtime checks shared by the response guards.
 */
import { getAddress, isAddress, parseUnits } from "viem";

export const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const hasStringFields = (
  value: unknown,
  fields: readonly string[],
): value is Record<string, string> =>
  isObjectRecord(value) &&
  fields.every((field) => typeof value[field] === "string");

export const isWalletAsset = (value: unknown): boolean =>
  hasStringFields(value, ["symbol", "formatted"]);

/** A decimal string, or null when the value could not be read (e.g. a price source outage). */
export const isStringOrNull = (value: unknown): boolean =>
  value === null || typeof value === "string";

const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const POSITIVE_USDC = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
export const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;

export const isCanonicalAddress = (value: unknown): value is string => {
  if (typeof value !== "string" || !isAddress(value)) return false;
  try {
    return getAddress(value) === value;
  } catch {
    return false;
  }
};

export const isBaseUsdcAddress = (value: unknown): value is string =>
  isCanonicalAddress(value) &&
  getAddress(value) === getAddress(BASE_MAINNET_USDC);

export const isPublicHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      Boolean(hostname) &&
      hostname !== "localhost" &&
      !hostname.endsWith(".localhost") &&
      !hostname.endsWith(".local") &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) &&
      !hostname.includes(":")
    );
  } catch {
    return false;
  }
};

export const isPreparedResourceUrl = (
  resource: string,
  requestUrl: unknown,
): requestUrl is string => {
  if (requestUrl === undefined) return true;
  if (!isPublicHttpsUrl(requestUrl)) return false;
  try {
    const catalog = new URL(resource);
    const prepared = new URL(requestUrl);
    return (
      prepared.origin === catalog.origin &&
      prepared.pathname === catalog.pathname &&
      prepared.hash === ""
    );
  } catch {
    return false;
  }
};

export const isExactUsdcPair = (
  amount: unknown,
  amountAtomic: unknown,
): amount is string => {
  if (
    typeof amount !== "string" ||
    typeof amountAtomic !== "string" ||
    !POSITIVE_USDC.test(amount) ||
    !UNSIGNED_INTEGER.test(amountAtomic)
  ) {
    return false;
  }
  try {
    return (
      parseUnits(amount, 6) > 0n &&
      parseUnits(amount, 6).toString() === amountAtomic
    );
  } catch {
    return false;
  }
};

export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const isPositiveAtomicString = (value: unknown): value is string =>
  typeof value === "string" &&
  UNSIGNED_INTEGER.test(value) &&
  BigInt(value) > 0n;
