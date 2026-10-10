/**
 * Solana transaction inspection: unsigned payload checks before a wallet sees
 * a transaction, and landed-transaction evidence after a signature is
 * submitted (status, fee payer, invoked programs, balance deltas).
 */
import {
  address as toAddress,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { createHash } from "node:crypto";
import { explorerTxUrl, isSolanaAddress, isSolanaSignature, WRAPPED_SOL_MINT, type SolanaProgramPin } from "@kletia/core";
import {
  isUnsupportedTransactionVersion,
  SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION,
  SOLANA_RPC_URLS,
  solanaRpc,
  warnUnsupportedTransactionVersion,
  type SolanaNetworkKey,
} from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { isRecord } from "../util.js";

export const SOLANA_PROGRAM_IDS = Object.freeze({
  system: "11111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  addressLookupTable: "AddressLookupTab1e1111111111111111111111111",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
});

/** Most compute units a provider-built transaction may request (the per-transaction maximum). */
export const MAX_COMPUTE_UNITS = 1_400_000;
/** Highest priority fee a provider-built transaction may set (micro-lamports per compute unit). */
export const MAX_COMPUTE_UNIT_PRICE = 1_000_000n;

/**
 * Checks a provider's ComputeBudget instruction data: known opcodes only
 * (heap frame, unit limit, unit price, loaded-accounts limit), a unit limit up
 * to the per-transaction maximum and a capped unit price, so the priority fee
 * stays below MAX_COMPUTE_UNITS x MAX_COMPUTE_UNIT_PRICE (0.0014 SOL).
 * Returns why the instruction is refused, or null.
 */
export function computeBudgetMismatch(data: Uint8Array): string | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = data[0];
  if (kind === 2 && data.length === 5) return view.getUint32(1, true) > MAX_COMPUTE_UNITS ? "requests too many compute units" : null;
  if (kind === 3 && data.length === 9) return view.getBigUint64(1, true) > MAX_COMPUTE_UNIT_PRICE ? "sets a priority fee above the cap" : null;
  if ((kind === 1 || kind === 4) && data.length === 5) return null;
  return "is an unknown compute-budget instruction";
}

/**
 * One top-level instruction with every account resolved to its address
 * (address-lookup-table entries included), in instruction order.
 */
