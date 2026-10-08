import React from "react";
import { Box, CircleDot, Loader2, Orbit, Sparkles, type LucideIcon } from "lucide-react";
import { getNetwork, type ConsoleWorkspace } from "../../config/networks";

/**
 * A selectable console workspace: one of the wallet-switchable EVM networks
 * or the Solana workspace. Selecting Solana never asks the EVM wallet to
 * switch chains.
 */
export type WorkspaceMode = ConsoleWorkspace;

type WorkspacePresentation = {
  readonly label: string;
  readonly compactLabel: string;
  readonly status: string;
  readonly icon: LucideIcon;
  readonly name: string;
  readonly color: string;
  /** Optional CSS background for the active state (Solana gradient). */
  readonly activeBackground?: string;
  readonly activeText?: string;
  readonly enabled: boolean;
  readonly beta?: boolean;
};

type LaneOption = {
  readonly id: string;
  readonly workspace: WorkspaceMode;
  readonly presentation: WorkspacePresentation;
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

const NETWORK_PRESENTATION: Record<WorkspaceMode, WorkspacePresentation> = {
  base: { label: "Base", compactLabel: "Base", status: "Mainnet", icon: Box, name: "Base Mainnet", color: "#0052FF", enabled: true },
  arbitrum: { label: "Arb", compactLabel: "Arb", status: "Mainnet", icon: Orbit, name: "Arbitrum One", color: "#28A0F0", enabled: getNetwork("arbitrum").enabled, beta: true },
  solana: {
    label: "Solana",
    compactLabel: "SOL",
    status: "Mainnet",
    icon: Sparkles,
    name: "Solana Mainnet",
    color: "#9945FF",
    activeBackground: "linear-gradient(135deg, #9945FF 0%, #7C3AED 55%, #14F195 140%)",
    activeText: "#FFFFFF",
    enabled: true,
  },
  arc: { label: "Arc", compactLabel: "Arc", status: "Testnet", icon: CircleDot, name: "Arc Testnet", color: "#F59E0B", enabled: true },
};

const COMPACT_ORDER = ["base", "arbitrum", "solana", "arc"] as const satisfies readonly WorkspaceMode[];

const LANE_OPTIONS: readonly {
  readonly label: "Production" | "Testnet";
  readonly options: readonly LaneOption[];
}[] = [
  {
    label: "Production",
    options: (["base", "arbitrum", "solana"] as const).map((workspace) => ({
      id: workspace,
      workspace,
      presentation: NETWORK_PRESENTATION[workspace],
    })),
  },
  {
    label: "Testnet",
    options: [
      { id: "arc", workspace: "arc", presentation: NETWORK_PRESENTATION.arc },
    ],
  },
] as const;

function activeStyle(definition: WorkspacePresentation, active: boolean): React.CSSProperties {
  return {
    outlineColor: definition.color,
    ...(active
      ? definition.activeBackground
        ? { backgroundImage: definition.activeBackground, backgroundColor: definition.color, color: definition.activeText }
        : { backgroundColor: definition.color }
      : {}),
  };
}

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
    const workspaces = COMPACT_ORDER;
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
                style={activeStyle(definition, active)}
              >
                {isSwitching && active ? (
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  definition.compactLabel
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
        <div className="relative z-10 grid grid-cols-1 gap-1.5">
          {LANE_OPTIONS.map((lane) => (
            <section key={lane.label} className="min-w-0 border-[2px] border-[#1A1A1A] bg-[#E7E5E4] p-1 dark:border-[#64748B] dark:bg-[#111C2F]">
              <p className="mb-1 truncate px-1 text-[10px] font-black uppercase tracking-[0.12em] text-gray-600 dark:text-slate-300">
                {lane.label}
              </p>
              <div
                className={`grid gap-1 ${
                  lane.options.length > 2
                    ? "grid-cols-3"
                    : lane.options.length > 1
                      ? "grid-cols-2"
                      : "grid-cols-1"
                }`}
              >
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
                style={activeStyle(definition, active)}
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
