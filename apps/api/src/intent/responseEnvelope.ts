import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { resolveConfiguredBaseSwapExecution } from "../networks/base/config/intentRouterV2Environment.js";
import {
  resolveBaseTokenDeploymentConfig,
  ZERO_ADDRESS,
  type LaunchFactoryV2TokenDeploymentConfig,
} from "../networks/base/config/launchFactoryV2Environment.js";
import {
  NETWORKS,
  isNetworkPolicyTargetAllowed,
  isNetworkTargetAllowed,
  type NetworkId,
} from "../config/networks.js";
import {
  isArcAppKitExecutionPlan,
  isArcAppKitResultBinding,
} from "../networks/arc/appKit.js";
import {
  NATIVE_TOKEN_SENTINEL,
  decodeUniV3PackedPath,
  type BaseIntentV2AdapterEvidence,
  type BaseIntentV2DeploymentEvidence,
  type BaseIntentV2DeploymentSchemaVersion,
  type IntentV2ExecutionConfig,
} from "../networks/base/intent/routerV2.js";
import {
  ERC20_EXACT_APPROVAL_ABI,
  KLETIA_INTENT_ROUTER_V2_ABI,
} from "../networks/base/intent/routerV2Abis.js";
import {
  ARC_MULTICALL3_FROM_ABI,
  ARC_OFFICIAL_ADDRESSES,
  ARC_OFFICIAL_MEMO_ABI,
  assertOfficialArcCallPlan,
} from "../networks/arc/officialExtensions.js";
import {
  deriveLaunchFactoryV2UserSalt,
  KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
  KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION,
  type LaunchFactoryV2Evidence,
} from "../networks/base/creator/launchFactoryV2.js";
import { KLETIA_LAUNCH_FACTORY_V2_ABI } from "../networks/base/creator/launchFactoryV2Abi.js";

export class IntentResponseError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "IntentResponseError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface RouteLike {
  name?: string;
  protocol?: string;
  router?: string;
  targetContract?: string;
  calldata?: Hex;
  value?: string | number | bigint;
  approvals?: unknown[];
  network?: unknown;
  chainId?: unknown;
  requestId?: unknown;
  userAddress?: unknown;
  quoteExpiresAt?: unknown;
  executionMode?: unknown;
  feeRouterCompatible?: unknown;
  policyTargets?: unknown;
  [key: string]: unknown;
}

const KLETIA_FEE_ROUTER = getAddress(
  "0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf",
);
const BASE_INTENT_V2_EXECUTION_MODE = "kletia_intent_router_v2" as const;
const MAX_BASE_INTENT_V2_ROUTES = 20;
const MAX_BASE_INTENT_V2_FEE_BPS = 100;
const MAX_BASE_INTENT_V2_TTL_SECONDS = 3_600n;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/u;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
const V2_INTENT_KEYS = new Set([
  "owner",
  "tokenIn",
  "tokenOut",
  "amountIn",
  "minAmountOut",
  "recipient",
  "adapter",
  "adapterConfigHash",
  "adapterDataHash",
  "nonce",
  "issuedAt",
  "validAfter",
  "deadline",
  "executor",
  "maxFeeBps",
]);
const V2_CONFIG_EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "adapterKind",
  "observedAtBlock",
  "routerCodehash",
  "wrappedNativeCodehash",
  "adapterConfigHash",
  "adapterConfigurationHash",
]);
const V2_ECONOMICS_KEYS = new Set([
  "quotedGrossAmountOut",
  "grossMinimumAfterSlippage",
  "estimatedFeeAtObservedRate",
  "maximumFeeAtSignedCap",
  "netMinimumAmountOut",
  "userMinimumNetAmountOut",
  "bindingMinimumSource",
  "observedFeeBps",
  "maxFeeBps",
  "slippageBps",
]);
const V2_COVERAGE_KEYS = new Set([
  "policyVersion",
  "runtimeValidationStatus",
  "observedAtBlock",
  "quotedRouteCount",
  "typedAdapterMatchedRouteCount",
  "compiledRouteCount",
  "simulatedRouteCount",
  "eligibleRouteCount",
  "unsupportedQuoteCount",
  "sharedExclusiveNonce",
  "rankingMetric",
  "noLegacyFallback",
]);
const V2_RANKING_KEYS = new Set([
  "policyVersion",
  "stage",
  "primaryMetric",
  "direction",
  "eligibleRouteCount",
  "simulationPassedCount",
  "deferredUntilApprovalCount",
  "gasCostNormalized",
  "executionLatencyNormalized",
  "limitation",
  "rankedRoutes",
]);
const V2_QUOTE_COVERAGE_KEYS = new Set([
  "requestedSourceCount",
  "responsiveSourceCount",
  "sourceWithRoutesCount",
  "unavailableSourceCount",
  "totalQuotedRouteCount",
  "totalAttemptedQuoteCount",
  "totalSuccessfulQuoteReadCount",
  "sources",
]);
const V2_QUOTE_SOURCE_ORDER = ["aerodrome", "standard_amm", "v3_amm"] as const;
const LAUNCH_V2_EVIDENCE_KEYS = new Set([
  "policyVersion",
  "factory",
  "userSalt",
  "saltSource",
  "launchId",
  "name",
  "symbol",
  "totalSupply",
  "recipient",
  "maxDeploymentFee",
  "deploymentFee",
  "value",
  "predictedAddress",
  "observedAtBlock",
  "factoryCodehash",
  "ownerAuthority",
  "ownerAuthorityKind",
  "treasurySafe",
  "pendingTreasury",
  "factoryFeeCap",
  "simulationStatus",
  "supplyPolicy",
  "saltPolicy",
]);

interface ResultLike {
  action?: string;
  actionType?: string;
  winner?: string;
  targetContract?: string;
  target?: string;
  calldata?: Hex;
  value?: string | number | bigint;
  amountInWei?: string | number | bigint;
  allRoutes?: RouteLike[];
  approvals?: unknown[];
  [key: string]: unknown;
}

type UnknownRecord = Record<string, unknown>;

interface CheckedV2Intent {
  readonly owner: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: string;
  readonly minAmountOut: string;
  readonly recipient: Address;
  readonly adapter: Address;
  readonly adapterConfigHash: Hex;
  readonly adapterDataHash: Hex;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly validAfter: string;
  readonly deadline: string;
  readonly executor: Address;
  readonly maxFeeBps: number;
}

interface CheckedV2Route {
  readonly route: RouteLike;
  readonly name: string;
  readonly router: Address;
  readonly calldata: Hex;
  readonly value: string;
  readonly approvals: ReturnType<typeof checkedApprovals>;
  readonly adapter: BaseIntentV2AdapterEvidence;
  readonly adapterData: Hex;
  readonly intent: CheckedV2Intent;
  readonly quoteExpiresAt: number;
  readonly observedAtBlock: string;
  readonly policyTargets: readonly Address[];
  readonly protocolId: string;
  readonly routePath: string;
  readonly expectedOutput: string;
  readonly simulationStatus: "passed" | "deferred_until_approval";
  readonly economics: CheckedV2Economics;
}

interface CheckedV2Economics {
  readonly quotedGrossAmountOut: string;
  readonly grossMinimumAfterSlippage: string;
  readonly estimatedFeeAtObservedRate: string;
  readonly maximumFeeAtSignedCap: string;
  readonly netMinimumAmountOut: string;
  readonly userMinimumNetAmountOut: string | null;
  readonly bindingMinimumSource: "slippage_and_fee_cap" | "user_minimum";
  readonly observedFeeBps: number;
  readonly maxFeeBps: number;
  readonly slippageBps: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedEntityResolution(
  value: unknown,
  expected: {
    readonly network: NetworkId;
    readonly action: string;
    readonly requestId: string;
    readonly userAddress: Address;
  },
): UnknownRecord | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.policyVersion !== "kletia_entity_resolution_v1" ||
    value.network !== expected.network ||
    value.chainId !== NETWORKS[expected.network].chainId ||
    value.action !== expected.action ||
    value.requestId !== expected.requestId ||
    value.decision !== "eligible" ||
    value.scorePolicy !== "informational_only_hard_gates_take_precedence" ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.userAddress !== "string"
  ) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution evidence does not match the request, network, wallet, or action.",
    );
  }
  let evidenceUser: Address;
  try {
    evidenceUser = getAddress(value.userAddress);
  } catch {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "The wallet in the entity resolution evidence is invalid.",
    );
  }
  if (!sameAddress(evidenceUser, expected.userAddress)) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution evidence is not linked to the active wallet.",
    );
  }
  if (
    !Array.isArray(value.assets) ||
    value.assets.length > 4 ||
    !Array.isArray(value.recipients) ||
    value.recipients.length > 25 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 20
  ) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution evidence collection boundaries are invalid.",
    );
  }
  const roles = new Set<string>();
  for (const asset of value.assets) {
    if (
      !isRecord(asset) ||
      typeof asset.role !== "string" ||
      !new Set(["tokenIn", "tokenOut", "collateralToken", "borrowToken"]).has(
        asset.role,
      ) ||
      roles.has(asset.role) ||
      typeof asset.canonicalSymbol !== "string" ||
      asset.canonicalSymbol.length < 1 ||
      asset.canonicalSymbol.length > 24 ||
      typeof asset.displayName !== "string" ||
      asset.displayName.length < 1 ||
      asset.displayName.length > 64 ||
      !Number.isInteger(asset.decimals) ||
      Number(asset.decimals) < 0 ||
      Number(asset.decimals) > 36 ||
      !Number.isFinite(asset.identityConfidence) ||
      Number(asset.identityConfidence) < 0 ||
      Number(asset.identityConfidence) > 100 ||
      !Number.isFinite(asset.trustScore) ||
      Number(asset.trustScore) < 0 ||
      Number(asset.trustScore) > 100 ||
      !new Set([
        "native",
        "erc20",
        "native_with_erc20_interface",
        "app_kit_symbol",
      ]).has(String(asset.representation)) ||
      !new Set([
        "canonical_symbol",
        "curated_alias",
        "exact_address",
        "portfolio_verified_address",
        "protocol_fixed_asset",
      ]).has(String(asset.matchedBy)) ||
      !isRecord(asset.security) ||
      !new Set([
        "manifest_verified",
        "registry_reviewed",
        "provider_passed",
      ]).has(String(asset.security.status)) ||
      !new Set(["Kletia reviewed registry", "GoPlus"]).has(
        String(asset.security.provider),
      ) ||
      typeof asset.security.observedAt !== "string" ||
      !Number.isFinite(Date.parse(asset.security.observedAt)) ||
      !isRecord(asset.actionCompatibility) ||
      asset.actionCompatibility.action !== expected.action ||
      asset.actionCompatibility.allowed !== true ||
      !Number.isInteger(asset.actionCompatibility.executionDecimals) ||
      Number(asset.actionCompatibility.executionDecimals) < 0 ||
      Number(asset.actionCompatibility.executionDecimals) > 36 ||
      !Array.isArray(asset.warnings) ||
      asset.warnings.length > 10
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "The asset record in the entity resolution evidence is invalid.",
      );
    }
    if (asset.address !== undefined) {
      try {
        getAddress(String(asset.address));
      } catch {
        throw new IntentResponseError(
          "INVALID_ENTITY_RESOLUTION_EVIDENCE",
          "The token address in the entity resolution evidence is invalid.",
        );
      }
    }
    if (asset.representation === "native" && asset.address !== undefined) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Native asset evidence cannot carry an ERC-20 address.",
      );
    }
    if (
      asset.security.status === "manifest_verified" &&
      (typeof asset.security.catalogRevision !== "string" ||
        asset.security.catalogRevision.length < 1 ||
        asset.security.catalogRevision.length > 64 ||
        typeof asset.security.primarySource !== "string" ||
        !/^https:\/\//u.test(asset.security.primarySource))
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Manifest verification evidence is missing revision or primary source.",
      );
    }
    if (
      asset.security.status === "registry_reviewed" &&
      (typeof asset.security.catalogRevision !== "string" ||
        asset.security.catalogRevision.length < 1 ||
        asset.security.catalogRevision.length > 64)
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Registry review evidence is missing manifest revision.",
      );
    }
    if (
      asset.security.status === "provider_passed" &&
      asset.security.provider !== "GoPlus"
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Dynamic token evidence is not linked to the expected risk provider.",
      );
    }
    roles.add(asset.role);
  }
  for (const recipient of value.recipients) {
    if (
      !isRecord(recipient) ||
      recipient.role !== "recipient" ||
      typeof recipient.resolvedAddress !== "string" ||
      !new Set(["exact_address", "basename"]).has(
        String(recipient.matchedBy),
      ) ||
      typeof recipient.observedAt !== "string" ||
      !Number.isFinite(Date.parse(recipient.observedAt)) ||
      typeof recipient.expiresAt !== "number" ||
      !Number.isFinite(recipient.expiresAt)
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Recipient resolution evidence is invalid.",
      );
    }
    if (
      recipient.matchedBy === "basename" &&
      (typeof recipient.basename !== "string" ||
        !/^[^\s.]+\.base(?:\.eth)?$/iu.test(recipient.basename) ||
        typeof recipient.resolver !== "string" ||
        typeof recipient.observedAtBlock !== "string")
    ) {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "Basename resolution evidence lacks resolver or block dependency.",
      );
    }
    try {
      getAddress(recipient.resolvedAddress);
    } catch {
      throw new IntentResponseError(
        "INVALID_ENTITY_RESOLUTION_EVIDENCE",
        "The address in the recipient resolution evidence is invalid.",
      );
    }
    if (
      recipient.matchedBy === "basename" &&
      recipient.expiresAt <= Date.now()
    ) {
      throw new IntentResponseError(
        "BASENAME_RESOLUTION_EXPIRED",
        "Basename resolution evidence has expired; recipient must be re-resolved.",
      );
    }
  }
  if (
    value.warnings.some(
      (warning) => typeof warning !== "string" || warning.length > 500,
    )
  ) {
    throw new IntentResponseError(
      "INVALID_ENTITY_RESOLUTION_EVIDENCE",
      "Entity resolution warnings are invalid.",
    );
  }
  return value;
}

