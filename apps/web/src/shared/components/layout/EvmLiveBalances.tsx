import React from "react";
import { sameAccount, type AccountId } from "@kletia/core";
import { LoaderCircle, RefreshCw } from "lucide-react";

import { BACKEND_URL } from "../../config/runtime";
import { useKletiaEvent } from "../../sync/bus";

interface LiveHolding {
  readonly key: string;
  readonly symbol: string;
  readonly formatted: string;
  readonly usdValue: number | null;
}

interface LivePortfolio {
  readonly totalUsd: number | null;
  readonly holdings: readonly LiveHolding[];
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function parseLivePortfolio(body: unknown, accountId: AccountId): LivePortfolio {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const candidate =
    root && root.portfolio && typeof root.portfolio === "object"
      ? (root.portfolio as Record<string, unknown>)
      : root;
  if (!candidate || !Array.isArray(candidate.holdings)) {
    throw new Error("Live balances did not match the expected format.");
  }
  if (typeof candidate.account === "string" && !sameAccount(candidate.account, accountId)) {
    throw new Error("Live balances were returned for a different account.");
  }
  const holdings = candidate.holdings.slice(0, 50).flatMap((raw, index): LiveHolding[] => {
    if (!raw || typeof raw !== "object") return [];
    const holding = raw as Record<string, unknown>;
    if (typeof holding.symbol !== "string" || typeof holding.formatted !== "string") return [];
    return [
      {
        key: typeof holding.asset === "string" ? holding.asset : `${holding.symbol}-${index}`,
        symbol: holding.symbol.slice(0, 16),
        formatted: holding.formatted.slice(0, 40),
        usdValue:
          typeof holding.usdValue === "number" && Number.isFinite(holding.usdValue)
            ? holding.usdValue
            : null,
      },
    ];
  });
  return {
    totalUsd:
      typeof candidate.totalUsd === "number" && Number.isFinite(candidate.totalUsd)
        ? candidate.totalUsd
        : null,
    holdings,
  };
}

/**
 * Live balances for the connected EVM account from Kletia Platform API v1
 * (`GET /v1/portfolio/{accountId}`). Re-reads whenever a
 * `portfolio.invalidated` event targets this account.
 */
export const EvmLiveBalances: React.FC<{ accountId: AccountId; networkName: string }> = ({
  accountId,
  networkName,
}) => {
  const [nonce, setNonce] = React.useState(0);
  const [state, setState] = React.useState<{
    key: string | null;
    data: LivePortfolio | null;
    error: string | null;
  }>({ key: null, data: null, error: null });
  const key = `${nonce}:${accountId}`;

  React.useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    fetch(`${BACKEND_URL}/v1/portfolio/${encodeURIComponent(accountId)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "Live balances are not available from this API deployment."
              : `Live balances returned HTTP ${response.status}.`,
          );
        }
        return parseLivePortfolio(body, accountId);
      })
      .then(
        (data) => {
          if (!controller.signal.aborted) setState({ key, data, error: null });
        },
        (error: unknown) => {
          if (controller.signal.aborted && !timedOut) return;
          setState((previous) => ({
            key,
            data: previous.data,
            error:
              timedOut
                ? "Live balances timed out."
                : error instanceof Error
                  ? error.message
                  : "Live balances are unavailable.",
          }));
        },
      )
      .finally(() => window.clearTimeout(timer));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accountId, key]);

  useKletiaEvent("portfolio.invalidated", (event) => {
    if (sameAccount(event.account, accountId)) setNonce((value) => value + 1);
  });

  const loading = state.key !== key;
  const data = state.data;

  return (
    <section
      aria-label={`Live ${networkName} balances`}
      className="border-[3px] border-[#1A1A1A] bg-white p-4 shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:text-white dark:shadow-[4px_4px_0_#475569]"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-[0.16em] text-gray-600 dark:text-slate-300">
          Live balances
        </h3>
        <button
          type="button"
          onClick={() => setNonce((value) => value + 1)}
          disabled={loading}
          aria-label="Refresh live balances"
          className="flex h-9 w-9 items-center justify-center border-2 border-[#1A1A1A] bg-white text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] disabled:opacity-50 dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
      </div>
      <div aria-live="polite" className="mt-3 flex flex-col gap-2">
        {data ? (
          <>
            <p className="text-2xl font-black">
              {data.totalUsd === null ? "Unpriced" : usd.format(data.totalUsd)}
            </p>
            {data.holdings.length > 0 ? (
              <ul className="flex flex-col divide-y-2 divide-dashed divide-[#1A1A1A]/20 dark:divide-slate-700">
                {data.holdings.map((holding) => (
                  <li key={holding.key} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="font-black">{holding.symbol}</span>
                    <span className="text-right font-mono font-bold">
                      {holding.formatted}
                      {holding.usdValue !== null ? (
                        <span className="block text-[11px] text-gray-600 dark:text-slate-400">
                          {usd.format(holding.usdValue)}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm font-bold text-gray-600 dark:text-slate-300">
                No tracked balances on {networkName}.
              </p>
            )}
          </>
        ) : loading ? (
          <p className="flex items-center gap-2 text-sm font-bold text-gray-600 dark:text-slate-300">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            Reading balances…
          </p>
        ) : null}
        {state.error && !loading ? (
          <p className="text-xs font-bold text-[#B91C1C] dark:text-red-300">{state.error}</p>
        ) : null}
      </div>
    </section>
  );
};

export default EvmLiveBalances;
