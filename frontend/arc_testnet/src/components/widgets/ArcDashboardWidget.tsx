import React, { useState } from 'react';
import { useWriteContract, useAccount, useBalance, useReadContract } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { ARC_CONTRACTS, ARC_SWAP_ABI, ARC_BATCHPAY_ABI, ARC_VAULT_ABI, ARC_MEMOTRANSFER_ABI, ARC_AGENTREGISTRY_ABI, ARC_STAKING_ABI, ARC_LENDING_ABI } from '../../config/arcConfig';
import { WidgetId } from '../../types';

const WIDGETS = [
  { id: 'swap' as const, icon: '🔄', name: 'Swap', desc: 'USDC / KLET Swap', color: 'bg-[#3B82F6]' },
  { id: 'vault' as const, icon: '🔒', name: 'Vault', desc: 'Time-Locked Vault', color: 'bg-[#8B5CF6]' },
  { id: 'lending' as const, icon: '🏦', name: 'Lending', desc: 'Lend & Borrow', color: 'bg-[#EF4444]' },
  { id: 'staking' as const, icon: '💎', name: 'Staking', desc: 'Stake KLET', color: 'bg-[#06B6D4]' },
  { id: 'liquidity' as const, icon: '💧', name: 'Liquidity', desc: 'Provide LP', color: 'bg-[#10B981]' },
  { id: 'batch' as const, icon: '📦', name: 'Batch Pay', desc: 'Batch Transfer', color: 'bg-[#F59E0B]' },
  { id: 'memo' as const, icon: '📝', name: 'Memo', desc: 'Memo Transfer', color: 'bg-[#EC4899]' },
  { id: 'agent' as const, icon: '🤖', name: 'Agent', desc: 'Register Agent', color: 'bg-[#14B8A6]', disabled: true },
];

