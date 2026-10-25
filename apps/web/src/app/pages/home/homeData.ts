/**
 * Static content of the home page: the network meta (from the @kletia/core registry), the four
 * example intents the hero machine loops, and the protocol categories of the station index.
 *
 * The example intents are EXAMPLES: amounts, quotes and serials are illustrative and the page
 * labels them so. Every sentence opens in the desk (`/app?q=`), which plans it for real.
 */
import { CHAINS, PROTOCOLS, type NetworkKey, type ProtocolCategory, type ProtocolDescriptor } from "@kletia/core";

import { realProtocols } from "../../site/protocolCount";
import type { HomeIconName } from "./homeIcons";

/* ---------- networks ---------- */
export const NET_ICON: Readonly<Record<NetworkKey, HomeIconName>> = {
  base: "base",
  arbitrum: "arb",
  ethereum: "eth",
  optimism: "op",
  polygon: "pol",
  solana: "sol",
  arc: "arc",
  "arbitrum-sepolia": "arb",
  "solana-devnet": "sol",
};

/** Cartridge label colours (the mockup's palette, tuned for white text). */
export const NET_COLOR: Readonly<Record<NetworkKey, string>> = {
  base: "var(--n-base)",
  arbitrum: "var(--n-arb)",
  ethereum: "var(--n-eth)",
  optimism: "var(--n-op)",
  polygon: "var(--n-pol)",
  solana: "var(--n-sol)",
  arc: "#5B6B8C",
  "arbitrum-sepolia": "var(--n-arb)",
  "solana-devnet": "var(--n-sol)",
};

const CHAIN_LIST = Object.values(CHAINS);

/** The name a cartridge prints: the short name on mainnets ("Arbitrum"), the full name on test networks. */
export function netName(key: NetworkKey): string {
  const chain = CHAINS[key];
  if (!chain) return key;
  if (chain.lane === "testnet" || key === "optimism") return chain.name;
  return chain.shortName;
}

/** Mainnets first, then test networks, each in registry order. */
export const NET_ORDER: readonly NetworkKey[] = [
  ...CHAIN_LIST.filter((chain) => chain.lane !== "testnet").map((chain) => chain.key),
  ...CHAIN_LIST.filter((chain) => chain.lane === "testnet").map((chain) => chain.key),
];

export const isTestNetwork = (key: NetworkKey): boolean => CHAINS[key]?.lane === "testnet";

/** Real protocols (no bring-your-own-contract entries), in registry order. */
export const STATIONS: readonly ProtocolDescriptor[] = realProtocols(PROTOCOLS);

/** Real protocols the registry lists on a network. */
export function protocolsOn(key: NetworkKey, list: readonly ProtocolDescriptor[] = STATIONS): number {
  return list.filter((protocol) => protocol.networks.includes(key)).length;
}

/* ---------- station index categories ---------- */
export type StationFilter = "all" | "swap" | "bridge" | "earn" | "stake" | "perps" | "pay";

export const STATION_FILTERS: readonly { readonly id: StationFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "swap", label: "Swap" },
  { id: "bridge", label: "Bridge" },
  { id: "earn", label: "Lend & earn" },
  { id: "stake", label: "Stake" },
  { id: "perps", label: "Perps & predict" },
  { id: "pay", label: "Pay, data, names" },
];

/** Registry category -> index filter, kept in one place. */
export const CATEGORY_FILTER: Readonly<Record<ProtocolCategory, StationFilter>> = {
  "dex-aggregator": "swap",
  dex: "swap",
  bridge: "bridge",
  "intent-network": "bridge",
  lending: "earn",
  yield: "earn",
  "liquid-staking": "stake",
  perps: "perps",
  prediction: "perps",
  naming: "pay",
  payments: "pay",
  security: "pay",
  data: "pay",
  "token-program": "pay",
  custom: "pay",
};

/** Registry category -> tile glyph. */
export const CATEGORY_ICON: Readonly<Record<ProtocolCategory, HomeIconName>> = {
  "dex-aggregator": "swap",
  dex: "swap",
  bridge: "bridge",
  "intent-network": "relay",
  lending: "earn",
  yield: "earn",
  "liquid-staking": "lido",
  perps: "perp",
  prediction: "poly",
  naming: "at",
  payments: "pay",
  security: "shield",
  data: "data",
  "token-program": "coin",
  custom: "code",
};

/** A few protocols get their own drawing instead of the category glyph. */
export const PROTOCOL_ICON: Readonly<Partial<Record<string, HomeIconName>>> = {
  "uniswap-v3": "uni",
  across: "across",
  relay: "relay",
  "cctp-v2": "cctp",
  "aave-v3": "aave",
  "gmx-v2": "gmx",
  jupiter: "jup",
  lido: "lido",
  polymarket: "poly",
  hyperliquid: "hl",
  x402: "pay",
  "solana-pay": "pay",
};

/* ---------- the hero's example intents ---------- */
export type RouteNode = readonly [kind: "chain" | "stn" | "end", icon: HomeIconName, label: string, amount?: string];