export interface SolanaInstructionView {
  readonly program: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

export interface DecodedSolanaAccountMeta {
  readonly address: string;
  readonly signer: boolean;
  readonly writable: boolean;
}

/** A top-level instruction of an unsigned transaction, with account roles. */
export interface DecodedSolanaInstruction extends SolanaInstructionView {
  readonly metas: readonly DecodedSolanaAccountMeta[];
}

export interface UnsignedSolanaTransactionInfo {
  readonly feePayer: string;
  readonly signers: readonly string[];
  /** Programs invoked by top-level instructions, in order, de-duplicated. */
  readonly programs: readonly string[];
  /** Message version (absent on hand-built values: treat as legacy or v0). */
  readonly version?: SolanaMessageVersion;
  /** Compute-budget config of a version 1 message (null for legacy and v0, which use ComputeBudget instructions). */
  readonly config?: SolanaTransactionConfig | null;
}

export type SolanaMessageVersion = "legacy" | 0 | 1;

/**
 * Compute-budget settings a version 1 message carries in its header instead
 * of ComputeBudget instructions (null when unset). The priority fee is a
 * total in lamports, not a price per compute unit.
 */
export interface SolanaTransactionConfig {
  readonly priorityFeeLamports: bigint | null;
  readonly computeUnitLimit: number | null;
  readonly loadedAccountsDataSizeLimit: number | null;
  readonly heapSize: number | null;
}

/**
 * Highest total priority fee a provider-built version 1 transaction may set:
 * the legacy and v0 bound, MAX_COMPUTE_UNITS x MAX_COMPUTE_UNIT_PRICE
 * (1,400,000 lamports, 0.0014 SOL).
 */
export const MAX_V1_PRIORITY_FEE_LAMPORTS = (BigInt(MAX_COMPUTE_UNITS) * MAX_COMPUTE_UNIT_PRICE) / 1_000_000n;
/** Wire size limits: legacy and v0 keep the existing bound; version 1 transactions may be up to 4,096 bytes. */
const LEGACY_BASE64_LIMIT = 1_700 * 2;
const V1_TRANSACTION_SIZE_LIMIT = 4_096;
const V1_BASE64_LIMIT = Math.ceil(V1_TRANSACTION_SIZE_LIMIT / 3) * 4;
/** Config fields a version 1 message may declare (priority fee: bits 0-1, unit limit: 2, loaded data: 3, heap: 4). */
const V1_CONFIG_KNOWN_BITS = 0x1f;
const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;
const MIN_HEAP_SIZE = 32 * 1024;
const MAX_HEAP_SIZE = 256 * 1024;

type CompiledMessage = ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
type V1CompiledMessage = Extract<CompiledMessage, { readonly version: 1 }>;

/** Reads the config values of a version 1 message in wire order (fee, unit limit, loaded data, heap). */
function v1Config(message: V1CompiledMessage): SolanaTransactionConfig {
  const mask = message.configMask;
  if ((mask & ~V1_CONFIG_KNOWN_BITS) !== 0) throw new Error("unknown config fields");
  const values = [...message.configValues];
  const take = (present: boolean, kind: "u32" | "u64") => {
    if (!present) return null;
    const value = values.shift();
    if (!value || value.kind !== kind) throw new Error("config values do not match the mask");
    return value.value;
  };
  const priorityFee = take((mask & 3) === 3, "u64");
  const computeUnitLimit = take((mask & 4) !== 0, "u32");
  const loadedAccountsDataSizeLimit = take((mask & 8) !== 0, "u32");
  const heapSize = take((mask & 16) !== 0, "u32");
  if (values.length > 0) throw new Error("config values do not match the mask");
  return {
    priorityFeeLamports: priorityFee === null ? null : BigInt(priorityFee),
    computeUnitLimit: computeUnitLimit === null ? null : Number(computeUnitLimit),
    loadedAccountsDataSizeLimit: loadedAccountsDataSizeLimit === null ? null : Number(loadedAccountsDataSizeLimit),
    heapSize: heapSize === null ? null : Number(heapSize),
  };
}

/**
 * Checks the compute-budget config of a provider's version 1 message with the
 * same bounds as computeBudgetMismatch: a unit limit up to the
 * per-transaction maximum, a total priority fee up to
 * MAX_V1_PRIORITY_FEE_LAMPORTS, a valid heap frame and loaded-data limit.
 * Returns why the config is refused, or null.
 */
export function v1ConfigMismatch(config: SolanaTransactionConfig): string | null {
  if (config.computeUnitLimit !== null && config.computeUnitLimit > MAX_COMPUTE_UNITS) return "requests too many compute units";
  if (config.priorityFeeLamports !== null && config.priorityFeeLamports > MAX_V1_PRIORITY_FEE_LAMPORTS) return "sets a priority fee above the cap";
  if (config.loadedAccountsDataSizeLimit !== null && config.loadedAccountsDataSizeLimit > MAX_LOADED_ACCOUNTS_DATA_SIZE) return "requests too much loaded account data";
  if (config.heapSize !== null && (config.heapSize < MIN_HEAP_SIZE || config.heapSize > MAX_HEAP_SIZE || config.heapSize % 1024 !== 0)) {
    return "requests an invalid heap frame";
  }
  return null;
}

/**
 * One top-level instruction of a compiled message (any version): program and
 * account indexes into the message's account list, raw data.
 */
interface CompiledInstructionView {
  readonly programIndex: number;
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
}

function compiledInstructions(message: CompiledMessage): CompiledInstructionView[] {
  if (message.version === 1) {
    if (message.instructionHeaders.length !== message.numInstructions || message.instructionPayloads.length !== message.numInstructions) {
      throw new Error("instruction headers and payloads disagree");
    }
    return message.instructionHeaders.map((header, index) => {
      const payload = message.instructionPayloads[index];
      if (!payload) throw new Error("missing instruction payload");
      return { programIndex: header.programAccountIndex, accountIndexes: payload.instructionAccountIndices, data: Uint8Array.from(payload.instructionData) };
    });
  }
  return message.instructions.map((instruction) => ({
    programIndex: instruction.programAddressIndex,
    accountIndexes: instruction.accountIndices ?? [],
    data: Uint8Array.from(instruction.data ?? []),
  }));
}

/**
 * Decodes an unsigned base64 wire transaction (legacy, v0 or v1). A version 1
 * message carries its compute budget in a config header: it is held to the
 * same unit-limit and priority-fee caps as ComputeBudget instructions, and
 * unknown config fields are refused.
 */
export function inspectUnsignedSolanaTransaction(base64: string): UnsignedSolanaTransactionInfo {
  if (typeof base64 !== "string" || base64.length === 0 || base64.length > V1_BASE64_LIMIT || !/^[A-Za-z0-9+/]+=*$/u.test(base64)) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned a malformed Solana transaction.", 502);
  }
  let info: UnsignedSolanaTransactionInfo;
  try {
    const bytes = getBase64Encoder().encode(base64);
    const transaction = getTransactionDecoder().decode(bytes);
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (message.version !== 0 && message.version !== "legacy" && message.version !== 1) {
      throw new Error("unsupported version");
    }
    if (message.version === 1 ? bytes.length > V1_TRANSACTION_SIZE_LIMIT : base64.length > LEGACY_BASE64_LIMIT) {
      throw new Error("oversized transaction");
    }
    const feePayer = String(message.staticAccounts[0] ?? "");
    const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts).map(String);
    const programs: string[] = [];
    for (const instruction of compiledInstructions(message)) {
      const program = message.staticAccounts[instruction.programIndex];
      if (program === undefined) throw new Error("program outside static accounts");
      if (!programs.includes(String(program))) programs.push(String(program));
    }
    info = { feePayer, signers, programs, version: message.version, config: message.version === 1 ? v1Config(message) : null };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned an undecodable Solana transaction.", 502);
  }
  const mismatch = info.config ? v1ConfigMismatch(info.config) : null;
  if (mismatch) {
    throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", `The provider transaction ${mismatch}.`, 502);
  }
  return info;
}

/**
 * Refuses any payload whose fee payer is not the step account or which needs
 * a signature from anyone else.
 */
export function assertSolanaTransactionOwner(base64: string, owner: string): UnsignedSolanaTransactionInfo {
  const info = inspectUnsignedSolanaTransaction(base64);
  if (info.feePayer !== owner || info.signers.length !== 1 || info.signers[0] !== owner) {
    throw new PlatformError(
      "PROVIDER_TRANSACTION_REJECTED",
      "The provider transaction is not fee-paid and signed solely by the step account.",
      502,
    );
  }
  return info;
}

export interface DecodedSolanaTransaction extends UnsignedSolanaTransactionInfo {
  readonly version: SolanaMessageVersion;
  /** Every top-level instruction, lookup-table accounts resolved. */
  readonly instructions: readonly DecodedSolanaInstruction[];
  /** Address lookup tables the message loads accounts from. */
  readonly lookupTables: readonly string[];
  /** Static keys followed by resolved lookup-table writable and read-only keys. */
  readonly accountKeys: readonly string[];
}

/** Lookup tables one provider transaction may load (Kamino uses one or two). */
const MAX_LOOKUP_TABLES = 4;
/** LookupTableMeta size; addresses follow it, 32 bytes each. */
const LOOKUP_TABLE_HEADER_BYTES = 56;

/**
 * Reads address lookup tables (base64 account data). Every table must exist,
 * be owned by the Address Lookup Table program and hold whole 32-byte
 * entries. Table entries are append-only, so an index resolved now resolves
 * to the same address when the transaction lands.
 */
