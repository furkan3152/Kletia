/**
 * EVM history through the Etherscan V2 multichain API (one key, every
 * chain id: docs.etherscan.io/etherscan-v2): normal transactions
 * (`txlist`), ERC-20 transfers (`tokentx`) and internal transactions
 * (`txlistinternal`) of an address, newest first, grouped by hash.
 *
 * Paging walks blocks downwards: each list is read up to the cursor's block
 * (`endblock`, inclusive) and hashes already listed there are skipped. A
 * transaction is complete only above the lowest block every full list
 * reached, so rows at that block wait for the next page.
 *
 * Fees are `gasUsed × gasPrice` of transactions the address sent; on OP
 * Stack networks (Base, OP Mainnet) the L1 data fee is not included.
 */
import { CHAINS, fromBaseUnits, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { historyFetch } from "./fetch.js";
import type { AccountCursor, HistoryProvider, ProviderPage, RawTransfer, RawTx } from "./types.js";

const BASE_URL = "https://api.etherscan.io/v2/api";
const ACTIONS = ["txlist", "tokentx", "txlistinternal"] as const;
type Action = (typeof ACTIONS)[number];

interface EtherscanRow {
  readonly hash?: string;
  readonly blockNumber?: string;
  readonly timeStamp?: string;
  readonly from?: string;
  readonly to?: string;
  readonly value?: string;
  readonly isError?: string;
  readonly txreceipt_status?: string;
  readonly gasUsed?: string;
  readonly gasPrice?: string;
  readonly functionName?: string;
  readonly methodId?: string;
  readonly contractAddress?: string;
  readonly tokenSymbol?: string;
  readonly tokenDecimal?: string;
}

export function etherscanKey(): string | null {
  return process.env.ETHERSCAN_API_KEY?.trim() || null;
}

/** Chain ids Etherscan V2 serves among Kletia's EVM networks (Arc Testnet is not one). */
export function etherscanServes(network: NetworkKey): boolean {
  return network !== "arc" && CHAINS[network].vm === "evm" && CHAINS[network].evmChainId !== undefined;
}

async function list(action: Action, network: NetworkKey, address: string, cursor: AccountCursor | undefined, size: number, key: string): Promise<EtherscanRow[]> {
  const query = new URLSearchParams({
    chainid: String(CHAINS[network].evmChainId),
    module: "account",
    action,
    address,
    startblock: "0",
    endblock: cursor?.block === undefined ? "99999999999" : String(cursor.block),
    page: "1",
    offset: String(size),
    sort: "desc",
    apikey: key,
  });
  const body = (await historyFetch(`${BASE_URL}?${query}`, { provider: "Etherscan" })) as { status?: unknown; message?: unknown; result?: unknown } | null;
  if (!body || typeof body !== "object") throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", "Etherscan returned an invalid response.", 502);
  if (Array.isArray(body.result)) return body.result as EtherscanRow[];
  // status 0 with "No transactions found" is an empty list; anything else (bad key, rate limit, plan) fails closed.
  if (body.message === "No transactions found") return [];
  const detail = typeof body.result === "string" ? body.result : String(body.message ?? "unknown error");
  if (/rate limit/iu.test(detail)) throw new PlatformError("PROVIDER_RATE_LIMITED", "Etherscan is limiting requests right now.", 503);
  throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", `Etherscan refused the read: ${detail.slice(0, 160)}`, 502);
}

const lower = (value: string | undefined) => (value ?? "").toLowerCase();

function nativeTransfer(network: NetworkKey, row: EtherscanRow): RawTransfer | null {
  if (!row.value || row.value === "0") return null;
  const native = CHAINS[network].nativeAsset;
  return { token: { symbol: native.symbol, address: null, decimals: native.decimals }, from: lower(row.from), to: lower(row.to), amount: fromBaseUnits(row.value, native.decimals) };
}

function tokenTransfer(row: EtherscanRow): RawTransfer {
  const decimals = /^\d{1,2}$/u.test(row.tokenDecimal ?? "") ? Number(row.tokenDecimal) : null;
  return {
    token: { symbol: row.tokenSymbol || "Unknown token", address: lower(row.contractAddress), decimals },
    from: lower(row.from),
    to: lower(row.to),
    amount: decimals === null || !row.value ? null : fromBaseUnits(row.value, decimals),
  };
}

interface Group {
  hash: string;
  block: number;
  time: number;
  normal: EtherscanRow | null;
  transfers: RawTransfer[];
  internalTargets: string[];
  internalFailed: boolean;
}

/** Groups the three lists by hash into raw transactions of `owner`. */
export function etherscanTransactions(network: NetworkKey, account: RawTx["account"], owner: string, rows: Readonly<Record<Action, readonly EtherscanRow[]>>): RawTx[] {
  const me = owner.toLowerCase();
  const groups = new Map<string, Group>();
  const group = (row: EtherscanRow): Group | null => {
    if (!row.hash || !row.blockNumber || !row.timeStamp) return null;
    const hash = row.hash.toLowerCase();
    let entry = groups.get(hash);
    if (!entry) {
      entry = { hash, block: Number(row.blockNumber), time: Number(row.timeStamp) * 1000, normal: null, transfers: [], internalTargets: [], internalFailed: false };
      groups.set(hash, entry);
    }
    return entry;
  };
  for (const row of rows.txlist) {
    const entry = group(row);
    if (!entry) continue;
    entry.normal = row;
    const value = nativeTransfer(network, row);
    if (value) entry.transfers.push(value);
  }
  for (const row of rows.tokentx) group(row)?.transfers.push(tokenTransfer(row));
  for (const row of rows.txlistinternal) {
    const entry = group(row);
    if (!entry) continue;
    if (row.isError === "1") entry.internalFailed = true;
    else {
      const value = nativeTransfer(network, row);
      if (value) entry.transfers.push(value);
    }
    if (row.to) entry.internalTargets.push(lower(row.to));
  }
  return [...groups.values()]
    .map((entry): RawTx => {
      const normal = entry.normal;
      const sent = normal !== null && lower(normal.from) === me;
      const failed = normal !== null && (normal.isError === "1" || normal.txreceipt_status === "0");
      const fee = sent && normal.gasUsed && normal.gasPrice ? fromBaseUnits(BigInt(normal.gasUsed) * BigInt(normal.gasPrice), CHAINS[network].nativeAsset.decimals) : null;
      const method = normal?.functionName ? normal.functionName.split("(")[0]! : normal?.methodId && normal.methodId !== "0x" ? normal.methodId : null;
      return {
        network,
        account,
        owner: me,
        hash: entry.hash,
        time: entry.time,
        block: entry.block,
        status: failed ? "failed" : "success",
        from: normal ? lower(normal.from) : null,
        to: normal?.to ? lower(normal.to) : null,
        method,
        transfers: entry.transfers.filter((transfer) => transfer.from === me || transfer.to === me),
        fee,
        feeKnown: normal !== null,
        programs: [...new Set([...(normal?.to ? [lower(normal.to)] : []), ...entry.internalTargets])],
        hint: null,
        source: "etherscan",
      };
    })
    .sort((a, b) => b.time - a.time || (b.block ?? 0) - (a.block ?? 0) || a.hash.localeCompare(b.hash));
}

/** Keeps the transactions every list fully covered (see the module comment) and drops already listed hashes. */
export function completeEvmPage(txs: readonly RawTx[], lists: readonly (readonly { block: number }[])[], size: number, cursor: AccountCursor | undefined): ProviderPage {
  const skip = new Set(cursor?.skip ?? []);
  const fresh = txs.filter((tx) => !(tx.block === cursor?.block && skip.has(tx.hash)));
  const full = lists.filter((rows) => rows.length >= size);
  if (full.length === 0) return { txs: fresh, more: false };
  // The lowest block every full list reached: rows at it may still miss transfers from the next page.
  const floor = Math.max(...full.map((rows) => Math.min(...rows.map((row) => row.block))));
  const above = fresh.filter((tx) => (tx.block ?? 0) > floor);
  // A single block holding a whole page: list it as it is rather than stall.
  return { txs: above.length > 0 ? above : fresh, more: true };
}

export const etherscanProvider: HistoryProvider = {
  id: "etherscan",
  async page(account, cursor, size): Promise<ProviderPage> {
    const key = etherscanKey();
    if (!key) throw new PlatformError("HISTORY_NOT_CONFIGURED", "ETHERSCAN_API_KEY is not set.", 503);
    const [txlist, tokentx, txlistinternal] = await Promise.all(ACTIONS.map((action) => list(action, account.network, account.address, cursor, size, key)));
    const rows = { txlist: txlist!, tokentx: tokentx!, txlistinternal: txlistinternal! };
    const txs = etherscanTransactions(account.network, account.id, account.address, rows);
    const blocks = ACTIONS.map((action) => rows[action].map((row) => ({ block: Number(row.blockNumber ?? 0) })));
    return completeEvmPage(txs, blocks, size, cursor);
  },
};
