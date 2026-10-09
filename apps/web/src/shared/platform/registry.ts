/**
 * Offline view of the platform registries, built from @kletia/core. Used when
 * the API cannot be reached so pages can still show what Kletia supports,
 * clearly labelled as a registry view rather than live status.
 */
import {
  CHAINS,
  NETWORK_KEYS,
  PROTOCOLS,
  protocolsForNetwork,
  type IntentActionKind,
  type NetworkKey,
} from "@kletia/core";
import type { NetworkCapabilities } from "@kletia/sdk";

/**
 * Intent kinds per network, mirroring the "Supported intents (v1)" table in
 * docs/platform/api-v1.md. The live API (`GET /v1/networks`) is authoritative.
 */
const REGISTRY_ACTIONS: Readonly<Record<NetworkKey, readonly IntentActionKind[]>> = Object.freeze({
  base: ["swap", "transfer", "bridge", "deposit"],
  arbitrum: ["swap", "transfer", "bridge", "deposit"],
  ethereum: ["transfer", "deposit"],
  optimism: ["transfer", "deposit"],
  polygon: ["transfer", "deposit"],
  solana: ["swap", "stake", "transfer", "bridge"],
  arc: ["transfer"],
  "arbitrum-sepolia": ["transfer"],
  "solana-devnet": ["transfer"],
});

export function registryNetworks(): NetworkCapabilities[] {
  return NETWORK_KEYS.map((key) => ({
    ...CHAINS[key],
    actions: REGISTRY_ACTIONS[key],
    protocols: protocolsForNetwork(key).map((protocol) => protocol.id),
  }));
}

export function registryProtocols() {
  return [...PROTOCOLS];
}

/** Display order for networks: production lane first, then testnets. */
export function sortNetworks<T extends { key: NetworkKey; environment: string }>(networks: readonly T[]): T[] {
  const order = new Map(NETWORK_KEYS.map((key, index) => [key, index]));
  return [...networks].sort((a, b) => {
    if (a.environment !== b.environment) return a.environment === "mainnet" ? -1 : 1;
    return (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99);
  });
}

export const MAINNET_NETWORKS = NETWORK_KEYS.filter((key) => CHAINS[key].environment === "mainnet");
export const TESTNET_NETWORKS = NETWORK_KEYS.filter((key) => CHAINS[key].environment === "testnet");
