/**
 * Arc dashboard widget catalogue and amount helpers.
 */
import { parseEther } from "viem";
import { NETWORKS } from "../../../../shared/config/networks";
import { WidgetId } from "../../../../shared/types";

export const ARC_CHAIN_ID = NETWORKS.arc.chainId;

export const WIDGETS: Array<{
  id: Exclude<WidgetId, null>;
  icon: string;
  name: string;
  desc: string;
  color: string;
}> = [
  {
    id: "swap" as const,
    icon: "🔄",
    name: "Swap",
    desc: "USDC / KLET Swap",
    color: "bg-[#3B82F6]",
  },
  {
    id: "vault" as const,
    icon: "🔒",
    name: "Vault",
    desc: "Time-Locked Vault",
    color: "bg-[#8B5CF6]",
  },
  {
    id: "lending" as const,
    icon: "🏦",
    name: "Lending",
    desc: "Lend & Borrow",
    color: "bg-[#EF4444]",
  },
  {
    id: "staking" as const,
    icon: "💎",
    name: "Staking",
    desc: "Stake Native USDC",
    color: "bg-[#06B6D4]",
  },
  {
    id: "liquidity" as const,
    icon: "💧",
    name: "Liquidity",
    desc: "Provide LP",
    color: "bg-[#10B981]",
  },
  {
    id: "batch" as const,
    icon: "📦",
    name: "Batch Pay",
    desc: "Batch Transfer",
    color: "bg-[#F59E0B]",
  },
  {
    id: "memo" as const,
    icon: "📝",
    name: "Memo",
    desc: "Memo Transfer",
    color: "bg-[#EC4899]",
  },
];

export function parsePositiveAmount(
  value: string,
  label: string,
  userDecimals = 6,
): string {
  const normalized = value.trim();
  if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Enter a valid amount for ${label}.`);
  }
  const fraction = normalized.split(".")[1] || "";
  if (fraction.length > userDecimals) {
    throw new Error(
      `${label} user input can have up to ${userDecimals} decimal places.`,
    );
  }
  const parsed = parseEther(normalized);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero.`);
  return normalized;
}

/** LP token units (18 decimals) of an amount typed in the LP exit field; null when empty or malformed. */
export function lpTokenUnits(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(trimmed)) return null;
  try {
    return parseEther(trimmed);
  } catch {
    return null;
  }
}
