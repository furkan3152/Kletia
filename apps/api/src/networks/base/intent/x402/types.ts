/**
 * x402 service, challenge and buyer shapes and the x402 error class.
 */
import type { IncomingHttpHeaders } from "node:http";
import { NETWORKS } from "../../../../shared/config/networks.js";
import type { BASE_CAIP_NETWORK } from "./constants.js";

export class BaseX402IntentError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "BaseX402IntentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface BaseX402Service {
  readonly resource: string;
  readonly description: string;
  readonly curated: boolean;
  readonly lastUpdated: string;
  readonly method?: "GET" | "POST";
  readonly requestUrl?: string;
  readonly scheme: "exact";
  readonly network: typeof BASE_CAIP_NETWORK;
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly amount: string;
  readonly maxTimeoutSeconds?: number;
  readonly skillUrl?: string;
}

export interface BaseX402ChallengeEvidence {
  readonly policyVersion: "kletia_x402_challenge_v1";
  readonly status: "verified";
  readonly method: "GET";
  readonly sourceRequestUrl: string;
  readonly requestUrl: string;
  readonly resourceUrl: string;
  readonly network: typeof BASE_CAIP_NETWORK;
  readonly chainId: typeof NETWORKS.base.chainId;
  readonly scheme: "exact";
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly amount: string;
  readonly maxPayment: string;
  readonly maxTimeoutSeconds?: number;
  readonly requiredParams: readonly string[];
  readonly walletInputBinding?: {
    readonly parameter: "address" | "wallet";
    readonly value: string;
    readonly source: "active_user_address";
  };
  readonly observedAt: string;
}

export interface BaseX402BuyerPaymentRequirement {
  readonly scheme: "exact";
  readonly network: typeof BASE_CAIP_NETWORK;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: {
    readonly name: "USD Coin";
    readonly version: "2";
    readonly assetTransferMethod?: "eip3009";
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface PreparedBaseX402BuyerChallenge {
  readonly paymentRequiredHeader: string;
  readonly paymentRequired: {
    readonly x402Version: 2;
    readonly accepts: readonly Readonly<Record<string, unknown>>[];
    readonly resource: {
      readonly url: string;
      readonly [key: string]: unknown;
    };
    readonly extensions?: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
  readonly accepted: BaseX402BuyerPaymentRequirement;
  readonly evidence: BaseX402ChallengeEvidence;
}

export interface BaseX402BuyerUpstreamResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

declare global {
  namespace Express {
    interface Request {
      kletiaBaseX402Challenge?: BaseX402ChallengeEvidence;
    }
  }
}