function clampToRecipientResolutionExpiry(
  quoteExpiresAt: number,
  entityResolution: UnknownRecord | undefined,
): number {
  if (!entityResolution) return quoteExpiresAt;
  const recipients = entityResolution.recipients as UnknownRecord[];
  return Math.min(
    quoteExpiresAt,
    ...recipients.map((recipient) => Number(recipient.expiresAt)),
  );
}

function assertV2EntityResolutionBinding(
  entityResolution: UnknownRecord | undefined,
  intent: CheckedV2Intent,
) {
  if (!entityResolution) return;
  const assets = entityResolution.assets as UnknownRecord[];
  const assertRole = (
    role: "tokenIn" | "tokenOut",
    expectedAddress: Address,
  ) => {
    const asset = assets.find((candidate) => candidate.role === role);
    if (!asset) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISSING",
        `Missing ${role} resolution proof on Base V2 route.`,
      );
    }
    const native = asset.representation === "native";
    if (native) {
      if (!sameAddress(expectedAddress, NATIVE_TOKEN_SENTINEL)) {
        throw new IntentResponseError(
          "ENTITY_ROUTE_BINDING_MISMATCH",
          `Base V2 ${role} native ID does not match the route token.`,
        );
      }
      return;
    }
    if (
      typeof asset.address !== "string" ||
      !sameAddress(getAddress(asset.address), expectedAddress)
    ) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISMATCH",
        `Base V2 ${role} address does not match the route token.`,
      );
    }
  };
  assertRole("tokenIn", intent.tokenIn);
  assertRole("tokenOut", intent.tokenOut);
}

function assertArcExternalEntityResolutionBinding(
  entityResolution: UnknownRecord | undefined,
  rawResult: ResultLike,
  action: string,
) {
  if (!entityResolution) return;
  const assets = entityResolution.assets as UnknownRecord[];
  const recipients = entityResolution.recipients as UnknownRecord[];
  const tokenIn = assets.find((asset) => asset.role === "tokenIn");
  if (rawResult.executionKind === "circle_app_kit") {
    if (!isRecord(rawResult.executionPlan) || !tokenIn) {
      throw new IntentResponseError(
        "ENTITY_EXTERNAL_BINDING_MISSING",
        "App Kit execution plan is missing entity resolution evidence.",
      );
    }
    const plan = rawResult.executionPlan;
    const expectedToken = String(
      plan.tokenIn || plan.token || "",
    ).toUpperCase();
    const expectedDecimals = expectedToken === "CIRBTC" ? 8 : 6;
    if (
      String(tokenIn.canonicalSymbol).toUpperCase() !== expectedToken ||
      !isRecord(tokenIn.actionCompatibility) ||
      tokenIn.actionCompatibility.executionDecimals !== expectedDecimals
    ) {
      throw new IntentResponseError(
        "ENTITY_EXTERNAL_BINDING_MISMATCH",
        "App Kit token or atomic precision does not match resolution evidence.",
      );
    }
    if (plan.tokenOut !== undefined) {
      const tokenOut = assets.find((asset) => asset.role === "tokenOut");
      if (
        !tokenOut ||
        String(tokenOut.canonicalSymbol).toUpperCase() !==
          String(plan.tokenOut).toUpperCase()
      ) {
        throw new IntentResponseError(
          "ENTITY_EXTERNAL_BINDING_MISMATCH",
          "App Kit output token does not match resolution evidence.",
        );
      }
    }
    if (plan.recipient !== undefined) {
      const recipient = recipients.find(
        (candidate) => candidate.role === "recipient",
      );
      if (
        !recipient ||
        typeof recipient.resolvedAddress !== "string" ||
        !sameAddress(
          getAddress(recipient.resolvedAddress),
          getAddress(String(plan.recipient)),
        )
      ) {
        throw new IntentResponseError(
          "ENTITY_RECIPIENT_BINDING_MISMATCH",
          "App Kit recipient does not match the resolution evidence.",
        );
      }
    }
    return;
  }

  if (action === "official_memo_send" || action === "atomic_payout") {
    if (
      !tokenIn ||
      !isRecord(tokenIn.actionCompatibility) ||
      tokenIn.actionCompatibility.executionDecimals !== 6 ||
      !isRecord(rawResult.policyEvidence) ||
      rawResult.policyEvidence.assetDecimals !== 6 ||
      typeof tokenIn.address !== "string" ||
      typeof rawResult.policyEvidence.asset !== "string" ||
      !sameAddress(
        getAddress(tokenIn.address),
        getAddress(rawResult.policyEvidence.asset),
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_OFFICIAL_ASSET_BINDING_MISMATCH",
        "Official Arc USDC plan address or 6-decimal precision does not match the resolution evidence.",
      );
    }
    assertOfficialRecipientBindings(entityResolution, rawResult, action);
  }
}

function decodedErc20TransferRecipient(calldata: Hex): Address {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata });
    if (
      decoded.functionName !== "transfer" ||
      !decoded.args ||
      decoded.args.length !== 2
    ) {
      throw new Error("not_transfer");
    }
    return getAddress(String(decoded.args[0]));
  } catch {
    throw new IntentResponseError(
      "ENTITY_OFFICIAL_CALLDATA_INVALID",
      "USDC transfer in Official Arc payment calldata could not be resolved.",
    );
  }
}

function assertOfficialRecipientBindings(
  entityResolution: UnknownRecord,
  rawResult: ResultLike,
  action: string,
) {
  try {
    assertOfficialArcCallPlan({
      ...rawResult,
      action:
        action === "official_memo_send"
          ? "arc_official_memo_payment"
          : "arc_atomic_usdc_payout",
    } as never);
  } catch {
    throw new IntentResponseError(
      "ENTITY_OFFICIAL_CALLDATA_INVALID",
      "Official Arc payment plan failed execution policy validation.",
    );
  }
  const recipients = entityResolution.recipients as UnknownRecord[];
  const calldata = checkedCalldata(rawResult.calldata, "officialArc.calldata");
  if (action === "official_memo_send") {
    let transferCalldata: Hex;
    try {
      const decoded = decodeFunctionData({
        abi: ARC_OFFICIAL_MEMO_ABI,
        data: calldata,
      });
      if (decoded.functionName !== "memo" || !decoded.args) {
        throw new Error("not_memo");
      }
      const [target, nested] = decoded.args;
      if (
        !sameAddress(getAddress(String(target)), ARC_OFFICIAL_ADDRESSES.USDC)
      ) {
        throw new Error("wrong_asset");
      }
      transferCalldata = nested as Hex;
    } catch {
      throw new IntentResponseError(
        "ENTITY_OFFICIAL_CALLDATA_INVALID",
        "Official Arc Memo calldata structure could not be resolved.",
      );
    }
    const actualRecipient = decodedErc20TransferRecipient(transferCalldata);
    const evidenceRecipient = recipients.find(
      (recipient) => recipient.transferIndex === undefined,
    );
    if (
      recipients.length !== 1 ||
      !evidenceRecipient ||
      typeof evidenceRecipient.resolvedAddress !== "string" ||
      !sameAddress(
        getAddress(evidenceRecipient.resolvedAddress),
        actualRecipient,
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_RECIPIENT_BINDING_MISMATCH",
        "Official Arc Memo recipient does not match the resolution evidence.",
      );
    }
    return;
  }

  let calls: readonly {
    target: Address;
    allowFailure: boolean;
    callData: Hex;
  }[];
  try {
    const decoded = decodeFunctionData({
      abi: ARC_MULTICALL3_FROM_ABI,
      data: calldata,
    });
    if (decoded.functionName !== "aggregate3" || !decoded.args) {
      throw new Error("not_aggregate3");
    }
    calls = decoded.args[0] as typeof calls;
  } catch {
    throw new IntentResponseError(
      "ENTITY_OFFICIAL_CALLDATA_INVALID",
      "Atomic Arc payment calldata structure could not be resolved.",
    );
  }
  if (calls.length !== recipients.length) {
    throw new IntentResponseError(
      "ENTITY_RECIPIENT_BINDING_MISMATCH",
      "Atomic Arc payment recipient count does not match the resolution evidence.",
    );
  }
  calls.forEach((call, index) => {
    const evidenceRecipient = recipients.find(
      (recipient) => recipient.transferIndex === index,
    );
    const actualRecipient = decodedErc20TransferRecipient(call.callData);
    if (
      call.allowFailure !== false ||
      !sameAddress(getAddress(call.target), ARC_OFFICIAL_ADDRESSES.USDC) ||
      !evidenceRecipient ||
      typeof evidenceRecipient.resolvedAddress !== "string" ||
      !sameAddress(
        getAddress(evidenceRecipient.resolvedAddress),
        actualRecipient,
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_RECIPIENT_BINDING_MISMATCH",
        "Atomic Arc payment recipient does not match the resolution evidence.",
      );
    }
  });
}

