import { getAddress } from "viem";

import { BASE_TOKEN_REGISTRY } from "../protocols.js";

const SECURITY_PROVIDER_TIMEOUT_MS = 8_000;

export type TokenSecurityPolicy = "registered" | "dynamic_execution";

const REGISTERED_TOKEN_ADDRESSES = new Set(
  Object.values(BASE_TOKEN_REGISTRY).map(({ address }) =>
    address.toLowerCase(),
  ),
);

const REGISTERED_EMPTY_TRANSFER_TAX_EXCEPTIONS = new Set([
  BASE_TOKEN_REGISTRY.USDC.address.toLowerCase(),
]);

function isBinarySignal(value: unknown): value is "0" | "1" {
  return value === "0" || value === "1";
}

function securityRisk(message: string): Error {
  return Object.assign(new Error(message), {
    code: "TOKEN_SECURITY_RISK",
    statusCode: 400,
  });
}

function zeroTax(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const normalized = String(value).trim();
  if (!/^(?:0|0\.0+)$/u.test(normalized)) return false;
  return Number(normalized) === 0;
}

export async function checkTokenSecurity(
  tokenAddress: string,
  policy: TokenSecurityPolicy = "registered",
): Promise<boolean> {
  if (typeof tokenAddress !== "string" || !tokenAddress.trim()) {
    throw Object.assign(
      new Error("Token security requires an explicit asset identity."),
      { code: "TOKEN_SECURITY_UNAVAILABLE", statusCode: 503 },
    );
  }
  if (tokenAddress.toLowerCase() === "native") return true;

  try {
    const normalizedToken = getAddress(tokenAddress);
    const response = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${encodeURIComponent(normalizedToken)}`,
      { signal: AbortSignal.timeout(SECURITY_PROVIDER_TIMEOUT_MS) },
    );
    if (!response.ok) {
      throw new Error(
        `Token security provider returned HTTP ${response.status}.`,
      );
    }

    const data = await response.json();
    const security = data?.result?.[normalizedToken.toLowerCase()];
    if (!security || typeof security !== "object") {
      throw new Error("Token security provider returned no verifiable result.");
    }

    const registeredTokenSignalException =
      policy === "registered" &&
      REGISTERED_TOKEN_ADDRESSES.has(normalizedToken.toLowerCase()) &&
      security.is_open_source === "1" &&
      isBinarySignal(security.is_proxy) &&
      zeroTax(security.buy_tax) &&
      zeroTax(security.sell_tax) &&
      (zeroTax(security.transfer_tax) ||
        (REGISTERED_EMPTY_TRANSFER_TAX_EXCEPTIONS.has(
          normalizedToken.toLowerCase(),
        ) &&
          (security.transfer_tax === undefined ||
            security.transfer_tax === "")));

    if (
      (!isBinarySignal(security.is_honeypot) ||
        !isBinarySignal(security.is_blacklisted)) &&
      !registeredTokenSignalException
    ) {
      throw new Error(
        "Token security provider returned incomplete risk signals.",
      );
    }

    const optionalHardSignals = [
      "is_airdrop_scam",
      "cannot_buy",
      "cannot_sell_all",
      "hidden_owner",
      "owner_change_balance",
      "selfdestruct",
      "gas_abuse",
    ] as const;
    const hasHardRisk =
      security.is_honeypot === "1" ||
      security.is_blacklisted === "1" ||
      optionalHardSignals.some((field) => security[field] === "1") ||
      security.fake_token?.value === "1" ||
      security.fake_token?.value === 1;
    if (hasHardRisk) {
      throw securityRisk(
        "Token security provider reported a high-risk signal that halted the operation.",
      );
    }

    if (policy === "dynamic_execution") {
      const requiredZeroSignals = [
        "is_proxy",
        "transfer_pausable",
        "slippage_modifiable",
        "cannot_buy",
        "cannot_sell_all",
        "hidden_owner",
        "owner_change_balance",
      ] as const;
      if (
        security.is_open_source !== "1" ||
        requiredZeroSignals.some((field) => security[field] !== "0") ||
        !zeroTax(security.buy_tax) ||
        !zeroTax(security.sell_tax) ||
        !zeroTax(security.transfer_tax)
      ) {
        throw new Error(
          "Dynamic token behavior, proxy state or transfer taxes are not conclusively compatible.",
        );
      }
    }

    return true;
  } catch (error: any) {
    if (error?.code === "TOKEN_SECURITY_RISK") throw error;
    throw Object.assign(
      new Error("Token security could not be verified; route fail-closed halted."),
      { code: "TOKEN_SECURITY_UNAVAILABLE", statusCode: 503 },
    );
  }
}
