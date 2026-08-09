import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import {
  BASE_MAINNET_CHAIN_ID,
  BaseTokenLaunchError,
  ZERO_ADDRESS,
  type LaunchFactoryV2TokenDeploymentConfig,
} from '../config/baseLaunchFactoryV2Environment.js';
import {
  KLETIA_LAUNCH_FACTORY_V2_ABI,
  TIMELOCK_IDENTITY_ABI,
} from './launchFactoryV2Abi.js';

export const KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE =
  'kletia_launch_factory_v2' as const;
export const KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION =
  'kletia_launch_factory_v2_v1' as const;
export const KLETIA_LAUNCH_USER_SALT_DOMAIN = keccak256(
  stringToHex('KLETIA_LAUNCH_FACTORY_V2_USER_SALT_V1'),
);

const EXPLICIT_LAUNCH_ID_KIND = 1;
const CANONICAL_PARAMETERS_KIND = 0;
const TOKEN_DECIMALS = 18;
const UINT256_MAX = (1n << 256n) - 1n;
const STRICT_TOKEN_SUPPLY_PATTERN =
  /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u;
const CONTROL_OR_FORMAT_PATTERN = /\p{C}/u;
const UNICODE_SEPARATOR_PATTERN = /\p{Z}/u;
const ZERO_CODE = '0x';

export type LaunchSaltSource =
  | 'explicit_launch_id'
  | 'canonical_parameters';

export interface LaunchFactoryV2Evidence {
  readonly policyVersion:
    typeof KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION;
  readonly factory: Address;
  readonly userSalt: Hex;
  readonly saltSource: LaunchSaltSource;
  readonly launchId: string | null;
  readonly name: string;
  readonly symbol: string;
  readonly totalSupply: string;
  readonly recipient: Address;
  readonly maxDeploymentFee: string;
  readonly deploymentFee: string;
  readonly value: string;
  readonly predictedAddress: Address;
  readonly observedAtBlock: string;
  readonly factoryCodehash: Hex;
  readonly ownerTimelock: Address;
  readonly treasurySafe: Address;
  readonly pendingTreasury: typeof ZERO_ADDRESS;
  readonly factoryFeeCap: string;
  readonly simulationStatus: 'passed';
  readonly supplyPolicy: 'fixed_full_supply_to_recipient';
  readonly saltPolicy: 'creator_scoped_create2';
}

export type LaunchFactoryV2PublicClient = Pick<
  PublicClient,
  | 'getBlockNumber'
  | 'getChainId'
  | 'getCode'
  | 'readContract'
  | 'simulateContract'
>;

export interface LaunchFactoryV2Runtime {
  readonly observedAtBlock: bigint;
  readonly deploymentFee: bigint;
  readonly factoryFeeCap: bigint;
  readonly maxTokenSupply: bigint;
  readonly maxNameBytes: bigint;
  readonly maxSymbolBytes: bigint;
}

function runtimeError(): never {
  throw new BaseTokenLaunchError(
    'BASE_LAUNCH_FACTORY_V2_RUNTIME_INVALID',
  );
}

function inputError(): never {
  throw new BaseTokenLaunchError('TOKEN_LAUNCH_INPUT_INVALID');
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function checkedRuntimeCode(value: unknown): Hex {
  if (
    typeof value !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})+$/u.test(value)
  ) {
    runtimeError();
  }
  return value.toLowerCase() as Hex;
}

function checkedRuntimeAddress(value: unknown): Address {
  if (typeof value !== 'string') runtimeError();
  try {
    return getAddress(value);
  } catch {
    return runtimeError();
  }
}

function checkedRuntimeUint(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) runtimeError();
  return value;
}

export function parseStrictTokenSupply(
  supply: unknown,
  maximumAtomicSupply = UINT256_MAX,
): bigint {
  if (
    typeof supply !== 'string' ||
    supply !== supply.trim() ||
    !STRICT_TOKEN_SUPPLY_PATTERN.test(supply)
  ) {
    inputError();
  }
  let parsed: bigint;
  try {
    parsed = parseUnits(supply, TOKEN_DECIMALS);
  } catch {
    return inputError();
  }
  if (parsed <= 0n || parsed > maximumAtomicSupply) {
    inputError();
  }
  return parsed;
}

