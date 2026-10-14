/**
 * The desk's tools (console design 3.10) and where every legacy console
 * feature lives once the desk replaces the old console (6.1). Every network's
 * extras share one card language: platform number, name, network bullets, one
 * line, a kind (panel, form, read only, prompt, link) and the wallet it needs.
 *
 * Panels and forms load lazily (`load`), so each tool is its own chunk and the
 * desk's first paint carries none of them. Sentences a tool produces go to the
 * composer with the tool's engine pin; nothing is sent from here.
 *
 * Pure data (node --test loads it): `load` only names a dynamic import and is
 * never called here. ToolPanel hosts each component and adapts its props from
 * the fields below (`promptProp`, `host`, `networkProp`).
 */
import type { NetworkKey, ProtocolId } from "@kletia/core";

import { ACTIVE_WALLET_ADDRESS } from "../../../shared/config/intentExamples.ts";
import type { LegacyNetwork } from "../state/deskModel.ts";
import { ARC_FAUCET_URL } from "./funding.ts";

export type ToolKind = "panel" | "form" | "read-only" | "prompt" | "link";
export type ToolCategory = "pay" | "earn" | "swap" | "send" | "names" | "security" | "data" | "funding" | "contracts" | "agents";
/** Callback props of the moved console components that receive a sentence. */
export type ToolPromptProp = "onIntentTemplate" | "onActionClick" | "onWidgetClick";
/** The wallet a tool needs before it can act. */
export type ToolNeeds = "evm" | "solana" | "none";

/** One starter sentence of a prompt tool; `{{ACTIVE_WALLET_ADDRESS}}` is materialized when inserted. */
export interface ToolPrompt {
  readonly id: string;
  readonly label: string;
  readonly sentence: string;
}

export interface DeskTool {
  readonly id: string;
  /** Platform number on the tool's sign ("01"). */
  readonly number: number;
  readonly title: string;
  /** Network bullets; empty for a tool that serves every network. */
  readonly networks: readonly NetworkKey[];
  readonly category: ToolCategory;
  readonly kind: ToolKind;
  /** Network engine its sentences are pinned to; null when it never writes a sentence for an engine. */
  readonly engine: LegacyNetwork | null;
  readonly needs: ToolNeeds;
  readonly summary: string;
  /** Registry protocols this tool exposes. */
  readonly protocols: readonly ProtocolId[];
  /** Lazy component module (panels, forms, read-only panels and prompt panels). Never called here. */
  readonly load?: () => Promise<unknown>;
  /** Named export of the component in the loaded module. */
  readonly exportName?: string;
  /**
   * The component's callback that hands a sentence back: ToolPanel passes
   * `onPrompt(text, { engine })`, which fills the composer with this tool's
   * engine pinned (nothing is sent).
   */
  readonly promptProp?: ToolPromptProp;
  /** `solana`: hosted by SolanaToolHost, which passes the Solana owner and mainnet portfolio. */
  readonly host?: "solana";
  /** The component takes `network` and `chainId`: ToolPanel offers the tool's networks as a choice. */
  readonly networkProp?: boolean;
  /** Static starter sentences (prompt tools). */
  readonly prompts?: readonly ToolPrompt[];
  /** Destination of a link tool. */
  readonly href?: string;
  /** A link that runs a flow before opening (the Coinbase onramp needs a session token first). */
  readonly flow?: "coinbase-onramp";
  readonly external?: boolean;
}

/** Deep link of a tool (`/app/tools/<toolId>`, console design 3.13). */
export function toolPath(toolId: string): string {
  return `/app/tools/${encodeURIComponent(toolId)}`;
}

const BASE_ENGINE_PROMPTS: readonly ToolPrompt[] = [
  {
    id: "base-best-yield",
    label: "Compare live yield",
    sentence: "Compare best yield for USDC among Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
  },
  {
    id: "base-lowest-borrow",
    label: "Compare borrow cost",
    sentence: "Compare USDC borrow rates and available liquidity across Aave, Moonwell, and Compound on Base Mainnet without preparing a transaction",
  },
  {
    id: "base-smart-swap",
    label: "Scan swap routes",
    sentence: "Buy AERO with 10 USDC on Base Mainnet using the most efficient verified route and show the expected output before execution",
  },
  {
    id: "base-stake-well",
    label: "Stake WELL",
    sentence: "Stake 100 WELL in the Moonwell Safety Module on Base Mainnet and show the expected stkWELL output and risks before execution",
  },
  {
    id: "base-arbitrum-workflow",
    label: "Cross-chain workflow",
    sentence:
      "Bridge 10 USDC from Base to Arbitrum with Across, then supply only the received USDC to Aave V3; show every checkpoint and require a separate wallet approval for each financial step",
  },
];

