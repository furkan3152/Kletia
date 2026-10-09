/**
 * Art tokens for the "Interchange" art direction.
 *
 * Every network fact (name, colour, CAIP-2 id, lane, virtual machine) is read
 * from the @kletia/core registry, so the map, the board, the tickets and the
 * platform signs never drift from what the API plans against. The only thing
 * defined here is presentation: the 2 to 4 letter line bullet code.
 *
 * Colour rule of the house: a network colour appears only where that network
 * is meant. Yellow (#FFD60A) is signage and Kletia; blue (#0052FF) is the
 * primary action. Imports use explicit `.ts` extensions so `node --test` can
 * load this module directly.
 */
import {
  CHAINS,
  NETWORK_KEYS,
  PROTOCOLS,
  resolveChain,
  type CaipChainId,
  type ChainDescriptor,
  type NetworkKey,
  type NetworkLane,
  type ProtocolDescriptor,
  type ProtocolId,
} from "@kletia/core";

import { readableOn } from "./color.ts";

export const INK = "#1A1A1A";
export const PAPER = "#F4F1EA";
/** Ticket and notice stock: printed objects keep this colour at night. */
export const STOCK = "#FFFCF2";
export const YELLOW = "#FFD60A";
export const BLUE = "#0052FF";

/** Track gauge: SVM networks (Solana) run on their own gauge, drawn with a sleeper stripe. */
export type Gauge = "standard" | "svm";

export interface Line {
  readonly key: NetworkKey;
  /** CAIP-2 chain id. */
  readonly id: CaipChainId;
  /** Display name from the registry, e.g. "OP Mainnet". */
  readonly name: string;
  readonly shortName: string;
  /** Bullet text, 2 to 4 uppercase characters. */
  readonly code: string;
  /** Registry brand colour. */
  readonly color: string;
  /** Text colour on `color` with the higher WCAG contrast (always at least 4.5:1 for registry colours). */
  readonly on: string;
  readonly gauge: Gauge;
  readonly lane: NetworkLane;
  /** Testnet lane: drawn in the fenced test yard, never connected to production lines. */
  readonly yard: boolean;
}

const CODES: Partial<Record<NetworkKey, string>> = {
  ethereum: "ETH",
  base: "BASE",
  arbitrum: "ARB",
  optimism: "OP",
  polygon: "POL",
  solana: "SOL",
  arc: "ARC",
  "arbitrum-sepolia": "ASEP",
  "solana-devnet": "SDEV",
};

/** Bullet code for a chain: the curated code, or the first four letters of its short name. */
export function bulletCode(chain: Pick<ChainDescriptor, "key" | "shortName">): string {
  return CODES[chain.key] ?? chain.shortName.replace(/[^a-z0-9]/giu, "").slice(0, 4).toUpperCase();
}

/** The art view of one registry chain. */
export function lineOf(chain: ChainDescriptor): Line {
  return Object.freeze({
    key: chain.key,
    id: chain.id,
    name: chain.name,
    shortName: chain.shortName,
    code: bulletCode(chain),
    color: chain.color,
    on: readableOn(chain.color),
    gauge: chain.vm === "svm" ? "svm" : "standard",
    lane: chain.lane,
    yard: chain.lane === "testnet",
  });
}

/** Every registry network as a line, keyed by network key. */
export const LINES: Readonly<Record<NetworkKey, Line>> = Object.freeze(
  Object.fromEntries(NETWORK_KEYS.map((key) => [key, lineOf(CHAINS[key])])) as Record<NetworkKey, Line>,
);

/** Production (and beta) lines, in registry order. */
export const PRODUCTION_LINES: readonly Line[] = Object.freeze(NETWORK_KEYS.map((key) => LINES[key]).filter((line) => !line.yard));

/** Testnet lines, in registry order: they live in the test yard. */
export const YARD_LINES: readonly Line[] = Object.freeze(NETWORK_KEYS.map((key) => LINES[key]).filter((line) => line.yard));

/** Line for a network key, CAIP-2 id or EVM chain id; null when the registry does not know it. */
export function lineFor(network: unknown): Line | null {
  const chain = resolveChain(network);
  return chain ? LINES[chain.key] : null;
}

/** True when a protocol touches at least one production line. */
function servesProduction(protocol: ProtocolDescriptor): boolean {
  return protocol.networks.some((network) => !LINES[network]?.yard);
}

/**
 * Venues that move value between networks and therefore run through the
 * interchange: registry protocols flagged `crossChain` that serve production
 * lines (testnet-only bridges stay in the yard).
 */
export const INTERCHANGE_VENUES: readonly ProtocolDescriptor[] = Object.freeze(
  PROTOCOLS.filter((protocol) => protocol.crossChain === true && servesProduction(protocol)),
);

/** Registry protocol by id, only when it serves `network` (map stations use this, so a stale station disappears). */
export function venueOn(id: ProtocolId, network: NetworkKey): ProtocolDescriptor | null {
  const protocol = PROTOCOLS.find((entry) => entry.id === id);
  return protocol && protocol.networks.includes(network) ? protocol : null;
}
