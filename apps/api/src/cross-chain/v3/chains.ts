import { getAddress } from "viem";
import { Networks } from "@stellar/stellar-sdk";
import type { AssetRef, ChainRef, EnvironmentLane } from "./types.js";
import { STELLAR_TESTNET } from "../../networks/stellar/config.js";

export const CHAINS_V3 = Object.freeze({
  base_mainnet: Object.freeze({
    family: "evm",
    chainId: 8453,
    key: "base_mainnet",
    caip2: "eip155:8453",
    lane: "production",
  }),
  arbitrum_one: Object.freeze({
    family: "evm",
    chainId: 42_161,
    key: "arbitrum_one",
    caip2: "eip155:42161",
    lane: "production",
  }),
  arc_testnet: Object.freeze({
    family: "evm",
    chainId: 5_042_002,
    key: "arc_testnet",
    caip2: "eip155:5042002",
    lane: "testnet",
  }),
  arbitrum_sepolia: Object.freeze({
    family: "evm",
    chainId: 421_614,
    key: "arbitrum_sepolia",
    caip2: "eip155:421614",
    lane: "testnet",
  }),
  stellar_testnet: Object.freeze({
    family: "stellar",
    network: "testnet",
    key: "stellar_testnet",
    caip2: "stellar:testnet",
    lane: "testnet",
    networkPassphrase: Networks.TESTNET,
  }),
  stellar_mainnet: Object.freeze({
    family: "stellar",
    network: "public",
    key: "stellar_mainnet",
    caip2: "stellar:public",
    lane: "production",
    networkPassphrase: Networks.PUBLIC,
  }),
} as const satisfies Record<string, ChainRef>);

export type ChainKeyV3 = keyof typeof CHAINS_V3;

export const ASSETS_V3 = Object.freeze({
  base_usdc: Object.freeze({
    family: "evm",
    chainId: 8453,
    symbol: "USDC",
    decimals: 6,
    address: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    native: false,
  }),
  base_eth: Object.freeze({
    family: "evm",
    chainId: 8453,
    symbol: "ETH",
    decimals: 18,
    address: null,
    native: true,
  }),
  arbitrum_usdc: Object.freeze({
    family: "evm",
    chainId: 42_161,
    symbol: "USDC",
    decimals: 6,
    address: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    native: false,
  }),
  arbitrum_eth: Object.freeze({
    family: "evm",
    chainId: 42_161,
    symbol: "ETH",
    decimals: 18,
    address: null,
    native: true,
  }),
  arc_usdc: Object.freeze({
    family: "evm",
    chainId: 5_042_002,
    symbol: "USDC",
    decimals: 6,
    address: getAddress("0x3600000000000000000000000000000000000000"),
    native: false,
  }),
  arbitrum_sepolia_usdc: Object.freeze({
    family: "evm",
    chainId: 421_614,
    symbol: "USDC",
    decimals: 6,
    address: getAddress("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"),
    native: false,
  }),
  stellar_testnet_xlm: Object.freeze({
    family: "stellar",
    network: "testnet",
    symbol: "XLM",
    code: "XLM",
    issuer: null,
    sac: null,
    decimals: 7,
    native: true,
  }),
  stellar_testnet_usdc: Object.freeze({
    family: "stellar",
    network: "testnet",
    symbol: "USDC",
    code: STELLAR_TESTNET.usdc.symbol,
    issuer: STELLAR_TESTNET.usdc.issuer,
    sac: STELLAR_TESTNET.usdc.sac,
    decimals: 7,
    native: false,
  }),
} as const satisfies Record<string, AssetRef>);

export function chainByKey(value: unknown): ChainRef | null {
  const key = String(value ?? "").trim().toLowerCase() as ChainKeyV3;
  return CHAINS_V3[key] ?? null;
}

export function assertSingleLane(chains: readonly ChainRef[]): EnvironmentLane {
  if (chains.length === 0) {
    throw Object.assign(new Error("At least one network is required."), {
      code: "WORKFLOW_NETWORK_REQUIRED",
      statusCode: 400,
    });
  }
  const lane = chains[0].lane;
  if (chains.some((chain) => chain.lane !== lane)) {
    throw Object.assign(
      new Error("Production and testnet networks cannot share one workflow."),
      { code: "WORKFLOW_ENVIRONMENT_MIXING_BLOCKED", statusCode: 409 },
    );
  }
  return lane;
}

export function assetFor(chain: ChainRef, symbolInput: unknown): AssetRef | null {
  const symbol = String(symbolInput ?? "").trim().toUpperCase();
  const matches = Object.values(ASSETS_V3).filter((asset) => {
    if (asset.symbol !== symbol || asset.family !== chain.family) return false;
    return asset.family === "evm"
      ? chain.family === "evm" && asset.chainId === chain.chainId
      : chain.family === "stellar" && asset.network === chain.network;
  });
  return matches.length === 1 ? matches[0] : null;
}