async function readLookupTables(network: SolanaNetworkKey, tables: readonly string[]): Promise<Map<string, string[]>> {
  const resolved = new Map<string, string[]>();
  if (tables.length === 0) return resolved;
  let accounts: readonly unknown[];
  try {
    const response = await solanaRpc(network)
      .getMultipleAccounts(tables.map((table) => toAddress(table)), { encoding: "base64", commitment: "confirmed" })
      .send({ abortSignal: rpcAbortSignal() });
    accounts = response.value;
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The transaction's lookup tables could not be read. Try again shortly.", 502);
  }
  const decoder = getAddressDecoder();
  tables.forEach((table, index) => {
    const account = accounts[index];
    if (!isRecord(account) || String(account.owner) !== SOLANA_PROGRAM_IDS.addressLookupTable || !Array.isArray(account.data)) {
      throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider transaction loads accounts from a missing or foreign lookup table.", 502);
    }
    const bytes = getBase64Encoder().encode(String(account.data[0] ?? ""));
    if (bytes.length < LOOKUP_TABLE_HEADER_BYTES || (bytes.length - LOOKUP_TABLE_HEADER_BYTES) % 32 !== 0 || bytes[0] !== 1) {
      throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider transaction loads accounts from a malformed lookup table.", 502);
    }
    const entries: string[] = [];
    for (let offset = LOOKUP_TABLE_HEADER_BYTES; offset < bytes.length; offset += 32) {
      entries.push(String(decoder.decode(bytes.subarray(offset, offset + 32))));
    }
    resolved.set(table, entries);
  });
  return resolved;
}

/**
 * Decodes an unsigned wire transaction completely: fee payer, signers and
 * every top-level instruction with its accounts resolved through the address
 * lookup tables it loads (read from `network`). Use it when a provider builds
 * the transaction and the program, accounts and data of each instruction must
 * be checked against pinned values before a wallet sees it.
 */
export async function decodeSolanaTransaction(network: SolanaNetworkKey, base64: string): Promise<DecodedSolanaTransaction> {
  const info = inspectUnsignedSolanaTransaction(base64);
  let message;
  try {
    message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(base64)).messageBytes);
  } catch {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned an undecodable Solana transaction.", 502);
  }
  if (message.version !== 0 && message.version !== "legacy" && message.version !== 1) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned an unsupported Solana transaction version.", 502);
  }
  let compiled: CompiledInstructionView[];
  try {
    compiled = compiledInstructions(message);
  } catch {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned an undecodable Solana transaction.", 502);
  }
  const staticAccounts = message.staticAccounts.map(String);
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = message.header;
  const metas: DecodedSolanaAccountMeta[] = staticAccounts.map((address, index) => {
    const signer = index < numSignerAccounts;
    const writable = signer
      ? index < numSignerAccounts - numReadonlySignerAccounts
      : index < staticAccounts.length - numReadonlyNonSignerAccounts;
    return { address, signer, writable };
  });
  // Version 1 messages list every account statically (no lookup tables).
  const lookups = message.version === 0 ? (message.addressTableLookups ?? []) : [];
  if (lookups.length > MAX_LOOKUP_TABLES) {
    throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", "The provider transaction loads too many lookup tables.", 502);
  }
  const tables = await readLookupTables(network, lookups.map((lookup) => String(lookup.lookupTableAddress)));
  const entry = (table: string, index: number) => {
    const address = tables.get(table)?.[index];
    if (address === undefined) {
      throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider transaction references a lookup-table entry that does not exist.", 502);
    }
    return address;
  };
  // Message account order: static keys, then every table's writable entries, then every table's read-only entries.
  for (const lookup of lookups) {
    for (const index of lookup.writableIndexes) metas.push({ address: entry(String(lookup.lookupTableAddress), index), signer: false, writable: true });
  }
  for (const lookup of lookups) {
    for (const index of lookup.readonlyIndexes) metas.push({ address: entry(String(lookup.lookupTableAddress), index), signer: false, writable: false });
  }
  const instructions = compiled.map((instruction): DecodedSolanaInstruction => {
    const program = staticAccounts[instruction.programIndex];
    const accountMetas = instruction.accountIndexes.map((index) => metas[index]);
    if (program === undefined || accountMetas.some((meta) => meta === undefined)) {
      throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider transaction references an account outside its message.", 502);
    }
    const resolved = accountMetas as DecodedSolanaAccountMeta[];
    return {
      program,
      accounts: resolved.map((meta) => meta.address),
      metas: resolved,
      data: instruction.data,
    };
  });
  return {
    ...info,
    version: message.version,
    instructions,
    lookupTables: lookups.map((lookup) => String(lookup.lookupTableAddress)),
    accountKeys: metas.map((meta) => meta.address),
  };
}

/** Little-endian u64 at `offset` (null when out of range). */
export function readU64(data: Uint8Array, offset: number): bigint | null {
  if (offset < 0 || offset + 8 > data.length) return null;
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(data[offset + index] as number);
  return value;
}

/** Hex form of a byte prefix (instruction discriminators). */
export function bytesHex(data: Uint8Array, length = data.length): string {
  return Buffer.from(data.subarray(0, length)).toString("hex");
}

/**
 * Text form of an RPC transaction error. @solana/kit decodes the numbers inside
 * errors (e.g. `InstructionError: [2, { Custom: 1 }]`) as bigint, which plain
 * JSON.stringify refuses to serialise.
 */
export function rpcErrorText(error: unknown): string {
  try {
    const text = JSON.stringify(error, (_key, value: unknown) =>
      typeof value === "bigint" ? (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()) : value);
    return (text ?? "error").slice(0, 200);
  } catch {
    return "Transaction error";
  }
}

/**
 * Simulates an unsigned wire transaction (signature verification off, fresh
 * blockhash). Returns null when the RPC cannot simulate right now.
 */
