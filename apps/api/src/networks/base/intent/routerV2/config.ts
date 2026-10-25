/**
 * Field checks, adapter configuration hashes and deployment evidence
 * validation.
 */
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import {
  BASE_MAINNET_CHAIN_ID,
  BYTES32_PATTERN,
  KLETIA_SWAP_ACTION_KIND_V2,
  KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION,
  MAX_ROUTER_FEE_BPS,
  NATIVE_TOKEN_SENTINEL,
  PROTOCOL_ID_PATTERN,
  UINT256_MAX,
  UNI_V2_ADAPTER_EVIDENCE_KEYS,
  UNI_V3_ADAPTER_EVIDENCE_KEYS,
  ZERO_BYTES32,
} from "./constants.js";
import {
  type BaseIntentV2AdapterEvidence,
  type BaseIntentV2DeploymentEvidence,
  type BaseIntentV2DeploymentSchemaVersion,
  BaseIntentV2PlanError,
  type BaseSwapExecutionConfig,
} from "./types.js";

function configError(): never {
  throw new BaseIntentV2PlanError("BASE_INTENT_V2_CONFIG_INVALID");
}

export function routeError(
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

export function checkedRouteAddress(value: unknown, allowNative = false): Address {
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

export function checkedRouteUint(
  value: unknown,
  maximum: bigint = UINT256_MAX,
): bigint {
  if (typeof value !== "bigint" || value < 0n || value > maximum) {
    routeError();
  }
  return value;
}

export function sameAddress(left: Address, right: Address): boolean {
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
