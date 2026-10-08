import { assetsForNetwork, WRAPPED_SOL_MINT, type AssetDescriptor } from "@kletia/core";

import type { SolanaNetworkKey } from "./api";

export interface TokenOption {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly verified: boolean;
  /** From Kletia's canonical asset registry in @kletia/core. */
  readonly canonical: boolean;
}

function toOption(asset: AssetDescriptor): TokenOption {
  return {
    mint: asset.address ?? WRAPPED_SOL_MINT,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    verified: true,
    canonical: true,
  };
}

export function canonicalTokens(network: SolanaNetworkKey): TokenOption[] {
  return assetsForNetwork(network).map(toOption);
}

export const CANONICAL_SOLANA_TOKENS: readonly TokenOption[] = canonicalTokens("solana");

export function canonicalToken(symbol: string, network: SolanaNetworkKey = "solana"): TokenOption {
  const tokens = network === "solana" ? CANONICAL_SOLANA_TOKENS : canonicalTokens(network);
  const token = tokens.find((candidate) => candidate.symbol === symbol);
  if (!token) throw new Error(`${symbol} is not a canonical ${network} token.`);
  return token;
}

/** Liquid staking tokens Kletia routes into through Jupiter. */
export const LIQUID_STAKING_OPTIONS = [
  {
    symbol: "JitoSOL",
    protocol: "Jito",
    summary: "Stake pool whose validators share both staking rewards and MEV tips with holders.",
    website: "https://www.jito.network",
  },
  {
    symbol: "mSOL",
    protocol: "Marinade",
    summary: "Marinade's stake pool, delegated across a broad set of validators by its stake bot.",
    website: "https://marinade.finance",
  },
  {
    symbol: "JupSOL",
    protocol: "Jupiter",
    summary: "Jupiter's liquid staking token, backed by SOL staked to the Jupiter validator.",
    website: "https://jup.ag",
  },
] as const;

export type LiquidStakingSymbol = (typeof LIQUID_STAKING_OPTIONS)[number]["symbol"];
