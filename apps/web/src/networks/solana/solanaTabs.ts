/**
 * Internal navigation of the Solana workspace. Kept dependency-free so the
 * console sidebar can render it without loading the workspace chunk.
 */
export type SolanaTab = "overview" | "swap" | "send" | "stake" | "yields" | "activity";

export interface SolanaTabDefinition {
  readonly id: SolanaTab;
  readonly label: string;
  readonly description: string;
}

export const SOLANA_TABS: readonly SolanaTabDefinition[] = [
  { id: "overview", label: "Overview", description: "Portfolio and balances" },
  { id: "swap", label: "Swap", description: "Best route through Jupiter" },
  { id: "send", label: "Send", description: "SOL and SPL transfers" },
  { id: "stake", label: "Stake", description: "Liquid staking tokens" },
  { id: "yields", label: "Yields", description: "Kamino lending rates" },
  { id: "activity", label: "Activity", description: "Solana transactions" },
];

export function isSolanaTab(value: unknown): value is SolanaTab {
  return SOLANA_TABS.some((tab) => tab.id === value);
}

/** Workspace branding shared by the switcher, navbar and sidebar. */
export const SOLANA_BRAND = {
  primary: "#9945FF",
  accent: "#14F195",
  gradient: "linear-gradient(135deg, #9945FF 0%, #14F195 100%)",
} as const;
