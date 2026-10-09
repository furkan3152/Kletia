/**
 * Receipt anchors (receipts design §4.4, §5.5): the on-chain facts a receipt
 * carries for each reference, and one transport-agnostic reader per VM used
 * by the issuer (over the engine's RPC clients) and by verifiers (over public
 * RPCs). Core performs no I/O itself: callers pass an `RpcTransport`.
 *
 * A reader never reports "does not exist": a `null` result, an RPC error, a
 * malformed response or `-32015` (client too old for the transaction version)
 * is an `AnchorUnavailableError`, because public endpoints prune history.
 */
import { CHAINS, type CaipChainId } from "./chains.js";
import { canonicalJson } from "./contracts.js";
import { hexToBytes, sha256Hex } from "./hash.js";
import { receiptJcs } from "./receiptProfile.js";
import { isSolanaAddress, isSolanaSignature } from "./caip.js";

/** JSON-RPC call: resolves with `result`, throws on transport or RPC errors (keep `code` on the error when known). */
export type RpcTransport = (method: string, params: readonly unknown[]) => Promise<unknown>;

export type AnchorRole = "origin" | "fill";

export interface EvmAnchorTransfer {
  readonly logIndex: number;
  /** Lower-case token address (the log emitter). */
  readonly token: string;
  readonly from: string;
  readonly to: string;
  /** Base units, decimal. */
  readonly amount: string;
}

export interface EvmAnchor {
  readonly vm: "evm";
  readonly role: AnchorRole;
  /** CAIP-2, e.g. "eip155:8453". */
  readonly chain: CaipChainId;
  /** Lower-case 0x transaction hash. */
  readonly tx: string;
  /** Decimal. */
  readonly blockNumber: string;
  readonly blockHash: string;
  /** Unix seconds. */
  readonly blockTimestamp: number;
  readonly transactionIndex: number;
  readonly status: "success" | "reverted";
  readonly from: string;
  /** Lower-case target; "" for a contract creation. */
  readonly to: string;
  readonly valueWei: string;
  /** hex sha256 of the calldata bytes. */
  readonly inputDigest: string;
  /** hex sha256(JCS(all logs as { address, data, logIndex, topics }, lower-case, receipt order)). */
  readonly logsDigest: string;
  readonly logCount: number;
  /** Addresses whose ERC-20 movements are listed (step parties on this chain), lower-case, sorted. */
  readonly watch: readonly string[];
  /** Every 3-topic ERC-20 Transfer log with `from` or `to` in `watch`. */
  readonly transfers: readonly EvmAnchorTransfer[];
}

export interface SvmAnchor {
  readonly vm: "svm";
  readonly role: AnchorRole;
  /** CAIP-2, e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp". */
  readonly chain: CaipChainId;
  readonly signature: string;
  /** Decimal. */
  readonly slot: string;
  readonly blockhash: string;
  readonly blockTime: number;
  readonly transactionIndex: number | null;
  /** Transaction message version; version 1 transactions are live on mainnet. */
  readonly version: "legacy" | "0" | "1";
  /** JSON text of `meta.err`, or null. */
  readonly err: string | null;
  readonly feePayer: string;
  /** Lamports, decimal. */
  readonly fee: string;
  /** Top-level program ids, sorted, unique. */
  readonly programs: readonly string[];
  readonly watch: readonly string[];
  /** Per (owner, mint), owner in `watch`, zero deltas dropped, sorted by owner + mint. */
  readonly tokenDeltas: readonly { readonly owner: string; readonly mint: string; readonly delta: string }[];
  /** Accounts of the transaction that are in `watch`, in account-key order. */
  readonly lamportDeltas: readonly { readonly account: string; readonly delta: string }[];
}

export type ReceiptAnchor = EvmAnchor | SvmAnchor;

export type AnchorUnavailableReason = "not_found" | "client_too_old" | "rpc_error" | "malformed" | "wrong_chain";

/** The source could not show the anchor. Never evidence that it does not exist. */
export class AnchorUnavailableError extends Error {
  readonly code = "ANCHOR_UNAVAILABLE" as const;
  readonly reason: AnchorUnavailableReason;

  constructor(reason: AnchorUnavailableReason, message: string) {
    super(message);
    this.name = "AnchorUnavailableError";
    this.reason = reason;
  }
}

