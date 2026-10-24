/**
 * Solana history through Helius's Enhanced Transactions API
 * (docs.helius.dev: `GET /v0/addresses/{address}/transactions`), newest
 * first, paged with `before` (a signature). Helius parses native and token
 * transfers and labels the transaction (`type`, used as a hint only: the
 * classifier decides from the programs invoked and the transfers).
 */
import { fromBaseUnits, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { historyFetch } from "./fetch.js";
import type { HistoryProvider, ProviderPage, RawTransfer, RawTx } from "./types.js";

const HOSTS: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  solana: "https://api.helius.xyz",
  "solana-devnet": "https://api-devnet.helius.xyz",
});
const LAMPORTS = 9;

interface HeliusInstruction {
  readonly programId?: string;
  readonly innerInstructions?: readonly { readonly programId?: string }[];
}

interface HeliusTransaction {
  readonly signature?: string;
  readonly timestamp?: number;
  readonly slot?: number;
  readonly type?: string;
  readonly fee?: number;
  readonly feePayer?: string;
  readonly transactionError?: unknown;
  readonly nativeTransfers?: readonly { readonly fromUserAccount?: string; readonly toUserAccount?: string; readonly amount?: number }[];
  readonly tokenTransfers?: readonly { readonly fromUserAccount?: string; readonly toUserAccount?: string; readonly tokenAmount?: number; readonly mint?: string }[];
  readonly instructions?: readonly HeliusInstruction[];
}

export function heliusKey(): string | null {
  return process.env.HELIUS_API_KEY?.trim() || null;
}

export function heliusServes(network: NetworkKey): boolean {
  return HOSTS[network] !== undefined;
}

/** Token amounts arrive as JSON numbers in the token's units: written out without exponent notation. */
function decimalOf(value: number): string {
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 });
}

export function heliusTransaction(network: NetworkKey, account: RawTx["account"], owner: string, tx: HeliusTransaction): RawTx | null {
  if (!tx.signature || typeof tx.timestamp !== "number") return null;
  const transfers: RawTransfer[] = [];
  for (const native of tx.nativeTransfers ?? []) {
    if ((native.fromUserAccount !== owner && native.toUserAccount !== owner) || !native.amount) continue;
    transfers.push({ token: { symbol: "SOL", address: null, decimals: LAMPORTS }, from: native.fromUserAccount ?? null, to: native.toUserAccount ?? null, amount: fromBaseUnits(BigInt(native.amount), LAMPORTS) });
  }
  for (const token of tx.tokenTransfers ?? []) {
    if ((token.fromUserAccount !== owner && token.toUserAccount !== owner) || !token.mint || typeof token.tokenAmount !== "number") continue;
    transfers.push({ token: { symbol: "", address: token.mint, decimals: null }, from: token.fromUserAccount ?? null, to: token.toUserAccount ?? null, amount: decimalOf(token.tokenAmount) });
  }
  const programs = (tx.instructions ?? []).flatMap((instruction) => [instruction.programId, ...(instruction.innerInstructions ?? []).map((inner) => inner.programId)]);
  const paid = tx.feePayer === owner;
  return {
    network,
    account,
    owner,
    hash: tx.signature,
    time: tx.timestamp * 1000,
    block: tx.slot ?? null,
    status: tx.transactionError ? "failed" : "success",
    from: tx.feePayer ?? null,
    to: null,
    method: null,
    transfers,
    fee: paid && typeof tx.fee === "number" ? fromBaseUnits(BigInt(tx.fee), LAMPORTS) : null,
    feeKnown: true,
    programs: [...new Set(programs.filter((program): program is string => typeof program === "string"))],
    hint: tx.type && tx.type !== "UNKNOWN" ? tx.type : null,
    source: "helius",
  };
}

export const heliusProvider: HistoryProvider = {
  id: "helius",
  async page(account, cursor, size): Promise<ProviderPage> {
    const key = heliusKey();
    if (!key) throw new PlatformError("HISTORY_NOT_CONFIGURED", "HELIUS_API_KEY is not set.", 503);
    const query = new URLSearchParams({ "api-key": key, limit: String(Math.min(size, 100)), ...(cursor?.before ? { before: cursor.before } : {}) });
    const body = await historyFetch(`${HOSTS[account.network]}/v0/addresses/${account.address}/transactions?${query}`, { provider: "Helius" });
    if (!Array.isArray(body)) throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", "Helius returned an invalid response.", 502);
    const txs = (body as HeliusTransaction[]).map((tx) => heliusTransaction(account.network, account.id, account.address, tx)).filter((tx): tx is RawTx => tx !== null);
    return { txs, more: body.length >= Math.min(size, 100) };
  },
};