function assertGenericEntityResolutionBinding(
  entityResolution: UnknownRecord | undefined,
  rawResult: ResultLike,
  action: string,
) {
  if (!entityResolution) return;
  const assets = entityResolution.assets as UnknownRecord[];
  const tokenIn = assets.find((asset) => asset.role === "tokenIn");
  const allRawApprovals = [
    ...(Array.isArray(rawResult.approvals) ? rawResult.approvals : []),
    ...(Array.isArray(rawResult.allRoutes)
      ? rawResult.allRoutes.flatMap((route) =>
          Array.isArray(route.approvals) ? route.approvals : [],
        )
      : []),
  ];
  const inputConsumingActions = new Set([
    "swap",
    "add_liquidity",
    "stake",
    "liquid_stake",
    "liquid_unstake",
    "lend",
    "repay",
    "bridge",
    "vault_deposit",
    "lending_deposit",
    "lending_repay",
    "memo_send",
  ]);
  if (inputConsumingActions.has(action) && !tokenIn) {
    throw new IntentResponseError(
      "ENTITY_ROUTE_BINDING_MISSING",
      "Execution route is missing tokenIn resolution evidence.",
    );
  }
  if (tokenIn && rawResult.isNativeIn === true) {
    if (
      tokenIn.representation !== "native" &&
      tokenIn.representation !== "native_with_erc20_interface"
    ) {
      throw new IntentResponseError(
        "ENTITY_NATIVE_BINDING_MISMATCH",
        "Native-value route does not match ERC-20 tokenIn evidence.",
      );
    }
    const nativeValue = decimalValue(
      rawResult.value ?? rawResult.amountInWei ?? "0",
      "entity.nativeValue",
    );
    if (BigInt(nativeValue) <= 0n) {
      throw new IntentResponseError(
        "ENTITY_NATIVE_BINDING_MISMATCH",
        "Native-value route does not carry a positive and proven value.",
      );
    }
  }
  if (
    action !== "remove_liquidity" &&
    rawResult.tokenInAddress !== undefined &&
    tokenIn &&
    tokenIn.representation !== "native" &&
    typeof tokenIn.address === "string"
  ) {
    if (
      typeof rawResult.tokenInAddress !== "string" ||
      !sameAddress(
        getAddress(rawResult.tokenInAddress),
        getAddress(tokenIn.address),
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISMATCH",
        "Execution tokenIn address does not match resolved input entity.",
      );
    }
  }

  if (
    tokenIn &&
    inputConsumingActions.has(action) &&
    rawResult.isNativeIn !== true &&
    tokenIn.representation !== "native" &&
    typeof tokenIn.address === "string"
  ) {
    const expectedInput = getAddress(tokenIn.address);
    const directAddressMatches =
      typeof rawResult.tokenInAddress === "string" &&
      sameAddress(getAddress(rawResult.tokenInAddress), expectedInput);
    const approvalMatches = allRawApprovals.some(
      (approval) =>
        isRecord(approval) &&
        typeof approval.token === "string" &&
        sameAddress(getAddress(approval.token), expectedInput),
    );
    if (!directAddressMatches && !approvalMatches) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISSING",
        "ERC-20 tokenIn identity is not bound to route address or approval.",
      );
    }
  }

  const tokenOut = assets.find((asset) => asset.role === "tokenOut");
  if (rawResult.tokenOutAddress !== undefined) {
    if (
      !tokenOut ||
      typeof tokenOut.address !== "string" ||
      typeof rawResult.tokenOutAddress !== "string" ||
      !sameAddress(
        getAddress(rawResult.tokenOutAddress),
        getAddress(tokenOut.address),
      )
    ) {
      throw new IntentResponseError(
        "ENTITY_ROUTE_BINDING_MISMATCH",
        "Execution tokenOut address does not match resolved output entity.",
      );
    }
  }

  if (action === "remove_liquidity") return;
  const allowedApprovalTokens = new Set(
    assets.flatMap((asset) =>
      typeof asset.address === "string"
        ? [getAddress(asset.address).toLowerCase()]
        : [],
    ),
  );
  for (const approval of allRawApprovals) {
    if (!isRecord(approval) || typeof approval.token !== "string") {
      continue;
    }
    const approvalToken = getAddress(approval.token).toLowerCase();
    if (!allowedApprovalTokens.has(approvalToken)) {
      throw new IntentResponseError(
        "ENTITY_APPROVAL_BINDING_MISMATCH",
        "Approval token does not match any transaction entity in the resolution evidence.",
      );
    }
  }
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function v2ResponseError(): never {
  throw new IntentResponseError(
    "INVALID_BASE_INTENT_V2_RESPONSE",
    "Base Intent Router V2 response could not be securely matched with active deployment evidence.",
  );
}

function checkedV2Address(value: unknown, allowNative = false): Address {
  if (typeof value !== "string") return v2ResponseError();
  try {
    const address = getAddress(value);
    if (!allowNative && sameAddress(address, NATIVE_TOKEN_SENTINEL)) {
      return v2ResponseError();
    }
    return address;
  } catch {
    return v2ResponseError();
  }
}

function checkedV2Hex(value: unknown, bytes32 = false): Hex {
  if (
    typeof value !== "string" ||
    !(bytes32 ? BYTES32_PATTERN : HEX_PATTERN).test(value)
  ) {
    return v2ResponseError();
  }
  return value.toLowerCase() as Hex;
}

function checkedV2Decimal(
  value: unknown,
  allowZero = true,
): { readonly encoded: string; readonly value: bigint } {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    return v2ResponseError();
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) return v2ResponseError();
  return { encoded: value, value: parsed };
}

function hasOnlyKeys(
  record: UnknownRecord,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expected.size && keys.every((key) => expected.has(key))
  );
}

function launchV2ResponseError(): never {
  throw new IntentResponseError(
    "INVALID_BASE_LAUNCH_FACTORY_V2_RESPONSE",
    "Base Launch Factory V2 response could not be securely matched with active deployment evidence and calldata.",
  );
}

function checkedLaunchAddress(value: unknown): Address {
  if (typeof value !== "string") return launchV2ResponseError();
  try {
    const address = getAddress(value);
    if (sameAddress(address, ZERO_ADDRESS)) {
      return launchV2ResponseError();
    }
    return address;
  } catch {
    return launchV2ResponseError();
  }
}

function checkedLaunchAddressAllowZero(value: unknown): Address {
  if (typeof value !== "string") return launchV2ResponseError();
  try {
    return getAddress(value);
  } catch {
    return launchV2ResponseError();
  }
}

function checkedLaunchBytes32(value: unknown): Hex {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
    return launchV2ResponseError();
  }
  return value.toLowerCase() as Hex;
}

function checkedLaunchDecimal(
  value: unknown,
  allowZero = true,
): { readonly encoded: string; readonly value: bigint } {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    return launchV2ResponseError();
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) return launchV2ResponseError();
  return { encoded: value, value: parsed };
}

function resolveActiveLaunchV2Config(): LaunchFactoryV2TokenDeploymentConfig {
  try {
    const config = resolveBaseTokenDeploymentConfig(process.env);
    if (config.mode !== "launch_v2" || config.chainId !== 8453) {
      return launchV2ResponseError();
    }
    return config;
  } catch {
    return launchV2ResponseError();
  }
}

function checkedLaunchV2Evidence(
  value: unknown,
  userAddress: Address,
  config: LaunchFactoryV2TokenDeploymentConfig,
): {
  readonly evidence: LaunchFactoryV2Evidence;
  readonly totalSupply: bigint;
  readonly value: bigint;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, LAUNCH_V2_EVIDENCE_KEYS) ||
    value.policyVersion !== KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION ||
    value.simulationStatus !== "passed" ||
    value.supplyPolicy !== "fixed_full_supply_to_recipient" ||
    value.saltPolicy !== "creator_scoped_create2"
  ) {
    return launchV2ResponseError();
  }
  const factory = checkedLaunchAddress(value.factory);
  const recipient = checkedLaunchAddress(value.recipient);
  const predictedAddress = checkedLaunchAddress(value.predictedAddress);
  const ownerAuthority = checkedLaunchAddress(value.ownerAuthority);
  const ownerAuthorityKind =
    value.ownerAuthorityKind === "timelock" ||
    value.ownerAuthorityKind === "safe_2_of_2"
      ? value.ownerAuthorityKind
      : launchV2ResponseError();
  const treasurySafe = checkedLaunchAddress(value.treasurySafe);
  const pendingTreasury = checkedLaunchAddressAllowZero(value.pendingTreasury);
  const userSalt = checkedLaunchBytes32(value.userSalt);
  const factoryCodehash = checkedLaunchBytes32(value.factoryCodehash);
  const totalSupply = checkedLaunchDecimal(value.totalSupply, false);
  const maxDeploymentFee = checkedLaunchDecimal(value.maxDeploymentFee);
  const deploymentFee = checkedLaunchDecimal(value.deploymentFee);
  const nativeValue = checkedLaunchDecimal(value.value);
  const factoryFeeCap = checkedLaunchDecimal(value.factoryFeeCap, false);
  const observedAtBlock = checkedLaunchDecimal(value.observedAtBlock, false);
  const name =
    typeof value.name === "string" ? value.name : launchV2ResponseError();
  const symbol =
    typeof value.symbol === "string" ? value.symbol : launchV2ResponseError();
  const saltSource =
    value.saltSource === "explicit_launch_id" ||
    value.saltSource === "canonical_parameters"
      ? value.saltSource
      : launchV2ResponseError();
  const launchId =
    value.launchId === null || typeof value.launchId === "string"
      ? value.launchId
      : launchV2ResponseError();

  if (
    !sameAddress(factory, config.factory) ||
    !sameAddress(recipient, userAddress) ||
    !sameAddress(ownerAuthority, config.deployment.ownerAuthority) ||
    ownerAuthorityKind !== config.deployment.ownerAuthorityKind ||
    !sameAddress(treasurySafe, config.deployment.treasurySafe) ||
    !sameAddress(pendingTreasury, ZERO_ADDRESS) ||
    !sameHex(factoryCodehash, config.deployment.factoryCodehash) ||
    observedAtBlock.value < config.deployment.observedAtBlock ||
    factoryFeeCap.value !== config.deployment.factoryFeeCap ||
    totalSupply.value > config.deployment.maxTokenSupply ||
    maxDeploymentFee.value !== deploymentFee.value ||
    nativeValue.value !== deploymentFee.value ||
    deploymentFee.value > factoryFeeCap.value ||
    (saltSource === "explicit_launch_id") !== (launchId !== null)
  ) {
    return launchV2ResponseError();
  }

  let canonicalSalt: Hex;
  try {
    canonicalSalt = deriveLaunchFactoryV2UserSalt({
      ...(launchId === null ? {} : { launchId }),
      name,
      symbol,
      totalSupply: totalSupply.value,
      recipient,
    }).userSalt;
  } catch {
    return launchV2ResponseError();
  }
  if (!sameHex(canonicalSalt, userSalt)) {
    return launchV2ResponseError();
  }

  return {
    evidence: {
      policyVersion: KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION,
      factory,
      userSalt,
      saltSource,
      launchId,
      name,
      symbol,
      totalSupply: totalSupply.encoded,
      recipient,
      maxDeploymentFee: maxDeploymentFee.encoded,
      deploymentFee: deploymentFee.encoded,
      value: nativeValue.encoded,
      predictedAddress,
      observedAtBlock: observedAtBlock.encoded,
      factoryCodehash,
      ownerAuthority,
      ownerAuthorityKind,
      treasurySafe,
      pendingTreasury: ZERO_ADDRESS,
      factoryFeeCap: factoryFeeCap.encoded,
      simulationStatus: "passed",
      supplyPolicy: "fixed_full_supply_to_recipient",
      saltPolicy: "creator_scoped_create2",
    },
    totalSupply: totalSupply.value,
    value: nativeValue.value,
  };
}

function sameLaunchV2Evidence(
  left: LaunchFactoryV2Evidence,
  right: LaunchFactoryV2Evidence,
): boolean {
  return Object.keys(left).every((key) => {
    const field = key as keyof LaunchFactoryV2Evidence;
    const leftValue = left[field];
    const rightValue = right[field];
    return typeof leftValue === "string" && /^0x[0-9a-fA-F]+$/u.test(leftValue)
      ? typeof rightValue === "string" &&
          leftValue.toLowerCase() === rightValue.toLowerCase()
      : leftValue === rightValue;
  });
}

function resolveActiveV2Config(): IntentV2ExecutionConfig {
  try {
    const config = resolveConfiguredBaseSwapExecution(process.env);
    if (config.mode !== "intent_v2" || config.chainId !== 8453) {
      return v2ResponseError();
    }
    return config;
  } catch {
    return v2ResponseError();
  }
}

function findBoundV2Adapter(
  route: RouteLike,
  deployment: BaseIntentV2DeploymentEvidence,
): {
  readonly adapter: BaseIntentV2AdapterEvidence;
  readonly adapterAddress: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly wrappedNative: Address;
} {
  const adapterKind =
    route.adapterKind === "uniswap_v2_compatible" ||
    route.adapterKind === "uniswap_v3_swaprouter02"
      ? route.adapterKind
      : v2ResponseError();
  const adapterAddress = checkedV2Address(route.adapter);
  const target = checkedV2Address(route.underlyingTarget);
  const spender = checkedV2Address(route.underlyingSpender);
  const factory = checkedV2Address(route.underlyingFactory);
  const wrappedNative = checkedV2Address(route.wrappedNative);
  if (!sameAddress(wrappedNative, deployment.wrappedNative)) {
    return v2ResponseError();
  }

  const adapter = deployment.adapters.find(
    (candidate) =>
      candidate.kind === adapterKind &&
      sameAddress(candidate.adapter, adapterAddress) &&
      sameAddress(candidate.target, target) &&
      sameAddress(candidate.spender, spender) &&
      sameAddress(candidate.factory, factory),
  );
  if (!adapter) return v2ResponseError();
  return {
    adapter,
    adapterAddress,
    target,
    spender,
    factory,
    wrappedNative,
  };
}

