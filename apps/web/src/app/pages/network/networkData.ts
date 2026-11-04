/**
 * THE NETWORK: Kletia's family of products as a transit system. Kletia is the
 * Interchange (the central station, its intent engine); the products built on
 * that engine are lines leaving it. Every fact here is presentation data with
 * its source noted, so the board, the map, the tickets and the line pages
 * never disagree.
 *
 * Lineage, stated honestly: Kletia's intent engine came first. Elyia ported its
 * engine concepts (intent graph, Rule Book, developer platform) to Elysium,
 * HyperEVM and HyperCore. Lykia was built on that lineage for Arc Network.
 *
 * Pure (only the @kletia/core registry) so `node --test` loads it directly.
 */
import { CHAINS } from "@kletia/core";

/** Kletia's production networks, from the registry the planner uses. */
const KLETIA_NETWORKS: readonly string[] = Object.values(CHAINS)
  .filter((chain) => chain.lane !== "testnet")
  .map((chain) => chain.name);

export type LineId = "kletia" | "elyia" | "lykia";

/** Where a product stands today. Words, never colour alone. */
export type LineStage = "live" | "mainnet" | "testnet";

export interface LineLink {
  readonly label: string;
  readonly href: string;
}

export interface FamilyLine {
  readonly id: LineId;
  /** Product name. */
  readonly name: string;
  /** Transit name of the line. */
  readonly line: string;
  /** Two or three letter bullet code. */
  readonly code: string;
  /** Bullet colour (the product's own accent) and the text colour on it (WCAG AA). */
  readonly color: string;
  readonly on: string;
  /** One sentence: what it does. */
  readonly summary: string;
  /** Networks it runs on, in its own order. */
  readonly networks: readonly string[];
  readonly stage: LineStage;
  /** Status words as printed: "Live", "Mainnet beta", "Testnet · in development". */
  readonly status: string;
  readonly mascot: { readonly name: string; readonly kind: string } | null;
  /** The policy layer's name in this product. */
  readonly policy: string;
  /** The ask-in-a-sentence surface. */
  readonly ask: string;
  /** Design language of the product (its ticket is printed in it). */
  readonly design: string;
  /** Detail page on this site; null for the Interchange (it is this site). */
  readonly page: string | null;
  readonly links: readonly LineLink[];
}

export const KLETIA_REPO = "https://github.com/furkan3152/Kletia";
export const LYKIA_APP = "https://lykia-akdogan1.vercel.app";
export const LYKIA_API = "https://lykia-api-akdogan1.vercel.app";
export const LYKIA_REPO = "https://github.com/furkan3152/Lykia";

/**
 * Elyia's repository is not public: checked 2026-11-04, the old name
 * github.com/furkan3152/Elyra redirects to /Elyia, which answers like a
 * private repository to anonymous requests. Elyia also has no public API
 * host yet. So its line shows "In development" and links nowhere; turn this
 * on (and add the link) once the repository is public.
 */
export const ELYIA_PUBLIC = false;

