import React from "react";
import { getNetwork, type NetworkMode } from "../../config/networks";

interface NetworkSwitcherProps {
  networkMode: NetworkMode;
  onSelect: (network: NetworkMode) => void | Promise<unknown>;
  isSwitching?: boolean;
  error?: string | null;
  showStatusBadge?: boolean;
}

export const NetworkSwitcher: React.FC<NetworkSwitcherProps> = ({
  networkMode,
  onSelect,
  isSwitching = false,
  error,
  showStatusBadge = true,
}) => {
  const currentNetwork = getNetwork(networkMode);
  const options: readonly NetworkMode[] = ["base", "arc", "arbitrum"];

  return (
    <div className="flex min-w-0 items-center" title={error ?? currentNetwork.name}>
      <div
        role="group"
        aria-label="Select execution network"
        aria-busy={isSwitching}
        className="relative flex min-h-11 items-center overflow-hidden border-[3px] border-[#1A1A1A] bg-white p-1 shadow-[3px_3px_0_#1A1A1A] transition-[transform,box-shadow,opacity] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none disabled:cursor-wait disabled:opacity-60 dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569]"
        title={currentNetwork.name}
      >
        <div className="relative z-10 grid h-8 grid-cols-3">
          {options.map((option) => {
            const definition = getNetwork(option);
            const active = option === networkMode;
            return (
              <button
                key={option}
                type="button"
                disabled={isSwitching || active || !definition.enabled}
                aria-pressed={active}
                onClick={() => void Promise.resolve(onSelect(option)).catch(() => {})}
                className={`flex min-w-[62px] items-center justify-center gap-1 border-2 border-[#1A1A1A] px-2 text-[9px] font-black uppercase disabled:cursor-default disabled:opacity-50 ${active ? "text-white" : "text-[#1A1A1A] dark:text-gray-200"}`}
                style={{ backgroundColor: active ? definition.color : undefined }}
              >
                {definition.shortName}
                {definition.beta ? <small className="text-[7px]">BETA</small> : null}
              </button>
            );
          })}
        </div>
      </div>

      {showStatusBadge && networkMode === "arc" && (
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
