import React from 'react';
import { NetworkMode } from '../../config/networks';

interface NetworkSwitcherProps {
  networkMode: NetworkMode;
  onToggle: () => void;
}

export const NetworkSwitcher: React.FC<NetworkSwitcherProps> = ({ networkMode, onToggle }) => {
  const isArc = networkMode === 'arc';

  return (
    <div className="flex items-center">
      <button
        onClick={onToggle}
        className="relative flex items-center border-[3px] border-[#1A1A1A] dark:border-[#4B5563] bg-white dark:bg-[#1A2841] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] hover:-translate-y-1 hover:shadow-[5px_5px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all duration-100 ease-out cursor-pointer overflow-hidden p-1"
        title={`Switch to ${isArc ? 'Base' : 'ARC'} network`}
      >
        <div className="flex z-10 w-32 relative">
          {/* Active Slider */}
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

      {isArc && (
        <span className="ml-2 px-2 py-1 text-[9px] font-black text-white bg-[#8B5CF6] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] uppercase tracking-widest hidden sm:inline-block">
          TESTNET
        </span>
      )}
    </div>
  );
};
