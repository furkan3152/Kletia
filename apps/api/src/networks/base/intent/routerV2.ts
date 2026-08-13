import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  ERC20_EXACT_APPROVAL_ABI,
  KLETIA_INTENT_ROUTER_V2_ABI,
} from "./routerV2Abis.js";

export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const NATIVE_TOKEN_SENTINEL =
  "0x0000000000000000000000000000000000000000" as const;
export const KLETIA_SWAP_ACTION_KIND_V2 = keccak256(
  stringToHex("KLETIA_SWAP_EXACT_INPUT_V2"),
);
export const KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION = keccak256(
  stringToHex("KLETIA_UNISWAP_V3_EXACT_INPUT_PACKED_PATH_V1"),
);

const BPS_DENOMINATOR = 10_000n;
const MAX_ROUTER_FEE_BPS = 100;
const MAX_INTENT_TTL_SECONDS = 3_600n;
const UINT48_MAX = (1n << 48n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/u;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const PROTOCOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const UNI_V2_ADAPTER_EVIDENCE_KEYS = new Set([
  "kind",
  "reviewStatus",
  "protocolId",
  "enabled",
  "adapter",
  "target",
  "spender",
  "factory",
  "adapterCodehash",
  "targetCodehash",
  "spenderCodehash",
  "factoryCodehash",
  "adapterConfigurationHash",
  "adapterConfigHash",
]);
const UNI_V3_ADAPTER_EVIDENCE_KEYS = new Set([
  ...UNI_V2_ADAPTER_EVIDENCE_KEYS,
  "policyKey",
  "adapterFormatVersion",
]);
const REVIEWED_UNI_V2_ROUTE_KEYS = new Set([
  "kind",
  "reviewStatus",
  "quoteStatus",
  "chainId",
  "protocolId",
  "adapter",
  "target",
  "spender",
  "tokenIn",
  "tokenOut",
  "amountIn",
  "quotedAmountOut",
  "slippageBps",
  "path",
]);
const REVIEWED_UNI_V3_ROUTE_KEYS = new Set([
  "kind",
  "reviewStatus",
  "quoteStatus",
  "chainId",
  "protocolId",
  "adapter",
  "target",
  "spender",
  "tokenIn",
  "tokenOut",
  "amountIn",
  "quotedAmountOut",
  "slippageBps",
  "packedPath",
]);

const V3_ADDRESS_BYTES = 20;
const V3_FEE_BYTES = 3;
const V3_NEXT_HOP_BYTES = V3_ADDRESS_BYTES + V3_FEE_BYTES;
const V3_MIN_PATH_BYTES = V3_ADDRESS_BYTES + V3_NEXT_HOP_BYTES;
const V3_MAX_HOPS = 4;
const V3_MAX_PATH_BYTES = V3_ADDRESS_BYTES + V3_MAX_HOPS * V3_NEXT_HOP_BYTES;
const V3_FEE_DENOMINATOR = 1_000_000;

type PublicErrorDefinition = {
  readonly message: string;
  readonly statusCode: number;
};

const PUBLIC_ERRORS = {
  BASE_SWAP_EXECUTION_MODE_INVALID: {
    message:
      "Base swap yürütme modu açıkça legacy_v1 veya intent_v2 olarak yapılandırılmalıdır.",
    statusCode: 500,
  },
  BASE_INTENT_V2_CONFIG_INVALID: {
    message: "Base V2 işlem yapılandırması eksik veya doğrulanamadı.",
    statusCode: 503,
  },
  BASE_INTENT_V2_ROUTE_UNSUPPORTED: {
    message:
      "Bu rota etkin Base V2 typed-adapter yürütme politikası tarafından desteklenmiyor.",
    statusCode: 400,
  },
  BASE_INTENT_V2_ROUTE_INVALID: {
    message:
      "Base V2 rotası imzalanabilir alanlarla güvenli biçimde eşleştirilemedi.",
    statusCode: 400,
  },
  BASE_INTENT_V2_TIME_INVALID: {
    message: "Base V2 niyet zaman aralığı geçersiz veya bir saati aşıyor.",
    statusCode: 400,
  },
  BASE_INTENT_V2_FEE_INVALID: {
    message:
      "Base V2 ücret sınırı doğrulanmış router politikasıyla eşleşmiyor.",
    statusCode: 400,
  },
  BASE_INTENT_V2_NO_ELIGIBLE_ROUTE: {
    message:
      "Canlı tekliflerden hiçbiri etkin Base V2 typed-adapter politikasıyla eşleşmedi.",
    statusCode: 400,
  },
  BASE_INTENT_V2_NONCE_UNAVAILABLE: {
    message:
      "Base V2 niyeti için kullanılmamış bir nonce güvenli biçimde ayrılamadı.",
    statusCode: 503,
  },
  BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED: {
    message:
      "İstenen işlem sınırı Base V2 tarafından zincir üzerinde doğrulanabilir biçimde uygulanamıyor.",
    statusCode: 400,
  },
  BASE_INTENT_V2_SIMULATION_FAILED: {
    message:
      "Hiçbir Base V2 rotası canlı router simülasyonu veya approval-sonrası doğrulama politikasını geçemedi.",
    statusCode: 400,
  },
} as const satisfies Readonly<Record<string, PublicErrorDefinition>>;

export type BaseIntentV2PlanErrorCode = keyof typeof PUBLIC_ERRORS;

export class BaseIntentV2PlanError extends Error {
  readonly code: BaseIntentV2PlanErrorCode;
  readonly statusCode: number;

  constructor(code: BaseIntentV2PlanErrorCode) {
    const definition = PUBLIC_ERRORS[code];
    super(definition.message);
    this.name = "BaseIntentV2PlanError";
    this.code = code;
    this.statusCode = definition.statusCode;
  }
}

export type BaseSwapExecutionMode = "legacy_v1" | "intent_v2";

export interface BaseIntentV2UniV2AdapterEvidence {
  readonly kind: "uniswap_v2_compatible";
  readonly reviewStatus: "reviewed";
  readonly protocolId: string;
  readonly policyKey?: string;
  readonly enabled: true;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly adapterCodehash: Hex;
  readonly targetCodehash: Hex;
  readonly spenderCodehash: Hex;
  readonly factoryCodehash: Hex;
  readonly adapterConfigurationHash: Hex;
  readonly adapterConfigHash: Hex;
}

export interface BaseIntentV2UniV3AdapterEvidence {
  readonly kind: "uniswap_v3_swaprouter02";
  readonly reviewStatus: "reviewed";
  readonly protocolId: string;
  readonly policyKey: string;
  readonly enabled: true;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly adapterCodehash: Hex;
  readonly targetCodehash: Hex;
  readonly spenderCodehash: Hex;
  readonly factoryCodehash: Hex;
  readonly adapterFormatVersion: Hex;
  readonly adapterConfigurationHash: Hex;
  readonly adapterConfigHash: Hex;
}

export type BaseIntentV2AdapterEvidence =
  BaseIntentV2UniV2AdapterEvidence | BaseIntentV2UniV3AdapterEvidence;

export type BaseIntentV2DeploymentSchemaVersion =
  "kletia_base_intent_v2_deployment_v1" | "kletia_base_intent_v2_deployment_v2";

export interface BaseIntentV2DeploymentEvidence {
  readonly schemaVersion: BaseIntentV2DeploymentSchemaVersion;
  readonly validationStatus: "validated";
  readonly chainId: 8453;
  readonly observedAtBlock: bigint;
  readonly router: Address;
  readonly routerCodehash: Hex;
  readonly wrappedNative: Address;
  readonly wrappedNativeCodehash: Hex;
  readonly feeBps: number;
  readonly adapters: readonly BaseIntentV2AdapterEvidence[];
}

export interface LegacyV1ExecutionConfig {
  readonly mode: "legacy_v1";
}

export interface IntentV2ExecutionConfig {
  readonly mode: "intent_v2";
  readonly chainId: 8453;
  readonly router: Address;
  readonly deployment: BaseIntentV2DeploymentEvidence;
}

export type BaseSwapExecutionConfig =
  LegacyV1ExecutionConfig | IntentV2ExecutionConfig;

export interface ReviewedUniV2ExactInputRoute {
  readonly kind: "uniswap_v2_compatible";
  readonly reviewStatus: "reviewed";
  readonly quoteStatus: "quoted";
  readonly chainId: 8453;
  readonly protocolId: string;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly slippageBps: number;
  readonly path: readonly Address[];
}

export interface ReviewedUniV3ExactInputRoute {
  readonly kind: "uniswap_v3_swaprouter02";
  readonly reviewStatus: "reviewed";
  readonly quoteStatus: "quoted";
  readonly chainId: 8453;
  readonly protocolId: string;
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  readonly slippageBps: number;
  readonly packedPath: Hex;
}

export type ReviewedBaseIntentV2ExactInputRoute =
  ReviewedUniV2ExactInputRoute | ReviewedUniV3ExactInputRoute;

export interface BuildBaseIntentV2SwapPlanInput {
  readonly executionConfig: BaseSwapExecutionConfig;
  readonly route: ReviewedBaseIntentV2ExactInputRoute;
  readonly owner: Address;
  readonly recipient: Address;
  readonly nonce: bigint;
  readonly issuedAt: bigint;
  readonly validAfter: bigint;
  readonly deadline: bigint;
  readonly now: bigint;
  readonly executor: Address;
  readonly maxFeeBps: number;
  readonly minimumNetAmountOut?: bigint;
}

export interface BaseIntentV2SerializableSwapIntent {
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

export interface BaseIntentV2SwapPlan {
  readonly chainId: 8453;
  readonly executionMode: "kletia_intent_router_v2";
  readonly targetContract: Address;
  readonly router: Address;
  readonly adapter: Address;
  readonly adapterKind: "uniswap_v2_compatible" | "uniswap_v3_swaprouter02";
  readonly adapterDataEncoding:
    "abi_address_array_v1" | "uniswap_v3_packed_path_v1";
  readonly underlyingTarget: Address;
  readonly underlyingSpender: Address;
  readonly underlyingFactory: Address;
  readonly wrappedNative: Address;
  readonly calldata: Hex;
  readonly value: string;
  readonly adapterData: Hex;
  readonly intent: BaseIntentV2SerializableSwapIntent;
  readonly approvals: readonly {
    readonly token: Address;
    readonly spender: Address;
    readonly amount: string;
    readonly calldata: Hex;
    readonly required: true;
  }[];
  readonly policyTargets: readonly Address[];
  readonly economics: {
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
  };
  readonly configEvidence: {
    readonly schemaVersion: BaseIntentV2DeploymentSchemaVersion;
    readonly adapterKind: "uniswap_v2_compatible" | "uniswap_v3_swaprouter02";
    readonly observedAtBlock: string;
    readonly routerCodehash: Hex;
    readonly wrappedNativeCodehash: Hex;
    readonly adapterConfigHash: Hex;
    readonly adapterConfigurationHash: Hex;
  };
}

function configError(): never {
  throw new BaseIntentV2PlanError("BASE_INTENT_V2_CONFIG_INVALID");
}

function routeError(
  code:
    | "BASE_INTENT_V2_ROUTE_UNSUPPORTED"
    | "BASE_INTENT_V2_ROUTE_INVALID" = "BASE_INTENT_V2_ROUTE_INVALID",
): never {
  throw new BaseIntentV2PlanError(code);
}

function checkedAddress(value: unknown): Address {
  if (typeof value !== "string") configError();
  try {
    const address = getAddress(value);
    if (address === NATIVE_TOKEN_SENTINEL) configError();
    return address;
  } catch {
    return configError();
  }
}

function checkedRouteAddress(value: unknown, allowNative = false): Address {
  if (typeof value !== "string") routeError();
  try {
    const address = getAddress(value);
    if (!allowNative && address === NATIVE_TOKEN_SENTINEL) {
      routeError();
    }
    return address;
  } catch {
    return routeError();
  }
}

function checkedBytes32(value: unknown): Hex {
  if (
    typeof value !== "string" ||
    !BYTES32_PATTERN.test(value) ||
    value.toLowerCase() === ZERO_BYTES32
  ) {
    configError();
  }
  return value.toLowerCase() as Hex;
}

function checkedConfigUint(value: unknown, maximum: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > maximum) {
    configError();
  }
  return value;
}

function checkedRouteUint(
  value: unknown,
  maximum: bigint = UINT256_MAX,
): bigint {
  if (typeof value !== "bigint" || value < 0n || value > maximum) {
    routeError();
  }
  return value;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function checkedProtocolId(value: unknown): string {
  if (typeof value !== "string" || !PROTOCOL_ID_PATTERN.test(value)) {
    configError();
  }
  return value;
}

export function computeUniV2AdapterConfigurationHash(input: {
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly wrappedNative: Address;
  readonly targetCodehash: Hex;
  readonly factoryCodehash: Hex;
  readonly wrappedNativeCodehash: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        KLETIA_SWAP_ACTION_KIND_V2,
        input.target,
        input.spender,
        input.factory,
        input.wrappedNative,
        input.targetCodehash,
        input.factoryCodehash,
        input.wrappedNativeCodehash,
      ],
    ),
  );
}

