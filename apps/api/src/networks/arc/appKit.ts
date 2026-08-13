import { getAddress, keccak256, parseUnits, toBytes, type Address } from "viem";
import type { ParsedIntent } from "../../ai/parser.js";

export const ARC_APP_KIT_TOKENS = ["USDC", "EURC", "cirBTC"] as const;

export type ArcAppKitToken = (typeof ARC_APP_KIT_TOKENS)[number];

export const ARC_APP_KIT_DESTINATIONS = {
  "arbitrum-sepolia": "Arbitrum_Sepolia",
  "avalanche-fuji": "Avalanche_Fuji",
  "base-sepolia": "Base_Sepolia",
  "ethereum-sepolia": "Ethereum_Sepolia",
  "optimism-sepolia": "Optimism_Sepolia",
} as const;

export type ArcAppKitDestination =
  (typeof ARC_APP_KIT_DESTINATIONS)[keyof typeof ARC_APP_KIT_DESTINATIONS];

export type ArcAppKitExecutionPlan =
  | {
      readonly version: 1;
      readonly environment: "testnet";
      readonly operation: "swap";
      readonly sourceChain: "Arc_Testnet";
      readonly amount: string;
      readonly tokenIn: ArcAppKitToken;
      readonly tokenOut: ArcAppKitToken;
      readonly slippageBps: number;
      readonly minimumOutput?: string;
      readonly traceId: string;
    }
  | {
      readonly version: 1;
      readonly environment: "testnet";
      readonly operation: "send";
      readonly sourceChain: "Arc_Testnet";
      readonly amount: string;
      readonly token: ArcAppKitToken;
      readonly recipient: Address;
      readonly traceId: string;
    }
  | {
      readonly version: 1;
      readonly environment: "testnet";
      readonly operation: "bridge";
      readonly sourceChain: "Arc_Testnet";
      readonly destinationChain: ArcAppKitDestination;
      readonly amount: string;
      readonly token: "USDC";
      readonly recipient: Address;
      readonly transferSpeed: "FAST" | "SLOW";
      readonly maxFee?: string;
      readonly useForwarder: true;
      readonly traceId: string;
    };

const DECIMAL_INPUT = /^(?:\d+\.?\d*|\.\d+)$/;
const REQUEST_CORRELATION_ID = /^[0-9a-zA-Z:_-]{8,128}$/;
const OPEN_TELEMETRY_TRACE_ID = /^[0-9a-f]{32}$/;

export class ArcAppKitPlanError extends Error {
  readonly statusCode = 400;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArcAppKitPlanError";
    this.code = code;
  }
}

function positiveDecimal(value: unknown, field: string, decimals = 6): string {
  const normalized = String(value ?? "").trim();
  if (!DECIMAL_INPUT.test(normalized)) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_INVALID_AMOUNT",
      `${field} pozitif bir ondalık sayı olmalıdır.`,
    );
  }
  const fraction = normalized.split(".")[1] || "";
  if (fraction.length > decimals) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_AMOUNT_PRECISION",
      `${field} en fazla ${decimals} ondalık hane taşıyabilir.`,
    );
  }
  try {
    if (parseUnits(normalized, decimals) <= 0n) throw new Error("zero");
  } catch {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_INVALID_AMOUNT",
      `${field} pozitif ve geçerli bir miktar olmalıdır.`,
    );
  }
  return normalized;
}

function normalizedToken(value: unknown, field: string): ArcAppKitToken {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  const token = normalized === "CIRBTC" ? "cirBTC" : normalized;
  if (!ARC_APP_KIT_TOKENS.includes(token as ArcAppKitToken)) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_TOKEN_UNSUPPORTED",
      `${field} Arc Testnet App Kit için USDC, EURC veya cirBTC olmalıdır.`,
    );
  }
  return token as ArcAppKitToken;
}

const tokenDecimals = (token: ArcAppKitToken): number =>
  token === "cirBTC" ? 8 : 6;

function recipientAddress(value: unknown): Address {
  try {
    return getAddress(String(value ?? "").trim());
  } catch {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_RECIPIENT_INVALID",
      "Geçerli bir EVM alıcı adresi gereklidir.",
    );
  }
}

