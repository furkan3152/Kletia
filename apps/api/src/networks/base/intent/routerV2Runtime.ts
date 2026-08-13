import {
  getAddress,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  BASE_MAINNET_CHAIN_ID,
  BaseIntentV2PlanError,
  KLETIA_SWAP_ACTION_KIND_V2,
  KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION,
  resolveBaseSwapExecutionConfig,
  type BaseIntentV2AdapterEvidence,
  type BaseIntentV2DeploymentEvidence,
  type IntentV2ExecutionConfig,
} from "./routerV2.js";
import {
  KLETIA_INTENT_ROUTER_V2_RUNTIME_ABI,
  KLETIA_UNISWAP_V2_ADAPTER_RUNTIME_ABI,
  KLETIA_UNISWAP_V3_ADAPTER_RUNTIME_ABI,
  UNISWAP_V2_ROUTER02_RUNTIME_ABI,
  UNISWAP_V3_SWAP_ROUTER02_RUNTIME_ABI,
} from "./routerV2RuntimeAbis.js";

const MAX_ROUTER_FEE_BPS = 100;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const RUNTIME_CODE_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type BaseIntentV2RuntimeInput =
  IntentV2ExecutionConfig | BaseIntentV2DeploymentEvidence;

export type BaseIntentV2RuntimePublicClient = Pick<
  PublicClient,
  "getBlockNumber" | "getChainId" | "getCode" | "readContract"
>;

type RuntimeReadParameters = {
  readonly address: Address;
  readonly abi: Abi;
  readonly functionName: string;
  readonly args?: readonly unknown[];
  readonly blockNumber: bigint;
};

type RuntimeRead = (parameters: RuntimeReadParameters) => Promise<unknown>;

function configError(): never {
  throw new BaseIntentV2PlanError("BASE_INTENT_V2_CONFIG_INVALID");
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function checkedAddress(value: unknown): Address {
  if (typeof value !== "string") configError();
  try {
    const address = getAddress(value);
    if (address.toLowerCase() === ZERO_ADDRESS) configError();
    return address;
  } catch {
    return configError();
  }
}

function checkedBytes32(value: unknown): Hex {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
    configError();
  }
  return value.toLowerCase() as Hex;
}

function checkedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") configError();
  return value;
}

function checkedFeeBps(value: unknown): number {
  const fee =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : configError();
  if (fee < 0n || fee > BigInt(MAX_ROUTER_FEE_BPS)) {
    configError();
  }
  return Number(fee);
}

function checkedBlockNumber(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    configError();
  }
  return value;
}

function checkedRuntimeCode(value: unknown): Hex {
  if (typeof value !== "string" || !RUNTIME_CODE_PATTERN.test(value)) {
    configError();
  }
  return value.toLowerCase() as Hex;
}

function checkedAdapterConfigTuple(
  value: unknown,
): readonly [boolean, boolean, Address, Address, Hex, Hex, Hex, Hex, Hex] {
  if (!Array.isArray(value) || value.length !== 9) {
    configError();
  }
  return [
    checkedBoolean(value[0]),
    checkedBoolean(value[1]),
    checkedAddress(value[2]),
    checkedAddress(value[3]),
    checkedBytes32(value[4]),
    checkedBytes32(value[5]),
    checkedBytes32(value[6]),
    checkedBytes32(value[7]),
    checkedBytes32(value[8]),
  ];
}

function normalizeInput(
  input: BaseIntentV2RuntimeInput,
): IntentV2ExecutionConfig {
  if (!input || typeof input !== "object") configError();
  const record = input as unknown as Record<string, unknown>;

  let configuredRouter: Address;
  let deployment: BaseIntentV2DeploymentEvidence;
  if ("mode" in record) {
    if (
      record.mode !== "intent_v2" ||
      record.chainId !== BASE_MAINNET_CHAIN_ID
    ) {
      configError();
    }
    configuredRouter = checkedAddress(record.router);
    if (!record.deployment || typeof record.deployment !== "object") {
      configError();
    }
    deployment = record.deployment as BaseIntentV2DeploymentEvidence;
  } else {
    configuredRouter = checkedAddress(record.router);
    deployment = input as BaseIntentV2DeploymentEvidence;
  }

  const resolved = resolveBaseSwapExecutionConfig(
    {
      BASE_SWAP_EXECUTION_MODE: "intent_v2",
      KLETIA_INTENT_ROUTER_V2_ADDRESS: configuredRouter,
    },
    deployment,
  );
  if (resolved.mode !== "intent_v2") configError();
  return resolved;
}

