/**
 * Scenarios for the home hero's "intent compiler" window. Every prompt is a
 * real example from the API grammar (`GRAMMAR_EXAMPLES`), and each compiles
 * with `compileIntentText` to the steps shown here. The window is a labelled
 * DRY RUN · EXAMPLE: nothing is planned or signed.
 *
 * Geometry is for an SVG with viewBox 0 0 480 260: a production lane on the
 * left and a testnet lane on the right behind a dashed divider. No route
 * ever crosses the divider (mainnet and testnet capital never share a graph).
 */
import { CHAINS } from "@kletia/core";

export type HeroNodeId = "base" | "arbitrum" | "solana" | "arc";
export type HeroAssetId = "jitosol" | "recipient";

export interface HeroBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const MAP_WIDTH = 480;
export const MAP_HEIGHT = 260;
/** x of the dashed divider between the production and testnet lanes. */
export const LANE_DIVIDER_X = 346;

export interface HeroNode {
  readonly id: HeroNodeId;
  readonly name: string;
  readonly sub: string;
  readonly color: string;
  readonly box: HeroBox;
}

export const HERO_NODES: readonly HeroNode[] = [
  { id: "base", name: "Base", sub: "EVM · 8453", color: CHAINS.base.color, box: { x: 14, y: 40, w: 108, h: 44 } },
  { id: "arbitrum", name: "Arbitrum", sub: "EVM · 42161", color: CHAINS.arbitrum.color, box: { x: 14, y: 190, w: 108, h: 44 } },
  { id: "solana", name: "Solana", sub: "SVM · mainnet", color: CHAINS.solana.color, box: { x: 214, y: 112, w: 108, h: 44 } },
  { id: "arc", name: "Arc Testnet", sub: "EVM · testnet", color: CHAINS.arc.color, box: { x: 362, y: 52, w: 106, h: 44 } },
];

export interface HeroAsset {
  readonly id: HeroAssetId;
  readonly label: string;
  readonly box: HeroBox;
}

export const HERO_ASSETS: readonly HeroAsset[] = [
  { id: "jitosol", label: "JitoSOL", box: { x: 226, y: 214, w: 84, h: 30 } },
  { id: "recipient", label: "0x…dEaD", box: { x: 366, y: 196, w: 98, h: 30 } },
];

/** Every edge the map can draw; idle edges show as faint guides. */
export interface HeroEdge {
  readonly id: string;
  readonly d: string;
  /** Where the protocol/action chip sits (centre). */
  readonly chip: { readonly x: number; readonly y: number };
}

export const HERO_EDGES: Readonly<Record<string, HeroEdge>> = {
  "base-solana": { id: "base-solana", d: "M122 62 H168 V134 H214", chip: { x: 168, y: 108 } },
  "arbitrum-solana": { id: "arbitrum-solana", d: "M122 212 H168 V134 H214", chip: { x: 168, y: 172 } },
  "solana-jitosol": { id: "solana-jitosol", d: "M268 156 V214", chip: { x: 268, y: 186 } },
  "arc-recipient": { id: "arc-recipient", d: "M415 96 V196", chip: { x: 415, y: 146 } },
};

export type StepStatus = "waiting" | "awaiting" | "submitted" | "settled";

export interface HeroHop {
  readonly edge: keyof typeof HERO_EDGES;
  readonly from: HeroNodeId;
  readonly to: HeroNodeId | HeroAssetId;
  /** Chip text: the protocol where the example implies it, otherwise the action. */
  readonly chip: string;
  /** Packet / glow colour. */
  readonly color: string;
}

export interface HeroStep {
  readonly title: string;
  readonly venue: string;
  readonly signer: string;
}

export interface HeroScenario {
  readonly id: string;
  /** Accessible name of the scenario button. */
  readonly label: string;
  readonly prompt: string;
  readonly tokens: readonly string[];
  readonly summary: string;
  readonly lane: "production" | "testnet";
  readonly hops: readonly HeroHop[];
  readonly steps: readonly HeroStep[];
  readonly signatures: string;
  /** Static description for screen readers. */
  readonly description: string;
}