export function validateExplicitLaunchId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value !== value.normalize('NFC') ||
    CONTROL_OR_FORMAT_PATTERN.test(value)
  ) {
    inputError();
  }
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength < 1 || byteLength > 128) inputError();
  return value;
}

function validateMetadata(
  value: unknown,
  maximumBytes: bigint,
  allowInternalAsciiSpace: boolean,
): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value !== value.normalize('NFC') ||
    CONTROL_OR_FORMAT_PATTERN.test(value)
  ) {
    inputError();
  }
  const encoded = new TextEncoder().encode(value);
  if (
    encoded.length === 0 ||
    BigInt(encoded.length) > maximumBytes
  ) {
    inputError();
  }
  if (
    (!allowInternalAsciiSpace && /\s/u.test(value)) ||
    UNICODE_SEPARATOR_PATTERN.test(value.replaceAll(' ', ''))
  ) {
    inputError();
  }
  return value;
}

export function deriveLaunchFactoryV2UserSalt(input: {
  readonly launchId?: string;
  readonly name: string;
  readonly symbol: string;
  readonly totalSupply: bigint;
  readonly recipient: Address;
}): {
  readonly userSalt: Hex;
  readonly saltSource: LaunchSaltSource;
  readonly launchId: string | null;
} {
  if (input.launchId !== undefined) {
    const launchId = validateExplicitLaunchId(input.launchId);
    return {
      userSalt: keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint8' },
            { type: 'string' },
          ],
          [
            KLETIA_LAUNCH_USER_SALT_DOMAIN,
            EXPLICIT_LAUNCH_ID_KIND,
            launchId,
          ],
        ),
      ),
      saltSource: 'explicit_launch_id',
      launchId,
    };
  }
  return {
    userSalt: keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'uint8' },
          { type: 'string' },
          { type: 'string' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [
          KLETIA_LAUNCH_USER_SALT_DOMAIN,
          CANONICAL_PARAMETERS_KIND,
          input.name,
          input.symbol,
          input.totalSupply,
          input.recipient,
        ],
      ),
    ),
    saltSource: 'canonical_parameters',
    launchId: null,
  };
}

