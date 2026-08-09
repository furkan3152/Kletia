import {
  CheckCircle2,
  Fingerprint,
  Loader2,
  Rocket,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import { formatEther, formatUnits } from 'viem';
import type { BaseLaunchFactoryV2Evidence } from '../../types';

type LaunchTokenPreviewCardProps = {
  evidence: BaseLaunchFactoryV2Evidence;
  disabled: boolean;
  isExecuting: boolean;
  txHash?: string;
  onExecute: () => void;
};

const groupedUnits = (atomic: string): string => {
  const [whole, fraction] = formatUnits(BigInt(atomic), 18).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
};

const nativeFee = (atomic: string): string => {
  const formatted = formatEther(BigInt(atomic));
  return `${formatted} ETH`;
};

export function LaunchTokenPreviewCard({
  evidence,
  disabled,
  isExecuting,
  txHash,
  onExecute,
}: LaunchTokenPreviewCardProps) {
  const launchIdentity =
    evidence.saltSource === 'explicit_launch_id'
      ? evidence.launchId
      : 'Canonical token parameters';

  return (
    <section className="space-y-3 border-[3px] border-[#1A1A1A] bg-[#FFF7A8] p-3 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#FDE68A] dark:shadow-[4px_4px_0_#475569] md:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.18em]">
            <Rocket className="h-4 w-4" strokeWidth={4} />
            Deterministic Base launch
          </div>
          <h3 className="mt-1 break-words text-xl font-black leading-tight md:text-2xl">
            {evidence.name}{' '}
            <span className="text-[#0052FF]">${evidence.symbol}</span>
          </h3>
        </div>
        <span className="border-[3px] border-[#1A1A1A] bg-[#D9F99D] px-2 py-1 text-[10px] font-black uppercase shadow-[2px_2px_0_#1A1A1A]">
          Fixed supply
        </span>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="border-[3px] border-[#1A1A1A] bg-white p-3">
          <div className="text-[9px] font-black uppercase tracking-widest text-[#555]">
            Full supply to recipient
          </div>
          <div className="mt-1 break-all text-base font-black">
            {groupedUnits(evidence.totalSupply)} {evidence.symbol}
          </div>
          <div className="mt-1 break-all font-mono text-[9px] font-bold text-[#555]">
            {evidence.totalSupply} atomic · 18 decimals
          </div>
        </div>

        <div className="border-[3px] border-[#1A1A1A] bg-[#BFF7FF] p-3">
          <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-[#555]">
            <WalletCards className="h-3.5 w-3.5" strokeWidth={4} />
            Recipient = active wallet
          </div>
          <div className="mt-2 break-all font-mono text-[10px] font-black">
            {evidence.recipient}
          </div>
        </div>
      </div>

      <div className="border-[3px] border-[#1A1A1A] bg-[#E9D5FF] p-3">
        <div className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-[#555]">
          <Fingerprint className="h-3.5 w-3.5" strokeWidth={4} />
          Creator-scoped CREATE2 identity
        </div>
        <div className="mt-2 text-[10px] font-black uppercase">
          {evidence.saltSource === 'explicit_launch_id'
            ? 'Explicit launch ID'
            : 'Canonical parameters'}
        </div>
        <div className="mt-1 break-all text-xs font-bold">
          {launchIdentity}
        </div>
        <div className="mt-2 break-all font-mono text-[9px] font-bold text-[#555]">
          Salt {evidence.userSalt}
        </div>
      </div>

      <div className="border-[3px] border-[#1A1A1A] bg-white p-3">
        <div className="text-[9px] font-black uppercase tracking-widest text-[#555]">
          Predicted token address
        </div>
        <a
          href={`https://basescan.org/address/${evidence.predictedAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 block break-all font-mono text-[10px] font-black text-[#0052FF] underline decoration-[2px] underline-offset-2"
        >
          {evidence.predictedAddress}
        </a>
      </div>

      <div className="grid gap-2 text-[10px] font-bold md:grid-cols-2">
        <div className="border-[3px] border-[#1A1A1A] bg-[#FFD6A5] p-3">
          <div className="font-black uppercase">Exact deployment fee</div>
          <div className="mt-1 text-base font-black">
            {nativeFee(evidence.deploymentFee)}
          </div>
          <div className="mt-1 break-all font-mono text-[9px]">
            value {evidence.value} wei
          </div>
        </div>
        <div className="border-[3px] border-[#1A1A1A] bg-[#D9F99D] p-3">
          <div className="font-black uppercase">Signed fee ceiling</div>
          <div className="mt-1 text-base font-black">
            {nativeFee(evidence.maxDeploymentFee)}
          </div>
          <div className="mt-1 text-[9px]">
            Governance cannot charge above this transaction limit.
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[9px] font-black uppercase">
        <span className="flex items-center gap-1 border-[2px] border-[#1A1A1A] bg-[#D9F99D] px-2 py-1">
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={4} />
          Simulation passed
        </span>
        <span className="border-[2px] border-[#1A1A1A] bg-white px-2 py-1">
          No admin · no mint · no tax
        </span>
        <span className="border-[2px] border-[#1A1A1A] bg-white px-2 py-1">
          Factory block {evidence.observedAtBlock}
        </span>
      </div>

      <button
        type="button"
        onClick={onExecute}
        disabled={disabled || isExecuting || Boolean(txHash)}
        className={`flex w-full items-center justify-center gap-2 border-[3px] border-[#1A1A1A] py-3 text-sm font-black uppercase tracking-wide text-white shadow-[3px_3px_0_#1A1A1A] transition-all active:translate-y-1 active:shadow-none ${
          txHash
            ? 'bg-[#10B981]'
            : disabled || isExecuting
              ? 'cursor-not-allowed bg-gray-400'
              : 'bg-[#0052FF] hover:bg-blue-700'
        }`}
      >
        {isExecuting ? (
          <Loader2 className="h-5 w-5 animate-spin" strokeWidth={4} />
        ) : txHash ? (
          <CheckCircle2 className="h-5 w-5" strokeWidth={4} />
        ) : (
          <Rocket className="h-5 w-5" strokeWidth={4} />
        )}
        {isExecuting
          ? 'Revalidating + simulating'
          : txHash
            ? 'Token deployed on Base'
            : 'Deploy exact token'}
      </button>
    </section>
  );
}
