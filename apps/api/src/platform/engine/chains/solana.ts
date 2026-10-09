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
import { explorerTxUrl, isSolanaAddress, isSolanaSignature, WRAPPED_SOL_MINT } from "@kletia/core";
import { solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
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
}

/** Decodes an unsigned base64 wire transaction (legacy or v0 only). */
export function inspectUnsignedSolanaTransaction(base64: string): UnsignedSolanaTransactionInfo {
  if (typeof base64 !== "string" || base64.length === 0 || base64.length > 1_700 * 2 || !/^[A-Za-z0-9+/]+=*$/u.test(base64)) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned a malformed Solana transaction.", 502);
  }
  try {
    const bytes = getBase64Encoder().encode(base64);
    const transaction = getTransactionDecoder().decode(bytes);
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (message.version !== 0 && message.version !== "legacy") {
      throw new Error("unsupported version");
    }
    const feePayer = String(message.staticAccounts[0] ?? "");
    const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts).map(String);
    const programs: string[] = [];
    for (const instruction of message.instructions) {
      const program = message.staticAccounts[instruction.programAddressIndex];
      if (program === undefined) throw new Error("program outside static accounts");
      if (!programs.includes(String(program))) programs.push(String(program));
    }
    return { feePayer, signers, programs };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned an undecodable Solana transaction.", 502);
  }
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
  readonly version: 0 | "legacy";
  /** Every top-level instruction, lookup-table accounts resolved. */
  readonly instructions: readonly DecodedSolanaInstruction[];
  /** Address lookup tables the message loads accounts from. */
  readonly lookupTables: readonly string[];
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
  if (message.version !== 0 && message.version !== "legacy") {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned an unsupported Solana transaction version.", 502);
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
  const instructions = message.instructions.map((instruction): DecodedSolanaInstruction => {
    const program = staticAccounts[instruction.programAddressIndex];
    const accountMetas = (instruction.accountIndices ?? []).map((index) => metas[index]);
    if (program === undefined || accountMetas.some((meta) => meta === undefined)) {
      throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider transaction references an account outside its message.", 502);
    }
    const resolved = accountMetas as DecodedSolanaAccountMeta[];
    return {
      program,
      accounts: resolved.map((meta) => meta.address),
      metas: resolved,
      data: Uint8Array.from(instruction.data ?? []),
    };
  });
  return {
    ...info,
    version: message.version,
    instructions,
    lookupTables: lookups.map((lookup) => String(lookup.lookupTableAddress)),
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
  /** True when the transaction body could be read (statuses alone are not enough to accept). */
  readonly detailsAvailable: boolean;
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

interface SolanaTransactionDetails {
  readonly feePayer: string | null;
  readonly programs: readonly string[];
  readonly blockTime: number | null;
  readonly tokenDeltas: ReadonlyMap<string, bigint>;
  readonly lamportDeltas: ReadonlyMap<string, bigint>;
  readonly fee: bigint | null;
  readonly instructions: readonly SolanaInstructionView[];
  readonly executionError: string | null;
}

interface SolanaSignatureRead {
  /** `null` when the signature is unknown to the cluster. */
  readonly confirmation: "processed" | "confirmed" | "finalized" | null;
  readonly statusError: string | null;
  readonly slot: string | null;
  /** Parsed transaction body; null when not (yet) readable. */
  readonly details: SolanaTransactionDetails | null;
}

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
  const raw: unknown = await rpc
    .getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" })
    .send({ abortSignal: rpcAbortSignal() })
    .catch(() => null);
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
    detailsAvailable: false,
  };
  if (read.confirmation === null) return { ...base, ...empty, status: "not_found", error: null };
  const details = read.details;
  if (!details) {
    // Confirmed (or failed) per status, but the body is not readable yet: report it unconfirmed.
    return { ...base, ...empty, status: read.statusError ? "failed" : "processed", error: read.statusError };
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
 * when `mint` is null). `credited` is null when the body is not readable yet.
 */
export async function readSolanaCredit(
  network: SolanaNetworkKey,
  signatureValue: string,
  owner: string,
  mint: string | null,
): Promise<{ readonly status: "success" | "failed" | "pending"; readonly credited: bigint | null }> {
  if (!isSolanaSignature(signatureValue) || !isSolanaAddress(owner)) return { status: "pending", credited: null };
  const read = await readSolanaSignature(network, signatureValue);
  if (read.confirmation === null || read.confirmation === "processed") return { status: "pending", credited: null };
  if (read.statusError || read.details?.executionError) return { status: "failed", credited: null };
  if (!read.details) return { status: "pending", credited: null };
  const credited = mint === null
    ? (read.details.lamportDeltas.get(owner) ?? 0n) + (read.details.tokenDeltas.get(`${owner}:${WRAPPED_SOL_MINT}`) ?? 0n)
    : (read.details.tokenDeltas.get(`${owner}:${mint}`) ?? 0n);
  return { status: "success", credited };
}
