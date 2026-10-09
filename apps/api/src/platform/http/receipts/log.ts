/**
 * Transparency log (receipts design §5.8, §7.4).
 *
 * - Every KLETIA_RECEIPT_LOG_SECONDS (default 3,600) the log job closes a batch
 *   of every receipt not yet in one, ordered by `(issued_at, id)`, at most
 *   65,536 leaves: an RFC 6962 Merkle tree over the receipt digests, and a
 *   `kletia.receipt-log/v1` document chained to the previous batch
 *   (`previous` = its batch digest) and signed like receipts over
 *   `"kletia.receipt-log.v1:" + batchDigest`. Every leaf's audit path is
 *   stored with it, so inclusion proofs are served without rebuilding trees.
 * - Anchoring is an operator opt-in (`scripts/receipts/anchorLog.ts`): anyone
 *   may call `EAS.timestamp(batchDigest)` on Base. The API never sends
 *   anything: it only reads `getTimestamp(batchDigest)` (watcher, every 10
 *   minutes, for recent unanchored batches) and checks an operator-reported
 *   transaction before recording it (a successful call to the EAS predeploy
 *   with calldata `0x4d003070 ‖ batchDigest`, timestamp equal to its block's).
 */
import {
  bytesToHex,
  merkleLeafHash,
  merkleNodeHash,
  RECEIPT_LOG_SPEC_VERSION,
  receiptLogBatchDigest,
  receiptLogSigningInput,
  type ReceiptLogBatch,
  type RpcTransport,
} from "@kletia/core";
import { keccak256, toHex } from "viem";
import { PlatformError } from "../../errors.js";
import { evmClient } from "../../engine/chains/evm.js";
import { EAS_ADDRESS, EAS_CHAIN } from "./eas.js";
import { activeReceiptSigner } from "./signer.js";
import { MAX_BATCH_LEAVES, receiptStore, type BatchAnchor, type SealedBatch, type StoredBatch } from "./store.js";

export const EAS_TIMESTAMP_SELECTOR = "0x4d003070";
export const EAS_GET_TIMESTAMP_SELECTOR = "0xd45c4435";
/** topic0 of `Timestamped(bytes32 indexed data, uint64 indexed timestamp)`. */
export const EAS_TIMESTAMPED_TOPIC = keccak256(toHex("Timestamped(bytes32,uint64)"));
export const DEFAULT_LOG_SECONDS = 3_600;
export const ANCHOR_WATCH_INTERVAL_MS = 10 * 60_000;
const ANCHOR_WATCH_BATCHES = 24;
const ANCHOR_WATCH_WINDOW_MS = 7 * 86_400_000;
const BASE_CHAIN_ID_HEX = "0x2105";
const TX_HASH = /^0x[0-9a-f]{64}$/u;

/* ------------------------------------------------------------------ merkle */

/**
 * Root and every leaf's RFC 6962 audit path in O(n log n) (core's
 * `merkleAuditPath` rebuilds subtrees per leaf, which is quadratic for a
 * full batch). Paths list the closest sibling first, like core's.
 */
export function merkleTree(leaves: readonly string[]): { readonly root: string; readonly paths: string[][] } {
  if (leaves.length === 0) throw new Error("A batch needs at least one leaf.");
  const hashes = leaves.map((leaf) => merkleLeafHash(leaf));
  const build = (lo: number, hi: number): { root: Uint8Array; paths: Uint8Array[][] } => {
    if (hi - lo === 1) return { root: hashes[lo] as Uint8Array, paths: [[]] };
    let k = 1;
    while (k * 2 < hi - lo) k *= 2;
    const left = build(lo, lo + k);
    const right = build(lo + k, hi);
    for (const path of left.paths) path.push(right.root);
    for (const path of right.paths) path.push(left.root);
    return { root: merkleNodeHash(left.root, right.root), paths: [...left.paths, ...right.paths] };
  };
  const tree = build(0, hashes.length);
  return { root: bytesToHex(tree.root), paths: tree.paths.map((path) => path.map((node) => bytesToHex(node))) };
}

