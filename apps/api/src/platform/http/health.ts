/**
 * GET /v1/health: API status plus a live RPC probe per network (Solana via
 * getSlot/getVersion, EVM via eth_blockNumber). Never throws; results are
 * cached for 10 s and concurrent callers share one probe. Provider error
 * text is never returned (it can contain keyed RPC URLs).
 *
 * Custom contracts: whether they are enabled and, per network, whether a
 * configured endpoint can simulate (`eth_simulateV1` / `simulateTransaction`),
 * which custom contract steps need before they can be prepared. That probe is
 * cached for 60 s and bounded to 4 s.
 */
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "@kletia/core";
import type { PublicClient } from "viem";
import { readSolanaHealth, isSolanaNetworkKey } from "../../networks/solana/index.js";
import { arbitrumSepoliaPublicClient } from "../../networks/arbitrum-sepolia/config.js";
import { NETWORK_CLIENTS, PLATFORM_NETWORK_CLIENTS } from "../../shared/config/networks.js";
import { getIntentStore } from "../index.js";
import { apiKeyStoreKind } from "./auth.js";
import { contractEngine, contractsEnabled } from "./contractChecks.js";
import { contractStoreKind } from "./contracts.js";
import { webhookDispatcherStats, type DispatcherStats } from "./dispatcher.js";
import { previewStoreKind } from "./preview.js";
import { receiptHealth, type ReceiptHealth } from "./receipts/health.js";
import { platformSecretStatus, type PlatformSecretStatus } from "./secrets.js";
import { sessionStore } from "./sessions.js";
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
  readonly storage: { readonly intents: string; readonly apiKeys: string; readonly webhooks: string; readonly contracts: string; readonly sessions: string };
  readonly webhooks: {
    readonly status: "enabled" | "needs_configuration";
    /** How webhook secrets are sealed: a configured secret, the development key (memory stores only) or none. */
    readonly sealing: PlatformSecretStatus;
    readonly dispatcher: DispatcherStats | null;
  };
  readonly contracts: {
    readonly enabled: boolean;
    /** Per network: can a configured endpoint simulate now? Null when not probed (custom health probe) or unavailable. */
    readonly simulation: Partial<Record<NetworkKey, "ok" | "unavailable">> | null;
  };
  /** Verifiable receipts: signer state, issuance queue and the last log batch. */
  readonly receipts: ReceiptHealth;
  /** Asset-change previews: where acknowledged digests are kept. */
  readonly preview: { readonly store: "memory" | "postgres" | "custom" };
}

function evmClientFor(network: NetworkKey): PublicClient | null {
  switch (network) {
    case "base":
      return NETWORK_CLIENTS.base;
    case "arbitrum":
      return NETWORK_CLIENTS.arbitrum;
    case "ethereum":
    case "optimism":
    case "polygon":
      return PLATFORM_NETWORK_CLIENTS[network];
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
let activeProbe: (network: NetworkKey) => Promise<NetworkHealth> = probe;

type SimulationProbe = () => Promise<Partial<Record<NetworkKey, "ok" | "unavailable">>>;

const liveSimulationProbe: SimulationProbe = () => contractEngine().simulationCapability();
let simulationProbe: SimulationProbe | null = liveSimulationProbe;
let simulationCache: { readonly at: number; readonly value: Partial<Record<NetworkKey, "ok" | "unavailable">> | null } | null = null;
const SIMULATION_CACHE_MS = 60_000;

/**
 * Replaces the per-network RPC probe (tests, embedders with their own
 * monitoring); `null` restores the live probes. A custom probe also replaces
 * the simulation capability probe (`simulation`, not probed when omitted).
 * Clears the cached results.
 */
export function configureHealthProbe(custom: ((network: NetworkKey) => Promise<NetworkHealth>) | null, simulation?: SimulationProbe): void {
  activeProbe = custom ?? probe;
  simulationProbe = custom ? (simulation ?? null) : liveSimulationProbe;
  cached = null;
  inflight = null;
  simulationCache = null;
}

async function simulationHealth(): Promise<Partial<Record<NetworkKey, "ok" | "unavailable">> | null> {
  const now = Date.now();
  if (simulationCache && now - simulationCache.at < SIMULATION_CACHE_MS) return simulationCache.value;
  const probeUsed = simulationProbe;
  let value: Partial<Record<NetworkKey, "ok" | "unavailable">> | null = null;
  if (probeUsed && contractsEnabled()) {
    try {
      value = await withTimeout(probeUsed(), PROBE_TIMEOUT_MS);
    } catch {
      value = null;
    }
  }
  if (simulationProbe === probeUsed) simulationCache = { at: Date.now(), value };
  return value;
}

async function safeProbe(network: NetworkKey): Promise<NetworkHealth> {
  try {
    return await activeProbe(network);
  } catch {
    const chain = CHAINS[network];
    return { network, chain: chain.id, name: chain.name, environment: chain.environment, ok: false, latencyMs: 0, detail: "RPC unavailable" };
  }
}

async function networkHealth(): Promise<readonly NetworkHealth[]> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.networks;
  if (inflight) return inflight;
  const probeUsed = activeProbe;
  const current: Promise<readonly NetworkHealth[]> = Promise.all(NETWORK_KEYS.map((network) => safeProbe(network)))
    .then((networks) => {
      // A probe swapped mid-flight (configureHealthProbe) must not cache stale results.
      if (activeProbe === probeUsed) cached = { at: Date.now(), networks };
      return networks;
    })
    .finally(() => {
      if (inflight === current) inflight = null;
    });
  inflight = current;
  return current;
}

export async function readPlatformHealth(): Promise<PlatformHealth> {
  // The RPC probes and the simulation probe run side by side (both bounded).
  const [networks, simulation, receipts] = await Promise.all([networkHealth().catch((): readonly NetworkHealth[] => []), simulationHealth(), receiptHealth()]);
  const healthy = networks.filter((entry) => entry.ok).length;
  const sealing = platformSecretStatus();
  const webhooksEnabled = sealing !== "missing";
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
      contracts: storeKind(contractStoreKind),
      sessions: storeKind(() => sessionStore().kind),
    },
    webhooks: {
      status: webhooksEnabled ? "enabled" : "needs_configuration",
      sealing,
      dispatcher: webhookDispatcherStats(),
    },
    contracts: { enabled: contractsEnabled(), simulation },
    receipts,
    preview: { store: previewStoreKind() },
  };
}