export async function validateLaunchFactoryV2Runtime(
  config: LaunchFactoryV2TokenDeploymentConfig,
  client: LaunchFactoryV2PublicClient,
): Promise<LaunchFactoryV2Runtime> {
  try {
    const chainId = await client.getChainId();
    if (chainId !== BASE_MAINNET_CHAIN_ID) runtimeError();
    const observedAtBlock = await client.getBlockNumber();
    if (
      typeof observedAtBlock !== 'bigint' ||
      observedAtBlock < config.deployment.observedAtBlock
    ) {
      runtimeError();
    }

    const readFactory = (functionName: string) =>
      client.readContract({
        address: config.factory,
        abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
        functionName: functionName as never,
        blockNumber: observedAtBlock,
      });
    const [
      factoryCodeResult,
      ownerCodeResult,
      treasuryCodeResult,
      ownerResult,
      treasuryResult,
      pendingTreasuryResult,
      deploymentFeeResult,
      factoryFeeCapResult,
      maxTokenSupplyResult,
      maxNameBytesResult,
      maxSymbolBytesResult,
      ownerTimelockMinDelayResult,
    ] = await Promise.all([
      client.getCode({
        address: config.factory,
        blockNumber: observedAtBlock,
      }),
      client.getCode({
        address: config.deployment.ownerTimelock,
        blockNumber: observedAtBlock,
      }),
      client.getCode({
        address: config.deployment.treasurySafe,
        blockNumber: observedAtBlock,
      }),
      readFactory('owner'),
      readFactory('treasury'),
      readFactory('pendingTreasury'),
      readFactory('deploymentFee'),
      readFactory('MAX_DEPLOYMENT_FEE'),
      readFactory('MAX_TOKEN_SUPPLY'),
      readFactory('MAX_NAME_BYTES'),
      readFactory('MAX_SYMBOL_BYTES'),
      client.readContract({
        address: config.deployment.ownerTimelock,
        abi: TIMELOCK_IDENTITY_ABI,
        functionName: 'getMinDelay',
        blockNumber: observedAtBlock,
      }),
    ]);

    const factoryCode = checkedRuntimeCode(factoryCodeResult);
    const ownerCode = checkedRuntimeCode(ownerCodeResult);
    const treasuryCode = checkedRuntimeCode(treasuryCodeResult);
    const owner = checkedRuntimeAddress(ownerResult);
    const treasury = checkedRuntimeAddress(treasuryResult);
    const pendingTreasury = checkedRuntimeAddress(
      pendingTreasuryResult,
    );
    const deploymentFee = checkedRuntimeUint(
      deploymentFeeResult,
    );
    const factoryFeeCap = checkedRuntimeUint(
      factoryFeeCapResult,
    );
    const maxTokenSupply = checkedRuntimeUint(
      maxTokenSupplyResult,
    );
    const maxNameBytes = checkedRuntimeUint(maxNameBytesResult);
    const maxSymbolBytes = checkedRuntimeUint(
      maxSymbolBytesResult,
    );
    const ownerTimelockMinDelay = checkedRuntimeUint(
      ownerTimelockMinDelayResult,
    );

    if (
      !sameHex(
        keccak256(factoryCode),
        config.deployment.factoryCodehash,
      ) ||
      !sameHex(
        keccak256(ownerCode),
        config.deployment.ownerTimelockCodehash,
      ) ||
      !sameHex(
        keccak256(treasuryCode),
        config.deployment.treasurySafeCodehash,
      ) ||
      !sameAddress(owner, config.deployment.ownerTimelock) ||
      !sameAddress(treasury, config.deployment.treasurySafe) ||
      !sameAddress(pendingTreasury, ZERO_ADDRESS) ||
      ownerTimelockMinDelay !==
        config.deployment.ownerTimelockMinDelay ||
      factoryFeeCap !== config.deployment.factoryFeeCap ||
      maxTokenSupply !== config.deployment.maxTokenSupply ||
      maxNameBytes !== config.deployment.maxNameBytes ||
      maxSymbolBytes !== config.deployment.maxSymbolBytes ||
      deploymentFee > factoryFeeCap ||
      factoryFeeCap <= 0n ||
      maxTokenSupply <= 0n
    ) {
      runtimeError();
    }

    return {
      observedAtBlock,
      deploymentFee,
      factoryFeeCap,
      maxTokenSupply,
      maxNameBytes,
      maxSymbolBytes,
    };
  } catch (error) {
    if (error instanceof BaseTokenLaunchError) throw error;
    return runtimeError();
  }
}

