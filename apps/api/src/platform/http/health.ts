/**
 * GET /v1/health: API status plus a live RPC probe per network (Solana via
 * getSlot/getVersion, EVM via eth_blockNumber). Never throws; results are
 * cached for 10 s and concurrent callers share one probe. Provider error
 * text is never returned (it can contain keyed RPC URLs).
 */
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "@kletia/core";
import type { PublicClient } from "viem";
import { readSolanaHealth, isSolanaNetworkKey } from "../../networks/solana/index.js";
import { arbitrumSepoliaPublicClient } from "../../networks/arbitrum-sepolia/config.js";
import { NETWORK_CLIENTS } from "../../shared/config/networks.js";
import { getIntentStore } from "../index.js";
import { apiKeyStoreKind } from "./auth.js";
import { webhookDispatcherStats, type DispatcherStats } from "./dispatcher.js";
import { platformSecretStatus } from "./secrets.js";
import { webhookStoreKind } from "./webhooks.js";

export const PLATFORM_API_VERSION = "1.0.0";
const PROBE_TIMEOUT_MS = 4_000;
const CACHE_MS = 10_000;
const startedAt = Date.now();

export interface NetworkHealth {
  readonly network: NetworkKey;
  readonly chain: string;
  readonly name: string;
  readonly environment: "mainnet" | "testnet";
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Latest block number (EVM) or slot (Solana) as a decimal string. */
  readonly height?: string;
  readonly detail?: string;
}

export interface PlatformHealth {
  readonly status: "ok" | "degraded" | "down";
  readonly api: "v1";
  readonly version: string;
  readonly time: string;
  readonly uptimeSeconds: number;
  readonly networks: readonly NetworkHealth[];
  readonly storage: { readonly intents: string; readonly apiKeys: string; readonly webhooks: string };
  readonly webhooks: {
    readonly status: "enabled" | "needs_configuration";
    readonly dispatcher: DispatcherStats | null;
  };
}

function evmClientFor(network: NetworkKey): PublicClient | null {
  switch (network) {
    case "base":
      return NETWORK_CLIENTS.base;
    case "arbitrum":
      return NETWORK_CLIENTS.arbitrum;
    case "arc":
      return NETWORK_CLIENTS.arc;
    case "arbitrum-sepolia":
      return arbitrumSepoliaPublicClient;
    default:
      return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probe(network: NetworkKey): Promise<NetworkHealth> {
  const chain = CHAINS[network];
  const base = { network, chain: chain.id, name: chain.name, environment: chain.environment } as const;
  const started = Date.now();
  try {
    if (isSolanaNetworkKey(network)) {
      const result = await withTimeout(readSolanaHealth(network), PROBE_TIMEOUT_MS + 1_000);
      return result.ok
        ? { ...base, ok: true, latencyMs: result.latencyMs, height: result.slot }
        : { ...base, ok: false, latencyMs: result.latencyMs, detail: "RPC unavailable" };
    }
    const client = evmClientFor(network);
    if (!client) return { ...base, ok: false, latencyMs: 0, detail: "No RPC client configured" };
    const block = await withTimeout(client.getBlockNumber({ cacheTime: 0 }), PROBE_TIMEOUT_MS);
    return { ...base, ok: true, latencyMs: Date.now() - started, height: block.toString() };
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    return { ...base, ok: false, latencyMs: Date.now() - started, detail: timedOut ? "RPC timeout" : "RPC unavailable" };
  }
}

function storeKind(read: () => string): string {
  try {
    return read();
  } catch {
    return "unavailable";
  }
}

let cached: { readonly at: number; readonly networks: readonly NetworkHealth[] } | null = null;
let inflight: Promise<readonly NetworkHealth[]> | null = null;

async function networkHealth(): Promise<readonly NetworkHealth[]> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.networks;
  inflight ??= Promise.all(NETWORK_KEYS.map((network) => probe(network)))
    .then((networks) => {
      cached = { at: Date.now(), networks };
      return networks;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function readPlatformHealth(): Promise<PlatformHealth> {
  let networks: readonly NetworkHealth[];
  try {
    networks = await networkHealth();
  } catch {
    networks = [];
  }
  const healthy = networks.filter((entry) => entry.ok).length;
  const webhooksEnabled = platformSecretStatus() !== "missing";
  return {
    status: networks.length > 0 && healthy === networks.length ? "ok" : healthy === 0 ? "down" : "degraded",
    api: "v1",
    version: PLATFORM_API_VERSION,
    time: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    networks,
    storage: {
      intents: storeKind(() => getIntentStore().kind),
      apiKeys: storeKind(apiKeyStoreKind),
      webhooks: storeKind(webhookStoreKind),
    },
    webhooks: {
      status: webhooksEnabled ? "enabled" : "needs_configuration",
      dispatcher: webhookDispatcherStats(),
    },
  };
}
