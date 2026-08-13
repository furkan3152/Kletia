import { getAddress, type Address, type Hex } from "viem";

export const BASE_TOKEN_DEPLOYMENT_MODE_ENV = "BASE_TOKEN_DEPLOYMENT_MODE";
export const BASE_LAUNCH_FACTORY_V2_ADDRESS_ENV =
  "KLETIA_LAUNCH_FACTORY_V2_ADDRESS";
export const BASE_LAUNCH_FACTORY_V2_EVIDENCE_ENV =
  "KLETIA_LAUNCH_FACTORY_V2_EVIDENCE_JSON";

export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const LEGACY_KLETIA_TOKEN_FACTORY = getAddress(
  "0x69d1cfca1916a310edba69a6becd1702c7ac8d64",
);
export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
const EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "validationStatus",
  "chainId",
  "observedAtBlock",
  "factory",
  "factoryCodehash",
  "ownerTimelock",
  "ownerTimelockCodehash",
  "ownerTimelockMinDelay",
  "treasurySafe",
  "treasurySafeCodehash",
  "pendingTreasury",
  "factoryFeeCap",
  "maxTokenSupply",
  "maxNameBytes",
  "maxSymbolBytes",
]);

export type BaseTokenDeploymentMode = "legacy_v1" | "launch_v2";

export interface BaseLaunchFactoryV2DeploymentEvidence {
  readonly schemaVersion: "kletia_launch_factory_v2_deployment_v1";
  readonly validationStatus: "validated";
  readonly chainId: 8453;
  readonly observedAtBlock: bigint;
  readonly factory: Address;
  readonly factoryCodehash: Hex;
  readonly ownerTimelock: Address;
  readonly ownerTimelockCodehash: Hex;
  readonly ownerTimelockMinDelay: bigint;
  readonly treasurySafe: Address;
  readonly treasurySafeCodehash: Hex;
  readonly pendingTreasury: typeof ZERO_ADDRESS;
  readonly factoryFeeCap: bigint;
  readonly maxTokenSupply: bigint;
  readonly maxNameBytes: bigint;
  readonly maxSymbolBytes: bigint;
}

export interface LegacyTokenDeploymentConfig {
  readonly mode: "legacy_v1";
  readonly factory: Address;
}

export interface LaunchFactoryV2TokenDeploymentConfig {
  readonly mode: "launch_v2";
  readonly chainId: 8453;
  readonly factory: Address;
  readonly deployment: BaseLaunchFactoryV2DeploymentEvidence;
}

export type BaseTokenDeploymentConfig =
  LegacyTokenDeploymentConfig | LaunchFactoryV2TokenDeploymentConfig;

type Environment = Readonly<Record<string, string | undefined>>;

const PUBLIC_ERRORS = {
  BASE_TOKEN_DEPLOYMENT_MODE_REQUIRED: {
    message:
      "Base token deployment modu production ortamında açıkça yapılandırılmalıdır.",
    statusCode: 503,
  },
  BASE_TOKEN_DEPLOYMENT_MODE_INVALID: {
    message: "Base token deployment modu legacy_v1 veya launch_v2 olmalıdır.",
    statusCode: 500,
  },
  BASE_LAUNCH_FACTORY_V2_CONFIG_INVALID: {
    message: "Base Launch Factory V2 dağıtım kanıtı eksik veya doğrulanamadı.",
    statusCode: 503,
  },
  BASE_LAUNCH_FACTORY_V2_RUNTIME_INVALID: {
    message:
      "Base Launch Factory V2 canlı zincir kimliği güvenli biçimde doğrulanamadı.",
    statusCode: 503,
  },
  TOKEN_LAUNCH_INPUT_INVALID: {
    message:
      "Token adı, sembolü, arzı veya launch kimliği güvenli biçimde doğrulanamadı.",
    statusCode: 400,
  },
  TOKEN_LAUNCH_SALT_ALREADY_USED: {
    message:
      "Bu cüzdan için seçilen token launch kimliği daha önce kullanılmış.",
    statusCode: 409,
  },
  TOKEN_DEPLOYMENT_SIMULATION_FAILED: {
    message: "Token oluşturma işlemi canlı Base simülasyonunu geçemedi.",
    statusCode: 400,
  },
} as const;

export type BaseTokenLaunchErrorCode = keyof typeof PUBLIC_ERRORS;

export class BaseTokenLaunchError extends Error {
  readonly code: BaseTokenLaunchErrorCode;
  readonly statusCode: number;

  constructor(code: BaseTokenLaunchErrorCode) {
    const definition = PUBLIC_ERRORS[code];
    super(definition.message);
    this.name = "BaseTokenLaunchError";
    this.code = code;
    this.statusCode = definition.statusCode;
  }
}

function configError(): never {
  throw new BaseTokenLaunchError("BASE_LAUNCH_FACTORY_V2_CONFIG_INVALID");
}