export function isAnchorUnavailable(error: unknown): error is AnchorUnavailableError {
  return error instanceof AnchorUnavailableError;
}

/** Topic 0 of `Transfer(address,address,uint256)`. */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Highest Solana transaction version the readers understand (sent as `maxSupportedTransactionVersion`). */
export const RECEIPT_SOLANA_MAX_TRANSACTION_VERSION = 1;

/** True for the RPC error "Transaction version (N) is not supported by the requesting client" (-32015). */
export function isUnsupportedSolanaVersionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (record.code === -32015) return true;
  const message = typeof record.message === "string" ? record.message : "";
  if (/-32015|not supported by the requesting client/u.test(message)) return true;
  return record.cause !== undefined && record.cause !== error ? isUnsupportedSolanaVersionError(record.cause) : false;
}

async function call(rpc: RpcTransport, method: string, params: readonly unknown[]): Promise<unknown> {
  let result: unknown;
  try {
    result = await rpc(method, params);
  } catch (error) {
    if (isUnsupportedSolanaVersionError(error)) {
      throw new AnchorUnavailableError("client_too_old", `${method}: the endpoint cannot return this transaction version.`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AnchorUnavailableError("rpc_error", `${method}: ${message.slice(0, 200)}`);
  }
  if (result === null || result === undefined) throw new AnchorUnavailableError("not_found", `${method} returned no data (pruned or unknown to this source).`);
  return result;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/u;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

function malformed(what: string): never {
  throw new AnchorUnavailableError("malformed", `Malformed RPC response: ${what}.`);
}

function quantity(value: unknown, what: string): bigint {
  if (typeof value === "string" && HEX_QUANTITY.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return malformed(what);
}

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) malformed(what);
  return Number(value);
}

function lowerHash(value: unknown, what: string): string {
  if (typeof value !== "string" || !HASH.test(value)) return malformed(what);
  return value.toLowerCase();
}

function lowerAddress(value: unknown, what: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) return malformed(what);
  return value.toLowerCase();
}

function evmChainId(chain: CaipChainId): bigint {
  const [namespace, reference = ""] = chain.split(":");
  if (namespace !== "eip155" || !/^\d+$/u.test(reference)) throw new Error(`${chain} is not an EVM chain.`);
  return BigInt(reference);
}

function normalizeWatch(watch: readonly string[], evm: boolean): string[] {
  return [...new Set(watch.map((entry) => (evm ? entry.toLowerCase() : entry)))].sort();
}

/**
 * Reads one EVM transaction as an anchor (`eth_getTransactionByHash`,
 * `eth_getTransactionReceipt`, `eth_getBlockByNumber`). Finality is not
 * checked here (the issuer gates on it; verifiers check it separately).
 */
export async function readEvmAnchor(
  rpc: RpcTransport,
  input: { readonly chain: CaipChainId; readonly tx: string; readonly role: AnchorRole; readonly watch: readonly string[] },
): Promise<EvmAnchor> {
  const chainId = evmChainId(input.chain);
  if (!HASH.test(input.tx)) throw new Error("tx must be a 0x-prefixed 32-byte hash.");
  const hash = input.tx.toLowerCase();
  const [transaction, receipt] = await Promise.all([
    call(rpc, "eth_getTransactionByHash", [hash]),
    call(rpc, "eth_getTransactionReceipt", [hash]),
  ]);
  if (!isRecord(transaction) || !isRecord(receipt)) return malformed("transaction or receipt is not an object");
  if (lowerHash(transaction.hash, "transaction.hash") !== hash || lowerHash(receipt.transactionHash, "receipt.transactionHash") !== hash) {
    return malformed("the source answered for another transaction");
  }
  if (transaction.chainId !== undefined && transaction.chainId !== null && quantity(transaction.chainId, "transaction.chainId") !== chainId) {
    throw new AnchorUnavailableError("wrong_chain", `The source serves another chain than ${input.chain}.`);
  }
  const blockNumber = quantity(receipt.blockNumber, "receipt.blockNumber");
  const blockHash = lowerHash(receipt.blockHash, "receipt.blockHash");
  const block = await call(rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
  if (!isRecord(block)) return malformed("block is not an object");
  if (lowerHash(block.hash, "block.hash") !== blockHash) {
    throw new AnchorUnavailableError("not_found", "The block at this height has another hash on this source (reorg or lagging node).");
  }
  if (typeof transaction.input !== "string" || !HEX_DATA.test(transaction.input)) return malformed("transaction.input");
  if (!Array.isArray(receipt.logs)) return malformed("receipt.logs");
  const logs = receipt.logs.map((log, index) => {
    if (!isRecord(log) || !Array.isArray(log.topics) || typeof log.data !== "string" || !HEX_DATA.test(log.data)) return malformed(`receipt.logs[${index}]`);
    return {
      address: lowerAddress(log.address, `receipt.logs[${index}].address`),
      data: log.data.toLowerCase(),
      logIndex: safeNumber(quantity(log.logIndex, `receipt.logs[${index}].logIndex`), "logIndex"),
      topics: log.topics.map((topic, topicIndex) => lowerHash(topic, `receipt.logs[${index}].topics[${topicIndex}]`)),
    };
  });
  const watch = normalizeWatch(input.watch, true);
  const watched = new Set(watch);
  const transfers: EvmAnchorTransfer[] = [];
  for (const log of logs) {
    if (log.topics.length !== 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    const from = `0x${(log.topics[1] as string).slice(26)}`;
    const to = `0x${(log.topics[2] as string).slice(26)}`;
    if (!watched.has(from) && !watched.has(to)) continue;
    transfers.push({ logIndex: log.logIndex, token: log.address, from, to, amount: log.data === "0x" ? "0" : BigInt(log.data).toString() });
  }
  const status = quantity(receipt.status, "receipt.status");
  return {
    vm: "evm",
    role: input.role,
    chain: input.chain,
    tx: hash,
    blockNumber: blockNumber.toString(),
    blockHash,
    blockTimestamp: safeNumber(quantity(block.timestamp, "block.timestamp"), "block.timestamp"),
    transactionIndex: safeNumber(quantity(receipt.transactionIndex, "receipt.transactionIndex"), "transactionIndex"),
    status: status === 1n ? "success" : "reverted",
    from: lowerAddress(receipt.from, "receipt.from"),
    to: receipt.to === null || receipt.to === undefined ? "" : lowerAddress(receipt.to, "receipt.to"),
    valueWei: quantity(transaction.value, "transaction.value").toString(),
    inputDigest: sha256Hex(hexToBytes(transaction.input) as Uint8Array),
    logsDigest: sha256Hex(receiptJcs(logs)),
    logCount: logs.length,
    watch,
    transfers,
  };
}

function lamports(value: unknown, what: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
  return malformed(what);
}

/**
 * Reads one Solana transaction as an anchor (`getTransaction` with
 * `maxSupportedTransactionVersion: 1`, then `getBlock` for the blockhash).
 */
export async function readSvmAnchor(
  rpc: RpcTransport,
  input: { readonly chain: CaipChainId; readonly signature: string; readonly role: AnchorRole; readonly watch: readonly string[] },
): Promise<SvmAnchor> {
  if (!input.chain.startsWith("solana:")) throw new Error(`${input.chain} is not a Solana chain.`);
  if (!isSolanaSignature(input.signature)) throw new Error("signature must be a base58 Solana signature.");
  const transaction = await call(rpc, "getTransaction", [
    input.signature,
    { encoding: "json", maxSupportedTransactionVersion: RECEIPT_SOLANA_MAX_TRANSACTION_VERSION, commitment: "finalized" },
  ]);
  if (!isRecord(transaction) || !isRecord(transaction.meta) || !isRecord(transaction.transaction)) return malformed("transaction");
  const meta = transaction.meta;
  const message = transaction.transaction.message;
  const signatures = transaction.transaction.signatures;
  if (!isRecord(message) || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) return malformed("transaction.message");
  if (!Array.isArray(signatures) || signatures[0] !== input.signature) return malformed("the source answered for another signature");
  const slot = lamports(transaction.slot, "slot");
  const block = await call(rpc, "getBlock", [
    Number(slot),
    { transactionDetails: "none", rewards: false, commitment: "finalized", maxSupportedTransactionVersion: RECEIPT_SOLANA_MAX_TRANSACTION_VERSION },
  ]);
  if (!isRecord(block) || typeof block.blockhash !== "string" || !isSolanaAddress(block.blockhash)) return malformed("block.blockhash");
  const loaded = isRecord(meta.loadedAddresses) ? meta.loadedAddresses : {};
  const listOf = (value: unknown, what: string): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return malformed(what);
    return value as string[];
  };
  const keys = [
    ...listOf(message.accountKeys, "accountKeys"),
    ...listOf(loaded.writable, "loadedAddresses.writable"),
    ...listOf(loaded.readonly, "loadedAddresses.readonly"),
  ];
  const feePayer = keys[0];
  if (feePayer === undefined) return malformed("accountKeys is empty");
  const programs = new Set<string>();
  for (const [index, instruction] of message.instructions.entries()) {
    const programIndex = isRecord(instruction) ? instruction.programIdIndex : undefined;
    const program = typeof programIndex === "number" ? keys[programIndex] : undefined;
    if (program === undefined) return malformed(`instructions[${index}].programIdIndex`);
    programs.add(program);
  }
  const watch = normalizeWatch(input.watch, false);
  const watched = new Set(watch);
  const deltas = new Map<string, { owner: string; mint: string; delta: bigint }>();
  for (const [sign, list, what] of [[-1n, meta.preTokenBalances, "preTokenBalances"], [1n, meta.postTokenBalances, "postTokenBalances"]] as const) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return malformed(what);
    for (const balance of list) {
      if (!isRecord(balance) || typeof balance.mint !== "string" || !isRecord(balance.uiTokenAmount)) return malformed(what);
      const owner = balance.owner;
      if (typeof owner !== "string" || !watched.has(owner)) continue;
      const key = `${owner}|${balance.mint}`;
      const entry = deltas.get(key) ?? { owner, mint: balance.mint, delta: 0n };
      entry.delta += sign * lamports(balance.uiTokenAmount.amount, `${what}.uiTokenAmount.amount`);
      deltas.set(key, entry);
    }
  }
  const pre = Array.isArray(meta.preBalances) ? meta.preBalances : malformed("preBalances");
  const post = Array.isArray(meta.postBalances) ? meta.postBalances : malformed("postBalances");
  const lamportDeltas = keys
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => watched.has(account))
    .map(({ account, index }) => ({
      account,
      delta: (lamports(post[index] ?? 0, "postBalances") - lamports(pre[index] ?? 0, "preBalances")).toString(),
    }));
  const version = transaction.version === undefined || transaction.version === "legacy" ? "legacy" : String(transaction.version);
  if (version !== "legacy" && version !== "0" && version !== "1") return malformed(`unknown transaction version ${version}`);
  const blockTime = transaction.blockTime;
  if (typeof blockTime !== "number" || !Number.isSafeInteger(blockTime)) return malformed("blockTime");
  const transactionIndex = transaction.transactionIndex;
  return {
    vm: "svm",
    role: input.role,
    chain: input.chain,
    signature: input.signature,
    slot: slot.toString(),
    blockhash: block.blockhash,
    blockTime,
    transactionIndex: typeof transactionIndex === "number" && Number.isSafeInteger(transactionIndex) ? transactionIndex : null,
    version,
    err: meta.err === null || meta.err === undefined ? null : JSON.stringify(meta.err),
    feePayer,
    fee: lamports(meta.fee, "fee").toString(),
    programs: [...programs].sort(),
    watch,
    tokenDeltas: [...deltas.values()]
      .filter((entry) => entry.delta !== 0n)
      .sort((a, b) => (a.owner + a.mint < b.owner + b.mint ? -1 : a.owner + a.mint > b.owner + b.mint ? 1 : 0))
      .map((entry) => ({ owner: entry.owner, mint: entry.mint, delta: entry.delta.toString() })),
    lamportDeltas,
  };
}