function checkedV2PolicyTargets(
  value: unknown,
  identities: readonly Address[],
): readonly Address[] {
  if (!Array.isArray(value)) return v2ResponseError();
  const normalized = value.map((target) => checkedV2Address(target));
  const suppliedKeys = normalized.map((target) => target.toLowerCase());
  if (new Set(suppliedKeys).size !== suppliedKeys.length) {
    return v2ResponseError();
  }

  const expected = [
    ...new Map(
      identities.map((target) => [target.toLowerCase(), target]),
    ).values(),
  ];
  const expectedKeys = new Set(expected.map((target) => target.toLowerCase()));
  if (
    normalized.length !== expected.length ||
    suppliedKeys.some(
      (key, index) =>
        !expectedKeys.has(key) || key !== expected[index].toLowerCase(),
    )
  ) {
    return v2ResponseError();
  }
  return expected;
}

function checkedV2ConfigEvidence(
  value: unknown,
  deployment: BaseIntentV2DeploymentEvidence,
  adapter: BaseIntentV2AdapterEvidence,
): {
  readonly schemaVersion: BaseIntentV2DeploymentSchemaVersion;
  readonly adapterKind: "uniswap_v2_compatible" | "uniswap_v3_swaprouter02";
  readonly observedAtBlock: string;
  readonly routerCodehash: Hex;
  readonly wrappedNativeCodehash: Hex;
  readonly adapterConfigHash: Hex;
  readonly adapterConfigurationHash: Hex;
} {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, V2_CONFIG_EVIDENCE_KEYS) ||
    value.schemaVersion !== deployment.schemaVersion ||
    value.adapterKind !== adapter.kind
  ) {
    return v2ResponseError();
  }
  const observedAtBlock = checkedV2Decimal(value.observedAtBlock, false);
  const routerCodehash = checkedV2Hex(value.routerCodehash, true);
  const wrappedNativeCodehash = checkedV2Hex(value.wrappedNativeCodehash, true);
  const adapterConfigHash = checkedV2Hex(value.adapterConfigHash, true);
  const adapterConfigurationHash = checkedV2Hex(
    value.adapterConfigurationHash,
    true,
  );
  if (
    observedAtBlock.value < deployment.observedAtBlock ||
    !sameHex(routerCodehash, deployment.routerCodehash) ||
    !sameHex(wrappedNativeCodehash, deployment.wrappedNativeCodehash) ||
    !sameHex(adapterConfigHash, adapter.adapterConfigHash) ||
    !sameHex(adapterConfigurationHash, adapter.adapterConfigurationHash)
  ) {
    return v2ResponseError();
  }
  return {
    schemaVersion: deployment.schemaVersion,
    adapterKind: adapter.kind,
    observedAtBlock: observedAtBlock.encoded,
    routerCodehash,
    wrappedNativeCodehash,
    adapterConfigHash,
    adapterConfigurationHash,
  };
}

function checkedV2Intent(
  value: unknown,
  userAddress: Address,
  adapter: BaseIntentV2AdapterEvidence,
): {
  readonly intent: CheckedV2Intent;
  readonly numeric: {
    readonly amountIn: bigint;
    readonly minAmountOut: bigint;
    readonly nonce: bigint;
    readonly issuedAt: bigint;
    readonly validAfter: bigint;
    readonly deadline: bigint;
  };
} {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_INTENT_KEYS)) {
    return v2ResponseError();
  }
  const owner = checkedV2Address(value.owner);
  const tokenIn = checkedV2Address(value.tokenIn, true);
  const tokenOut = checkedV2Address(value.tokenOut, true);
  const recipient = checkedV2Address(value.recipient);
  const adapterAddress = checkedV2Address(value.adapter);
  const executor = checkedV2Address(value.executor);
  const adapterConfigHash = checkedV2Hex(value.adapterConfigHash, true);
  const adapterDataHash = checkedV2Hex(value.adapterDataHash, true);
  const amountIn = checkedV2Decimal(value.amountIn, false);
  const minAmountOut = checkedV2Decimal(value.minAmountOut, false);
  const nonce = checkedV2Decimal(value.nonce);
  const issuedAt = checkedV2Decimal(value.issuedAt, false);
  const validAfter = checkedV2Decimal(value.validAfter, false);
  const deadline = checkedV2Decimal(value.deadline, false);
  if (
    !sameAddress(owner, userAddress) ||
    !sameAddress(recipient, userAddress) ||
    !sameAddress(executor, userAddress) ||
    !sameAddress(adapterAddress, adapter.adapter) ||
    !sameHex(adapterConfigHash, adapter.adapterConfigHash) ||
    sameAddress(tokenIn, tokenOut) ||
    issuedAt.value > validAfter.value ||
    validAfter.value > deadline.value ||
    deadline.value - issuedAt.value > MAX_BASE_INTENT_V2_TTL_SECONDS ||
    typeof value.maxFeeBps !== "number" ||
    !Number.isInteger(value.maxFeeBps) ||
    value.maxFeeBps < 0 ||
    value.maxFeeBps > MAX_BASE_INTENT_V2_FEE_BPS
  ) {
    return v2ResponseError();
  }

  return {
    intent: {
      owner,
      tokenIn,
      tokenOut,
      amountIn: amountIn.encoded,
      minAmountOut: minAmountOut.encoded,
      recipient,
      adapter: adapterAddress,
      adapterConfigHash,
      adapterDataHash,
      nonce: nonce.encoded,
      issuedAt: issuedAt.encoded,
      validAfter: validAfter.encoded,
      deadline: deadline.encoded,
      executor,
      maxFeeBps: value.maxFeeBps,
    },
    numeric: {
      amountIn: amountIn.value,
      minAmountOut: minAmountOut.value,
      nonce: nonce.value,
      issuedAt: issuedAt.value,
      validAfter: validAfter.value,
      deadline: deadline.value,
    },
  };
}

function decimalValue(value: unknown, fieldName: string): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new IntentResponseError(
    "INVALID_TRANSACTION_VALUE",
    `${fieldName} must be a non-negative integer.`,
  );
}

function checkedCalldata(value: unknown, fieldName: string): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(value)) {
    throw new IntentResponseError(
      "INVALID_TRANSACTION_CALLDATA",
      `${fieldName} must be valid EVM calldata of at least 4 bytes.`,
    );
  }
  return value as Hex;
}

function checkedQuoteExpiry(
  value: unknown,
  fallback: number,
  fieldName: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= Date.now()
  ) {
    throw new IntentResponseError(
      "INVALID_QUOTE_EXPIRY",
      `${fieldName} must be a future millisecond timestamp.`,
    );
  }
  return Math.min(value, fallback);
}

function checkedAddress(
  network: NetworkId,
  target: string,
  action?: string,
): Address {
  let normalized: Address;
  try {
    normalized = getAddress(target);
  } catch {
    throw new IntentResponseError(
      "INVALID_TRANSACTION_TARGET",
      "Transaction target is not a valid EVM address.",
    );
  }

  if (!isNetworkTargetAllowed(network, normalized, action)) {
    throw new IntentResponseError(
      "TARGET_NOT_ALLOWED",
      `Disallowed transaction target for ${network} network: ${normalized}`,
    );
  }
  return normalized;
}

function checkedApprovals(
  value: unknown,
  spender: Address,
): Array<
  Record<string, unknown> & {
    token: Address;
    spender: Address;
    amount: string;
  }
> {
  if (!Array.isArray(value)) return [];
  return value.map((approval, index) => {
    if (
      typeof approval !== "object" ||
      approval === null ||
      Array.isArray(approval)
    ) {
      throw new IntentResponseError(
        "INVALID_ROUTE_APPROVAL",
        `route.approvals[${index}] is not a valid approval object.`,
      );
    }
    const record = approval as Record<string, unknown>;
    let token: Address;
    let approvalSpender: Address;
    try {
      token = getAddress(String(record.token));
      approvalSpender = getAddress(String(record.spender));
    } catch {
      throw new IntentResponseError(
        "INVALID_ROUTE_APPROVAL",
        `route.approvals[${index}] does not contain a valid token/spender.`,
      );
    }
    if (approvalSpender !== spender) {
      throw new IntentResponseError(
        "APPROVAL_SPENDER_MISMATCH",
        "Approval spender must match the transaction route target.",
      );
    }
    const amount = decimalValue(
      record.amount,
      `route.approvals[${index}].amount`,
    );
    if (amount === "0") {
      throw new IntentResponseError(
        "INVALID_ROUTE_APPROVAL",
        "Approval with zero amount cannot be added to the transaction plan.",
      );
    }
    return {
      ...record,
      token,
      spender: approvalSpender,
      amount,
    };
  });
}

function checkedV2Approvals(
  value: unknown,
  router: Address,
  intent: CheckedV2Intent,
): ReturnType<typeof checkedApprovals> {
  if (!Array.isArray(value)) return v2ResponseError();
  let approvals: ReturnType<typeof checkedApprovals>;
  try {
    approvals = checkedApprovals(value, router);
  } catch {
    return v2ResponseError();
  }
  const nativeInput = sameAddress(intent.tokenIn, NATIVE_TOKEN_SENTINEL);
  if (nativeInput) {
    if (approvals.length !== 0) return v2ResponseError();
    return approvals;
  }
  if (approvals.length !== 1) return v2ResponseError();
  const approval = approvals[0];
  if (
    !sameAddress(approval.token, intent.tokenIn) ||
    !sameAddress(approval.spender, router) ||
    approval.amount !== intent.amountIn ||
    approval.required !== true
  ) {
    return v2ResponseError();
  }
  const calldata = checkedV2Hex(approval.calldata);
  const expectedCalldata = encodeFunctionData({
    abi: ERC20_EXACT_APPROVAL_ABI,
    functionName: "approve",
    args: [router, BigInt(intent.amountIn)],
  });
  if (!sameHex(calldata, expectedCalldata)) {
    return v2ResponseError();
  }
  const symbol =
    typeof approval.symbol === "string" &&
    approval.symbol.trim().length > 0 &&
    approval.symbol.trim().length <= 32
      ? approval.symbol.trim()
      : undefined;
  return [
    {
      token: intent.tokenIn,
      spender: router,
      amount: intent.amountIn,
      calldata,
      required: true,
      ...(symbol ? { symbol } : {}),
    },
  ];
}

function checkedV2Economics(
  value: unknown,
  intent: CheckedV2Intent,
): CheckedV2Economics {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_ECONOMICS_KEYS)) {
    return v2ResponseError();
  }
  const quotedGross = checkedV2Decimal(value.quotedGrossAmountOut, false);
  const grossMinimum = checkedV2Decimal(value.grossMinimumAfterSlippage, false);
  const estimatedFee = checkedV2Decimal(value.estimatedFeeAtObservedRate);
  const maximumFee = checkedV2Decimal(value.maximumFeeAtSignedCap);
  const netMinimum = checkedV2Decimal(value.netMinimumAmountOut, false);
  const userMinimum =
    value.userMinimumNetAmountOut === null
      ? null
      : checkedV2Decimal(value.userMinimumNetAmountOut, false);
  const observedFeeBps = value.observedFeeBps;
  const maxFeeBps = value.maxFeeBps;
  const slippageBps = value.slippageBps;
  if (
    typeof observedFeeBps !== "number" ||
    !Number.isInteger(observedFeeBps) ||
    observedFeeBps < 0 ||
    typeof maxFeeBps !== "number" ||
    !Number.isInteger(maxFeeBps) ||
    maxFeeBps < observedFeeBps ||
    maxFeeBps > MAX_BASE_INTENT_V2_FEE_BPS ||
    maxFeeBps !== intent.maxFeeBps ||
    typeof slippageBps !== "number" ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 1 ||
    slippageBps > 5_000 ||
    netMinimum.encoded !== intent.minAmountOut
  ) {
    return v2ResponseError();
  }

  const expectedGrossMinimum =
    (quotedGross.value * (10_000n - BigInt(slippageBps))) / 10_000n;
  const expectedEstimatedFee =
    (grossMinimum.value * BigInt(observedFeeBps)) / 10_000n;
  const expectedMaximumFee = (grossMinimum.value * BigInt(maxFeeBps)) / 10_000n;
  const quoteDerivedNetMinimum = grossMinimum.value - expectedMaximumFee;
  const expectedNetMinimum =
    userMinimum !== null && userMinimum.value > quoteDerivedNetMinimum
      ? userMinimum.value
      : quoteDerivedNetMinimum;
  const expectedBindingMinimumSource =
    userMinimum !== null && userMinimum.value > quoteDerivedNetMinimum
      ? "user_minimum"
      : "slippage_and_fee_cap";
  if (
    grossMinimum.value !== expectedGrossMinimum ||
    estimatedFee.value !== expectedEstimatedFee ||
    maximumFee.value !== expectedMaximumFee ||
    netMinimum.value !== expectedNetMinimum ||
    value.bindingMinimumSource !== expectedBindingMinimumSource
  ) {
    return v2ResponseError();
  }

  return {
    quotedGrossAmountOut: quotedGross.encoded,
    grossMinimumAfterSlippage: grossMinimum.encoded,
    estimatedFeeAtObservedRate: estimatedFee.encoded,
    maximumFeeAtSignedCap: maximumFee.encoded,
    netMinimumAmountOut: netMinimum.encoded,
    userMinimumNetAmountOut: userMinimum?.encoded ?? null,
    bindingMinimumSource: expectedBindingMinimumSource,
    observedFeeBps,
    maxFeeBps,
    slippageBps,
  };
}