export const LINES: Readonly<Record<LineId, FamilyLine>> = Object.freeze({
  kletia: {
    id: "kletia",
    name: "Kletia",
    line: "The Interchange",
    code: "KLT",
    color: "#C6FF3A",
    on: "#121212",
    summary: "Intent infrastructure for EVM and Solana: one sentence becomes planned, quoted transactions your own wallet signs.",
    networks: KLETIA_NETWORKS,
    stage: "live",
    status: "Live",
    mascot: null,
    policy: "Rule Book",
    ask: "Intent graph",
    design: "Card machine",
    page: null,
    links: [
      { label: "Open the desk", href: "/app" },
      { label: "Developers", href: "/developers" },
      { label: "GitHub", href: KLETIA_REPO },
    ],
  },
  elyia: {
    id: "elyia",
    name: "Elyia",
    line: "Summit Line",
    code: "ELY",
    color: "#17788C",
    on: "#FFFFFF",
    summary: "The intent, trading and portfolio deck for Elysium, HyperEVM and HyperCore, with a Rule Book between you and your capital.",
    networks: ["HyperCore", "HyperEVM", "Elysium"],
    stage: "testnet",
    status: "Testnet · in development",
    mascot: { name: "Ely", kind: "the goat" },
    policy: "Rule Book",
    ask: "Ask Ely",
    design: "Pixel Survey",
    page: "/network/elyia",
    links: [],
  },
  lykia: {
    id: "lykia",
    name: "Lykia",
    line: "Coast Line",
    code: "LYK",
    color: "#B9472E",
    on: "#FFFFFF",
    summary: "Policy-bound agents and stablecoin routing on Arc Network: every step is checked against the Fence before a wallet or an agent signs.",
    networks: ["Arc mainnet"],
    stage: "mainnet",
    status: "Live on Arc mainnet",
    mascot: { name: "Lyko", kind: "the Anatolian shepherd dog" },
    policy: "Fence",
    ask: "Ask Lyko",
    design: "Mosaic",
    page: "/network/lykia",
    links: [
      { label: "Open Lykia", href: LYKIA_APP },
      { label: "API reference", href: `${LYKIA_API}/v1/reference` },
      { label: "GitHub", href: LYKIA_REPO },
    ],
  },
});

/** The two lines leaving the Interchange, in departure order. */
export const DEPARTURES: readonly FamilyLine[] = [LINES.elyia, LINES.lykia];

/** Elyia's altitude layers: each network is a band of the mountain. */
export const ELYIA_LAYERS: readonly { readonly band: string; readonly network: string; readonly color: string; readonly role: string }[] = [
  { band: "Summit", network: "Elysium", color: "#17788C", role: "Swaps, bridges and earn on Elysium" },
  { band: "Ridge", network: "HyperEVM", color: "#8A5A2B", role: "Contracts and tokens on HyperEVM" },
  { band: "Floor", network: "HyperCore", color: "#1E6B7D", role: "Perps and spot on HyperCore" },
];

/** Lykia's mainnet contracts on Arc (also reported by GET /v1/stats). */
export const LYKIA_CONTRACTS: readonly { readonly name: string; readonly address: string; readonly role: string }[] = [
  { name: "LykiaAccountFactory", address: "0x810e8db89f4c4e8fa814ed3ed0d636d3416dd7f9", role: "Creates one smart account per owner (CREATE2)" },
  { name: "LykiaRouter", address: "0xc9c0ea4d22ddbef4504a634759fb78334efc5d18", role: "Runs a checked route as one transaction with an Arc Memo" },
  { name: "LykiaOrders", address: "0xdcefebb3d449b7f8965c5f1ae3bba836f30ae6cc", role: "Holds standing orders until their conditions are met" },
];

