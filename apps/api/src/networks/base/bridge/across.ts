import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
} from "viem";

const BASE_CHAIN_ID = 8453;
const BASE_ACROSS_SPOKE_POOL = getAddress(
  "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
);
const ACROSS_QUOTE_URL = "https://app.across.to/api/suggested-fees";
const QUOTE_TIMEOUT_MS = 12_000;
const MAX_QUOTE_BYTES = 128 * 1024;
const MAX_QUOTE_AGE_SECONDS = 3 * 60;
const MAX_FILL_WINDOW_SECONDS = 6 * 60 * 60;
const CLIENT_QUOTE_TTL_MS = 2 * 60 * 1000;
const FILL_DEADLINE_SAFETY_MS = 30 * 1000;
const DEFAULT_MAX_RELAY_FEE_BPS = 300n;
const ACROSS_INTEGRATOR_DELIMITER = "1dc0de";

type SupportedToken = "ETH" | "WETH" | "USDC";
type SupportedDestination = "ethereum" | "arbitrum" | "optimism";

interface TokenRoute {
  readonly inputToken: Address;
  readonly outputToken: Address;
  readonly decimals: number;
}

interface DestinationRoute {
  readonly chainId: number;
  readonly displayName: string;
  readonly tokens: Readonly<Record<SupportedToken, TokenRoute>>;
}

const BASE_WETH = getAddress("0x4200000000000000000000000000000000000006");
const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

const SUPPORTED_DESTINATIONS: Readonly<
  Record<SupportedDestination, DestinationRoute>
> = {
  ethereum: {
    chainId: 1,
    displayName: "ETHEREUM",
    tokens: {
      ETH: {
        inputToken: BASE_WETH,
        outputToken: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        decimals: 18,
      },
      WETH: {
        inputToken: BASE_WETH,
        outputToken: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        decimals: 18,
      },
      USDC: {
        inputToken: BASE_USDC,
        outputToken: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        decimals: 6,
      },
    },
  },
  arbitrum: {
    chainId: 42161,
    displayName: "ARBITRUM",
    tokens: {
      ETH: {
        inputToken: BASE_WETH,
        outputToken: getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
        decimals: 18,
      },
      WETH: {
        inputToken: BASE_WETH,
        outputToken: getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
        decimals: 18,
      },
      USDC: {
        inputToken: BASE_USDC,
        outputToken: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
        decimals: 6,
      },
    },
  },
  optimism: {
    chainId: 10,
    displayName: "OPTIMISM",
    tokens: {
      ETH: {
        inputToken: BASE_WETH,
        outputToken: getAddress("0x4200000000000000000000000000000000000006"),
        decimals: 18,
      },
      WETH: {
        inputToken: BASE_WETH,
        outputToken: getAddress("0x4200000000000000000000000000000000000006"),
        decimals: 18,
      },
      USDC: {
        inputToken: BASE_USDC,
        outputToken: getAddress("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
        decimals: 6,
      },
    },
  },
};

const DESTINATION_ALIASES: Readonly<Record<string, SupportedDestination>> = {
  ethereum: "ethereum",
  eth: "ethereum",
  mainnet: "ethereum",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  optimism: "optimism",
  op: "optimism",
};

const DEPOSIT_V3_ABI = [
  {
    inputs: [
      { internalType: "address", name: "depositor", type: "address" },
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "address", name: "inputToken", type: "address" },
      { internalType: "address", name: "outputToken", type: "address" },
      { internalType: "uint256", name: "inputAmount", type: "uint256" },
      { internalType: "uint256", name: "outputAmount", type: "uint256" },
      { internalType: "uint256", name: "destinationChainId", type: "uint256" },
      { internalType: "address", name: "exclusiveRelayer", type: "address" },
      { internalType: "uint32", name: "quoteTimestamp", type: "uint32" },
      { internalType: "uint32", name: "fillDeadline", type: "uint32" },
      { internalType: "uint32", name: "exclusivityDeadline", type: "uint32" },
      { internalType: "bytes", name: "message", type: "bytes" },
    ],
    name: "depositV3",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

interface AcrossQuoteToken {
  readonly address: string;
  readonly decimals: number;
  readonly chainId: number;
}

interface AcrossQuote {
  readonly spokePoolAddress: string;
  readonly timestamp: string | number;
  readonly fillDeadline: string | number;
  readonly exclusivityDeadline: string | number;
  readonly exclusiveRelayer: string;
  readonly outputAmount: string;
  readonly isAmountTooLow: boolean;
  readonly totalRelayFee: { readonly total: string };
  readonly limits: {
    readonly minDeposit: string;
    readonly maxDeposit: string;
  };
  readonly inputToken: AcrossQuoteToken;
  readonly outputToken: AcrossQuoteToken;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Across returned invalid ${field} data.`);
  }
  return value as Record<string, unknown>;
}

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== "string") {
    throw new Error(`Across returned an invalid ${field} address.`);
  }
  try {
    return getAddress(value);
  } catch {
    throw new Error(`Across returned an invalid ${field} address.`);
  }
}

function asUnsignedBigInt(value: unknown, field: string): bigint {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^(0|[1-9]\d*)$/.test(String(value))
  ) {
    throw new Error(`Across returned an invalid ${field} value.`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new Error(`Across returned an invalid ${field} value.`);
  }
  return parsed;
}

function asUint32(value: unknown, field: string): number {
  const parsed = asUnsignedBigInt(value, field);
  if (parsed > 0xffff_ffffn) {
    throw new Error(`Across ${field} value exceeds the uint32 limit.`);
  }
  return Number(parsed);
}

function asChainId(value: unknown, field: string): number {
  const parsed = asUnsignedBigInt(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Across returned an invalid ${field}.`);
  }
  return Number(parsed);
}

