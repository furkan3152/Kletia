import { useState } from "react";
import {
  AlertTriangle,
  User,
  Layers,
  ChevronDown,
  ChevronUp,
  Droplet,
  History,
  Landmark,
  ShieldCheck,
  Zap,
} from "lucide-react";
import type { BasePortfolioData, WalletAsset, LSTAsset } from "../../types";
import { NETWORKS } from "../../config/networks";

const formattedUsd = (
  asset: Pick<WalletAsset, "priceStatus" | "usdFormatted">,
): string | undefined => {
  if (asset.priceStatus === "unavailable") return undefined;
  return typeof asset.usdFormatted === "string" && asset.usdFormatted.length > 0
    ? asset.usdFormatted
    : undefined;
};

const observedAtLabel = (observedAt?: string): string => {
  if (!observedAt) return "Observation time unavailable";
  const timestamp = Date.parse(observedAt);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString("tr-TR")
    : "Observation time unavailable";
};

export default function PortfolioViewer({ data }: { data: BasePortfolioData }) {
  const [showAllWallet, setShowAllWallet] = useState(false);
  const [showAllDefi, setShowAllDefi] = useState(false);
  const [showAllTx, setShowAllTx] = useState(false);

  const walletToShow = showAllWallet ? data.wallet : data.wallet?.slice(0, 4);
  const defiToShow = showAllDefi
    ? data.defiTokens
    : data.defiTokens?.slice(0, 4);
  const txToShow = showAllTx
    ? data.recentTransactions
    : data.recentTransactions?.slice(0, 5);
  const integrity = data.integrity;
  const valuationStatus = integrity?.valuation.status ?? "unavailable";
  const scanStatus = integrity?.status ?? "unavailable";
  const hasVisiblePortfolioData =
    Boolean(data.wallet?.length) ||
    Boolean(data.defiTokens?.length) ||
    Boolean(data.liquidStaking?.length) ||
    Boolean(data.baseNames?.length) ||
    Boolean(data.recentTransactions?.length) ||
    Boolean(data.defiPositions && Object.keys(data.defiPositions).length > 0);
  const totalValue =
    typeof data.summary?.totalNetWorthUSD === "string" &&
    data.summary.totalNetWorthUSD.length > 0
      ? data.summary.totalNetWorthUSD
      : "Valuation unavailable";

  return (
    <div className="w-full space-y-5 md:space-y-6 text-sm md:text-base">
      <div className="bg-[#FFD700] p-5 md:p-6 border-[3px] border-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] flex flex-col items-center justify-center text-center">
        <h3 className="text-black font-black uppercase tracking-widest text-xs md:text-sm mb-1 opacity-80 flex items-center gap-1">
          <Zap className="w-4 h-4" /> Verified Priced Assets
        </h3>
        <div className="text-3xl md:text-5xl font-black text-[#1A1A1A] tracking-tighter">
          {totalValue}
        </div>
        <p className="mt-2 text-xs font-bold text-black/70">
          {valuationStatus === "complete"
            ? "This result is the verified total of scanned assets with available prices."
            : valuationStatus === "partial"
              ? "Partial valuation: assets without prices are excluded from the total."
              : "Zero value was not assumed because the USD price source could not be verified."}
        </p>

        {data.summary && (
          <div className="mt-4 flex flex-wrap justify-center gap-2 md:gap-4 w-full">
            <div className="bg-white border-[2px] border-black px-3 py-1 text-xs md:text-sm font-bold text-black flex items-center gap-1">
              <User className="w-3 h-3" /> Wallet: {data.summary.walletValueUSD}
            </div>
            <div className="bg-[#059669] text-white border-[2px] border-black px-3 py-1 text-xs md:text-sm font-bold flex items-center gap-1">
              <Layers className="w-3 h-3" /> DeFi:{" "}
              {data.summary.defiTokenValueUSD}
            </div>
            <div className="bg-[#E11D48] text-white border-[2px] border-black px-3 py-1 text-xs md:text-sm font-bold flex items-center gap-1">
              <Droplet className="w-3 h-3" /> LST:{" "}
              {data.summary.liquidStakingValueUSD}
            </div>
          </div>
        )}
      </div>

      <div
        className={`p-3 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] ${
          scanStatus === "complete"
            ? "bg-[#D1FAE5] dark:bg-emerald-950/30"
            : scanStatus === "partial"
              ? "bg-[#FEF3C7] dark:bg-amber-950/30"
              : "bg-[#FEE2E2] dark:bg-red-950/30"
        }`}
      >
        <div className="font-black uppercase text-xs flex items-center gap-2 text-[#1A1A1A] dark:text-white">
          {scanStatus === "complete" ? (
            <ShieldCheck className="w-4 h-4" />
          ) : (
            <AlertTriangle className="w-4 h-4" />
          )}
          Scan Integrity:{" "}
          {scanStatus === "complete"
            ? "Tam"
            : scanStatus === "partial"
              ? "Partial"
              : "Unavailable"}
        </div>
        <p className="mt-1 text-xs font-bold text-slate-700 dark:text-slate-300">
          {observedAtLabel(integrity?.observedAt)}
          {integrity?.unavailableSources?.length
            ? ` · Eksik kaynaklar: ${integrity.unavailableSources.join(", ")}`
            : ""}
        </p>
        {integrity?.valuation.scope && (
          <p className="mt-1 text-[10px] font-bold text-slate-600 dark:text-slate-400">
            Kapsam: {integrity.valuation.scope}
          </p>
        )}
      </div>

      {/* 2. BASE NAMES (BNS) */}
      {data.baseNames && data.baseNames.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.baseNames.map((bns, idx) => (
            <div
              key={idx}
              className="bg-white text-black px-3 py-1 rounded-full border-[3px] border-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] text-xs font-bold whitespace-nowrap"
            >
              {bns.name
                ? bns.name
                : `Basename #${bns.tokenId.substring(0, 6)}...`}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5">
        {data.wallet && data.wallet.length > 0 && (
          <div className="p-4 md:p-5 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
            <h4 className="text-[#1A1A1A] dark:text-white font-black mb-3 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 uppercase flex items-center gap-2">
              <User className="w-4 h-4" strokeWidth={3} /> Wallet (Wallet)
            </h4>
            {walletToShow?.map((w: WalletAsset, idx: number) => (
              <div
                key={idx}
                className="flex justify-between items-center py-2 border-b-2 border-gray-100 dark:border-slate-700/50 last:border-0"
              >
                <div className="flex flex-col">
                  <span className="text-[#1A1A1A] dark:text-slate-300 font-black font-mono">
                    {w.symbol}
                  </span>
                  {w.name && (
                    <span className="text-[10px] md:text-xs text-gray-500 dark:text-slate-500 font-bold max-w-[120px] truncate">
                      {w.name}
                    </span>
                  )}
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[#1A1A1A] dark:text-white font-black text-base md:text-lg">
                    {w.formatted}
                  </span>
                  {formattedUsd(w) ? (
                    <span className="text-green-600 dark:text-green-400 text-xs md:text-sm font-bold">
                      {formattedUsd(w)}
                    </span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-300 text-[10px] md:text-xs font-bold">
                      USD price is unavailable
                    </span>
                  )}
                </div>
              </div>
            ))}
            {data.wallet.length > 4 && (
              <button
                onClick={() => setShowAllWallet(!showAllWallet)}
                className="w-full mt-3 py-2 flex items-center justify-center gap-1 text-xs font-black uppercase tracking-wider text-[#0052FF] hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors border-[2px] border-transparent hover:border-[#0052FF]"
              >
                {showAllWallet ? (
                  <>
                    <ChevronUp className="w-4 h-4" /> Hide
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4" /> See All (+
                    {data.wallet.length - 4})
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {/* 4. LIQUID STAKING (LST) */}
        {data.liquidStaking && data.liquidStaking.length > 0 && (
          <div className="p-4 md:p-5 bg-[#FFF1F2] dark:bg-[#4C1D95]/20 border-[3px] border-[#1A1A1A] dark:border-[#E11D48] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#E11D48]">
            <h4 className="text-[#E11D48] dark:text-[#FDA4AF] font-black mb-3 border-b-[3px] border-[#1A1A1A] dark:border-[#E11D48] pb-2 uppercase flex items-center gap-2">
              <Droplet className="w-4 h-4" strokeWidth={3} /> Likit Staking
            </h4>
            {data.liquidStaking.map((lst: LSTAsset, idx: number) => (
              <div
                key={idx}
                className="flex justify-between items-center py-2 border-b-2 border-rose-200 dark:border-rose-900/50 last:border-0"
              >
                <div className="flex flex-col">
                  <span className="text-[#BE123C] dark:text-[#FDA4AF] font-black font-mono">
                    {lst.symbol}
                  </span>
                  <span className="text-[10px] md:text-xs text-rose-700 dark:text-rose-400 font-bold">
                    {lst.protocol}
                  </span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[#881337] dark:text-white font-black text-base md:text-lg">
                    {lst.formatted}
                  </span>
                  {formattedUsd(lst) ? (
                    <span className="text-rose-600 dark:text-rose-300 text-xs md:text-sm font-bold">
                      {formattedUsd(lst)}
                    </span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-300 text-[10px] md:text-xs font-bold">
                      USD price is unavailable.</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 5. DEFI VARLIKLARI (LP, Vault, vs) */}
        {data.defiTokens && data.defiTokens.length > 0 && (
          <div className="p-4 md:p-5 bg-[#F0FDF4] dark:bg-[#064E3B]/20 border-[3px] border-[#1A1A1A] dark:border-[#059669] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#059669]">
            <h4 className="text-[#059669] dark:text-[#34D399] font-black mb-3 border-b-[3px] border-[#1A1A1A] dark:border-[#059669] pb-2 uppercase flex items-center gap-2">
              <Layers className="w-4 h-4" strokeWidth={3} /> Other DeFi Assets
            </h4>
            {defiToShow?.map((w: WalletAsset, idx: number) => (
              <div
                key={idx}
                className="flex justify-between items-center py-2 border-b-2 border-emerald-100 dark:border-[#059669]/30 last:border-0"
              >
                <div className="flex flex-col">
                  <span className="text-[#065F46] dark:text-[#A7F3D0] font-black font-mono">
                    {w.symbol}
                  </span>
                  {w.name && (
                    <span className="text-[10px] md:text-xs text-emerald-700 dark:text-[#6EE7B7] font-bold max-w-[120px] truncate">
                      {w.name}
                    </span>
                  )}
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[#064E3B] dark:text-white font-black text-base md:text-lg">
                    {w.formatted}
                  </span>
                  {formattedUsd(w) ? (
                    <span className="text-emerald-600 dark:text-[#34D399] text-xs md:text-sm font-bold">
                      {formattedUsd(w)}
                    </span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-300 text-[10px] md:text-xs font-bold">
                      USD price is unavailable.</span>
                  )}
                </div>
              </div>
            ))}
            {data.defiTokens.length > 4 && (
              <button
                onClick={() => setShowAllDefi(!showAllDefi)}
                className="w-full mt-3 py-2 flex items-center justify-center gap-1 text-xs font-black uppercase tracking-wider text-[#059669] hover:bg-emerald-100 dark:hover:bg-[#064E3B]/40 transition-colors border-[2px] border-transparent hover:border-[#059669]"
              >
                {showAllDefi ? (
                  <>
                    <ChevronUp className="w-4 h-4" /> Hide
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4" /> See All (+
                    {data.defiTokens.length - 4})
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {!hasVisiblePortfolioData && (
        <div className="p-4 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] font-bold text-center text-slate-700 dark:text-slate-300">
          {scanStatus === "complete"
            ? "No assets or positions to display in the completed scan."
            : "Scan incomplete. Empty result was not interpreted as zero balance."}
        </div>
      )}

      {data.defiPositions && Object.keys(data.defiPositions).length > 0 && (
        <div className="grid grid-cols-1 gap-4 mt-6">
          <div className="flex items-center gap-2 text-[#1A1A1A] dark:text-white font-black text-lg uppercase tracking-wider mt-2 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2">
            <Landmark className="w-5 h-5" /> Aktif Pozisyonlar
          </div>

          {data.defiPositions.aave && (
            <div className="p-4 bg-[#EFEFFF] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-[#0052FF] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#0052FF]">
              <h4 className="text-[#0052FF] font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-[#0052FF]/30 pb-2 uppercase text-sm">
                Aave V3 (Lending)
              </h4>
              <div className="flex justify-between py-1">
                <span className="text-gray-800 dark:text-slate-300 font-bold">
                  Teminat:
                </span>
                <span className="text-green-700 dark:text-green-400 font-black">
                  {data.defiPositions.aave.suppliedCollateralUSD}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-gray-800 dark:text-slate-300 font-bold">
                  Debt:
                </span>
                <span className="text-red-700 dark:text-red-400 font-black">
                  {data.defiPositions.aave.totalDebtUSD}
                </span>
              </div>
              <div className="flex justify-between py-1 mt-1 border-t-2 border-dashed border-[#1A1A1A]/20 dark:border-[#0052FF]/20 pt-1">
                <span className="text-gray-800 dark:text-slate-300 font-bold">
                  Health (HF):
                </span>
                <span
                  className={`font-black ${data.defiPositions.aave.status === "SAFE" ? "text-green-600" : "text-yellow-600"}`}
                >
                  {data.defiPositions.aave.healthFactor}
                </span>
              </div>
            </div>
          )}

          {data.defiPositions.moonwell &&
            Object.keys(data.defiPositions.moonwell).length > 0 && (
              <div className="p-4 bg-purple-50 dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-purple-600 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#9333ea]">
                <h4 className="text-purple-700 dark:text-purple-400 font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-purple-600/30 pb-2 uppercase text-sm">
                  Moonwell (Lending)
                </h4>
                {Object.entries(data.defiPositions.moonwell).map(
                  ([market, pos], idx) => (
                    <div key={idx} className="mb-2 last:mb-0">
                      <div className="font-bold text-xs text-purple-900 dark:text-purple-300 mb-1">
                        {market} Market:
                      </div>
                      <div className="flex justify-between py-0.5 pl-2 border-l-2 border-[#1A1A1A] dark:border-purple-300">
                        <span className="text-gray-600 dark:text-slate-400 text-xs">
                          Supplied:
                        </span>
                        <span className="text-purple-800 dark:text-purple-200 font-black text-xs">
                          {pos.supplied}
                        </span>
                      </div>
                      <div className="flex justify-between py-0.5 pl-2 border-l-2 border-[#1A1A1A] dark:border-purple-300">
                        <span className="text-gray-600 dark:text-slate-400 text-xs">
                          Debt:
                        </span>
                        <span className="text-red-600 dark:text-red-400 font-black text-xs">
                          {pos.debt}
                        </span>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}

          {data.defiPositions.compound &&
            Object.keys(data.defiPositions.compound).length > 0 && (
              <div className="p-4 bg-[#F8FAFC] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-teal-600 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#0d9488]">
                <h4 className="text-teal-700 dark:text-teal-400 font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-teal-600/30 pb-2 uppercase text-sm">
                  Compound V3
                </h4>
                {Object.entries(data.defiPositions.compound).map(
                  ([market, position]) => (
                    <div key={market} className="mb-2 last:mb-0">
                      <div className="mb-1 text-xs font-bold text-teal-900 dark:text-teal-300">
                        {market} Comet:
                      </div>
                      <div className="flex justify-between border-l-2 border-[#1A1A1A] py-0.5 pl-2 dark:border-teal-300">
                        <span className="text-xs text-gray-600 dark:text-slate-400">
                          Supplied:
                        </span>
                        <span className="text-xs font-black text-teal-700 dark:text-teal-300">
                          {position.supplied}
                        </span>
                      </div>
                      <div className="flex justify-between border-l-2 border-[#1A1A1A] py-0.5 pl-2 dark:border-teal-300">
                        <span className="text-xs text-gray-600 dark:text-slate-400">
                          Debt:
                        </span>
                        <span className="text-xs font-black text-red-700 dark:text-red-400">
                          {position.debt}
                        </span>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}

          {data.defiPositions.aerodrome && (
            <div className="p-4 bg-[#FFFbeb] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-amber-500 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#f59e0b]">
              <h4 className="text-amber-600 dark:text-amber-400 font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-amber-500/30 pb-2 uppercase text-sm">
                Aerodrome (veAERO)
              </h4>
              <div className="flex justify-between py-1">
                <span className="text-gray-800 dark:text-slate-300 font-bold">
                  Kilitli Miktar:
                </span>
                <span className="text-[#1A1A1A] dark:text-white font-black">
                  {data.defiPositions.aerodrome.lockedAmount}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-gray-800 dark:text-slate-300 font-bold">
                  Voting Power:
                </span>
                <span className="text-amber-600 dark:text-amber-400 font-black">
                  {data.defiPositions.aerodrome.votingPower}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {data.recentTransactions && data.recentTransactions.length > 0 && (
        <div className="mt-8 pt-4 border-t-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
          <h4 className="text-[#1A1A1A] dark:text-white font-black mb-4 uppercase flex items-center gap-2">
            <History className="w-5 h-5" /> Recent Transactions
          </h4>
          <div className="flex flex-col gap-2">
            {txToShow?.map((tx, idx) => (
              <a
                key={idx}
                href={`${NETWORKS.base.explorer.url}/tx/${tx.hash}`}
                target="_blank"
                rel="noreferrer"
                className="bg-[#FAFAFA] dark:bg-slate-900 border-[2px] border-[#1A1A1A] dark:border-slate-700 p-2.5 flex flex-col hover:bg-[#EFEFEF] dark:hover:bg-slate-800 transition-colors shadow-[2px_2px_0_#1A1A1A]"
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-[#1A1A1A] text-white dark:bg-slate-700 uppercase tracking-wider">
                    {tx.type}
                  </span>
                  <span className="text-xs font-black text-[#0052FF]">
                    {tx.value}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-gray-500 dark:text-slate-400 truncate mt-1 flex gap-2">
                  <span>
                    From: {tx.from.substring(0, 6)}...{tx.from.substring(38)}
                  </span>
                  <span>
                    To: {tx.to.substring(0, 6)}...{tx.to.substring(38)}
                  </span>
                </div>
              </a>
            ))}
          </div>
          {data.recentTransactions.length > 5 && (
            <button
              onClick={() => setShowAllTx(!showAllTx)}
              className="w-full mt-3 py-2 flex items-center justify-center gap-1 text-xs font-black uppercase tracking-wider text-[#1A1A1A] dark:text-white hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors border-[2px] border-[#1A1A1A] dark:border-[#4B5563]"
            >
              {showAllTx ? (
                <>
                  <ChevronUp className="w-4 h-4" /> Hide
                </>
              ) : (
                <>
                  <ChevronDown className="w-4 h-4" /> See All (+
                  {data.recentTransactions.length - 5})
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
