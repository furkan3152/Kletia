/**
 * Detects prompts the EVM chat engines (legacy `/api/intent`) cannot serve
 * because they involve Solana: a Solana network mention, a Solana base58
 * address, Solana-only assets, or a `from <network> to <network>` route with
 * Solana on one side. Those are handed to the platform planner (Studio or the
 * inline "Plan here" card) instead.
 */
import { isSolanaAddress } from "@kletia/core";

export type CrossNetworkReason = "solana-network" | "solana-address" | "solana-asset" | "route";

export interface CrossNetworkPrompt {
  readonly reason: CrossNetworkReason;
  /** Networks named in the prompt, in order of appearance (lower case). */
  readonly networks: readonly string[];
}

const NETWORK_WORDS: Readonly<Record<string, string>> = {
  solana: "solana",
  sol: "solana",
  base: "base",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  arc: "arc",
  ethereum: "ethereum",
  eth: "ethereum",
};

const SOLANA_WORD = /\bsolana\b/iu;
/** "on sol", "to sol network", "sol chain": SOL used as a network name. */
const SOL_AS_NETWORK = /\b(?:on|from|to|via|into|onto|over)\s+sol\b(?!\s*(?:token|coin))|\bsol\s+(?:network|chain|mainnet)\b/iu;
/** Solana-native assets the EVM engines do not route. */
const SOLANA_ASSET = /\b(?:\d+(?:[.,]\d+)?\s*sol|jitosol|msol|jupsol|bsol|bonk|jup)\b/iu;
const ROUTE = /\bfrom\s+([a-z]+)\b[^.;\n]{0,60}?\bto\s+([a-z]+)\b/giu;
const BASE58_TOKEN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu;

function namedNetworks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.toLowerCase().matchAll(/\b[a-z]+\b/gu)) {
    const network = NETWORK_WORDS[match[0]];
    if (network && (match[0] !== "sol" || SOL_AS_NETWORK.test(text)) && !found.includes(network)) {
      found.push(network);
    }
  }
  return found;
}

export function detectCrossNetworkPrompt(rawText: string): CrossNetworkPrompt | null {
  const text = rawText.normalize("NFKC").slice(0, 2_000);
  if (!text.trim()) return null;

  for (const match of text.matchAll(ROUTE)) {
    const from = NETWORK_WORDS[(match[1] ?? "").toLowerCase()];
    const to = NETWORK_WORDS[(match[2] ?? "").toLowerCase()];
    if (from && to && from !== to && (from === "solana" || to === "solana")) {
      return { reason: "route", networks: [from, to] };
    }
  }
  if (SOLANA_WORD.test(text) || SOL_AS_NETWORK.test(text)) {
    return { reason: "solana-network", networks: namedNetworks(text) };
  }
  for (const match of text.matchAll(BASE58_TOKEN)) {
    if (isSolanaAddress(match[0])) return { reason: "solana-address", networks: namedNetworks(text) };
  }
  if (SOLANA_ASSET.test(text)) {
    return { reason: "solana-asset", networks: namedNetworks(text) };
  }
  return null;
}