export async function simulateSolanaTransaction(
  network: SolanaNetworkKey,
  base64: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string } | null> {
  try {
    const result = await solanaRpc(network)
      .simulateTransaction(base64 as Base64EncodedWireTransaction, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      })
      .send({ abortSignal: rpcAbortSignal() });
    return result.value.err === null ? { ok: true } : { ok: false, error: rpcErrorText(result.value.err) };
  } catch {
    return null;
  }
}

export interface BuiltSolanaTransaction {
  /** Unsigned v0 wire transaction (base64), fee-paid by `feePayer`. */
  readonly transaction: string;
  readonly lastValidBlockHeight: number;
  /** Simulation of the exact payload; null when the RPC could not simulate. */
  readonly simulation: { readonly ok: true } | { readonly ok: false; readonly error: string } | null;
}

/** Priority fee for engine-built transactions (micro-lamports per compute unit). */
const ENGINE_COMPUTE_UNIT_PRICE = 50_000n;

/**
 * Compiles engine-built instructions into an unsigned v0 transaction with a
 * compute budget (limit plus a small priority fee) and the latest blockhash,
 * then simulates that exact payload.
 */
export async function buildSolanaTransaction(
  network: SolanaNetworkKey,
  feePayer: string,
  instructions: readonly Instruction[],
  computeUnits: number,
): Promise<BuiltSolanaTransaction> {
  let blockhash;
  try {
    ({ value: blockhash } = await solanaRpc(network).getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: rpcAbortSignal() }));
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The Solana RPC could not provide a recent blockhash. Try again shortly.", 502);
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(toAddress(feePayer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(blockhash, draft),
    (draft) => appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: computeUnits }),
      getSetComputeUnitPriceInstruction({ microLamports: ENGINE_COMPUTE_UNIT_PRICE }),
      ...instructions,
    ], draft),
  );
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message));
  return {
    transaction,
    lastValidBlockHeight: Number(blockhash.lastValidBlockHeight),
    simulation: await simulateSolanaTransaction(network, transaction),
  };
}

/**
 * Settles a simulation reported by the Solana module. That module reports any
 * simulation it could not serialise as "Simulation unavailable" (including
 * real instruction errors), so such results are re-simulated here.
 */
export async function confirmSimulation(
  network: SolanaNetworkKey,
  base64: string,
  simulation: { readonly ok: boolean; readonly error: string | null },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string } | null> {
  if (simulation.ok) return { ok: true };
  if (simulation.error && simulation.error !== "Simulation unavailable") return { ok: false, error: simulation.error };
  return simulateSolanaTransaction(network, base64);
}

export type SolanaLandedStatus = "not_found" | "processed" | "confirmed" | "finalized" | "failed";

export interface SolanaTransactionObservation {
  readonly network: SolanaNetworkKey;
  readonly signature: string;
  readonly status: SolanaLandedStatus;
  readonly error: string | null;
  readonly feePayer: string | null;
  readonly programs: readonly string[];
  readonly blockTime: number | null;
  readonly slot: string | null;
  readonly explorerUrl: string;
  /** Token balance change per `${owner}:${mint}`. */
  readonly tokenDeltas: ReadonlyMap<string, bigint>;
  /** Lamport change per account address. */
  readonly lamportDeltas: ReadonlyMap<string, bigint>;
  /** Transaction fee in lamports (paid by the fee payer); null when unknown. */
  readonly fee: bigint | null;
  /**
   * Top-level instructions with lookup-table accounts resolved (empty when
   * the body is not readable). Adapters bind a landed transaction to its
   * prepared payload by program, accounts and instruction data. Optional so
   * hand-built observations stay valid; a missing list proves no instruction.
   */
  readonly instructions?: readonly SolanaInstructionView[];
  /** Token balances before / after with their owners (empty when the body is not readable). */
  readonly tokenBalances?: { readonly pre: readonly SolanaTokenBalance[]; readonly post: readonly SolanaTokenBalance[] };
  /** Inner (CPI) instructions of the landed transaction, accounts resolved. */
  readonly innerInstructions?: readonly SolanaInnerInstruction[];
  /** True when the transaction body could be read (statuses alone are not enough to accept). */
  readonly detailsAvailable: boolean;
}

/** One token balance entry of a transaction meta (or a simulation), owner included. */
export interface SolanaTokenBalance {
  readonly account: string;
  readonly mint: string;
  readonly owner: string | null;
  readonly programId: string | null;
  readonly amount: bigint;
  readonly decimals: number | null;
}

/**
 * An inner instruction of a landed or simulated transaction. RPCs return
 * them compiled (account indexes, base58 data), partially decoded (account
 * addresses, base58 data) or parsed (`{ type, info }` for known programs);
 * all three are normalised here.
 */
export interface SolanaInnerInstruction {
  /** Index of the top-level instruction that issued it. */
  readonly index: number;
  readonly program: string;
  readonly accounts: readonly string[];
  /** Raw data when the RPC returned it (null for parsed instructions). */
  readonly data: Uint8Array | null;
  /** RPC-parsed form for known programs (spl-token, system, ...). */
  readonly parsed: { readonly type: string; readonly info: Readonly<Record<string, unknown>> } | null;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return BigInt(value);
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function parseTokenBalances(value: unknown, keys: readonly string[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  if (!Array.isArray(value)) return balances;
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.uiTokenAmount)) continue;
    const mint = typeof entry.mint === "string" ? entry.mint : null;
    const index = typeof entry.accountIndex === "number" ? entry.accountIndex : null;
    const owner = typeof entry.owner === "string" ? entry.owner : index !== null ? keys[index] ?? null : null;
    const amount = toBigInt(entry.uiTokenAmount.amount);
    if (!mint || !owner || amount === null) continue;
    const key = `${owner}:${mint}`;
    balances.set(key, (balances.get(key) ?? 0n) + amount);
  }
  return balances;
}

/**
 * An instruction of a `getTransaction` (json encoding) body: account indexes
 * into static keys plus loaded addresses, base58 data. Null when malformed
 * (the instruction then cannot satisfy any binding check).
 */