const ARC_ENGINE_PROMPTS: readonly ToolPrompt[] = [
  { id: "arc-swap", label: "Swap", sentence: "Swap 1 native USDC to KLET on Arc Testnet using the live on-chain Kletia route; simulate it before wallet approval" },
  { id: "arc-vault", label: "Vault", sentence: "Deposit 1 native USDC into the Kletia Vault on Arc Testnet; prepare the time-locked vault route and simulate it before wallet approval" },
  { id: "arc-staking", label: "Staking", sentence: "Stake 1 native USDC in Kletia Staking on Arc Testnet; prepare the route and simulate it before wallet approval" },
  {
    id: "arc-batch",
    label: "Batch pay",
    sentence: `Atomically pay 0.1 native USDC to ${ACTIVE_WALLET_ADDRESS} on Arc Testnet through the official Multicall3From route; fail the whole batch if any payment fails and simulate it before wallet approval`,
  },
  {
    id: "arc-memo",
    label: "Memo transfer",
    sentence: `Send 0.1 native USDC to ${ACTIVE_WALLET_ADDRESS} through Kletia Memo Pay on Arc Testnet with the permanent public on-chain memo "KLETIA-DEMO-001"; simulate it before wallet approval`,
  },
  {
    id: "arc-liquidity",
    label: "Liquidity pool",
    sentence: "Add 1 native USDC liquidity to the KLET/USDC pool on Arc Testnet and spend at most 10 KLET; calculate and show the live requirement and enforce that hard cap before wallet approval",
  },
];

const ARBITRUM_ENGINE_PROMPTS: readonly ToolPrompt[] = [
  { id: "arbitrum-swap", label: "Uniswap V3 swap", sentence: "Swap 10 USDC to WETH on Arbitrum One through the best live Uniswap V3 fee tier and show the exact quote before approval" },
  { id: "arbitrum-lend", label: "Aave V3 supply", sentence: "Supply 10 USDC to Aave V3 on Arbitrum One after checking the live reserve and rate" },
  { id: "arbitrum-yield", label: "Live Aave rates", sentence: "Show the live USDC supply and variable borrow rates from Aave V3 on Arbitrum without preparing a transaction" },
];