export function computeUniV3AdapterConfigurationHash(input: {
  readonly target: Address;
  readonly spender: Address;
  readonly factory: Address;
  readonly wrappedNative: Address;
  readonly targetCodehash: Hex;
  readonly factoryCodehash: Hex;
  readonly wrappedNativeCodehash: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        KLETIA_SWAP_ACTION_KIND_V2,
        KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION,
        input.target,
        input.spender,
        input.factory,
        input.wrappedNative,
        input.targetCodehash,
        input.factoryCodehash,
        input.wrappedNativeCodehash,
      ],
    ),
  );
}

export function computeIntentV2AdapterConfigHash(input: {
  readonly adapter: Address;
  readonly target: Address;
  readonly spender: Address;
  readonly adapterCodehash: Hex;
  readonly targetCodehash: Hex;
  readonly spenderCodehash: Hex;
  readonly adapterConfigurationHash: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        KLETIA_SWAP_ACTION_KIND_V2,
        input.adapter,
        input.target,
        input.spender,
        input.adapterCodehash,
        input.targetCodehash,
        input.spenderCodehash,
        input.adapterConfigurationHash,
      ],
    ),
  );
}

function validateAdapterEvidence(
  raw: BaseIntentV2AdapterEvidence,
  wrappedNative: Address,
  wrappedNativeCodehash: Hex,
  router: Address,
  schemaVersion: BaseIntentV2DeploymentSchemaVersion,
): BaseIntentV2AdapterEvidence {
  if (
    !raw ||
    (raw.kind !== "uniswap_v2_compatible" &&
      raw.kind !== "uniswap_v3_swaprouter02") ||
    raw.reviewStatus !== "reviewed" ||
    raw.enabled !== true
  ) {
    configError();
  }
  const evidenceRecord = raw as unknown as Record<string, unknown>;
  const expectedKeys =
    raw.kind === "uniswap_v3_swaprouter02"
      ? UNI_V3_ADAPTER_EVIDENCE_KEYS
      : schemaVersion === "kletia_base_intent_v2_deployment_v2"
        ? new Set([...UNI_V2_ADAPTER_EVIDENCE_KEYS, "policyKey"])
        : UNI_V2_ADAPTER_EVIDENCE_KEYS;
  if (
    Object.keys(evidenceRecord).length !== expectedKeys.size ||
    Object.keys(evidenceRecord).some((key) => !expectedKeys.has(key))
  ) {
    configError();
  }
  const protocolId = checkedProtocolId(raw.protocolId);
  const expectedPolicyKey = `${raw.kind}:${protocolId}`;
  const policyKey = raw.policyKey;
  if (
    schemaVersion === "kletia_base_intent_v2_deployment_v1"
      ? policyKey !== undefined
      : policyKey !== expectedPolicyKey
  ) {
    configError();
  }
  const adapter = checkedAddress(raw.adapter);
  const target = checkedAddress(raw.target);
  const spender = checkedAddress(raw.spender);
  const factory = checkedAddress(raw.factory);
  const adapterCodehash = checkedBytes32(raw.adapterCodehash);
  const targetCodehash = checkedBytes32(raw.targetCodehash);
  const spenderCodehash = checkedBytes32(raw.spenderCodehash);
  const factoryCodehash = checkedBytes32(raw.factoryCodehash);
  const adapterConfigurationHash = checkedBytes32(raw.adapterConfigurationHash);
  const adapterConfigHash = checkedBytes32(raw.adapterConfigHash);
  const adapterFormatVersion =
    raw.kind === "uniswap_v3_swaprouter02"
      ? checkedBytes32(raw.adapterFormatVersion)
      : undefined;
  if (
    adapterFormatVersion !== undefined &&
    adapterFormatVersion.toLowerCase() !==
      KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION.toLowerCase()
  ) {
    configError();
  }

  if (
    !sameAddress(target, spender) ||
    targetCodehash !== spenderCodehash ||
    [adapter, target, factory].some(
      (address) =>
        sameAddress(address, wrappedNative) || sameAddress(address, router),
    ) ||
    sameAddress(adapter, target) ||
    sameAddress(adapter, factory) ||
    sameAddress(target, factory)
  ) {
    configError();
  }
  const expectedConfigurationHash =
    raw.kind === "uniswap_v2_compatible"
      ? computeUniV2AdapterConfigurationHash({
          target,
          spender,
          factory,
          wrappedNative,
          targetCodehash,
          factoryCodehash,
          wrappedNativeCodehash,
        })
      : computeUniV3AdapterConfigurationHash({
          target,
          spender,
          factory,
          wrappedNative,
          targetCodehash,
          factoryCodehash,
          wrappedNativeCodehash,
        });
  if (
    expectedConfigurationHash.toLowerCase() !==
    adapterConfigurationHash.toLowerCase()
  ) {
    configError();
  }
  const expectedConfigHash = computeIntentV2AdapterConfigHash({
    adapter,
    target,
    spender,
    adapterCodehash,
    targetCodehash,
    spenderCodehash,
    adapterConfigurationHash,
  });
  if (expectedConfigHash.toLowerCase() !== adapterConfigHash.toLowerCase()) {
    configError();
  }

  const common = {
    reviewStatus: "reviewed",
    protocolId,
    enabled: true,
    adapter,
    target,
    spender,
    factory,
    adapterCodehash,
    targetCodehash,
    spenderCodehash,
    factoryCodehash,
    adapterConfigurationHash,
    adapterConfigHash,
  } as const;
  if (raw.kind === "uniswap_v3_swaprouter02") {
    if (
      schemaVersion !== "kletia_base_intent_v2_deployment_v2" ||
      adapterFormatVersion === undefined
    ) {
      configError();
    }
    return {
      kind: "uniswap_v3_swaprouter02",
      policyKey: expectedPolicyKey,
      adapterFormatVersion,
      ...common,
    };
  }
  return {
    kind: "uniswap_v2_compatible",
    ...(schemaVersion === "kletia_base_intent_v2_deployment_v2"
      ? { policyKey: expectedPolicyKey }
      : {}),
    ...common,
  };
}

