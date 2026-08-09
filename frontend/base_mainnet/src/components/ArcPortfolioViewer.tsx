import {
  Coins,
  Database,
  FlaskConical,
  Landmark,
  ShieldCheck,
  Timer,
  Vault,
} from 'lucide-react';
import type { ArcPortfolioData } from '../types';

const displayAmount = (value: string, decimals = 6): string => {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return 'Kullanılamıyor';

  const [whole, fraction = ''] = value.split('.');
  const visibleFraction = fraction.slice(0, decimals).replace(/0+$/, '');
  return visibleFraction ? `${whole}.${visibleFraction}` : whole;
};

const cooldownLabel = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Kullanılamıyor';
  if (seconds === 0) return 'Aktif değil';
  if (seconds < 60) return `${seconds} sn`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)} dk`;
  return `${Math.ceil(seconds / 3_600)} sa`;
};

function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b-2 border-black/10 dark:border-white/10 last:border-0">
      <span className="font-bold text-xs md:text-sm text-slate-700 dark:text-slate-300">
        {label}
      </span>
      <span className="font-black font-mono text-right text-[#1A1A1A] dark:text-white">
        {value}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  );
}

export default function ArcPortfolioViewer({
  data,
}: {
  data: ArcPortfolioData;
}) {
  const nativeUsdc = data.wallet.find(
    (asset) => asset.symbol.toUpperCase() === 'USDC',
  );

  return (
    <div className="w-full space-y-5 text-sm md:text-base">
      <div className="bg-[#67E8F9] p-5 md:p-6 border-[3px] border-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] text-center">
        <h3 className="text-black font-black uppercase tracking-widest text-xs md:text-sm mb-1 flex items-center justify-center gap-2">
          <FlaskConical className="w-4 h-4" />
          Arc Testnet Native Bakiye
        </h3>
        <div className="text-3xl md:text-5xl font-black text-[#1A1A1A] tracking-tighter break-all">
          {nativeUsdc
            ? `${displayAmount(nativeUsdc.formatted)} USDC`
            : 'Kullanılamıyor'}
        </div>
        <p className="mt-3 text-xs font-bold text-black/70">
          Native USDC, Arc üzerinde hem değer hem gas varlığıdır. Bu görünüm USD
          değerlemesi üretmez.
        </p>
      </div>

      <div className="p-4 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
        <h4 className="font-black uppercase flex items-center gap-2 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 text-[#1A1A1A] dark:text-white">
          <Coins className="w-4 h-4" strokeWidth={3} />
          Cüzdan Varlıkları
        </h4>
        {data.wallet.length > 0 ? (
          data.wallet.map((asset) => (
            <Metric
              key={`${asset.symbol}-${asset.address ?? 'native'}`}
              label={asset.name}
              value={displayAmount(asset.formatted)}
              unit={asset.symbol}
            />
          ))
        ) : (
          <p className="py-3 font-bold text-slate-600 dark:text-slate-300">
            Cüzdan bakiyeleri okunamadı.
          </p>
        )}
      </div>

      <div className="p-4 bg-[#ECFEFF] dark:bg-cyan-950/30 border-[3px] border-[#1A1A1A] dark:border-cyan-500 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#06B6D4]">
        <h4 className="font-black uppercase flex items-center gap-2 border-b-[3px] border-[#1A1A1A] dark:border-cyan-500 pb-2 text-cyan-900 dark:text-cyan-200">
          <Vault className="w-4 h-4" strokeWidth={3} />
          Kletia Vault
        </h4>
        <Metric label="Ana para" value={displayAmount(data.vault.principal)} unit="USDC" />
        <Metric
          label="Tahakkuk eden faiz"
          value={displayAmount(data.vault.accruedInterest)}
          unit="USDC"
        />
        <Metric
          label="Bekleyen faiz"
          value={displayAmount(data.vault.pendingInterest)}
          unit="USDC"
        />
      </div>

      <div className="p-4 bg-[#F5F3FF] dark:bg-violet-950/30 border-[3px] border-[#1A1A1A] dark:border-violet-500 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#8B5CF6]">
        <h4 className="font-black uppercase flex items-center gap-2 border-b-[3px] border-[#1A1A1A] dark:border-violet-500 pb-2 text-violet-900 dark:text-violet-200">
          <Database className="w-4 h-4" strokeWidth={3} />
          Kletia Staking
        </h4>
        <Metric
          label="Stake edilen"
          value={displayAmount(data.staking.stakedAmount)}
          unit="USDC"
        />
        <Metric
          label="Bekleyen unstake"
          value={displayAmount(data.staking.pendingUnstake)}
          unit="USDC"
        />
        <Metric
          label="Bekleyen ödül"
          value={displayAmount(data.staking.pendingRewards)}
          unit="USDC"
        />
        <Metric
          label="Cooldown"
          value={cooldownLabel(data.staking.cooldownRemaining)}
        />
      </div>

      <div className="p-4 bg-[#FFF7ED] dark:bg-orange-950/30 border-[3px] border-[#1A1A1A] dark:border-orange-500 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#F97316]">
        <h4 className="font-black uppercase flex items-center gap-2 border-b-[3px] border-[#1A1A1A] dark:border-orange-500 pb-2 text-orange-900 dark:text-orange-200">
          <Landmark className="w-4 h-4" strokeWidth={3} />
          Kletia Lending
        </h4>
        <Metric
          label="KLET teminat"
          value={displayAmount(data.lending.collateralKLET)}
          unit="KLET"
        />
        <Metric
          label="Sağlanan likidite"
          value={displayAmount(data.lending.suppliedUSDC)}
          unit="USDC"
        />
        <Metric
          label="Borç"
          value={displayAmount(data.lending.borrowedUSDC)}
          unit="USDC"
        />
        <Metric
          label="Sağlık faktörü"
          value={displayAmount(data.lending.healthFactor)}
        />
      </div>

      <div className="p-3 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] bg-[#D1FAE5] dark:bg-emerald-950/30 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
        <div className="font-black uppercase text-xs flex items-center gap-2 text-emerald-900 dark:text-emerald-200">
          <ShieldCheck className="w-4 h-4" />
          Zincir Kaynağı Doğrulandı
        </div>
        <p className="mt-1 text-xs font-bold text-emerald-900/80 dark:text-emerald-100/80">
          Bakiye ve pozisyonlar Arc Testnet RPC ile Kletia kontratlarından
          okunmuştur. Chain ID: {data.chainId}. Mock veri ve tahmini USD değeri
          kullanılmaz.
        </p>
        <div className="mt-2 flex items-center gap-1 text-[10px] font-bold text-emerald-900/70 dark:text-emerald-200/70">
          <Timer className="w-3 h-3" />
          Okuma, portföy isteğinin yanıt anını temsil eder.
        </div>
      </div>
    </div>
  );
}
