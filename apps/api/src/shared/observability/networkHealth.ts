import {
  NETWORKS,
  NETWORK_CLIENTS,
  type NetworkId,
} from "../config/networks.js";

/**
 * Live RPC attestation for every configured network: the RPC must answer and
 * report the expected chain id. Results are cached for a few seconds and
 * concurrent probes for the same network share one in-flight request.
 */
export type NetworkHealthCheck = {
  network: NetworkId;
  chainId: number | null;
  expectedChainId: number;
  blockNumber?: string;
  status: "ok" | "chain_mismatch" | "unreachable" | "disabled";
  checkedAt: number;
  error?: string;
};

const NETWORK_HEALTH_TTL_MS = 10_000;
const NETWORK_HEALTH_TIMEOUT_MS = 7_000;
const networkHealthCache = new Map<
  NetworkId,
  { expiresAt: number; value: NetworkHealthCheck }
>();
const networkHealthInFlight = new Map<NetworkId, Promise<NetworkHealthCheck>>();

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("rpc_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Networks whose `enabled` flag is set, in registry order. */
export function enabledNetworkIds(): NetworkId[] {
  return (Object.keys(NETWORKS) as NetworkId[]).filter(
    (network) => NETWORKS[network].enabled,
  );
}

export async function readNetworkHealth(
  network: NetworkId,
  force = false,
): Promise<NetworkHealthCheck> {
  const cached = networkHealthCache.get(network);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = networkHealthInFlight.get(network);
  if (existing) return existing;

  const check = (async () => {
    const config = NETWORKS[network];
    let value: NetworkHealthCheck;
    if (!config.enabled) {
      value = {
        network,
        chainId: null,
        expectedChainId: config.chainId,
        status: "disabled",
        checkedAt: Date.now(),
      };
      networkHealthCache.set(network, {
        expiresAt: Date.now() + NETWORK_HEALTH_TTL_MS,
        value,
      });
      return value;
    }
    try {
      const [chainId, blockNumber] = await withDeadline(
        Promise.all([
          NETWORK_CLIENTS[network].getChainId(),
          NETWORK_CLIENTS[network].getBlockNumber(),
        ]),
        NETWORK_HEALTH_TIMEOUT_MS,
      );
      value = {
        network,
        chainId,
        expectedChainId: config.chainId,
        blockNumber: blockNumber.toString(),
        status: chainId === config.chainId ? "ok" : "chain_mismatch",
        checkedAt: Date.now(),
      };
    } catch (error: any) {
      console.error("[HEALTH RPC CHECK FAILED]", {
        network,
        code: typeof error?.code === "string" ? error.code : "RPC_ERROR",
      });
      value = {
        network,
        chainId: null,
        expectedChainId: config.chainId,
        status: "unreachable",
        checkedAt: Date.now(),
        error: "RPC health check failed.",
      };
    }
    networkHealthCache.set(network, {
      expiresAt: Date.now() + NETWORK_HEALTH_TTL_MS,
      value,
    });
    return value;
  })().finally(() => networkHealthInFlight.delete(network));

  networkHealthInFlight.set(network, check);
  return check;
}
