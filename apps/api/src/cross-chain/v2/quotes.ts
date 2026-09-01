import { getAddress } from "viem";
import { arcPublicClient } from "../../shared/config/networks.js";

const CIRCLE_IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";
const ARC_CHAIN_ID = 5_042_002;
const LIVE_ROUTE_QUOTE_TTL_MS = 5 * 60 * 1_000;
const ARC_CCTP_CONTRACTS = [
  getAddress("0x3600000000000000000000000000000000000000"),
  getAddress("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"),
  getAddress("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"),
] as const;

function controlled(code: string, message: string, statusCode = 502): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export async function readCctpStandardFeeBps(
  sourceDomain: 26 | 27,
  destinationDomain: 3 | 27,
): Promise<number> {
  const url = new URL(
    `/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`,
    CIRCLE_IRIS_SANDBOX,
  );
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw controlled("CCTP_FEE_QUOTE_UNAVAILABLE", "Circle CCTP fee quote is unavailable.");
  }
  const payload = (await response.json()) as Array<{
    finalityThreshold?: unknown;
    minimumFee?: unknown;
  }>;
  const standard = Array.isArray(payload)
    ? payload.find((entry) => Number(entry.finalityThreshold) === 2_000)
    : undefined;
  const fee = Number(standard?.minimumFee);
  if (!Number.isFinite(fee) || fee < 0 || fee > 10_000) {
    throw controlled("CCTP_FEE_QUOTE_INVALID", "Circle CCTP fee quote was invalid.");
  }
  return fee;
}

export async function readWorkflowRouteMetrics(
  aaveSupplyApyBps: number,
  scope: "all" | "direct_only" = "all",
) {
  const [arcChainId, arcContractCode, direct] = await Promise.all([
    arcPublicClient.getChainId(),
    Promise.all(ARC_CCTP_CONTRACTS.map((address) => arcPublicClient.getCode({ address }))),
    readCctpStandardFeeBps(26, 3),
  ]);
  if (
    arcChainId !== ARC_CHAIN_ID ||
    arcContractCode.some((code) => !code || code === "0x")
  ) {
    throw controlled(
      "ARC_CCTP_ATTESTATION_FAILED",
      "Arc Testnet CCTP contract identities are unavailable.",
      503,
    );
  }
  const observedAt = new Date().toISOString();
  // Competitive Testnet routing needs enough time for the owner's auction-open
  // transaction, the solver's bond lock, commit and reveal before the exact
  // quote is rebound to the winning route. Five minutes is still bounded; the
  // V3 financial executor independently refreshes Circle/Aave evidence before
  // it prepares any value-moving call.
  const quoteExpiresAt = Date.now() + LIVE_ROUTE_QUOTE_TTL_MS;
  const directEvidence = {
    observedAt,
    quoteExpiresAt,
    cctpStandardFeeBps: direct,
    cctpHops: 1 as const,
    cctpLegs: [
      {
        sourceDomain: 26 as const,
        destinationDomain: 3 as const,
        standardFeeBps: direct,
      },
    ],
    aaveSupplyApyBps,
    sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"] as const,
  };
  // An explicit direct route must not depend on either Stellar-domain fee
  // endpoint. Auto/stellar comparison still fails closed unless both live legs
  // are available, because scoring a partial public corridor would be invented.
  if (scope === "direct_only") {
    return { direct: directEvidence };
  }
  let arcToStellar: number;
  let stellarToArbitrum: number;
  try {
    [arcToStellar, stellarToArbitrum] = await Promise.all([
      readCctpStandardFeeBps(26, 27),
      readCctpStandardFeeBps(27, 3),
    ]);
  } catch (error) {
    return {
      direct: directEvidence,
      stellarUnavailableReason:
        error instanceof Error
          ? error.message
          : "The Stellar CCTP fee corridor is unavailable.",
    };
  }
  const sequentialStellarFeeBps = Number(
    (
      10_000 -
      ((10_000 - arcToStellar) * (10_000 - stellarToArbitrum)) / 10_000
    ).toFixed(6),
  );
  return {
    direct: directEvidence,
    stellar: {
      observedAt,
      quoteExpiresAt,
      // Two CCTP legs charge sequentially against the remaining amount.
      cctpStandardFeeBps: sequentialStellarFeeBps,
      cctpHops: 2 as const,
      cctpLegs: [
        { sourceDomain: 26 as const, destinationDomain: 27 as const, standardFeeBps: arcToStellar },
        { sourceDomain: 27 as const, destinationDomain: 3 as const, standardFeeBps: stellarToArbitrum },
      ],
      aaveSupplyApyBps,
      sources: ["circle_iris_sandbox", "aave_v3_arbitrum_sepolia"] as const,
    },
    stellarUnavailableReason: undefined,
  };
}
