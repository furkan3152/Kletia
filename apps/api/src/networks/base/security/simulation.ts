import { decodeAbiParameters, erc20Abi, type Hex } from "viem";

import { basePublicClient } from "../../../shared/config/client.js";

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
    const callResult = await basePublicClient.call({
      account: user as `0x${string}`,
      to: router,
      data,
      value: BigInt(val),
    });
    assertSimulationReturnData(returnPolicy, callResult.data);
    console.log(`[Simulation] ${name}: EVM simulation passed.`);
    return { success: true };
  } catch (error: any) {
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
            basePublicClient.readContract({
              address: safeAddr,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [user as `0x${string}`],
            }),
            basePublicClient.readContract({
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
        error,
      };
    }

    console.log(
      `❌ [X-RAY SIMULATION FAILED] ${name}: code=${error?.code || error?.name || "SIMULATION_REVERTED"}`,
    );
    return { success: false, error };
  }
}
