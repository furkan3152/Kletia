/**
 * On-chain transaction history of a wallet set (`GET /v1/data/transactions`):
 * every account of the set read through its network's history provider
 * (chain/providers.ts), classified (classify.ts), priced at the time
 * (historicalPrices.ts), linked to Kletia intents and merged newest first.
 *
 * Paging across accounts: each request reads one provider page per account,
 * then up to `MAX_ROUNDS` more for the accounts that still limit the merge.
 * A row is listed only when every account that has older rows has been read
 * past it, so the merged order never skips a row; the cursor holds each
 * account's own position (after its last listed row). An account whose read
 * fails is reported in `coverage` and keeps its position for the next page.
 *
 * Kletia links: a transaction whose hash a Kletia intent step claimed shows
 * that intent (and its latest receipt) only to callers that may see it: the
 * API key that owns the intent, or a wallet session whose wallets the intent
 * was planned for. Public reads never see intent ids.
 */
import { createHash } from "node:crypto";
import {
  CHAINS,
  findAssetByAddress,
  nativeAssetId,
  parseAccountId,
  type AccountId,
  type DataTransaction,
  type DataTransactionPage,
  type DataTxCoverage,
  type DataTxQuery,
  type DataTxLeg,
  type DataWalletSet,
  type NetworkKey,
} from "@kletia/core";
import { evmClient, isEvmNetwork } from "../engine/chains/evm.js";
import { getIntentStore } from "../engine/service.js";
import { PlatformError, toPlatformError } from "../errors.js";
import { receiptStore } from "../http/receipts/store.js";
import { historyProviderFor } from "./chain/providers.js";
import { readSolanaTransaction } from "./chain/solanaRpc.js";
import type { AccountCursor, HistoryProvider, ProviderPage, RawToken, RawTx } from "./chain/types.js";
import { classifyTransaction } from "./classify.js";
import { historicalPrices, lookupKey, priceLookup, type HistoricalPrice, type PriceLookup } from "./historicalPrices.js";
import { inWalletSet } from "./wallets.js";

export const TRANSACTION_LIMITS = Object.freeze({ defaultLimit: 50, maxLimit: 100, pageSize: 50, maxRounds: 3 });
const PAGE_CACHE_TTL_MS = 60_000;
const PAGE_CACHE_ENTRIES = 500;

/** Who reads: decides which Kletia intents a row may link to. */
export type DataViewer =
  | { readonly kind: "wallet" }
  | { readonly kind: "key"; readonly keyId: string }
  | { readonly kind: "public" };

/* ----------------------------------------------------------- page cache */

const pages = new Map<string, { readonly at: number; readonly page: Promise<ProviderPage> }>();

export function resetTransactionCache(): void {
  pages.clear();
}

function cachedPage(provider: HistoryProvider, account: ReadAccount, cursor: AccountCursor | undefined): Promise<ProviderPage> {
  const key = `${provider.id}|${account.id}|${JSON.stringify(cursor ?? null)}`;
  const hit = pages.get(key);
  if (hit && Date.now() - hit.at < PAGE_CACHE_TTL_MS) return hit.page;
  const page = provider.page(account, cursor, TRANSACTION_LIMITS.pageSize);
  pages.delete(key);
  pages.set(key, { at: Date.now(), page });
  page.catch(() => pages.delete(key));
  while (pages.size > PAGE_CACHE_ENTRIES) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) break;
    pages.delete(oldest);
  }
  return page;
}

/* --------------------------------------------------------------- cursor */

interface CursorBody {
  readonly v: 1;
  /** Hash of the wallet set and filters the cursor was issued for. */
  readonly k: string;
  /** Position per account; null: the account has no older rows. */
  readonly a: Readonly<Record<string, AccountCursor | null>>;
}

function cursorScope(set: DataWalletSet, query: DataTxQuery): string {
  const filters = [query.network, query.kind, query.asset, query.protocol, query.from, query.to, query.kletiaOnly ? "1" : ""].join("|");
  return createHash("sha256").update(`${set.accounts.join(",")}#${filters}`).digest("hex").slice(0, 16);
}