function acrossCredentials(): {
  apiKey: string;
  integratorId: string;
} {
  const apiKey = process.env.ACROSS_API_KEY?.trim();
  const integratorId = process.env.ACROSS_INTEGRATOR_ID?.trim();
  if (!apiKey || !integratorId) {
    throw Object.assign(
      new Error(
        "ACROSS_API_KEY and ACROSS_INTEGRATOR_ID are required for the Across Base mainnet route.",
      ),
      { code: "ACROSS_CONFIGURATION_REQUIRED", statusCode: 503 },
    );
  }
  if (!/^0x[0-9a-fA-F]{4}$/.test(integratorId)) {
    throw Object.assign(
      new Error("ACROSS_INTEGRATOR_ID must be a 2-byte 0x-prefixed hex."),
      { code: "ACROSS_CONFIGURATION_INVALID", statusCode: 503 },
    );
  }
  return { apiKey, integratorId: integratorId.slice(2).toLowerCase() };
}

function maxRelayFeeBps(): bigint {
  const raw =
    process.env.ACROSS_MAX_RELAY_FEE_BPS?.trim() ||
    DEFAULT_MAX_RELAY_FEE_BPS.toString();
  if (!/^\d+$/.test(raw)) {
    throw Object.assign(
      new Error("ACROSS_MAX_RELAY_FEE_BPS configuration is invalid."),
      { code: "ACROSS_CONFIGURATION_INVALID", statusCode: 503 },
    );
  }
  const parsed = BigInt(raw);
  if (parsed < 1n || parsed > 1_000n) {
    throw Object.assign(
      new Error("ACROSS_MAX_RELAY_FEE_BPS must be between 1 and 1000."),
      { code: "ACROSS_CONFIGURATION_INVALID", statusCode: 503 },
    );
  }
  return parsed;
}

