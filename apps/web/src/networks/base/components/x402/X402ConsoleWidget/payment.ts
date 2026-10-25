/**
 * x402 payment types, constants and the checks the console widget runs
 * on payment requirements, authorizations and receipts.
 */
import {
  formatUnits,
  getAddress,
  isAddress,
  parseAbiItem,
  parseUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import type { PaymentRequirements } from "@x402/fetch";
import { BASE_USDC_ADDRESS } from "../../../x402/contracts";
import { NETWORKS } from "../../../../../shared/config/networks";

export interface ContractData {
  address: string;
  owner: string;
  price: string;
  collected: string;
  label: string;
}

export interface VerifiedPaymentEvidence {
  network: typeof BASE_CAIP_NETWORK;
  payer: Address;
  amountAtomic: string;
  amount: string;
  evidence: "base_receipt";
  transaction?: Hex;
  blockNumber?: string;
  finality: "base_inclusion";
}

export interface X402PayResult {
  error?: boolean;
  message?: string;
  status?: number;
  payment?: VerifiedPaymentEvidence;
  data?: unknown;
}

export interface X402Policy {
  maxGatewayPriceAtomic: bigint;
}

export interface ExactTypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const errorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;

  const sanitized = error.message
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(
      /\b(?:authorization|x-payment|payment-signature|signature|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/giu,
      "[redacted-credential]",
    )
    .replace(/\b0x[a-f\d]{96,}\b/giu, "[redacted-payload]")
    .replace(/\b[A-Za-z\d+/_-]{80,}={0,2}\b/gu, "[redacted-payload]")
    .trim();

  return sanitized || fallback;
};

// ── ERC20 ABI for USDC balance ─────────────────────────────────────────
export const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
export const ERC20_TRANSFER_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
] as const;
export const GATEWAY_CREATED_EVENT = parseAbiItem(
  "event GatewayCreated(address indexed gatewayAddress, address indexed owner, address usdc, uint256 initialPrice)",
);

export const BASE_CHAIN_ID = NETWORKS.base.chainId;
export const BASE_CAIP_NETWORK = `eip155:${BASE_CHAIN_ID}` as const;
export const X402_PROTOCOL_VERSION = 2;
const MAX_PAYMENT_TIMEOUT_SECONDS = 300;
const FETCH_TIMEOUT_MS = 15_000;
export const X402_FACTORY_DEPLOYMENT_BLOCK = 48_037_476n;

export const assertReceiptSuccess = (receipt: TransactionReceipt) => {
  if (receipt.status !== "success") {
    throw new Error("Base transaction was included but reverted.");
  }
};

export const parseUsdcPrice = (value: string, label: string, maxAmount?: bigint) => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.trim())) {
    throw new Error(
      `${label} must be a positive USDC amount with at most 6 decimals.`,
    );
  }
  const atomic = parseUnits(value.trim(), NETWORKS.base.tokens.usdc.decimals);
  if (atomic <= 0n) {
    throw new Error(`${label} must be greater than zero.`);
  }
  if (maxAmount !== undefined && atomic > maxAmount) {
    throw new Error(
      `${label} exceeds the server gateway-demo price policy (${formatUnits(maxAmount, NETWORKS.base.tokens.usdc.decimals)} USDC).`,
    );
  }
  return atomic;
};

export const requestWithTimeout = async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await window.fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(
        "x402 endpoint timed out; no unchecked payment was sent.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};

const normalizeRequiredAddress = (value: string, label: string) => {
  if (!isAddress(value)) {
    throw new Error(`x402 ${label} is not a valid EVM address.`);
  }
  return getAddress(value);
};

export const validatePaymentRequirement = (
  requirement: PaymentRequirements,
  expectedGateway: Address,
  expectedAmount: bigint,
) => {
  if (requirement.scheme !== "exact") {
    throw new Error(`Unsupported x402 scheme: ${requirement.scheme}.`);
  }
  if (requirement.network !== BASE_CAIP_NETWORK) {
    throw new Error(`x402 requested ${requirement.network}, not Base Mainnet.`);
  }
  if (
    normalizeRequiredAddress(requirement.asset, "asset") !== BASE_USDC_ADDRESS
  ) {
    throw new Error("x402 requested an asset other than Base Mainnet USDC.");
  }
  if (
    normalizeRequiredAddress(requirement.payTo, "payTo") !== expectedGateway
  ) {
    throw new Error("x402 payTo does not match the active gateway.");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(requirement.amount)) {
    throw new Error("x402 amount is not an unsigned atomic USDC amount.");
  }
  if (BigInt(requirement.amount) !== expectedAmount) {
    throw new Error(
      "x402 amount does not exactly match the gateway on-chain price.",
    );
  }
  if (
    !Number.isInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0 ||
    requirement.maxTimeoutSeconds > MAX_PAYMENT_TIMEOUT_SECONDS
  ) {
    throw new Error("x402 authorization timeout exceeds the client policy.");
  }

  const extra = requirement.extra || {};
  if (
    extra.name !== "USD Coin" ||
    extra.version !== "2" ||
    (extra.assetTransferMethod !== undefined &&
      extra.assetTransferMethod !== "eip3009")
  ) {
    throw new Error("x402 Base USDC authorization domain is not approved.");
  }

  return requirement;
};

export const validateExactAuthorization = (
  params: ExactTypedDataRequest,
  expectedAccount: Address,
  expectedGateway: Address,
  expectedAmount: bigint,
) => {
  const domain = params.domain;
  const message = params.message;
  const transferFields = params.types.TransferWithAuthorization;
  if (
    params.primaryType !== "TransferWithAuthorization" ||
    domain.name !== "USD Coin" ||
    domain.version !== "2" ||
    Number(domain.chainId) !== BASE_CHAIN_ID ||
    normalizeRequiredAddress(
      String(domain.verifyingContract || ""),
      "verifyingContract",
    ) !== BASE_USDC_ADDRESS ||
    !Array.isArray(transferFields) ||
    transferFields
      .map((field) => (isRecord(field) ? `${field.name}:${field.type}` : ""))
      .join(",") !==
      "from:address,to:address,value:uint256,validAfter:uint256,validBefore:uint256,nonce:bytes32" ||
    normalizeRequiredAddress(String(message.from || ""), "from") !==
      expectedAccount ||
    normalizeRequiredAddress(String(message.to || ""), "to") !==
      expectedGateway ||
    BigInt(String(message.value)) !== expectedAmount
  ) {
    throw new Error("x402 requested an unexpected EIP-3009 authorization.");
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = BigInt(String(message.validAfter));
  const validBefore = BigInt(String(message.validBefore));
  const nonce = String(message.nonce || "");
  if (
    validAfter > now ||
    validBefore <= now ||
    validBefore > now + BigInt(MAX_PAYMENT_TIMEOUT_SECONDS + 30) ||
    !/^0x[0-9a-fA-F]{64}$/.test(nonce)
  ) {
    throw new Error("x402 EIP-3009 authorization window or nonce is invalid.");
  }

  return {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: BASE_CHAIN_ID,
      verifyingContract: BASE_USDC_ADDRESS,
    },
    message: {
      from: expectedAccount,
      to: expectedGateway,
      value: expectedAmount,
      validAfter,
      validBefore,
      nonce: nonce as Hex,
    },
  };
};