export function arcAppKitTraceId(value: string): string {
  if (!REQUEST_CORRELATION_ID.test(value)) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_TRACE_INVALID",
      "App Kit trace kimliği geçersiz.",
    );
  }
  return keccak256(toBytes(`kletia:${value}`)).slice(2, 34);
}

function slippageBps(value: unknown): number {
  const rawPercent = String(value ?? "1")
    .replace("%", "")
    .trim();
  if (!DECIMAL_INPUT.test(rawPercent)) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_SLIPPAGE_INVALID",
      "Arc stable swap toleransı %0,01 ile %5 arasında olmalıdır.",
    );
  }
  const canonicalPercent = rawPercent.includes(".")
    ? rawPercent.replace(/0+$/, "").replace(/\.$/, "")
    : rawPercent;
  const fractionalPart = canonicalPercent.split(".")[1] || "";
  if (fractionalPart.length > 2) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_SLIPPAGE_PRECISION",
      "Arc stable swap toleransı 0,01% (1 BPS) adımlarıyla belirtilmelidir; kullanıcı sınırı yukarı yuvarlanmaz.",
    );
  }
  let bps: bigint;
  try {
    bps = parseUnits(canonicalPercent || "0", 2);
  } catch {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_SLIPPAGE_PRECISION",
      "Arc stable swap toleransı 0,01% (1 BPS) adımlarıyla belirtilmelidir; kullanıcı sınırı yukarı yuvarlanmaz.",
    );
  }
  if (bps <= 0n || bps > 500n) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_SLIPPAGE_INVALID",
      "Arc stable swap toleransı %0,01 ile %5 arasında olmalıdır.",
    );
  }
  return Number(bps);
}

function destinationChain(value: unknown): ArcAppKitDestination {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
  const destination =
    ARC_APP_KIT_DESTINATIONS[
      normalized as keyof typeof ARC_APP_KIT_DESTINATIONS
    ];
  if (!destination) {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_DESTINATION_UNSUPPORTED",
      "Arc Testnet çıkış köprüsü yalnızca desteklenen testnet hedeflerine hazırlanabilir.",
    );
  }
  return destination;
}

function optionalMaximumFee(value: unknown): string | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  return positiveDecimal(value, "Maksimum bridge ücreti", 6);
}

function optionalMinimumOutput(
  value: unknown,
  decimals: number,
): string | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  return positiveDecimal(value, "Minimum alınacak miktar", decimals);
}

