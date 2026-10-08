import { KAMINO_API_URL, KAMINO_MAIN_MARKET } from "./config.js";
import { fetchProviderJson, isRecord } from "./http.js";

export interface SolanaYieldOpportunity {
  readonly protocol: "kamino";
  readonly market: string;
  readonly reserve: string;
  readonly symbol: string;
  readonly mint: string;
  readonly supplyApy: number;
  readonly borrowApy: number;
  readonly maxLtv: number;
  readonly totalSupplyUsd: number;
  readonly totalBorrowUsd: number;
  readonly utilization: number;
}

let cache: { expiresAt: number; value: SolanaYieldOpportunity[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Reserves below this TVL are hidden: tiny reserves produce misleading rates. */
const MIN_RESERVE_TVL_USD = 250_000;

function finite(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Kamino main-market lending reserves ranked by supply APY (read-only discovery). */
export async function readSolanaLendingYields(): Promise<SolanaYieldOpportunity[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const body = await fetchProviderJson<unknown>(
    `${KAMINO_API_URL}/kamino-market/${KAMINO_MAIN_MARKET}/reserves/metrics?env=mainnet-beta`,
    { provider: "Kamino" },
  );
  const rows = Array.isArray(body) ? body : [];
  const value = rows
    .flatMap((row): SolanaYieldOpportunity[] => {
      if (!isRecord(row)) return [];
      const supplyApy = finite(row.supplyApy);
      const borrowApy = finite(row.borrowApy);
      const totalSupplyUsd = finite(row.totalSupplyUsd);
      const totalBorrowUsd = finite(row.totalBorrowUsd);
      const maxLtv = finite(row.maxLtv);
      if (
        supplyApy === null || borrowApy === null || totalSupplyUsd === null || totalBorrowUsd === null ||
        typeof row.reserve !== "string" || typeof row.liquidityToken !== "string" ||
        typeof row.liquidityTokenMint !== "string" || totalSupplyUsd < MIN_RESERVE_TVL_USD ||
        supplyApy < 0 || supplyApy > 5
      ) {
        return [];
      }
      return [
        {
          protocol: "kamino",
          market: KAMINO_MAIN_MARKET,
          reserve: row.reserve,
          symbol: row.liquidityToken.slice(0, 16),
          mint: row.liquidityTokenMint,
          supplyApy,
          borrowApy,
          maxLtv: maxLtv ?? 0,
          totalSupplyUsd,
          totalBorrowUsd,
          utilization: totalSupplyUsd > 0 ? Math.min(1, totalBorrowUsd / totalSupplyUsd) : 0,
        },
      ];
    })
    .sort((a, b) => b.supplyApy - a.supplyApy);
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
