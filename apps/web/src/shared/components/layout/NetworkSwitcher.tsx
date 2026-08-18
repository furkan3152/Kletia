import React from "react";
import { Box, CircleDot, Loader2, Orbit, type LucideIcon } from "lucide-react";
import { getNetwork, type NetworkMode } from "../../config/networks";

interface NetworkSwitcherProps {
  networkMode: NetworkMode;
  onSelect: (network: NetworkMode) => void | Promise<unknown>;
  isSwitching?: boolean;
  error?: string | null;
  showStatusBadge?: boolean;
  className?: string;
  compact?: boolean;
}

const NETWORK_PRESENTATION: Record<
  NetworkMode,
  { readonly label: string; readonly status: string; readonly icon: LucideIcon }
> = {
  base: { label: "Base", status: "Mainnet", icon: Box },
  arc: { label: "Arc", status: "Testnet", icon: CircleDot },
  arbitrum: { label: "Arb", status: "Beta", icon: Orbit },
};

export const NetworkSwitcher: React.FC<NetworkSwitcherProps> = ({
  networkMode,
  onSelect,
  isSwitching = false,
  error,
  showStatusBadge = true,
  className = "",
  compact = false,
}) => {
  const currentNetwork = getNetwork(networkMode);
  const options: readonly NetworkMode[] = ["base", "arc", "arbitrum"];

  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5 ${className}`}
      title={error ?? currentNetwork.name}
    >
      <div
        role="group"
        aria-label="Select execution network"
        aria-busy={isSwitching}
        className="relative w-full overflow-hidden border-[3px] border-[#1A1A1A] bg-[#F5F5F0] p-1 shadow-[4px_4px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#0F172A] dark:shadow-[4px_4px_0_#475569]"
        title={currentNetwork.name}
      >
        <div className="relative z-10 grid grid-cols-3 gap-1">
          {options.map((option) => {
            const definition = getNetwork(option);
            const active = option === networkMode;
            const presentation = NETWORK_PRESENTATION[option];
            const Icon = presentation.icon;
            return (
              <button
                key={option}
                type="button"
                disabled={isSwitching || !definition.enabled}
                aria-pressed={active}
                aria-current={active ? "true" : undefined}
                aria-label={`${definition.name}${definition.beta ? ", public beta" : ""}`}
                onClick={() => void Promise.resolve(onSelect(option)).catch(() => {})}
                className={`group relative flex min-h-[52px] min-w-0 items-center justify-center gap-1.5 overflow-hidden border-[2px] border-[#1A1A1A] px-1.5 py-1.5 text-[#1A1A1A] transition-[transform,box-shadow,background-color,color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[2px_2px_0_#1A1A1A] focus-visible:z-20 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-1 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#64748B] dark:text-white dark:hover:shadow-[2px_2px_0_#475569] ${
                  active
                    ? "text-white shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#94A3B8]"
                    : "bg-white hover:bg-[#FFF36D] dark:bg-[#1A2841] dark:hover:bg-[#243652]"
                }`}
                style={{
                  backgroundColor: active ? definition.color : undefined,
                  outlineColor: definition.color,
                }}
              >
                {isSwitching && active ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                ) : !compact ? (
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={3} aria-hidden="true" />
                ) : null}
                <span className="min-w-0 text-left leading-none">
                  <span className="block truncate text-xs font-black uppercase">
                    {presentation.label}
                  </span>
                  {showStatusBadge ? (
                    <span className={`mt-1 block truncate text-[9px] font-black uppercase tracking-[0.08em] ${active ? "text-white/90" : "text-gray-600 dark:text-slate-300"}`}>
                      {presentation.status}
                    </span>
                  ) : null}
                </span>
                {active ? (
                  <span
                    className="absolute right-1 top-1 h-1.5 w-1.5 border border-white bg-[#10B981]"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      {error ? (
        <span className="border-[2px] border-[#1A1A1A] bg-[#EF4444] px-2 py-1 text-[10px] font-black uppercase tracking-wider text-white shadow-[2px_2px_0_#1A1A1A] dark:border-[#64748B] dark:shadow-[2px_2px_0_#475569]" role="alert">
          Switch failed — retry
        </span>
      ) : null}
    </div>
  );
};