function checkedV2RouteAtomic(value: unknown, expected: string): string {
  let encoded: string;
  if (typeof value === "bigint" && value > 0n) {
    encoded = value.toString();
  } else {
    encoded = checkedV2Decimal(value, false).encoded;
  }
  if (encoded !== expected) return v2ResponseError();
  return encoded;
}

function requireDecodedV2Call(
  calldata: Hex,
  adapterData: Hex,
  intent: CheckedV2Intent,
): void {
  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: KLETIA_INTENT_ROUTER_V2_ABI,
      data: calldata,
    });
  } catch {
    return v2ResponseError();
  }
  if (
    decoded.functionName !== "executeSwap" ||
    !decoded.args ||
    decoded.args.length !== 2
  ) {
    return v2ResponseError();
  }
  const decodedIntent = decoded.args[0] as unknown;
  const decodedAdapterData = decoded.args[1] as unknown;
  if (!isRecord(decodedIntent)) return v2ResponseError();

  const decodedFields: Array<
    readonly [unknown, string | number | Address | Hex]
  > = [
    [decodedIntent.owner, intent.owner],
    [decodedIntent.tokenIn, intent.tokenIn],
    [decodedIntent.tokenOut, intent.tokenOut],
    [decodedIntent.amountIn, intent.amountIn],
    [decodedIntent.minAmountOut, intent.minAmountOut],
    [decodedIntent.recipient, intent.recipient],
    [decodedIntent.adapter, intent.adapter],
    [decodedIntent.adapterConfigHash, intent.adapterConfigHash],
    [decodedIntent.adapterDataHash, intent.adapterDataHash],
    [decodedIntent.nonce, intent.nonce],
    [decodedIntent.issuedAt, intent.issuedAt],
    [decodedIntent.validAfter, intent.validAfter],
    [decodedIntent.deadline, intent.deadline],
    [decodedIntent.executor, intent.executor],
    [decodedIntent.maxFeeBps, intent.maxFeeBps],
  ];
  for (const [actual, expected] of decodedFields) {
    if (typeof expected === "string" && expected.startsWith("0x")) {
      if (typeof actual !== "string" || !sameHex(actual, expected)) {
        return v2ResponseError();
      }
      continue;
    }
    if (typeof expected === "string" && DECIMAL_PATTERN.test(expected)) {
      try {
        if (BigInt(actual as bigint) !== BigInt(expected)) {
          return v2ResponseError();
        }
      } catch {
        return v2ResponseError();
      }
      continue;
    }
    if (
      typeof expected === "number" &&
      typeof actual !== "number" &&
      typeof actual !== "bigint"
    ) {
      return v2ResponseError();
    }
    if (
      typeof expected === "number" &&
      BigInt(actual as number | bigint) !== BigInt(expected)
    ) {
      return v2ResponseError();
    }
  }
  if (
    typeof decodedAdapterData !== "string" ||
    !sameHex(decodedAdapterData, adapterData)
  ) {
    return v2ResponseError();
  }

  const canonicalCalldata = encodeFunctionData({
    abi: KLETIA_INTENT_ROUTER_V2_ABI,
    functionName: "executeSwap",
    args: [
      {
        owner: intent.owner,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: BigInt(intent.amountIn),
        minAmountOut: BigInt(intent.minAmountOut),
        recipient: intent.recipient,
        adapter: intent.adapter,
        adapterConfigHash: intent.adapterConfigHash,
        adapterDataHash: intent.adapterDataHash,
        nonce: BigInt(intent.nonce),
        issuedAt: Number(intent.issuedAt),
        validAfter: Number(intent.validAfter),
        deadline: Number(intent.deadline),
        executor: intent.executor,
        maxFeeBps: intent.maxFeeBps,
      },
      adapterData,
    ],
  });
  if (!sameHex(canonicalCalldata, calldata)) {
    return v2ResponseError();
  }
}

function requireBoundV2AdapterData(
  adapterData: Hex,
  intent: CheckedV2Intent,
  deployment: BaseIntentV2DeploymentEvidence,
  adapter: BaseIntentV2AdapterEvidence,
): void {
  if (!sameHex(keccak256(adapterData), intent.adapterDataHash)) {
    return v2ResponseError();
  }
  const normalizedInput = sameAddress(intent.tokenIn, NATIVE_TOKEN_SENTINEL)
    ? deployment.wrappedNative
    : intent.tokenIn;
  const normalizedOutput = sameAddress(intent.tokenOut, NATIVE_TOKEN_SENTINEL)
    ? deployment.wrappedNative
    : intent.tokenOut;

  if (adapter.kind === "uniswap_v3_swaprouter02") {
    try {
      const decoded = decodeUniV3PackedPath(adapterData);
      if (
        !sameAddress(decoded.tokens[0], normalizedInput) ||
        !sameAddress(
          decoded.tokens[decoded.tokens.length - 1],
          normalizedOutput,
        ) ||
        !sameHex(decoded.packedPath, adapterData)
      ) {
        return v2ResponseError();
      }
      return;
    } catch {
      return v2ResponseError();
    }
  }

  let path: readonly Address[];
  try {
    const decoded = decodeAbiParameters([{ type: "address[]" }], adapterData);
    path = decoded[0].map((token) => checkedV2Address(token));
  } catch {
    return v2ResponseError();
  }
  if (path.length < 2 || path.length > 5) {
    return v2ResponseError();
  }
  const pathKeys = path.map((token) => token.toLowerCase());
  if (new Set(pathKeys).size !== pathKeys.length) {
    return v2ResponseError();
  }
  if (
    !sameAddress(path[0], normalizedInput) ||
    !sameAddress(path[path.length - 1], normalizedOutput)
  ) {
    return v2ResponseError();
  }
  const canonicalAdapterData = encodeAbiParameters(
    [{ type: "address[]" }],
    [path],
  );
  if (!sameHex(canonicalAdapterData, adapterData)) {
    return v2ResponseError();
  }
}

function normalizeV2Route(
  route: RouteLike,
  context: {
    readonly action: string;
    readonly network: NetworkId;
    readonly requestId: string;
    readonly userAddress: Address;
    readonly config: IntentV2ExecutionConfig;
  },
): CheckedV2Route {
  if (
    context.network !== "base" ||
    context.action !== "swap" ||
    route.executionMode !== BASE_INTENT_V2_EXECUTION_MODE ||
    route.network !== "base" ||
    route.chainId !== 8453 ||
    route.action !== "swap" ||
    route.approvalPolicy !== "explicit" ||
    route.callerSemantics !== "explicit_recipient" ||
    route.feeRouterCompatible !== false
  ) {
    return v2ResponseError();
  }
  if (route.requestId !== undefined && route.requestId !== context.requestId) {
    return v2ResponseError();
  }
  if (route.userAddress !== undefined) {
    const suppliedUser = checkedV2Address(route.userAddress);
    if (!sameAddress(suppliedUser, context.userAddress)) {
      return v2ResponseError();
    }
  }

  const router = checkedV2Address(route.router);
  const targetContract = checkedV2Address(route.targetContract);
  if (
    !sameAddress(router, context.config.router) ||
    !sameAddress(targetContract, context.config.router)
  ) {
    return v2ResponseError();
  }
  const identities = findBoundV2Adapter(route, context.config.deployment);
  const configEvidence = checkedV2ConfigEvidence(
    route.configEvidence,
    context.config.deployment,
    identities.adapter,
  );
  const checkedIntent = checkedV2Intent(
    route.intent,
    context.userAddress,
    identities.adapter,
  );
  const adapterData = checkedV2Hex(route.adapterData);
  const expectedQuoteSource =
    identities.adapter.kind === "uniswap_v3_swaprouter02"
      ? "v3_amm"
      : "standard_amm";
  const expectedAdapterDataEncoding =
    identities.adapter.kind === "uniswap_v3_swaprouter02"
      ? "uniswap_v3_packed_path_v1"
      : "abi_address_array_v1";
  if (
    route.quoteSource !== expectedQuoteSource ||
    route.adapterDataEncoding !== expectedAdapterDataEncoding
  ) {
    return v2ResponseError();
  }
  requireBoundV2AdapterData(
    adapterData,
    checkedIntent.intent,
    context.config.deployment,
    identities.adapter,
  );
  const calldata = checkedCalldata(route.calldata, "route.calldata");
  requireDecodedV2Call(calldata, adapterData, checkedIntent.intent);

  const value = decimalValue(route.value, "route.value");
  const nativeInput = sameAddress(
    checkedIntent.intent.tokenIn,
    NATIVE_TOKEN_SENTINEL,
  );
  if (value !== (nativeInput ? checkedIntent.intent.amountIn : "0")) {
    return v2ResponseError();
  }
  const approvals = checkedV2Approvals(
    route.approvals,
    context.config.router,
    checkedIntent.intent,
  );
  const simulationStatus = route.simulationStatus;
  if (
    simulationStatus !== "passed" &&
    (nativeInput || simulationStatus !== "deferred_until_approval")
  ) {
    return v2ResponseError();
  }
  const economics = checkedV2Economics(route.economics, checkedIntent.intent);
  const amountOut = checkedV2RouteAtomic(
    route.amountOut,
    economics.netMinimumAmountOut,
  );
  const quotedAmountOut = checkedV2RouteAtomic(
    route.quotedAmountOut,
    economics.quotedGrossAmountOut,
  );
  const protocolId =
    typeof route.protocolId === "string" &&
    route.protocolId === identities.adapter.protocolId &&
    /^[a-z0-9][a-z0-9-]{1,63}$/u.test(route.protocolId)
      ? route.protocolId
      : v2ResponseError();
  const routePath =
    typeof route.routePath === "string" &&
    route.routePath.trim().length > 0 &&
    route.routePath.trim().length <= 500
      ? route.routePath.trim()
      : v2ResponseError();
  const expectedOutput =
    typeof route.expectedOutput === "string" &&
    route.expectedOutput.trim().length > 0 &&
    route.expectedOutput.trim().length <= 500
      ? route.expectedOutput.trim()
      : v2ResponseError();
  const policyTargets = checkedV2PolicyTargets(route.policyTargets, [
    identities.adapterAddress,
    identities.target,
    identities.spender,
    identities.factory,
    identities.wrappedNative,
  ]);

  const deadlineMilliseconds = checkedIntent.numeric.deadline * 1_000n;
  if (
    deadlineMilliseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
    Number(deadlineMilliseconds) <= Date.now() ||
    route.quoteExpiresAt !== Number(deadlineMilliseconds)
  ) {
    return v2ResponseError();
  }
  const name =
    typeof route.name === "string" && route.name.trim()
      ? route.name.trim()
      : v2ResponseError();
  if (
    [
      context.config.router,
      identities.adapterAddress,
      identities.target,
      identities.spender,
      identities.factory,
      identities.wrappedNative,
      checkedIntent.intent.tokenIn,
      checkedIntent.intent.tokenOut,
    ].some((target) => sameAddress(checkedIntent.intent.recipient, target))
  ) {
    return v2ResponseError();
  }

  return {
    route: {
      name,
      action: "swap",
      protocolId,
      expectedOutput,
      routePath,
      amountOut,
      quotedAmountOut,
      quoteSource: expectedQuoteSource,
      router,
      targetContract,
      calldata,
      value,
      approvals,
      simulationStatus,
      approvalPolicy: "explicit",
      executionMode: BASE_INTENT_V2_EXECUTION_MODE,
      callerSemantics: "explicit_recipient",
      feeRouterCompatible: false,
      adapterKind: identities.adapter.kind,
      adapterDataEncoding: expectedAdapterDataEncoding,
      adapter: identities.adapterAddress,
      underlyingTarget: identities.target,
      underlyingSpender: identities.spender,
      underlyingFactory: identities.factory,
      wrappedNative: identities.wrappedNative,
      adapterData,
      intent: checkedIntent.intent,
      economics,
      configEvidence,
      policyTargets,
      network: "base",
      chainId: 8453,
      requestId: context.requestId,
      userAddress: context.userAddress,
      quoteExpiresAt: Number(deadlineMilliseconds),
    },
    name,
    router,
    calldata,
    value,
    approvals,
    adapter: identities.adapter,
    adapterData,
    intent: checkedIntent.intent,
    quoteExpiresAt: Number(deadlineMilliseconds),
    observedAtBlock: configEvidence.observedAtBlock,
    policyTargets,
    protocolId,
    routePath,
    expectedOutput,
    simulationStatus,
    economics,
  };
}

