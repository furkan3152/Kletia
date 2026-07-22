import { useState } from 'react';
import { AgentWidgetContainer } from './AgentWidgetContainer';
import { Play, Square } from 'lucide-react';

interface Props {
  initialTarget?: string;
  onClose?: () => void;
}

export function CopyTradeWidget({ initialTarget = "", onClose }: Props) {
  const [targetWallet, setTargetWallet] = useState(initialTarget);
  const [maxSpend, setMaxSpend] = useState("50");
  const [isActive, setIsActive] = useState(false);

  const toggleTracking = () => {
    if (!targetWallet) return alert("Enter wallet address to track.");
    setIsActive(!isActive);
  };

  return (
    <AgentWidgetContainer title="Kletia Balina Takibi" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="block text-sm font-bold mb-1">🎯 Target (Whale) Wallet</label>
          <input 
            type="text" 
            value={targetWallet}
            onChange={(e) => setTargetWallet(e.target.value)}
            disabled={isActive}
            placeholder="0x..." 
            className="w-full p-2 bg-transparent border-2 border-[#1A1A1A] dark:border-[#333] rounded focus:outline-none focus:border-[#60A5FA] dark:focus:border-[#CCA000]"
          />
        </div>
        
        <div>
          <label className="block text-sm font-bold mb-1">💰 Max Limit per Transaction (USDC)</label>
          <input 
            type="number" 
            value={maxSpend}
            onChange={(e) => setMaxSpend(e.target.value)}
            disabled={isActive}
            className="w-full p-2 bg-transparent border-2 border-[#1A1A1A] dark:border-[#333] rounded focus:outline-none focus:border-[#60A5FA] dark:focus:border-[#CCA000]"
          />
        </div>

        <button 
          onClick={toggleTracking}
          className={`w-full py-3 mt-2 border-2 border-[#1A1A1A] rounded font-bold flex items-center justify-center gap-2 transition-all ${
            isActive 
              ? "bg-red-500 text-white hover:bg-red-600 shadow-[4px_4px_0px_#1A1A1A]" 
              : "bg-[#60A5FA] dark:bg-[#CCA000] text-[#1A1A1A] hover:translate-y-1 hover:shadow-[0px_0px_0px_#1A1A1A] shadow-[4px_4px_0px_#1A1A1A]"
          }`}
        >
          {isActive ? (
            <><Square size={18} fill="currentColor"/> Stop Tracking</>
          ) : (
            <><Play size={18} fill="currentColor"/> Start Auto Copying</>
          )}
        </button>

        {isActive && (
          <div className="p-3 bg-[#1A1A1A] border-2 border-[#333] rounded mt-2">
            <div className="flex items-center gap-2 text-green-400 text-sm font-mono animate-pulse">
              <span className="w-2 h-2 rounded-full bg-green-400"></span>
              On-chain mempool dinleniyor...
            </div>
          </div>
        )}
      </div>
    </AgentWidgetContainer>
  );
}