function validateDeploymentEvidence(
  raw: BaseIntentV2DeploymentEvidence | undefined,
  configuredRouter: Address,
): BaseIntentV2DeploymentEvidence {
  if (
    !raw ||
    (raw.schemaVersion !== "kletia_base_intent_v2_deployment_v1" &&
      raw.schemaVersion !== "kletia_base_intent_v2_deployment_v2") ||
    raw.validationStatus !== "validated" ||
    raw.chainId !== BASE_MAINNET_CHAIN_ID ||
    !Array.isArray(raw.adapters) ||
    raw.adapters.length === 0
  ) {
    configError();
  }
  const observedAtBlock = checkedConfigUint(raw.observedAtBlock, UINT256_MAX);
  if (observedAtBlock === 0n) configError();
  const router = checkedAddress(raw.router);
  const routerCodehash = checkedBytes32(raw.routerCodehash);
  const wrappedNative = checkedAddress(raw.wrappedNative);
  const wrappedNativeCodehash = checkedBytes32(raw.wrappedNativeCodehash);
  if (
    !sameAddress(configuredRouter, router) ||
    sameAddress(router, wrappedNative)
  ) {
    configError();
  }
  if (
    !Number.isInteger(raw.feeBps) ||
    raw.feeBps < 0 ||
    raw.feeBps > MAX_ROUTER_FEE_BPS
  ) {
    configError();
  }

  const adapters = raw.adapters.map((adapter) =>
    validateAdapterEvidence(
      adapter,
      wrappedNative,
      wrappedNativeCodehash,
      router,
      raw.schemaVersion,
    ),
  );
  if (
    raw.schemaVersion === "kletia_base_intent_v2_deployment_v1" &&
    adapters.some((adapter) => adapter.kind !== "uniswap_v2_compatible")
  ) {
    configError();
  }
  const protocolKinds = new Set<string>();
  const adapterAddresses = new Set<string>();
  for (const adapter of adapters) {
    const adapterKey = adapter.adapter.toLowerCase();
    if (
      protocolKinds.has(`${adapter.kind}:${adapter.protocolId}`) ||
      adapterAddresses.has(adapterKey)
    ) {
      configError();
    }
    protocolKinds.add(`${adapter.kind}:${adapter.protocolId}`);
    adapterAddresses.add(adapterKey);
  }

  return {
    schemaVersion: raw.schemaVersion,
    validationStatus: "validated",
    chainId: BASE_MAINNET_CHAIN_ID,
    observedAtBlock,
    router,
    routerCodehash,
    wrappedNative,
    wrappedNativeCodehash,
    feeBps: raw.feeBps,
    adapters,
  };
}

