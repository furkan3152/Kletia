import { readFile } from 'node:fs/promises';

import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';

import {
  BASE_MAINNET_CHAIN_ID,
  ZERO_ADDRESS,
} from '../config/baseLaunchFactoryV2Environment.js';
import {
  KLETIA_LAUNCH_FACTORY_V2_ABI,
  TIMELOCK_IDENTITY_ABI,
} from '../creator/launchFactoryV2Abi.js';

const MANIFEST_URL = new URL(
  '../../../../smart-contracts/base_mainnet/deployments/base-mainnet-v2.json',
  import.meta.url,
);
const RUNTIME_CODE_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/u;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error(`INVALID_MANIFEST:${label}`);
  }
  return value as JsonRecord;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== 'string') {
    throw new Error(`INVALID_MANIFEST_ADDRESS:${label}`);
  }
  try {
    return getAddress(value);
  } catch {
    throw new Error(`INVALID_MANIFEST_ADDRESS:${label}`);
  }
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !BYTES32_PATTERN.test(value)) {
    throw new Error(`INVALID_MANIFEST_HASH:${label}`);
  }
  return value.toLowerCase() as Hex;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function checkedCode(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !RUNTIME_CODE_PATTERN.test(value)) {
    throw new Error(`MISSING_RUNTIME_CODE:${label}`);
  }
  return value.toLowerCase() as Hex;
}

async function main() {
  const manifest = record(
    JSON.parse(await readFile(MANIFEST_URL, 'utf8')),
    'root',
  );
  const network = record(manifest.network, 'network');
  const governance = record(manifest.governance, 'governance');
  const contracts = record(manifest.contracts, 'contracts');
  const factoryManifest = record(
    contracts.launchFactoryV2,
    'contracts.launchFactoryV2',
  );
  const timelockManifest = record(
    governance.timelock,
    'governance.timelock',
  );
  const treasuryManifest = record(
    governance.treasurySafe,
    'governance.treasurySafe',
  );
  if (
    network.chainId !== BASE_MAINNET_CHAIN_ID ||
    factoryManifest.verifiedExact !== true ||
    timelockManifest.verifiedExact !== true
  ) {
    throw new Error('MANIFEST_NOT_VERIFIED_FOR_BASE_MAINNET');
  }

  const factory = address(factoryManifest.address, 'factory');
  const ownerTimelock = address(
    timelockManifest.address,
    'timelock',
  );
  const treasurySafe = address(
    treasuryManifest.address,
    'treasurySafe',
  );
  const factoryCodehash = bytes32(
    factoryManifest.runtimeCodehash,
    'factoryCodehash',
  );
  const ownerTimelockCodehash = bytes32(
    timelockManifest.runtimeCodehash,
    'ownerTimelockCodehash',
  );
  const treasurySafeCodehash = bytes32(
    governance.safeProxyRuntimeCodehash,
    'treasurySafeCodehash',
  );
  if (
    !sameAddress(
      address(factoryManifest.owner, 'factory.owner'),
      ownerTimelock,
    ) ||
    !sameAddress(
      address(factoryManifest.treasury, 'factory.treasury'),
      treasurySafe,
    ) ||
    address(
      factoryManifest.pendingTreasury,
      'factory.pendingTreasury',
    ).toLowerCase() !== ZERO_ADDRESS
  ) {
    throw new Error('MANIFEST_FACTORY_ROLE_MISMATCH');
  }

  const client = createPublicClient({
    chain: base,
    transport: http(
      process.env.BASE_RPC_URL?.trim() ||
        'https://mainnet.base.org',
    ),
    batch: { multicall: true },
  });
  const observedAtBlock = await client.getBlockNumber();
  const readFactory = (functionName: string) =>
    client.readContract({
      address: factory,
      abi: KLETIA_LAUNCH_FACTORY_V2_ABI,
      functionName: functionName as never,
      blockNumber: observedAtBlock,
    });
  const [
    chainId,
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
    minDelayResult,
  ] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: factory, blockNumber: observedAtBlock }),
    client.getCode({
      address: ownerTimelock,
      blockNumber: observedAtBlock,
    }),
    client.getCode({
      address: treasurySafe,
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
      address: ownerTimelock,
      abi: TIMELOCK_IDENTITY_ABI,
      functionName: 'getMinDelay',
      blockNumber: observedAtBlock,
    }),
  ]);

  const liveFactoryCodehash = keccak256(
    checkedCode(factoryCodeResult, 'factory'),
  );
  const liveOwnerCodehash = keccak256(
    checkedCode(ownerCodeResult, 'ownerTimelock'),
  );
  const liveTreasuryCodehash = keccak256(
    checkedCode(treasuryCodeResult, 'treasurySafe'),
  );
  const owner = address(ownerResult, 'live.owner');
  const treasury = address(treasuryResult, 'live.treasury');
  const pendingTreasury = address(
    pendingTreasuryResult,
    'live.pendingTreasury',
  );
  const deploymentFee = deploymentFeeResult as bigint;
  const factoryFeeCap = factoryFeeCapResult as bigint;
  const maxTokenSupply = maxTokenSupplyResult as bigint;
  const maxNameBytes = maxNameBytesResult as bigint;
  const maxSymbolBytes = maxSymbolBytesResult as bigint;
  const ownerTimelockMinDelay = minDelayResult as bigint;
  if (
    chainId !== BASE_MAINNET_CHAIN_ID ||
    liveFactoryCodehash.toLowerCase() !==
      factoryCodehash.toLowerCase() ||
    liveOwnerCodehash.toLowerCase() !==
      ownerTimelockCodehash.toLowerCase() ||
    liveTreasuryCodehash.toLowerCase() !==
      treasurySafeCodehash.toLowerCase() ||
    !sameAddress(owner, ownerTimelock) ||
    !sameAddress(treasury, treasurySafe) ||
    pendingTreasury.toLowerCase() !== ZERO_ADDRESS ||
    ownerTimelockMinDelay <
      BigInt(String(timelockManifest.minDelaySeconds)) ||
    deploymentFee > factoryFeeCap
  ) {
    throw new Error('LIVE_LAUNCH_FACTORY_IDENTITY_MISMATCH');
  }

  console.log(JSON.stringify({
    schemaVersion:
      'kletia_launch_factory_v2_deployment_v1',
    validationStatus: 'validated',
    chainId: BASE_MAINNET_CHAIN_ID,
    observedAtBlock: observedAtBlock.toString(),
    factory,
    factoryCodehash,
    ownerTimelock,
    ownerTimelockCodehash,
    ownerTimelockMinDelay: ownerTimelockMinDelay.toString(),
    treasurySafe,
    treasurySafeCodehash,
    pendingTreasury: ZERO_ADDRESS,
    factoryFeeCap: factoryFeeCap.toString(),
    maxTokenSupply: maxTokenSupply.toString(),
    maxNameBytes: maxNameBytes.toString(),
    maxSymbolBytes: maxSymbolBytes.toString(),
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'unavailable',
    noBroadcast: true,
    code:
      error instanceof Error
        ? error.message.slice(0, 160)
        : 'UNKNOWN_ERROR',
  }));
  process.exitCode = 1;
});