function parseQuote(
  value: unknown,
  route: TokenRoute,
  destination: DestinationRoute,
  amountInWei: bigint,
): {
  spokePoolAddress: Address;
  totalRelayFee: bigint;
  outputAmount: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
} {
  const data = asRecord(value, "teklif");
  const fee = asRecord(data.totalRelayFee, "totalRelayFee");
  const limits = asRecord(data.limits, "limit");
  const inputToken = asRecord(data.inputToken, "inputToken");
  const outputToken = asRecord(data.outputToken, "outputToken");

  const spokePoolAddress = asAddress(data.spokePoolAddress, "spokePoolAddress");
  if (!isAddressEqual(spokePoolAddress, BASE_ACROSS_SPOKE_POOL)) {
    throw new Error("Across returned an unexpected Base SpokePool target.");
  }

  const responseInputToken = asAddress(inputToken.address, "inputToken");
  const responseOutputToken = asAddress(outputToken.address, "outputToken");
  if (
    !isAddressEqual(responseInputToken, route.inputToken) ||
    asChainId(inputToken.chainId, "inputToken.chainId") !== BASE_CHAIN_ID ||
    asChainId(inputToken.decimals, "inputToken.decimals") !== route.decimals
  ) {
    throw new Error(
      "The Base input token in the Across quote does not match the requested route.",
    );
  }
  if (
    !isAddressEqual(responseOutputToken, route.outputToken) ||
    asChainId(outputToken.chainId, "outputToken.chainId") !==
      destination.chainId ||
    asChainId(outputToken.decimals, "outputToken.decimals") !== route.decimals
  ) {
    throw new Error(
      "The target token in the Across quote does not match the requested route.",
    );
  }

  if (data.isAmountTooLow !== false) {
    throw new Error("Amount is below the Across bridging minimum limit.");
  }
  const minDeposit = asUnsignedBigInt(limits.minDeposit, "limits.minDeposit");
  const maxDeposit = asUnsignedBigInt(limits.maxDeposit, "limits.maxDeposit");
  if (
    minDeposit <= 0n ||
    maxDeposit < minDeposit ||
    amountInWei < minDeposit ||
    amountInWei > maxDeposit
  ) {
    throw new Error("Amount is outside Across bridging limits.");
  }

  const totalRelayFee = asUnsignedBigInt(fee.total, "totalRelayFee.total");
  const outputAmount = asUnsignedBigInt(data.outputAmount, "outputAmount");
  if (
    totalRelayFee >= amountInWei ||
    outputAmount <= 0n ||
    outputAmount > amountInWei ||
    outputAmount !== amountInWei - totalRelayFee
  ) {
    throw new Error("The output amount and fee in the Across quote are inconsistent.");
  }
  const relayFeeBps =
    (totalRelayFee * 10_000n + amountInWei - 1n) / amountInWei;
  if (relayFeeBps > maxRelayFeeBps()) {
    throw Object.assign(
      new Error(
        `Across relay fee exceeds the configured upper limit (${relayFeeBps} bps).`,
      ),
      { code: "ACROSS_FEE_LIMIT_EXCEEDED", statusCode: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const quoteTimestamp = asUint32(data.timestamp, "timestamp");
  if (
    quoteTimestamp < now - MAX_QUOTE_AGE_SECONDS ||
    quoteTimestamp > now + 60
  ) {
    throw new Error("Across quote is not current.");
  }

  const fillDeadline = asUint32(data.fillDeadline, "fillDeadline");
  if (
    fillDeadline <= now ||
    fillDeadline <= quoteTimestamp ||
    fillDeadline > now + MAX_FILL_WINDOW_SECONDS
  ) {
    throw new Error(
      "Across returned an invalid or expired fillDeadline.",
    );
  }

  const exclusivityDeadline = asUint32(
    data.exclusivityDeadline,
    "exclusivityDeadline",
  );

  const validAbsoluteExclusivity =
    exclusivityDeadline > now && exclusivityDeadline <= fillDeadline;
  const validRelativeExclusivity =
    exclusivityDeadline > 0 && exclusivityDeadline <= fillDeadline - now;
  if (
    exclusivityDeadline !== 0 &&
    !validAbsoluteExclusivity &&
    !validRelativeExclusivity
  ) {
    throw new Error("Across returned an invalid exclusivityDeadline.");
  }

  const exclusiveRelayer = asAddress(data.exclusiveRelayer, "exclusiveRelayer");

  return {
    spokePoolAddress,
    totalRelayFee,
    outputAmount,
    quoteTimestamp,
    fillDeadline,
    exclusiveRelayer,
    exclusivityDeadline,
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_QUOTE_BYTES
  ) {
    throw new Error("Across quote response exceeds safe size limit.");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_QUOTE_BYTES) {
    throw new Error("Across quote response exceeds safe size limit.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Across did not return valid JSON.");
  }
}

export async function getAcrossBridgeRoutes(
  tokenAddress: `0x${string}`,
  tokenSymbol: string,
  amountInWei: bigint,
  destinationChainStr: string,
  userAddress: string,
  decimals: number,
  isNative: boolean,
) {
  const destinationKey =
    DESTINATION_ALIASES[destinationChainStr.trim().toLowerCase()];
  const destination = destinationKey
    ? SUPPORTED_DESTINATIONS[destinationKey]
    : undefined;
  if (!destination) {
    throw new Error(
      `Unsupported Target Network: ${destinationChainStr}. Only Ethereum, Arbitrum, or Optimism are selectable.`,
    );
  }

  const normalizedSymbol = tokenSymbol.trim().toUpperCase();
  if (
    normalizedSymbol !== "ETH" &&
    normalizedSymbol !== "WETH" &&
    normalizedSymbol !== "USDC"
  ) {
    throw new Error(
      `Unsupported token on Across Base route: ${tokenSymbol}.`,
    );
  }
  const route = destination.tokens[normalizedSymbol];

  let normalizedInputToken: Address;
  let normalizedUser: Address;
  try {
    normalizedInputToken = getAddress(tokenAddress);
    normalizedUser = getAddress(userAddress);
  } catch {
    throw new Error("Invalid user or token address for Across route.");
  }
  if (
    normalizedUser === zeroAddress ||
    !isAddressEqual(normalizedInputToken, route.inputToken)
  ) {
    throw new Error(
      "Base input token does not match a supported Across route.",
    );
  }
  if (
    decimals !== route.decimals ||
    amountInWei <= 0n ||
    isNative !== (normalizedSymbol === "ETH")
  ) {
    throw new Error(
      "Across route parameters do not match token configuration.",
    );
  }

  const url = new URL(ACROSS_QUOTE_URL);
  url.searchParams.set("inputToken", route.inputToken);
  url.searchParams.set("outputToken", route.outputToken);
  url.searchParams.set("originChainId", String(BASE_CHAIN_ID));
  url.searchParams.set("destinationChainId", String(destination.chainId));
  url.searchParams.set("amount", amountInWei.toString());
  url.searchParams.set("allowUnmatchedDecimals", "false");

  const { apiKey, integratorId } = acrossCredentials();
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
  });
  const rawQuote = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Across Protocol API teklifi reddetti (HTTP ${response.status}).`,
    );
  }

  const quote = parseQuote(rawQuote, route, destination, amountInWei);
  const encodedCalldata = encodeFunctionData({
    abi: DEPOSIT_V3_ABI,
    functionName: "depositV3",
    args: [
      normalizedUser,
      normalizedUser,
      route.inputToken,
      route.outputToken,
      amountInWei,
      quote.outputAmount,
      BigInt(destination.chainId),
      quote.exclusiveRelayer,
      quote.quoteTimestamp,
      quote.fillDeadline,
      quote.exclusivityDeadline,
      "0x",
    ],
  });
  const calldata =
    `${encodedCalldata}${ACROSS_INTEGRATOR_DELIMITER}${integratorId}` as `0x${string}`;
  const quoteExpiresAt = Math.min(
    Date.now() + CLIENT_QUOTE_TTL_MS,
    quote.fillDeadline * 1000 - FILL_DEADLINE_SAFETY_MS,
  );
  if (quoteExpiresAt <= Date.now()) {
    throw Object.assign(new Error("The signature period for the Across quote has expired."), {
      code: "ACROSS_QUOTE_EXPIRED",
      statusCode: 400,
    });
  }

  return [
    {
      name: "Across V3 Bridge",
      protocolId: "across",
      expectedOutput: `${formatUnits(quote.outputAmount, route.decimals)} ${normalizedSymbol} (${destination.displayName} network)`,
      routePath: `Base -> ${destination.displayName}`,
      router: quote.spokePoolAddress,
      calldata,
      value: isNative ? amountInWei.toString() : "0",
      quoteExpiresAt,
      inputAmountAtomic: amountInWei.toString(),
      outputAmountAtomic: quote.outputAmount.toString(),
      inputTokenAddress: route.inputToken,
      outputTokenAddress: route.outputToken,
      destinationChainId: destination.chainId,
      relayFeeAtomic: quote.totalRelayFee.toString(),
      fillDeadline: quote.fillDeadline,
    },
  ];
}