export const TOOLS: readonly DeskTool[] = Object.freeze([
  {
    id: "x402",
    number: 1,
    title: "x402 services",
    networks: ["base"],
    category: "pay",
    kind: "panel",
    engine: "base",
    needs: "evm",
    summary: "Find paid APIs and pay per call in Base USDC.",
    protocols: ["x402"],
    load: () => import("../../../networks/base/components/x402/X402ServiceRouter"),
    exportName: "X402ServiceRouter",
    promptProp: "onIntentTemplate",
  },
  {
    id: "basenames",
    number: 2,
    title: "Basenames",
    networks: ["base"],
    category: "names",
    kind: "prompt",
    engine: "base",
    needs: "evm",
    summary: "Claim or renew a .base.eth name through the Base engine.",
    protocols: ["basenames"],
    load: () => import("../../../networks/base/components/BasenameClaimer"),
    exportName: "BasenameClaimer",
    promptProp: "onActionClick",
  },
  {
    id: "address-risk",
    number: 3,
    title: "Address risk check",
    networks: ["base", "arbitrum"],
    category: "security",
    kind: "read-only",
    engine: null,
    needs: "none",
    summary: "Webacy scan of any address before you pay it.",
    protocols: ["webacy"],
    load: () => import("../../../integrations/webacy/components/WebacyScanner"),
    exportName: "WebacyScanner",
    networkProp: true,
  },
  {
    id: "jupiter-swap",
    number: 4,
    title: "Jupiter swap",
    networks: ["solana"],
    category: "swap",
    kind: "form",
    engine: null,
    needs: "solana",
    summary: "Swap Solana tokens through Jupiter with a quote and a minimum output.",
    protocols: ["jupiter"],
    load: () => import("../../../networks/solana/components/SolanaSwap"),
    exportName: "SolanaSwap",
    host: "solana",
  },
  {
    id: "solana-send",
    number: 5,
    title: "Send SOL or tokens",
    networks: ["solana", "solana-devnet"],
    category: "send",
    kind: "form",
    engine: null,
    needs: "solana",
    summary: "Send SOL or an SPL token to a Solana wallet.",
    protocols: ["system-transfer", "spl-token"],
    load: () => import("../../../networks/solana/components/SolanaSend"),
    exportName: "SolanaSend",
    host: "solana",
  },
  {
    id: "liquid-staking",
    number: 6,
    title: "Liquid staking",
    networks: ["solana"],
    category: "earn",
    kind: "form",
    engine: null,
    needs: "solana",
    summary: "Stake SOL into JitoSOL, mSOL or JupSOL.",
    protocols: ["jito", "marinade", "sanctum"],
    load: () => import("../../../networks/solana/components/SolanaStake"),
    exportName: "SolanaStake",
    host: "solana",
  },
  {
    id: "solana-lending-rates",
    number: 7,
    title: "Solana lending rates",
    networks: ["solana"],
    category: "earn",
    kind: "read-only",
    engine: null,
    needs: "none",
    summary: "Supply rates and size of Jupiter Lend and Kamino.",
    protocols: ["jupiter-lend", "kamino"],
    load: () => import("../../../networks/solana/components/SolanaYields"),
    exportName: "SolanaYields",
    host: "solana",
  },
  {
    id: "arc-contracts",
    number: 8,
    title: "Kletia contracts on Arc",
    networks: ["arc"],
    category: "contracts",
    kind: "panel",
    engine: "arc",
    needs: "evm",
    summary: "Swap, vault, staking, batch pay, memo and liquidity on Kletia's Arc contracts.",
    protocols: ["arc-native"],
    load: () => import("../../../networks/arc/components/ArcDashboardWidget"),
    exportName: "ArcDashboardWidget",
    promptProp: "onWidgetClick",
  },
  {
    id: "arc-lending",
    number: 9,
    title: "Arc lending",
    networks: ["arc"],
    category: "earn",
    kind: "panel",
    engine: "arc",
    needs: "evm",
    summary: "Lend and borrow on Kletia's Arc lending market.",
    protocols: ["arc-native"],
    load: () => import("../../../networks/arc/components/ArcLendingDashboard"),
    exportName: "ArcLendingDashboard",
    promptProp: "onActionClick",
  },
  {
    id: "allora",
    number: 10,
    title: "Allora predictions",
    networks: ["base"],
    category: "data",
    kind: "read-only",
    engine: "base",
    needs: "none",
    summary: "Allora price inference as advisory market context.",
    protocols: ["allora"],
    load: () => import("../../../integrations/allora/components/AlloraDashboard"),
    exportName: "AlloraDashboard",
    promptProp: "onActionClick",
  },
  {
    id: "airdrop-check",
    number: 11,
    title: "Airdrop check",
    networks: ["base"],
    category: "data",
    kind: "read-only",
    engine: null,
    needs: "none",
    summary: "Estimate what an address has done on Base before a claim.",
    protocols: [],
    load: () => import("../../../networks/base/components/AirdropSimulator"),
    exportName: "AirdropSimulator",
  },
  {
    id: "arc-faucet",
    number: 12,
    title: "Arc USDC faucet",
    networks: ["arc"],
    category: "funding",
    kind: "link",
    engine: null,
    needs: "none",
    summary: "Get test USDC for Arc Testnet from Circle's faucet.",
    protocols: [],
    href: ARC_FAUCET_URL,
    external: true,
  },
  {
    id: "coinbase-onramp",
    number: 13,
    title: "Buy USDC with Coinbase",
    networks: ["base"],
    category: "funding",
    kind: "link",
    engine: null,
    needs: "evm",
    summary: "Fund your Base wallet with USDC through Coinbase.",
    protocols: [],
    href: "https://pay.coinbase.com",
    flow: "coinbase-onramp",
    external: true,
  },
  {
    id: "agents",
    number: 14,
    title: "Agents: MCP and x402",
    networks: [],
    category: "agents",
    kind: "link",
    engine: null,
    needs: "none",
    summary: "Give an agent Kletia's planner over MCP, and pay per call with x402.",
    protocols: ["x402"],
    href: "/developers/agents",
    external: false,
  },
  {
    id: "base-engine-starters",
    number: 15,
    title: "Starter sentences: Base engine",
    networks: ["base"],
    category: "earn",
    kind: "prompt",
    engine: "base",
    needs: "evm",
    summary: "Yield and borrow comparisons, verified swap routes on Kletia's Intent Router V2, Moonwell staking and an Across workflow.",
    protocols: ["kletia-router-v2", "moonwell", "aave-v3", "compound-v3", "across"],
    prompts: BASE_ENGINE_PROMPTS,
  },
  {
    id: "arc-engine-starters",
    number: 16,
    title: "Starter sentences: Arc engine",
    networks: ["arc"],
    category: "contracts",
    kind: "prompt",
    engine: "arc",
    needs: "evm",
    summary: "Swaps, vault, staking, batch pay, memo and liquidity on Kletia's Arc contracts.",
    protocols: ["arc-native"],
    prompts: ARC_ENGINE_PROMPTS,
  },
  {
    id: "arbitrum-engine-starters",
    number: 17,
    title: "Starter sentences: Arbitrum engine",
    networks: ["arbitrum"],
    category: "earn",
    kind: "prompt",
    engine: "arbitrum",
    needs: "evm",
    summary: "Uniswap V3 swaps, Aave V3 supply and live Aave rates on Arbitrum One.",
    protocols: ["uniswap-v3", "aave-v3"],
    prompts: ARBITRUM_ENGINE_PROMPTS,
  },
] satisfies DeskTool[]);