const EVM_FIELDS = ["vm", "chain", "tx", "blockNumber", "blockHash", "blockTimestamp", "transactionIndex", "status", "from", "to", "valueWei", "inputDigest", "logsDigest", "logCount", "watch", "transfers"] as const;
const SVM_FIELDS = ["vm", "chain", "signature", "slot", "blockhash", "blockTime", "transactionIndex", "version", "err", "feePayer", "fee", "programs", "watch", "tokenDeltas", "lamportDeltas"] as const;

/**
 * Field names whose values differ between the receipt's anchor and a fresh
 * read (empty = match). `role` is the receipt's own classification and is
 * not compared.
 */
export function compareAnchors(expected: ReceiptAnchor, observed: ReceiptAnchor): readonly string[] {
  if (expected.vm !== observed.vm) return ["vm"];
  const fields: readonly string[] = expected.vm === "evm" ? EVM_FIELDS : SVM_FIELDS;
  const left = expected as unknown as Record<string, unknown>;
  const right = observed as unknown as Record<string, unknown>;
  return fields.filter((field) => canonicalJson(left[field] ?? null) !== canonicalJson(right[field] ?? null));
}

/** The security-relevant view of one EVM transaction, as the engine's quote binding hashes it. */
export interface EvmBindingView {
  readonly vm: "evm";
  readonly chainId: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  /** Wei, decimal. */
  readonly value: string;
}