function instructionView(instruction: Record<string, unknown>, program: string | undefined, keys: readonly string[]): SolanaInstructionView | null {
  if (!program || !Array.isArray(instruction.accounts) || typeof instruction.data !== "string") return null;
  const accounts: string[] = [];
  for (const index of instruction.accounts) {
    const key = typeof index === "number" ? keys[index] : undefined;
    if (key === undefined) return null;
    accounts.push(key);
  }
  try {
    return { program, accounts, data: Uint8Array.from(getBase58Encoder().encode(instruction.data)) };
  } catch {
    return null;
  }
}

/** Token balance entries with owners (json `getTransaction` meta or `simulateTransaction`). */
export function tokenBalanceList(value: unknown, keys: readonly string[]): SolanaTokenBalance[] {
  const out: SolanaTokenBalance[] = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.uiTokenAmount)) continue;
    const index = typeof entry.accountIndex === "number" ? entry.accountIndex : typeof entry.accountIndex === "bigint" ? Number(entry.accountIndex) : null;
    const account = index !== null ? keys[index] : undefined;
    const amount = toBigInt(entry.uiTokenAmount.amount);
    if (!account || typeof entry.mint !== "string" || amount === null) continue;
    const decimals = toBigInt(entry.uiTokenAmount.decimals);
    out.push({
      account,
      mint: entry.mint,
      owner: typeof entry.owner === "string" ? entry.owner : null,
      programId: typeof entry.programId === "string" ? entry.programId : null,
      amount,
      decimals: decimals === null ? null : Number(decimals),
    });
  }
  return out;
}

function base58Bytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  try {
    return Uint8Array.from(getBase58Encoder().encode(value));
  } catch {
    return null;
  }
}

/**
 * Normalises `innerInstructions` of a transaction meta or a simulation:
 * compiled (`programIdIndex`, index accounts), partially decoded
 * (`programId`, address accounts, base58 data) or parsed (`parsed`).
 * Entries that cannot be read are kept with an empty program so a scan
 * treats them as unknown (callers fail closed on them).
 */
export function innerInstructionList(value: unknown, keys: readonly string[]): SolanaInnerInstruction[] {
  const out: SolanaInnerInstruction[] = [];
  if (!Array.isArray(value)) return out;
  for (const group of value) {
    if (!isRecord(group) || !Array.isArray(group.instructions)) continue;
    const index = Number(group.index ?? -1);
    for (const raw of group.instructions) {
      if (!isRecord(raw)) {
        out.push({ index, program: "", accounts: [], data: null, parsed: null });
        continue;
      }
      const programIndex = toBigInt(raw.programIdIndex);
      const program = typeof raw.programId === "string" ? raw.programId : programIndex !== null ? keys[Number(programIndex)] ?? "" : "";
      const accounts: string[] = [];
      if (Array.isArray(raw.accounts)) {
        for (const account of raw.accounts) {
          const position = toBigInt(account);
          if (typeof account === "string") accounts.push(account);
          else if (position !== null && keys[Number(position)] !== undefined) accounts.push(keys[Number(position)] as string);
          else accounts.push("");
        }
      }
      const parsed = isRecord(raw.parsed) && typeof raw.parsed.type === "string"
        ? { type: raw.parsed.type, info: isRecord(raw.parsed.info) ? raw.parsed.info : {} }
        : null;
      out.push({ index, program, accounts, data: raw.parsed !== undefined ? null : base58Bytes(raw.data), parsed });
    }
  }
  return out;
}

interface SolanaTransactionDetails {
  readonly feePayer: string | null;
  readonly programs: readonly string[];
  readonly blockTime: number | null;
  readonly tokenDeltas: ReadonlyMap<string, bigint>;
  readonly lamportDeltas: ReadonlyMap<string, bigint>;
  readonly fee: bigint | null;
  readonly instructions: readonly SolanaInstructionView[];
  readonly tokenBalances: { readonly pre: readonly SolanaTokenBalance[]; readonly post: readonly SolanaTokenBalance[] };
  readonly innerInstructions: readonly SolanaInnerInstruction[];
  readonly executionError: string | null;
}

interface SolanaSignatureRead {
  /** `null` when the signature is unknown to the cluster. */
  readonly confirmation: "processed" | "confirmed" | "finalized" | null;
  readonly statusError: string | null;
  readonly slot: string | null;
  /** Parsed transaction body; null when not (yet) readable. */
  readonly details: SolanaTransactionDetails | null;
  /** Why a landed body is not readable when the RPC said so (a version newer than this client reads). */
  readonly unreadable?: string;
}

const UNSUPPORTED_VERSION = Symbol("unsupported transaction version");

/** Text of an observation whose body the RPC refused to return in a version this client reads. */
export const SOLANA_VERSION_UNREADABLE = `The transaction uses a version newer than ${SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION}, which Kletia cannot read yet.`;

