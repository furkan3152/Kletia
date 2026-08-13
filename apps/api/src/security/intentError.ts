import { IntentParserError } from "../ai/parser.js";
import { ArcAppKitPlanError } from "../networks/arc/appKit.js";
import { ArcPlanError } from "../networks/arc/handlers.js";
import { ArcOfficialPlanError } from "../networks/arc/officialExtensions.js";
import { BaseIntentV2PlanError } from "../networks/base/intent/routerV2.js";
import { BaseX402IntentError } from "../networks/base/intent/x402.js";
import { IntentResponseError } from "../intent/responseEnvelope.js";
import { EntityResolutionError } from "../assets/resolver.js";
import { BaseTokenLaunchError } from "../networks/base/config/launchFactoryV2Environment.js";
import type { NetworkId } from "../config/networks.js";

export interface IntentPublicError {
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
}

interface ControlledErrorDefinition {
  readonly message: string;
  readonly statusCode: number;
}

const CONTROLLED_CODE_ERRORS: Readonly<
  Record<string, ControlledErrorDefinition>
> = {
  ACROSS_CONFIGURATION_REQUIRED: {
    message:
      "Across production API key and Kletia integrator ID are not configured on the server; secure bridge route not prepared.",
    statusCode: 503,
  },
  ACROSS_CONFIGURATION_INVALID: {
    message:
      "Across server configuration is invalid; bridge route not prepared.",
    statusCode: 503,
  },
  ACROSS_FEE_LIMIT_EXCEEDED: {
    message: "Across live relay fee exceeds Kletia security limit.",
    statusCode: 400,
  },
  ACROSS_QUOTE_EXPIRED: {
    message:
      "Across quote expired before signing; a new route must be requested.",
    statusCode: 400,
  },
  AMOUNT_REQUIRED: {
    message: "A positive amount or explicit MAX must be specified for the transaction.",
    statusCode: 400,
  },
  ALLORA_ASSET_UNSUPPORTED: {
    message:
      "Allora observations are only available for supported assets.",
    statusCode: 400,
  },
  ALLORA_UNAVAILABLE: {
    message: "Live prediction service is currently unavailable.",
    statusCode: 503,
  },
  ALLORA_PROVIDER_ERROR: {
    message: "Live prediction data is temporarily unavailable.",
    statusCode: 502,
  },
  BASE_RPC_CHAIN_MISMATCH: {
    message: "Base RPC does not match the expected Base Mainnet chain.",
    statusCode: 503,
  },
  FEE_ROUTER_ROUTE_REQUIRED: {
    message:
      "An explicit execution route is required for the Kletia fee router.",
    statusCode: 400,
  },
  FEE_ROUTER_UNAVAILABLE: {
    message:
      "No route passed the Kletia fee router allowlist and simulation check.",
    statusCode: 400,
  },
  INSUFFICIENT_FUNDS: {
    message: "Insufficient available balance for this transaction. [SHOW_ONRAMP]",
    statusCode: 400,
  },
  INVALID_BASE_LENDING_ROUTE: {
    message: "Base lending route does not match the security contract.",
    statusCode: 500,
  },
  INVALID_PROTOCOL_RETURN_DATA: {
    message: "Protocol simulation did not produce verifiable return data.",
    statusCode: 400,
  },
  INVALID_ROUTE_QUOTE: {
    message: "Route quote does not match the secure ordering contract.",
    statusCode: 500,
  },
  INVALID_SLIPPAGE: {
    message: "Slippage limit is invalid.",
    statusCode: 400,
  },
  INVALID_X402_ASSET: {
    message: "x402 payment asset does not match Base USDC policy.",
    statusCode: 400,
  },
  INVALID_X402_GATEWAY: {
    message: "x402 gateway address is invalid.",
    statusCode: 400,
  },
  INVALID_X402_PRICE: {
    message: "x402 payment price is not within safe limits.",
    statusCode: 400,
  },
  LIQUID_STAKING_TOKEN_REQUIRED: {
    message: "A supported liquid staking asset must be specified.",
    statusCode: 400,
  },
  PROTOCOL_RETURN_CODE_NONZERO: {
    message: "Protocol simulation returned a failure code.",
    statusCode: 400,
  },
  TOKEN_DEPLOYMENT_SIMULATION_FAILED: {
    message: "Token creation failed live Base simulation.",
    statusCode: 400,
  },
  TOKEN_REQUIRED: {
    message: "A supported token must be specified for the transaction.",
    statusCode: 400,
  },
  TOKEN_SECURITY_UNAVAILABLE: {
    message: "Token security verification is currently unavailable.",
    statusCode: 503,
  },
  TOKEN_SECURITY_RISK: {
    message: "Token was securely blocked due to a high-risk signal.",
    statusCode: 400,
  },
  UNVERIFIED_X402_GATEWAY: {
    message: "x402 gateway could not be verified on Base Mainnet.",
    statusCode: 400,
  },
  UNSUPPORTED_ACTION: {
    message: "This action is not supported on the selected network.",
    statusCode: 400,
  },
  WETH_SIMULATION_FAILED: {
    message: "WETH transaction failed live Base simulation.",
    statusCode: 400,
  },
};

