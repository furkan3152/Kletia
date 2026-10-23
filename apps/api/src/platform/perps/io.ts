/**
 * Every read the perps venues make goes through this port: venue HTTP APIs
 * (GMX oracle keeper, Hyperliquid /info and the /exchange relay), Arbitrum
 * eth_call and gas price, and Solana account reads. Tests swap it for
 * recorded fixtures (`configurePerpsIo`); nothing here signs or sends a
 * transaction.
 */
import type { Hex } from "viem";
import { fetchProviderJson } from "../../networks/solana/http.js";
import { PlatformError } from "../errors.js";
import { evmClient } from "../engine/chains/evm.js";
import { readSolanaAccounts, type SolanaAccountState } from "../engine/chains/solana.js";

export interface PerpsIo {
  /** GET (no body) or POST (JSON body) of a venue API; throws `<PROVIDER>_UNAVAILABLE` / `_REJECTED`. */
  json(provider: string, url: string, body?: unknown): Promise<unknown>;
  /** eth_call on Arbitrum One at the latest block. */
  arbitrumCall(to: string, data: Hex): Promise<Hex>;
  arbitrumGasPrice(): Promise<bigint>;
  /** Solana mainnet accounts (null entries for missing accounts). */
  solanaAccounts(addresses: readonly string[]): Promise<(SolanaAccountState | null)[]>;
  /** Milliseconds since the epoch. */
  now(): number;
}

const RPC_TIMEOUT_MS = 8_000;

async function timed<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const livePerpsIo: PerpsIo = {
  json(provider, url, body) {
    return fetchProviderJson(url, {
      provider,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
  },
  async arbitrumCall(to, data) {
    try {
      const { data: result } = await timed(evmClient("arbitrum").call({ to: to as Hex, data }));
      return result ?? "0x";
    } catch {
      throw new PlatformError("RPC_UNAVAILABLE", "Arbitrum One could not be read. Try again shortly.", 502);
    }
  },
  async arbitrumGasPrice() {
    try {
      return await timed(evmClient("arbitrum").getGasPrice());
    } catch {
      throw new PlatformError("RPC_UNAVAILABLE", "Arbitrum One could not be read. Try again shortly.", 502);
    }
  },
  solanaAccounts(addresses) {
    return readSolanaAccounts("solana", addresses);
  },
  now: () => Date.now(),
};

let current: PerpsIo = livePerpsIo;

export function perpsIo(): PerpsIo {
  return current;
}

/** Replaces the reads (tests: recorded fixtures); null restores the live port. */
export function configurePerpsIo(io: PerpsIo | null): void {
  current = io ?? livePerpsIo;
}