export async function buildLaunchFactoryV2TokenPlan(input: {
  readonly config: LaunchFactoryV2TokenDeploymentConfig;
  readonly client: LaunchFactoryV2PublicClient;
  readonly userAddress: string;
  readonly name: unknown;
  readonly symbol: unknown;
  readonly supply: unknown;
  readonly launchId?: unknown;
  readonly requestedRecipient?: unknown;
}) {
  let recipient: Address;
  try {
    recipient = getAddress(input.userAddress);
  } catch {
    return inputError();
  }
  if (input.requestedRecipient !== undefined) {
    try {
      if (
        !sameAddress(
          getAddress(String(input.requestedRecipient)),
          recipient,
        )
      ) {
        inputError();
      }
    } catch (error) {
      if (error instanceof BaseTokenLaunchError) throw error;
      return inputError();
    }
  }

  const runtime = await validateLaunchFactoryV2Runtime(
    input.config,
    input.client,
  );
  const name = validateMetadata(
    input.name,
    runtime.maxNameBytes,
    true,
  );
  const symbol = validateMetadata(
    input.symbol,
    runtime.maxSymbolBytes,
    false,
  );
  const totalSupply = parseStrictTokenSupply(
    input.supply,
    runtime.maxTokenSupply,
  );
  const launchIdentity = deriveLaunchFactoryV2UserSalt({
    ...(input.launchId === undefined
      ? {}
      : { launchId: input.launchId as string }),
    name,
    symbol,
    totalSupply,
    recipient,
  });

  let predictedAddress: Address;
  try {
    const existingToken = checkedRuntimeAddress(
      await input.client.readContract({
        address: input.config.factory,
        abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
        functionName: 'tokenForSalt',
        args: [recipient, launchIdentity.userSalt],
        blockNumber: runtime.observedAtBlock,
      }),
    );
    if (!sameAddress(existingToken, ZERO_ADDRESS)) {
      throw new BaseTokenLaunchError(
        'TOKEN_LAUNCH_SALT_ALREADY_USED',
      );
    }
    predictedAddress = checkedRuntimeAddress(
      await input.client.readContract({
        address: input.config.factory,
        abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
        functionName: 'predictTokenAddress',
        args: [
          recipient,
          launchIdentity.userSalt,
          name,
          symbol,
          totalSupply,
          recipient,
        ],
        blockNumber: runtime.observedAtBlock,
      }),
    );
    const predictedCode = await input.client.getCode({
      address: predictedAddress,
      blockNumber: runtime.observedAtBlock,
    });
    if (
      predictedCode !== undefined &&
      predictedCode.toLowerCase() !== ZERO_CODE
    ) {
      inputError();
    }
  } catch (error) {
    if (error instanceof BaseTokenLaunchError) throw error;
    return inputError();
  }

  const calldata = encodeFunctionData({
    abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
    functionName: 'deployToken',
    args: [
      launchIdentity.userSalt,
      name,
      symbol,
      totalSupply,
      recipient,
      runtime.deploymentFee,
    ],
  });
  try {
    const simulation = await input.client.simulateContract({
      account: recipient,
      address: input.config.factory,
      abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
      functionName: 'deployToken',
      args: [
        launchIdentity.userSalt,
        name,
        symbol,
        totalSupply,
        recipient,
        runtime.deploymentFee,
      ],
      value: runtime.deploymentFee,
      blockNumber: runtime.observedAtBlock,
    });
    if (
      typeof simulation.result !== 'string' ||
      !sameAddress(
        getAddress(simulation.result),
        predictedAddress,
      )
    ) {
      throw new Error('SIMULATION_RESULT_MISMATCH');
    }
  } catch {
    throw new BaseTokenLaunchError(
      'TOKEN_DEPLOYMENT_SIMULATION_FAILED',
    );
  }

  const value = runtime.deploymentFee.toString();
  const evidence: LaunchFactoryV2Evidence = {
    policyVersion: KLETIA_LAUNCH_FACTORY_V2_POLICY_VERSION,
    factory: input.config.factory,
    userSalt: launchIdentity.userSalt,
    saltSource: launchIdentity.saltSource,
    launchId: launchIdentity.launchId,
    name,
    symbol,
    totalSupply: totalSupply.toString(),
    recipient,
    maxDeploymentFee: value,
    deploymentFee: value,
    value,
    predictedAddress,
    observedAtBlock: runtime.observedAtBlock.toString(),
    factoryCodehash: input.config.deployment.factoryCodehash,
    ownerTimelock: input.config.deployment.ownerTimelock,
    treasurySafe: input.config.deployment.treasurySafe,
    pendingTreasury: ZERO_ADDRESS,
    factoryFeeCap: runtime.factoryFeeCap.toString(),
    simulationStatus: 'passed',
    supplyPolicy: 'fixed_full_supply_to_recipient',
    saltPolicy: 'creator_scoped_create2',
  };
  const quoteExpiresAt = Date.now() + 2 * 60 * 1_000;
  const route = {
    name: 'Kletia Launch Factory V2',
    action: 'deploy_token',
    router: input.config.factory,
    calldata,
    value,
    approvals: [] as const,
    executionMode: KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
    simulationStatus: 'passed' as const,
    launchFactoryV2Evidence: evidence,
    policyTargets: [input.config.factory],
    quoteExpiresAt,
  };

  return {
    status: 'success' as const,
    target: input.config.factory,
    targetContract: input.config.factory,
    calldata,
    value,
    amountInWei: value,
    approvals: [] as const,
    allRoutes: [route],
    executionMode: KLETIA_LAUNCH_FACTORY_V2_EXECUTION_MODE,
    simulationStatus: 'passed' as const,
    launchFactoryV2Evidence: evidence,
    predictedTokenAddress: predictedAddress,
    quoteExpiresAt,
    summary:
      `'${name}' (${symbol}) tokenı sabit ${totalSupply.toString()} atomik arzla ` +
      `tamamen aktif cüzdana dağıtılacak. Tahmini adres: ${predictedAddress}.`,
  };
}