const invalidCursor = () => new PlatformError("INVALID_REQUEST", "cursor is not a cursor of this listing (same wallets and filters).", 400, [{ path: "cursor", message: "Unknown cursor." }]);

function decodeCursor(raw: string | undefined, scope: string): CursorBody["a"] {
  if (!raw) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const parsed = body as Partial<CursorBody> | null;
  if (!parsed || parsed.v !== 1 || parsed.k !== scope || typeof parsed.a !== "object" || parsed.a === null) throw invalidCursor();
  for (const position of Object.values(parsed.a)) {
    if (position === null) continue;
    const valid = typeof position === "object"
      && (position.block === undefined || Number.isSafeInteger(position.block))
      && (position.before === undefined || (typeof position.before === "string" && position.before.length <= 120))
      && (position.skip === undefined || (Array.isArray(position.skip) && position.skip.length <= 200 && position.skip.every((hash) => typeof hash === "string" && hash.length <= 120)));
    if (!valid) throw invalidCursor();
  }
  return parsed.a;
}

function encodeCursor(scope: string, positions: Record<string, AccountCursor | null>): string | null {
  if (Object.values(positions).every((position) => position === null)) return null;
  return Buffer.from(JSON.stringify({ v: 1, k: scope, a: positions } satisfies CursorBody)).toString("base64url");
}

/** The position after `rows` (newest first) were listed, continuing from `previous`. */
function positionAfter(network: NetworkKey, rows: readonly Pick<RawTx, "hash" | "block">[], previous: AccountCursor | undefined): AccountCursor | undefined {
  const last = rows[rows.length - 1];
  if (!last) return previous;
  if (CHAINS[network].vm === "svm") return { before: last.hash };
  const block = last.block ?? 0;
  const carried = previous?.block === block ? (previous.skip ?? []) : [];
  return { block, skip: [...new Set([...carried, ...rows.filter((row) => row.block === block).map((row) => row.hash)])] };
}

/* ------------------------------------------------------------ enrichment */

interface ReadAccount {
  readonly id: AccountId;
  readonly network: NetworkKey;
  readonly address: string;
}

function assetOf(network: NetworkKey, token: RawToken): DataTxLeg["asset"] {
  if (token.address === null) return { symbol: CHAINS[network].nativeAsset.symbol, address: null, decimals: CHAINS[network].nativeAsset.decimals, id: nativeAssetId(network) };
  const listed = findAssetByAddress(network, token.address);
  if (listed) return { symbol: listed.symbol, address: token.address, decimals: listed.decimals, id: listed.id };
  const symbol = token.symbol.trim().slice(0, 24) || `${token.address.slice(0, 4)}…${token.address.slice(-4)}`;
  return { symbol, address: token.address, decimals: token.decimals, id: null };
}

const roundUsd = (value: number) => Math.round(value * 100) / 100;

function valued(amount: string | null, lookup: PriceLookup, prices: ReadonlyMap<string, HistoricalPrice | null>): Pick<DataTxLeg, "usdAtTime" | "priceSource"> & { reason?: string } {
  if (lookup.coin === null) return { usdAtTime: null, priceSource: null, reason: lookup.reason };
  const price = prices.get(lookupKey(lookup) ?? "") ?? null;
  if (!price) return { usdAtTime: null, priceSource: null, reason: "No historical price was found for this time." };
  if (amount === null) return { usdAtTime: null, priceSource: null, reason: "The amount is unknown." };
  return { usdAtTime: roundUsd(Number(amount) * price.usd), priceSource: price.source };
}