export function buildArcAppKitPlan(intent: ParsedIntent, requestId: string) {
  const action = String(intent.action || "").toLowerCase();
  const correlationId = arcAppKitTraceId(requestId);

  let executionPlan: ArcAppKitExecutionPlan;
  let expectedOutput: string;

  if (action === "stable_swap") {
    const tokenIn = normalizedToken(intent.tokenIn, "tokenIn");
    const tokenOut = normalizedToken(intent.tokenOut, "tokenOut");
    const amount = positiveDecimal(
      intent.amount,
      "App Kit miktarı",
      tokenDecimals(tokenIn),
    );
    if (tokenIn === tokenOut) {
      throw new ArcAppKitPlanError(
        "ARC_APP_KIT_IDENTICAL_TOKENS",
        "Stable swap giriş ve çıkış tokenları farklı olmalıdır.",
      );
    }
    executionPlan = {
      version: 1,
      environment: "testnet",
      operation: "swap",
      sourceChain: "Arc_Testnet",
      amount,
      tokenIn,
      tokenOut,
      slippageBps: slippageBps(intent.slippage),
      minimumOutput: optionalMinimumOutput(
        intent.minimumOutput,
        tokenDecimals(tokenOut),
      ),
      traceId: correlationId,
    };
    expectedOutput = `${amount} ${tokenIn} için canlı App Kit ${tokenOut} tahmini`;
  } else if (action === "appkit_send") {
    const token = normalizedToken(intent.tokenIn || "USDC", "tokenIn");
    if (token === "cirBTC") {
      throw new ArcAppKitPlanError(
        "ARC_APP_KIT_SEND_TOKEN_UNSUPPORTED",
        "cirBTC için doğrulanmış Arc Testnet kontrat adresi yayımlanmadan Send rotası hazırlanmaz.",
      );
    }
    const amount = positiveDecimal(
      intent.amount,
      "App Kit miktarı",
      tokenDecimals(token),
    );
    const recipient = recipientAddress(intent.recipient || intent.tokenOut);
    executionPlan = {
      version: 1,
      environment: "testnet",
      operation: "send",
      sourceChain: "Arc_Testnet",
      amount,
      token,
      recipient,
      traceId: correlationId,
    };
    expectedOutput = `${recipient} adresine ${amount} ${token}`;
  } else if (action === "appkit_bridge") {
    const token = normalizedToken(intent.tokenIn || "USDC", "tokenIn");
    if (token !== "USDC") {
      throw new ArcAppKitPlanError(
        "ARC_APP_KIT_BRIDGE_TOKEN_UNSUPPORTED",
        "Circle App Kit bridge rotası yalnızca USDC destekler.",
      );
    }
    const amount = positiveDecimal(intent.amount, "App Kit miktarı", 6);
    const recipient = recipientAddress(intent.recipient);
    const maxFee = optionalMaximumFee(intent.maxFee);
    const rawSpeed = String(intent.transferSpeed || "SLOW")
      .trim()
      .toUpperCase();
    if (rawSpeed !== "FAST" && rawSpeed !== "SLOW") {
      throw new ArcAppKitPlanError(
        "ARC_APP_KIT_TRANSFER_SPEED_INVALID",
        "Bridge hızı açıkça FAST veya SLOW olmalıdır.",
      );
    }
    const requestedSpeed = rawSpeed;
    if (requestedSpeed === "FAST" && !maxFee) {
      throw new ArcAppKitPlanError(
        "ARC_APP_KIT_MAX_FEE_REQUIRED",
        "FAST bridge için kullanıcı tarafından belirtilmiş maksimum USDC ücreti gereklidir.",
      );
    }
    if (
      requestedSpeed === "FAST" &&
      maxFee &&
      parseUnits(maxFee, 6) >= parseUnits(amount, 6)
    ) {
      throw new ArcAppKitPlanError(
        "ARC_APP_KIT_MAX_FEE_TOO_HIGH",
        "FAST bridge maksimum ücreti gönderilecek USDC miktarından küçük olmalıdır.",
      );
    }
    if (requestedSpeed === "SLOW" && maxFee) {
      throw new ArcAppKitPlanError(
        "ARC_APP_KIT_SLOW_MAX_FEE_FORBIDDEN",
        "SLOW bridge için FAST burn ücret tavanı gönderilmez; maxFee alanını kaldırın veya FAST seçin.",
      );
    }
    executionPlan = {
      version: 1,
      environment: "testnet",
      operation: "bridge",
      sourceChain: "Arc_Testnet",
      destinationChain: destinationChain(intent.destinationChain),
      amount,
      token: "USDC",
      recipient,
      transferSpeed: requestedSpeed,
      maxFee,
      useForwarder: true,
      traceId: correlationId,
    };
    expectedOutput = `${amount} USDC → ${executionPlan.destinationChain} / ${recipient}`;
  } else {
    throw new ArcAppKitPlanError(
      "ARC_APP_KIT_ACTION_UNSUPPORTED",
      `Circle App Kit action "${action}" desteklenmiyor.`,
    );
  }

  return {
    status: "success" as const,
    action,
    actionType: action,
    executionKind: "circle_app_kit" as const,
    provider: "Circle App Kit" as const,
    approvalRequired: true as const,
    executionPlan,
    winner: "Circle App Kit",
    winnerMessage:
      `Circle App Kit planı hazır: ${expectedOutput}. ` +
      "İmzadan önce resmî SDK üzerinden canlı ücret ve çıktı tahmini alınacaktır.",
    expectedOutput,
    routeProof: {
      environment: "testnet" as const,
      sourceNetwork: "arc" as const,
      sourceChainId: 5_042_002,
      provider: "Circle App Kit",
      requiresLiveEstimate: true,
      requiresExplicitWalletApproval: true,
      forwardsDestinationMint:
        executionPlan.operation === "bridge"
          ? executionPlan.useForwarder
          : false,
    },
    quoteExpiresAt: Date.now() + 2 * 60 * 1000,
  };
}