function checkedV2Count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return v2ResponseError();
  }
  return value;
}

function sameV2Approvals(
  left: ReturnType<typeof checkedApprovals>,
  right: ReturnType<typeof checkedApprovals>,
): boolean {
  return (
    left.length === right.length &&
    left.every((approval, index) => {
      const candidate = right[index];
      return (
        sameAddress(approval.token, candidate.token) &&
        sameAddress(approval.spender, candidate.spender) &&
        approval.amount === candidate.amount &&
        approval.required === candidate.required &&
        typeof approval.calldata === "string" &&
        typeof candidate.calldata === "string" &&
        sameHex(approval.calldata, candidate.calldata)
      );
    })
  );
}

function compareV2Routes(left: CheckedV2Route, right: CheckedV2Route): number {
  if (left.simulationStatus !== right.simulationStatus) {
    return left.simulationStatus === "passed" ? -1 : 1;
  }
  const leftMinimum = BigInt(left.economics.netMinimumAmountOut);
  const rightMinimum = BigInt(right.economics.netMinimumAmountOut);
  if (leftMinimum !== rightMinimum) {
    return leftMinimum > rightMinimum ? -1 : 1;
  }
  const protocolOrder = left.protocolId.localeCompare(right.protocolId);
  if (protocolOrder !== 0) return protocolOrder;
  const adapterKindOrder = left.adapter.kind.localeCompare(right.adapter.kind);
  if (adapterKindOrder !== 0) return adapterKindOrder;
  return left.adapterData.localeCompare(right.adapterData);
}

function requireSharedV2Intent(routes: readonly CheckedV2Route[]): void {
  const first = routes[0];
  for (let index = 1; index < routes.length; index += 1) {
    const route = routes[index];
    if (
      !sameAddress(route.intent.owner, first.intent.owner) ||
      !sameAddress(route.intent.tokenIn, first.intent.tokenIn) ||
      !sameAddress(route.intent.tokenOut, first.intent.tokenOut) ||
      route.intent.amountIn !== first.intent.amountIn ||
      !sameAddress(route.intent.recipient, first.intent.recipient) ||
      route.intent.nonce !== first.intent.nonce ||
      route.intent.issuedAt !== first.intent.issuedAt ||
      route.intent.validAfter !== first.intent.validAfter ||
      route.intent.deadline !== first.intent.deadline ||
      !sameAddress(route.intent.executor, first.intent.executor) ||
      route.intent.maxFeeBps !== first.intent.maxFeeBps ||
      route.quoteExpiresAt !== first.quoteExpiresAt ||
      route.observedAtBlock !== first.observedAtBlock ||
      compareV2Routes(first, route) > 0
    ) {
      return v2ResponseError();
    }
  }
  for (let index = 1; index < routes.length; index += 1) {
    if (compareV2Routes(routes[index - 1], routes[index]) > 0) {
      return v2ResponseError();
    }
  }
}

function checkedV2Coverage(value: unknown, routes: readonly CheckedV2Route[]) {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_COVERAGE_KEYS)) {
    return v2ResponseError();
  }
  const quotedRouteCount = checkedV2Count(value.quotedRouteCount);
  const typedAdapterMatchedRouteCount = checkedV2Count(
    value.typedAdapterMatchedRouteCount,
  );
  const compiledRouteCount = checkedV2Count(value.compiledRouteCount);
  const simulatedRouteCount = checkedV2Count(value.simulatedRouteCount);
  const eligibleRouteCount = checkedV2Count(value.eligibleRouteCount);
  const unsupportedQuoteCount = checkedV2Count(value.unsupportedQuoteCount);
  const observedAtBlock = checkedV2Decimal(
    value.observedAtBlock,
    false,
  ).encoded;
  const sharedExclusiveNonce = checkedV2Decimal(
    value.sharedExclusiveNonce,
  ).encoded;
  const expectedPolicyVersion = routes.some(
    ({ adapter }) => adapter.kind === "uniswap_v3_swaprouter02",
  )
    ? "kletia_base_intent_v2_typed_adapter_v2"
    : "kletia_base_intent_v2_typed_adapter_v1";
  if (
    value.policyVersion !== expectedPolicyVersion ||
    value.runtimeValidationStatus !== "validated" ||
    value.rankingMetric !== "simulation_then_guaranteed_net_minimum" ||
    value.noLegacyFallback !== true ||
    observedAtBlock !== routes[0].observedAtBlock ||
    sharedExclusiveNonce !== routes[0].intent.nonce ||
    quotedRouteCount < typedAdapterMatchedRouteCount ||
    typedAdapterMatchedRouteCount !== compiledRouteCount ||
    compiledRouteCount !== simulatedRouteCount ||
    eligibleRouteCount !== routes.length ||
    eligibleRouteCount > simulatedRouteCount ||
    unsupportedQuoteCount !== quotedRouteCount - typedAdapterMatchedRouteCount
  ) {
    return v2ResponseError();
  }
  return {
    policyVersion: expectedPolicyVersion,
    runtimeValidationStatus: "validated" as const,
    observedAtBlock,
    quotedRouteCount,
    typedAdapterMatchedRouteCount,
    compiledRouteCount,
    simulatedRouteCount,
    eligibleRouteCount,
    unsupportedQuoteCount,
    sharedExclusiveNonce,
    rankingMetric: "simulation_then_guaranteed_net_minimum" as const,
    noLegacyFallback: true as const,
  };
}

function checkedV2Ranking(value: unknown, routes: readonly CheckedV2Route[]) {
  if (!isRecord(value) || !hasOnlyKeys(value, V2_RANKING_KEYS)) {
    return v2ResponseError();
  }
  const eligibleRouteCount = checkedV2Count(value.eligibleRouteCount);
  const simulationPassedCount = checkedV2Count(value.simulationPassedCount);
  const deferredUntilApprovalCount = checkedV2Count(
    value.deferredUntilApprovalCount,
  );
  if (
    value.policyVersion !== "base_intent_v2_net_floor_v1" ||
    value.stage !== "final_routes_after_intent_v2_runtime_and_simulation" ||
    value.primaryMetric !== "guaranteed_net_minimum_amount_out" ||
    value.direction !== "descending" ||
    value.gasCostNormalized !== false ||
    value.executionLatencyNormalized !== false ||
    typeof value.limitation !== "string" ||
    value.limitation.length === 0 ||
    value.limitation.length > 500 ||
    eligibleRouteCount !== routes.length ||
    simulationPassedCount !==
      routes.filter(({ simulationStatus }) => simulationStatus === "passed")
        .length ||
    deferredUntilApprovalCount !==
      routes.filter(
        ({ simulationStatus }) =>
          simulationStatus === "deferred_until_approval",
      ).length ||
    !Array.isArray(value.rankedRoutes) ||
    value.rankedRoutes.length !== routes.length
  ) {
    return v2ResponseError();
  }
  const rankedRoutes = value.rankedRoutes.map((ranked, index) => {
    if (!isRecord(ranked)) return v2ResponseError();
    const route = routes[index];
    if (
      ranked.rank !== index + 1 ||
      ranked.protocolId !== route.protocolId ||
      ranked.name !== route.name ||
      ranked.guaranteedNetMinimumAtomic !==
        route.economics.netMinimumAmountOut ||
      ranked.quotedGrossAmountAtomic !== route.economics.quotedGrossAmountOut ||
      ranked.simulationStatus !== route.simulationStatus
    ) {
      return v2ResponseError();
    }
    return {
      rank: index + 1,
      protocolId: route.protocolId,
      name: route.name,
      guaranteedNetMinimumAtomic: route.economics.netMinimumAmountOut,
      quotedGrossAmountAtomic: route.economics.quotedGrossAmountOut,
      simulationStatus: route.simulationStatus,
    };
  });
  return {
    policyVersion: "base_intent_v2_net_floor_v1" as const,
    stage: "final_routes_after_intent_v2_runtime_and_simulation" as const,
    primaryMetric: "guaranteed_net_minimum_amount_out" as const,
    direction: "descending" as const,
    eligibleRouteCount,
    simulationPassedCount,
    deferredUntilApprovalCount,
    gasCostNormalized: false as const,
    executionLatencyNormalized: false as const,
    limitation: value.limitation,
    rankedRoutes,
  };
}

function checkedV2QuoteCoverage(
  value: unknown,
  routes: readonly CheckedV2Route[],
  minimumQuotedRouteCount: number,
) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, V2_QUOTE_COVERAGE_KEYS) ||
    !Array.isArray(value.sources) ||
    value.sources.length !== V2_QUOTE_SOURCE_ORDER.length
  ) {
    return v2ResponseError();
  }
  const requestedSourceCount = checkedV2Count(value.requestedSourceCount);
  const responsiveSourceCount = checkedV2Count(value.responsiveSourceCount);
  const sourceWithRoutesCount = checkedV2Count(value.sourceWithRoutesCount);
  const unavailableSourceCount = checkedV2Count(value.unavailableSourceCount);
  const totalQuotedRouteCount = checkedV2Count(value.totalQuotedRouteCount);
  const totalAttemptedQuoteCount = checkedV2Count(
    value.totalAttemptedQuoteCount,
  );
  const totalSuccessfulQuoteReadCount = checkedV2Count(
    value.totalSuccessfulQuoteReadCount,
  );
  const sources = value.sources.map((source, index) => {
    if (!isRecord(source)) return v2ResponseError();
    const quotedRouteCount = checkedV2Count(source.quotedRouteCount);
    const attemptedQuoteCount = checkedV2Count(source.attemptedQuoteCount);
    const successfulQuoteReadCount = checkedV2Count(
      source.successfulQuoteReadCount,
    );
    if (
      source.source !== V2_QUOTE_SOURCE_ORDER[index] ||
      (source.status !== "quoted" &&
        source.status !== "empty" &&
        source.status !== "unavailable") ||
      (source.status === "quoted"
        ? quotedRouteCount === 0
        : quotedRouteCount !== 0) ||
      attemptedQuoteCount < successfulQuoteReadCount ||
      successfulQuoteReadCount < quotedRouteCount
    ) {
      return v2ResponseError();
    }
    return {
      source: V2_QUOTE_SOURCE_ORDER[index],
      status: source.status,
      quotedRouteCount,
      attemptedQuoteCount,
      successfulQuoteReadCount,
    };
  });
  const summedQuoted = sources.reduce(
    (total, source) => total + source.quotedRouteCount,
    0,
  );
  const summedAttempted = sources.reduce(
    (total, source) => total + source.attemptedQuoteCount,
    0,
  );
  const summedSuccessful = sources.reduce(
    (total, source) => total + source.successfulQuoteReadCount,
    0,
  );
  const expectedResponsive = sources.filter(
    ({ status }) => status !== "unavailable",
  ).length;
  const expectedWithRoutes = sources.filter(
    ({ status }) => status === "quoted",
  ).length;
  const expectedUnavailable = sources.filter(
    ({ status }) => status === "unavailable",
  ).length;
  const requiredSources = new Set(
    routes.map(({ route }) => String(route.quoteSource)),
  );
  if (
    requestedSourceCount !== V2_QUOTE_SOURCE_ORDER.length ||
    responsiveSourceCount !== expectedResponsive ||
    sourceWithRoutesCount !== expectedWithRoutes ||
    unavailableSourceCount !== expectedUnavailable ||
    totalQuotedRouteCount !== summedQuoted ||
    totalAttemptedQuoteCount !== summedAttempted ||
    totalSuccessfulQuoteReadCount !== summedSuccessful ||
    totalQuotedRouteCount < minimumQuotedRouteCount ||
    [...requiredSources].some(
      (requiredSource) =>
        !sources.some(
          (source) =>
            source.source === requiredSource &&
            source.status === "quoted" &&
            source.quotedRouteCount > 0,
        ),
    )
  ) {
    return v2ResponseError();
  }
  return {
    requestedSourceCount,
    responsiveSourceCount,
    sourceWithRoutesCount,
    unavailableSourceCount,
    totalQuotedRouteCount,
    totalAttemptedQuoteCount,
    totalSuccessfulQuoteReadCount,
    sources,
  };
}