export function resolveBaseSwapExecutionConfig(
  environment: Readonly<Record<string, string | undefined>>,
  deploymentEvidence?: BaseIntentV2DeploymentEvidence,
): BaseSwapExecutionConfig {
  const mode = environment.BASE_SWAP_EXECUTION_MODE?.trim();
  if (mode !== "legacy_v1" && mode !== "intent_v2") {
    throw new BaseIntentV2PlanError("BASE_SWAP_EXECUTION_MODE_INVALID");
  }
  if (mode === "legacy_v1") return { mode };

  const router = checkedAddress(
    environment.KLETIA_INTENT_ROUTER_V2_ADDRESS?.trim(),
  );
  const deployment = validateDeploymentEvidence(deploymentEvidence, router);
  return {
    mode: "intent_v2",
    chainId: BASE_MAINNET_CHAIN_ID,
    router,
    deployment,
  };
}

function requireIntentV2Config(
  config: BaseSwapExecutionConfig,
): IntentV2ExecutionConfig {
  if (config.mode !== "intent_v2") {
    routeError("BASE_INTENT_V2_ROUTE_UNSUPPORTED");
  }
  return config;
}

function findRouteAdapter(
  deployment: BaseIntentV2DeploymentEvidence,
  route: ReviewedBaseIntentV2ExactInputRoute,
): BaseIntentV2AdapterEvidence {
  const protocolId =
    typeof route.protocolId === "string" ? route.protocolId : "";
  const match = deployment.adapters.find(
    (candidate) =>
      candidate.kind === route.kind &&
      candidate.protocolId === protocolId &&
      sameAddress(candidate.adapter, route.adapter) &&
      sameAddress(candidate.target, route.target) &&
      sameAddress(candidate.spender, route.spender),
  );
  if (!match) routeError();
  return match;
}

