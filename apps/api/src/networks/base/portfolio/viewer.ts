import { erc20Abi, formatUnits, getAddress } from "viem";
import { basePublicClient } from "../../../config/client.js";
import {
  AAVE_V3_BASE,
  BASE_STAKING_CONTRACTS,
  BASE_TOKEN_REGISTRY,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
} from "../protocols.js";

const AAVE_POOL = AAVE_V3_BASE.pool;
const VE_AERO = BASE_STAKING_CONTRACTS.veAero;
const WSTETH = BASE_TOKEN_REGISTRY.WSTETH.address;
const CBETH = BASE_TOKEN_REGISTRY.CBETH.address;
const RETH = BASE_TOKEN_REGISTRY.RETH.address;
const BNS_NFT = getAddress("0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a");
const WETH_ADDRESS = BASE_TOKEN_REGISTRY.WETH.address;

const AAVE_ACCOUNT_ABI = [
  {
    inputs: [{ internalType: "address", name: "user", type: "address" }],
    name: "getUserAccountData",
    outputs: [
      { internalType: "uint256", name: "totalCollateralBase", type: "uint256" },
      { internalType: "uint256", name: "totalDebtBase", type: "uint256" },
      {
        internalType: "uint256",
        name: "availableBorrowsBase",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "currentLiquidationThreshold",
        type: "uint256",
      },
      { internalType: "uint256", name: "ltv", type: "uint256" },
      { internalType: "uint256", name: "healthFactor", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const VE_AERO_ABI = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "tokenOfOwnerByIndex",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "locked",
    outputs: [
      { internalType: "int128", name: "amount", type: "int128" },
      { internalType: "uint256", name: "end", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "balanceOfNFT",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const COMET_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "borrowBalanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const MOONWELL_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "borrowBalanceStored",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOfUnderlying",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

type Availability =
  "available" | "partial" | "unavailable" | "not_configured" | "not_needed";

type SourceReport = {
  source: "base_rpc" | "alchemy" | "dexscreener";
  status: Availability;
  partial: boolean;
  observedAt: string;
  method: string;
  scope?: string;
  reason?: string;
  records?: number;
  failures?: number;
  requested?: number;
  resolved?: number;
};

type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: string };

type WalletAsset = {
  symbol: string;
  name?: string;
  balance: string;
  formatted: string;
  usdValue?: number;
  usdFormatted?: string;
  address?: string;
  balanceStatus: "available" | "unavailable";
  metadataStatus?: "available" | "partial" | "unavailable";
  priceStatus?: "available" | "unavailable";
  priceSource?: "dexscreener";
  _quantity?: number;
  _priceAddress?: string;
};

type LiquidStakingAsset = {
  protocol: string;
  symbol: string;
  balance: string;
  formatted: string;
  tokenAddress: string;
  usdValue?: number;
  usdFormatted?: string;
  balanceStatus: "available";
  priceStatus?: "available" | "unavailable";
  priceSource?: "dexscreener";
  _quantity: number;
};

type PriceQuote = {
  usd: number;
  liquidityUsd: number;
};

function report(
  source: SourceReport["source"],
  status: Availability,
  observedAt: string,
  method: string,
  details: Omit<
    SourceReport,
    "source" | "status" | "partial" | "observedAt" | "method"
  > = {},
): SourceReport {
  return {
    source,
    status,
    partial:
      status === "partial" ||
      status === "unavailable" ||
      status === "not_configured",
    observedAt,
    method,
    ...details,
  };
}

async function readContract<T>(params: any): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: (await basePublicClient.readContract(params)) as T };
  } catch {
    return { ok: false, reason: "rpc_read_failed" };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        output[index] = await worker(items[index]);
      }
    }),
  );
  return output;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<ReadResult<any>> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok === false)
      return { ok: false, reason: `http_${response.status}` };

    const body = await response.json();
    if (body?.error) return { ok: false, reason: "provider_error" };
    return { ok: true, value: body };
  } catch {
    return { ok: false, reason: "request_failed" };
  }
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  const exact = formatUnits(amount, decimals);
  const numeric = Number(exact);
  if (!Number.isFinite(numeric)) return exact;
  if (amount !== 0n && Math.abs(numeric) < 0.000001) return exact;
  return numeric.toFixed(6);
}

function combineAvailability(
  reports: SourceReport[],
): "complete" | "partial" | "unavailable" {
  const relevant = reports.filter((item) => item.status !== "not_needed");
  if (relevant.length === 0) return "complete";

  const available = relevant.filter(
    (item) => item.status === "available",
  ).length;
  const incomplete = relevant.some(
    (item) =>
      item.status === "partial" ||
      item.status === "unavailable" ||
      item.status === "not_configured",
  );

  if (available === 0 && incomplete) return "unavailable";
  return incomplete ? "partial" : "complete";
}

