/**
 * GET /v1/portfolio/{accountId}: balances for one CAIP-10 account.
 * Solana uses the Solana module (SPL + Token-2022, Jupiter prices). EVM reads
 * the native balance plus every canonical asset on that network; USD
 * stablecoins are valued at 1 USD, other EVM assets carry usd: null.
 */
import { erc20Abi, getAddress } from "viem";
import {
  assetsForNetwork,
  CHAINS,
  formatAssetId,
  fromBaseUnits,
  nativeAssetId,
  parseAccountId,
  type AccountId,
  type AssetId,
  type NetworkKey,
} from "@kletia/core";
import { isSolanaNetworkKey, readSolanaPortfolio } from "../../networks/solana/index.js";
import { PlatformError, toPlatformError } from "../errors.js";
import { isUsdStablecoin } from "./assets.js";
import { evmClient, isEvmNetwork } from "./chains/evm.js";

export interface PortfolioHolding {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly amount: string;
  readonly formatted: string;
  readonly usd: number | null;
  readonly verified: boolean;
  readonly isNative: boolean;
}

export interface AccountPortfolio {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly holdings: readonly PortfolioHolding[];
  readonly totalUsd: number;
  readonly unpricedCount: number;
  readonly observedAt: string;
}

async function readEvmPortfolio(network: NetworkKey, owner: string): Promise<PortfolioHolding[]> {
  if (!isEvmNetwork(network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Not an EVM network.", 422);
  const client = evmClient(network);
  const account = getAddress(owner);
  const chain = CHAINS[network];
  const tokens = assetsForNetwork(network).filter((asset) => asset.address !== null);
  const [native, balances] = await Promise.all([
    client.getBalance({ address: account }),
    Promise.allSettled(
      tokens.map((asset) =>
        client.readContract({ address: getAddress(asset.address as string), abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      ),
    ),
  ]);
  const holdings: PortfolioHolding[] = [];
  // Arc's gas asset is USDC exposed through its ERC-20 interface, so it is listed once (as the token).
  if (assetsForNetwork(network).some((asset) => asset.address === null)) {
    holdings.push({
      asset: nativeAssetId(chain),
      symbol: chain.nativeAsset.symbol,
      name: chain.nativeAsset.name,
      decimals: chain.nativeAsset.decimals,
      amount: native.toString(),
      formatted: fromBaseUnits(native, chain.nativeAsset.decimals),
      usd: null,
      verified: true,
      isNative: true,
    });
  }
  tokens.forEach((asset, index) => {
    const result = balances[index];
    if (!result || result.status !== "fulfilled" || result.value === 0n) return;
    const formatted = fromBaseUnits(result.value, asset.decimals);
    const stable = isUsdStablecoin({ symbol: asset.symbol, canonical: true, category: asset.category });
    holdings.push({
      asset: formatAssetId(network, "erc20", asset.address as string),
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      amount: result.value.toString(),
      formatted,
      usd: stable ? Number(formatted) : null,
      verified: true,
      isNative: false,
    });
  });
  return holdings;
}

export async function readAccountPortfolio(accountId: string): Promise<AccountPortfolio> {
  try {
    const parsed = parseAccountId(accountId);
    if (!parsed) throw new PlatformError("ACCOUNT_INVALID", "accountId must be a CAIP-10 account (e.g. eip155:8453:0x…).", 400);
    const network = parsed.chain.key;
    let holdings: PortfolioHolding[];
    if (isSolanaNetworkKey(network)) {
      const portfolio = await readSolanaPortfolio(network, parsed.address);
      holdings = portfolio.holdings.map((holding) => ({
        asset: holding.isNative ? nativeAssetId(parsed.chain) : formatAssetId(parsed.chain, "token", holding.mint),
        symbol: holding.symbol,
        name: holding.name,
        decimals: holding.decimals,
        amount: holding.amount,
        formatted: holding.formatted,
        usd: holding.usdValue,
        verified: holding.verified,
        isNative: holding.isNative,
      }));
    } else {
      holdings = await readEvmPortfolio(network, parsed.address);
    }
    holdings.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    return {
      account: parsed.id,
      network,
      holdings,
      totalUsd: Math.round(holdings.reduce((total, holding) => total + (holding.usd ?? 0), 0) * 100) / 100,
      unpricedCount: holdings.filter((holding) => holding.usd === null && holding.amount !== "0").length,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw toPlatformError(error);
  }
}
