import { Activity, Bot, Gavel, Globe2, Landmark, Route, type LucideIcon } from "lucide-react";

import { PREVIEW_ACCOUNTS } from "../../../../shared/platform/previewAccounts";
import { CURATED_BODIES } from "./operations";

export interface QuickStartPreset {
  readonly id: string;
  readonly operationId: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly accent: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** The curated "first five minutes" set shown above the full explorer. */
export const QUICK_START: readonly QuickStartPreset[] = [
  {
    id: "health",
    operationId: "getHealth",
    title: "Is the API up?",
    description: "Per-network RPC health and storage mode.",
    icon: Activity,
    accent: "#14F195",
  },
  {
    id: "networks",
    operationId: "listNetworks",
    title: "What runs where?",
    description: "Actions and protocols Kletia executes on each network.",
    icon: Globe2,
    accent: "#0052FF",
  },
  {
    id: "auction",
    operationId: "quoteRoutes",
    title: "Run a bridge auction",
    description: "Relay, LI.FI and deBridge quote 25 USDC from Base to Arbitrum.",
    icon: Gavel,
    accent: "#FFD60A",
    body: CURATED_BODIES.quoteRoutes?.[0]?.value,
  },
  {
    id: "plan",
    operationId: "createIntent",
    title: "Plan a dry run",
    description: "Natural language to a step graph. Nothing stored, nothing signed.",
    icon: Route,
    accent: "#9945FF",
    values: { dryRun: "true" },
    body: {
      text: "bridge 50 USDC from base to solana then swap half to JitoSOL",
      accounts: [PREVIEW_ACCOUNTS.evm, PREVIEW_ACCOUNTS.solana],
    },
  },
  {
    id: "venues",
    operationId: "listVenues",
    title: "Compare lending venues",
    description: "Supply APY, size and exit liquidity on Base.",
    icon: Landmark,
    accent: "#FF5A5F",
    values: { network: "base", protocol: "" },
  },
  {
    id: "mcp",
    operationId: "mcp",
    title: "Ask the MCP server",
    description: "List the read-only tools agents get at /v1/mcp.",
    icon: Bot,
    accent: "#0052FF",
    body: CURATED_BODIES.mcp?.[0]?.value,
  },
];