function requireDistinctDeploymentIdentities(
  deployment: BaseIntentV2DeploymentEvidence,
): void {
  const occupied = new Map<string, string>();
  const reserve = (address: Address, role: string) => {
    const key = address.toLowerCase();
    if (occupied.has(key)) configError();
    occupied.set(key, role);
  };

  reserve(deployment.router, "router");
  reserve(deployment.wrappedNative, "wrapped-native");
  for (const adapter of deployment.adapters) {
    reserve(adapter.adapter, `adapter:${adapter.protocolId}`);
    reserve(adapter.target, `target:${adapter.protocolId}`);
    reserve(adapter.factory, `factory:${adapter.protocolId}`);
  }
}

async function requireRuntimeCode(
  client: BaseIntentV2RuntimePublicClient,
  address: Address,
  expectedCodehash: Hex,
  blockNumber: bigint,
): Promise<void> {
  const code = checkedRuntimeCode(
    await client.getCode({ address, blockNumber }),
  );
  if (!sameHex(keccak256(code), expectedCodehash)) {
    configError();
  }
}

async function validateRouterState(
  read: RuntimeRead,
  deployment: BaseIntentV2DeploymentEvidence,
  blockNumber: bigint,
): Promise<number> {
  const readRouter = (functionName: string, args?: readonly unknown[]) =>
    read({
      address: deployment.router,
      abi: KLETIA_INTENT_ROUTER_V2_RUNTIME_ABI,
      functionName,
      args,
      blockNumber,
    });

  const [
    wrappedNativeResult,
    wrappedNativeCodehashResult,
    feeBpsResult,
    pausedResult,
    ...adapterConfigResults
  ] = await Promise.all([
    readRouter("wrappedNative"),
    readRouter("wrappedNativeCodehash"),
    readRouter("feeBps"),
    readRouter("paused"),
    ...deployment.adapters.map((adapter) =>
      readRouter("adapterConfig", [adapter.adapter]),
    ),
  ]);

  if (
    !sameAddress(
      checkedAddress(wrappedNativeResult),
      deployment.wrappedNative,
    ) ||
    !sameHex(
      checkedBytes32(wrappedNativeCodehashResult),
      deployment.wrappedNativeCodehash,
    ) ||
    checkedBoolean(pausedResult)
  ) {
    configError();
  }
  const feeBps = checkedFeeBps(feeBpsResult);

  deployment.adapters.forEach((adapter, index) => {
    const [
      configured,
      enabled,
      target,
      spender,
      adapterCodehash,
      targetCodehash,
      spenderCodehash,
      adapterConfigurationHash,
      configHash,
    ] = checkedAdapterConfigTuple(adapterConfigResults[index]);
    if (
      !configured ||
      !enabled ||
      !sameAddress(target, adapter.target) ||
      !sameAddress(spender, adapter.spender) ||
      !sameHex(adapterCodehash, adapter.adapterCodehash) ||
      !sameHex(targetCodehash, adapter.targetCodehash) ||
      !sameHex(spenderCodehash, adapter.spenderCodehash) ||
      !sameHex(adapterConfigurationHash, adapter.adapterConfigurationHash) ||
      !sameHex(configHash, adapter.adapterConfigHash)
    ) {
      configError();
    }
  });

  return feeBps;
}