const ACTION_OPERATION_BINDING = {
  stable_swap: "swap",
  appkit_send: "send",
  appkit_bridge: "bridge",
} as const;

export function isArcAppKitResultBinding(
  value: unknown,
  requestId: string,
): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  const action = String(result.action || "");
  const actionType = String(result.actionType || "");
  const operation =
    ACTION_OPERATION_BINDING[action as keyof typeof ACTION_OPERATION_BINDING];
  const plan =
    result.executionPlan && typeof result.executionPlan === "object"
      ? (result.executionPlan as Record<string, unknown>)
      : undefined;
  const proof =
    result.routeProof && typeof result.routeProof === "object"
      ? (result.routeProof as Record<string, unknown>)
      : undefined;

  let expectedTraceId: string;
  try {
    expectedTraceId = arcAppKitTraceId(requestId);
  } catch {
    return false;
  }

  return (
    result.executionKind === "circle_app_kit" &&
    result.provider === "Circle App Kit" &&
    result.approvalRequired === true &&
    operation !== undefined &&
    actionType === action &&
    isArcAppKitExecutionPlan(result.executionPlan) &&
    plan?.operation === operation &&
    plan.traceId === expectedTraceId &&
    proof?.environment === "testnet" &&
    proof.sourceNetwork === "arc" &&
    proof.sourceChainId === 5_042_002 &&
    proof.provider === "Circle App Kit" &&
    proof.requiresLiveEstimate === true &&
    proof.requiresExplicitWalletApproval === true &&
    proof.forwardsDestinationMint === (operation === "bridge")
  );
}

export function isArcAppKitExecutionPlan(
  value: unknown,
): value is ArcAppKitExecutionPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  if (
    plan.version !== 1 ||
    plan.environment !== "testnet" ||
    plan.sourceChain !== "Arc_Testnet" ||
    !OPEN_TELEMETRY_TRACE_ID.test(String(plan.traceId || ""))
  ) {
    return false;
  }
  try {
    if (plan.operation === "swap") {
      const tokenIn = normalizedToken(plan.tokenIn, "tokenIn");
      const tokenOut = normalizedToken(plan.tokenOut, "tokenOut");
      positiveDecimal(plan.amount, "App Kit miktarı", tokenDecimals(tokenIn));
      if (
        tokenIn === tokenOut ||
        !Number.isSafeInteger(plan.slippageBps) ||
        Number(plan.slippageBps) <= 0 ||
        Number(plan.slippageBps) > 500
      ) {
        return false;
      }
      optionalMinimumOutput(plan.minimumOutput, tokenDecimals(tokenOut));
      return true;
    }
    if (plan.operation === "send") {
      const token = normalizedToken(plan.token, "token");
      if (token === "cirBTC") return false;
      positiveDecimal(plan.amount, "App Kit miktarı", tokenDecimals(token));
      recipientAddress(plan.recipient);
      return true;
    }
    if (plan.operation === "bridge") {
      if (
        plan.token !== "USDC" ||
        plan.useForwarder !== true ||
        (plan.transferSpeed !== "FAST" && plan.transferSpeed !== "SLOW")
      ) {
        return false;
      }
      positiveDecimal(plan.amount, "App Kit miktarı", 6);
      recipientAddress(plan.recipient);
      destinationChain(plan.destinationChain);
      const maxFee = optionalMaximumFee(plan.maxFee);
      if (plan.transferSpeed === "SLOW") return maxFee === undefined;
      return (
        maxFee !== undefined &&
        parseUnits(maxFee, 6) < parseUnits(String(plan.amount), 6)
      );
    }
  } catch {
    return false;
  }
  return false;
}