export interface DecodedUniV3PackedPath {
  readonly packedPath: Hex;
  readonly tokens: readonly Address[];
  readonly fees: readonly number[];
}

/**
 * Decodes only the canonical Uniswap V3 forward exact-input path layout.
 * It rejects arbitrary bytes, repeated/zero tokens, invalid fees and more than
 * four pools before any value can become signed adapter data.
 */
export function decodeUniV3PackedPath(value: unknown): DecodedUniV3PackedPath {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    routeError();
  }
  const packedPath = value.toLowerCase() as Hex;
  const raw = packedPath.slice(2);
  const byteLength = raw.length / 2;
  if (
    byteLength < V3_MIN_PATH_BYTES ||
    byteLength > V3_MAX_PATH_BYTES ||
    (byteLength - V3_ADDRESS_BYTES) % V3_NEXT_HOP_BYTES !== 0
  ) {
    routeError();
  }

  const hopCount = (byteLength - V3_ADDRESS_BYTES) / V3_NEXT_HOP_BYTES;
  const tokens: Address[] = [];
  const fees: number[] = [];
  const seenTokens = new Set<string>();
  const readAddress = (byteOffset: number): Address =>
    checkedRouteAddress(
      `0x${raw.slice(byteOffset * 2, (byteOffset + V3_ADDRESS_BYTES) * 2)}`,
    );
  const addToken = (token: Address): void => {
    const key = token.toLowerCase();
    if (seenTokens.has(key)) routeError();
    seenTokens.add(key);
    tokens.push(token);
  };

  addToken(readAddress(0));
  let cursor = V3_ADDRESS_BYTES;
  for (let hop = 0; hop < hopCount; hop += 1) {
    const fee = Number.parseInt(
      raw.slice(cursor * 2, (cursor + V3_FEE_BYTES) * 2),
      16,
    );
    if (!Number.isSafeInteger(fee) || fee <= 0 || fee >= V3_FEE_DENOMINATOR) {
      routeError();
    }
    fees.push(fee);
    addToken(readAddress(cursor + V3_FEE_BYTES));
    cursor += V3_NEXT_HOP_BYTES;
  }
  if (tokens.length !== fees.length + 1) routeError();
  return { packedPath, tokens, fees };
}

