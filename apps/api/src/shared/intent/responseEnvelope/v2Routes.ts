/**
 * Base Intent Router V2 route normalisation: approvals, economics, decoded
 * calls, adapter data and the shared intent across routes.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import type { NetworkId } from "../../config/networks.js";
import {
  NATIVE_TOKEN_SENTINEL,
  decodeUniV3PackedPath,
  type BaseIntentV2AdapterEvidence,
  type BaseIntentV2DeploymentEvidence,
  type IntentV2ExecutionConfig,
} from "../../../networks/base/intent/routerV2.js";
import {
  ERC20_EXACT_APPROVAL_ABI,
  KLETIA_INTENT_ROUTER_V2_ABI,
} from "../../../networks/base/intent/routerV2Abis.js";
import type {
  CheckedV2Economics,
  CheckedV2Intent,
  RouteLike,
} from "./types.js";
import {
  BASE_INTENT_V2_EXECUTION_MODE,
  DECIMAL_PATTERN,
  MAX_BASE_INTENT_V2_FEE_BPS,
  V2_ECONOMICS_KEYS,
} from "./constants.js";
import {
  checkedApprovals,
  checkedCalldata,
  decimalValue,
  hasOnlyKeys,
  isRecord,
  sameAddress,
  sameHex,
} from "./checks.js";
import {
  checkedV2Address,
  checkedV2ConfigEvidence,
  checkedV2Decimal,
  checkedV2Hex,
  checkedV2Intent,
  checkedV2PolicyTargets,
  findBoundV2Adapter,
  v2ResponseError,
} from "./v2Checks.js";

export interface CheckedV2Route {
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

export function checkedV2Approvals(
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

export function normalizeV2Route(
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

export function checkedV2Count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return v2ResponseError();
  }
  return value;
}

export function sameV2Approvals(
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

export function requireSharedV2Intent(routes: readonly CheckedV2Route[]): void {
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
