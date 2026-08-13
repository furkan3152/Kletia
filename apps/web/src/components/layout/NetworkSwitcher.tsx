import React from "react";
import { getNetwork, type NetworkMode } from "../../config/networks";

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
  const isArc = networkMode === "arc";
  const currentNetwork = getNetwork(networkMode);
  const targetNetwork = getNetwork(isArc ? "base" : "arc");

  const handleToggle = () => {
    void Promise.resolve(onToggle()).catch(() => {});
  };

  return (
    <div className="flex min-w-0 items-center" title={error ?? currentNetwork.name}>
      <button
        type="button"
        onClick={handleToggle}
        disabled={isSwitching}
        aria-label={`Switch to ${targetNetwork.name}`}
        aria-busy={isSwitching}
        className="relative flex min-h-11 items-center overflow-hidden border-[3px] border-[#1A1A1A] bg-white p-1 shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,opacity] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none disabled:cursor-wait disabled:opacity-60 dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569]"
        title={`Switch to ${targetNetwork.name}`}
      >
        <div className="relative z-10 flex h-8 w-32">
          <div
            className={`absolute top-0 left-0 h-full w-1/2 border-[2px] border-[#1A1A1A] transition-transform duration-200 ease-in-out ${isArc ? "translate-x-full bg-[#8B5CF6]" : "translate-x-0 bg-[#0052FF]"}`}
          />

          <div
            className={`z-20 flex flex-1 items-center justify-center gap-1.5 px-2 py-1 text-[10px] font-black uppercase transition-colors duration-100 ${!isArc ? "text-white" : "text-[#1A1A1A] dark:text-gray-300"}`}
          >
            <span
              className="h-2 w-2 rounded-full border border-current bg-[#0052FF]"
              aria-hidden="true"
            />
            Base
          </div>
          <div
            className={`z-20 flex flex-1 items-center justify-center gap-1.5 px-2 py-1 text-[10px] font-black uppercase transition-colors duration-100 ${isArc ? "text-white" : "text-[#1A1A1A] dark:text-gray-300"}`}
          >
            <span
              className="h-2 w-2 rounded-full border border-current bg-[#8B5CF6]"
              aria-hidden="true"
            />
            Arc
          </div>
        </div>
      </button>

      {showStatusBadge && isArc && (
        <span className="ml-3 hidden min-h-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-[#8B5CF6] px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:shadow-[3px_3px_0_#475569] sm:inline-flex">
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