function utcDay(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Builds and signs the batch document for the selected leaves (the store calls it inside its transaction). */
async function sealBatch(leaves: readonly { readonly id: string; readonly digest: string }[], previous: StoredBatch | null, now: number): Promise<SealedBatch> {
  const signer = activeReceiptSigner();
  if (!signer) throw new Error("No receipt signing key: the log cannot be signed.");
  const tree = merkleTree(leaves.map((leaf) => leaf.digest));
  const document: ReceiptLogBatch = {
    spec: RECEIPT_LOG_SPEC_VERSION,
    seq: (previous?.seq ?? 0) + 1,
    size: leaves.length,
    root: tree.root,
    previous: previous?.batchDigest ?? null,
    closedOn: utcDay(now),
  };
  const batchDigest = receiptLogBatchDigest(document);
  const signature = Buffer.from(await signer.sign(new TextEncoder().encode(receiptLogSigningInput(batchDigest)))).toString("base64url");
  return { document, batchDigest, signature, paths: tree.paths };
}

/** Closes one batch now (the log job; tests). Null when nothing is unbatched or no key can sign. */
export async function closeReceiptBatch(now = Date.now()): Promise<StoredBatch | null> {
  if (!activeReceiptSigner()) return null;
  return receiptStore().closeBatch((leaves, previous) => sealBatch(leaves, previous, now), MAX_BATCH_LEAVES);
}

/* ----------------------------------------------------------------- anchors */

let baseTransport: RpcTransport | null = null;

/** Replaces the Base JSON-RPC transport used for anchor reads (tests); null restores the engine's client. */
export function configureAnchorTransport(transport: RpcTransport | null): void {
  baseTransport = transport;
}

function base(): RpcTransport {
  if (baseTransport) return baseTransport;
  const client = evmClient("base");
  return async (method, params) => client.request({ method: method as never, params: params as never });
}

function quantity(value: unknown): bigint | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/u.test(value) ? BigInt(value) : null;
}

/** EAS.getTimestamp(batchDigest) on Base (eth_call, read-only): 0 when not anchored. */
export async function readEasTimestamp(batchDigest: string, rpc: RpcTransport = base()): Promise<number> {
  const result = await rpc("eth_call", [{ to: EAS_ADDRESS, data: `${EAS_GET_TIMESTAMP_SELECTOR}${batchDigest}` }, "latest"]);
  const value = quantity(result);
  if (value === null) throw new Error("getTimestamp returned no value.");
  return Number(value);
}

function anchorInvalid(message: string): PlatformError {
  return new PlatformError("RECEIPT_ANCHOR_INVALID", message, 422);
}

/**
 * Checks an operator-reported anchoring transaction on Base and records it:
 * it must be a successful call from anyone to the EAS predeploy with calldata
 * `timestamp(batchDigest)`, and `getTimestamp(batchDigest)` must equal its
 * block's timestamp. Read-only.
 */
export async function reportAnchor(seq: number, tx: string, rpc: RpcTransport = base(), now = Date.now()): Promise<StoredBatch> {
  const batch = await receiptStore().batch(seq);
  if (!batch) throw new PlatformError("RECEIPT_LOG_NOT_FOUND", `Log batch ${seq} does not exist.`, 404);
  if (batch.anchor) throw new PlatformError("RECEIPT_ANCHOR_EXISTS", `Log batch ${seq} is already anchored by ${batch.anchor.tx}.`, 409);
  const hash = tx.toLowerCase();
  if (!TX_HASH.test(hash)) throw anchorInvalid("tx must be a Base transaction hash (0x + 64 hex).");
  let transaction: { to?: unknown; input?: unknown; chainId?: unknown; blockNumber?: unknown } | null;
  let receipt: { status?: unknown; to?: unknown; blockNumber?: unknown } | null;
  try {
    [transaction, receipt] = (await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])])) as [typeof transaction, typeof receipt];
  } catch {
    throw new PlatformError("RPC_UNAVAILABLE", "Base could not be read to check the anchoring transaction. Retry shortly.", 502);
  }
  if (!transaction || !receipt) throw anchorInvalid("The transaction is not on Base (or not yet visible). Report it once it is included.");
  if (typeof transaction.chainId === "string" && transaction.chainId.toLowerCase() !== BASE_CHAIN_ID_HEX) throw anchorInvalid("The transaction is not a Base transaction.");
  if (typeof transaction.to !== "string" || transaction.to.toLowerCase() !== EAS_ADDRESS.toLowerCase()) throw anchorInvalid("The transaction does not call the EAS contract on Base.");
  if (typeof transaction.input !== "string" || transaction.input.toLowerCase() !== `${EAS_TIMESTAMP_SELECTOR}${batch.batchDigest}`) {
    throw anchorInvalid("The transaction does not call timestamp(batchDigest) for this batch.");
  }
  if (receipt.status !== "0x1") throw anchorInvalid("The transaction reverted.");
  let timestamp: number;
  let blockTimestamp: bigint | null;
  try {
    const block = (await rpc("eth_getBlockByNumber", [receipt.blockNumber, false])) as { timestamp?: unknown } | null;
    blockTimestamp = quantity(block?.timestamp);
    timestamp = await readEasTimestamp(batch.batchDigest, rpc);
  } catch {
    throw new PlatformError("RPC_UNAVAILABLE", "Base could not be read to check the anchoring transaction. Retry shortly.", 502);
  }
  if (timestamp === 0 || blockTimestamp === null || BigInt(timestamp) !== blockTimestamp) {
    throw anchorInvalid("EAS has no timestamp for this batch from that transaction.");
  }
  const anchor: BatchAnchor = { chain: EAS_CHAIN, contract: EAS_ADDRESS, tx: hash, timestamp };
  const recorded = await receiptStore().recordAnchor(seq, anchor, new Date(now).toISOString());
  if (recorded === "exists") throw new PlatformError("RECEIPT_ANCHOR_EXISTS", `Log batch ${seq} is already anchored.`, 409);
  if (recorded === "missing") throw new PlatformError("RECEIPT_LOG_NOT_FOUND", `Log batch ${seq} does not exist.`, 404);
  return { ...batch, anchor, anchoredAt: new Date(now).toISOString() };
}