/** Normalised view (lower-case hex, decimal value), identical to the engine's `bindingView`. */
export function evmBindingView(input: { readonly chainId: number; readonly from: string; readonly to: string; readonly data: string; readonly value: string | bigint }): EvmBindingView {
  return {
    vm: "evm",
    chainId: input.chainId,
    from: input.from.toLowerCase(),
    to: input.to.toLowerCase(),
    data: input.data.toLowerCase(),
    value: BigInt(input.value).toString(),
  };
}

/**
 * Quote binding of EVM views: hex sha256 of `canonicalJson(views)`, the same
 * value the engine records as `payload.quoteBinding` (receipts design §5.5.3).
 */
export async function evmQuoteBinding(views: readonly EvmBindingView[]): Promise<string> {
  return sha256Hex(canonicalJson(views.map(evmBindingView)));
}

/** Reads a landed EVM transaction's binding view (verifiers rebuild `landedBinding` from these, in anchor order). */
export async function readEvmBindingView(rpc: RpcTransport, input: { readonly chain: CaipChainId; readonly tx: string }): Promise<EvmBindingView> {
  const chainId = evmChainId(input.chain);
  const transaction = await call(rpc, "eth_getTransactionByHash", [input.tx.toLowerCase()]);
  if (!isRecord(transaction) || typeof transaction.input !== "string" || !HEX_DATA.test(transaction.input)) return malformed("transaction");
  if (typeof transaction.to !== "string") return malformed("transaction.to (contract creations have no binding)");
  return evmBindingView({
    chainId: safeNumber(chainId, "chainId"),
    from: lowerAddress(transaction.from, "transaction.from"),
    to: lowerAddress(transaction.to, "transaction.to"),
    data: transaction.input,
    value: quantity(transaction.value, "transaction.value"),
  });
}

