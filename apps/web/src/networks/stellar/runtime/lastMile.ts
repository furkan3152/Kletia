import { BACKEND_URL } from "../../../shared/config/runtime";

export type StellarPayoutSourceNetwork =
  | "stellar_testnet"
  | "arc_testnet"
  | "base_sepolia"
  | "arbitrum_sepolia";

export type StellarLastMileQuoteInput = {
  sourceNetwork: StellarPayoutSourceNetwork;
  amountMode: "send_exact" | "receive_exact";
  amount: string;
  destinationCountry: string;
  destinationCurrency: string;
  deliveryMethod: string;
  passkeyAccount?: string;
};

export type StellarLastMileCandidate = {
  provider: string;
  sourceNetwork: StellarPayoutSourceNetwork;
  sourceAsset: "USDC";
  destinationCountry: string;
  destinationCurrency: string;
  deliveryMethod: string;
  sellAmount: string;
  buyAmount: string;
  totalPrice: string;
  price: string;
  fee: { total: string; asset: string } | null;
  quoteType: "indicative";
  observedAt: string;
  sep24: true;
  sep31PartnerAdvertised: boolean;
  sep38: true;
  settlementMode: "sep24_hosted_withdrawal";
  sep12Advertised: boolean;
  sep45Advertised: boolean;
  providerRole: "reference_anchor" | "reviewed_anchor" | "operator_allowlisted";
  realWorldSettlement: boolean | null;
  passkeyIdentityBound: false;
  executionReady: false;
  blockedReason: string;
  mockData: false;
};

export type StellarLastMileQuoteResult = {
  schemaVersion: "kletia_stellar_last_mile_quote_v1";
  candidates: StellarLastMileCandidate[];
  unavailableProviders: Array<{ provider: string; reason: string }>;
  nextRequiredCapability: "sep45_firm_quote_sep24_execution";
  mockData: false;
};

export type StellarLastMileReadiness = {
  enabled: boolean;
  configuredAnchors: number;
  paymentCore: "unavailable" | "discovery_configured";
  identity: "stellar_secp256r1_contract_account";
  settlement: "sep24_hosted_withdrawal";
  pricing: "sep38_live_indicative";
  execution: "blocked_until_sep45_firm_quote_and_sep24_session";
  reason: string;
  mockData: false;
};

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The Stellar Payment Center returned an invalid response.");
  }
  const record = body as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof record.message === "string"
        ? record.message
        : "The live payout service is unavailable.",
    );
  }
  return record;
}

export async function readStellarLastMileReadiness(): Promise<StellarLastMileReadiness> {
  const response = await fetch(`${BACKEND_URL}/api/stellar/payment-center/readiness`, {
    headers: { "X-Kletia-Chain-Ref": "stellar:testnet" },
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The Stellar Payment Center returned an invalid response.");
  }
  const value = body.lastMile;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stellar payout readiness is missing.");
  }
  return value as StellarLastMileReadiness;
}

export async function compareStellarLastMileRoutes(
  input: StellarLastMileQuoteInput,
): Promise<StellarLastMileQuoteResult> {
  const body = await jsonObject(
    await fetch(`${BACKEND_URL}/api/stellar/payment-center/quotes/indicative`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kletia-Chain-Ref": "stellar:testnet",
      },
      body: JSON.stringify(input),
    }),
  );
  if (
    body.schemaVersion !== "kletia_stellar_last_mile_quote_v1" ||
    body.mockData !== false ||
    !Array.isArray(body.candidates) ||
    !Array.isArray(body.unavailableProviders)
  ) {
    throw new Error("The payout route response failed its browser boundary.");
  }
  return body as StellarLastMileQuoteResult;
}