function checkedAddress(value: unknown, allowZero = false): Address {
  if (typeof value !== "string") configError();
  try {
    const address = getAddress(value);
    if (!allowZero && address.toLowerCase() === ZERO_ADDRESS) {
      configError();
    }
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

function checkedDecimal(value: unknown, allowZero = true): bigint {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    configError();
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) configError();
  return parsed;
}

export function parseBaseLaunchFactoryV2DeploymentEvidence(
  environment: Environment,
): BaseLaunchFactoryV2DeploymentEvidence {
  const encoded = environment[BASE_LAUNCH_FACTORY_V2_EVIDENCE_ENV]?.trim();
  if (!encoded) configError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return configError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    configError();
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== EVIDENCE_KEYS.size ||
    keys.some((key) => !EVIDENCE_KEYS.has(key)) ||
    record.schemaVersion !== "kletia_launch_factory_v2_deployment_v1" ||
    record.validationStatus !== "validated" ||
    record.chainId !== BASE_MAINNET_CHAIN_ID
  ) {
    configError();
  }

  const pendingTreasury = checkedAddress(record.pendingTreasury, true);
  if (pendingTreasury.toLowerCase() !== ZERO_ADDRESS) {
    configError();
  }

  const evidence: BaseLaunchFactoryV2DeploymentEvidence = {
    schemaVersion: "kletia_launch_factory_v2_deployment_v1",
    validationStatus: "validated",
    chainId: BASE_MAINNET_CHAIN_ID,
    observedAtBlock: checkedDecimal(record.observedAtBlock, false),
    factory: checkedAddress(record.factory),
    factoryCodehash: checkedBytes32(record.factoryCodehash),
    ownerTimelock: checkedAddress(record.ownerTimelock),
    ownerTimelockCodehash: checkedBytes32(record.ownerTimelockCodehash),
    ownerTimelockMinDelay: checkedDecimal(record.ownerTimelockMinDelay, false),
    treasurySafe: checkedAddress(record.treasurySafe),
    treasurySafeCodehash: checkedBytes32(record.treasurySafeCodehash),
    pendingTreasury: ZERO_ADDRESS,
    factoryFeeCap: checkedDecimal(record.factoryFeeCap, false),
    maxTokenSupply: checkedDecimal(record.maxTokenSupply, false),
    maxNameBytes: checkedDecimal(record.maxNameBytes, false),
    maxSymbolBytes: checkedDecimal(record.maxSymbolBytes, false),
  };
  if (
    evidence.ownerTimelockMinDelay < 172_800n ||
    evidence.factoryFeeCap !== 10_000_000_000_000_000n ||
    evidence.maxTokenSupply !==
      1_000_000_000_000_000_000_000_000_000_000_000_000n ||
    evidence.maxNameBytes !== 64n ||
    evidence.maxSymbolBytes !== 16n ||
    evidence.ownerTimelock.toLowerCase() ===
      evidence.treasurySafe.toLowerCase() ||
    evidence.factory.toLowerCase() === evidence.ownerTimelock.toLowerCase() ||
    evidence.factory.toLowerCase() === evidence.treasurySafe.toLowerCase()
  ) {
    configError();
  }
  return evidence;
}

export function resolveBaseTokenDeploymentConfig(
  environment: Environment,
): BaseTokenDeploymentConfig {
  const rawMode = environment[BASE_TOKEN_DEPLOYMENT_MODE_ENV]?.trim();
  if (!rawMode) {
    if (environment.NODE_ENV === "production") {
      throw new BaseTokenLaunchError("BASE_TOKEN_DEPLOYMENT_MODE_REQUIRED");
    }
    return {
      mode: "legacy_v1",
      factory: LEGACY_KLETIA_TOKEN_FACTORY,
    };
  }
  if (rawMode === "legacy_v1") {
    return {
      mode: "legacy_v1",
      factory: LEGACY_KLETIA_TOKEN_FACTORY,
    };
  }
  if (rawMode !== "launch_v2") {
    throw new BaseTokenLaunchError("BASE_TOKEN_DEPLOYMENT_MODE_INVALID");
  }

  const configuredAddress =
    environment[BASE_LAUNCH_FACTORY_V2_ADDRESS_ENV]?.trim();
  if (!configuredAddress) configError();
  const factory = checkedAddress(configuredAddress);
  const deployment = parseBaseLaunchFactoryV2DeploymentEvidence(environment);
  if (factory.toLowerCase() !== deployment.factory.toLowerCase()) {
    configError();
  }
  return {
    mode: "launch_v2",
    chainId: BASE_MAINNET_CHAIN_ID,
    factory,
    deployment,
  };
}

export function configuredBaseTokenDeploymentTarget(
  environment: Environment,
): Address | null {
  try {
    return resolveBaseTokenDeploymentConfig(environment).factory;
  } catch {
    return null;
  }
}