/** "0x810e…d7f9". */
export function shortAddress(address: string): string {
  return /^0x[0-9a-fA-F]{40}$/u.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/* ---------------------------------------------------------------------------
 * Line map: the lineage as stations. Coordinates live in the component; here
 * are the stops and what each one means.
 * ------------------------------------------------------------------------ */

export interface MapStop {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly line: LineId;
  readonly terminus?: boolean;
  readonly interchange?: boolean;
}

export const MAP_STOPS: readonly MapStop[] = [
  { id: "engine", name: "Kletia intent engine", note: "Intent graph, planner, Rule Book, developer platform", line: "kletia", interchange: true },
  { id: "port", name: "Engine port", note: "Elyia ports the engine's concepts", line: "elyia", interchange: true },
  { id: "floor", name: "Floor · HyperCore", note: "Perps and spot", line: "elyia" },
  { id: "ridge", name: "Ridge · HyperEVM", note: "Contracts and tokens", line: "elyia" },
  { id: "summit", name: "Summit · Elysium", note: "Testnet first", line: "elyia", terminus: true },
  { id: "fence", name: "The Fence", note: "Lykia builds on the lineage for Arc", line: "lykia" },
  { id: "arc", name: "Arc mainnet", note: "Live", line: "lykia", terminus: true },
];

/** The lineage in reading order: who built on whom. */
export const LINEAGE: readonly { readonly from: LineId; readonly to: LineId; readonly verb: string }[] = [
  { from: "kletia", to: "elyia", verb: "Elyia ported Kletia's engine concepts" },
  { from: "elyia", to: "lykia", verb: "Lykia built on that lineage for Arc" },
];

/* ---------------------------------------------------------------------------
 * Transfer stations: one concept, three names. Change here for all three lines.
 * ------------------------------------------------------------------------ */

export interface TransferStation {
  readonly id: string;
  readonly concept: string;
  readonly kletia: string;
  readonly elyia: string;
  readonly lykia: string;
  readonly note: string;
}

export const TRANSFERS: readonly TransferStation[] = [
  {
    id: "ask",
    concept: "Say it in one sentence",
    kletia: "Intent graph",
    elyia: "Ask Ely",
    lykia: "Ask Lyko",
    note: "A plain goal becomes a graph of steps you can read before anything is signed.",
  },
  {
    id: "policy",
    concept: "Rules before signing",
    kletia: "Rule Book",
    elyia: "Rule Book",
    lykia: "The Fence",
    note: "Caps, allowed assets and recipients, approvals. Checked before a step reaches a wallet.",
  },
  {
    id: "platform",
    concept: "Build on it",
    kletia: "Developer portal",
    elyia: "Developers",
    lykia: "API, SDKs, the League",
    note: "Keys, projects, webhooks and MCP: the engine the app runs on, open to other teams.",
  },
  {
    id: "signing",
    concept: "Who signs",
    kletia: "Your wallet",
    elyia: "Your wallet",
    lykia: "Your wallet or a Tagged agent",
    note: "The server never signs. Lykia's agents carry an ERC-8004 Tag that pins their Fence.",
  },
];

/* ---------------------------------------------------------------------------
 * Lykia live figures: GET /v1/stats and GET /v1/health on its public API.
 * Parsed defensively: a field that is missing or of the wrong type becomes
 * null and prints as "—", never a made-up number.
 * ------------------------------------------------------------------------ */

export interface LykiaStats {
  readonly environment: string | null;
  readonly accountsCreated: number | null;
  readonly protocols: number | null;
  readonly verified: number | null;
  readonly routable: number | null;
  readonly intents: number | null;
  readonly contracts: number | null;
  readonly at: string | null;
}

export interface LykiaHealth {
  readonly status: "ok" | "degraded" | "down" | null;
  readonly version: string | null;
  readonly environment: string | null;
  readonly arcHead: number | null;
  readonly arcLatencyMs: number | null;
  readonly arcReachable: boolean | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
const text = (value: unknown, max = 40): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);

export function parseLykiaStats(body: unknown): LykiaStats | null {
  if (!isRecord(body)) return null;
  const onchain = isRecord(body.onchain) ? body.onchain : {};
  const ecosystem = isRecord(body.ecosystem) ? body.ecosystem : {};
  const routed = isRecord(body.routed) ? body.routed : {};
  return {
    environment: text(body.environment),
    accountsCreated: count(onchain.accountsCreated),
    protocols: count(ecosystem.protocols),
    verified: count(ecosystem.verified),
    routable: count(ecosystem.routable),
    intents: count(routed.intents),
    contracts: Array.isArray(onchain.contracts) ? onchain.contracts.length : null,
    at: text(body.at),
  };
}

export function parseLykiaHealth(body: unknown): LykiaHealth | null {
  if (!isRecord(body)) return null;
  const networks = isRecord(body.networks) ? body.networks : {};
  const arc = isRecord(networks["arc-mainnet"]) ? (networks["arc-mainnet"] as Record<string, unknown>) : {};
  const status = body.status === "ok" || body.status === "degraded" || body.status === "down" ? body.status : null;
  return {
    status,
    version: text(body.version, 16),
    environment: text(body.environment),
    arcHead: count(arc.head),
    arcLatencyMs: count(arc.latencyMs),
    arcReachable: typeof arc.reachable === "boolean" ? arc.reachable : null,
  };
}

export type LiveState = "loading" | "live" | "offline";

export interface LykiaLive {
  readonly state: LiveState;
  readonly stats: LykiaStats | null;
  readonly health: LykiaHealth | null;
  /** Epoch ms of the answer (or of the failed attempt). */
  readonly at: number | null;
}

/* ---------------------------------------------------------------------------
 * Departure board rows. Flap texts fit the board's tile widths.
 * ------------------------------------------------------------------------ */

export const FLAP_LINE_WIDTH = 11;
export const FLAP_INFO_WIDTH = 10;
export const FLAP_STATUS_WIDTH = 9;

export type BoardTone = "running" | "delayed" | "suspended" | "checking" | "unknown" | "building";

export interface FamilyBoardRow {
  readonly line: FamilyLine;
  /** Destination as printed on the tiles. */
  readonly flapLine: string;
  /** Live or fixed reading on the tiles ("40 MS", "TESTNET"). */
  readonly flapInfo: string;
  readonly flapStatus: string;
  readonly tone: BoardTone;
  /** The row read aloud (the tiles are hidden from assistive tech). */
  readonly spoken: string;
}

/** Thousands with thin grouping for tiles: 29555550 -> "29.55M", 940 -> "940". */
export function compactCount(value: number | null): string {
  if (value === null) return "—";
  if (value < 10_000) return String(value);
  if (value < 1_000_000) return `${(Math.floor(value / 100) / 10).toFixed(1)}K`;
  return `${(Math.floor(value / 10_000) / 100).toFixed(2)}M`;
}

export interface KletiaReading {
  readonly state: LiveState;
  /** Networks answering out of the total, when the health report is in. */
  readonly ok?: number;
  readonly total?: number;
}

export function familyBoard(kletia: KletiaReading, lykia: LykiaLive): readonly FamilyBoardRow[] {
  const kletiaRow: FamilyBoardRow = (() => {
    if (kletia.state === "live" && typeof kletia.ok === "number" && typeof kletia.total === "number") {
      const all = kletia.ok === kletia.total;
      return {
        line: LINES.kletia,
        flapLine: "INTERCHANGE",
        flapInfo: `${kletia.ok}/${kletia.total} NETS`,
        flapStatus: all ? "RUNNING" : "DELAYED",
        tone: all ? "running" : "delayed",
        spoken: `Kletia, the Interchange: ${kletia.ok} of ${kletia.total} networks answering, ${all ? "running" : "delayed"}.`,
      };
    }
    const checking = kletia.state === "loading";
    return {
      line: LINES.kletia,
      flapLine: "INTERCHANGE",
      flapInfo: "EVM + SOL",
      flapStatus: checking ? "CHECKING" : "LIVE",
      tone: checking ? "checking" : "running",
      spoken: `Kletia, the Interchange: EVM and Solana, ${checking ? "checking" : "live"}.`,
    };
  })();

  const elyiaRow: FamilyBoardRow = {
    line: LINES.elyia,
    flapLine: "SUMMIT LINE",
    flapInfo: "TESTNET",
    flapStatus: "BUILDING",
    tone: "building",
    spoken: "Elyia, Summit Line to Elysium, HyperEVM and HyperCore: testnet, in development.",
  };

  const lykiaRow: FamilyBoardRow = (() => {
    const base = { line: LINES.lykia, flapLine: "COAST LINE" } as const;
    if (lykia.state === "loading") {
      return { ...base, flapInfo: "--- MS", flapStatus: "CHECKING", tone: "checking", spoken: "Lykia, Coast Line to Arc mainnet: checking." };
    }
    const health = lykia.health;
    if (lykia.state === "offline" || !health || health.status === null) {
      return { ...base, flapInfo: "ARC MAIN", flapStatus: "NO SIGNAL", tone: "unknown", spoken: "Lykia, Coast Line to Arc mainnet: no live reading from this browser." };
    }
    const latency = health.arcLatencyMs;
    const info = latency !== null ? `${Math.min(latency, 9999)} MS` : "ARC MAIN";
    if (health.status === "down" || health.arcReachable === false) {
      return { ...base, flapInfo: info, flapStatus: "SUSPENDED", tone: "suspended", spoken: "Lykia, Coast Line to Arc mainnet: suspended." };
    }
    const delayed = health.status === "degraded" || (latency !== null && latency > 3000);
    return {
      ...base,
      flapInfo: info,
      flapStatus: delayed ? "DELAYED" : "RUNNING",
      tone: delayed ? "delayed" : "running",
      spoken: `Lykia, Coast Line to Arc mainnet: ${latency !== null ? `Arc answered in ${latency} milliseconds, ` : ""}${delayed ? "delayed" : "running"}.`,
    };
  })();

  return [kletiaRow, elyiaRow, lykiaRow];
}

/** Figures printed under the board, from the live answer (null values print "—"). */
export function lykiaFigures(live: LykiaLive): readonly { readonly label: string; readonly value: string; readonly spoken: string }[] {
  const stats = live.stats;
  const health = live.health;
  const show = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));
  return [
    { label: "Arc block", value: show(health?.arcHead ?? null), spoken: "Latest Arc mainnet block Lykia read" },
    { label: "Arc RPC", value: health?.arcLatencyMs != null ? `${health.arcLatencyMs} ms` : "—", spoken: "Lykia's round trip to its Arc RPC" },
    { label: "Protocols", value: show(stats?.protocols ?? null), spoken: "Protocols in Lykia's registry" },
    { label: "Verified", value: show(stats?.verified ?? null), spoken: "Protocols Lykia has verified" },
    { label: "Routable", value: show(stats?.routable ?? null), spoken: "Protocols Lykia can route through" },
    { label: "Accounts", value: show(stats?.accountsCreated ?? null), spoken: "Smart accounts created by LykiaAccountFactory" },
  ];
}