function sourceLabels(sources: Record<string, SourceReport>): string[] {
  return Object.entries(sources)
    .filter(([, item]) => item.partial)
    .map(([name]) => name);
}

async function fetchPrices(
  addresses: string[],
  observedAt: string,
): Promise<{
  quotes: Map<string, PriceQuote>;
  source: SourceReport;
}> {
  const uniqueAddresses = [
    ...new Set(addresses.map((address) => address.toLowerCase())),
  ];
  const quotes = new Map<string, PriceQuote>();

  if (uniqueAddresses.length === 0) {
    return {
      quotes,
      source: report(
        "dexscreener",
        "not_needed",
        observedAt,
        "latest/dex/tokens",
        {
          requested: 0,
          resolved: 0,
        },
      ),
    };
  }

  let failedChunks = 0;
  for (let index = 0; index < uniqueAddresses.length; index += 30) {
    const chunk = uniqueAddresses.slice(index, index + 30);
    const result = await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`,
    );
    if (!result.ok) {
      failedChunks += 1;
      continue;
    }

    const pairs = Array.isArray(result.value?.pairs) ? result.value.pairs : [];
    for (const pair of pairs) {
      if (pair?.chainId && pair.chainId !== "base") continue;

      const address =
        typeof pair?.baseToken?.address === "string"
          ? pair.baseToken.address.toLowerCase()
          : "";
      if (!uniqueAddresses.includes(address)) continue;

      const rawPrice = pair?.priceUsd;
      if (rawPrice === undefined || rawPrice === null || rawPrice === "")
        continue;
      const usd = Number(rawPrice);
      if (!Number.isFinite(usd) || usd < 0) continue;

      const liquidityUsd = Number(pair?.liquidity?.usd);
      const normalizedLiquidity = Number.isFinite(liquidityUsd)
        ? liquidityUsd
        : 0;
      const existing = quotes.get(address);
      if (!existing || normalizedLiquidity > existing.liquidityUsd) {
        quotes.set(address, { usd, liquidityUsd: normalizedLiquidity });
      }
    }
  }

  const resolved = uniqueAddresses.filter((address) =>
    quotes.has(address),
  ).length;
  const status: Availability =
    resolved === uniqueAddresses.length && failedChunks === 0
      ? "available"
      : resolved > 0
        ? "partial"
        : "unavailable";

  return {
    quotes,
    source: report("dexscreener", status, observedAt, "latest/dex/tokens", {
      reason:
        status === "available"
          ? undefined
          : failedChunks > 0
            ? "price_request_or_quote_unavailable"
            : "price_quote_unavailable",
      requested: uniqueAddresses.length,
      resolved,
      failures: failedChunks,
      scope: "Base pairs; highest reported USD-liquidity pair per base token",
    }),
  };
}

function applyPrice(
  asset: WalletAsset | LiquidStakingAsset,
  address: string,
  quotes: Map<string, PriceQuote>,
): void {
  const quote = quotes.get(address.toLowerCase());
  const quantity = asset._quantity;
  if (!quote || quantity === undefined || !Number.isFinite(quantity)) {
    asset.priceStatus = "unavailable";
    asset.priceSource = "dexscreener";
    asset.usdFormatted = "Price unavailable";
    return;
  }

  const value = quantity * quote.usd;
  if (!Number.isFinite(value)) {
    asset.priceStatus = "unavailable";
    asset.priceSource = "dexscreener";
    asset.usdFormatted = "Price unavailable";
    return;
  }

  asset.priceStatus = "available";
  asset.priceSource = "dexscreener";
  asset.usdValue = value;
  asset.usdFormatted = `$${value.toFixed(2)}`;
}

function summarizeAssets(
  assets: Array<WalletAsset | LiquidStakingAsset>,
  discoveryComplete: boolean,
) {
  const priced = assets.filter((asset) => typeof asset.usdValue === "number");
  const knownValue = priced.reduce(
    (sum, asset) => sum + (asset.usdValue ?? 0),
    0,
  );
  const unpricedCount = assets.length - priced.length;
  const complete = discoveryComplete && unpricedCount === 0;

  let formatted: string;
  if (complete) {
    formatted = `$${knownValue.toFixed(2)}`;
  } else if (priced.length > 0) {
    formatted = `$${knownValue.toFixed(2)}+ (partial)`;
  } else {
    formatted = "Unavailable";
  }

  return { knownValue, unpricedCount, complete, formatted };
}

export async function getPortfolio(userAddress: string) {
  const observedAt = new Date().toISOString();
  const user = getAddress(userAddress);
  const alchemyApiKey = process.env.ALCHEMY_API_KEY?.trim();
  const alchemyRpcUrl = alchemyApiKey
    ? `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
    : undefined;

  const sources: Record<string, SourceReport> = {};
  const tokenAddressesToPrice = new Set<string>();
  const wallet: WalletAsset[] = [];

  console.log(`[KLETIA PORTFOLIO][base:8453] Scan started for ${user}`);

  try {
    const ethBalance = await basePublicClient.getBalance({ address: user });
    sources.nativeBalance = report(
      "base_rpc",
      "available",
      observedAt,
      "eth_getBalance",
      {
        records: ethBalance > 0n ? 1 : 0,
      },
    );
    if (ethBalance > 0n) {
      const exact = formatUnits(ethBalance, 18);
      wallet.push({
        symbol: "ETH",
        name: "Ethereum",
        balance: ethBalance.toString(),
        formatted: formatTokenAmount(ethBalance, 18),
        balanceStatus: "available",
        metadataStatus: "available",
        _quantity: Number(exact),
        _priceAddress: WETH_ADDRESS.toLowerCase(),
      });
      tokenAddressesToPrice.add(WETH_ADDRESS.toLowerCase());
    }
  } catch {
    sources.nativeBalance = report(
      "base_rpc",
      "unavailable",
      observedAt,
      "eth_getBalance",
      {
        reason: "rpc_read_failed",
      },
    );
  }

  let discoveredTokenCount = 0;
  let metadataFailures = 0;
  if (!alchemyRpcUrl) {
    sources.erc20Balances = report(
      "alchemy",
      "not_configured",
      observedAt,
      "alchemy_getTokenBalances",
      {
        reason: "ALCHEMY_API_KEY_missing",
        scope: "All positive ERC-20 wallet balances",
      },
    );
    sources.erc20Metadata = report(
      "base_rpc",
      "not_needed",
      observedAt,
      "erc20_metadata",
      {
        reason: "no_discovered_tokens",
      },
    );
  } else {
    const result = await fetchJson(alchemyRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getTokenBalances",
        params: [user, "erc20"],
      }),
    });

    const tokenBalances =
      result.ok && Array.isArray(result.value?.result?.tokenBalances)
        ? result.value.result.tokenBalances
        : undefined;

    if (!tokenBalances) {
      sources.erc20Balances = report(
        "alchemy",
        "unavailable",
        observedAt,
        "alchemy_getTokenBalances",
        {
          reason: result.ok ? "unexpected_provider_response" : result.reason,
          scope: "All positive ERC-20 wallet balances",
        },
      );
      sources.erc20Metadata = report(
        "base_rpc",
        "not_needed",
        observedAt,
        "erc20_metadata",
        {
          reason: "no_discovered_tokens",
        },
      );
    } else {
      const positiveBalances: Array<{
        address: `0x${string}`;
        balance: bigint;
      }> = [];
      let invalidBalanceRecords = 0;
      for (const token of tokenBalances) {
        try {
          const address = getAddress(token.contractAddress);
          const balance = BigInt(token.tokenBalance);
          if (balance > 0n) positiveBalances.push({ address, balance });
        } catch {
          invalidBalanceRecords += 1;
        }
      }
      discoveredTokenCount = positiveBalances.length;
      sources.erc20Balances = report(
        "alchemy",
        invalidBalanceRecords > 0 ? "partial" : "available",
        observedAt,
        "alchemy_getTokenBalances",
        {
          records: discoveredTokenCount,
          failures: invalidBalanceRecords,
          reason:
            invalidBalanceRecords > 0
              ? "invalid_provider_balance_record"
              : undefined,
          scope: "All positive ERC-20 wallet balances",
        },
      );

      await Promise.all(
        positiveBalances.map(async ({ address, balance }) => {
          const [symbolResult, nameResult, decimalsResult] = await Promise.all([
            readContract<string>({
              address,
              abi: erc20Abi,
              functionName: "symbol",
            }),
            readContract<string>({
              address,
              abi: erc20Abi,
              functionName: "name",
            }),
            readContract<number>({
              address,
              abi: erc20Abi,
              functionName: "decimals",
            }),
          ]);

          const decimals = decimalsResult.ok
            ? Number(decimalsResult.value)
            : undefined;
          const decimalsValid =
            decimals !== undefined &&
            Number.isInteger(decimals) &&
            decimals >= 0 &&
            decimals <= 255;
          const metadataStatus =
            decimalsValid && symbolResult.ok && nameResult.ok
              ? "available"
              : decimalsValid
                ? "partial"
                : "unavailable";

          if (metadataStatus !== "available") metadataFailures += 1;
          const addressLabel = `${address.slice(0, 6)}…${address.slice(-4)}`;
          const exactAmount = decimalsValid
            ? formatUnits(balance, decimals)
            : undefined;
          const lowerAddress = address.toLowerCase();

          wallet.push({
            symbol:
              symbolResult.ok && symbolResult.value
                ? symbolResult.value
                : addressLabel,
            name:
              nameResult.ok && nameResult.value
                ? nameResult.value
                : "ERC-20 metadata unavailable",
            balance: balance.toString(),
            formatted: decimalsValid
              ? formatTokenAmount(balance, decimals)
              : "Decimals unavailable",
            address: lowerAddress,
            balanceStatus: "available",
            metadataStatus,
            _quantity:
              exactAmount === undefined ? undefined : Number(exactAmount),
            _priceAddress: lowerAddress,
          });
          tokenAddressesToPrice.add(lowerAddress);
        }),
      );

      const metadataStatus: Availability =
        discoveredTokenCount === 0
          ? "not_needed"
          : metadataFailures === 0
            ? "available"
            : metadataFailures < discoveredTokenCount
              ? "partial"
              : "unavailable";
      sources.erc20Metadata = report(
        "base_rpc",
        metadataStatus,
        observedAt,
        "symbol/name/decimals",
        {
          requested: discoveredTokenCount,
          resolved: Math.max(0, discoveredTokenCount - metadataFailures),
          failures: metadataFailures,
          reason:
            metadataFailures > 0
              ? "one_or_more_metadata_reads_failed"
              : undefined,
        },
      );
    }
  }

  const liquidStaking: LiquidStakingAsset[] = [];
  const lstTokens = [
    { protocol: "Lido", symbol: "wstETH", address: WSTETH, decimals: 18 },
    { protocol: "Coinbase", symbol: "cbETH", address: CBETH, decimals: 18 },
    { protocol: "Rocket Pool", symbol: "rETH", address: RETH, decimals: 18 },
  ] as const;
  let lstReadFailures = 0;
  for (const lst of lstTokens) {
    const result = await readContract<bigint>({
      address: lst.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [user],
    });
    if (!result.ok) {
      lstReadFailures += 1;
      continue;
    }
    if (result.value > 0n) {
      const exact = formatUnits(result.value, lst.decimals);
      liquidStaking.push({
        protocol: lst.protocol,
        symbol: lst.symbol,
        balance: result.value.toString(),
        formatted: formatTokenAmount(result.value, lst.decimals),
        tokenAddress: lst.address,
        balanceStatus: "available",
        _quantity: Number(exact),
      });
      tokenAddressesToPrice.add(lst.address.toLowerCase());
    }
  }
  sources.liquidStaking = report(
    "base_rpc",
    lstReadFailures === 0
      ? "available"
      : lstReadFailures < lstTokens.length
        ? "partial"
        : "unavailable",
    observedAt,
    "balanceOf",
    {
      requested: lstTokens.length,
      resolved: lstTokens.length - lstReadFailures,
      records: liquidStaking.length,
      failures: lstReadFailures,
      reason:
        lstReadFailures > 0
          ? "one_or_more_lst_balance_reads_failed"
          : undefined,
    },
  );

  const baseNames: { tokenId: string; name?: string; index: number }[] = [];
  if (!alchemyApiKey) {
    sources.basenames = report(
      "alchemy",
      "not_configured",
      observedAt,
      "nft/v3/getNFTsForOwner",
      {
        reason: "ALCHEMY_API_KEY_missing",
        scope: "Basenames owned by the address",
      },
    );
  } else {
    const result = await fetchJson(
      `https://base-mainnet.g.alchemy.com/nft/v3/${alchemyApiKey}/getNFTsForOwner` +
        `?owner=${encodeURIComponent(user)}&contractAddresses[]=${encodeURIComponent(BNS_NFT)}&withMetadata=true`,
    );
    const ownedNfts =
      result.ok && Array.isArray(result.value?.ownedNfts)
        ? result.value.ownedNfts
        : undefined;
    let invalidRecords = 0;
    if (ownedNfts) {
      for (const nft of ownedNfts) {
        try {
          baseNames.push({
            tokenId: BigInt(nft.tokenId).toString(),
            name:
              typeof nft.name === "string" && nft.name.trim()
                ? nft.name
                : undefined,
            index: baseNames.length,
          });
        } catch {
          invalidRecords += 1;
        }
      }
      sources.basenames = report(
        "alchemy",
        invalidRecords > 0 ? "partial" : "available",
        observedAt,
        "nft/v3/getNFTsForOwner",
        {
          records: baseNames.length,
          failures: invalidRecords,
          reason: invalidRecords > 0 ? "invalid_nft_record" : undefined,
          scope: "Basenames owned by the address",
        },
      );
    } else {
      sources.basenames = report(
        "alchemy",
        "unavailable",
        observedAt,
        "nft/v3/getNFTsForOwner",
        {
          reason: result.ok ? "unexpected_provider_response" : result.reason,
          scope: "Basenames owned by the address",
        },
      );
    }
  }

  const defiPositions: Record<string, any> = {};

  const aaveResult = await readContract<
    readonly [bigint, bigint, bigint, bigint, bigint, bigint]
  >({
    address: AAVE_POOL,
    abi: AAVE_ACCOUNT_ABI,
    functionName: "getUserAccountData",
    args: [user],
  });
  if (!aaveResult.ok) {
    sources.aave = report(
      "base_rpc",
      "unavailable",
      observedAt,
      "getUserAccountData",
      {
        reason: aaveResult.reason,
      },
    );
  } else if (
    !Array.isArray(aaveResult.value) ||
    aaveResult.value.length < 6 ||
    aaveResult.value.some((value) => typeof value !== "bigint")
  ) {
    sources.aave = report(
      "base_rpc",
      "unavailable",
      observedAt,
      "getUserAccountData",
      {
        reason: "unexpected_rpc_response",
      },
    );
  } else {
    const [collateralRaw, debtRaw, availableBorrowRaw, , , healthFactorRaw] =
      aaveResult.value;
    const collateral = Number(formatUnits(collateralRaw, 8));
    const debt = Number(formatUnits(debtRaw, 8));
    const availableBorrow = Number(formatUnits(availableBorrowRaw, 8));
    if (collateralRaw > 0n || debtRaw > 0n) {
      const debtFree = debtRaw === 0n;
      const healthFactor = debtFree
        ? undefined
        : Number(formatUnits(healthFactorRaw, 18));
      defiPositions.aave = {
        suppliedCollateralUSD: `$${collateral.toFixed(2)}`,
        totalDebtUSD: `$${debt.toFixed(2)}`,
        availableBorrowPowerUSD: `$${availableBorrow.toFixed(2)}`,
        healthFactor: debtFree ? "∞ (Debt-free)" : healthFactor?.toFixed(2),
        status: debtFree
          ? "SAFE"
          : (healthFactor ?? 0) > 1.5
            ? "HEALTHY"
            : "WARNING",
      };
    }
    sources.aave = report(
      "base_rpc",
      "available",
      observedAt,
      "getUserAccountData",
      {
        records: collateralRaw > 0n || debtRaw > 0n ? 1 : 0,
      },
    );
  }

  const moonwellMarkets = MOONWELL_BASE.markets.map(({ token, market }) => ({
    name: BASE_TOKEN_REGISTRY[token].symbol,
    mToken: market,
    decimals: BASE_TOKEN_REGISTRY[token].decimals,
  }));
  const moonwellData: Record<string, { supplied: string; debt: string }> = {};
  let moonwellFailures = 0;
  let moonwellResolvedReads = 0;
  const moonwellResults = await mapWithConcurrency(
    moonwellMarkets,
    4,
    async (market) => {
      const [debtResult, suppliedResult] = await Promise.all([
        readContract<bigint>({
          address: market.mToken,
          abi: MOONWELL_ABI,
          functionName: "borrowBalanceStored",
          args: [user],
        }),
        readContract<bigint>({
          address: market.mToken,
          abi: MOONWELL_ABI,
          functionName: "balanceOfUnderlying",
          args: [user],
        }),
      ]);
      return { market, debtResult, suppliedResult };
    },
  );
  for (const { market, debtResult, suppliedResult } of moonwellResults) {
    if (debtResult.ok) moonwellResolvedReads += 1;
    else moonwellFailures += 1;
    if (suppliedResult.ok) moonwellResolvedReads += 1;
    else moonwellFailures += 1;

    const hasKnownPosition =
      (debtResult.ok && debtResult.value > 0n) ||
      (suppliedResult.ok && suppliedResult.value > 0n);
    if (hasKnownPosition) {
      moonwellData[market.name] = {
        supplied: suppliedResult.ok
          ? `${Number(formatUnits(suppliedResult.value, market.decimals)).toFixed(4)} ${market.name}`
          : "Unavailable",
        debt: debtResult.ok
          ? `${Number(formatUnits(debtResult.value, market.decimals)).toFixed(4)} ${market.name}`
          : "Unavailable",
      };
    }
  }
  if (Object.keys(moonwellData).length > 0)
    defiPositions.moonwell = moonwellData;
  sources.moonwell = report(
    "base_rpc",
    moonwellFailures === 0
      ? "available"
      : moonwellResolvedReads > 0
        ? "partial"
        : "unavailable",
    observedAt,
    "borrowBalanceStored/balanceOfUnderlying",
    {
      requested: moonwellMarkets.length * 2,
      resolved: moonwellResolvedReads,
      failures: moonwellFailures,
      records: Object.keys(moonwellData).length,
      reason:
        moonwellFailures > 0 ? "one_or_more_market_reads_failed" : undefined,
      scope:
        `${moonwellMarkets.length} registry-bound Base markets; ` +
        "debt is the stored onchain balance",
    },
  );

  const compoundResults = await mapWithConcurrency(
    COMPOUND_V3_BASE.markets,
    4,
    async ({ token, comet }) => {
      const [borrowResult, supplyResult] = await Promise.all([
        readContract<bigint>({
          address: comet,
          abi: COMET_ABI,
          functionName: "borrowBalanceOf",
          args: [user],
        }),
        readContract<bigint>({
          address: comet,
          abi: COMET_ABI,
          functionName: "balanceOf",
          args: [user],
        }),
      ]);
      return {
        token,
        borrowResult,
        supplyResult,
      };
    },
  );
  const compoundData: Record<string, { supplied: string; debt: string }> = {};
  let compoundFailures = 0;
  for (const { token, borrowResult, supplyResult } of compoundResults) {
    compoundFailures += Number(!borrowResult.ok) + Number(!supplyResult.ok);
    const definition = BASE_TOKEN_REGISTRY[token];
    const hasKnownPosition =
      (borrowResult.ok && borrowResult.value > 0n) ||
      (supplyResult.ok && supplyResult.value > 0n);
    if (!hasKnownPosition) continue;
    compoundData[definition.symbol] = {
      supplied: supplyResult.ok
        ? `${Number(
            formatUnits(supplyResult.value, definition.decimals),
          ).toFixed(4)} ${definition.symbol}`
        : "Unavailable",
      debt: borrowResult.ok
        ? `${Number(
            formatUnits(borrowResult.value, definition.decimals),
          ).toFixed(4)} ${definition.symbol}`
        : "Unavailable",
    };
  }
  if (Object.keys(compoundData).length > 0) {
    defiPositions.compound = compoundData;
  }
  const compoundRequestedReads = COMPOUND_V3_BASE.markets.length * 2;
  sources.compound = report(
    "base_rpc",
    compoundFailures === 0
      ? "available"
      : compoundFailures < compoundRequestedReads
        ? "partial"
        : "unavailable",
    observedAt,
    "borrowBalanceOf/balanceOf",
    {
      requested: compoundRequestedReads,
      resolved: compoundRequestedReads - compoundFailures,
      failures: compoundFailures,
      records: Object.keys(compoundData).length,
      reason:
        compoundFailures > 0 ? "one_or_more_comet_reads_failed" : undefined,
      scope: `${COMPOUND_V3_BASE.markets.length} registry-bound Base Comets`,
    },
  );

  const veBalanceResult = await readContract<bigint>({
    address: VE_AERO,
    abi: VE_AERO_ABI,
    functionName: "balanceOf",
    args: [user],
  });
  if (!veBalanceResult.ok) {
    sources.aerodrome = report(
      "base_rpc",
      "unavailable",
      observedAt,
      "veAERO enumerable reads",
      {
        reason: veBalanceResult.reason,
      },
    );
  } else if (veBalanceResult.value === 0n) {
    sources.aerodrome = report(
      "base_rpc",
      "available",
      observedAt,
      "veAERO enumerable reads",
      {
        records: 0,
      },
    );
  } else {
    const scanLimit = 25n;
    const countToScan = Number(
      veBalanceResult.value > scanLimit ? scanLimit : veBalanceResult.value,
    );
    let lockedTotal = 0n;
    let votingPowerTotal = 0n;
    let latestUnlock = 0n;
    let lockReadFailures = 0;
    const lockIds: string[] = [];

    for (let index = 0; index < countToScan; index += 1) {
      const tokenIdResult = await readContract<bigint>({
        address: VE_AERO,
        abi: VE_AERO_ABI,
        functionName: "tokenOfOwnerByIndex",
        args: [user, BigInt(index)],
      });
      if (!tokenIdResult.ok) {
        lockReadFailures += 1;
        continue;
      }
      const [lockedResult, votingPowerResult] = await Promise.all([
        readContract<readonly [bigint, bigint]>({
          address: VE_AERO,
          abi: VE_AERO_ABI,
          functionName: "locked",
          args: [tokenIdResult.value],
        }),
        readContract<bigint>({
          address: VE_AERO,
          abi: VE_AERO_ABI,
          functionName: "balanceOfNFT",
          args: [tokenIdResult.value],
        }),
      ]);
      if (!lockedResult.ok || !votingPowerResult.ok) {
        lockReadFailures += 1;
        continue;
      }

      lockIds.push(tokenIdResult.value.toString());
      lockedTotal += lockedResult.value[0];
      votingPowerTotal += votingPowerResult.value;
      if (lockedResult.value[1] > latestUnlock)
        latestUnlock = lockedResult.value[1];
    }

    if (lockIds.length > 0 && lockedTotal > 0n) {
      defiPositions.aerodrome = {
        lockId: lockIds.length === 1 ? lockIds[0] : `${lockIds.length} locks`,
        lockedAmount: `${Number(formatUnits(lockedTotal, 18)).toFixed(2)} AERO`,
        votingPower: `${Number(formatUnits(votingPowerTotal, 18)).toFixed(2)} veAERO`,
        unlockDate:
          latestUnlock > 0n
            ? new Date(Number(latestUnlock) * 1000).toISOString()
            : "Unavailable",
        positionCount: Number(veBalanceResult.value),
        scannedPositionCount: countToScan,
      };
    }

    const hitLimit = veBalanceResult.value > scanLimit;
    const status: Availability =
      lockIds.length === 0
        ? "unavailable"
        : hitLimit || lockReadFailures > 0
          ? "partial"
          : "available";
    sources.aerodrome = report(
      "base_rpc",
      status,
      observedAt,
      "veAERO enumerable reads",
      {
        requested: Number(veBalanceResult.value),
        resolved: lockIds.length,
        records: lockIds.length,
        failures: lockReadFailures,
        reason: hitLimit
          ? "scan_limit_reached"
          : lockReadFailures > 0
            ? "one_or_more_lock_reads_failed"
            : undefined,
        scope: `Up to ${scanLimit.toString()} veAERO locks; values are aggregated`,
      },
    );
  }

  const recentTransactions: {
    hash: string;
    from: string;
    to: string;
    value: string;
    type: string;
    timestamp?: string;
  }[] = [];
  if (!alchemyRpcUrl) {
    sources.recentTransactions = report(
      "alchemy",
      "not_configured",
      observedAt,
      "alchemy_getAssetTransfers",
      {
        reason: "ALCHEMY_API_KEY_missing",
        scope: "Latest 20 outgoing external/ERC-20 transfers",
      },
    );
  } else {
    const result = await fetchJson(alchemyRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "alchemy_getAssetTransfers",
        params: [
          {
            fromBlock: "0x0",
            toBlock: "latest",
            fromAddress: user,
            category: ["external", "erc20"],
            maxCount: "0x14",
            order: "desc",
          },
        ],
      }),
    });
    const transfers =
      result.ok && Array.isArray(result.value?.result?.transfers)
        ? result.value.result.transfers
        : undefined;
    if (transfers) {
      let invalidRecords = 0;
      for (const transaction of transfers) {
        if (
          typeof transaction?.hash !== "string" ||
          typeof transaction?.from !== "string"
        ) {
          invalidRecords += 1;
          continue;
        }
        const numericValue =
          transaction.value === null || transaction.value === undefined
            ? undefined
            : Number(transaction.value);
        const amount =
          numericValue !== undefined && Number.isFinite(numericValue)
            ? numericValue.toFixed(6)
            : "Amount unavailable";
        recentTransactions.push({
          hash: transaction.hash,
          from: transaction.from,
          to:
            typeof transaction.to === "string"
              ? transaction.to
              : "Contract Creation",
          value: `${amount}${transaction.asset ? ` ${transaction.asset}` : ""}`,
          type:
            transaction.category === "erc20"
              ? "Token Transfer"
              : "ETH Transfer",
        });
      }
      sources.recentTransactions = report(
        "alchemy",
        invalidRecords > 0 ? "partial" : "available",
        observedAt,
        "alchemy_getAssetTransfers",
        {
          records: recentTransactions.length,
          failures: invalidRecords,
          reason: invalidRecords > 0 ? "invalid_transfer_record" : undefined,
          scope: "Latest 20 outgoing external/ERC-20 transfers",
        },
      );
    } else {
      sources.recentTransactions = report(
        "alchemy",
        "unavailable",
        observedAt,
        "alchemy_getAssetTransfers",
        {
          reason: result.ok ? "unexpected_provider_response" : result.reason,
          scope: "Latest 20 outgoing external/ERC-20 transfers",
        },
      );
    }
  }

  const priceResult = await fetchPrices([...tokenAddressesToPrice], observedAt);
  sources.prices = priceResult.source;
  for (const asset of wallet) {
    if (asset._priceAddress)
      applyPrice(asset, asset._priceAddress, priceResult.quotes);
  }
  for (const asset of liquidStaking) {
    applyPrice(asset, asset.tokenAddress, priceResult.quotes);
  }

  const independentlyReadLstAddresses = new Set(
    liquidStaking.map((asset) => asset.tokenAddress.toLowerCase()),
  );
  const deduplicatedWallet = wallet.filter(
    (asset) =>
      !asset.address ||
      !independentlyReadLstAddresses.has(asset.address.toLowerCase()),
  );

  const defiKeywords =
    /lp|vault|morpho|moonwell|staked|aave|pool|veaero|usdbc|receipt|v3|compound|comet/i;
  const finalWallet: WalletAsset[] = [];
  const defiTokens: WalletAsset[] = [];
  for (const asset of deduplicatedWallet) {
    if (
      defiKeywords.test(asset.name ?? "") ||
      defiKeywords.test(asset.symbol)
    ) {
      defiTokens.push(asset);
    } else {
      finalWallet.push(asset);
    }
  }
  const byKnownValue = (left: WalletAsset, right: WalletAsset) => {
    const leftValue =
      typeof left.usdValue === "number"
        ? left.usdValue
        : Number.NEGATIVE_INFINITY;
    const rightValue =
      typeof right.usdValue === "number"
        ? right.usdValue
        : Number.NEGATIVE_INFINITY;
    return rightValue - leftValue;
  };
  finalWallet.sort(byKnownValue);
  defiTokens.sort(byKnownValue);

  const walletDiscovery = combineAvailability([
    sources.nativeBalance,
    sources.erc20Balances,
    sources.erc20Metadata,
  ]);
  const walletSummary = summarizeAssets(
    [...finalWallet, ...defiTokens],
    walletDiscovery === "complete",
  );
  const regularWalletSummary = summarizeAssets(
    finalWallet,
    walletDiscovery === "complete",
  );
  const defiTokenSummary = summarizeAssets(
    defiTokens,
    walletDiscovery === "complete",
  );
  const lstSummary = summarizeAssets(
    liquidStaking,
    sources.liquidStaking.status === "available",
  );
  const allValuedAssets = [...finalWallet, ...defiTokens, ...liquidStaking];
  const pricedAssets = allValuedAssets.filter(
    (asset) => typeof asset.usdValue === "number",
  );
  const knownTotal = walletSummary.knownValue + lstSummary.knownValue;
  const unpricedAssets = allValuedAssets
    .filter((asset) => asset.priceStatus !== "available")
    .map((asset) => ({
      symbol: asset.symbol,
      address: "tokenAddress" in asset ? asset.tokenAddress : asset.address,
      reason:
        asset._quantity === undefined
          ? "amount_metadata_unavailable"
          : "price_quote_unavailable",
    }));
  const assetDiscoveryComplete =
    walletDiscovery === "complete" &&
    sources.liquidStaking.status === "available";
  const valuationStatus: "complete" | "partial" | "unavailable" =
    assetDiscoveryComplete && unpricedAssets.length === 0
      ? "complete"
      : pricedAssets.length > 0
        ? "partial"
        : allValuedAssets.length === 0 && assetDiscoveryComplete
          ? "complete"
          : "unavailable";
  const totalFormatted =
    valuationStatus === "complete"
      ? `$${knownTotal.toFixed(2)}`
      : pricedAssets.length > 0
        ? `$${knownTotal.toFixed(2)}+ (partial)`
        : "Unavailable";

  const scanStatus = combineAvailability(Object.values(sources));
  const unavailableSources = sourceLabels(sources);
  const integrity = {
    status: scanStatus,
    partial: scanStatus !== "complete",
    observedAt,
    network: "base",
    chainId: 8453,
    valuation: {
      status: valuationStatus,
      partial: valuationStatus !== "complete",
      knownPricedValueUSD:
        pricedAssets.length > 0 || valuationStatus === "complete"
          ? knownTotal.toFixed(2)
          : null,
      pricedAssetCount: pricedAssets.length,
      unpricedAssetCount: unpricedAssets.length,
      unpricedAssets,
      scope:
        "Wallet and LST token balances only; NFTs and protocol positions are excluded from the USD total.",
      isCompleteNetWorth: false,
    },
    unavailableSources,
    sources,
  };

  for (const asset of [...finalWallet, ...defiTokens, ...liquidStaking]) {
    delete asset._quantity;
    if ("_priceAddress" in asset) delete asset._priceAddress;
  }

  const warning =
    unavailableSources.length > 0
      ? `\n⚠️ Partial/unavailable sources: ${unavailableSources.join(", ")}.`
      : "";
  console.log(
    `[KLETIA PORTFOLIO][base:8453] Scan ${scanStatus}; valuation ${valuationStatus}; ` +
      `known priced value ${pricedAssets.length > 0 ? `$${knownTotal.toFixed(2)}` : "unavailable"}`,
  );

  return {
    // "success" means the request was processed. Data completeness is
    // represented separately and explicitly under data.integrity.
    status: "success",
    resultStatus: scanStatus,
    partial: scanStatus !== "complete",
    action: "portfolio",
    data: {
      summary: {
        totalNetWorthUSD: totalFormatted,
        walletValueUSD: regularWalletSummary.formatted,
        defiTokenValueUSD: defiTokenSummary.formatted,
        liquidStakingValueUSD: lstSummary.formatted,
      },
      wallet: finalWallet,
      defiTokens,
      liquidStaking,
      baseNames,
      defiPositions,
      recentTransactions,
      integrity,
    },
    expectedOutput: "Kletia Base Portfolio Overview",
    message:
      `**💼 Kletia Base portfolio scan processed.**\n` +
      `💵 Verified priced assets: **${totalFormatted}**\n` +
      `📦 Wallet: ${finalWallet.length} token\n` +
      `🥩 Liquid staking: ${liquidStaking.length} position\n` +
      `🏷️ Basenames: ${baseNames.length}\n` +
      `🏦 DeFi protocols with known positions: ${Object.keys(defiPositions).length}\n` +
      `📜 Indexed outgoing transfers: ${recentTransactions.length}` +
      warning,
  };
}
