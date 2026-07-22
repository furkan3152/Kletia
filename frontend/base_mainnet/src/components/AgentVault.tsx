import { useState, useEffect } from 'react';
import { Bot, Copy, ExternalLink, Loader2, Wallet } from 'lucide-react';
import { useAccount } from 'wagmi';


export function AgentVault({ 
  agentWallet, 
  onQuickAction 
}: { 
  agentWallet: string;
  onQuickAction: (text: string) => void;
}) {
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);
  const [balance, setBalance] = useState<{ ETH: string, USDC: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);


  useEffect(() => {
    if (address) {
      setIsLoading(true);
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
      fetch(`${BACKEND_URL}/api/agent/vault/balance?userAddress=${address}`)
        .then(res => res.json())
        .then(data => {
          if (data.balances) {
            setBalance(data.balances);
          }
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [address]);

  const copyAddress = () => {
    navigator.clipboard.writeText(agentWallet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const explorerUrl = `https://sepolia.basescan.org/address/${agentWallet}`;
  const explorerTitle = "View on Basescan";

  return (
    <div className="bg-[#FDFDFD] dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-4 md:p-6 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col gap-4 mb-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-4">
        <div className="shrink-0 w-12 h-12 bg-[#0052FF] dark:bg-[#60A5FA] flex items-center justify-center border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
          <Bot className="w-6 h-6 text-white dark:text-[#1A1A1A]" />
        </div>
        <div>
          <h3 className="text-[#1A1A1A] dark:text-white font-black uppercase tracking-wide text-base md:text-lg leading-tight">Your Agent Wallet (CDP)</h3>
          <p className="text-gray-600 dark:text-gray-400 text-[10px] md:text-xs font-bold">Your autonomous wallet managed by Coinbase MPC.</p>
        </div>
      </div>

      {/* Address Area */}
      <div className="bg-white dark:bg-[#1A2841] p-3 md:p-4 flex items-center justify-between border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
        <div className="font-mono text-[#0052FF] dark:text-[#60A5FA] font-bold text-xs md:text-sm break-all mr-4">
          {agentWallet}
        </div>
        <div className="flex gap-2 shrink-0">
          <button 
            onClick={copyAddress}
            className="p-2 bg-gray-100 dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] hover:bg-[#FFD700] dark:hover:bg-[#60A5FA] dark:hover:text-[#1A1A1A] transition-colors text-[#1A1A1A] dark:text-white active:translate-y-1 active:shadow-none shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569]"
            title="Copy Address"
          >
            {copied ? <span className="text-green-600 dark:text-[#1A1A1A] text-[10px] font-black uppercase tracking-tighter">OK!</span> : <Copy className="w-4 h-4 md:w-5 md:h-5" strokeWidth={3} />}
          </button>
          <a 
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 bg-gray-100 dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] hover:bg-[#FFD700] dark:hover:bg-[#60A5FA] dark:hover:text-[#1A1A1A] transition-colors text-[#1A1A1A] dark:text-white active:translate-y-1 active:shadow-none shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569]"
            title={explorerTitle}
          >
            <ExternalLink className="w-4 h-4 md:w-5 md:h-5" strokeWidth={3} />
          </a>
        </div>
      </div>

      {/* Balances */}
      <div className="flex flex-col sm:flex-row gap-3 md:gap-4 mt-2">
        <div className="flex-1 bg-white dark:bg-[#1A2841] p-3 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] flex items-center gap-3 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
          <Wallet className="w-5 h-5 text-[#0052FF] dark:text-[#60A5FA]" strokeWidth={3} />
          <div>
            <div className="text-[10px] md:text-xs font-black text-gray-500 dark:text-gray-400 uppercase tracking-widest">ETH Balance</div>
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#0052FF] dark:text-[#60A5FA] mt-1" />
            ) : (
              <div className="text-[#1A1A1A] dark:text-white font-black font-mono text-sm md:text-base">
                {balance ? `${parseFloat(balance.ETH).toFixed(5)} ETH` : '0.00000 ETH'}
              </div>
            )}
          </div>
        </div>
        
        <div className="flex-1 bg-white dark:bg-[#1A2841] p-3 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] flex items-center gap-3 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569]">
          <div className="w-5 h-5 rounded-full bg-[#0052FF] dark:bg-[#60A5FA] flex items-center justify-center text-xs font-black text-white dark:text-[#1A1A1A] border-[2px] border-[#1A1A1A] dark:border-[#4B5563]">$</div>
          <div>
            <div className="text-[10px] md:text-xs font-black text-gray-500 dark:text-gray-400 uppercase tracking-widest">USDC Balance</div>
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#0052FF] dark:text-[#60A5FA] mt-1" />
            ) : (
              <div className="text-[#1A1A1A] dark:text-white font-black font-mono text-sm md:text-base">
                {balance ? `${parseFloat(balance.USDC).toFixed(2)} USDC` : '0.00 USDC'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-4 border-t-[3px] border-[#1A1A1A] dark:border-[#4B5563] pt-4">
        <div className="text-[10px] text-[#1A1A1A] dark:text-gray-400 mb-2 uppercase tracking-widest font-black">Quick Actions</div>
        <div className="flex flex-wrap gap-2">
          <button 
            onClick={() => onQuickAction('fetch premium alpha signals')}
            className="px-3 py-1.5 bg-[#FFD700] hover:bg-[#FACC15] dark:bg-yellow-500 dark:hover:bg-yellow-400 text-[#1A1A1A] font-black text-xs md:text-sm border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] active:translate-y-1 active:shadow-none transition-all"
          >
            🔥 Get Alpha Signals
          </button>
          <button 
            onClick={() => onQuickAction('find the best yield strategy')}
            className="px-3 py-1.5 bg-[#0052FF] hover:bg-blue-700 dark:bg-[#60A5FA] dark:hover:bg-[#3B82F6] text-white dark:text-[#1A1A1A] font-black text-xs md:text-sm border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] active:translate-y-1 active:shadow-none transition-all"
          >
            💰 Yield Strategy
          </button>
          <button 
            onClick={() => onQuickAction('find me a risk-free arbitrage route')}
            className="px-3 py-1.5 bg-white hover:bg-gray-100 dark:bg-[#8B5CF6] dark:hover:bg-indigo-500 text-[#1A1A1A] dark:text-white font-black text-xs md:text-sm border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] active:translate-y-1 active:shadow-none transition-all"
          >
            ⚡ Find Arbitrage
          </button>
        </div>
      </div>
    </div>
  );
}