/* ---------------------------------------------------------------------------
 * Line pages: what each product does, in a few honest lines.
 * ------------------------------------------------------------------------ */

export interface LineDetail {
  readonly id: Exclude<LineId, "kletia">;
  readonly headline: string;
  readonly does: readonly { readonly title: string; readonly text: string }[];
  readonly shares: string;
}

export const LINE_DETAILS: Readonly<Record<Exclude<LineId, "kletia">, LineDetail>> = Object.freeze({
  elyia: {
    id: "elyia",
    headline: "The Summit Line climbs from the Interchange to Elysium.",
    does: [
      { title: "Ask Ely", text: "Say the goal (bridge, swap, trade, earn, track) and Ely drafts an auditable intent graph you read before you sign." },
      { title: "Trade and track", text: "A trading terminal and a portfolio deck across HyperCore perps and spot, HyperEVM tokens and Elysium." },
      { title: "The Rule Book", text: "Policies sit between you and your capital and fail closed; de-risking always works." },
      { title: "Developers", text: "Keys, a playground, MCP and webhooks on the same engine the deck uses." },
    ],
    shares:
      "Elyia ported Kletia's engine concepts: the intent graph and its lifecycle, the Rule Book, and a developer platform with keys and webhooks. Like Kletia, its server never signs: wallets do.",
  },
  lykia: {
    id: "lykia",
    headline: "The Coast Line runs from the Interchange to Arc mainnet.",
    does: [
      { title: "Ask Lyko", text: "Say the outcome; Lykia compiles it into a scored, simulated route across the protocols live on Arc and Circle's rails." },
      { title: "The Fence", text: "A typed policy checked before signing, compiled into a Circle Agent Wallet policy and enforced on chain." },
      { title: "Tagged agents", text: "Agents carry an ERC-8004 Tag that pins their Fence, so what an agent may move is public and fixed." },
      { title: "The League", text: "Sub-products and integrators on one engine: REST and SSE, MCP, TypeScript and Python SDKs, a CLI and components." },
    ],
    shares:
      "Lykia built on the lineage Elyia carried from Kletia: an intent turned into checked steps, a policy layer before every signature (the Fence), and a developer platform. Non-custodial like Kletia: the server never holds keys.",
  },
});