function validateRouteShape(
  route: ReviewedBaseIntentV2ExactInputRoute,
  deployment: BaseIntentV2DeploymentEvidence,
): {
  readonly route: ReviewedBaseIntentV2ExactInputRoute;
  readonly adapter: BaseIntentV2AdapterEvidence;
  readonly normalizedTokenIn: Address;
  readonly normalizedTokenOut: Address;
  readonly routeTokens: readonly Address[];
  readonly adapterData: Hex;
  readonly adapterDataEncoding:
    "abi_address_array_v1" | "uniswap_v3_packed_path_v1";
} {
  const runtimeRoute = route as unknown as Record<string, unknown>;
  if (
    !route ||
    (route.kind !== "uniswap_v2_compatible" &&
      route.kind !== "uniswap_v3_swaprouter02") ||
    route.reviewStatus !== "reviewed" ||
    route.quoteStatus !== "quoted" ||
    Object.keys(runtimeRoute).some(
      (key) =>
        !(
          route.kind === "uniswap_v2_compatible"
            ? REVIEWED_UNI_V2_ROUTE_KEYS
            : REVIEWED_UNI_V3_ROUTE_KEYS
        ).has(key),
    )
  ) {
    routeError("BASE_INTENT_V2_ROUTE_UNSUPPORTED");
  }
  if (route.chainId !== BASE_MAINNET_CHAIN_ID) routeError();
  const adapter = checkedRouteAddress(route.adapter);
  const target = checkedRouteAddress(route.target);
  const spender = checkedRouteAddress(route.spender);
  const tokenIn = checkedRouteAddress(route.tokenIn, true);
  const tokenOut = checkedRouteAddress(route.tokenOut, true);
  if (sameAddress(tokenIn, tokenOut)) routeError();
  if (
    typeof route.protocolId !== "string" ||
    !PROTOCOL_ID_PATTERN.test(route.protocolId)
  ) {
    routeError();
  }
  const amountIn = checkedRouteUint(route.amountIn);
  const quotedAmountOut = checkedRouteUint(route.quotedAmountOut);
  if (amountIn === 0n || quotedAmountOut === 0n) routeError();
  if (
    !Number.isInteger(route.slippageBps) ||
    route.slippageBps < 1 ||
    route.slippageBps > 5_000
  ) {
    routeError();
  }
  const normalizedTokenIn =
    tokenIn === NATIVE_TOKEN_SENTINEL ? deployment.wrappedNative : tokenIn;
  const normalizedTokenOut =
    tokenOut === NATIVE_TOKEN_SENTINEL ? deployment.wrappedNative : tokenOut;
  if (sameAddress(normalizedTokenIn, normalizedTokenOut)) {
    routeError();
  }

  if (route.kind === "uniswap_v2_compatible") {
    if (
      !Array.isArray(route.path) ||
      route.path.length < 2 ||
      route.path.length > 5
    ) {
      routeError();
    }
    const path = route.path.map((token) => checkedRouteAddress(token));
    const pathTokens = new Set<string>();
    for (const pathToken of path) {
      const key = pathToken.toLowerCase();
      if (pathTokens.has(key)) routeError();
      pathTokens.add(key);
    }
    if (
      !sameAddress(path[0], normalizedTokenIn) ||
      !sameAddress(path[path.length - 1], normalizedTokenOut)
    ) {
      routeError();
    }
    const normalizedRoute: ReviewedUniV2ExactInputRoute = {
      kind: "uniswap_v2_compatible",
      reviewStatus: "reviewed",
      quoteStatus: "quoted",
      chainId: BASE_MAINNET_CHAIN_ID,
      protocolId: route.protocolId,
      adapter,
      target,
      spender,
      tokenIn,
      tokenOut,
      amountIn,
      quotedAmountOut,
      slippageBps: route.slippageBps,
      path,
    };
    return {
      route: normalizedRoute,
      adapter: findRouteAdapter(deployment, normalizedRoute),
      normalizedTokenIn,
      normalizedTokenOut,
      routeTokens: path,
      adapterData: encodeAbiParameters([{ type: "address[]" }], [path]),
      adapterDataEncoding: "abi_address_array_v1",
    };
  }

  const decodedPath = decodeUniV3PackedPath(route.packedPath);
  if (
    !sameAddress(decodedPath.tokens[0], normalizedTokenIn) ||
    !sameAddress(
      decodedPath.tokens[decodedPath.tokens.length - 1],
      normalizedTokenOut,
    )
  ) {
    routeError();
  }
  const normalizedRoute: ReviewedUniV3ExactInputRoute = {
    kind: "uniswap_v3_swaprouter02",
    reviewStatus: "reviewed",
    quoteStatus: "quoted",
    chainId: BASE_MAINNET_CHAIN_ID,
    protocolId: route.protocolId,
    adapter,
    target,
    spender,
    tokenIn,
    tokenOut,
    amountIn,
    quotedAmountOut,
    slippageBps: route.slippageBps,
    packedPath: decodedPath.packedPath,
  };
  return {
    route: normalizedRoute,
    adapter: findRouteAdapter(deployment, normalizedRoute),
    normalizedTokenIn,
    normalizedTokenOut,
    routeTokens: decodedPath.tokens,
    adapterData: decodedPath.packedPath,
    adapterDataEncoding: "uniswap_v3_packed_path_v1",
  };
}

