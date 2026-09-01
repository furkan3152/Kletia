import { formatUnits } from "viem";
import type { ArbitrumPortfolioData } from "../../../shared/types";

function balance(value: string, decimals: number) {
  const formatted = formatUnits(BigInt(value), decimals);
  const [whole, fraction = ""] = formatted.split(".");
  return fraction ? `${whole}.${fraction.slice(0, 6)}` : whole;
}

export function ArbitrumPortfolioViewer({ data }: { data: ArbitrumPortfolioData }) {
  const assets = [data.native, ...data.tokens];
  return (
    <div className="space-y-3">
      <div className="border-[3px] border-[#1A1A1A] bg-[#DDF5FF] p-3 shadow-[3px_3px_0_#1A1A1A]">
        <p className="text-[10px] font-black uppercase tracking-widest">Live Arbitrum balances</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {assets.map((asset) => (
            <div key={asset.symbol} className="border-2 border-[#1A1A1A] bg-white p-2">
              <p className="text-[9px] font-black uppercase">{asset.symbol}</p>
              <p className="break-all font-mono text-xs font-bold">{balance(asset.balanceAtomic, asset.decimals)}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-3 shadow-[3px_3px_0_#1A1A1A]">
        <p className="text-[10px] font-black uppercase tracking-widest">Aave V3 account</p>
        <div className="mt-2 space-y-1 text-xs font-bold">
          <p>Collateral base: {data.aave.totalCollateralBase}</p>
          <p>Debt base: {data.aave.totalDebtBase}</p>
          <p>Available borrow base: {data.aave.availableBorrowsBase}</p>
          <p>Health factor: {data.aave.healthFactor ?? "No debt"}</p>
        </div>
      </div>
      <p className="text-[9px] font-bold">Live RPC block {data.observedAtBlock}. USD valuation is not inferred.</p>
    </div>
  );
}
