/**
 * Simulation endpoints for custom contract steps.
 *
 * Simulation is mandatory before Kletia hands a custom call to a wallet, and
 * not every RPC can do it: `eth_simulateV1` with `traceTransfers` and state
 * overrides is served by some public endpoints and refused by others
 * (verified live 2026-10-09; see the design's network table). Each network
 * has an ordered URL list, overridable with
 * `KLETIA_SIMULATION_RPC_URLS_<NETWORK>` (comma separated, e.g.
 * `KLETIA_SIMULATION_RPC_URLS_ARBITRUM_SEPOLIA`). Every URL is
 * capability-probed on first use (a 1-wei self transfer through
 * `eth_simulateV1` with a balance override and `traceTransfers`) and the
 * result is cached for 10 minutes. Only URLs that passed the probe are used.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";
import { EVM_NETWORK_KEYS, type EvmNetworkKey } from "../chains/evm.js";
import { probeSolanaSimulation } from "../chains/solana.js";
import { SOLANA_NETWORK_KEYS } from "../../../networks/solana/index.js";

/** Endpoints verified to serve eth_simulateV1 with traceTransfers and state overrides (2026-10-09). */
export const DEFAULT_SIMULATION_RPC_URLS: Readonly<Record<EvmNetworkKey, readonly string[]>> = Object.freeze({
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"],
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"],
  optimism: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io", "https://optimism.drpc.org"],
  polygon: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  arc: ["https://rpc.drpc.testnet.arc.network"],
  // publicnode first: the official endpoint answered 429 under simulation-heavy use (asset-preview design F6).
  "arbitrum-sepolia": ["https://arbitrum-sepolia-rpc.publicnode.com", "https://sepolia-rollup.arbitrum.io/rpc"],
});

const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8_000;
export const SIMULATION_TIMEOUT_MS = 15_000;
/** traceTransfers reports native value moves as ERC-20 style Transfer logs from this address. */
export const NATIVE_TRANSFER_EMITTER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Synthetic probe account (no code, never funded on-chain: the probe overrides its balance). */
const PROBE_ACCOUNT = "0x00000000000000000000000000000000c1e7a001";

export function simulationEnvName(network: NetworkKey): string {
  return `KLETIA_SIMULATION_RPC_URLS_${network.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

function validUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || (url.protocol === "http:" && process.env.NODE_ENV !== "production")) return url.href.replace(/\/+$/u, "");
  } catch {
    // ignored below
  }
  return null;
}

/** The configured URL list of an EVM network, in preference order. */
export function simulationUrls(network: EvmNetworkKey): readonly string[] {
  const raw = process.env[simulationEnvName(network)]?.trim();
  if (!raw) return DEFAULT_SIMULATION_RPC_URLS[network];
  const urls = raw.split(",").map((entry) => entry.trim()).filter(Boolean).map(validUrl).filter((entry): entry is string => entry !== null);
  return [...new Set(urls)];
}

export type JsonRpcOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

/**
 * One JSON-RPC call. Resolves with the result or the JSON-RPC error; rejects
 * when the endpoint cannot be reached or answers with something else.
 */
export async function jsonRpc(url: string, method: string, params: readonly unknown[], timeoutMs = SIMULATION_TIMEOUT_MS): Promise<JsonRpcOutcome> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (text.length > 8_000_000) throw new Error("oversized RPC response");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}: not JSON`);
  }
  if (typeof body !== "object" || body === null) throw new Error("malformed JSON-RPC response");
  const record = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  if (record.error) {
    return {
      ok: false,
      error: {
        code: typeof record.error.code === "number" ? record.error.code : -1,
        message: typeof record.error.message === "string" ? record.error.message.slice(0, 300) : "error",
        ...(record.error.data !== undefined ? { data: record.error.data } : {}),
      },
    };
  }
  if (!("result" in record)) throw new Error(`HTTP ${response.status}: no result`);
  return { ok: true, result: record.result };
}

interface ProbeState {
  readonly ok: boolean;
  readonly checkedAt: number;
}

const probes = new Map<string, ProbeState>();
const inflight = new Map<string, Promise<boolean>>();

/** True when the probe block came back with a successful call and a traced native transfer log. */
function probePassed(result: unknown): boolean {
  if (!Array.isArray(result) || result.length !== 1) return false;
  const block = result[0] as { calls?: unknown };
  if (!Array.isArray(block.calls) || block.calls.length !== 1) return false;
  const call = block.calls[0] as { status?: unknown; logs?: unknown };
  if (call.status !== "0x1" || !Array.isArray(call.logs)) return false;
  return call.logs.some((log: { address?: unknown; topics?: unknown }) =>
    typeof log.address === "string" && log.address.toLowerCase() === NATIVE_TRANSFER_EMITTER &&
    Array.isArray(log.topics) && String(log.topics[0]).toLowerCase() === TRANSFER_TOPIC);
}

async function probe(url: string): Promise<boolean> {
  try {
    const outcome = await jsonRpc(url, "eth_simulateV1", [
      {
        blockStateCalls: [
          {
            stateOverrides: { [PROBE_ACCOUNT]: { balance: "0xde0b6b3a7640000" } },
            calls: [{ from: PROBE_ACCOUNT, to: PROBE_ACCOUNT, value: "0x1" }],
          },
        ],
        traceTransfers: true,
        validation: false,
      },
      "latest",
    ], PROBE_TIMEOUT_MS);
    return outcome.ok && probePassed(outcome.result);
  } catch {
    return false;
  }
}

async function capable(url: string, now: number): Promise<boolean> {
  const known = probes.get(url);
  if (known && now - known.checkedAt < PROBE_TTL_MS) return known.ok;
  const pending = inflight.get(url);
  if (pending) return pending;
  const run = probe(url).then((ok) => {
    probes.set(url, { ok, checkedAt: Date.now() });
    inflight.delete(url);
    return ok;
  });
  inflight.set(url, run);
  return run;
}

/** URLs of `network` that passed the capability probe, in configured order. */
export async function simulationEndpoints(network: EvmNetworkKey): Promise<string[]> {
  const urls = simulationUrls(network);
  const now = Date.now();
  const results = await Promise.all(urls.map((url) => capable(url, now)));
  return urls.filter((_, index) => results[index]);
}

/** Marks an endpoint unusable until the next probe (it failed a real request). */
export function demoteSimulationEndpoint(url: string): void {
  probes.set(url, { ok: false, checkedAt: Date.now() - PROBE_TTL_MS + 60_000 });
}

/** Forgets every probe result (tests, configuration changes). */
export function resetSimulationEndpoints(): void {
  probes.clear();
  inflight.clear();
}

/** Health: whether each network can simulate custom contract steps right now. */
export async function simulationCapability(): Promise<Record<NetworkKey, "ok" | "unavailable">> {
  const entries = await Promise.all([
    ...EVM_NETWORK_KEYS.map(async (network) => [network, (await simulationEndpoints(network)).length > 0 ? "ok" : "unavailable"] as const),
    ...SOLANA_NETWORK_KEYS.map(async (network) => [network, (await probeSolanaSimulation(network)) ? "ok" : "unavailable"] as const),
  ]);
  const out = {} as Record<NetworkKey, "ok" | "unavailable">;
  for (const key of Object.keys(CHAINS) as NetworkKey[]) out[key] = "unavailable";
  for (const [network, status] of entries) out[network] = status;
  return out;
}
