/**
 * Portfolio source reports, bounded reads, prices and asset summaries.
 */
import { formatUnits } from "viem";
import { basePublicClient } from "../../../../shared/config/client.js";

export type Availability =
  "available" | "partial" | "unavailable" | "not_configured" | "not_needed";

export type SourceReport = {
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

export type WalletAsset = {
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

export type LiquidStakingAsset = {
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

export function report(
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

export async function readContract<T>(params: any): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: (await basePublicClient.readContract(params)) as T };
  } catch {
    return { ok: false, reason: "rpc_read_failed" };
  }
}

export async function mapWithConcurrency<T, R>(
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

export async function fetchJson(
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

export function formatTokenAmount(amount: bigint, decimals: number): string {
  const exact = formatUnits(amount, decimals);
  const numeric = Number(exact);
  if (!Number.isFinite(numeric)) return exact;
  if (amount !== 0n && Math.abs(numeric) < 0.000001) return exact;
  return numeric.toFixed(6);
}

export function combineAvailability(
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

export function sourceLabels(sources: Record<string, SourceReport>): string[] {
  return Object.entries(sources)
    .filter(([, item]) => item.partial)
    .map(([name]) => name);
}

export async function fetchPrices(
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

export function applyPrice(
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

export function summarizeAssets(
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
