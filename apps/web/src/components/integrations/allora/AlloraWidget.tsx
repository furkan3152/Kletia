import React, { useEffect, useState } from "react";
import { NETWORKS } from "../../../config/networks";
import { BACKEND_URL } from "../../../config/runtime";

interface AlloraWidgetProps {
  asset?: "BTC" | "ETH";
  isDarkMode?: boolean;
}

interface PredictionData {
  asset: "BTC" | "ETH";
  timeframe: "5m";
  currentPrice: string;
  predictedPrice: string;
  predictedDeltaPercent: string;
  direction: "UP" | "DOWN" | "FLAT";
  fetchedAt: string;
}

function isPredictionData(
  value: unknown,
  expectedAsset: "BTC" | "ETH",
): value is PredictionData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    item.asset === expectedAsset &&
    item.timeframe === "5m" &&
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

export const AlloraWidget: React.FC<AlloraWidgetProps> = ({
  asset = "ETH",
  isDarkMode = false,
}) => {
  const [data, setData] = useState<PredictionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const fetchPrediction = async (resetData = false) => {
      if (resetData) setData(null);
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ asset, timeframe: "5m" });
        const res = await fetch(
          `${BACKEND_URL}/api/allora/prediction?${params.toString()}`,
          {
            headers: {
              Accept: "application/json",
              "X-Kletia-Network": "base",
              "X-Kletia-Chain-Id": String(NETWORKS.base.chainId),
            },
            signal: controller.signal,
          },
        );
        const json: unknown = await res.json();
        const payload =
          typeof json === "object" && json !== null && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : null;

        if (
          !res.ok ||
          payload?.success !== true ||
          !isPredictionData(payload.data, asset)
        ) {
          throw new Error("INVALID_PREDICTION_RESPONSE");
        }

        if (isMounted) {
          setData(payload.data);
        }
      } catch (err) {
        if (
          isMounted &&
          !(err instanceof DOMException && err.name === "AbortError")
        ) {
          setError("Canlı tahmin verisi şu anda kullanılamıyor.");
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void fetchPrediction(true);

    const interval = setInterval(() => {
      void fetchPrediction();
    }, 30000);
    return () => {
      isMounted = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [asset]);

  const bgClass = isDarkMode
    ? "bg-gray-900 border-[#CCA000] text-gray-200"
    : "bg-white border-[#1A1A1A] text-black";
  const shadowClass = isDarkMode
    ? "shadow-[4px_4px_0_#CCA000]"
    : "shadow-[4px_4px_0_#1A1A1A]";

  return (
    <div
      className={`p-4 border-[3px] rounded-xl flex flex-col gap-3 transition-all duration-300 ${bgClass} ${shadowClass}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🤖</span>
          <h3 className="font-bold text-lg font-mono">Allora AI</h3>
        </div>
        <span
          className={`text-xs px-2 py-1 rounded-full font-bold uppercase tracking-wider ${isDarkMode ? "bg-[#CCA000] text-black" : "bg-[#1A1A1A] text-white"}`}
        >
          5m Tahmini
        </span>
      </div>

      <div className="text-sm font-medium opacity-80">
        Target Asset: <span className="font-bold text-base">{asset}/USD</span>
      </div>

      {loading && !data ? (
        <div className="animate-pulse flex space-x-4 py-2">
          <div className="flex-1 space-y-3 py-1">
            <div
              className={`h-4 rounded w-3/4 ${isDarkMode ? "bg-gray-700" : "bg-gray-300"}`}
            ></div>
            <div
              className={`h-4 rounded w-1/2 ${isDarkMode ? "bg-gray-700" : "bg-gray-300"}`}
            ></div>
          </div>
        </div>
      ) : error ? (
        <div className="text-red-500 font-bold text-sm bg-red-100 dark:bg-red-900/30 p-2 border-2 border-red-500 rounded">
          {error}
        </div>
      ) : data ? (
        <div className="flex flex-col gap-1 mt-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-3xl font-black font-mono">
              $
              {Number(data.predictedPrice).toLocaleString("en-US", {
                minimumFractionDigits: 2,
              })}
            </span>
            <span
              className={`border-2 px-2 py-1 text-xs font-black ${
                data.direction === "UP"
                  ? "border-green-500 text-green-500"
                  : data.direction === "DOWN"
                    ? "border-red-500 text-red-500"
                    : "border-gray-500 text-gray-500"
              }`}
            >
              {data.direction}
            </span>
          </div>

          <div className="text-xs font-bold opacity-75">
            Spot $
            {Number(data.currentPrice).toLocaleString("en-US", {
              minimumFractionDigits: 2,
            })}
            {" · "}
            Tahmini fark {Number(data.predictedDeltaPercent) > 0 ? "+" : ""}
            {data.predictedDeltaPercent}%
          </div>

          <div className="flex items-center gap-2 text-xs font-bold mt-2 opacity-70">
            <span>⚡ Live Allora API</span>
            <span>•</span>
            <span>⏱️ {new Date(data.fetchedAt).toLocaleTimeString()}</span>
          </div>

          <div className="mt-2 border-t-2 border-dashed border-current pt-2 text-[10px] font-bold uppercase opacity-60">
            Model gözlemidir; al/sat önerisi değildir.
          </div>
        </div>
      ) : null}
    </div>
  );
};