function createBaseIntentV2Envelope(
  rawResult: ResultLike,
  requestId: string,
  userAddress: Address,
  config: IntentV2ExecutionConfig,
  entityResolution?: UnknownRecord,
) {
  if (
    rawResult.actionType !== "swap" ||
    (rawResult.action !== undefined && rawResult.action !== "swap") ||
    !Array.isArray(rawResult.allRoutes) ||
    rawResult.allRoutes.length === 0 ||
    rawResult.allRoutes.length > MAX_BASE_INTENT_V2_ROUTES
  ) {
    return v2ResponseError();
  }
  const routes = rawResult.allRoutes.map((route) => {
    if (!isRecord(route)) return v2ResponseError();
    return normalizeV2Route(route, {
      action: "swap",
      network: "base",
      requestId,
      userAddress,
      config,
    });
  });
  requireSharedV2Intent(routes);
  const winner = routes[0];
  assertV2EntityResolutionBinding(entityResolution, winner.intent);
  const rawTarget = checkedV2Address(
    rawResult.targetContract || rawResult.target,
  );
  const calldata = checkedCalldata(rawResult.calldata, "transaction.calldata");
  const value = decimalValue(rawResult.value, "transaction.value");
  const amountInWei = decimalValue(
    rawResult.amountInWei,
    "transaction.amountInWei",
  );
  const approvals = checkedV2Approvals(
    rawResult.approvals,
    winner.router,
    winner.intent,
  );
  const nativeInput = sameAddress(winner.intent.tokenIn, NATIVE_TOKEN_SENTINEL);
  if (
    rawResult.winner !== winner.name ||
    rawResult.expectedOutput !== winner.expectedOutput ||
    rawResult.routePath !== winner.routePath ||
    !sameAddress(rawTarget, winner.router) ||
    !sameHex(calldata, winner.calldata) ||
    value !== winner.value ||
    amountInWei !== winner.intent.amountIn ||
    rawResult.isNativeIn !== nativeInput ||
    rawResult.quoteExpiresAt !== winner.quoteExpiresAt ||
    !sameV2Approvals(approvals, winner.approvals) ||
    (nativeInput
      ? rawResult.tokenInAddress !== undefined
      : !sameAddress(
          checkedV2Address(rawResult.tokenInAddress),
          winner.intent.tokenIn,
        ))
  ) {
    return v2ResponseError();
  }
  const coverage = checkedV2Coverage(rawResult.intentRouterV2Coverage, routes);
  const rankingEvidence = checkedV2Ranking(rawResult.rankingEvidence, routes);
  const quoteCoverage = checkedV2QuoteCoverage(
    rawResult.quoteCoverage,
    routes,
    coverage.quotedRouteCount,
  );

  const winnerMessage =
    typeof rawResult.winnerMessage === "string" &&
    rawResult.winnerMessage.trim().length > 0 &&
    rawResult.winnerMessage.trim().length <= 2_000
      ? rawResult.winnerMessage.trim()
      : undefined;
  return {
    status: "success",
    action: "swap",
    actionType: "swap",
    executionMode: BASE_INTENT_V2_EXECUTION_MODE,
    winner: winner.name,
    expectedOutput: winner.expectedOutput,
    routePath: winner.routePath,
    target: winner.router,
    targetContract: winner.router,
    calldata: winner.calldata,
    value: winner.value,
    amountInWei: winner.intent.amountIn,
    isNativeIn: nativeInput,
    tokenInAddress: nativeInput ? undefined : winner.intent.tokenIn,
    approvals,
    allRoutes: routes.map(({ route }) => route),
    intentRouterV2Coverage: coverage,
    quoteCoverage,
    rankingEvidence,
    network: "base" as const,
    chainId: 8453 as const,
    requestId,
    userAddress,
    quoteExpiresAt: winner.quoteExpiresAt,
    ...(entityResolution ? { entityResolution } : {}),
    ...(winnerMessage ? { winnerMessage } : {}),
  };
}

function hasBaseIntentV2Marker(rawResult: ResultLike): boolean {
  return (
    rawResult.executionMode === BASE_INTENT_V2_EXECUTION_MODE ||
    rawResult.intentRouterV2Coverage !== undefined ||
    (Array.isArray(rawResult.allRoutes) &&
      rawResult.allRoutes.some(
        (route) =>
          isRecord(route) &&
          (route.executionMode === BASE_INTENT_V2_EXECUTION_MODE ||
            route.adapterKind !== undefined ||
            route.adapterDataEncoding !== undefined),
      ))
  );
}

function hasLaunchFactoryV2Marker(rawResult: ResultLike): boolean {
  return (
    rawResult.executionMode === KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
    rawResult.launchFactoryV2Evidence !== undefined ||
    (Array.isArray(rawResult.allRoutes) &&
      rawResult.allRoutes.some(
        (route) =>
          isRecord(route) &&
          (route.executionMode === KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
            route.launchFactoryV2Evidence !== undefined),
      ))
  );
}

function createLaunchFactoryV2Envelope(
  rawResult: ResultLike,
  requestId: string,
  userAddress: Address,
  config: LaunchFactoryV2TokenDeploymentConfig,
  entityResolution?: UnknownRecord,
) {
  if (
    rawResult.executionMode !== KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
    rawResult.simulationStatus !== "passed" ||
    !Array.isArray(rawResult.approvals) ||
    rawResult.approvals.length !== 0 ||
    !Array.isArray(rawResult.allRoutes) ||
    rawResult.allRoutes.length !== 1 ||
    !isRecord(rawResult.allRoutes[0])
  ) {
    return launchV2ResponseError();
  }
  const route = rawResult.allRoutes[0];
  if (
    route.action !== "deploy_token" ||
    route.executionMode !== KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE ||
    route.simulationStatus !== "passed" ||
    !Array.isArray(route.approvals) ||
    route.approvals.length !== 0
  ) {
    return launchV2ResponseError();
  }

  const topEvidence = checkedLaunchV2Evidence(
    rawResult.launchFactoryV2Evidence,
    userAddress,
    config,
  );
  const routeEvidence = checkedLaunchV2Evidence(
    route.launchFactoryV2Evidence,
    userAddress,
    config,
  );
  if (!sameLaunchV2Evidence(topEvidence.evidence, routeEvidence.evidence)) {
    return launchV2ResponseError();
  }

  const rawTarget = rawResult.targetContract || rawResult.target;
  const targetContract = checkedAddress(
    "base",
    String(rawTarget || ""),
    "deploy_token",
  );
  const routeTarget = checkedAddress(
    "base",
    String(route.router || route.targetContract || ""),
    "deploy_token",
  );
  const calldata = checkedCalldata(rawResult.calldata, "launchV2.calldata");
  const routeCalldata = checkedCalldata(
    route.calldata,
    "launchV2.route.calldata",
  );
  const value = checkedLaunchDecimal(
    decimalValue(rawResult.value ?? rawResult.amountInWei, "launchV2.value"),
  );
  const routeValue = checkedLaunchDecimal(
    decimalValue(route.value, "launchV2.route.value"),
  );
  const amountInWei = checkedLaunchDecimal(
    decimalValue(rawResult.amountInWei, "launchV2.amountInWei"),
  );
  if (
    !sameAddress(targetContract, config.factory) ||
    !sameAddress(routeTarget, config.factory) ||
    !sameHex(calldata, routeCalldata) ||
    value.value !== topEvidence.value ||
    routeValue.value !== topEvidence.value ||
    amountInWei.value !== topEvidence.value ||
    rawResult.predictedTokenAddress === undefined ||
    !sameAddress(
      checkedLaunchAddress(rawResult.predictedTokenAddress),
      topEvidence.evidence.predictedAddress,
    )
  ) {
    return launchV2ResponseError();
  }

  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
      data: calldata,
    });
  } catch {
    return launchV2ResponseError();
  }
  if (
    decoded.functionName !== "deployToken" ||
    !decoded.args ||
    decoded.args.length !== 6
  ) {
    return launchV2ResponseError();
  }
  const [
    decodedSalt,
    decodedName,
    decodedSymbol,
    decodedTotalSupply,
    decodedRecipient,
    decodedMaxFee,
  ] = decoded.args;
  if (
    !sameHex(
      checkedLaunchBytes32(decodedSalt),
      topEvidence.evidence.userSalt,
    ) ||
    decodedName !== topEvidence.evidence.name ||
    decodedSymbol !== topEvidence.evidence.symbol ||
    decodedTotalSupply !== topEvidence.totalSupply ||
    !sameAddress(checkedLaunchAddress(decodedRecipient), userAddress) ||
    decodedMaxFee !== topEvidence.value
  ) {
    return launchV2ResponseError();
  }

  const policyTargets = checkedPolicyTargets(
    route.policyTargets,
    "base",
    "deploy_token",
  );
  if (
    policyTargets.length !== 1 ||
    !sameAddress(policyTargets[0], config.factory)
  ) {
    return launchV2ResponseError();
  }
  const quoteExpiresAt = checkedQuoteExpiry(
    rawResult.quoteExpiresAt,
    Date.now() + 2 * 60 * 1_000,
    "launchV2.quoteExpiresAt",
  );
  const routeQuoteExpiresAt = checkedQuoteExpiry(
    route.quoteExpiresAt,
    quoteExpiresAt,
    "launchV2.route.quoteExpiresAt",
  );
  if (
    routeQuoteExpiresAt !== quoteExpiresAt ||
    rawResult.winner !== "Kletia Launch Factory V2"
  ) {
    return launchV2ResponseError();
  }

  const canonicalRoute = {
    name: "Kletia Launch Factory V2",
    action: "deploy_token",
    router: config.factory,
    calldata,
    value: value.encoded,
    approvals: [] as const,
    approvalPolicy: "explicit" as const,
    executionMode: KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
    simulationStatus: "passed" as const,
    launchFactoryV2Evidence: topEvidence.evidence,
    policyTargets: [config.factory],
    network: "base" as const,
    chainId: 8453 as const,
    requestId,
    userAddress,
    quoteExpiresAt,
  };

  return {
    ...rawResult,
    status: "success",
    action: "deploy_token",
    actionType: "deploy_token",
    executionMode: KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
    winner: "Kletia Launch Factory V2",
    target: config.factory,
    targetContract: config.factory,
    calldata,
    value: value.encoded,
    amountInWei: value.encoded,
    isNativeIn: false,
    approvals: [] as const,
    allRoutes: [canonicalRoute],
    simulationStatus: "passed" as const,
    launchFactoryV2Evidence: topEvidence.evidence,
    predictedTokenAddress: topEvidence.evidence.predictedAddress,
    network: "base" as const,
    chainId: 8453 as const,
    requestId,
    userAddress,
    quoteExpiresAt,
    ...(entityResolution ? { entityResolution } : {}),
  };
}

function isCanonicalWrappedNativePrimitive(
  rawResult: ResultLike,
  config: IntentV2ExecutionConfig,
): boolean {
  try {
    if (
      !Array.isArray(rawResult.allRoutes) ||
      rawResult.allRoutes.length !== 1 ||
      !isRecord(rawResult.allRoutes[0])
    ) {
      return false;
    }
    const route = rawResult.allRoutes[0];
    const target = getAddress(
      String(rawResult.targetContract || rawResult.target),
    );
    const router = getAddress(String(route.router || route.targetContract));
    if (
      !sameAddress(target, config.deployment.wrappedNative) ||
      !sameAddress(router, config.deployment.wrappedNative) ||
      route.simulationStatus !== "passed" ||
      (Array.isArray(rawResult.approvals) &&
        rawResult.approvals.length !== 0) ||
      (Array.isArray(route.approvals) && route.approvals.length !== 0)
    ) {
      return false;
    }
    const calldata = checkedCalldata(
      rawResult.calldata,
      "transaction.calldata",
    );
    const routeCalldata = checkedCalldata(route.calldata, "route.calldata");
    const amountInWei = checkedV2Decimal(
      decimalValue(rawResult.amountInWei, "transaction.amountInWei"),
      false,
    ).value;
    const value = decimalValue(rawResult.value, "transaction.value");
    const routeValue = decimalValue(route.value, "route.value");
    if (
      !sameHex(calldata, routeCalldata) ||
      value !== routeValue ||
      rawResult.winner !== route.name ||
      rawResult.tokenInAddress !== undefined
    ) {
      return false;
    }
    const depositCalldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "deposit",
          stateMutability: "payable",
          inputs: [],
          outputs: [],
        },
      ] as const,
      functionName: "deposit",
    });
    const withdrawCalldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [{ name: "wad", type: "uint256" }],
          outputs: [],
        },
      ] as const,
      functionName: "withdraw",
      args: [amountInWei],
    });
    if (rawResult.isNativeIn === true) {
      return (
        value === amountInWei.toString() && sameHex(calldata, depositCalldata)
      );
    }
    return (
      rawResult.isNativeIn === false &&
      value === "0" &&
      sameHex(calldata, withdrawCalldata)
    );
  } catch {
    return false;
  }
}

