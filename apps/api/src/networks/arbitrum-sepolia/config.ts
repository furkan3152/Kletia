import {
  createPublicClient,
  getAddress,
  http,
  isAddressEqual,
  type PublicClient,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { AAVE_V3_ADDRESSES_PROVIDER_ABI } from "../../shared/protocols/aave/abis.js";

export const ARBITRUM_SEPOLIA = Object.freeze({
  id: "arbitrum_sepolia",
  chainId: 421_614,
  rpcUrl:
    process.env.ARBITRUM_SEPOLIA_RPC_URL?.trim() ||
    "https://sepolia-rollup.arbitrum.io/rpc",
  explorerUrl: "https://sepolia.arbiscan.io",
  usdc: getAddress("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"),
  cctp: Object.freeze({
    domain: 3,
    tokenMessengerV2: getAddress(
      "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    ),
    messageTransmitterV2: getAddress(
      "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    ),
  }),
  aave: Object.freeze({
    poolAddressesProvider: getAddress(
      "0xB25a5D144626a0D488e52AE717A051a2E9997076",
    ),
    pool: getAddress("0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff"),
    dataProvider: getAddress("0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01"),
    oracle: getAddress("0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00"),
  }),
} as const);

export const ARBITRUM_SEPOLIA_MVP_ENABLED =
  process.env.ARBITRUM_SEPOLIA_MVP_ENABLED?.trim() === "true";

export const arbitrumSepoliaPublicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(ARBITRUM_SEPOLIA.rpcUrl),
  batch: { multicall: true },
}) as PublicClient;

let readiness: { expiresAt: number; promise: Promise<void> } | undefined;

async function readReadiness(): Promise<void> {
  const client = arbitrumSepoliaPublicClient;
  const [chainId, pool, dataProvider, oracle, code] = await Promise.all([
    client.getChainId(),
    client.readContract({
      address: ARBITRUM_SEPOLIA.aave.poolAddressesProvider,
      abi: AAVE_V3_ADDRESSES_PROVIDER_ABI,
      functionName: "getPool",
    }),
    client.readContract({
      address: ARBITRUM_SEPOLIA.aave.poolAddressesProvider,
      abi: AAVE_V3_ADDRESSES_PROVIDER_ABI,
      functionName: "getPoolDataProvider",
    }),
    client.readContract({
      address: ARBITRUM_SEPOLIA.aave.poolAddressesProvider,
      abi: AAVE_V3_ADDRESSES_PROVIDER_ABI,
      functionName: "getPriceOracle",
    }),
    Promise.all(
      [
        ARBITRUM_SEPOLIA.usdc,
        ARBITRUM_SEPOLIA.cctp.tokenMessengerV2,
        ARBITRUM_SEPOLIA.cctp.messageTransmitterV2,
        ARBITRUM_SEPOLIA.aave.pool,
        ARBITRUM_SEPOLIA.aave.dataProvider,
        ARBITRUM_SEPOLIA.aave.oracle,
      ].map((address) => client.getCode({ address })),
    ),
  ]);
  if (
    chainId !== ARBITRUM_SEPOLIA.chainId ||
    !isAddressEqual(pool, ARBITRUM_SEPOLIA.aave.pool) ||
    !isAddressEqual(dataProvider, ARBITRUM_SEPOLIA.aave.dataProvider) ||
    !isAddressEqual(oracle, ARBITRUM_SEPOLIA.aave.oracle) ||
    code.some((entry) => !entry || entry === "0x")
  ) {
    throw Object.assign(
      new Error("Arbitrum Sepolia protocol identities did not match the reviewed manifest."),
      { code: "ARBITRUM_SEPOLIA_ATTESTATION_FAILED", statusCode: 503 },
    );
  }
}

export async function assertArbitrumSepoliaReadiness(): Promise<void> {
  if (!ARBITRUM_SEPOLIA_MVP_ENABLED) {
    throw Object.assign(new Error("Arbitrum Sepolia Public Testnet Beta is disabled."), {
      code: "ARBITRUM_SEPOLIA_DISABLED",
      statusCode: 503,
    });
  }
  const now = Date.now();
  if (!readiness || readiness.expiresAt <= now) {
    readiness = { expiresAt: now + 30_000, promise: readReadiness() };
  }
  try {
    await readiness.promise;
  } catch (error) {
    readiness = undefined;
    throw error;
  }
}