const KEE_ERRORS: Readonly<Record<string, ControlledErrorDefinition>> = {
  RATE_LIMIT: {
    message:
      "Temporary RPC request limit reached; please try again shortly.",
    statusCode: 503,
  },
  SLIPPAGE: {
    message:
      "Transaction failed simulation due to slippage or insufficient liquidity.",
    statusCode: 400,
  },
  ALLOWANCE: {
    message: "Insufficient token allowance for the transaction.",
    statusCode: 400,
  },
  WHITELIST: {
    message: "Target protocol failed Kletia security allowlist policy.",
    statusCode: 400,
  },
  INSUFFICIENT_FUNDS: {
    message: "Insufficient available balance for this transaction. [SHOW_ONRAMP]",
    statusCode: 400,
  },
  NETWORK: {
    message: "Base network is temporarily unreachable; please try again.",
    statusCode: 503,
  },
  INVALID_ADDRESS: {
    message: "Invalid wallet or contract address in the transaction.",
    statusCode: 400,
  },
  UNKNOWN_REVERT: {
    message: "Transaction was safely rejected during chain simulation.",
    statusCode: 400,
  },
};

function safeStatusCode(value: unknown, fallback: number): number {
  const statusCode = Number(value);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : fallback;
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value)
    ? value
    : fallback;
}

function controlledMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, 500) : fallback;
}

function isTrustedDomainError(error: unknown): error is Error & {
  readonly code: string;
  readonly statusCode: number;
} {
  return (
    error instanceof IntentParserError ||
    error instanceof ArcAppKitPlanError ||
    error instanceof ArcPlanError ||
    error instanceof ArcOfficialPlanError ||
    error instanceof BaseIntentV2PlanError ||
    error instanceof BaseTokenLaunchError ||
    error instanceof BaseX402IntentError ||
    error instanceof IntentResponseError ||
    error instanceof EntityResolutionError
  );
}

function kletiaEngineError(error: unknown): IntentPublicError | null {
  if (!(error instanceof Error)) return null;
  const match = /^KEE_ERROR\|([A-Z_]+)\|/u.exec(error.message);
  if (!match) return null;
  const definition = KEE_ERRORS[match[1]];
  if (!definition) return null;
  return {
    code: match[1],
    message: definition.message,
    statusCode: definition.statusCode,
  };
}

export function resolveIntentPublicError(
  error: unknown,
  network: NetworkId,
): IntentPublicError {
  const fallback: IntentPublicError =
    network === "arc"
      ? {
          code: "ARC_ENGINE_ERROR",
          message: "Arc transaction plan could not be safely prepared.",
          statusCode: 502,
        }
      : {
          code: "ENGINE_ERROR",
          message: "Base transaction plan could not be safely prepared.",
          statusCode: 502,
        };

  if (isTrustedDomainError(error)) {
    return {
      code: safeCode(error.code, fallback.code),
      message: controlledMessage(error.message, fallback.message),
      statusCode: safeStatusCode(error.statusCode, fallback.statusCode),
    };
  }

  const engineError = kletiaEngineError(error);
  if (engineError) return engineError;

  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  const definition = CONTROLLED_CODE_ERRORS[code];
  if (definition) {
    return {
      code,
      message: definition.message,
      statusCode: definition.statusCode,
    };
  }

  return fallback;
}
