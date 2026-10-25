import React, { useEffect, useState } from "react";
import { NETWORKS } from "../../../shared/config/networks";
import { BACKEND_URL } from "../../../shared/config/runtime";

interface PredictionData {
  asset: string;
  timeframe: "5m" | "8h";
  currentPrice: string;
  predictedPrice: string;
  predictedDeltaPercent: string;
  direction: "UP" | "DOWN" | "FLAT";
  fetchedAt: string;
}

interface AlloraDashboardProps {
  /** Puts a sentence in the desk's composer with the Base engine pinned (unused by this read-only panel today). */
  onActionClick?: (prompt: string) => void;
}

const ALLORA_ASSETS = ["ETH", "BTC"] as const;

function isPredictionData(
  value: unknown,
  expectedTimeframe: "5m" | "8h",
): value is PredictionData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    (item.asset === "BTC" || item.asset === "ETH") &&
    item.timeframe === expectedTimeframe &&
    typeof item.currentPrice === "string" &&
    Number.isFinite(Number(item.currentPrice)) &&
    Number(item.currentPrice) > 0 &&
    typeof item.predictedPrice === "string" &&
    Number.isFinite(Number(item.predictedPrice)) &&
    Number(item.predictedPrice) > 0 &&
    typeof item.predictedDeltaPercent === "string" &&
    Number.isFinite(Number(item.predictedDeltaPercent)) &&
    (item.direction === "UP" ||
      item.direction === "DOWN" ||
      item.direction === "FLAT") &&
    typeof item.fetchedAt === "string" &&
    Number.isFinite(Date.parse(item.fetchedAt))
  );
}

/**
 * Allora price inference as advisory market context (desk tool 10). Follows
 * the site theme through the `dark` class on the document, like every desk
 * surface.
 */
export const AlloraDashboard: React.FC<AlloraDashboardProps> = () => {
  const [data, setData] = useState<PredictionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<"5m" | "8h">("8h");

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const fetchPredictions = async (resetData = false) => {
      if (resetData) setData([]);
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${BACKEND_URL}/api/allora/multi-prediction`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kletia-Network": "base",
            "X-Kletia-Chain-Id": String(NETWORKS.base.chainId),
          },
          body: JSON.stringify({ assets: ALLORA_ASSETS, timeframe }),
          signal: controller.signal,
        });
        const json: unknown = await res.json();
        const payload =
          typeof json === "object" && json !== null && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : null;
        const predictions = Array.isArray(payload?.data) ? payload.data : null;
        const hasExpectedAssets =
          predictions?.length === ALLORA_ASSETS.length &&
          new Set(
            predictions.map((item) =>
              typeof item === "object" && item !== null && !Array.isArray(item)
                ? (item as Record<string, unknown>).asset
                : null,
            ),
          ).size === ALLORA_ASSETS.length;

        if (
          !res.ok ||
          payload?.success !== true ||
          !predictions ||
          !hasExpectedAssets ||
          !predictions.every((item) => isPredictionData(item, timeframe))
        ) {
          throw new Error("INVALID_PREDICTION_RESPONSE");
        }

        if (isMounted) {
          setData(predictions);
        }
      } catch (err) {
        if (
          isMounted &&
          !(err instanceof DOMException && err.name === "AbortError")
        ) {
          setError("Live prediction data is currently unavailable.");
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void fetchPredictions(true);
    const interval = setInterval(() => {
      void fetchPredictions();
    }, 30000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [timeframe]);

  return (
    <div className="flex w-full flex-col gap-5 text-fg">
      <div className="flex flex-col gap-3 border-b-[3px] border-[#121212] pb-4 dark:border-[#4A4A52] sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="font-display text-xl font-bold">Allora price observation</h3>
          <p className="mt-1 text-sm text-muted">
            Live price and the Allora network's inference, shown as advisory market context.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label htmlFor="allora-timeframe" className="text-label uppercase">
            Timeframe
          </label>
          <select
            id="allora-timeframe"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as "5m" | "8h")}
            className="min-h-11 border-2 border-control bg-surface px-2 text-sm font-bold text-fg focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <option value="5m">5 minutes (short term)</option>
            <option value="8h">8 hours (medium term)</option>
          </select>
        </div>
      </div>

      {loading && data.length === 0 ? (
        <p role="status" className="flex items-center gap-3 text-sm font-bold">
          <span
            aria-hidden="true"
            className="h-6 w-6 animate-spin rounded-full border-4 border-dashed border-[#2F5BFF] motion-reduce:animate-none dark:border-[#8FA6FF]"
          />
          Reading the latest inference
        </p>
      ) : error ? (
        <p role="alert" className="border-[3px] border-[#121212] bg-[#FEE2E2] p-4 text-sm font-bold text-[#7F1D1D] dark:border-[#4A4A52] dark:bg-[#3A1414] dark:text-[#FECACA]">
          {error}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {data.map((item) => {
            const diffPercent = Number(item.predictedDeltaPercent);
            const isPositive = diffPercent > 0;
            const diffColor = isPositive
              ? "text-[#047857] dark:text-[#6EE7B7]"
              : diffPercent < 0
                ? "text-[#B91C1C] dark:text-[#FCA5A5]"
                : "text-muted";

            return (
              <div
                key={item.asset}
                className="flex flex-col gap-4 border-[3px] border-[#121212] bg-surface p-5 shadow-[4px_4px_0_#121212] dark:border-[#4A4A52] dark:shadow-[4px_4px_0_#2A2A30]"
              >
                <div className="flex items-center justify-between border-b-2 border-dashed border-[#121212]/40 pb-2 dark:border-white/20">
                  <h4 className="font-display text-2xl font-bold">{item.asset}</h4>
                  <span className={`border-2 border-current px-2 py-1 text-xs font-black uppercase ${diffColor}`}>
                    {item.direction}
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-label uppercase text-muted">Live price (Binance)</span>
                  <span className="font-code text-xl font-bold">${item.currentPrice}</span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-label uppercase text-muted">Allora inference ({timeframe})</span>
                  <div className="flex flex-wrap items-end gap-2">
                    <span className="font-code text-2xl font-bold text-[#1A36B0] dark:text-[#8FA6FF]">
                      ${item.predictedPrice}
                    </span>
                    <span className={`mb-0.5 text-base font-bold ${diffColor}`}>
                      <span aria-hidden="true">{isPositive ? "▲" : diffPercent < 0 ? "▼" : "•"} </span>
                      {item.predictedDeltaPercent}%
                    </span>
                  </div>
                </div>

                <p className="mt-auto border-t-2 border-dashed border-[#121212]/40 pt-3 text-xs font-bold text-muted dark:border-white/20">
                  A model observation, not a buy or sell recommendation.
                  <span className="mt-1 block font-normal">
                    Updated {new Date(item.fetchedAt).toLocaleTimeString("en-US")}
                  </span>
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