export function getTool(id: string): DeskTool | null {
  return TOOLS.find((tool) => tool.id === id) ?? null;
}

/** Where a legacy console feature lives in the desk (console design 6.1). */
export type FeatureHome =
  | { readonly kind: "tool"; readonly toolId: string }
  | { readonly kind: "desk"; readonly surface: "composer" | "departure" | "wallets" | "tasks" | "holdings" | "activity" | "header" }
  | { readonly kind: "engine-task"; readonly network: LegacyNetwork | "any" }
  | { readonly kind: "studio" }
  | { readonly kind: "removed"; readonly reason: string };

export interface LegacyFeature {
  readonly id: string;
  readonly title: string;
  /** Where it was in the old console. */
  readonly was: string;
  readonly homes: readonly FeatureHome[];
}

/** Every feature of the old console (`App.tsx`, the sidebar, the Solana workspace) and its new home. */
export const LEGACY_FEATURES: readonly LegacyFeature[] = Object.freeze([
  { id: "evm-chat", title: "EVM chat for Base, Arc and Arbitrum", was: "App.tsx chat", homes: [{ kind: "desk", surface: "composer" }, { kind: "engine-task", network: "any" }] },
  { id: "network-switcher", title: "Network switcher (four workspaces)", was: "NetworkSwitcher.tsx", homes: [{ kind: "desk", surface: "departure" }, { kind: "desk", surface: "wallets" }] },
  { id: "base-intent-prompts", title: "Base Intent DeFi prompts", was: "networks.ts navigation", homes: [{ kind: "tool", toolId: "base-engine-starters" }] },
  { id: "webacy", title: "Webacy Security (Base, Arbitrum)", was: "sidebar tab", homes: [{ kind: "tool", toolId: "address-risk" }] },
  { id: "allora", title: "Allora AI Hub and the drawer's Allora widget", was: "sidebar tab, portfolio drawer", homes: [{ kind: "tool", toolId: "allora" }] },
  { id: "basename-claim", title: "Basename claim", was: "sidebar tab", homes: [{ kind: "tool", toolId: "basenames" }] },
  { id: "airdrop-simulator", title: "Airdrop simulator", was: "sidebar tab", homes: [{ kind: "tool", toolId: "airdrop-check" }] },
  { id: "x402-console", title: "x402 console (buyer router, seller studio)", was: "sidebar tab", homes: [{ kind: "tool", toolId: "x402" }] },
  { id: "agents-handoff", title: "Base MCP and agents hand-off", was: "engine card, header link", homes: [{ kind: "engine-task", network: "base" }, { kind: "tool", toolId: "agents" }] },
  { id: "fund-wallet", title: "Fund wallet (Coinbase onramp)", was: "header button", homes: [{ kind: "tool", toolId: "coinbase-onramp" }, { kind: "desk", surface: "holdings" }] },
  { id: "paymaster", title: "Paymaster sponsorship", was: "executor flag", homes: [{ kind: "engine-task", network: "base" }] },
  { id: "arc-dashboard", title: "Arc dashboard (Kletia swap, vault, staking, batch pay, memo, liquidity)", was: "sidebar tab", homes: [{ kind: "tool", toolId: "arc-contracts" }] },
  { id: "arc-lending", title: "Arc lending and borrow", was: "sidebar tab", homes: [{ kind: "tool", toolId: "arc-lending" }] },
  { id: "arc-contract-prompts", title: "Arc contract prompts", was: "sidebar", homes: [{ kind: "tool", toolId: "arc-engine-starters" }] },
  { id: "arc-faucet", title: "Arc USDC faucet", was: "header button", homes: [{ kind: "tool", toolId: "arc-faucet" }, { kind: "desk", surface: "holdings" }] },
  { id: "circle-app-kit", title: "Circle App Kit route card", was: "engine card", homes: [{ kind: "engine-task", network: "arc" }] },
  { id: "arbitrum-prompts", title: "Arbitrum prompts (Uniswap V3, Aave V3, live rates)", was: "sidebar", homes: [{ kind: "tool", toolId: "arbitrum-engine-starters" }] },
  { id: "arbitrum-gas-step", title: "Arbitrum \"Prepare capped gas step\"", was: "engine card", homes: [{ kind: "engine-task", network: "arbitrum" }] },
  { id: "portfolio-drawer", title: "Portfolio drawer (Base, Arc and Arbitrum viewers, live balances, rescan)", was: "Sidebar.tsx", homes: [{ kind: "desk", surface: "holdings" }, { kind: "engine-task", network: "any" }] },
  { id: "activity-drawer", title: "Activity drawer", was: "ActivityDrawer.tsx", homes: [{ kind: "desk", surface: "activity" }] },
  { id: "clear-history", title: "Clear history", was: "sidebar", homes: [{ kind: "desk", surface: "tasks" }, { kind: "desk", surface: "activity" }] },
  { id: "theme-toggle", title: "Theme toggle", was: "sidebar", homes: [{ kind: "desk", surface: "header" }] },
  { id: "cross-network-handoff", title: "Cross-network hand-off card and \"Plan here\"", was: "chat", homes: [{ kind: "removed", reason: "The platform plans every sentence first, on all nine networks." }] },
  { id: "solana-overview", title: "Solana overview", was: "Solana workspace tab", homes: [{ kind: "desk", surface: "holdings" }] },
  { id: "solana-ask", title: "Solana Ask", was: "Solana workspace tab", homes: [{ kind: "desk", surface: "composer" }] },
  { id: "solana-swap", title: "Solana swap", was: "Solana workspace tab", homes: [{ kind: "tool", toolId: "jupiter-swap" }] },
  { id: "solana-send", title: "Solana send", was: "Solana workspace tab", homes: [{ kind: "tool", toolId: "solana-send" }] },
  { id: "solana-stake", title: "Solana stake", was: "Solana workspace tab", homes: [{ kind: "tool", toolId: "liquid-staking" }] },
  { id: "solana-yields", title: "Solana yields", was: "Solana workspace tab", homes: [{ kind: "tool", toolId: "solana-lending-rates" }] },
  { id: "solana-activity", title: "Solana activity", was: "Solana workspace tab", homes: [{ kind: "desk", surface: "activity" }] },
  { id: "wallet-dock", title: "Wallet dock with \"Wrong network\"", was: "header", homes: [{ kind: "desk", surface: "wallets" }] },
  { id: "workflow-resume", title: "Legacy cross-chain workflow resume", was: "App.tsx effect", homes: [{ kind: "engine-task", network: "any" }] },
  { id: "ai-consent", title: "AI-consent decision and session pill", was: "chat", homes: [{ kind: "engine-task", network: "any" }] },
  { id: "token-clarification", title: "Token clarification", was: "chat", homes: [{ kind: "engine-task", network: "any" }, { kind: "desk", surface: "composer" }] },
  { id: "privacy-evidence", title: "Privacy trace and entity evidence cards", was: "chat", homes: [{ kind: "engine-task", network: "any" }] },
  { id: "studio-execution", title: "Studio wallet execution", was: "StudioExecutionPanel.tsx", homes: [{ kind: "desk", surface: "tasks" }] },
  { id: "studio-dry-run", title: "Studio dry run, ticket, graph, JSON and share link", was: "Studio", homes: [{ kind: "studio" }] },
] satisfies LegacyFeature[]);

/**
 * Protocols only the network engines execute (`execution: "console"` in the
 * registry, protocols design 4.1) and the desk paths that reach them. The Base
 * engine's starter tool is the only path to Kletia Intent Router V2: a swap
 * typed in the desk goes to the platform route.
 */
export const CONSOLE_PROTOCOL_HOMES: Readonly<Partial<Record<ProtocolId, { readonly toolIds: readonly string[]; readonly engine: LegacyNetwork }>>> = Object.freeze({
  "kletia-router-v2": { toolIds: ["base-engine-starters"], engine: "base" },
  basenames: { toolIds: ["basenames"], engine: "base" },
  "arc-native": { toolIds: ["arc-contracts", "arc-lending", "arc-engine-starters"], engine: "arc" },
  "circle-app-kit": { toolIds: [], engine: "arc" },
});
