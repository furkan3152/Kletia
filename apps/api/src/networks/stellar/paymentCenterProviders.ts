import { STELLAR_TESTNET } from "./config.js";

export type StellarPaymentCenterProviderManifest = {
  schemaVersion: "kletia_stellar_payment_provider_v1";
  domain: string;
  environment: "stellar_testnet";
  role: "reference_anchor" | "reviewed_anchor";
  referenceOnly: boolean;
  realWorldSettlement: boolean;
  networkPassphrase: string;
  stellarAsset: {
    code: "USDC";
    issuer: string;
  };
  expectedCapabilities: readonly ["sep24", "sep38", "sep45"];
  releaseProbe: null | {
    sourceNetwork: "stellar_testnet";
    amountMode: "send_exact" | "receive_exact";
    amount: string;
    destinationCountry: string;
    destinationCurrency: string;
    deliveryMethod: string;
  };
  observedProtocolGaps: readonly string[];
  reviewedAt: string;
  note: string;
};

const TESTANCHOR_MANIFEST: StellarPaymentCenterProviderManifest = Object.freeze({
  schemaVersion: "kletia_stellar_payment_provider_v1",
  domain: "testanchor.stellar.org",
  environment: "stellar_testnet",
  role: "reference_anchor",
  referenceOnly: true,
  realWorldSettlement: false,
  networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  stellarAsset: Object.freeze({
    code: "USDC",
    issuer: STELLAR_TESTNET.usdc.issuer,
  }),
  expectedCapabilities: Object.freeze(["sep24", "sep38", "sep45"] as const),
  releaseProbe: null,
  observedProtocolGaps: Object.freeze([
    "Live check on 2026-08-28: SEP-38 /price rejected context=sep24 and advertised support only for sep6 and sep31.",
  ]),
  reviewedAt: "2026-08-28",
  note: "SDF reference Testnet anchor. Its hosted flow simulates off-chain delivery; it is not evidence of a bank payout.",
});

const PROVIDERS = Object.freeze([TESTANCHOR_MANIFEST]);

export function readStellarPaymentCenterProviderManifests(): readonly StellarPaymentCenterProviderManifest[] {
  return PROVIDERS;
}

export function findStellarPaymentCenterProviderManifest(
  domain: string,
): StellarPaymentCenterProviderManifest | null {
  return PROVIDERS.find((provider) => provider.domain === domain) || null;
}
