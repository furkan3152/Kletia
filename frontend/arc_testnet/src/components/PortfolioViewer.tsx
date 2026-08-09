import { useState } from 'react';
import { User, Layers, ChevronDown, ChevronUp, Droplet, History, Landmark, Zap } from 'lucide-react';
import { PortfolioData, WalletAsset, LSTAsset } from '../types';

export default function PortfolioViewer({ data }: { data: PortfolioData }) {
  const [showAllWallet, setShowAllWallet] = useState(false);
  const [showAllDefi, setShowAllDefi] = useState(false);
  const [showAllTx, setShowAllTx] = useState(false);

  if (!data) return null;

  const walletToShow = showAllWallet ? data.wallet : data.wallet?.slice(0, 4);
  const defiToShow = showAllDefi ? data.defiTokens : data.defiTokens?.slice(0, 4);
  const txToShow = showAllTx ? data.recentTransactions : data.recentTransactions?.slice(0, 5);

  return (
    <div className="w-full space-y-5 md:space-y-6 text-sm md:text-base">

      {}
      <div className="bg-[#FFD700] p-5 md:p-6 border-[3px] border-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] flex flex-col items-center justify-center text-center">
        <h3 className="text-black font-black uppercase tracking-widest text-xs md:text-sm mb-1 opacity-80 flex items-center gap-1"><Zap className="w-4 h-4"/> Total Portfolio Value</h3>
        <div className="text-3xl md:text-5xl font-black text-[#1A1A1A] tracking-tighter">
          {data.summary?.totalNetWorthUSD || "$0.00"}
        </div>

        {data.summary && (
          <div className="mt-4 flex flex-wrap justify-center gap-2 md:gap-4 w-full">
            <div className="bg-white border-[2px] border-black px-3 py-1 text-xs md:text-sm font-bold text-black flex items-center gap-1">
              <User className="w-3 h-3"/> Wallet: {data.summary.walletValueUSD}
            </div>
            <div className="bg-[#059669] text-white border-[2px] border-black px-3 py-1 text-xs md:text-sm font-bold flex items-center gap-1">
              <Layers className="w-3 h-3"/> DeFi: {data.summary.defiTokenValueUSD}
            </div>
            <div className="bg-[#E11D48] text-white border-[2px] border-black px-3 py-1 text-xs md:text-sm font-bold flex items-center gap-1">
              <Droplet className="w-3 h-3"/> LST: {data.summary.liquidStakingValueUSD}
            </div>
          </div>
        )}
      </div>

      {}
      {data.baseNames && data.baseNames.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.baseNames.map((bns, idx) => (
            <div key={idx} className="bg-white text-black px-3 py-1 rounded-full border-[3px] border-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A] text-xs font-bold whitespace-nowrap">
              {bns.name ? bns.name : `Basename #${bns.tokenId.substring(0, 6)}...`}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5">

        {}
        {data.wallet && data.wallet.length > 0 && (
          <div className="p-4 md:p-5 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
            <h4 className="text-[#1A1A1A] dark:text-white font-black mb-3 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 uppercase flex items-center gap-2">
                <User className="w-4 h-4" strokeWidth={3}/> Wallet (Wallet)
            </h4>
            {walletToShow?.map((w: WalletAsset, idx: number) => (
              <div key={idx} className="flex justify-between items-center py-2 border-b-2 border-gray-100 dark:border-slate-700/50 last:border-0">
                <div className="flex flex-col">
                   <span className="text-[#1A1A1A] dark:text-slate-300 font-black font-mono">{w.symbol}</span>
                   {w.name && <span className="text-[10px] md:text-xs text-gray-500 dark:text-slate-500 font-bold max-w-[120px] truncate">{w.name}</span>}
                </div>
                <div className="flex flex-col items-end">
                   <span className="text-[#1A1A1A] dark:text-white font-black text-base md:text-lg">{w.formatted}</span>
                   {w.usdFormatted !== "$0.00" && <span className="text-green-600 dark:text-green-400 text-xs md:text-sm font-bold">{w.usdFormatted}</span>}
                </div>
              </div>
            ))}
            {data.wallet.length > 4 && (
              <button 
                onClick={() => setShowAllWallet(!showAllWallet)}
                className="w-full mt-3 py-2 flex items-center justify-center gap-1 text-xs font-black uppercase tracking-wider text-[#0052FF] hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors border-[2px] border-transparent hover:border-[#0052FF]"
              >
                {showAllWallet ? <><ChevronUp className="w-4 h-4"/> Hide</> : <><ChevronDown className="w-4 h-4"/> See All (+{data.wallet.length - 4})</>}
              </button>
            )}
          </div>
        )}

        {}
        {data.liquidStaking && data.liquidStaking.length > 0 && (
          <div className="p-4 md:p-5 bg-[#FFF1F2] dark:bg-[#4C1D95]/20 border-[3px] border-[#1A1A1A] dark:border-[#E11D48] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#E11D48]">
            <h4 className="text-[#E11D48] dark:text-[#FDA4AF] font-black mb-3 border-b-[3px] border-[#1A1A1A] dark:border-[#E11D48] pb-2 uppercase flex items-center gap-2">
                <Droplet className="w-4 h-4" strokeWidth={3}/> Likit Staking
            </h4>
            {data.liquidStaking.map((lst: LSTAsset, idx: number) => (
              <div key={idx} className="flex justify-between items-center py-2 border-b-2 border-rose-200 dark:border-rose-900/50 last:border-0">
                <div className="flex flex-col">
                   <span className="text-[#BE123C] dark:text-[#FDA4AF] font-black font-mono">{lst.symbol}</span>
                   <span className="text-[10px] md:text-xs text-rose-700 dark:text-rose-400 font-bold">{lst.protocol}</span>
                </div>
                <div className="flex flex-col items-end">
                   <span className="text-[#881337] dark:text-white font-black text-base md:text-lg">{lst.formatted}</span>
                   {lst.usdFormatted !== "$0.00" && <span className="text-rose-600 dark:text-rose-300 text-xs md:text-sm font-bold">{lst.usdFormatted}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {}
        {data.defiTokens && data.defiTokens.length > 0 && (
          <div className="p-4 md:p-5 bg-[#F0FDF4] dark:bg-[#064E3B]/20 border-[3px] border-[#1A1A1A] dark:border-[#059669] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#059669]">
            <h4 className="text-[#059669] dark:text-[#34D399] font-black mb-3 border-b-[3px] border-[#1A1A1A] dark:border-[#059669] pb-2 uppercase flex items-center gap-2">
                <Layers className="w-4 h-4" strokeWidth={3}/> Other DeFi Assets
            </h4>
            {defiToShow?.map((w: WalletAsset, idx: number) => (
              <div key={idx} className="flex justify-between items-center py-2 border-b-2 border-emerald-100 dark:border-[#059669]/30 last:border-0">
                <div className="flex flex-col">
                   <span className="text-[#065F46] dark:text-[#A7F3D0] font-black font-mono">{w.symbol}</span>
                   {w.name && <span className="text-[10px] md:text-xs text-emerald-700 dark:text-[#6EE7B7] font-bold max-w-[120px] truncate">{w.name}</span>}
                </div>
                <div className="flex flex-col items-end">
                   <span className="text-[#064E3B] dark:text-white font-black text-base md:text-lg">{w.formatted}</span>
                   {w.usdFormatted !== "$0.00" && <span className="text-emerald-600 dark:text-[#34D399] text-xs md:text-sm font-bold">{w.usdFormatted}</span>}
                </div>
              </div>
            ))}
            {data.defiTokens.length > 4 && (
              <button 
                onClick={() => setShowAllDefi(!showAllDefi)}
                className="w-full mt-3 py-2 flex items-center justify-center gap-1 text-xs font-black uppercase tracking-wider text-[#059669] hover:bg-emerald-100 dark:hover:bg-[#064E3B]/40 transition-colors border-[2px] border-transparent hover:border-[#059669]"
              >
                {showAllDefi ? <><ChevronUp className="w-4 h-4"/> Hide</> : <><ChevronDown className="w-4 h-4"/> See All (+{data.defiTokens.length - 4})</>}
              </button>
            )}
          </div>
        )}

      </div>

      {}
      {data.defiPositions && Object.keys(data.defiPositions).length > 0 && (
        <div className="grid grid-cols-1 gap-4 mt-6">
          <div className="flex items-center gap-2 text-[#1A1A1A] dark:text-white font-black text-lg uppercase tracking-wider mt-2 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2">
            <Landmark className="w-5 h-5"/> Aktif Pozisyonlar
          </div>

          {}
          {data.defiPositions.aave && (
            <div className="p-4 bg-[#EFEFFF] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-[#0052FF] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#0052FF]">
              <h4 className="text-[#0052FF] font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-[#0052FF]/30 pb-2 uppercase text-sm">Aave V3 (Lending)</h4>
              <div className="flex justify-between py-1"><span className="text-gray-800 dark:text-slate-300 font-bold">Teminat:</span><span className="text-green-700 dark:text-green-400 font-black">{data.defiPositions.aave.suppliedCollateralUSD}</span></div>
              <div className="flex justify-between py-1"><span className="text-gray-800 dark:text-slate-300 font-bold">Debt:</span><span className="text-red-700 dark:text-red-400 font-black">{data.defiPositions.aave.totalDebtUSD}</span></div>
              <div className="flex justify-between py-1 mt-1 border-t-2 border-dashed border-[#1A1A1A]/20 dark:border-[#0052FF]/20 pt-1">
                <span className="text-gray-800 dark:text-slate-300 font-bold">Health (HF):</span>
                <span className={`font-black ${data.defiPositions.aave.status === 'SAFE' ? 'text-green-600' : 'text-yellow-600'}`}>{data.defiPositions.aave.healthFactor}</span>
              </div>
            </div>
          )}

          {}
          {data.defiPositions.moonwell && Object.keys(data.defiPositions.moonwell).length > 0 && (
            <div className="p-4 bg-purple-50 dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-purple-600 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#9333ea]">
              <h4 className="text-purple-700 dark:text-purple-400 font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-purple-600/30 pb-2 uppercase text-sm">Moonwell (Lending)</h4>
              {Object.entries(data.defiPositions.moonwell).map(([market, pos]: [string, any], idx) => (
                <div key={idx} className="mb-2 last:mb-0">
                   <div className="font-bold text-xs text-purple-900 dark:text-purple-300 mb-1">{market} Market:</div>
                   <div className="flex justify-between py-0.5 pl-2 border-l-2 border-[#1A1A1A] dark:border-purple-300"><span className="text-gray-600 dark:text-slate-400 text-xs">Supplied:</span><span className="text-purple-800 dark:text-purple-200 font-black text-xs">{pos.supplied}</span></div>
                   <div className="flex justify-between py-0.5 pl-2 border-l-2 border-[#1A1A1A] dark:border-purple-300"><span className="text-gray-600 dark:text-slate-400 text-xs">Debt:</span><span className="text-red-600 dark:text-red-400 font-black text-xs">{pos.debt}</span></div>
                </div>
              ))}
            </div>
          )}

          {}
          {data.defiPositions.compound && (
            <div className="p-4 bg-[#F8FAFC] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-teal-600 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#0d9488]">
              <h4 className="text-teal-700 dark:text-teal-400 font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-teal-600/30 pb-2 uppercase text-sm">Compound V3</h4>
              <div className="flex justify-between py-1"><span className="text-gray-800 dark:text-slate-300 font-bold">Supplied USDC:</span><span className="text-teal-700 dark:text-teal-400 font-black">{data.defiPositions.compound.suppliedUSDC}</span></div>
              <div className="flex justify-between py-1"><span className="text-gray-800 dark:text-slate-300 font-bold">Borrowed Debt:</span><span className="text-red-700 dark:text-red-400 font-black">{data.defiPositions.compound.borrowedUSDC}</span></div>
            </div>
          )}

          {}
          {data.defiPositions.aerodrome && (
            <div className="p-4 bg-[#FFFbeb] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-amber-500 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#f59e0b]">
              <h4 className="text-amber-600 dark:text-amber-400 font-black mb-3 border-b-[2px] border-[#1A1A1A] dark:border-amber-500/30 pb-2 uppercase text-sm">Aerodrome (veAERO)</h4>
              <div className="flex justify-between py-1"><span className="text-gray-800 dark:text-slate-300 font-bold">Kilitli Miktar:</span><span className="text-[#1A1A1A] dark:text-white font-black">{data.defiPositions.aerodrome.lockedAmount}</span></div>
              <div className="flex justify-between py-1"><span className="text-gray-800 dark:text-slate-300 font-bold">Voting Power:</span><span className="text-amber-600 dark:text-amber-400 font-black">{data.defiPositions.aerodrome.votingPower}</span></div>
            </div>
          )}
        </div>
      )}

      {}
      {data.recentTransactions && data.recentTransactions.length > 0 && (
        <div className="mt-8 pt-4 border-t-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
          <h4 className="text-[#1A1A1A] dark:text-white font-black mb-4 uppercase flex items-center gap-2">
              <History className="w-5 h-5"/> Recent Transactions
          </h4>
          <div className="flex flex-col gap-2">
            {txToShow?.map((tx, idx) => (
              <a 
                key={idx} 
                href={`https://testnet.arcscan.app/tx/${tx.hash}`}
                target="_blank"
                rel="noreferrer"
                className="bg-[#FAFAFA] dark:bg-slate-900 border-[2px] border-[#1A1A1A] dark:border-slate-700 p-2.5 flex flex-col hover:bg-[#EFEFEF] dark:hover:bg-slate-800 transition-colors shadow-[2px_2px_0_#1A1A1A]"
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-bold px-2 py-0.5 bg-[#1A1A1A] text-white dark:bg-slate-700 uppercase tracking-wider">{tx.type}</span>
                  <span className="text-xs font-black text-[#0052FF]">{tx.value}</span>
                </div>
                <div className="text-[10px] font-mono text-gray-500 dark:text-slate-400 truncate mt-1 flex gap-2">
                  <span>From: {tx.from.substring(0,6)}...{tx.from.substring(38)}</span>
                  <span>To: {tx.to.substring(0,6)}...{tx.to.substring(38)}</span>
                </div>
              </a>
            ))}
          </div>
          {data.recentTransactions.length > 5 && (
            <button 
              onClick={() => setShowAllTx(!showAllTx)}
              className="w-full mt-3 py-2 flex items-center justify-center gap-1 text-xs font-black uppercase tracking-wider text-[#1A1A1A] dark:text-white hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors border-[2px] border-[#1A1A1A] dark:border-[#4B5563]"
            >
              {showAllTx ? <><ChevronUp className="w-4 h-4"/> Hide</> : <><ChevronDown className="w-4 h-4"/> See All (+{data.recentTransactions.length - 5})</>}
            </button>
          )}
        </div>
      )}

    </div>
  );
}