/** The Base block with exactly `timestamp` (2-second blocks; a few reads), or null. */
async function blockAt(timestamp: number, rpc: RpcTransport): Promise<bigint | null> {
  const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as { number?: unknown; timestamp?: unknown } | null;
  let number = quantity(latest?.number);
  let time = quantity(latest?.timestamp);
  for (let round = 0; round < 6 && number !== null && time !== null; round += 1) {
    const delta = time - BigInt(timestamp);
    if (delta === 0n) return number;
    const step = delta / 2n === 0n ? (delta > 0n ? 1n : -1n) : delta / 2n;
    number -= step;
    if (number < 0n) return null;
    const block = (await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false])) as { timestamp?: unknown } | null;
    time = quantity(block?.timestamp);
  }
  return null;
}

/** The transaction that timestamped `batchDigest` at `timestamp` (one-block eth_getLogs), or null. */
async function anchoringTransaction(batchDigest: string, timestamp: number, rpc: RpcTransport): Promise<string | null> {
  const block = await blockAt(timestamp, rpc);
  if (block === null) return null;
  const tag = `0x${block.toString(16)}`;
  const logs = (await rpc("eth_getLogs", [{ address: EAS_ADDRESS, fromBlock: tag, toBlock: tag, topics: [EAS_TIMESTAMPED_TOPIC, `0x${batchDigest}`] }])) as { transactionHash?: unknown }[] | null;
  const hash = Array.isArray(logs) ? logs.find((log) => typeof log.transactionHash === "string")?.transactionHash : undefined;
  return typeof hash === "string" && TX_HASH.test(hash.toLowerCase()) ? hash.toLowerCase() : null;
}

/** One watcher round: records anchors of recent unanchored batches that someone timestamped. Returns how many. */
export async function watchAnchors(rpc: RpcTransport = base(), now = Date.now()): Promise<number> {
  const batches = await receiptStore().batches({ limit: ANCHOR_WATCH_BATCHES, unanchored: true, since: new Date(now - ANCHOR_WATCH_WINDOW_MS).toISOString() });
  let recorded = 0;
  for (const batch of batches) {
    try {
      const timestamp = await readEasTimestamp(batch.batchDigest, rpc);
      if (timestamp === 0) continue;
      const tx = await anchoringTransaction(batch.batchDigest, timestamp, rpc);
      if (!tx) {
        console.warn(`[platform] receipt log batch ${batch.seq} is timestamped on Base (${timestamp}) but its transaction was not found yet.`);
        continue;
      }
      const result = await receiptStore().recordAnchor(batch.seq, { chain: EAS_CHAIN, contract: EAS_ADDRESS, tx, timestamp }, new Date(now).toISOString());
      if (result === "recorded") recorded += 1;
    } catch (error) {
      console.warn(`[platform] receipt anchor watch of batch ${batch.seq} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return recorded;
}

/* ---------------------------------------------------------------- schedule */

export function receiptLogIntervalMs(): number {
  const raw = Number(process.env.KLETIA_RECEIPT_LOG_SECONDS?.trim() ?? "");
  return (Number.isSafeInteger(raw) && raw >= 60 && raw <= 86_400 ? raw : DEFAULT_LOG_SECONDS) * 1000;
}

/** Starts the hourly log close and the 10-minute anchor watcher. Returns a stop function. */
export function startReceiptLog(options: { readonly intervalMs?: number; readonly watchMs?: number } = {}): () => void {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    closeReceiptBatch()
      .then((batch) => {
        if (batch) console.info(`[platform] receipt log batch ${batch.seq} closed with ${batch.size} receipt(s).`);
      })
      .catch((error: unknown) => console.error("[platform] receipt log close failed:", error instanceof Error ? error.message : error))
      .finally(() => {
        closing = false;
      });
  };
  let watching = false;
  const watch = () => {
    if (watching) return;
    watching = true;
    watchAnchors()
      .catch((error: unknown) => console.warn("[platform] receipt anchor watch failed:", error instanceof Error ? error.message : error))
      .finally(() => {
        watching = false;
      });
  };
  const closer = setInterval(close, options.intervalMs ?? receiptLogIntervalMs());
  const watcher = setInterval(watch, options.watchMs ?? ANCHOR_WATCH_INTERVAL_MS);
  closer.unref?.();
  watcher.unref?.();
  return () => {
    clearInterval(closer);
    clearInterval(watcher);
  };
}
