/**
 * EVM history through Alchemy's Transfers API (`alchemy_getAssetTransfers`,
 * docs.alchemy.com/reference/alchemy-getassettransfers), the alternative
 * when only ALCHEMY_API_KEY is set: native, internal (Ethereum and Polygon
 * only) and ERC-20 transfers from and to the address, newest first, grouped
 * by hash. Transfers carry no fee, method or status: fees stay unknown,
 * failed transactions (which move nothing) are not listed, and protocols are
 * matched on the transfers' counterparties.
 */
import { CHAINS, fromBaseUnits, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { completeEvmPage } from "./etherscan.js";
import { historyFetch } from "./fetch.js";
import type { HistoryProvider, ProviderPage, RawTransfer, RawTx } from "./types.js";

const HOSTS: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  optimism: "opt-mainnet",
  polygon: "polygon-mainnet",
  "arbitrum-sepolia": "arb-sepolia",
});
const INTERNAL: ReadonlySet<NetworkKey> = new Set(["ethereum", "polygon"]);

interface AlchemyTransfer {
  readonly blockNum?: string;
  readonly hash?: string;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly asset?: string | null;
  readonly category?: string;
  readonly rawContract?: { readonly value?: string | null; readonly address?: string | null; readonly decimal?: string | null };
  readonly metadata?: { readonly blockTimestamp?: string };
}

export function alchemyKey(): string | null {
  return process.env.ALCHEMY_API_KEY?.trim() || null;
}

export function alchemyServes(network: NetworkKey): boolean {
  return HOSTS[network] !== undefined;
}

async function transfers(network: NetworkKey, side: "fromAddress" | "toAddress", address: string, toBlock: number | undefined, size: number, key: string): Promise<AlchemyTransfer[]> {
  const params = {
    [side]: address,
    category: ["external", "erc20", ...(INTERNAL.has(network) ? ["internal"] : [])],
    order: "desc",
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: `0x${size.toString(16)}`,
    toBlock: toBlock === undefined ? "latest" : `0x${toBlock.toString(16)}`,
  };
  const body = (await historyFetch(`https://${HOSTS[network]}.g.alchemy.com/v2/${key}`, {
    provider: "Alchemy",
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [params] },
  })) as { result?: { transfers?: unknown }; error?: { message?: unknown } } | null;
  if (body?.error) throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", `Alchemy refused the read: ${String(body.error.message ?? "unknown error").slice(0, 160)}`, 502);
  const list = body?.result?.transfers;
  if (!Array.isArray(list)) throw new PlatformError("HISTORY_PROVIDER_UNAVAILABLE", "Alchemy returned an invalid response.", 502);
  return list as AlchemyTransfer[];
}

function transferOf(network: NetworkKey, row: AlchemyTransfer): RawTransfer | null {
  const raw = row.rawContract?.value;
  if (!raw) return null;
  const native = row.category === "external" || row.category === "internal";
  const decimals = native ? CHAINS[network].nativeAsset.decimals : row.rawContract?.decimal ? Number.parseInt(row.rawContract.decimal, 16) : null;
  return {
    token: native
      ? { symbol: CHAINS[network].nativeAsset.symbol, address: null, decimals }
      : { symbol: row.asset || "Unknown token", address: (row.rawContract?.address ?? "").toLowerCase() || null, decimals },
    from: row.from?.toLowerCase() ?? null,
    to: row.to?.toLowerCase() ?? null,
    amount: decimals === null || !Number.isFinite(decimals) ? null : fromBaseUnits(BigInt(raw), decimals),
  };
}

/** Groups transfers by hash into raw transactions of `owner`. */
export function alchemyTransactions(network: NetworkKey, account: RawTx["account"], owner: string, rows: readonly AlchemyTransfer[]): RawTx[] {
  const me = owner.toLowerCase();
  const groups = new Map<string, { block: number; time: number; transfers: RawTransfer[] }>();
  for (const row of rows) {
    if (!row.hash || !row.blockNum || !row.metadata?.blockTimestamp) continue;
    const hash = row.hash.toLowerCase();
    const entry = groups.get(hash) ?? { block: Number.parseInt(row.blockNum, 16), time: Date.parse(row.metadata.blockTimestamp), transfers: [] };
    groups.set(hash, entry);
    const transfer = transferOf(network, row);
    // The same transfer comes back from both the from- and the to-side query when it is a self-transfer.
    if (transfer && !entry.transfers.some((seen) => JSON.stringify(seen) === JSON.stringify(transfer))) entry.transfers.push(transfer);
  }
  return [...groups.entries()]
    .map(([hash, entry]): RawTx => {
      const others = entry.transfers.flatMap((transfer) => [transfer.from, transfer.to]).filter((address): address is string => address !== null && address !== me);
      const sentFirst = entry.transfers.find((transfer) => transfer.from === me);
      return {
        network,
        account,
        owner: me,
        hash,
        time: entry.time,
        block: entry.block,
        status: "success",
        from: sentFirst ? me : (entry.transfers[0]?.from ?? null),
        to: sentFirst?.to ?? null,
        method: null,
        transfers: entry.transfers,
        fee: null,
        feeKnown: false,
        programs: [...new Set(others)],
        hint: null,
        source: "alchemy",
      };
    })
    .sort((a, b) => b.time - a.time || a.hash.localeCompare(b.hash));
}

export const alchemyProvider: HistoryProvider = {
  id: "alchemy",
  async page(account, cursor, size): Promise<ProviderPage> {
    const key = alchemyKey();
    if (!key) throw new PlatformError("HISTORY_NOT_CONFIGURED", "ALCHEMY_API_KEY is not set.", 503);
    const [sent, received] = await Promise.all([
      transfers(account.network, "fromAddress", account.address, cursor?.block, size, key),
      transfers(account.network, "toAddress", account.address, cursor?.block, size, key),
    ]);
    const txs = alchemyTransactions(account.network, account.id, account.address, [...sent, ...received]);
    const blocks = [sent, received].map((rows) => rows.map((row) => ({ block: Number.parseInt(row.blockNum ?? "0x0", 16) })));
    return completeEvmPage(txs, blocks, size, cursor);
  },
};
