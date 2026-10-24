/**
 * Keyless Solana history: `getSignaturesForAddress` and one
 * `getTransaction` (jsonParsed) per signature on the configured RPC
 * (SOLANA_RPC_URL). Slow and capped (`SOLANA_RPC_PAGE` transactions a
 * page): HELIUS_API_KEY replaces it. Transfers are the owner's balance
 * deltas (SOL net of the fee it paid, and every token account it owns), so
 * their other side is unknown; a plain System or SPL transfer names it.
 */
import { fromBaseUnits, type NetworkKey } from "@kletia/core";
import { SOLANA_RPC_URLS } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { historyFetch } from "./fetch.js";
import type { HistoryProvider, ProviderPage, RawTransfer, RawTx } from "./types.js";

/** Transactions per page on plain RPC (one getTransaction each). */
export const SOLANA_RPC_PAGE = 15;
const LAMPORTS = 9;

interface ParsedInstruction {
  readonly programId?: string;
  readonly parsed?: { readonly type?: string; readonly info?: Record<string, unknown> } | string;
}

interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

interface RpcTransaction {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly fee: number;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly TokenBalance[];
    readonly postTokenBalances?: readonly TokenBalance[];
    readonly innerInstructions?: readonly { readonly instructions: readonly ParsedInstruction[] }[];
  } | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: { readonly accountKeys: readonly { readonly pubkey: string }[]; readonly instructions: readonly ParsedInstruction[] };
  };
}

async function rpc(network: NetworkKey, method: string, params: readonly unknown[]): Promise<unknown> {
  const url = SOLANA_RPC_URLS[network as keyof typeof SOLANA_RPC_URLS];
  if (!url) throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", `No Solana RPC for ${network}.`, 502);
  const body = (await historyFetch(url, { provider: "Solana RPC", method: "POST", body: { jsonrpc: "2.0", id: 1, method, params } })) as { result?: unknown; error?: { message?: unknown } } | null;
  if (!body || body.error || !("result" in body)) {
    throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", `Solana RPC refused ${method}: ${String(body?.error?.message ?? "invalid response").slice(0, 160)}`, 502);
  }
  return body.result;
}

/** The other side of a plain System or SPL transfer of `owner`, when the transaction is exactly that. */
function plainCounterparty(instructions: readonly ParsedInstruction[], owner: string): string | null {
  const transfers = instructions.filter((instruction) => typeof instruction.parsed === "object" && /^transfer/u.test(instruction.parsed.type ?? ""));
  if (transfers.length !== 1) return null;
  const info = (transfers[0]!.parsed as { info?: Record<string, unknown> }).info ?? {};
  const from = info.source ?? info.authority;
  const to = info.destination;
  if (from === owner && typeof to === "string") return to;
  if (to === owner && typeof from === "string") return from;
  return typeof from === "string" && from !== owner ? from : null;
}

function tokenDeltas(meta: NonNullable<RpcTransaction["meta"]>, owner: string): Map<string, { delta: bigint; decimals: number }> {
  const deltas = new Map<string, { delta: bigint; decimals: number }>();
  const add = (balances: readonly TokenBalance[] | undefined, sign: 1n | -1n) => {
    for (const balance of balances ?? []) {
      if (balance.owner !== owner) continue;
      const entry = deltas.get(balance.mint) ?? { delta: 0n, decimals: balance.uiTokenAmount.decimals };
      entry.delta += sign * BigInt(balance.uiTokenAmount.amount);
      deltas.set(balance.mint, entry);
    }
  };
  add(meta.postTokenBalances, 1n);
  add(meta.preTokenBalances, -1n);
  return deltas;
}

export function rpcTransaction(network: NetworkKey, account: RawTx["account"], owner: string, tx: RpcTransaction): RawTx | null {
  const signature = tx.transaction.signatures[0];
  if (!signature || !tx.meta || tx.blockTime === null) return null;
  const keys = tx.transaction.message.accountKeys.map((key) => key.pubkey);
  const index = keys.indexOf(owner);
  const payer = keys[0] ?? null;
  const paid = payer === owner;
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((inner) => inner.instructions)];
  const counterparty = plainCounterparty(tx.transaction.message.instructions, owner);
  const transfers: RawTransfer[] = [];
  const side = (delta: bigint) => (delta < 0n ? { from: owner, to: counterparty } : { from: counterparty, to: owner });
  if (index >= 0) {
    // The SOL delta without the fee the owner paid (the fee is reported on its own).
    const delta = BigInt(tx.meta.postBalances[index] ?? 0) - BigInt(tx.meta.preBalances[index] ?? 0) + (paid ? BigInt(tx.meta.fee) : 0n);
    if (delta !== 0n) transfers.push({ token: { symbol: "SOL", address: null, decimals: LAMPORTS }, ...side(delta), amount: fromBaseUnits(delta < 0n ? -delta : delta, LAMPORTS) });
  }
  for (const [mint, entry] of tokenDeltas(tx.meta, owner)) {
    if (entry.delta === 0n) continue;
    const magnitude = entry.delta < 0n ? -entry.delta : entry.delta;
    transfers.push({ token: { symbol: "", address: mint, decimals: entry.decimals }, ...side(entry.delta), amount: fromBaseUnits(magnitude, entry.decimals) });
  }
  return {
    network,
    account,
    owner,
    hash: signature,
    time: tx.blockTime * 1000,
    block: tx.slot,
    status: tx.meta.err ? "failed" : "success",
    from: payer,
    to: null,
    method: null,
    transfers,
    fee: paid ? fromBaseUnits(BigInt(tx.meta.fee), LAMPORTS) : null,
    feeKnown: true,
    programs: [...new Set(instructions.map((instruction) => instruction.programId).filter((program): program is string => typeof program === "string"))],
    hint: null,
    source: "solana-rpc",
  };
}

/** One transaction of `account` by signature (null when the node does not have it). */
export async function readSolanaTransaction(account: { readonly id: RawTx["account"]; readonly network: NetworkKey; readonly address: string }, signature: string): Promise<RawTx | null> {
  const result = await rpc(account.network, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  return result ? rpcTransaction(account.network, account.id, account.address, result as RpcTransaction) : null;
}

export const solanaRpcProvider: HistoryProvider = {
  id: "solana-rpc",
  async page(account, cursor, size): Promise<ProviderPage> {
    const limit = Math.min(size, SOLANA_RPC_PAGE);
    const signatures = await rpc(account.network, "getSignaturesForAddress", [account.address, { limit, ...(cursor?.before ? { before: cursor.before } : {}) }]);
    if (!Array.isArray(signatures)) throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", "Solana RPC returned an invalid signature list.", 502);
    const txs: RawTx[] = [];
    for (const entry of signatures as { signature?: unknown }[]) {
      if (typeof entry.signature !== "string") continue;
      const result = await rpc(account.network, "getTransaction", [entry.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      // A transaction the node no longer has is left out rather than guessed.
      const tx = result ? rpcTransaction(account.network, account.id, account.address, result as RpcTransaction) : null;
      if (tx) txs.push(tx);
    }
    return { txs, more: signatures.length >= limit };
  },
};
