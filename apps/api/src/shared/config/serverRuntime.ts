/**
 * Process-level HTTP settings, validated once when the API is loaded. An
 * invalid value throws at import time, before any route is mounted. PORT is
 * validated before TRUST_PROXY_HOPS so a doubly misconfigured process reports
 * the same first error it always has.
 */

function resolvePort(): number {
  const parsedPort = Number(process.env.PORT || 3001);
  if (
    !Number.isSafeInteger(parsedPort) ||
    parsedPort < 1 ||
    parsedPort > 65_535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return parsedPort;
}

function resolveTrustProxyHops(): number {
  const configured = process.env.TRUST_PROXY_HOPS?.trim();
  const raw = configured || (process.env.NODE_ENV === "production" ? "1" : "0");
  if (!/^\d$/u.test(raw) || Number(raw) > 3) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 3.");
  }
  return Number(raw);
}

export const PORT = resolvePort();
export const TRUST_PROXY_HOPS = resolveTrustProxyHops();
