import {
  decodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  maxUint256,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { TOKENS } from "../networks/base/contracts.js";
import { ACROSS_SPOKE_POOL_PERIPHERY } from "../shared/config/networks.js";

const ACROSS_SWAP_APPROVAL_URL = "https://app.across.to/api/swap/approval";
const QUOTE_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_API_QUOTE_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const CLIENT_QUOTE_TTL_MS = 2 * 60 * 1_000;

export const BASE_ACROSS_SPOKE_POOL = getAddress(
  "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
);
export const ARBITRUM_NATIVE_ETH = zeroAddress;

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", `Across ${label} is invalid.`, 502);
  }
  return value as Record<string, unknown>;
}

function unsigned(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", `Across ${label} is invalid.`, 502);
  }
  return BigInt(value);
}

function address(value: unknown, label: string): Address {
  try {
    return getAddress(String(value));
  } catch {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", `Across ${label} is invalid.`, 502);
  }
}

function hex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", `Across ${label} is invalid.`, 502);
  }
  return value as Hex;
}

function credentials() {
  const apiKey = process.env.ACROSS_API_KEY?.trim();
  const integratorId = process.env.ACROSS_INTEGRATOR_ID?.trim();
  if (process.env.NODE_ENV === "production" && (!apiKey || !integratorId)) {
    throw controlled(
      "ACROSS_CONFIGURATION_REQUIRED",
      "ACROSS_API_KEY and ACROSS_INTEGRATOR_ID are required for production gas acquisition.",
      503,
    );
  }
  if (integratorId && !/^0x[0-9a-f]{4}$/iu.test(integratorId)) {
    throw controlled(
      "ACROSS_CONFIGURATION_INVALID",
      "ACROSS_INTEGRATOR_ID must be a 2-byte 0x-prefixed value.",
      503,
    );
  }
  return { apiKey, integratorId };
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", "Across response exceeded the safe limit.", 502);
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", "Across response exceeded the safe limit.", 502);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", "Across response was not valid JSON.", 502);
  }
}

export interface AcrossGasAcquisitionRoute {
  readonly name: "Across Exact-Output Gas Route";
  readonly protocolId: "across_swap_api";
  readonly router: Address;
  readonly calldata: Hex;
  readonly value: "0";
  readonly quoteExpiresAt: number;
  readonly inputAmountAtomic: string;
  readonly maxInputAmountAtomic: string;
  readonly outputAmountAtomic: string;
  readonly inputTokenAddress: Address;
  readonly outputTokenAddress: Address;
  readonly destinationChainId: 42161;
  readonly expectedOutput: string;
  readonly routePath: "Base USDC -> Arbitrum ETH";
  readonly approval: {
    readonly token: Address;
    readonly spender: Address;
    readonly amount: string;
    readonly calldata: Hex;
  };
}

/**
 * Builds an exact-output Base USDC -> Arbitrum native ETH quote. No quote is
 * cached and no transaction is submitted. Every executable field is checked
 * against Kletia's pinned official Across and token manifest.
 */