export const HERO_SCENARIOS: readonly HeroScenario[] = [
  {
    id: "base-solana-jitosol",
    label: "Example 1: Base to Solana, then JitoSOL",
    prompt: "bridge 50 USDC from base to solana then swap half to JitoSOL",
    tokens: ["50 USDC", "base", "solana", "JitoSOL"],
    summary: "2 steps · 2 networks",
    lane: "production",
    hops: [
      { edge: "base-solana", from: "base", to: "solana", chip: "Relay · bridge", color: CHAINS.base.color },
      { edge: "solana-jitosol", from: "solana", to: "jitosol", chip: "Jupiter · swap", color: "#9945FF" },
    ],
    steps: [
      { title: "Bridge 50 USDC Base → Solana", venue: "Relay", signer: "EVM wallet" },
      { title: "Swap 25 USDC → JitoSOL", venue: "Jupiter", signer: "Solana wallet" },
    ],
    signatures: "2 wallet signatures · EVM, then Solana",
    description:
      "Bridge 50 USDC from Base to Solana through Relay, signed with an EVM wallet, then swap half of it to JitoSOL through Jupiter, signed with a Solana wallet.",
  },
  {
    id: "arbitrum-solana",
    label: "Example 2: Arbitrum to Solana",
    prompt: "move 0.01 ETH from arbitrum to solana as SOL",
    tokens: ["0.01 ETH", "arbitrum", "solana", "SOL"],
    summary: "1 step · 2 networks",
    lane: "production",
    hops: [{ edge: "arbitrum-solana", from: "arbitrum", to: "solana", chip: "Relay · bridge", color: CHAINS.arbitrum.color }],
    steps: [{ title: "Bridge 0.01 ETH Arbitrum → Solana as SOL", venue: "Relay", signer: "EVM wallet" }],
    signatures: "1 wallet signature · EVM",
    description: "Bridge 0.01 ETH from Arbitrum to Solana, arriving as SOL, in one step signed with an EVM wallet.",
  },
  {
    id: "arc-transfer",
    label: "Example 3: transfer on Arc Testnet",
    prompt: "send 5 USDC to 0x000000000000000000000000000000000000dEaD on arc",
    tokens: ["5 USDC", "0x…dEaD", "arc"],
    summary: "1 step · testnet lane",
    lane: "testnet",
    hops: [{ edge: "arc-recipient", from: "arc", to: "recipient", chip: "transfer", color: CHAINS.arc.color }],
    steps: [{ title: "Transfer 5 USDC to 0x…dEaD", venue: "Arc Testnet", signer: "EVM wallet" }],
    signatures: "1 wallet signature · testnet capital only",
    description:
      "Send 5 USDC to a burn address on Arc Testnet in one step signed with an EVM wallet. Testnet capital never shares a graph with mainnet.",
  },
];

/*
 * Timeline. Stage 0 types the prompt (it ends when typing does). Then:
 * compile, one stage per hop, three per step (awaiting signature, submitted,
 * settled), hold, exit.
 */
export const STAGE_MS = {
  compile: 700,
  hop: 650,
  awaiting: 700,
  submitted: 600,
  settled: 350,
  hold: 1800,
  exit: 300,
} as const;

/** First stage where every step is settled (the resting "final state"). */
export function settledStage(scenario: HeroScenario): number {
  return 2 + scenario.hops.length + scenario.steps.length * 3 - 1;
}

export function holdStage(scenario: HeroScenario): number {
  return settledStage(scenario) + 1;
}

export function exitStage(scenario: HeroScenario): number {
  return holdStage(scenario) + 1;
}

/** How long a stage lasts before advancing (stage 0 is driven by the typewriter). */
export function stageDuration(scenario: HeroScenario, stage: number): number | null {
  if (stage <= 0) return null;
  if (stage === 1) return STAGE_MS.compile;
  const hopEnd = 1 + scenario.hops.length;
  if (stage <= hopEnd) return STAGE_MS.hop;
  if (stage === holdStage(scenario)) return STAGE_MS.hold;
  if (stage === exitStage(scenario)) return STAGE_MS.exit;
  const within = (stage - hopEnd - 1) % 3;
  return within === 0 ? STAGE_MS.awaiting : within === 1 ? STAGE_MS.submitted : STAGE_MS.settled;
}

/** Number of hops drawn at a stage. */
export function hopsShown(scenario: HeroScenario, stage: number): number {
  return Math.max(0, Math.min(scenario.hops.length, stage - 1));
}

export function stepStatus(scenario: HeroScenario, stage: number, index: number): StepStatus {
  const base = 2 + scenario.hops.length + index * 3;
  if (stage < base) return "waiting";
  if (stage === base) return "awaiting";
  if (stage === base + 1) return "submitted";
  return "settled";
}