function checkedPolicyTargets(
  value: unknown,
  network: NetworkId,
  action: string,
): Address[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new IntentResponseError(
      "INVALID_POLICY_TARGETS",
      "Route internal policy targets must be a valid array.",
    );
  }
  return [
    ...new Map(
      value.map((target) => {
        let checked: Address;
        try {
          checked = getAddress(String(target));
        } catch {
          throw new IntentResponseError(
            "INVALID_POLICY_TARGETS",
            "One of the route internal policy targets is not a valid EVM address.",
          );
        }
        if (!isNetworkPolicyTargetAllowed(network, checked)) {
          throw new IntentResponseError(
            "POLICY_TARGET_NOT_ALLOWED",
            `Disallowed internal policy target for ${network} network: ${checked}`,
          );
        }
        return [checked.toLowerCase(), checked] as const;
      }),
    ).values(),
  ];
}

function normalizeRoute(
  route: RouteLike,
  fallback: {
    name: string;
    action: string;
    router: Address;
    calldata: Hex;
    value: string;
    approvals: unknown[];
    approvalPolicy: "explicit" | "legacy_inferred";
    isNativeIn: boolean;
    network: NetworkId;
    chainId: number;
    requestId: string;
    userAddress: Address;
    quoteExpiresAt: number;
  },
  useFallbackTransaction = false,
) {
  const rawRouter = useFallbackTransaction
    ? fallback.router
    : route.router || route.targetContract;
  const rawCalldata = useFallbackTransaction
    ? fallback.calldata
    : route.calldata;
  if (!rawRouter || !rawCalldata) {
    throw new IntentResponseError(
      "INVALID_ROUTE",
      "Each transaction route must explicitly include its own router and calldata fields.",
    );
  }
  const router = checkedAddress(
    fallback.network,
    String(rawRouter),
    fallback.action,
  );
  const calldata = checkedCalldata(rawCalldata, "route.calldata");
  const routeValue =
    route.value ?? (fallback.isNativeIn ? fallback.value : "0");
  const hasExplicitRouteApprovals = Array.isArray(route.approvals);
  const inheritsFallback =
    useFallbackTransaction ||
    router.toLowerCase() === fallback.router.toLowerCase();
  const approvalPolicy = hasExplicitRouteApprovals
    ? "explicit"
    : inheritsFallback
      ? fallback.approvalPolicy
      : "legacy_inferred";
  const rawApprovals = Array.isArray(route.approvals)
    ? route.approvals
    : inheritsFallback
      ? fallback.approvals
      : [];
  const approvals = checkedApprovals(rawApprovals, router);
  const executionMode =
    route.executionMode === undefined
      ? undefined
      : route.executionMode === "direct" ||
          route.executionMode === "kletia_fee_router"
        ? route.executionMode
        : (() => {
            throw new IntentResponseError(
              "INVALID_EXECUTION_MODE",
              "Base route executionMode value is unrecognized.",
            );
          })();
  if (
    router === KLETIA_FEE_ROUTER &&
    (executionMode === "direct" || route.feeRouterCompatible === false)
  ) {
    throw new IntentResponseError(
      "FEE_ROUTER_CALLER_SEMANTICS_MISMATCH",
      "Direct user position route cannot be executed through Kletia Fee Router.",
    );
  }
  const simulationReturnPolicy =
    route.simulationReturnPolicy === undefined
      ? undefined
      : route.simulationReturnPolicy === "uint256_zero"
        ? route.simulationReturnPolicy
        : (() => {
            throw new IntentResponseError(
              "INVALID_SIMULATION_RETURN_POLICY",
              "Route carries an unrecognized protocol return-data policy.",
            );
          })();

  return {
    ...route,
    name: String(route.name || route.protocol || fallback.name),
    action: fallback.action,
    router,
    calldata,
    value: decimalValue(routeValue, "route.value"),
    approvals,
    approvalPolicy,
    ...(executionMode ? { executionMode } : {}),
    ...(simulationReturnPolicy ? { simulationReturnPolicy } : {}),
    policyTargets: checkedPolicyTargets(
      route.policyTargets,
      fallback.network,
      fallback.action,
    ),
    network: fallback.network,
    chainId: fallback.chainId,
    requestId: fallback.requestId,
    userAddress: fallback.userAddress,
    quoteExpiresAt: checkedQuoteExpiry(
      route.quoteExpiresAt,
      fallback.quoteExpiresAt,
      "route.quoteExpiresAt",
    ),
  };
}

export function createIntentResultEnvelope(
  rawResult: ResultLike,
  network: NetworkId,
  requestId: string,
  userAddress: string,
  trustedEntityResolution?: unknown,
) {
  const action = String(
    rawResult.actionType ||
      rawResult.action ||
      (isRecord(trustedEntityResolution)
        ? trustedEntityResolution.action
        : isRecord(rawResult.entityResolution)
          ? rawResult.entityResolution.action
          : "") ||
      "",
  );
  const rawTarget = rawResult.targetContract || rawResult.target;
  const isTransaction =
    typeof rawTarget === "string" && typeof rawResult.calldata === "string";

  let normalizedUser: Address;
  try {
    normalizedUser = getAddress(userAddress);
  } catch {
    throw new IntentResponseError(
      "INVALID_USER_ADDRESS",
      "User address in the response envelope is invalid.",
    );
  }

  const entityResolution = checkedEntityResolution(
    trustedEntityResolution === undefined
      ? rawResult.entityResolution
      : trustedEntityResolution,
    {
      network,
      action,
      requestId,
      userAddress: normalizedUser,
    },
  );
  if (network === "arc") {
    assertArcExternalEntityResolutionBinding(
      entityResolution,
      rawResult,
      action,
    );
  }

  if (rawResult.executionKind === "circle_app_kit") {
    if (
      network !== "arc" ||
      !isArcAppKitExecutionPlan(rawResult.executionPlan) ||
      !isArcAppKitResultBinding(rawResult, requestId)
    ) {
      throw new IntentResponseError(
        "INVALID_EXTERNAL_EXECUTION_PLAN",
        "Circle App Kit plan can only be used in a verified Arc Testnet context.",
      );
    }
    return {
      ...rawResult,
      ...(entityResolution ? { entityResolution } : {}),
      status: "success",
      network: "arc" as const,
      chainId: NETWORKS.arc.chainId,
      requestId,
      userAddress: normalizedUser,
      quoteExpiresAt: clampToRecipientResolutionExpiry(
        checkedQuoteExpiry(
          rawResult.quoteExpiresAt,
          Date.now() + 2 * 60 * 1000,
          "execution.quoteExpiresAt",
        ),
        entityResolution,
      ),
    };
  }

  const hasLaunchV2Marker = hasLaunchFactoryV2Marker(rawResult);
  if (hasLaunchV2Marker) {
    if (network !== "base" || action !== "deploy_token" || !isTransaction) {
      return launchV2ResponseError();
    }
    assertGenericEntityResolutionBinding(entityResolution, rawResult, action);
    return createLaunchFactoryV2Envelope(
      rawResult,
      requestId,
      normalizedUser,
      resolveActiveLaunchV2Config(),
      entityResolution,
    );
  }

  if (
    network === "base" &&
    action === "deploy_token" &&
    process.env.BASE_TOKEN_DEPLOYMENT_MODE?.trim() === "launch_v2"
  ) {
    return launchV2ResponseError();
  }

  const hasV2Marker = hasBaseIntentV2Marker(rawResult);
  if (hasV2Marker) {
    if (network !== "base" || action !== "swap" || !isTransaction) {
      return v2ResponseError();
    }
    return createBaseIntentV2Envelope(
      rawResult,
      requestId,
      normalizedUser,
      resolveActiveV2Config(),
      entityResolution,
    );
  }

  if (
    network === "base" &&
    action === "swap" &&
    process.env.BASE_SWAP_EXECUTION_MODE?.trim() === "intent_v2"
  ) {
    const config = resolveActiveV2Config();
    if (
      !isTransaction ||
      !isCanonicalWrappedNativePrimitive(rawResult, config)
    ) {
      return v2ResponseError();
    }
  }

  if (!isTransaction) {
    return {
      ...rawResult,
      ...(entityResolution ? { entityResolution } : {}),
      status: String(rawResult.status || "success"),
      network,
      chainId: NETWORKS[network].chainId,
      requestId,
      userAddress: normalizedUser,
      quoteExpiresAt: null,
    };
  }

  assertGenericEntityResolutionBinding(entityResolution, rawResult, action);

  if (!action.trim()) {
    throw new IntentResponseError(
      "INVALID_TRANSACTION_ACTION",
      "Transaction response must carry an action bound to the network-target policy.",
    );
  }

  const targetContract = checkedAddress(network, rawTarget, action);
  const calldata = checkedCalldata(rawResult.calldata, "transaction.calldata");
  const value = decimalValue(
    rawResult.value ?? rawResult.amountInWei ?? "0",
    "transaction.value",
  );
  const quoteExpiresAt = checkedQuoteExpiry(
    rawResult.quoteExpiresAt,
    Date.now() + 5 * 60 * 1000,
    "transaction.quoteExpiresAt",
  );
  const fallback = {
    name: String(rawResult.winner || action || "Kletia route"),
    action,
    router: targetContract,
    calldata,
    value,
    approvals: checkedApprovals(rawResult.approvals, targetContract),
    approvalPolicy: Array.isArray(rawResult.approvals)
      ? ("explicit" as const)
      : ("legacy_inferred" as const),
    isNativeIn: rawResult.isNativeIn === true,
    network,
    chainId: NETWORKS[network].chainId,
    requestId,
    userAddress: normalizedUser,
    quoteExpiresAt,
  };
  const suppliedRoutes = Array.isArray(rawResult.allRoutes)
    ? rawResult.allRoutes
    : [];
  const normalizedRoutes =
    suppliedRoutes.length > 0
      ? suppliedRoutes.map((route) => normalizeRoute(route, fallback))
      : [normalizeRoute({}, fallback, true)];
  const allRoutes = normalizedRoutes.map((route) => ({
    ...route,
    quoteExpiresAt: clampToRecipientResolutionExpiry(
      route.quoteExpiresAt,
      entityResolution,
    ),
  }));
  const effectiveQuoteExpiresAt = Math.min(
    clampToRecipientResolutionExpiry(quoteExpiresAt, entityResolution),
    ...allRoutes.map((route) => route.quoteExpiresAt),
  );

  return {
    ...rawResult,
    ...(entityResolution ? { entityResolution } : {}),
    status: "success",
    action,
    actionType: action,
    targetContract,
    calldata,
    value,
    approvals: fallback.approvals,
    allRoutes,
    network,
    chainId: NETWORKS[network].chainId,
    requestId,
    userAddress: normalizedUser,
    quoteExpiresAt: effectiveQuoteExpiresAt,
  };
}

export function createVerifiedIntentResultEnvelope(
  rawResult: ResultLike,
  network: NetworkId,
  requestId: string,
  userAddress: string,
  trustedEntityResolution: unknown,
) {
  if (!isRecord(trustedEntityResolution)) {
    throw new IntentResponseError(
      "ENTITY_RESOLUTION_REQUIRED",
      "Production execution envelope cannot be created without central entity resolution proof.",
    );
  }
  return createIntentResultEnvelope(
    rawResult,
    network,
    requestId,
    userAddress,
    trustedEntityResolution,
  );
}