/** Classifies and prices raw transactions (one historical price batch for all of them). */
export async function enrichTransactions(raws: readonly RawTx[]): Promise<DataTransaction[]> {
  const classified = raws.map((raw) => ({ raw, result: classifyTransaction(raw) }));
  const lookups: PriceLookup[] = [];
  for (const { raw, result } of classified) {
    for (const leg of result.legs) lookups.push(priceLookup(raw.network, leg.token.address, raw.time));
    if (raw.fee) lookups.push(priceLookup(raw.network, null, raw.time));
  }
  const prices = await historicalPrices(lookups);
  return classified.map(({ raw, result }): DataTransaction => {
    const legs = result.legs.map((leg): DataTxLeg => {
      const value = valued(leg.amount, priceLookup(raw.network, leg.token.address, raw.time), prices);
      return { asset: assetOf(raw.network, leg.token), amount: leg.amount, direction: leg.direction, ...value };
    });
    const feeValue = raw.fee ? valued(raw.fee, priceLookup(raw.network, null, raw.time), prices) : null;
    const opStack = raw.network === "base" || raw.network === "optimism";
    const feeReason = feeValue?.reason ?? (opStack && raw.source === "etherscan" ? "Execution fee only: the L1 data fee of this network is not included." : undefined);
    const hash = CHAINS[raw.network].vm === "evm" ? raw.hash.toLowerCase() : raw.hash;
    return {
      id: `${raw.network}:${hash}`,
      network: raw.network,
      hash,
      account: raw.account,
      time: new Date(raw.time).toISOString(),
      block: raw.block,
      kind: result.kind,
      status: raw.status,
      legs,
      fee: raw.fee && feeValue
        ? { asset: assetOf(raw.network, { symbol: "", address: null, decimals: null }), amount: raw.fee, usd: feeValue.usdAtTime, ...(feeReason ? { reason: feeReason } : {}) }
        : null,
      counterparty: result.counterparty,
      protocol: result.protocol ? { id: result.protocol.id, label: result.protocol.label, role: result.protocol.role } : null,
      method: raw.method,
      kletiaIntentId: null,
      kletiaReceiptId: null,
      source: raw.source,
      explorerUrl: CHAINS[raw.network].explorer.tx.replace("{hash}", raw.hash),
    };
  });
}

/* ---------------------------------------------------------- Kletia links */

function referenceKeyOf(tx: Pick<DataTransaction, "network" | "hash">): string {
  return `${CHAINS[tx.network].id}:${tx.hash}`;
}

/** Sets `kletiaIntentId` / `kletiaReceiptId` on rows whose intent the viewer may see. */
export async function linkKletia(transactions: readonly DataTransaction[], viewer: DataViewer, set: Pick<DataWalletSet, "evm" | "solana">): Promise<DataTransaction[]> {
  const store = getIntentStore();
  if (viewer.kind === "public" || transactions.length === 0 || !store.findReferences) return [...transactions];
  const claims = await store.findReferences(transactions.map(referenceKeyOf)).catch(() => new Map<string, { intentId: string }>());
  const visible = new Map<string, Promise<boolean>>();
  const mayView = (intentId: string) => {
    let check = visible.get(intentId);
    if (!check) {
      check = viewer.kind === "key"
        ? store.ownerOf(intentId).then((owner) => owner === viewer.keyId)
        : store.get(intentId).then((intent) => intent !== null && intent.request.accounts.some((account) => {
            const parsed = parseAccountId(account);
            return parsed !== null && inWalletSet(set, parsed.address);
          }));
      check = check.catch(() => false);
      visible.set(intentId, check);
    }
    return check;
  };
  return Promise.all(transactions.map(async (tx) => {
    const claim = claims.get(referenceKeyOf(tx));
    if (!claim || !(await mayView(claim.intentId))) return tx;
    const receipt = await receiptStore().latest(claim.intentId).catch(() => null);
    return { ...tx, kletiaIntentId: claim.intentId, kletiaReceiptId: receipt?.id ?? null };
  }));
}

/* --------------------------------------------------------------- filters */

