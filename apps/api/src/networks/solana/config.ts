import { CHAINS, type NetworkKey } from "@kletia/core";

export type SolanaNetworkKey = Extract<NetworkKey, "solana" | "solana-devnet">;

export const SOLANA_NETWORK_KEYS: readonly SolanaNetworkKey[] = ["solana", "solana-devnet"];

export function isSolanaNetworkKey(value: unknown): value is SolanaNetworkKey {
  return value === "solana" || value === "solana-devnet";
}

function readUrl(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (parsed.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS in production.`);
  }
  return raw.replace(/\/+$/u, "");
}

export const SOLANA_RPC_URLS: Readonly<Record<SolanaNetworkKey, string>> = Object.freeze({
  solana: readUrl("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  "solana-devnet": readUrl("SOLANA_DEVNET_RPC_URL", "https://api.devnet.solana.com"),
});

/** Jupiter: the keyless lite endpoint by default, the keyed pro endpoint when a key is configured. */
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || null;
export const JUPITER_API_URL = readUrl(
  "JUPITER_API_URL",
  JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag",
);
export const KAMINO_API_URL = readUrl("KAMINO_API_URL", "https://api.kamino.finance");
export const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

export const SOLANA_HTTP_TIMEOUT_MS = (() => {
  const configured = Number(process.env.SOLANA_HTTP_TIMEOUT_MS || 10_000);
  return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 60_000
    ? configured
    : 10_000;
})();

/** Default and hard ceiling for Solana swap slippage in basis points. */
export const SOLANA_DEFAULT_SLIPPAGE_BPS = 50;
export const SOLANA_MAX_SLIPPAGE_BPS = 300;

export const SOLANA_PROGRAMS = Object.freeze({
  system: "11111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudget: "ComputeBudget111111111111111111111111111111",
});

export function solanaChain(network: SolanaNetworkKey) {
  return CHAINS[network];
}
