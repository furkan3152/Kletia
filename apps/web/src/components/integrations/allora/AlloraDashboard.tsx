import React, { useEffect, useState } from "react";
import { NETWORKS } from "../../../config/networks";
import { BACKEND_URL } from "../../../config/runtime";

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
  isDarkMode: boolean;
  onActionClick: (prompt: string) => void;
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

export const AlloraDashboard: React.FC<AlloraDashboardProps> = ({
  isDarkMode,
}) => {
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

  const bgClass = isDarkMode
    ? "bg-gray-900 text-gray-200"
    : "bg-gray-50 text-black";
  const cardBg = isDarkMode
    ? "bg-gray-800 border-[#CCA000] shadow-[4px_4px_0_#CCA000]"
    : "bg-white border-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A]";
  const headerText = isDarkMode ? "text-[#CCA000]" : "text-blue-600";

  return (
    <div
      className={`p-8 w-full max-w-7xl mx-auto min-h-[80vh] flex flex-col gap-6 ${bgClass}`}
    >
      <div className="flex flex-col md:flex-row justify-between items-center border-b-4 border-current pb-4">
        <div>
          <h1
            className={`text-4xl font-black uppercase tracking-tighter ${headerText}`}
          >
            Allora{" "}
            <span className={isDarkMode ? "text-gray-100" : "text-gray-900"}>
              Price Observation
            </span>
          </h1>
          <p className="font-bold opacity-80 uppercase mt-2 tracking-widest text-sm">
            Live Price + AI Prediction ➔ Neutral Direction
          </p>
        </div>

        <div className="mt-4 md:mt-0 flex items-center gap-4">
          <label
            htmlFor="allora-timeframe"
            className="font-bold uppercase text-sm"
          >
            Timeframe:
          </label>
          <select
            id="allora-timeframe"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as "5m" | "8h")}
            className={`min-h-10 p-2 border-2 font-bold transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
              isDarkMode
                ? "bg-gray-800 border-[#CCA000] text-[#CCA000]"
                : "bg-white border-blue-600 text-blue-600"
            }`}
          >
            <option value="5m">5 Minutes (Short Term)</option>
            <option value="8h">8 Hours (Medium Term)</option>
          </select>
        </div>
      </div>

      {loading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1">
          <div
            className={`w-16 h-16 border-8 border-dashed rounded-full animate-spin ${isDarkMode ? "border-[#CCA000]" : "border-blue-600"}`}
          ></div>
          <p className="mt-4 font-bold uppercase tracking-widest animate-pulse">
            Market Analysis in Progress...
          </p>
        </div>
      ) : error ? (
        <div className="bg-red-500 text-white font-bold p-6 border-4 border-red-900 uppercase tracking-widest">
          ❌ {error}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {data.map((item) => {
            const diffPercent = Number(item.predictedDeltaPercent);
            const isPositive = diffPercent > 0;
            const diffColor = isPositive
              ? "text-green-500"
              : diffPercent < 0
                ? "text-red-500"
                : "text-gray-500";
            const directionClass =
              item.direction === "UP"
                ? "border-green-500 text-green-500"
                : item.direction === "DOWN"
                  ? "border-red-500 text-red-500"
                  : "border-gray-500 text-gray-500";

            return (
              <div
                key={item.asset}
                className={`border-4 p-6 flex flex-col gap-4 transform transition-all duration-200 hover:-translate-y-2 hover:translate-x-2 ${cardBg}`}
              >
                <div className="flex justify-between items-center border-b-2 border-dashed border-gray-500 pb-2">
                  <h2 className="text-3xl font-black">{item.asset}</h2>
                  <span
                    className={`text-sm font-bold uppercase px-2 py-1 border-2 ${directionClass}`}
                  >
                    {item.direction}
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold uppercase opacity-70">
                    Live Price (Binance)
                  </span>
                  <span className="text-xl font-bold">
                    ${item.currentPrice}
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold uppercase opacity-70">
                    Allora Prediction ({timeframe})
                  </span>
                  <div className="flex items-end gap-2">
                    <span className={`text-3xl font-black ${headerText}`}>
                      ${item.predictedPrice}
                    </span>
                    <span className={`text-lg font-bold mb-1 ${diffColor}`}>
                      {isPositive ? "▲" : diffPercent < 0 ? "▼" : "•"}{" "}
                      {item.predictedDeltaPercent}%
                    </span>
                  </div>
                </div>

                <div className="mt-auto pt-4 border-t-2 border-dashed border-gray-500 text-xs font-bold uppercase tracking-wide opacity-70">
                  This is a model observation; not a buy/sell recommendation.
                  <span className="block mt-1 normal-case">
                    Updated:{" "}
                    {new Date(item.fetchedAt).toLocaleTimeString("en-US")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
