import React, { useState } from "react";
import {
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Search,
  AlertTriangle,
  Shield,
} from "lucide-react";
import { getAddress, isAddress } from "viem";
import { NETWORKS } from "../../config/networks";
import { BACKEND_URL } from "../../config/runtime";

interface WebacyResult {
  status: "success";
  address: string;
  isContract: boolean;
  riskScore: number;
  riskLevel: string;
  decision: "approved" | "blocked";
  source: "webacy";
  tags: string[];
  network: "base";
  chainId: number;
}

function parseWebacyResult(
  value: unknown,
  expectedAddress: string,
): WebacyResult {
  if (!value || typeof value !== "object") {
    throw new Error("Webacy response is not an object.");
  }
  const data = value as Record<string, unknown>;
  const validTags =
    Array.isArray(data.tags) &&
    data.tags.every((tag) => typeof tag === "string");
  if (
    data.status !== "success" ||
    data.network !== "base" ||
    data.chainId !== NETWORKS.base.chainId ||
    data.source !== "webacy" ||
    (data.decision !== "approved" && data.decision !== "blocked") ||
    typeof data.address !== "string" ||
    !isAddress(data.address) ||
    getAddress(data.address) !== getAddress(expectedAddress) ||
    typeof data.isContract !== "boolean" ||
    typeof data.riskScore !== "number" ||
    !Number.isFinite(data.riskScore) ||
    data.riskScore < 0 ||
    data.riskScore > 100 ||
    typeof data.riskLevel !== "string" ||
    !validTags
  ) {
    throw new Error("Webacy response failed Base integrity validation.");
  }
  return data as unknown as WebacyResult;
}

export function WebacyScanner() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<WebacyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAddress(address.trim())) {
      setError("Enter a valid EVM address.");
      setResult(null);
      return;
    }
    const normalizedAddress = getAddress(address.trim());

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(
        `${BACKEND_URL}/api/webacy/scan/${normalizedAddress}?network=base&chainId=${NETWORKS.base.chainId}`,
        {
          headers: {
            Accept: "application/json",
            "X-Kletia-Network": "base",
            "X-Kletia-Chain-Id": String(NETWORKS.base.chainId),
          },
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          data?.message || `Security scan returned HTTP ${res.status}.`,
        );
      }
      setResult(parseWebacyResult(data, normalizedAddress));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar flex flex-col items-center">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <div className="bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] p-6 text-center">
          <div className="flex items-center justify-center gap-3 mb-2">
            <Shield className="w-8 h-8 text-[#0052FF]" strokeWidth={3} />
            <h1 className="text-2xl md:text-3xl font-black uppercase tracking-tighter text-[#1A1A1A] dark:text-white">
              Due Diligence Hub
            </h1>
          </div>
          <p className="text-sm md:text-base font-bold text-gray-600 dark:text-gray-400">
            Powered by Webacy (DD.xyz). Enter smart contract or wallet address
            to scan, view risk analysis instantly.
          </p>
        </div>

        <form
          onSubmit={handleScan}
          className="flex flex-col md:flex-row gap-3 w-full"
        >
          <input
            type="text"
            placeholder="0x..."
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="flex-1 bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-4 text-base md:text-lg font-mono font-bold text-[#1A1A1A] dark:text-white outline-none focus:border-[#0052FF]"
          />
          <button
            type="submit"
            disabled={loading || !address}
            className="bg-[#0052FF] hover:bg-blue-700 disabled:bg-gray-400 text-white font-black px-8 py-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase tracking-wide flex items-center justify-center gap-2 cursor-pointer"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" strokeWidth={3} />
            ) : (
              <Search className="w-5 h-5" strokeWidth={3} />
            )}
            TARA
          </button>
        </form>

        {error && (
          <div className="bg-red-100 dark:bg-red-900/30 border-[3px] border-red-500 p-4 text-red-700 dark:text-red-400 font-bold flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 shrink-0" strokeWidth={3} />{" "}
            {error}
          </div>
        )}

        {result && (
          <div className="bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col overflow-hidden">
            <div
              className={`p-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] flex flex-col md:flex-row items-center justify-between gap-4 ${
                result.decision === "blocked"
                  ? "bg-red-500 text-white"
                  : result.riskScore > 20
                    ? "bg-yellow-400 text-black"
                    : "bg-[#00d66f] text-black"
              }`}
            >
              <div className="flex items-center gap-3">
                {result.decision === "blocked" ? (
                  <ShieldAlert className="w-10 h-10" strokeWidth={3} />
                ) : (
                  <ShieldCheck className="w-10 h-10" strokeWidth={3} />
                )}
                <div className="flex flex-col">
                  <span className="text-xl font-black uppercase tracking-wider">
                    WEBACY: {result.riskLevel} RISK
                  </span>
                  <span className="text-sm font-bold opacity-80 uppercase tracking-widest">
                    {result.isContract ? "Smart Contract" : "Wallet (EOA)"} ·{" "}
                    {result.decision}
                  </span>
                </div>
              </div>
              <div className="text-5xl font-black">
                {result.riskScore}
                <span className="text-xl opacity-70">/100</span>
              </div>
            </div>

            <div className="p-6 flex flex-col gap-4">
              <h3 className="font-black text-[#1A1A1A] dark:text-white uppercase tracking-widest border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2">
                Detected Risk Tags
              </h3>

              {result.tags && result.tags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {result.tags.map((tag: string, idx: number) => (
                    <span
                      key={idx}
                      className="bg-[#1A1A1A] dark:bg-slate-700 text-white text-xs font-bold uppercase tracking-wider px-3 py-1.5 border-[2px] border-transparent"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-gray-500 dark:text-gray-400 font-bold italic">
                  Provider did not report a risk tag; this does not guarantee the address is risk-free.
                </div>
              )}

              {result.decision === "blocked" && (
                <div className="mt-4 bg-red-100 dark:bg-red-900/30 p-4 border-[3px] border-red-500 font-bold text-red-700 dark:text-red-400">
                  ⚠️ WARNING: Kletia Autonomous Agent and Kletia Firewall will
                  not allow you to make any transaction with this address.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
