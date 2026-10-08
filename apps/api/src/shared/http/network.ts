import type { NextFunction, Request, Response } from "express";
import {
  NETWORKS,
  NetworkValidationError,
  normalizeNetworkId,
  parseChainId,
  resolveNetworkRequest,
  type NetworkConfig,
  type NetworkId,
} from "../config/networks.js";

declare global {
  namespace Express {
    interface Request {
      kletiaNetwork?: NetworkConfig;
    }
  }
}

function values(input: unknown): unknown[] {
  if (input === undefined || input === null) return [];
  return Array.isArray(input) ? input : [input];
}

function requestNetworkInputs(req: Request) {
  return [
    ...values(req.body?.network),
    ...values(req.query?.network),
    ...values(req.headers["x-kletia-network"]),
  ];
}

function requestChainIdInputs(req: Request) {
  return [
    ...values(req.body?.chainId),
    ...values(req.query?.chainId),
    ...values(req.headers["x-kletia-chain-id"]),
  ];
}

export function resolveStrictRequestNetwork(req: Request): NetworkConfig {
  const networkInputs = requestNetworkInputs(req);
  const chainIdInputs = requestChainIdInputs(req);
  if (networkInputs.length === 0) {
    throw new NetworkValidationError(
      "NETWORK_REQUIRED",
      "The network field is required.",
    );
  }
  if (chainIdInputs.length === 0) {
    throw new NetworkValidationError(
      "CHAIN_ID_REQUIRED",
      "The chainId field is required.",
    );
  }

  const networks = networkInputs.map((input) => normalizeNetworkId(input));
  if (networks.some((network) => network === null)) {
    throw new NetworkValidationError(
      "UNSUPPORTED_NETWORK",
      "Unsupported network value.",
    );
  }
  const uniqueNetworks = new Set(networks);
  if (uniqueNetworks.size !== 1) {
    throw new NetworkValidationError(
      "CONFLICTING_NETWORK_CONTEXT",
      "Body, query, and header network values do not match.",
    );
  }

  const chainIds = chainIdInputs.map((input) => parseChainId(input));
  if (chainIds.some((chainId) => chainId === null)) {
    throw new NetworkValidationError(
      "INVALID_CHAIN_ID",
      "chainId must be a safe decimal integer.",
    );
  }
  const uniqueChainIds = new Set(chainIds);
  if (uniqueChainIds.size !== 1) {
    throw new NetworkValidationError(
      "CONFLICTING_CHAIN_CONTEXT",
      "Body, query, and header chainId values do not match.",
    );
  }

  return resolveNetworkRequest(networks[0], chainIds[0], {
    required: true,
  });
}

const BASE_ONLY_MESSAGE = "This service is only available on Base Mainnet.";

export function resolveFixedBaseRequestNetwork(req: Request): NetworkConfig {
  const hasNetwork = requestNetworkInputs(req).length > 0;
  const hasChainId = requestChainIdInputs(req).length > 0;
  if (!hasNetwork && !hasChainId) return NETWORKS.base;

  const config = resolveStrictRequestNetwork(req);
  if (config.id !== "base") {
    throw new NetworkValidationError("BASE_ONLY_ROUTE", BASE_ONLY_MESSAGE);
  }
  return config;
}

function sendNetworkError(res: Response, error: NetworkValidationError) {
  return res.status(error.statusCode).json({
    success: false,
    code: error.code,
    error: error.message,
    message: error.message,
  });
}

export type NetworkGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

/**
 * Builds an Express guard that resolves the request's network context,
 * stores it on `req.kletiaNetwork` and continues. A NetworkValidationError
 * becomes a JSON error response with its status code; any other error is
 * passed to Express.
 */
export function createNetworkGuard(
  resolve: (req: Request) => NetworkConfig,
): NetworkGuard {
  return (req, res, next) => {
    let config: NetworkConfig;
    try {
      config = resolve(req);
    } catch (error) {
      if (error instanceof NetworkValidationError) {
        sendNetworkError(res, error);
        return;
      }
      next(error);
      return;
    }
    req.kletiaNetwork = config;
    next();
  };
}

/**
 * Guard for a route owned by exactly one network: network and chainId are
 * both required, must agree, and must name `id`.
 */
export function requireNetwork(
  id: NetworkId,
  code: string,
  message: string,
): NetworkGuard {
  return createNetworkGuard((req) => {
    const config = resolveStrictRequestNetwork(req);
    if (config.id !== id) throw new NetworkValidationError(code, message);
    return config;
  });
}

/** Any enabled network; network and chainId are both required. */
export const requireIntentNetwork = createNetworkGuard(
  resolveStrictRequestNetwork,
);

/** Base only; an omitted network context defaults to Base Mainnet. */
export const requireFixedBaseNetwork = createNetworkGuard(
  resolveFixedBaseRequestNetwork,
);

export const requireBaseNetwork = requireNetwork(
  "base",
  "BASE_ONLY_ROUTE",
  BASE_ONLY_MESSAGE,
);

export const requireArcNetwork = requireNetwork(
  "arc",
  "ARC_ONLY_ROUTE",
  "This service is only available on Arc Testnet.",
);

export const requireArbitrumNetwork = requireNetwork(
  "arbitrum",
  "ARBITRUM_ONLY_ROUTE",
  "This service is only available on Arbitrum One.",
);

export function readOptionalNetwork(req: Request): NetworkId | null {
  if (
    requestNetworkInputs(req).length === 0 &&
    requestChainIdInputs(req).length === 0
  ) {
    return null;
  }
  return resolveStrictRequestNetwork(req).id;
}