function checkedIntentTimes(input: BuildBaseIntentV2SwapPlanInput): {
  readonly nonce: bigint;
  readonly issuedAt: bigint;
  readonly validAfter: bigint;
  readonly deadline: bigint;
  readonly now: bigint;
} {
  try {
    const nonce = checkedRouteUint(input.nonce);
    const issuedAt = checkedRouteUint(input.issuedAt, UINT48_MAX);
    const validAfter = checkedRouteUint(input.validAfter, UINT48_MAX);
    const deadline = checkedRouteUint(input.deadline, UINT48_MAX);
    const now = checkedRouteUint(input.now, UINT48_MAX);
    if (
      issuedAt === 0n ||
      issuedAt > now ||
      issuedAt > validAfter ||
      validAfter > deadline ||
      deadline <= now ||
      deadline - issuedAt > MAX_INTENT_TTL_SECONDS
    ) {
      throw new BaseIntentV2PlanError("BASE_INTENT_V2_TIME_INVALID");
    }
    return {
      nonce,
      issuedAt,
      validAfter,
      deadline,
      now,
    };
  } catch (error) {
    if (
      error instanceof BaseIntentV2PlanError &&
      error.code === "BASE_INTENT_V2_TIME_INVALID"
    ) {
      throw error;
    }
    throw new BaseIntentV2PlanError("BASE_INTENT_V2_TIME_INVALID");
  }
}

function checkedFeePolicy(maxFeeBps: unknown, observedFeeBps: number): number {
  if (
    !Number.isInteger(maxFeeBps) ||
    Number(maxFeeBps) < observedFeeBps ||
    Number(maxFeeBps) > MAX_ROUTER_FEE_BPS
  ) {
    throw new BaseIntentV2PlanError("BASE_INTENT_V2_FEE_INVALID");
  }
  return Number(maxFeeBps);
}

