import React from 'react';
import { getNetwork, type NetworkMode } from '../../config/networks';

interface NetworkSwitcherProps {
  networkMode: NetworkMode;
  onToggle: () => void | Promise<unknown>;
  isSwitching?: boolean;
  error?: string | null;
  showStatusBadge?: boolean;
}

export const NetworkSwitcher: React.FC<NetworkSwitcherProps> = ({
  networkMode,
  onToggle,
  isSwitching = false,
  error,
  showStatusBadge = true,
}) => {
  const isArc = networkMode === 'arc';
  const currentNetwork = getNetwork(networkMode);
  const targetNetwork = getNetwork(isArc ? 'base' : 'arc');

  const handleToggle = () => {
    void Promise.resolve(onToggle()).catch(() => {

    });
  };

  return (
    <div className="flex items-center" title={error ?? currentNetwork.name}>
      <button
        type="button"
        onClick={handleToggle}
        disabled={isSwitching}
        aria-label={`Switch to ${targetNetwork.name}`}
        aria-busy={isSwitching}
        className="relative flex items-center border-[3px] border-[#1A1A1A] dark:border-[#4B5563] bg-white dark:bg-[#1A2841] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all duration-100 ease-out cursor-pointer overflow-hidden p-1 disabled:cursor-wait disabled:opacity-60"
        title={`Switch to ${targetNetwork.name}`}
      >
        <div className="flex z-10 w-32 relative">
          {}
          <div 
            className={`absolute top-0 left-0 h-full w-1/2 border-[2px] border-[#1A1A1A] transition-transform duration-200 ease-in-out ${isArc ? 'translate-x-full bg-[#8B5CF6]' : 'translate-x-0 bg-[#0052FF]'}`}
          />

          <div className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 z-20 text-[10px] font-black uppercase transition-colors ${!isArc ? 'text-white' : 'text-[#1A1A1A] dark:text-gray-400'}`}>
            <span>🔵</span> Base
          </div>
          <div className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 z-20 text-[10px] font-black uppercase transition-colors ${isArc ? 'text-white' : 'text-[#1A1A1A] dark:text-gray-400'}`}>
            <span>🌀</span> ARC
          </div>
        </div>
      </button>

      {showStatusBadge && isArc && (
        <span className="ml-2 px-2 py-1 text-[9px] font-black text-white bg-[#8B5CF6] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] uppercase tracking-widest hidden sm:inline-block">
          TESTNET
        </span>
      )}

      {showStatusBadge && error && (
        <span className="ml-2 px-2 py-1 text-[9px] font-black text-white bg-[#EF4444] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] uppercase tracking-widest hidden xl:inline-block">
          Switch failed
        </span>
      )}
    </div>
  );
};
