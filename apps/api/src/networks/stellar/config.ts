import * as dotenv from "dotenv";
import { Networks, StrKey } from "@stellar/stellar-sdk";

// Stellar routes can be imported before the shared EVM network module that
// historically loaded dotenv. Load the local development environment at this
// boundary as well so readiness flags never depend on ESM import order.
dotenv.config({ quiet: true });

export const STELLAR_TESTNET = Object.freeze({
  id: "stellar_testnet",
  networkPassphrase: Networks.TESTNET,
  horizonUrl:
    process.env.STELLAR_HORIZON_URL?.trim() ||
    "https://horizon-testnet.stellar.org",
  rpcUrl:
    process.env.STELLAR_RPC_URL?.trim() ||
    "https://soroban-testnet.stellar.org",
  explorerUrl: "https://stellar.expert/explorer/testnet",
  nativeAsset: Object.freeze({ symbol: "XLM", decimals: 7 }),
  usdc: Object.freeze({
    symbol: "USDC",
    decimals: 7,
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  }),
  aquarius: Object.freeze({
    router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
    apiUrl: "https://amm-api-testnet.aqua.network/api/external/v1",
  }),
  cctp: Object.freeze({
    domain: 27,
    tokenMessengerMinter:
      "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter:
      "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    forwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  }),
} as const);

export const STELLAR_MVP_ENABLED =
  process.env.STELLAR_MVP_ENABLED?.trim() === "true";

/**
 * The policy registry is an optional Stellar capability, not a prerequisite
 * for the existing public Stellar route. A configured value is accepted only
 * when it is a valid StrKey contract ID; malformed environment input is never
 * exposed as a runtime target.
 */
export const STELLAR_POLICY_REGISTRY_ENABLED =
  process.env.STELLAR_POLICY_REGISTRY_ENABLED?.trim() === "true";

const policyRegistryContractInput =
  process.env.STELLAR_POLICY_REGISTRY_CONTRACT_ID?.trim() || "";

export const STELLAR_POLICY_REGISTRY_CONTRACT = Object.freeze(
  policyRegistryContractInput.length === 0
    ? {
        configurationStatus: "not_configured" as const,
        contractId: null,
      }
    : StrKey.isValidContract(policyRegistryContractInput)
      ? {
          configurationStatus: "configured" as const,
          contractId: policyRegistryContractInput,
        }
      : {
          configurationStatus: "invalid" as const,
          contractId: null,
        },
);

export function assertStellarAccount(value: unknown): string {
  const account = String(value ?? "").trim();
  if (!StrKey.isValidEd25519PublicKey(account)) {
    throw Object.assign(new Error("A valid Stellar G-account is required."), {
      code: "STELLAR_ACCOUNT_INVALID",
      statusCode: 400,
    });
  }
  return account;
}

export function assertStellarContract(value: unknown): string {
  const contract = String(value ?? "").trim();
  if (!StrKey.isValidContract(contract)) {
    throw Object.assign(new Error("A valid Stellar contract ID is required."), {
      code: "STELLAR_CONTRACT_INVALID",
      statusCode: 400,
    });
  }
  return contract;
}
