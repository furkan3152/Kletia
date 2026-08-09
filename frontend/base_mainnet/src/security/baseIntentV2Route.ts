import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem';

const BASE_MAINNET_CHAIN_ID = 8_453;
const NATIVE_TOKEN_SENTINEL =
  '0x0000000000000000000000000000000000000000';
const MAX_INTENT_TTL_SECONDS = 3_600n;
const MAX_ROUTER_FEE_BPS = 100;
const UINT48_MAX = (1n << 48n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

const KLETIA_INTENT_ROUTER_V2_EXECUTE_SWAP_ABI = [
  {
    type: 'function',
    name: 'executeSwap',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'intent',
        type: 'tuple',
        components: [
          { name: 'owner', type: 'address' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'minAmountOut', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'adapter', type: 'address' },
          { name: 'adapterConfigHash', type: 'bytes32' },
          { name: 'adapterDataHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'issuedAt', type: 'uint48' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'deadline', type: 'uint48' },
          { name: 'executor', type: 'address' },
          { name: 'maxFeeBps', type: 'uint16' },
        ],
      },
      { name: 'adapterData', type: 'bytes' },
    ],
    outputs: [
      { name: 'netAmountOut', type: 'uint256' },
      { name: 'feeAmount', type: 'uint256' },
    ],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

type UnknownRecord = Record<string, unknown>;
type BaseIntentV2AdapterKind =
  | 'uniswap_v2_compatible'
  | 'uniswap_v3_swaprouter02';

const isObjectRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const isCanonicalAddress = (value: unknown): value is Address => {
  if (typeof value !== 'string' || !isAddress(value)) return false;
  try {
    return getAddress(value) === value;
  } catch {
    return false;
  }
};

const sameAddress = (left: unknown, right: unknown): boolean =>
  isCanonicalAddress(left) &&
  isCanonicalAddress(right) &&
  getAddress(left) === getAddress(right);

const isBytes = (value: unknown): value is Hex =>
  typeof value === 'string' &&
  /^0x(?:[0-9a-fA-F]{2})+$/.test(value);

const isBytes32 = (value: unknown): value is Hex =>
  typeof value === 'string' &&
  /^0x[0-9a-fA-F]{64}$/.test(value);

const sameHex = (left: unknown, right: unknown): boolean =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  left.toLowerCase() === right.toLowerCase();

const parseUnsignedInteger = (
  value: unknown,
  maximum = UINT256_MAX,
): bigint | undefined => {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9]\d*)$/.test(value)
  ) {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= maximum ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const parseDecodedInteger = (value: unknown): bigint | undefined => {
  if (
    typeof value !== 'bigint' &&
    (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    )
  ) {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const parseExpiryMilliseconds = (value: unknown): number | undefined => {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    const numeric = Number(value);
    parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  }
  return (
    typeof parsed === 'number' &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
  )
    ? parsed
    : undefined;
};

const uniqueCanonicalAddresses = (
  addresses: readonly Address[],
): Address[] => {
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const hasExactPolicyTargets = (
  actual: unknown,
  expectedWithDuplicates: readonly Address[],
): boolean => {
  if (!Array.isArray(actual)) return false;
  const expected = uniqueCanonicalAddresses(expectedWithDuplicates);
  return (
    actual.length === expected.length &&
    actual.every(
      (target, index) =>
        isCanonicalAddress(target) &&
        sameAddress(target, expected[index]),
    )
  );
};

const hasExactExplicitApproval = (
  route: UnknownRecord,
  intent: UnknownRecord,
  router: Address,
): boolean => {
  if (!Array.isArray(route.approvals)) return false;
  const tokenIn = intent.tokenIn;
  const amountIn = parseUnsignedInteger(intent.amountIn);
  if (!isCanonicalAddress(tokenIn) || amountIn === undefined || amountIn === 0n) {
    return false;
  }

  const isNativeInput = sameAddress(tokenIn, NATIVE_TOKEN_SENTINEL);
  if (isNativeInput) {
    return (
      route.approvals.length === 0 &&
      route.value === intent.amountIn &&
      route.simulationStatus === 'passed'
    );
  }

  if (route.approvals.length !== 1 || route.value !== '0') return false;
  const approval = route.approvals[0];
  const expectedApprovalCalldata = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [router, amountIn],
  });
  return (
    isObjectRecord(approval) &&
    sameAddress(approval.token, tokenIn) &&
    sameAddress(approval.spender, router) &&
    approval.amount === intent.amountIn &&
    approval.required === true &&
    sameHex(approval.calldata, expectedApprovalCalldata) &&
    (
      route.simulationStatus === 'passed' ||
      route.simulationStatus === 'deferred_until_approval'
    )
  );
};

const hasValidIntentTimes = (
  response: UnknownRecord,
  route: UnknownRecord,
  intent: UnknownRecord,
): boolean => {
  const issuedAt = parseUnsignedInteger(intent.issuedAt, UINT48_MAX);
  const validAfter = parseUnsignedInteger(intent.validAfter, UINT48_MAX);
  const deadline = parseUnsignedInteger(intent.deadline, UINT48_MAX);
  const nonce = parseUnsignedInteger(intent.nonce);
  if (
    issuedAt === undefined ||
    validAfter === undefined ||
    deadline === undefined ||
    nonce === undefined ||
    issuedAt === 0n ||
    issuedAt > validAfter ||
    validAfter > deadline ||
    deadline - issuedAt > MAX_INTENT_TTL_SECONDS
  ) {
    return false;
  }

  const routeExpiry = parseExpiryMilliseconds(route.quoteExpiresAt);
  const responseExpiry = parseExpiryMilliseconds(response.quoteExpiresAt);
  if (
    routeExpiry === undefined ||
    responseExpiry === undefined ||
    routeExpiry !== responseExpiry
  ) {
    return false;
  }

  const onchainExpiry = Number(deadline) * 1_000;
  return Number.isSafeInteger(onchainExpiry) && routeExpiry === onchainExpiry;
};

const hasValidV2ConfigEvidence = (
  evidence: unknown,
  intent: UnknownRecord,
  adapterKind: BaseIntentV2AdapterKind,
): boolean =>
  isObjectRecord(evidence) &&
  (
    evidence.schemaVersion ===
      'kletia_base_intent_v2_deployment_v2' ||
    (
      evidence.schemaVersion ===
        'kletia_base_intent_v2_deployment_v1' &&
      adapterKind === 'uniswap_v2_compatible'
    )
  ) &&
  evidence.adapterKind === adapterKind &&
  (
    parseUnsignedInteger(evidence.observedAtBlock) ?? 0n
  ) > 0n &&
  isBytes32(evidence.routerCodehash) &&
  isBytes32(evidence.wrappedNativeCodehash) &&
  isBytes32(evidence.adapterConfigHash) &&
  sameHex(evidence.adapterConfigHash, intent.adapterConfigHash) &&
  isBytes32(evidence.adapterConfigurationHash);

const normalizedIntentToken = (
  token: Address,
  wrappedNative: Address,
): Address => sameAddress(token, NATIVE_TOKEN_SENTINEL)
  ? wrappedNative
  : token;

const hasCanonicalUniV2AdapterData = (
  adapterData: Hex,
  tokenIn: Address,
  tokenOut: Address,
  wrappedNative: Address,
): boolean => {
  try {
    const [decodedPath] = decodeAbiParameters(
      [{ type: 'address[]' }],
      adapterData,
    );
    if (decodedPath.length < 2 || decodedPath.length > 5) {
      return false;
    }
    const path = decodedPath.map((token) => getAddress(token));
    if (
      new Set(path.map((token) => token.toLowerCase())).size !==
      path.length ||
      !sameAddress(
        path[0],
        normalizedIntentToken(tokenIn, wrappedNative),
      ) ||
      !sameAddress(
        path[path.length - 1],
        normalizedIntentToken(tokenOut, wrappedNative),
      )
    ) {
      return false;
    }
    return sameHex(
      encodeAbiParameters(
        [{ type: 'address[]' }],
        [path],
      ),
      adapterData,
    );
  } catch {
    return false;
  }
};

const hasCanonicalUniV3AdapterData = (
  adapterData: Hex,
  tokenIn: Address,
  tokenOut: Address,
  wrappedNative: Address,
): boolean => {
  try {
    const raw = adapterData.slice(2);
    const byteLength = raw.length / 2;
    if (
      byteLength < 43 ||
      byteLength > 112 ||
      (byteLength - 20) % 23 !== 0
    ) {
      return false;
    }
    const hopCount = (byteLength - 20) / 23;
    if (hopCount < 1 || hopCount > 4) return false;
    const tokens: Address[] = [];
    const seen = new Set<string>();
    const readAddress = (offset: number): Address => getAddress(
      `0x${raw.slice(offset * 2, (offset + 20) * 2)}`,
    );
    const addToken = (token: Address): boolean => {
      if (sameAddress(token, NATIVE_TOKEN_SENTINEL)) return false;
      const key = token.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      tokens.push(token);
      return true;
    };
    if (!addToken(readAddress(0))) return false;
    let cursor = 20;
    for (let hop = 0; hop < hopCount; hop += 1) {
      const fee = Number.parseInt(
        raw.slice(cursor * 2, (cursor + 3) * 2),
        16,
      );
      if (!Number.isSafeInteger(fee) || fee <= 0 || fee >= 1_000_000) {
        return false;
      }
      if (!addToken(readAddress(cursor + 3))) return false;
      cursor += 23;
    }
    return (
      tokens.length === hopCount + 1 &&
      !sameAddress(tokens[0], NATIVE_TOKEN_SENTINEL) &&
      sameAddress(
        tokens[0],
        normalizedIntentToken(tokenIn, wrappedNative),
      ) &&
      sameAddress(
        tokens[tokens.length - 1],
        normalizedIntentToken(tokenOut, wrappedNative),
      )
    );
  } catch {
    return false;
  }
};

const hasCanonicalAdapterData = (
  route: UnknownRecord,
  intent: UnknownRecord,
): route is UnknownRecord & {
  adapterKind: BaseIntentV2AdapterKind;
} => {
  if (
    !isBytes(route.adapterData) ||
    !isCanonicalAddress(intent.tokenIn) ||
    !isCanonicalAddress(intent.tokenOut) ||
    !isCanonicalAddress(route.wrappedNative)
  ) {
    return false;
  }
  if (route.adapterKind === 'uniswap_v2_compatible') {
    return (
      route.adapterDataEncoding === 'abi_address_array_v1' &&
      route.quoteSource === 'standard_amm' &&
      hasCanonicalUniV2AdapterData(
        route.adapterData,
        intent.tokenIn,
        intent.tokenOut,
        route.wrappedNative,
      )
    );
  }
  if (route.adapterKind === 'uniswap_v3_swaprouter02') {
    return (
      route.adapterDataEncoding ===
        'uniswap_v3_packed_path_v1' &&
      route.quoteSource === 'v3_amm' &&
      hasCanonicalUniV3AdapterData(
        route.adapterData,
        intent.tokenIn,
        intent.tokenOut,
        route.wrappedNative,
      )
    );
  }
  return false;
};

const hasFailClosedV2Coverage = (
  response: UnknownRecord,
  route: UnknownRecord & {
    adapterKind: BaseIntentV2AdapterKind;
  },
  intent: UnknownRecord,
): boolean => {
  const coverage = response.intentRouterV2Coverage;
  if (!isObjectRecord(coverage) || !isObjectRecord(route.configEvidence)) {
    return false;
  }
  const responseHasV3 =
    Array.isArray(response.allRoutes) &&
    response.allRoutes.some(
      (candidate) =>
        isObjectRecord(candidate) &&
        candidate.adapterKind === 'uniswap_v3_swaprouter02',
    );
  const expectedPolicy = responseHasV3
      ? 'kletia_base_intent_v2_typed_adapter_v2'
      : 'kletia_base_intent_v2_typed_adapter_v1';
  return (
    coverage.policyVersion === expectedPolicy &&
    coverage.runtimeValidationStatus === 'validated' &&
    coverage.noLegacyFallback === true &&
    coverage.rankingMetric ===
      'simulation_then_guaranteed_net_minimum' &&
    coverage.observedAtBlock ===
      route.configEvidence.observedAtBlock &&
    coverage.sharedExclusiveNonce === intent.nonce &&
    typeof coverage.eligibleRouteCount === 'number' &&
    Number.isSafeInteger(coverage.eligibleRouteCount) &&
    coverage.eligibleRouteCount > 0
  );
};

const hasValidV2Economics = (
  economicsValue: unknown,
  intent: UnknownRecord,
): boolean => {
  if (!isObjectRecord(economicsValue)) return false;
  const economics = economicsValue;
  const quotedGross = parseUnsignedInteger(
    economics.quotedGrossAmountOut,
  );
  const grossMinimum = parseUnsignedInteger(
    economics.grossMinimumAfterSlippage,
  );
  const estimatedFee = parseUnsignedInteger(
    economics.estimatedFeeAtObservedRate,
  );
  const maximumFee = parseUnsignedInteger(
    economics.maximumFeeAtSignedCap,
  );
  const netMinimum = parseUnsignedInteger(
    economics.netMinimumAmountOut,
  );
  const userMinimum =
    economics.userMinimumNetAmountOut === null
      ? null
      : parseUnsignedInteger(economics.userMinimumNetAmountOut);
  if (
    quotedGross === undefined ||
    quotedGross === 0n ||
    grossMinimum === undefined ||
    grossMinimum === 0n ||
    estimatedFee === undefined ||
    maximumFee === undefined ||
    netMinimum === undefined ||
    netMinimum === 0n ||
    (
      economics.userMinimumNetAmountOut !== null &&
      (userMinimum === undefined || userMinimum === 0n)
    ) ||
    typeof economics.observedFeeBps !== 'number' ||
    !Number.isInteger(economics.observedFeeBps) ||
    economics.observedFeeBps < 0 ||
    typeof economics.maxFeeBps !== 'number' ||
    !Number.isInteger(economics.maxFeeBps) ||
    economics.maxFeeBps < economics.observedFeeBps ||
    economics.maxFeeBps > MAX_ROUTER_FEE_BPS ||
    economics.maxFeeBps !== intent.maxFeeBps ||
    typeof economics.slippageBps !== 'number' ||
    !Number.isInteger(economics.slippageBps) ||
    economics.slippageBps < 1 ||
    economics.slippageBps > 5_000 ||
    economics.netMinimumAmountOut !== intent.minAmountOut
  ) {
    return false;
  }
  const checkedUserMinimum = userMinimum ?? null;

  const expectedGrossMinimum =
    quotedGross *
    (10_000n - BigInt(economics.slippageBps)) /
    10_000n;
  const expectedEstimatedFee =
    grossMinimum *
    BigInt(economics.observedFeeBps) /
    10_000n;
  const expectedMaximumFee =
    grossMinimum *
    BigInt(economics.maxFeeBps) /
    10_000n;
  const quoteDerivedNetMinimum = grossMinimum - expectedMaximumFee;
  const expectedNetMinimum =
    checkedUserMinimum !== null &&
    checkedUserMinimum > quoteDerivedNetMinimum
      ? checkedUserMinimum
      : quoteDerivedNetMinimum;
  const expectedBindingSource =
    checkedUserMinimum !== null &&
    checkedUserMinimum > quoteDerivedNetMinimum
      ? 'user_minimum'
      : 'slippage_and_fee_cap';
  return (
    grossMinimum === expectedGrossMinimum &&
    estimatedFee === expectedEstimatedFee &&
    maximumFee === expectedMaximumFee &&
    netMinimum === expectedNetMinimum &&
    economics.bindingMinimumSource === expectedBindingSource
  );
};

export const isBaseIntentRouterV2SwapBinding = (
  responseValue: unknown,
  routeValue: unknown,
): boolean => {
  if (!isObjectRecord(responseValue) || !isObjectRecord(routeValue)) {
    return false;
  }
  const response = responseValue;
  const route = routeValue;
  const responseAction =
    typeof response.actionType === 'string' &&
    response.actionType.trim().length > 0
      ? response.actionType.trim()
      : typeof response.action === 'string'
        ? response.action.trim()
        : '';

  if (
    response.network !== 'base' ||
    response.chainId !== BASE_MAINNET_CHAIN_ID ||
    response.executionMode !== 'kletia_intent_router_v2' ||
    responseAction !== 'swap' ||
    (
      typeof response.action === 'string' &&
      response.action.trim().length > 0 &&
      response.action.trim() !== responseAction
    ) ||
    route.network !== 'base' ||
    route.chainId !== BASE_MAINNET_CHAIN_ID ||
    route.action !== 'swap' ||
    route.executionMode !== 'kletia_intent_router_v2' ||
    route.approvalPolicy !== 'explicit' ||
    route.feeRouterCompatible !== false ||
    route.callerSemantics !== 'explicit_recipient' ||
    route.simulationReturnPolicy !== undefined ||
    typeof response.requestId !== 'string' ||
    response.requestId.length === 0 ||
    response.requestId !== route.requestId ||
    !sameAddress(response.userAddress, route.userAddress) ||
    !isCanonicalAddress(route.router) ||
    !sameAddress(route.targetContract, route.router) ||
    !isCanonicalAddress(route.adapter) ||
    !isCanonicalAddress(route.underlyingTarget) ||
    !isCanonicalAddress(route.underlyingSpender) ||
    !isCanonicalAddress(route.underlyingFactory) ||
    !isCanonicalAddress(route.wrappedNative) ||
    !isObjectRecord(route.intent) ||
    !isBytes(route.adapterData) ||
    !isBytes(route.calldata)
  ) {
    return false;
  }

  const intent = route.intent;
  if (!hasCanonicalAdapterData(route, intent)) {
    return false;
  }
  const router = route.router;
  const adapter = route.adapter;
  const policyAddresses = [
    adapter,
    route.underlyingTarget,
    route.underlyingSpender,
    route.underlyingFactory,
    route.wrappedNative,
  ] as const;
  if (
    !sameAddress(intent.owner, response.userAddress) ||
    !sameAddress(intent.recipient, response.userAddress) ||
    !sameAddress(intent.adapter, adapter) ||
    !isCanonicalAddress(intent.tokenIn) ||
    !isCanonicalAddress(intent.tokenOut) ||
    sameAddress(intent.tokenIn, intent.tokenOut) ||
    !isCanonicalAddress(intent.executor) ||
    (
      !sameAddress(intent.executor, NATIVE_TOKEN_SENTINEL) &&
      !sameAddress(intent.executor, intent.owner)
    ) ||
    !isBytes32(intent.adapterConfigHash) ||
    !isBytes32(intent.adapterDataHash) ||
    !sameHex(intent.adapterDataHash, keccak256(route.adapterData)) ||
    parseUnsignedInteger(intent.amountIn) === undefined ||
    parseUnsignedInteger(intent.amountIn) === 0n ||
    parseUnsignedInteger(intent.minAmountOut) === undefined ||
    parseUnsignedInteger(intent.minAmountOut) === 0n ||
    typeof intent.maxFeeBps !== 'number' ||
    !Number.isInteger(intent.maxFeeBps) ||
    intent.maxFeeBps < 0 ||
    intent.maxFeeBps > MAX_ROUTER_FEE_BPS ||
    !hasValidIntentTimes(response, route, intent) ||
    !hasExactExplicitApproval(route, intent, router) ||
    !hasExactPolicyTargets(route.policyTargets, policyAddresses) ||
    !hasValidV2ConfigEvidence(
      route.configEvidence,
      intent,
      route.adapterKind,
    ) ||
    !hasFailClosedV2Coverage(response, route, intent) ||
    !hasValidV2Economics(route.economics, intent)
  ) {
    return false;
  }

  if (
    (
      route.primaryTokenAddress !== undefined &&
      !sameAddress(route.primaryTokenAddress, intent.tokenIn)
    ) ||
    (
      route.primaryAmountInWei !== undefined &&
      route.primaryAmountInWei !== intent.amountIn
    )
  ) {
    return false;
  }

  const forbiddenRecipientTargets = [
    router,
    ...policyAddresses,
    intent.tokenIn,
    intent.tokenOut,
  ];
  if (
    forbiddenRecipientTargets.some((target) =>
      sameAddress(intent.recipient, target),
    )
  ) {
    return false;
  }

  try {
    const decoded = decodeFunctionData({
      abi: KLETIA_INTENT_ROUTER_V2_EXECUTE_SWAP_ABI,
      data: route.calldata,
    });
    if (decoded.functionName !== 'executeSwap') return false;
    const [decodedIntent, decodedAdapterData] = decoded.args;
    const canonicalCalldata = encodeFunctionData({
      abi: KLETIA_INTENT_ROUTER_V2_EXECUTE_SWAP_ABI,
      functionName: 'executeSwap',
      args: [decodedIntent, decodedAdapterData],
    });
    if (
      !sameHex(canonicalCalldata, route.calldata) ||
      !sameHex(decodedAdapterData, route.adapterData) ||
      !sameAddress(decodedIntent.owner, intent.owner) ||
      !sameAddress(decodedIntent.tokenIn, intent.tokenIn) ||
      !sameAddress(decodedIntent.tokenOut, intent.tokenOut) ||
      parseDecodedInteger(decodedIntent.amountIn) !==
        parseUnsignedInteger(intent.amountIn) ||
      parseDecodedInteger(decodedIntent.minAmountOut) !==
        parseUnsignedInteger(intent.minAmountOut) ||
      !sameAddress(decodedIntent.recipient, intent.recipient) ||
      !sameAddress(decodedIntent.adapter, intent.adapter) ||
      !sameHex(decodedIntent.adapterConfigHash, intent.adapterConfigHash) ||
      !sameHex(decodedIntent.adapterDataHash, intent.adapterDataHash) ||
      parseDecodedInteger(decodedIntent.nonce) !==
        parseUnsignedInteger(intent.nonce) ||
      parseDecodedInteger(decodedIntent.issuedAt) !==
        parseUnsignedInteger(intent.issuedAt) ||
      parseDecodedInteger(decodedIntent.validAfter) !==
        parseUnsignedInteger(intent.validAfter) ||
      parseDecodedInteger(decodedIntent.deadline) !==
        parseUnsignedInteger(intent.deadline) ||
      !sameAddress(decodedIntent.executor, intent.executor) ||
      parseDecodedInteger(decodedIntent.maxFeeBps) !==
        BigInt(intent.maxFeeBps)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
};