async function validateAdapterState(
  read: RuntimeRead,
  adapter: BaseIntentV2AdapterEvidence,
  deployment: BaseIntentV2DeploymentEvidence,
  blockNumber: bigint,
): Promise<void> {
  const isUniV3 = adapter.kind === "uniswap_v3_swaprouter02";
  const adapterAbi = isUniV3
    ? KLETIA_UNISWAP_V3_ADAPTER_RUNTIME_ABI
    : KLETIA_UNISWAP_V2_ADAPTER_RUNTIME_ABI;
  const routerAbi = isUniV3
    ? UNISWAP_V3_SWAP_ROUTER02_RUNTIME_ABI
    : UNISWAP_V2_ROUTER02_RUNTIME_ABI;
  const readAdapter = (functionName: string) =>
    read({
      address: adapter.adapter,
      abi: adapterAbi,
      functionName,
      blockNumber,
    });
  const readRouter02 = (functionName: string) =>
    read({
      address: adapter.target,
      abi: routerAbi,
      functionName,
      blockNumber,
    });

  const [
    actionKindResult,
    targetResult,
    spenderResult,
    factoryResult,
    wrappedNativeResult,
    targetCodehashResult,
    factoryCodehashResult,
    wrappedNativeCodehashResult,
    configurationHashResult,
    routerFactoryResult,
    routerWrappedNativeResult,
    adapterFormatVersionResult,
  ] = await Promise.all([
    readAdapter("actionKind"),
    readAdapter("target"),
    readAdapter("spender"),
    readAdapter("factory"),
    readAdapter("wrappedNative"),
    readAdapter("targetCodehash"),
    readAdapter("factoryCodehash"),
    readAdapter("wrappedNativeCodehash"),
    readAdapter("configurationHash"),
    readRouter02("factory"),
    readRouter02(isUniV3 ? "WETH9" : "WETH"),
    isUniV3 ? readAdapter("ADAPTER_FORMAT_VERSION") : Promise.resolve(null),
  ]);

  if (
    !sameHex(checkedBytes32(actionKindResult), KLETIA_SWAP_ACTION_KIND_V2) ||
    !sameAddress(checkedAddress(targetResult), adapter.target) ||
    !sameAddress(checkedAddress(spenderResult), adapter.spender) ||
    !sameAddress(checkedAddress(factoryResult), adapter.factory) ||
    !sameAddress(
      checkedAddress(wrappedNativeResult),
      deployment.wrappedNative,
    ) ||
    !sameHex(checkedBytes32(targetCodehashResult), adapter.targetCodehash) ||
    !sameHex(checkedBytes32(factoryCodehashResult), adapter.factoryCodehash) ||
    !sameHex(
      checkedBytes32(wrappedNativeCodehashResult),
      deployment.wrappedNativeCodehash,
    ) ||
    !sameHex(
      checkedBytes32(configurationHashResult),
      adapter.adapterConfigurationHash,
    ) ||
    !sameAddress(checkedAddress(routerFactoryResult), adapter.factory) ||
    !sameAddress(
      checkedAddress(routerWrappedNativeResult),
      deployment.wrappedNative,
    ) ||
    (isUniV3 &&
      (!sameHex(
        checkedBytes32(adapterFormatVersionResult),
        KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION,
      ) ||
        !sameHex(
          checkedBytes32(adapterFormatVersionResult),
          adapter.kind === "uniswap_v3_swaprouter02"
            ? adapter.adapterFormatVersion
            : KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION,
        )))
  ) {
    configError();
  }
}

async function validateRuntimeUnsafe(
  input: BaseIntentV2RuntimeInput,
  client: BaseIntentV2RuntimePublicClient,
): Promise<BaseIntentV2DeploymentEvidence> {
  const config = normalizeInput(input);
  const deployment = config.deployment;
  requireDistinctDeploymentIdentities(deployment);

  const chainId = await client.getChainId();
  if (chainId !== BASE_MAINNET_CHAIN_ID) configError();
  const blockNumber = checkedBlockNumber(await client.getBlockNumber());
  if (deployment.observedAtBlock > blockNumber) configError();

  const read = client.readContract.bind(client) as unknown as RuntimeRead;

  await Promise.all([
    requireRuntimeCode(
      client,
      deployment.router,
      deployment.routerCodehash,
      blockNumber,
    ),
    requireRuntimeCode(
      client,
      deployment.wrappedNative,
      deployment.wrappedNativeCodehash,
      blockNumber,
    ),
    ...deployment.adapters.flatMap((adapter) => [
      requireRuntimeCode(
        client,
        adapter.adapter,
        adapter.adapterCodehash,
        blockNumber,
      ),
      requireRuntimeCode(
        client,
        adapter.target,
        adapter.targetCodehash,
        blockNumber,
      ),
      requireRuntimeCode(
        client,
        adapter.spender,
        adapter.spenderCodehash,
        blockNumber,
      ),
      requireRuntimeCode(
        client,
        adapter.factory,
        adapter.factoryCodehash,
        blockNumber,
      ),
    ]),
  ]);

  const [feeBps] = await Promise.all([
    validateRouterState(read, deployment, blockNumber),
    ...deployment.adapters.map((adapter) =>
      validateAdapterState(read, adapter, deployment, blockNumber),
    ),
  ]);

  return {
    schemaVersion: deployment.schemaVersion,
    validationStatus: "validated",
    chainId: BASE_MAINNET_CHAIN_ID,
    observedAtBlock: blockNumber,
    router: deployment.router,
    routerCodehash: deployment.routerCodehash,
    wrappedNative: deployment.wrappedNative,
    wrappedNativeCodehash: deployment.wrappedNativeCodehash,
    feeBps,
    adapters: deployment.adapters.map((adapter) => ({
      ...adapter,
    })),
  };
}

export async function validateBaseIntentV2Runtime(
  input: BaseIntentV2RuntimeInput,
  client: BaseIntentV2RuntimePublicClient,
): Promise<BaseIntentV2DeploymentEvidence> {
  try {
    return await validateRuntimeUnsafe(input, client);
  } catch {
    return configError();
  }
}