/** Reads a signature's status and, once confirmed, its body and balance deltas. */
async function readSolanaSignature(network: SolanaNetworkKey, signatureValue: string): Promise<SolanaSignatureRead> {
  const rpc = solanaRpc(network);
  const sig = toSignature(signatureValue);
  const statuses = await rpc
    .getSignatureStatuses([sig], { searchTransactionHistory: true })
    .send({ abortSignal: rpcAbortSignal() });
  const status = statuses.value[0];
  if (!status) return { confirmation: null, statusError: null, slot: null, details: null };
  const slot = status.slot.toString();
  const statusError = status.err ? rpcErrorText(status.err) : null;
  const confirmation = status.confirmationStatus === "finalized" ? "finalized" : status.confirmationStatus === "confirmed" ? "confirmed" : "processed";
  if (!statusError && confirmation === "processed") return { confirmation, statusError, slot, details: null };
  // Legacy, v0 and v1 bodies share the json shape read below (v1: no lookup tables, plus `transactionConfig`).
  const raw: unknown = await rpc
    .getTransaction(sig, { maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION, commitment: "confirmed", encoding: "json" })
    .send({ abortSignal: rpcAbortSignal() })
    .catch((error: unknown) => (isUnsupportedTransactionVersion(error) ? UNSUPPORTED_VERSION : null));
  if (raw === UNSUPPORTED_VERSION) {
    // Permanent for this client (transient failures are retried on the next read): logged, and never confirmed.
    warnUnsupportedTransactionVersion(network, signatureValue);
    return { confirmation, statusError, slot, details: null, unreadable: SOLANA_VERSION_UNREADABLE };
  }
  if (!isRecord(raw) || !isRecord(raw.transaction) || !isRecord(raw.transaction.message) || !isRecord(raw.meta)) {
    return { confirmation, statusError, slot, details: null };
  }
  const message = raw.transaction.message;
  const meta = raw.meta;
  const staticKeys = stringList(message.accountKeys);
  const loaded = isRecord(meta.loadedAddresses) ? meta.loadedAddresses : {};
  const keys = [...staticKeys, ...stringList(loaded.writable), ...stringList(loaded.readonly)];
  const programs: string[] = [];
  const instructions: SolanaInstructionView[] = [];
  if (Array.isArray(message.instructions)) {
    for (const instruction of message.instructions) {
      if (!isRecord(instruction) || typeof instruction.programIdIndex !== "number") continue;
      const program = staticKeys[instruction.programIdIndex];
      if (program && !programs.includes(program)) programs.push(program);
      const view = instructionView(instruction, program, keys);
      if (view) instructions.push(view);
    }
  }
  const pre = parseTokenBalances(meta.preTokenBalances, keys);
  const post = parseTokenBalances(meta.postTokenBalances, keys);
  const tokenDeltas = new Map<string, bigint>();
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    tokenDeltas.set(key, (post.get(key) ?? 0n) - (pre.get(key) ?? 0n));
  }
  const lamportDeltas = new Map<string, bigint>();
  if (Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    keys.forEach((key, index) => {
      const before = toBigInt((meta.preBalances as unknown[])[index]);
      const after = toBigInt((meta.postBalances as unknown[])[index]);
      if (before !== null && after !== null) lamportDeltas.set(key, (lamportDeltas.get(key) ?? 0n) + after - before);
    });
  }
  const blockTime = toBigInt(raw.blockTime);
  return {
    confirmation,
    statusError,
    slot,
    details: {
      feePayer: staticKeys[0] ?? null,
      programs,
      blockTime: blockTime === null ? null : Number(blockTime),
      tokenDeltas,
      lamportDeltas,
      fee: toBigInt(meta.fee),
      instructions,
      tokenBalances: { pre: tokenBalanceList(meta.preTokenBalances, keys), post: tokenBalanceList(meta.postTokenBalances, keys) },
      innerInstructions: innerInstructionList(meta.innerInstructions, keys),
      executionError: meta.err !== null && meta.err !== undefined ? rpcErrorText(meta.err) : null,
    },
  };
}

/**
 * Observes a submitted signature. A landed transaction from another fee payer
 * is reported as `failed` so it can never advance a step; a transaction whose
 * body cannot be read is never reported as confirmed.
 */
export async function observeSolanaTransaction(
  network: SolanaNetworkKey,
  signatureValue: string,
  expectedFeePayer: string,
): Promise<SolanaTransactionObservation> {
  if (!isSolanaSignature(signatureValue)) {
    throw new PlatformError("REFERENCE_INVALID", "A valid Solana transaction signature is required.", 400);
  }
  if (!isSolanaAddress(expectedFeePayer)) {
    throw new PlatformError("ACCOUNT_INVALID", "The step account is not a Solana address.", 500);
  }
  const read = await readSolanaSignature(network, signatureValue);
  const base = {
    network,
    signature: signatureValue,
    explorerUrl: explorerTxUrl(network, signatureValue),
    slot: read.slot,
  };
  const empty = {
    feePayer: null,
    programs: [],
    blockTime: null,
    tokenDeltas: new Map<string, bigint>(),
    lamportDeltas: new Map<string, bigint>(),
    fee: null,
    instructions: [],
    tokenBalances: { pre: [], post: [] },
    innerInstructions: [],
    detailsAvailable: false,
  };
  if (read.confirmation === null) return { ...base, ...empty, status: "not_found", error: null };
  const details = read.details;
  if (!details) {
    // Confirmed (or failed) per status, but the body is not readable yet: report it unconfirmed (never failed for
    // a version this client cannot read: it may have succeeded).
    return { ...base, ...empty, status: read.statusError ? "failed" : "processed", error: read.statusError ?? read.unreadable ?? null };
  }
  const payerMismatch = details.feePayer !== expectedFeePayer;
  const landed: SolanaLandedStatus = read.confirmation === "finalized" ? "finalized" : "confirmed";
  return {
    ...base,
    status: details.executionError || read.statusError || payerMismatch ? "failed" : landed,
    error: payerMismatch
      ? "Transaction fee payer does not match the step account."
      : details.executionError ?? read.statusError,
    feePayer: details.feePayer,
    programs: details.programs,
    blockTime: details.blockTime,
    tokenDeltas: details.tokenDeltas,
    lamportDeltas: details.lamportDeltas,
    fee: details.fee,
    instructions: details.instructions,
    tokenBalances: details.tokenBalances,
    innerInstructions: details.innerInstructions,
    detailsAvailable: true,
  };
}

/** Destination-side check for solver fills: the signature landed without error. */
export async function readSolanaSignatureStatus(
  network: SolanaNetworkKey,
  signatureValue: string,
): Promise<"success" | "failed" | "not_found" | "processed"> {
  if (!isSolanaSignature(signatureValue)) return "not_found";
  const statuses = await solanaRpc(network)
    .getSignatureStatuses([toSignature(signatureValue)], { searchTransactionHistory: true })
    .send({ abortSignal: rpcAbortSignal() });
  const status = statuses.value[0];
  if (!status) return "not_found";
  if (status.err) return "failed";
  return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? "success" : "processed";
}