export function matchesQuery(tx: DataTransaction, query: DataTxQuery): boolean {
  if (query.kind && tx.kind !== query.kind) return false;
  if (query.kletiaOnly && tx.kletiaIntentId === null) return false;
  if (query.from && tx.time < query.from) return false;
  if (query.to && tx.time > query.to) return false;
  if (query.protocol) {
    const wanted = query.protocol.toLowerCase();
    if (!tx.protocol || (tx.protocol.id?.toLowerCase() !== wanted && tx.protocol.label.toLowerCase() !== wanted)) return false;
  }
  if (query.asset) {
    const wanted = query.asset.toLowerCase();
    const assets = [...tx.legs.map((leg) => leg.asset), ...(tx.fee ? [tx.fee.asset] : [])];
    if (!assets.some((asset) => asset.symbol.toLowerCase() === wanted || asset.address?.toLowerCase() === wanted)) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- read */

interface AccountState {
  readonly account: ReadAccount;
  readonly provider: HistoryProvider;
  readonly start: AccountCursor | undefined;
  next: AccountCursor | undefined;
  rows: RawTx[];
  more: boolean;
  failed: boolean;
}

function readAccounts(set: DataWalletSet, network: NetworkKey | undefined): ReadAccount[] {
  return set.accounts.flatMap((id) => {
    const parsed = parseAccountId(id);
    if (!parsed || (network && parsed.chain.key !== network)) return [];
    return [{ id, network: parsed.chain.key, address: parsed.address }];
  });
}

async function fetchRound(states: readonly AccountState[], coverage: Map<AccountId, DataTxCoverage>, fromMs: number | null): Promise<void> {
  await Promise.all(states.map(async (state) => {
    try {
      const page = await cachedPage(state.provider, state.account, state.next);
      state.rows.push(...page.txs);
      state.next = positionAfter(state.account.network, page.txs, state.next);
      state.more = page.more && page.txs.length > 0 && !(fromMs !== null && page.txs.some((tx) => tx.time < fromMs));
    } catch (error) {
      const platform = toPlatformError(error);
      state.failed = true;
      state.more = false;
      coverage.set(state.account.id, { account: state.account.id, network: state.account.network, provider: state.provider.id, status: "failed", reason: `${platform.code}: ${platform.message}` });
    }
  }));
}

/** The time every account with more rows has been read past (rows at or after it are complete). */
function boundaryOf(states: readonly AccountState[]): number {
  const limits = states.filter((state) => state.more && !state.failed).map((state) => Math.min(...state.rows.map((row) => row.time)));
  return limits.length === 0 ? -Infinity : Math.max(...limits);
}

const notFound = () => new PlatformError("DATA_TRANSACTION_NOT_FOUND", "No transaction with this id involves these wallets.", 404);

/** Where an EVM transaction landed (the network's RPC), to read the address's history at that block. */
async function rpcBlockOf(network: NetworkKey, hash: string): Promise<number | null> {
  if (!isEvmNetwork(network)) return null;
  const tx = await evmClient(network).getTransaction({ hash: hash as `0x${string}` }).catch(() => null);
  return tx?.blockNumber === null || tx?.blockNumber === undefined ? null : Number(tx.blockNumber);
}

let evmBlockOf: (network: NetworkKey, hash: string) => Promise<number | null> = rpcBlockOf;

/** Replaces the block lookup (tests); null restores the RPC one. */
export function configureEvmBlockLookup(lookup: typeof evmBlockOf | null): void {
  evmBlockOf = lookup ?? rpcBlockOf;
}

/**
 * One transaction (`<network>:<hash>`) of the set: Solana by signature on
 * plain RPC, EVM by reading the address's history at the transaction's block.
 */
export async function readTransaction(set: DataWalletSet, id: string, viewer: DataViewer): Promise<DataTransaction> {
  const colon = id.indexOf(":");
  const network = id.slice(0, colon) as NetworkKey;
  const hash = id.slice(colon + 1);
  if (colon <= 0 || !(network in CHAINS) || !/^[0-9A-Za-z]{32,100}$/u.test(hash.replace(/^0x/u, ""))) {
    throw new PlatformError("INVALID_REQUEST", "id must be <network>:<hash or signature>.", 400, [{ path: "id", message: "Invalid transaction id." }]);
  }
  const accounts = readAccounts(set, network);
  if (accounts.length === 0) throw notFound();
  const evm = CHAINS[network].vm === "evm";
  const block = evm ? await evmBlockOf(network, hash) : null;
  if (evm && block === null) throw notFound();
  for (const account of accounts) {
    let raw: RawTx | null = null;
    if (!evm) raw = await readSolanaTransaction(account, hash);
    else {
      const choice = historyProviderFor(network);
      if (!choice.provider) throw new PlatformError("HISTORY_NOT_CONFIGURED", choice.reason, 503);
      const page = await choice.provider.page(account, { block: block! }, TRANSACTION_LIMITS.pageSize);
      raw = page.txs.find((tx) => tx.hash.toLowerCase() === hash.toLowerCase()) ?? null;
    }
    const involved = raw !== null && (raw.transfers.length > 0 || (raw.from !== null && inWalletSet(set, raw.from)));
    if (raw && involved) {
      const [tx] = await linkKletia(await enrichTransactions([raw]), viewer, set);
      return tx!;
    }
  }
  throw notFound();
}

/** One page of the set's history, newest first, filtered by `query`. */
export async function readTransactionPage(
  set: DataWalletSet,
  query: DataTxQuery,
  viewer: DataViewer,
): Promise<DataTransactionPage> {
  const limit = Math.max(1, Math.min(TRANSACTION_LIMITS.maxLimit, query.limit ?? TRANSACTION_LIMITS.defaultLimit));
  const scope = cursorScope(set, query);
  const positions = decodeCursor(query.cursor, scope);
  const coverage = new Map<AccountId, DataTxCoverage>();
  const states: AccountState[] = [];
  const nextPositions: Record<string, AccountCursor | null> = {};
  for (const account of readAccounts(set, query.network)) {
    const choice = historyProviderFor(account.network);
    if (!choice.provider) {
      coverage.set(account.id, { account: account.id, network: account.network, provider: null, status: choice.status, reason: choice.reason, ...(choice.env ? { env: choice.env } : {}) });
      continue;
    }
    const position = positions[account.id];
    coverage.set(account.id, { account: account.id, network: account.network, provider: choice.provider.id, status: "ok", ...(choice.note ? { reason: choice.note } : {}) });
    if (position === null) {
      nextPositions[account.id] = null;
      continue;
    }
    states.push({ account, provider: choice.provider, start: position, next: position, rows: [], more: true, failed: false });
  }

  const fromMs = query.from ? Date.parse(query.from) : null;
  let listed: DataTransaction[] = [];
  let consumed: RawTx[] = [];
  let fetching = states;
  for (let round = 0; round < TRANSACTION_LIMITS.maxRounds && fetching.length > 0; round += 1) {
    await fetchRound(fetching, coverage, fromMs);
    const boundary = boundaryOf(states);
    const rows = states.flatMap((state) => state.rows).sort((a, b) => b.time - a.time || a.hash.localeCompare(b.hash));
    // On the last round, rows at the boundary itself are listed rather than none at all (a page of one second).
    const strict = rows.filter((row) => row.time > boundary);
    const ready = strict.length > 0 || round < TRANSACTION_LIMITS.maxRounds - 1 ? strict : rows.filter((row) => row.time >= boundary);
    const prepared = await linkKletia(await enrichTransactions(ready), viewer, set);
    listed = [];
    consumed = [];
    for (let index = 0; index < ready.length && listed.length < limit; index += 1) {
      consumed.push(ready[index]!);
      if (matchesQuery(prepared[index]!, query)) listed.push(prepared[index]!);
    }
    if (listed.length >= limit || states.every((state) => !state.more || state.failed)) break;
    // Read further only the accounts that hold the merge back.
    fetching = states.filter((state) => state.more && !state.failed && Math.min(...state.rows.map((row) => row.time)) === boundary);
  }

  for (const state of states) {
    if (state.failed) {
      nextPositions[state.account.id] = state.start ?? {};
      continue;
    }
    const mine = consumed.filter((row) => row.account === state.account.id);
    const done = !state.more && mine.length === state.rows.length;
    nextPositions[state.account.id] = done ? null : (positionAfter(state.account.network, mine, state.start) ?? state.start ?? {});
  }
  return { transactions: listed, cursor: encodeCursor(scope, nextPositions), coverage: [...coverage.values()], asOf: new Date().toISOString() };
}
