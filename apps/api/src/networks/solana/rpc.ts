import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { SOLANA_RPC_URLS, type SolanaNetworkKey } from "./config.js";

const clients = new Map<SolanaNetworkKey, Rpc<SolanaRpcApi>>();

export function solanaRpc(network: SolanaNetworkKey): Rpc<SolanaRpcApi> {
  let client = clients.get(network);
  if (!client) {
    client = createSolanaRpc(SOLANA_RPC_URLS[network]);
    clients.set(network, client);
  }
  return client;
}

export function rpcAbortSignal(timeoutMs = 10_000): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export async function readSolanaHealth(network: SolanaNetworkKey) {
  const startedAt = Date.now();
  try {
    const rpc = solanaRpc(network);
    const [slot, version] = await Promise.all([
      rpc.getSlot({ commitment: "confirmed" }).send({ abortSignal: rpcAbortSignal(5_000) }),
      rpc.getVersion().send({ abortSignal: rpcAbortSignal(5_000) }),
    ]);
    return {
      network,
      ok: true as const,
      slot: slot.toString(),
      version: version["solana-core"],
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      network,
      ok: false as const,
      error: error instanceof Error ? error.message.slice(0, 160) : "RPC unavailable",
      latencyMs: Date.now() - startedAt,
    };
  }
}