/**
 * Destination-side evidence for a solver fill on Solana: the signature landed
 * without error and credited `owner` (SPL `mint`, or lamports plus wrapped SOL
 * when `mint` is null). `credited` is null when the body is not readable yet;
 * `blockTime` (unix seconds) is null when the cluster does not report it.
 */
export async function readSolanaCredit(
  network: SolanaNetworkKey,
  signatureValue: string,
  owner: string,
  mint: string | null,
): Promise<{ readonly status: "success" | "failed" | "pending"; readonly credited: bigint | null; readonly blockTime: number | null }> {
  if (!isSolanaSignature(signatureValue) || !isSolanaAddress(owner)) return { status: "pending", credited: null, blockTime: null };
  const read = await readSolanaSignature(network, signatureValue);
  if (read.confirmation === null || read.confirmation === "processed") return { status: "pending", credited: null, blockTime: null };
  if (read.statusError || read.details?.executionError) return { status: "failed", credited: null, blockTime: null };
  if (!read.details) return { status: "pending", credited: null, blockTime: null };
  const credited = mint === null
    ? (read.details.lamportDeltas.get(owner) ?? 0n) + (read.details.tokenDeltas.get(`${owner}:${WRAPPED_SOL_MINT}`) ?? 0n)
    : (read.details.tokenDeltas.get(`${owner}:${mint}`) ?? 0n);
  return { status: "success", credited, blockTime: read.details.blockTime };
}

/* ------------------------------------------------- Solana Actions support */

type ExactReviver = (this: unknown, key: string, value: unknown, context?: { readonly source?: string }) => unknown;

/**
 * JSON.parse that keeps integers beyond 2^53 exact (as bigint): lamport
 * balances of large accounts and `rentEpoch` (u64::MAX) exceed a double.
 */
export function parseJsonExact(text: string): unknown {
  const reviver: ExactReviver = (_key, value, context) =>
    typeof value === "number" && !Number.isSafeInteger(value) && typeof context?.source === "string" && /^-?\d+$/u.test(context.source)
      ? BigInt(context.source)
      : value;
  return (JSON.parse as (text: string, reviver: ExactReviver) => unknown)(text, reviver);
}

/** Raw JSON-RPC to the network's Solana RPC (exact integers, unknown fields kept). */
async function solanaJsonRpc(network: SolanaNetworkKey, method: string, params: readonly unknown[], timeoutMs = 10_000): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const response = await fetch(SOLANA_RPC_URLS[network], {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = parseJsonExact(await response.text());
  if (!isRecord(body)) throw new Error("malformed JSON-RPC response");
  if (isRecord(body.error)) return { ok: false, error: String(body.error.message ?? "error").slice(0, 200) };
  if (!("result" in body)) throw new Error(`HTTP ${response.status}: no result`);
  return { ok: true, result: body.result };
}

/** An account as returned with base64 encoding (null when it does not exist). */
export interface SolanaAccountState {
  readonly owner: string;
  readonly lamports: bigint;
  readonly executable: boolean;
  readonly data: Uint8Array;
}

function accountState(value: unknown): SolanaAccountState | null {
  if (!isRecord(value) || typeof value.owner !== "string" || !Array.isArray(value.data)) return null;
  const lamports = toBigInt(value.lamports);
  if (lamports === null) return null;
  try {
    return {
      owner: value.owner,
      lamports,
      executable: value.executable === true,
      data: Uint8Array.from(getBase64Encoder().encode(String(value.data[0] ?? ""))),
    };
  } catch {
    return null;
  }
}

/** Reads up to 100 accounts (base64); null entries for accounts that do not exist. Throws SOLANA_RPC_UNAVAILABLE. */
export async function readSolanaAccounts(network: SolanaNetworkKey, addresses: readonly string[], slice?: { readonly offset: number; readonly length: number }): Promise<(SolanaAccountState | null)[]> {
  if (addresses.length === 0) return [];
  if (addresses.length > 100) throw new PlatformError("ACTION_TRANSACTION_REJECTED", "The transaction writes too many accounts.", 422);
  try {
    const outcome = await solanaJsonRpc(network, "getMultipleAccounts", [
      addresses,
      { encoding: "base64", commitment: "confirmed", ...(slice ? { dataSlice: slice } : {}) },
    ]);
    if (!outcome.ok || !isRecord(outcome.result) || !Array.isArray(outcome.result.value)) throw new Error("unreadable");
    return (outcome.result.value as unknown[]).map(accountState);
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "Solana accounts could not be read. Try again shortly.", 502);
  }
}

export interface DetailedSolanaSimulation {
  /** Transaction error text, or null when it would succeed. */
  readonly error: string | null;
  readonly logs: readonly string[];
  readonly unitsConsumed: bigint | null;
  /** Fee the fee payer would pay (lamports), when the RPC reports it. */
  readonly fee: bigint | null;
  /** Static keys followed by loaded (lookup-table) keys, as the balance arrays index them. */
  readonly accountKeys: readonly string[];
  readonly preBalances: readonly bigint[] | null;
  readonly postBalances: readonly bigint[] | null;
  readonly preTokenBalances: readonly SolanaTokenBalance[];
  readonly postTokenBalances: readonly SolanaTokenBalance[];
  readonly innerInstructions: readonly SolanaInnerInstruction[];
  /** Post-simulation states of the requested accounts, in request order. */
  readonly accounts: readonly (SolanaAccountState | null)[];
  readonly slot: bigint | null;
}

/**
 * Simulates an unsigned wire transaction with balances, token balances,
 * inner instructions and the post states of `accounts` (sigVerify off, fresh
 * blockhash). Returns null when the RPC cannot simulate right now.
 */