/* ------------------------------------------------------------ schema (verifiers) */

const HEX64 = /^[0-9a-f]{64}$/u;
const TX_HASH = /^0x[0-9a-f]{64}$/u;
const EVM_ADDRESS_LOWER = /^0x[0-9a-f]{40}$/u;
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const SIGNED_DECIMAL = /^(?:0|-?[1-9]\d*)$/u;
const CAIP2 = /^(eip155|solana):[-_a-zA-Z0-9]{1,32}$/u;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const isUint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isStringList = (value: unknown, test: (entry: string) => boolean): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && test(entry));

/** Schema problems of an anchor as carried in a receipt's evidence group (empty = well formed). */
export function receiptAnchorIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["anchor must be an object"];
  const issues: string[] = [];
  const check = (ok: boolean, field: string) => {
    if (!ok) issues.push(field);
  };
  if (value.vm === "evm") {
    if (!exactKeys(value, ["vm", "role", "chain", "tx", "blockNumber", "blockHash", "blockTimestamp", "transactionIndex", "status", "from", "to", "valueWei", "inputDigest", "logsDigest", "logCount", "watch", "transfers"])) {
      return ["evm anchor fields"];
    }
    check(value.role === "origin" || value.role === "fill", "role");
    check(typeof value.chain === "string" && CAIP2.test(value.chain) && value.chain.startsWith("eip155:"), "chain");
    check(typeof value.tx === "string" && TX_HASH.test(value.tx), "tx");
    check(typeof value.blockNumber === "string" && DECIMAL.test(value.blockNumber), "blockNumber");
    check(typeof value.blockHash === "string" && TX_HASH.test(value.blockHash), "blockHash");
    check(isUint(value.blockTimestamp), "blockTimestamp");
    check(isUint(value.transactionIndex), "transactionIndex");
    check(value.status === "success" || value.status === "reverted", "status");
    check(typeof value.from === "string" && EVM_ADDRESS_LOWER.test(value.from), "from");
    check(value.to === "" || (typeof value.to === "string" && EVM_ADDRESS_LOWER.test(value.to)), "to");
    check(typeof value.valueWei === "string" && DECIMAL.test(value.valueWei), "valueWei");
    check(typeof value.inputDigest === "string" && HEX64.test(value.inputDigest), "inputDigest");
    check(typeof value.logsDigest === "string" && HEX64.test(value.logsDigest), "logsDigest");
    check(isUint(value.logCount), "logCount");
    check(isStringList(value.watch, (entry) => EVM_ADDRESS_LOWER.test(entry)), "watch");
    check(
      Array.isArray(value.transfers) &&
        value.transfers.every(
          (transfer) =>
            isRecord(transfer) &&
            exactKeys(transfer, ["logIndex", "token", "from", "to", "amount"]) &&
            isUint(transfer.logIndex) &&
            [transfer.token, transfer.from, transfer.to].every((address) => typeof address === "string" && EVM_ADDRESS_LOWER.test(address)) &&
            typeof transfer.amount === "string" &&
            DECIMAL.test(transfer.amount),
        ),
      "transfers",
    );
    return issues;
  }
  if (value.vm === "svm") {
    if (!exactKeys(value, ["vm", "role", "chain", "signature", "slot", "blockhash", "blockTime", "transactionIndex", "version", "err", "feePayer", "fee", "programs", "watch", "tokenDeltas", "lamportDeltas"])) {
      return ["svm anchor fields"];
    }
    check(value.role === "origin" || value.role === "fill", "role");
    check(typeof value.chain === "string" && CAIP2.test(value.chain) && value.chain.startsWith("solana:"), "chain");
    check(isSolanaSignature(value.signature), "signature");
    check(typeof value.slot === "string" && DECIMAL.test(value.slot), "slot");
    check(isSolanaAddress(value.blockhash), "blockhash");
    check(typeof value.blockTime === "number" && Number.isSafeInteger(value.blockTime), "blockTime");
    check(value.transactionIndex === null || isUint(value.transactionIndex), "transactionIndex");
    check(value.version === "legacy" || value.version === "0" || value.version === "1", "version");
    check(value.err === null || typeof value.err === "string", "err");
    check(isSolanaAddress(value.feePayer), "feePayer");
    check(typeof value.fee === "string" && DECIMAL.test(value.fee), "fee");
    check(isStringList(value.programs, isSolanaAddress), "programs");
    check(isStringList(value.watch, isSolanaAddress), "watch");
    check(
      Array.isArray(value.tokenDeltas) &&
        value.tokenDeltas.every(
          (delta) =>
            isRecord(delta) &&
            exactKeys(delta, ["owner", "mint", "delta"]) &&
            isSolanaAddress(delta.owner) &&
            isSolanaAddress(delta.mint) &&
            typeof delta.delta === "string" &&
            SIGNED_DECIMAL.test(delta.delta),
        ),
      "tokenDeltas",
    );
    check(
      Array.isArray(value.lamportDeltas) &&
        value.lamportDeltas.every(
          (delta) => isRecord(delta) && exactKeys(delta, ["account", "delta"]) && isSolanaAddress(delta.account) && typeof delta.delta === "string" && SIGNED_DECIMAL.test(delta.delta),
        ),
      "lamportDeltas",
    );
    return issues;
  }
  return ["vm"];
}

/** CAIP-2 chain of a network key (helper for anchor/step consistency). */
export function anchorChainOf(network: string): CaipChainId | null {
  return Object.prototype.hasOwnProperty.call(CHAINS, network) ? CHAINS[network as keyof typeof CHAINS].id : null;
}
