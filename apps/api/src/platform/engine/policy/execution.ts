/**
 * Execution-side Rule Book helpers (policy design §6.2, §6.3): nonce
 * pinning of prepared EVM transactions, the exposure identity of a payload,
 * and the chain reads both need (with test seams).
 */
import { randomUUID } from "node:crypto";
import { CHAINS, policyExposureId, type IntentStep, type NetworkKey, type TransactionRequest } from "@kletia/core";
import { solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { evmChainId, isEvmNetwork, readPendingNonce, type EvmNetworkKey } from "../chains/evm.js";
import type { PayloadExposure } from "./gate.js";

export interface PolicyChainReads {
  /** `eth_getTransactionCount(account, "pending")`. */
  pendingNonce(network: EvmNetworkKey, account: string): Promise<bigint>;
  /** Current block height of a Solana cluster. */
  solanaBlockHeight(network: SolanaNetworkKey): Promise<bigint>;
}

const defaultReads: PolicyChainReads = {
  pendingNonce: readPendingNonce,
  solanaBlockHeight: async (network) =>
    BigInt(await solanaRpc(network).getBlockHeight({ commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(5_000) })),
};

let reads: PolicyChainReads = defaultReads;

/** Replaces chain reads (tests); null restores the live ones. */
export function configurePolicyReads(next: Partial<PolicyChainReads> | null): void {
  reads = next ? { ...defaultReads, ...next } : defaultReads;
}

/**
 * Puts consecutive pending nonces on a payload's EVM transactions (all are
 * sent by the step account). A nonce that cannot be read refuses the
 * prepare: an unpinned payload would not be what the rule book asked for.
 */
export async function pinNonces(step: Pick<IntentStep, "network" | "account">, transactions: readonly TransactionRequest[]): Promise<TransactionRequest[]> {
  if (!isEvmNetwork(step.network) || !transactions.some((transaction) => transaction.vm === "evm")) return [...transactions];
  const sender = transactions.find((transaction) => transaction.vm === "evm");
  if (!sender || sender.vm !== "evm") return [...transactions];
  let next: bigint;
  try {
    next = await reads.pendingNonce(step.network, sender.from);
  } catch (error) {
    if (error instanceof PlatformError && error.status < 500) throw error;
    throw new PlatformError("RPC_UNAVAILABLE", `The account nonce on ${CHAINS[step.network].name} could not be read, and this key's rule book pins nonces. Retry shortly.`, 502);
  }
  if (next < 0n) throw new PlatformError("RPC_UNAVAILABLE", "The account nonce read was malformed.", 502);
  return transactions.map((transaction) => {
    if (transaction.vm !== "evm") return transaction;
    const nonce = next;
    next += 1n;
    return { ...transaction, nonce: nonce.toString() };
  });
}

/** Current Solana block height of the step network, or null when unreadable (callers then keep exposures). */
export async function solanaBlockHeight(network: NetworkKey): Promise<bigint | null> {
  if (CHAINS[network].vm !== "svm") return null;
  try {
    const height = await reads.solanaBlockHeight(network as SolanaNetworkKey);
    return height > 0n ? height : null;
  } catch {
    return null;
  }
}

/**
 * Identity of the exposure a payload opens. Pinned EVM payloads that share
 * the first nonce are mutually exclusive (`exclusiveKey`); unpinned EVM
 * payloads each count, even with identical calldata (a wallet can broadcast
 * both with different nonces), so each prepare gets its own id.
 * Solana payloads with the same binding are the same signed bytes.
 */
export function payloadExposure(input: {
  readonly intentId: string;
  readonly step: Pick<IntentStep, "id" | "network" | "account">;
  readonly quoteBinding: string;
  readonly transactions: readonly TransactionRequest[];
  readonly now: number;
}): PayloadExposure {
  const { intentId, step, quoteBinding, transactions, now } = input;
  const nonces = transactions.flatMap((transaction) => (transaction.vm === "evm" && transaction.nonce !== undefined ? [transaction.nonce] : []));
  const evm = isEvmNetwork(step.network);
  const pinned = evm && nonces.length > 0 && nonces.length === transactions.length;
  const first = transactions[0];
  const exclusiveKey = pinned && first?.vm === "evm"
    ? `evm:${evmChainId(step.network as EvmNetworkKey)}:${first.from.toLowerCase()}:${nonces[0]}`
    : null;
  // Unpinned EVM payloads: every prepare is its own exposure, even within one millisecond on two instances.
  const identity = pinned ? `${quoteBinding}|nonce:${nonces.join(",")}` : evm ? `${quoteBinding}|at:${now}|${randomUUID()}` : quoteBinding;
  const heights = transactions.flatMap((transaction) => (transaction.vm === "svm" && typeof transaction.lastValidBlockHeight === "number" ? [transaction.lastValidBlockHeight] : []));
  return {
    id: policyExposureId(intentId, step.id, identity),
    exclusiveKey,
    validUntilHeight: heights.length > 0 ? Math.max(...heights) : null,
    nonces: pinned ? nonces : [],
  };
}

/** The pinned first nonce an exclusive key names (`evm:<chainId>:<account>:<nonce>`). */
export function exclusiveKeyNonce(exclusiveKey: string | null): string | null {
  const match = exclusiveKey ? /^evm:\d+:0x[0-9a-f]{40}:(\d+)$/u.exec(exclusiveKey) : null;
  return match ? (match[1] as string) : null;
}