export async function simulateSolanaTransactionDetailed(
  network: SolanaNetworkKey,
  base64: string,
  staticKeys: readonly string[],
  accounts: readonly string[],
  /** True when `staticKeys` already contains the complete, RPC-verified lookup-table key list. */
  resolvedKeys = false,
): Promise<DetailedSolanaSimulation | null> {
  let outcome;
  try {
    outcome = await solanaJsonRpc(network, "simulateTransaction", [
      base64,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        innerInstructions: true,
        ...(accounts.length > 0 ? { accounts: { encoding: "base64", addresses: accounts } } : {}),
      },
    ], 15_000);
  } catch {
    return null;
  }
  if (!outcome.ok || !isRecord(outcome.result) || !isRecord(outcome.result.value)) return null;
  const value = outcome.result.value;
  const loaded = isRecord(value.loadedAddresses) ? value.loadedAddresses : {};
  const keys = resolvedKeys ? [...staticKeys] : [...staticKeys, ...stringList(loaded.writable), ...stringList(loaded.readonly)];
  const numbers = (list: unknown) => (Array.isArray(list) ? list.map(toBigInt) : null);
  const pre = numbers(value.preBalances);
  const post = numbers(value.postBalances);
  const context = isRecord(outcome.result.context) ? outcome.result.context : {};
  return {
    error: value.err === null || value.err === undefined ? null : rpcErrorText(value.err),
    logs: stringList(value.logs).slice(-40),
    unitsConsumed: toBigInt(value.unitsConsumed),
    fee: toBigInt(value.fee),
    accountKeys: keys,
    preBalances: pre && pre.every((entry) => entry !== null) ? (pre as bigint[]) : null,
    postBalances: post && post.every((entry) => entry !== null) ? (post as bigint[]) : null,
    preTokenBalances: tokenBalanceList(value.preTokenBalances, keys),
    postTokenBalances: tokenBalanceList(value.postTokenBalances, keys),
    innerInstructions: innerInstructionList(value.innerInstructions, keys),
    accounts: Array.isArray(value.accounts) ? value.accounts.map(accountState) : accounts.map(() => null),
    slot: toBigInt(context.slot),
  };
}

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const IMMUTABLE_LOADERS = new Set(["BPFLoader2111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111"]);

/**
 * Pins of Solana programs: owner loader, program data account, last deploy
 * slot and upgrade authority (upgradeable loader: program account data
 * `[u32 2][programData]`, program data header `[u32 3][u64 slot][Option<Pubkey>]`),
 * or the sha256 of the account data for the immutable loaders. Refuses
 * (PROGRAM_NOT_ALLOWED) accounts that are not executable programs of a
 * supported loader.
 */
export async function readProgramPins(network: SolanaNetworkKey, programs: readonly string[]): Promise<SolanaProgramPin[]> {
  const accounts = await readSolanaAccounts(network, programs);
  const decoder = getAddressDecoder();
  const programData = new Map<string, string>();
  for (const [index, program] of programs.entries()) {
    const account = accounts[index];
    if (!account || !account.executable) {
      throw new PlatformError("PROGRAM_NOT_ALLOWED", `${program} is not an executable program on ${network}.`, 422);
    }
    if (account.owner === UPGRADEABLE_LOADER) {
      const view = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
      if (account.data.length < 36 || view.getUint32(0, true) !== 2) {
        throw new PlatformError("PROGRAM_NOT_ALLOWED", `${program} is not a deployed upgradeable program.`, 422);
      }
      programData.set(program, String(decoder.decode(account.data.subarray(4, 36))));
    } else if (!IMMUTABLE_LOADERS.has(account.owner)) {
      throw new PlatformError("PROGRAM_NOT_ALLOWED", `${program} is owned by ${account.owner}, a loader Kletia does not pin.`, 422);
    }
  }
  const dataAddresses = [...programData.values()];
  const headers = await readSolanaAccounts(network, dataAddresses, { offset: 0, length: 45 });
  return programs.map((program, index): SolanaProgramPin => {
    const account = accounts[index] as SolanaAccountState;
    const dataAddress = programData.get(program);
    if (!dataAddress) {
      return {
        program,
        loader: account.owner,
        programData: null,
        lastDeploySlot: null,
        upgradeAuthority: null,
        dataHash: createHash("sha256").update(account.data).digest("hex"),
      };
    }
    const header = headers[dataAddresses.indexOf(dataAddress)];
    const bytes = header?.data;
    if (!bytes || bytes.length < 13 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 3) {
      throw new PlatformError("PROGRAM_NOT_ALLOWED", `The program data account of ${program} is unreadable.`, 422);
    }
    const slot = readU64(bytes, 4);
    const authority = bytes[12] === 1 && bytes.length >= 45 ? String(decoder.decode(bytes.subarray(13, 45))) : null;
    return {
      program,
      loader: UPGRADEABLE_LOADER,
      programData: dataAddress,
      lastDeploySlot: slot === null ? null : slot.toString(),
      upgradeAuthority: authority,
    };
  });
}

/** A recent blockhash and its last valid block height (re-blockhashing Solana Action payloads). */
export async function latestBlockhash(network: SolanaNetworkKey): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: number }> {
  try {
    const { value } = await solanaRpc(network).getLatestBlockhash({ commitment: "confirmed" }).send({ abortSignal: rpcAbortSignal() });
    return { blockhash: String(value.blockhash), lastValidBlockHeight: Number(value.lastValidBlockHeight) };
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The Solana RPC could not provide a recent blockhash. Try again shortly.", 502);
  }
}

/** A legacy transaction with one empty signature and no instructions: any RPC that can simulate answers it. */
const PROBE_TRANSACTION = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAABBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const solanaProbes = new Map<SolanaNetworkKey, { ok: boolean; at: number }>();

/** Whether the network's RPC answers simulateTransaction (cached 10 minutes; health). */
export async function probeSolanaSimulation(network: SolanaNetworkKey): Promise<boolean> {
  const cached = solanaProbes.get(network);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.ok;
  let ok = false;
  try {
    const outcome = await solanaJsonRpc(network, "simulateTransaction", [PROBE_TRANSACTION, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }], 6_000);
    ok = outcome.ok && isRecord(outcome.result) && isRecord(outcome.result.value);
  } catch {
    ok = false;
  }
  solanaProbes.set(network, { ok, at: Date.now() });
  return ok;
}