export async function getAcrossGasAcquisitionRoute(input: {
  readonly outputEth: string;
  readonly maxUsdc: string;
  readonly userAddress: Address;
}): Promise<AcrossGasAcquisitionRoute> {
  let outputAtomic: bigint;
  let maxInputAtomic: bigint;
  try {
    outputAtomic = parseUnits(input.outputEth, 18);
    maxInputAtomic = parseUnits(input.maxUsdc, 6);
  } catch {
    throw controlled(
      "WORKFLOW_GAS_AMOUNT_INVALID",
      "Gas output and USDC cap must be positive decimal amounts.",
    );
  }
  if (outputAtomic <= 0n || maxInputAtomic <= 0n) {
    throw controlled(
      "WORKFLOW_GAS_AMOUNT_INVALID",
      "Gas output and USDC cap must be positive decimal amounts.",
    );
  }

  const { apiKey, integratorId } = credentials();
  const url = new URL(ACROSS_SWAP_APPROVAL_URL);
  url.searchParams.set("tradeType", "exactOutput");
  url.searchParams.set("amount", outputAtomic.toString());
  url.searchParams.set("inputToken", TOKENS.USDC);
  url.searchParams.set("outputToken", ARBITRUM_NATIVE_ETH);
  url.searchParams.set("originChainId", "8453");
  url.searchParams.set("destinationChainId", "42161");
  url.searchParams.set("depositor", input.userAddress);
  url.searchParams.set("recipient", input.userAddress);
  url.searchParams.set("refundAddress", input.userAddress);
  url.searchParams.set("refundOnOrigin", "true");
  url.searchParams.set("slippage", "auto");
  url.searchParams.set("strictTradeType", "true");
  url.searchParams.set("skipOriginTxEstimation", "false");
  if (integratorId) url.searchParams.set("integratorId", integratorId);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
  });
  const raw = await readJson(response);
  if (!response.ok) {
    throw controlled(
      "ACROSS_GAS_QUOTE_UNAVAILABLE",
      `Across gas quote was rejected (HTTP ${response.status}).`,
      response.status >= 500 ? 502 : 409,
    );
  }
  const quote = object(raw, "quote");
  if (quote.crossSwapType !== "anyToBridgeable" || quote.amountType !== "exactOutput") {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", "Across returned the wrong route type.", 502);
  }
  const inputToken = object(quote.inputToken, "input token");
  const outputToken = object(quote.outputToken, "output token");
  if (
    Number(inputToken.chainId) !== 8453 ||
    Number(inputToken.decimals) !== 6 ||
    !isAddressEqual(address(inputToken.address, "input token address"), TOKENS.USDC) ||
    Number(outputToken.chainId) !== 42161 ||
    Number(outputToken.decimals) !== 18 ||
    !isAddressEqual(address(outputToken.address, "output token address"), ARBITRUM_NATIVE_ETH)
  ) {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", "Across token or network binding changed.", 502);
  }

  const actualInput = unsigned(quote.inputAmount, "input amount");
  const maximumInput = unsigned(quote.maxInputAmount, "maximum input amount");
  const expectedOutput = unsigned(quote.expectedOutputAmount, "expected output amount");
  const minimumOutput = unsigned(quote.minOutputAmount, "minimum output amount");
  if (
    actualInput <= 0n ||
    maximumInput < actualInput ||
    maximumInput > maxInputAtomic ||
    expectedOutput !== outputAtomic ||
    minimumOutput !== outputAtomic
  ) {
    throw controlled(
      "ACROSS_GAS_CAP_EXCEEDED",
      "Across could not satisfy the exact ETH output inside the user-approved USDC cap.",
      409,
    );
  }

  const swapTx = object(quote.swapTx, "swap transaction");
  const target = address(swapTx.to, "swap target");
  const calldata = hex(swapTx.data, "swap calldata");
  const transactionValue = swapTx.value === undefined
    ? 0n
    : unsigned(String(swapTx.value), "swap value");
  if (
    Number(swapTx.chainId) !== 8453 ||
    !isAddressEqual(target, ACROSS_SPOKE_POOL_PERIPHERY) ||
    calldata.slice(0, 10).toLowerCase() !== "0x110560ad" ||
    transactionValue !== 0n
  ) {
    throw controlled(
      "ACROSS_SWAP_TARGET_INVALID",
      "Across gas route did not target the pinned SpokePoolPeriphery entrypoint.",
      502,
    );
  }

  const quoteExpirySeconds = Number(quote.quoteExpiryTimestamp);
  const apiQuoteExpiresAt = quoteExpirySeconds * 1_000;
  if (
    !Number.isSafeInteger(quoteExpirySeconds) ||
    apiQuoteExpiresAt <= Date.now() ||
    apiQuoteExpiresAt > Date.now() + MAX_API_QUOTE_LIFETIME_MS
  ) {
    throw controlled("ACROSS_SWAP_QUOTE_INVALID", "Across quote expiry is invalid.", 502);
  }
  const quoteExpiresAt = Math.min(
    apiQuoteExpiresAt,
    Date.now() + CLIENT_QUOTE_TTL_MS,
  );

  if (!Array.isArray(quote.approvalTxns) || quote.approvalTxns.length !== 1) {
    throw controlled("ACROSS_SWAP_APPROVAL_INVALID", "Across approval plan is ambiguous.", 502);
  }
  const approvalTx = object(quote.approvalTxns[0], "approval transaction");
  const approvalTarget = address(approvalTx.to, "approval token");
  const approvalData = hex(approvalTx.data, "approval calldata");
  let spender: Address;
  let approvalAmount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approvalData });
    if (decoded.functionName !== "approve") throw new Error("not approve");
    spender = getAddress(String(decoded.args[0]));
    approvalAmount = BigInt(decoded.args[1]);
  } catch {
    throw controlled("ACROSS_SWAP_APPROVAL_INVALID", "Across approval calldata is invalid.", 502);
  }
  if (
    Number(approvalTx.chainId) !== 8453 ||
    !isAddressEqual(approvalTarget, TOKENS.USDC) ||
    !isAddressEqual(spender, target) ||
    approvalAmount !== maxUint256
  ) {
    throw controlled("ACROSS_SWAP_APPROVAL_INVALID", "Across approval binding is invalid.", 502);
  }

  return {
    name: "Across Exact-Output Gas Route",
    protocolId: "across_swap_api",
    router: target,
    calldata,
    value: "0",
    quoteExpiresAt,
    inputAmountAtomic: actualInput.toString(),
    maxInputAmountAtomic: maximumInput.toString(),
    outputAmountAtomic: outputAtomic.toString(),
    inputTokenAddress: TOKENS.USDC,
    outputTokenAddress: ARBITRUM_NATIVE_ETH,
    destinationChainId: 42161,
    expectedOutput: `${formatUnits(outputAtomic, 18)} ETH on Arbitrum (maximum ${formatUnits(maximumInput, 6)} USDC)`,
    routePath: "Base USDC -> Arbitrum ETH",
    approval: {
      token: TOKENS.USDC,
      spender,
      amount: maximumInput.toString(),
      calldata: approvalData,
    },
  };
}