export interface HeroIntent {
  /** The sentence typed into the machine (opens in the desk). */
  readonly text: string;
  /** LCD line, at most 17 characters. */
  readonly lcd: string;
  readonly type: string;
  /** Band colour of the card top. */
  readonly band: "lime" | "ink" | "blue";
  readonly serial: number;
  /** Networks the route touches (they light up in the bay). */
  readonly nets: readonly NetworkKey[];
  readonly nodes: readonly RouteNode[];
  readonly from: string;
  readonly title: string;
  readonly facts: readonly (readonly [string, string])[];
  readonly steps: number;
  readonly sign: string;
  readonly wallet: string;
  /** Stamp line ("19 s · Base"). */
  readonly stamp: string;
  /** Binder thumbnail: kind, title, venue. */
  readonly thumb: readonly [string, string, string];
}

export const HERO_INTENTS: readonly HeroIntent[] = [
  {
    text: "Swap 2 SOL to USDC",
    lcd: "2 SOL → USDC",
    type: "Swap",
    band: "lime",
    serial: 43,
    nets: ["solana"],
    nodes: [["chain", "sol", "Solana", "2 SOL"], ["stn", "jup", "Jupiter"], ["end", "wallet", "Wallet", "368.4 USDC"]],
    from: "2 SOL on Solana becomes",
    title: "368.40 USDC",
    facts: [["You pay", "2.000 SOL"], ["You get at least", "366.56 USDC"], ["Total fees", "$0.004"]],
    steps: 1,
    sign: "Sign 1 step",
    wallet: "Sign 1 of 1 on Solana",
    stamp: "4 s · Solana",
    thumb: ["Swap", "2 SOL → USDC", "Jupiter"],
  },
  {
    text: "Move 1,500 USDC from Arbitrum to Base, half to ETH",
    lcd: "1500 USDC → BASE",
    type: "Bridge + swap",
    band: "lime",
    serial: 44,
    nets: ["arbitrum", "base"],
    nodes: [["chain", "arb", "Arbitrum", "$1.5K"], ["stn", "across", "Across"], ["chain", "base", "Base"], ["stn", "uni", "Uniswap"]],
    from: "1,500 USDC on Arbitrum becomes",
    title: "749.20 USDC + 0.2393 ETH",
    facts: [["You pay", "1,500.00 USDC"], ["You get at least", "0.2381 ETH + 749.20"], ["Total fees", "$1.42"]],
    steps: 2,
    sign: "Sign 2 steps",
    wallet: "Sign 1 of 2 on Arbitrum",
    stamp: "19 s · Base",
    thumb: ["Bridge", "750 USDC → ETH", "Across · Uniswap"],
  },
  {
    text: "Long ETH 5x with 100 USDC",
    lcd: "LONG ETH 5X",
    type: "Perp",
    band: "ink",
    serial: 45,
    nets: ["arbitrum"],
    nodes: [["chain", "arb", "Arbitrum", "100 USDC"], ["stn", "hl", "Hyperliquid"], ["end", "perp", "ETH-PERP", "5×"]],
    from: "100 USDC on Arbitrum opens",
    title: "Long ETH-PERP 5×",
    facts: [["Size", "500.00 USDC"], ["Liquidation", "$2,741.10"], ["Total fees", "$0.18"]],
    steps: 2,
    sign: "Sign 2 steps",
    wallet: "Sign deposit on Arbitrum",
    stamp: "6 s · Hyperliquid",
    thumb: ["Perp", "Long ETH 5×", "Hyperliquid"],
  },
  {
    text: "Bet 50 USDC that ETH closes above $3.5k on Oct 31",
    lcd: "ETH > 3.5K · YES",
    type: "Predict",
    band: "blue",
    serial: 46,
    nets: ["base", "polygon"],
    nodes: [["chain", "base", "Base", "50 USDC"], ["stn", "relay", "Relay"], ["chain", "pol", "Polygon"], ["stn", "poly", "Polymarket"]],
    from: "50 USDC on Base buys",
    title: "119 YES shares at 42¢",
    facts: [["You pay", "50.00 USDC"], ["Pays if YES", "$119.00"], ["Total fees", "$0.21"]],
    steps: 2,
    sign: "Sign 2 steps",
    wallet: "Sign 1 of 2 on Base",
    stamp: "11 s · Polygon",
    thumb: ["Predict", "ETH > $3.5k · YES", "Polymarket"],
  },
];

/** The cards already in an example binder (the hero and the story start from these). */
export const SEED_THUMBS: readonly (readonly [string, string, string])[] = [
  ["Stake", "1.5 SOL → JitoSOL", "Jito"],
  ["Perp", "Long ETH 3×", "GMX v2"],
  ["Supply", "2,000 USDC", "Aave V3"],
];

/** The desk with a sentence typed in (it plans it; nothing is signed until the wallet does). */
export const deskHref = (sentence: string): string => `/app?q=${encodeURIComponent(sentence)}`;

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** "Sixty-five" for 65 (headings print registry counts in words); digits from 100 up. */
export function numberWord(count: number): string {
  if (!Number.isInteger(count) || count < 0 || count >= 100) return String(count);
  const word = count < 20 ? ONES[count]! : `${TENS[Math.floor(count / 10)]}${count % 10 ? `-${ONES[count % 10]}` : ""}`;
  return word.charAt(0).toUpperCase() + word.slice(1);
}
