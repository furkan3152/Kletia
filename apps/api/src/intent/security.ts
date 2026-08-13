import { publicClient } from "../config/client.js";
import { decodeAbiParameters, erc20Abi, getAddress, type Hex } from "viem";
import { BASE_TOKEN_REGISTRY } from "../networks/base/protocols.js";

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

export interface XRaySimulationResult {
  success: boolean;
  approvalRequired?: boolean;
  deferredUntilApproval?: boolean;
  error?: unknown;
}

export type SimulationReturnPolicy = "uint256_zero";

export function assertSimulationReturnData(
  policy: SimulationReturnPolicy | undefined,
  data: Hex | undefined,
): void {
  if (policy === undefined) return;
  if (
    policy !== "uint256_zero" ||
    typeof data !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(data)
  ) {
    throw Object.assign(
      new Error(
        "Protocol simulation did not return the required uint256 status word.",
      ),
      {
        code: "INVALID_PROTOCOL_RETURN_DATA",
        statusCode: 400,
      },
    );
  }
  const [returnCode] = decodeAbiParameters([{ type: "uint256" }], data);
  if (returnCode !== 0n) {
    throw Object.assign(
      new Error(
        `Protocol simulation returned non-zero failure code ${returnCode}.`,
      ),
      {
        code: "PROTOCOL_RETURN_CODE_NONZERO",
        statusCode: 400,
      },
    );
  }
}

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
        "Token güvenlik sağlayıcısı işlemi durduran yüksek risk sinyali bildirdi.",
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
  } catch (e: any) {
    if (e?.code === "TOKEN_SECURITY_RISK") throw e;
    throw Object.assign(
      new Error("Token güvenliği doğrulanamadı; rota fail-closed durduruldu."),
      { code: "TOKEN_SECURITY_UNAVAILABLE", statusCode: 503 },
    );
  }
}

export async function xRaySimulate(
  router: `0x${string}`,
  data: `0x${string}`,
  user: string,
  val: string,
  name: string,
  tokensToCheck: { addr?: string; amt?: string }[] = [],
  returnPolicy?: SimulationReturnPolicy,
): Promise<XRaySimulationResult> {
  try {
    const callResult = await publicClient.call({
      account: user as `0x${string}`,
      to: router,
      data,
      value: BigInt(val),
    });
    assertSimulationReturnData(returnPolicy, callResult.data);
    console.log(`[Simulation] ${name}: EVM simulation passed.`);
    return { success: true };
  } catch (e: any) {
    let needsApproval = false;

    try {
      for (const token of tokensToCheck) {
        if (token.addr && token.amt) {
          const safeAddr = token.addr.toLowerCase() as `0x${string}`;
          const required = BigInt(token.amt);
          if (required <= 0n) {
            throw new Error("Approval amount must be positive.");
          }
          const [balance, allowance] = await Promise.all([
            publicClient.readContract({
              address: safeAddr,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [user as `0x${string}`],
            }),
            publicClient.readContract({
              address: safeAddr,
              abi: erc20Abi,
              functionName: "allowance",
              args: [user as `0x${string}`, router],
            }),
          ]);
          if (balance < required) {
            throw new Error(`Insufficient token balance for ${safeAddr}.`);
          }
          if (allowance < required) needsApproval = true;
        }
      }
    } catch (allowanceError: any) {
      console.log(
        `❌ [X-RAY ALLOWANCE CHECK FAILED] ${name}: code=${allowanceError?.code || allowanceError?.name || "ALLOWANCE_CHECK_FAILED"}`,
      );
      return { success: false, error: allowanceError };
    }

    if (needsApproval) {
      console.log(
        `[Simulation] ${name}: final post-allowance simulation is required.`,
      );
      return {
        success: false,
        approvalRequired: true,
        deferredUntilApproval: true,
        error: e,
      };
    }

    console.log(
      `❌ [X-RAY SIMULATION FAILED] ${name}: code=${e?.code || e?.name || "SIMULATION_REVERTED"}`,
    );
    return { success: false, error: e };
  }
}
