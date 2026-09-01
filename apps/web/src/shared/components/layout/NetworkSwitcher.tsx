import React from "react";
import { Box, CircleDot, Loader2, Orbit, Sparkles, type LucideIcon } from "lucide-react";
import {
  getNetwork,
  STELLAR_WORKSPACE_ENABLED,
  type NetworkMode,
} from "../../config/networks";

export type WorkspaceMode = NetworkMode | "stellar";

type LaneOption = {
  readonly id: string;
  readonly workspace: WorkspaceMode;
  readonly presentation: {
    readonly label: string;
    readonly status: string;
    readonly icon: LucideIcon;
    readonly name: string;
    readonly color: string;
    readonly enabled: boolean;
    readonly beta?: boolean;
  };
};

interface NetworkSwitcherProps {
  networkMode: WorkspaceMode;
  onSelect: (network: WorkspaceMode) => void | Promise<unknown>;
  isSwitching?: boolean;
  error?: string | null;
  showStatusBadge?: boolean;
  className?: string;
  compact?: boolean;
}

const NETWORK_PRESENTATION: Record<
  WorkspaceMode,
  { readonly label: string; readonly status: string; readonly icon: LucideIcon; readonly name: string; readonly color: string; readonly enabled: boolean; readonly beta?: boolean }
> = {
  base: { label: "Base", status: "Mainnet", icon: Box, name: "Base Mainnet", color: "#0052FF", enabled: true },
  arc: { label: "Arc", status: "Testnet", icon: CircleDot, name: "Arc Testnet", color: "#F59E0B", enabled: true },
  arbitrum: { label: "Arb", status: "Mainnet", icon: Orbit, name: "Arbitrum One", color: "#28A0F0", enabled: getNetwork("arbitrum").enabled, beta: true },
  stellar: { label: "Stellar", status: "Payments", icon: Sparkles, name: "Stellar Payment Center", color: "#8B5CF6", enabled: STELLAR_WORKSPACE_ENABLED, beta: true },
};

const LANE_OPTIONS: readonly {
  readonly label: "Production" | "Testnet";
  readonly options: readonly LaneOption[];
}[] = [
  {
    label: "Production",
    options: (["base", "arbitrum"] as const).map((workspace) => ({
      id: workspace,
      workspace,
      presentation: NETWORK_PRESENTATION[workspace],
    })),
  },
  {
    label: "Testnet",
    options: [
      { id: "stellar", workspace: "stellar", presentation: NETWORK_PRESENTATION.stellar },
      { id: "arc", workspace: "arc", presentation: NETWORK_PRESENTATION.arc },
    ],
  },
] as const;

export const NetworkSwitcher: React.FC<NetworkSwitcherProps> = ({
  networkMode,
  onSelect,
  isSwitching = false,
  error,
  showStatusBadge = true,
  className = "",
  compact = false,
}) => {
  const currentNetwork = NETWORK_PRESENTATION[networkMode];
  if (compact) {
    const workspaces = ["base", "arbitrum", "stellar", "arc"] as const;
    return (
      <div className={`flex min-w-0 flex-col gap-1.5 ${className}`} title={error ?? currentNetwork.name}>
        <div
          role="group"
          aria-label="Select network workspace"
          aria-busy={isSwitching}
          className="grid grid-cols-4 gap-1 border-[3px] border-[#1A1A1A] bg-[#F5F5F0] p-1 shadow-[3px_3px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#0F172A] dark:shadow-[3px_3px_0_#475569]"
        >
          {workspaces.map((workspace) => {
            const definition = NETWORK_PRESENTATION[workspace];
            const active = workspace === networkMode;
            return (
              <button
                key={workspace}
                type="button"
                disabled={isSwitching || !definition.enabled}
                aria-pressed={active}
                aria-label={`${definition.name}${definition.beta ? ", public beta" : ""}`}
                onClick={() => void Promise.resolve(onSelect(workspace)).catch(() => {})}
                className={`min-h-11 min-w-0 border-[2px] border-[#1A1A1A] px-1 text-[10px] font-black uppercase text-[#1A1A1A] transition-[transform,box-shadow,background-color,color] duration-100 ease-out focus-visible:z-20 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-1 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#64748B] dark:text-white ${
                  active
                    ? "text-white shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#94A3B8]"
                    : "bg-white dark:bg-[#1A2841]"
                }`}
                style={{ backgroundColor: active ? definition.color : undefined, outlineColor: definition.color }}
              >
                {isSwitching && active ? (
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  definition.label
                )}
              </button>
            );
          })}
        </div>
        {error ? (
          <span className="border-[2px] border-[#1A1A1A] bg-[#EF4444] px-2 py-1 text-[10px] font-black uppercase tracking-wider text-white" role="alert">
            Switch failed — retry
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5 ${className}`}
      title={error ?? currentNetwork.name}
    >
      <div
        role="group"
        aria-label="Select workspace and settlement lane"
        aria-busy={isSwitching}
        className="relative w-full overflow-hidden border-[3px] border-[#1A1A1A] bg-[#F5F5F0] p-1 shadow-[4px_4px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#0F172A] dark:shadow-[4px_4px_0_#475569]"
        title={currentNetwork.name}
      >
        <div
          className={`relative z-10 grid gap-1.5 ${
            compact ? "grid-cols-2" : "grid-cols-1 min-[480px]:grid-cols-2"
          }`}
        >
          {LANE_OPTIONS.map((lane) => (
            <section key={lane.label} className="min-w-0 border-[2px] border-[#1A1A1A] bg-[#E7E5E4] p-1 dark:border-[#64748B] dark:bg-[#111C2F]">
              <p className="mb-1 truncate px-1 text-[10px] font-black uppercase tracking-[0.12em] text-gray-600 dark:text-slate-300">
                {lane.label}
              </p>
              <div className="grid grid-cols-2 gap-1">
          {lane.options.map((option) => {
            const definition = option.presentation;
            const active = option.workspace === networkMode;
            const presentation = option.presentation;
            const Icon = presentation.icon;
            return (
              <button
                key={option.id}
                type="button"
                disabled={isSwitching || !definition.enabled}
                aria-pressed={active}
                aria-current={active ? "true" : undefined}
                aria-label={`${definition.name}${definition.beta ? ", public beta" : ""}`}
                onClick={() => void Promise.resolve(onSelect(option.workspace)).catch(() => {})}
                className={`group relative flex min-h-[48px] min-w-0 items-center justify-center gap-1 overflow-hidden border-[2px] border-[#1A1A1A] px-1 py-1.5 text-[#1A1A1A] transition-[transform,box-shadow,background-color,color] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[2px_2px_0_#1A1A1A] focus-visible:z-20 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-1 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#64748B] dark:text-white dark:hover:shadow-[2px_2px_0_#475569] ${
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
                  {showStatusBadge && !compact ? (
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
            </section>
          ))}
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