export const ArcDashboardWidget: React.FC<{ 
  onWidgetClick: (prompt: string) => void,
  activeWidget?: WidgetId,
  setActiveWidget?: (w: WidgetId) => void,
  minimal?: boolean
}> = ({ onWidgetClick, activeWidget: propsActiveWidget, setActiveWidget: propsSetActiveWidget, minimal = false }) => {
  const [localActiveWidget, setLocalActiveWidget] = useState<WidgetId>(null);
  const activeWidget = propsActiveWidget !== undefined ? propsActiveWidget : localActiveWidget;
  const setActiveWidget = propsSetActiveWidget || setLocalActiveWidget;
  const { isConnected, address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const balance = useBalance({ address });
  const { data: kletRawBalance } = useReadContract({
    address: ARC_CONTRACTS.Token as `0x${string}`,
    abi: [{
      "inputs": [{"internalType": "address", "name": "account", "type": "address"}],
      "name": "balanceOf",
      "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
      "stateMutability": "view",
      "type": "function"
    }],
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
  });

  const { data: swapRate } = useReadContract({
    address: ARC_CONTRACTS.Swap as `0x${string}`,
    abi: ARC_SWAP_ABI,
    functionName: 'consultKletPrice',
  });

  const { data: usdcReserve } = useReadContract({
    address: ARC_CONTRACTS.Swap as `0x${string}`,
    abi: ARC_SWAP_ABI,
    functionName: 'usdcReserve',
  });

  const { data: lendingCollateral } = useReadContract({
    address: ARC_CONTRACTS.Lending as `0x${string}`,
    abi: ARC_LENDING_ABI,
    functionName: 'collateralBalance',
    args: address ? [address] : undefined,
  });

  const { data: lendingBorrow } = useReadContract({
    address: ARC_CONTRACTS.Lending as `0x${string}`,
    abi: ARC_LENDING_ABI,
    functionName: 'getBorrowedBalance',
    args: address ? [address] : undefined,
  });

  const [swapAmount, setSwapAmount] = useState('1');
  const [isUsdcToToken, setIsUsdcToToken] = useState(true);
  const [batchAddresses, setBatchAddresses] = useState('0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A, 0x1234567890123456789012345678901234567890');
  const [batchAmount, setBatchAmount] = useState('5');
  const [vaultAmount, setVaultAmount] = useState('100');
  const [memoTo, setMemoTo] = useState('0xFf3a3CFC42D27E85DbA9Ea85f0bFEC34bd632f9A');
  const [memoAmount, setMemoAmount] = useState('10');
  const [memoText, setMemoText] = useState('Monthly Rent Payment');
  const [agentName, setAgentName] = useState('Data Analysis Agent');
  const [agentDesc, setAgentDesc] = useState('Fetches and analyzes market data.');
  const [agentEndpoint, setAgentEndpoint] = useState('https://agent.kletia.com/data');
  const [agentSkills, setAgentSkills] = useState('data_analysis, python');
  const [stakeAmount, setStakeAmount] = useState('100');
  const [lpUsdcAmount, setLpUsdcAmount] = useState('50');
  const [lpTokenAmount, setLpTokenAmount] = useState('500');
  const [txResult, setTxResult] = useState<{ hash?: string, error?: string } | null>(null);

  const handleTx = async (action: () => Promise<string>) => {
    setTxResult(null);
    try {
      const txHash = await action();
      setTxResult({ hash: txHash });
    } catch (err: any) {
      console.error(err);
      setTxResult({ error: err.shortMessage || err.message });
    }
  };

  const renderTxResult = () => {
    if (!txResult) return null;
    return (
      <div className={`mt-4 p-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] font-bold shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] ${txResult.hash ? 'bg-[#10B981] text-white' : 'bg-[#EF4444] text-white'}`}>
        {txResult.hash ? (
          <div className="flex flex-col gap-2">
            <div className="text-lg">✅ TRANSACTION SUCCESSFUL</div>
            <a href={`https://testnet.arcscan.app/tx/${txResult.hash}`} target="_blank" rel="noreferrer" className="underline decoration-2 underline-offset-2 hover:text-[#1A1A1A] transition-colors">
              🔍 View on ArcScan Explorer
            </a>
          </div>
        ) : (
          <div>
            ❌ ERROR: {txResult.error}
          </div>
        )}
      </div>
    );
  };

  const InputLabel = ({ children }: { children: React.ReactNode }) => (
    <label className="block text-xs font-black uppercase tracking-wider text-[#1A1A1A] dark:text-white mb-2">{children}</label>
  );

  const InputField = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input 
      {...props} 
      className={`w-full p-3 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] focus:outline-none focus:-translate-y-0.5 focus:shadow-[5px_5px_0_#1A1A1A] dark:focus:shadow-[5px_5px_0_#8B5CF6] transition-all font-bold text-[#1A1A1A] dark:text-white disabled:opacity-50 disabled:cursor-not-allowed ${props.className || ''}`} 
    />
  );

  const ActionButton = ({ onClick, disabled, children, colorClass, className = "" }: { onClick: () => void, disabled?: boolean, children: React.ReactNode, colorClass?: string, className?: string }) => (
    <button 
      onClick={onClick} 
      disabled={disabled}
      className={`w-full py-3 px-4 font-black uppercase tracking-widest text-white transition-all duration-200 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] ${disabled ? 'bg-gray-400 dark:bg-slate-600 opacity-80 cursor-not-allowed shadow-[1px_1px_0_#1A1A1A] translate-y-0.5' : `${colorClass || 'bg-[#0052FF]'} hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] dark:hover:shadow-[6px_6px_0_#475569] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A]`} ${className}`}
    >
      {children}
    </button>
  );

  const renderForm = () => {
    switch (activeWidget) {
      case 'lending':
        return (
          <div className="bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] p-4 flex flex-col md:flex-row items-center justify-between animate-slide-up">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4 flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">🏦 KLETIA LENDING <span className="text-sm text-gray-500">(built on Arc)</span></h3>
                <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Provide KLET Collateral, Borrow USDC</p>
              </div>
              <div className="bg-white border-[3px] border-[#1A1A1A] p-2 shadow-[2px_2px_0_#1A1A1A]">
                <div className="text-xs font-black text-gray-500 uppercase">Collateral / Borrow</div>
                <div className="text-sm font-bold">{lendingCollateral ? parseFloat(formatEther(lendingCollateral as bigint)).toFixed(2) : '0'} KLET / {lendingBorrow ? parseFloat(formatEther(lendingBorrow as bigint)).toFixed(2) : '0'} USDC</div>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
               <div>
                  <InputLabel>Add Collateral (KLET)</InputLabel>
                  <InputField type="number" value={vaultAmount} onChange={(e) => setVaultAmount(e.target.value)} placeholder="0.00" />
                  <ActionButton 
                    disabled={isPending || !vaultAmount} 
                    colorClass="bg-[#10B981] hover:bg-[#059669]"
                    onClick={() => handleTx(async () => writeContractAsync({ address: ARC_CONTRACTS.Lending as `0x${string}`, abi: ARC_LENDING_ABI, functionName: 'depositCollateral', args: [parseEther(vaultAmount || '0')] }))}
                  >
                    {isPending ? '⏳ Awaiting...' : '🟢 Add Collateral'}
                  </ActionButton>
               </div>
               <div>
                  <InputLabel>Borrow (USDC)</InputLabel>
                  <InputField type="number" value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value)} placeholder="0.00" />
                  <ActionButton 
                    disabled={isPending || !stakeAmount} 
                    colorClass="bg-[#EF4444] hover:bg-[#DC2626]"
                    onClick={() => handleTx(async () => writeContractAsync({ address: ARC_CONTRACTS.Lending as `0x${string}`, abi: ARC_LENDING_ABI, functionName: 'borrow', args: [parseEther(stakeAmount || '0')] }))}
                  >
                    {isPending ? '⏳ Awaiting...' : '🔴 Borrow'}
                  </ActionButton>
               </div>
            </div>
          </div>
        );

      case 'swap':
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">🔄 KLETIA SWAP <span className="text-sm text-gray-500">(built on Arc)</span></h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Quickly swap between USDC and Tokens.</p>
            </div>
            <div className="mb-4">
              <InputLabel>{isUsdcToToken ? 'Send — USDC' : 'Send — KLET'}</InputLabel>
              <InputField type="number" value={swapAmount} onChange={(e) => setSwapAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="flex justify-center my-4">
              <button 
                onClick={() => setIsUsdcToToken(!isUsdcToToken)} 
                className="w-10 h-10 flex items-center justify-center bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] hover:-translate-y-0.5 active:translate-y-1 active:shadow-none transition-all font-black text-lg text-[#1A1A1A] dark:text-white"
              >
                ⇅
              </button>
            </div>
            <div className="mb-4">
              <InputLabel>{isUsdcToToken ? 'Receive — KLET' : 'Receive — USDC'}</InputLabel>
              <InputField type="text" disabled value="" placeholder="Live quote is available in frontend/base_mainnet" className="bg-gray-200 dark:bg-slate-800" />
            </div>
            <ActionButton 
              disabled={isPending || !swapAmount} 
              colorClass="bg-[#3B82F6] hover:bg-[#2563EB]"
              onClick={() => handleTx(async () => {
                if (isUsdcToToken) {
                  return writeContractAsync({ address: ARC_CONTRACTS.Swap as `0x${string}`, abi: ARC_SWAP_ABI, functionName: 'swapUSDCForToken', value: parseEther(swapAmount || '0') });
                } else {
                  return writeContractAsync({ address: ARC_CONTRACTS.Swap as `0x${string}`, abi: ARC_SWAP_ABI, functionName: 'swapTokenForUSDC', args: [parseEther(swapAmount || '0')] });
                }
              })}
            >
              {isPending ? '⏳ Awaiting Approval...' : '⚡ Swap'}
            </ActionButton>
          </div>
        );

      case 'vault':
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">🔒 KLETIA VAULT <span className="text-sm text-gray-500">(built on Arc)</span></h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Deposit your USDC into a secure time vault and earn interest.</p>
            </div>
            <div className="mb-4">
              <InputLabel>USDC to Deposit</InputLabel>
              <InputField type="number" value={vaultAmount} onChange={(e) => setVaultAmount(e.target.value)} placeholder="0.00" />
            </div>
            <ActionButton 
              disabled={isPending || !vaultAmount} 
              colorClass="bg-[#8B5CF6] hover:bg-[#7C3AED]"
              onClick={() => handleTx(async () => {
                return writeContractAsync({ address: ARC_CONTRACTS.Vault as `0x${string}`, abi: ARC_VAULT_ABI, functionName: 'deposit', value: parseEther(vaultAmount || '0') });
              })}
            >
              {isPending ? '⏳ Awaiting Approval...' : '🔒 Deposit to Vault'}
            </ActionButton>
            <ActionButton 
              disabled={isPending} 
              colorClass="bg-[#0052FF] hover:bg-[#0040DD] dark:bg-blue-600 dark:hover:bg-blue-500"
              onClick={() => handleTx(async () => {
                return writeContractAsync({ address: ARC_CONTRACTS.Vault as `0x${string}`, abi: ARC_VAULT_ABI, functionName: 'withdraw' });
              })}
            >
              {isPending ? '⏳ Awaiting Approval...' : '🔓 Withdraw (Principal + Interest)'}
            </ActionButton>
          </div>
        );

      case 'staking':
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">💎 KLETIA STAKING <span className="text-sm text-gray-500">(built on Arc)</span></h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Earn passive income by staking USDC. Flexible Staking (No lock).</p>
            </div>
            <div className="mb-4">
              <InputLabel>Stake Amount (USDC)</InputLabel>
              <InputField type="number" value={stakeAmount} onChange={(e) => setStakeAmount(e.target.value)} placeholder="0.00" />
            </div>
            <ActionButton 
              disabled={isPending || !stakeAmount} 
              colorClass="bg-[#06B6D4] hover:bg-[#0891B2]"
              onClick={() => handleTx(async () => {
                return writeContractAsync({ address: ARC_CONTRACTS.Staking as `0x${string}`, abi: ARC_STAKING_ABI, functionName: 'stake', value: parseEther(stakeAmount || '0') });
              })}
            >
              {isPending ? '⏳ Awaiting Approval...' : '💎 Stake'}
            </ActionButton>
            <div className="flex gap-4 mt-4">
              <ActionButton 
                disabled={isPending} 
                colorClass="bg-[#10B981] hover:bg-[#059669]"
                className="mt-0"
                onClick={() => handleTx(async () => {
                  return writeContractAsync({ address: ARC_CONTRACTS.Staking as `0x${string}`, abi: ARC_STAKING_ABI, functionName: 'claimRewards' });
                })}
              >
                🎁 Claim Rewards
              </ActionButton>
              <ActionButton 
                disabled={isPending} 
                colorClass="bg-[#EF4444] hover:bg-[#DC2626]"
                className="mt-0"
                onClick={() => handleTx(async () => {
                  return writeContractAsync({ address: ARC_CONTRACTS.Staking as `0x${string}`, abi: ARC_STAKING_ABI, functionName: 'unstake', args: [parseEther(stakeAmount || '0')] });
                })}
              >
                🔓 Unstake
              </ActionButton>
            </div>
          </div>
        );

      case 'liquidity':
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">💧 KLETIA LIQUIDITY <span className="text-sm text-gray-500">(built on Arc)</span></h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Provide liquidity to USDC/Token pair and earn a share of swap fees.</p>
            </div>
            <div className="mb-4">
              <InputLabel>USDC Amount</InputLabel>
              <InputField type="number" value={lpUsdcAmount} onChange={(e) => setLpUsdcAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="mb-4">
              <InputLabel>Token Amount</InputLabel>
              <InputField type="number" value={lpTokenAmount} onChange={(e) => setLpTokenAmount(e.target.value)} placeholder="0.00" />
            </div>
            <ActionButton 
              disabled={isPending || !lpUsdcAmount || !lpTokenAmount} 
              colorClass="bg-[#10B981] hover:bg-[#059669]"
              onClick={() => handleTx(async () => {
                return writeContractAsync({ address: ARC_CONTRACTS.Swap as `0x${string}`, abi: ARC_SWAP_ABI, functionName: 'addLiquidity', args: [parseEther(lpTokenAmount || '0')], value: parseEther(lpUsdcAmount || '0') });
              })}
            >
              {isPending ? '⏳ Awaiting Approval...' : '💧 Add Liquidity'}
            </ActionButton>
          </div>
        );

      case 'batch':
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">📦 KLETIA BATCH PAY <span className="text-sm text-gray-500">(built on Arc)</span></h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Send USDC to multiple wallets in a single transaction.</p>
            </div>
            <div className="mb-4">
              <InputLabel>Recipients (comma separated)</InputLabel>
              <InputField type="text" value={batchAddresses} onChange={(e) => setBatchAddresses(e.target.value)} placeholder="0x123..., 0x456..." />
            </div>
            <div className="mb-4">
              <InputLabel>USDC per Person</InputLabel>
              <InputField type="number" value={batchAmount} onChange={(e) => setBatchAmount(e.target.value)} placeholder="0.00" />
            </div>
            <ActionButton 
              disabled={isPending || !batchAddresses || !batchAmount} 
              colorClass="bg-[#F59E0B] hover:bg-[#D97706]"
              onClick={() => handleTx(async () => {
                const addrs = batchAddresses.split(',').map(a => a.trim() as `0x${string}`);
                const amounts = addrs.map(() => parseEther(batchAmount || '0'));
                const total = amounts.reduce((a, b) => a + b, BigInt(0));
                return writeContractAsync({ address: ARC_CONTRACTS.BatchPay as `0x${string}`, abi: ARC_BATCHPAY_ABI, functionName: 'batchPay', args: [addrs, amounts, 'Kletia Batch'], value: total });
              })}
            >
              {isPending ? '⏳ Sending...' : '📦 Batch Send'}
            </ActionButton>
          </div>
        );

      case 'memo':
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">📝 KLETIA MEMO PAY <span className="text-sm text-gray-500">(built on Arc)</span></h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Send USDC with a permanent on-chain message.</p>
            </div>
            <div className="mb-4">
              <InputLabel>Recipient Address</InputLabel>
              <InputField type="text" value={memoTo} onChange={(e) => setMemoTo(e.target.value)} placeholder="0x..." />
            </div>
            <div className="mb-4">
              <InputLabel>USDC Amount</InputLabel>
              <InputField type="number" value={memoAmount} onChange={(e) => setMemoAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="mb-4">
              <InputLabel>Your On-chain Memo</InputLabel>
              <InputField type="text" value={memoText} onChange={(e) => setMemoText(e.target.value)} placeholder="This payment is for rent..." />
            </div>
            <ActionButton 
              disabled={isPending || !memoTo || !memoAmount || !memoText} 
              colorClass="bg-[#EC4899] hover:bg-[#DB2777]"
              onClick={() => handleTx(async () => {
                return writeContractAsync({ address: ARC_CONTRACTS.MemoTransfer as `0x${string}`, abi: ARC_MEMOTRANSFER_ABI, functionName: 'transferWithMemo', args: [memoTo as `0x${string}`, memoText], value: parseEther(memoAmount || '0') });
              })}
            >
              {isPending ? '⏳ Sending...' : '📝 Memo Transfer'}
            </ActionButton>
          </div>
        );

      case 'agent':
        return (
          <div className="p-6 bg-[#F3F4F6] dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
            <div className="mb-6 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
              <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight">🤖 KLETIA AGENT REGISTRY <span className="text-sm text-gray-500">(built on Arc)</span></h3>
              <p className="text-sm font-bold text-gray-600 dark:text-gray-400 mt-1">Register your AI agent on-chain (ERC-8004).</p>
            </div>
            <div className="mb-4">
              <InputLabel>Agent Name</InputLabel>
              <InputField type="text" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Alpha Trader AI" />
            </div>
            <div className="mb-4">
              <InputLabel>Description</InputLabel>
              <InputField type="text" value={agentDesc} onChange={(e) => setAgentDesc(e.target.value)} placeholder="Hunts for arbitrage opportunities" />
            </div>
            <div className="mb-4">
              <InputLabel>Skills (comma separated)</InputLabel>
              <InputField type="text" value={agentSkills} onChange={(e) => setAgentSkills(e.target.value)} placeholder="defi, arbitrage, analytics" />
            </div>
            <div className="mb-4">
              <InputLabel>Endpoint URL</InputLabel>
              <InputField type="text" value={agentEndpoint} onChange={(e) => setAgentEndpoint(e.target.value)} placeholder="https://api.myagent.ai" />
            </div>
            <ActionButton 
              disabled={isPending || !agentName || !agentDesc} 
              colorClass="bg-[#14B8A6] hover:bg-[#0D9488]"
              onClick={() => handleTx(async () => {
                const skills = agentSkills.split(',').map(s => s.trim()).filter(Boolean);
                return writeContractAsync({ address: ARC_CONTRACTS.AgentRegistry as `0x${string}`, abi: ARC_AGENTREGISTRY_ABI, functionName: 'registerAgent', args: [agentName, agentDesc, skills, agentEndpoint || 'https://kletia.app'] });
              })}
            >
              {isPending ? '⏳ Registering...' : '🤖 Register On-Chain'}
            </ActionButton>
          </div>
        );

      default:
        return null;
    }
  };

  if (minimal) {
    return activeWidget ? (
      <div className="w-full">
        {renderForm()}
        {renderTxResult()}
      </div>
    ) : null;
  }

  return (
    <div className="w-full max-w-7xl mx-auto space-y-8 p-4 md:p-8 animate-fade-in pb-20">

      {}
      <div className="bg-[#8B5CF6] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] p-6 md:p-10 flex flex-col lg:flex-row gap-8 justify-between relative overflow-hidden">
        {}
        <div className="absolute -right-10 -top-10 w-40 h-40 bg-white border-[4px] border-[#1A1A1A] rotate-12 opacity-20 pointer-events-none"></div>
        <div className="absolute right-40 -bottom-10 w-24 h-24 rounded-full bg-[#10B981] border-[4px] border-[#1A1A1A] pointer-events-none"></div>

        <div className="z-10 flex flex-col gap-4 max-w-2xl">
          <div className="inline-block bg-white text-[#1A1A1A] border-[3px] border-[#1A1A1A] font-black uppercase tracking-widest text-xs px-3 py-1 shadow-[3px_3px_0_#1A1A1A] w-max">
            KLETIA OMNI-ENGINE
          </div>
          <h2 className="text-4xl md:text-6xl font-black text-white tracking-tight uppercase leading-none drop-shadow-[4px_4px_0_#1A1A1A]">
            DASHBOARD
          </h2>
          <p className="text-lg md:text-xl font-bold text-white bg-[#1A1A1A] p-2 inline-block shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] w-max">
            Built on Arc Network - Circle developed by, USDC-native Layer-1
          </p>

          {}
          <div className="flex flex-wrap gap-4 mt-6">
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <span className="text-xs font-black text-gray-500 uppercase block mb-1">KLET Price</span>
              <span className="text-xl font-black text-[#1A1A1A] flex items-center gap-2">
                {swapRate && Number(swapRate) > 0 ? `$${(1 / Number(swapRate)).toFixed(3)}` : '—'} <span className="text-xs text-[#10B981] bg-[#D1FAE5] px-2 py-0.5 border-[2px] border-[#10B981]">On-Chain</span>
              </span>
            </div>
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <span className="text-xs font-black text-gray-500 uppercase block mb-1">Total Liquidity (USDC)</span>
              <span className="text-xl font-black text-[#1A1A1A]">{usdcReserve ? `$${parseFloat(formatEther(usdcReserve as bigint)).toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}` : '—'}</span>
            </div>
            <div className="bg-white border-[3px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] min-w-[140px]">
              <span className="text-xs font-black text-gray-500 uppercase block mb-1">Network Status</span>
              <span className="text-xl font-black text-[#10B981] flex items-center gap-2">
                <span className="w-3 h-3 bg-[#10B981] border-[2px] border-[#1A1A1A] rounded-full animate-pulse"></span>
                ACTIVE
              </span>
            </div>
          </div>
        </div>

        <div className="z-10 bg-white dark:bg-[#0F172A] border-[4px] border-[#1A1A1A] shadow-[6px_6px_0_#1A1A1A] p-6 lg:min-w-[300px] flex flex-col justify-center">
          <div className="mb-4">
            <span className="text-xs font-black text-gray-500 uppercase block mb-1">Balance</span>
            <div className="text-4xl font-black text-[#1A1A1A] dark:text-white flex items-end gap-2">
              {isConnected && balance.data ? parseFloat(formatEther(balance.data.value)).toFixed(4) : '—'} 
              <span className="text-lg text-[#3B82F6] mb-1">USDC</span>
            </div>
            <div className="text-xl font-bold text-gray-600 dark:text-gray-400 mt-2 flex items-center gap-2">
              {isConnected && kletRawBalance !== undefined ? parseFloat(formatEther(kletRawBalance as bigint)).toFixed(4) : '—'} 
              <span className="text-sm text-[#8B5CF6] font-black">KLET</span>
            </div>
          </div>
          <div className="pt-4 border-t-[3px] border-[#1A1A1A] dark:border-slate-700 flex items-center gap-2">
            <div className={`w-4 h-4 border-[2px] border-[#1A1A1A] ${isConnected ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`}></div>
            <span className="font-black text-[#1A1A1A] dark:text-white uppercase text-sm">
              {isConnected ? 'WALLET CONNECTED' : 'NOT CONNECTED'}
            </span>
          </div>
        </div>
      </div>

      {}
      {}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
        {WIDGETS.map(w => (
          <button 
            key={w.id} 
            disabled={w.disabled}
            className={`relative group text-left bg-white dark:bg-[#1E293B] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-4 flex flex-col justify-between min-h-[140px] ${
              w.disabled 
                ? 'opacity-70 cursor-not-allowed grayscale-[0.5] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]'
                : 'shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] hover:-translate-y-1 hover:shadow-[8px_8px_0_#1A1A1A] active:translate-y-0 active:shadow-[2px_2px_0_#1A1A1A] transition-all'
            } ${activeWidget === w.id ? 'bg-[#E2E8F0] dark:bg-[#334155] translate-y-1 shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569]' : ''}`}
            onClick={() => !w.disabled && setActiveWidget(activeWidget === w.id ? null : w.id)}
          >
            {w.disabled && (
              <span className="absolute top-2 right-2 text-[10px] bg-[#FACC15] text-[#1A1A1A] border-[2px] border-[#1A1A1A] px-2 py-0.5 font-black uppercase tracking-widest rotate-[5deg] shadow-[2px_2px_0_#1A1A1A] z-10">
                SOON
              </span>
            )}
            <div className={`w-12 h-12 flex items-center justify-center border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] text-2xl ${w.color} ${!w.disabled ? 'group-hover:-translate-y-1 group-hover:shadow-[4px_4px_0_#1A1A1A] transition-transform' : ''}`}>
              {w.icon}
            </div>
            <div className="mt-4">
              <span className={`block text-lg font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight ${w.disabled ? 'line-through decoration-2' : ''}`}>{w.name}</span>
              <span className="block text-xs font-bold text-gray-500 mt-1">{w.desc}</span>
            </div>
          </button>
        ))}
      </div>

      {}
      {activeWidget && (
        <div className="relative mt-8 animate-fade-in-up">
          <button 
            className="absolute -top-4 -right-4 w-10 h-10 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 active:translate-y-0 transition-all font-black text-xl text-[#1A1A1A] dark:text-white z-10 flex items-center justify-center"
            onClick={() => setActiveWidget(null)}
          >
            ✕
          </button>
          {renderForm()}
          {renderTxResult()}
        </div>
      )}

      {}
      <div className="bg-[#F8FAFC] dark:bg-[#111827] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] p-6 md:p-8 mt-12">
        <h3 className="text-2xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tight mb-6 flex items-center gap-3">
          <span className="w-8 h-8 bg-[#FACC15] border-[3px] border-[#1A1A1A] flex items-center justify-center shadow-[2px_2px_0_#1A1A1A]">⚡</span> 
          Kletia Omni-Features
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { icon: '🔒', name: 'Vault AI', desc: 'Smart Investment', prompt: 'Transfer 50 USDC to my Kletia vault on Arc network immediately, I want to earn interest' },
            { icon: '✉️', name: 'Memo Pay', desc: 'Memo Payment', prompt: 'Send 10 USDC to Ahmet\'s wallet 0xFf... with rent payment description' },
            { icon: '💦', name: 'Liquidity', desc: 'Pool Funding', prompt: 'Add 10 USDC liquidity to Kletia Swap pool on Arc network' },
            { icon: '🔄', name: 'Swap', desc: 'USDC/KLETIA', prompt: 'Swap my 5 USDC for Kletia test token' },
            { icon: '💎', name: 'Stake', desc: 'Flexible Lock', prompt: 'Lock 25 USDC to Kletia staking contract on Arc network for the future' },
            { icon: '🏦', name: 'Lend', desc: 'Lend Assets', prompt: 'Lend 5 USDC to Kletia Lending on Arc network' },
            { icon: '💸', name: 'Borrow', desc: 'Borrow Assets', prompt: 'Borrow 5 USDC from Kletia Lending on Arc network' },
          ].map((f, i) => (
            <button 
              key={i} 
              className="flex items-center gap-4 bg-white dark:bg-[#1E293B] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-3 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all text-left"
              onClick={() => onWidgetClick(f.prompt)}
            >
              <span className="w-10 h-10 flex items-center justify-center bg-[#E2E8F0] dark:bg-[#0F172A] border-[2px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[2px_2px_0_#1A1A1A] text-xl shrink-0">{f.icon}</span>
              <div>
                <span className="block text-sm font-black text-[#1A1A1A] dark:text-white uppercase">{f.name}</span>
                <span className="block text-xs font-bold text-gray-500">{f.desc}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {}
      <div className="flex flex-wrap gap-4 mt-8">
        {[
          { name: '🔍 ArcScan Explorer', url: 'https://testnet.arcscan.app', color: 'bg-[#3B82F6]' },
          { name: '🚰 USDC Faucet', url: 'https://faucet.circle.com', color: 'bg-[#10B981]' },
          { name: '📖 Arc Docs', url: 'https://docs.arc.io', color: 'bg-[#F59E0B]' }
        ].map((link, i) => (
          <a 
            key={i}
            href={link.url} 
            target="_blank" 
            rel="noopener noreferrer" 
            className={`px-4 py-2 border-[3px] border-[#1A1A1A] ${link.color} text-white font-black uppercase text-sm shadow-[4px_4px_0_#1A1A1A] hover:-translate-y-1 hover:shadow-[6px_6px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all`}
          >
            {link.name}
          </a>
        ))}
      </div>
    </div>
  );
};