export function buildBaseIntentV2SwapPlan(
  input: BuildBaseIntentV2SwapPlanInput,
): BaseIntentV2SwapPlan {
  const config = requireIntentV2Config(input.executionConfig);
  const checked = validateRouteShape(input.route, config.deployment);
  const owner = checkedRouteAddress(input.owner);
  const recipient = checkedRouteAddress(input.recipient);
  const executor = checkedRouteAddress(input.executor, true);
  if (executor !== NATIVE_TOKEN_SENTINEL && !sameAddress(executor, owner)) {
    routeError();
  }
  const forbiddenRecipients = [
    config.router,
    config.deployment.wrappedNative,
    checked.adapter.adapter,
    checked.adapter.target,
    checked.adapter.spender,
    checked.normalizedTokenIn,
    checked.normalizedTokenOut,
  ];
  if (forbiddenRecipients.some((address) => sameAddress(address, recipient))) {
    routeError();
  }
  const times = checkedIntentTimes(input);
  const maxFeeBps = checkedFeePolicy(input.maxFeeBps, config.deployment.feeBps);

  const grossMinimumAfterSlippage =
    (checked.route.quotedAmountOut *
      (BPS_DENOMINATOR - BigInt(checked.route.slippageBps))) /
    BPS_DENOMINATOR;
  const estimatedFeeAtObservedRate =
    (grossMinimumAfterSlippage * BigInt(config.deployment.feeBps)) /
    BPS_DENOMINATOR;
  const maximumFeeAtSignedCap =
    (grossMinimumAfterSlippage * BigInt(maxFeeBps)) / BPS_DENOMINATOR;
  const quoteDerivedNetMinimum =
    grossMinimumAfterSlippage - maximumFeeAtSignedCap;
  let userMinimumNetAmountOut: bigint | null = null;
  if (input.minimumNetAmountOut !== undefined) {
    userMinimumNetAmountOut = checkedRouteUint(input.minimumNetAmountOut);
    if (userMinimumNetAmountOut === 0n) routeError();

    const maximumQuotedNetAfterSignedFeeCap =
      checked.route.quotedAmountOut -
      (checked.route.quotedAmountOut * BigInt(maxFeeBps)) / BPS_DENOMINATOR;
    if (userMinimumNetAmountOut > maximumQuotedNetAfterSignedFeeCap) {
      routeError();
    }
  }
  const netMinimumAmountOut =
    userMinimumNetAmountOut !== null &&
    userMinimumNetAmountOut > quoteDerivedNetMinimum
      ? userMinimumNetAmountOut
      : quoteDerivedNetMinimum;
  if (grossMinimumAfterSlippage === 0n || netMinimumAmountOut === 0n) {
    routeError();
  }

  const adapterData = checked.adapterData;
  const adapterDataHash = keccak256(adapterData);
  const contractIntent = {
    owner,
    tokenIn: checked.route.tokenIn,
    tokenOut: checked.route.tokenOut,
    amountIn: checked.route.amountIn,
    minAmountOut: netMinimumAmountOut,
    recipient,
    adapter: checked.adapter.adapter,
    adapterConfigHash: checked.adapter.adapterConfigHash,
    adapterDataHash,
    nonce: times.nonce,
    issuedAt: Number(times.issuedAt),
    validAfter: Number(times.validAfter),
    deadline: Number(times.deadline),
    executor,
    maxFeeBps,
  } as const;
  const calldata = encodeFunctionData({
    abi: KLETIA_INTENT_ROUTER_V2_ABI,
    functionName: "executeSwap",
    args: [contractIntent, adapterData],
  });
  const isNativeInput = checked.route.tokenIn === NATIVE_TOKEN_SENTINEL;
  const approvals = isNativeInput
    ? []
    : [
        {
          token: checked.route.tokenIn,
          spender: config.router,
          amount: checked.route.amountIn.toString(),
          calldata: encodeFunctionData({
            abi: ERC20_EXACT_APPROVAL_ABI,
            functionName: "approve",
            args: [config.router, checked.route.amountIn],
          }),
          required: true as const,
        },
      ];

  return {
    chainId: BASE_MAINNET_CHAIN_ID,
    executionMode: "kletia_intent_router_v2",
    targetContract: config.router,
    router: config.router,
    adapter: checked.adapter.adapter,
    adapterKind: checked.adapter.kind,
    adapterDataEncoding: checked.adapterDataEncoding,
    underlyingTarget: checked.adapter.target,
    underlyingSpender: checked.adapter.spender,
    underlyingFactory: checked.adapter.factory,
    wrappedNative: config.deployment.wrappedNative,
    calldata,
    value: isNativeInput ? checked.route.amountIn.toString() : "0",
    adapterData,
    intent: {
      owner,
      tokenIn: checked.route.tokenIn,
      tokenOut: checked.route.tokenOut,
      amountIn: checked.route.amountIn.toString(),
      minAmountOut: netMinimumAmountOut.toString(),
      recipient,
      adapter: checked.adapter.adapter,
      adapterConfigHash: checked.adapter.adapterConfigHash,
      adapterDataHash,
      nonce: times.nonce.toString(),
      issuedAt: times.issuedAt.toString(),
      validAfter: times.validAfter.toString(),
      deadline: times.deadline.toString(),
      executor,
      maxFeeBps,
    },
    approvals,
    policyTargets: [
      ...new Map(
        [
          checked.adapter.adapter,
          checked.adapter.target,
          checked.adapter.spender,
          checked.adapter.factory,
          config.deployment.wrappedNative,
        ].map((address) => [address.toLowerCase(), address]),
      ).values(),
    ],
    economics: {
      quotedGrossAmountOut: checked.route.quotedAmountOut.toString(),
      grossMinimumAfterSlippage: grossMinimumAfterSlippage.toString(),
      estimatedFeeAtObservedRate: estimatedFeeAtObservedRate.toString(),
      maximumFeeAtSignedCap: maximumFeeAtSignedCap.toString(),
      netMinimumAmountOut: netMinimumAmountOut.toString(),
      userMinimumNetAmountOut: userMinimumNetAmountOut?.toString() ?? null,
      bindingMinimumSource:
        userMinimumNetAmountOut !== null &&
        userMinimumNetAmountOut > quoteDerivedNetMinimum
          ? "user_minimum"
          : "slippage_and_fee_cap",
      observedFeeBps: config.deployment.feeBps,
      maxFeeBps,
      slippageBps: checked.route.slippageBps,
    },
    configEvidence: {
      schemaVersion: config.deployment.schemaVersion,
      adapterKind: checked.adapter.kind,
      observedAtBlock: config.deployment.observedAtBlock.toString(),
      routerCodehash: config.deployment.routerCodehash,
      wrappedNativeCodehash: config.deployment.wrappedNativeCodehash,
      adapterConfigHash: checked.adapter.adapterConfigHash,
      adapterConfigurationHash: checked.adapter.adapterConfigurationHash,
    },
  };
}
