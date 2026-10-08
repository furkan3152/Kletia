import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { isBaseUnitAmount, isSolanaAddress, WRAPPED_SOL_MINT } from "@kletia/core";
import { SOLANA_PROGRAMS, type SolanaNetworkKey } from "./config.js";
import { SolanaProviderError, describeRpcError, isRecord } from "./http.js";
import { assertSolanaWalletRecipient } from "./recipient.js";
import { rpcAbortSignal, solanaRpc } from "./rpc.js";

export interface PreparedSolanaTransaction {
  readonly transaction: string;
  readonly lastValidBlockHeight: number;
  readonly simulation: {
    readonly ok: boolean;
    readonly unitsConsumed: number | null;
    readonly error: string | null;
  };
}

const TOKEN_2022_PROGRAM_ADDRESS = address(SOLANA_PROGRAMS.token2022);

interface TransferFee {
  readonly epoch: bigint;
  readonly basisPoints: bigint;
  readonly maximumFee: bigint;
}

function integer(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
  return null;
}

function transferFee(value: unknown): TransferFee | null {
  if (!isRecord(value)) return null;
  const epoch = integer(value.epoch);
  const basisPoints = integer(value.transferFeeBasisPoints);
  const maximumFee = integer(value.maximumFee);
  return epoch === null || basisPoints === null || maximumFee === null ? null : { epoch, basisPoints, maximumFee };
}

const chargesFee = (fee: TransferFee) => fee.basisPoints > 0n && fee.maximumFee > 0n;

/**
 * True when a Token-2022 mint's transfer-fee extension withholds part of a
 * transfer now, or will from an epoch already scheduled. Token-2022 credits the
 * destination with amount minus fee, so such a transfer can never verify. An
 * unreadable fee config counts as charging.
 */
async function chargesTransferFee(network: SolanaNetworkKey, mintInfo: unknown): Promise<boolean> {
  const extensions = isRecord(mintInfo) && Array.isArray(mintInfo.extensions) ? mintInfo.extensions : [];
  const config: unknown = extensions.find((entry) => isRecord(entry) && entry.extension === "transferFeeConfig");
  if (config === undefined) return false;
  const state = isRecord(config) && isRecord(config.state) ? config.state : null;
  const older = transferFee(state?.olderTransferFee);
  const newer = transferFee(state?.newerTransferFee);
  if (!older || !newer) return true;
  if (chargesFee(newer)) return true;
  if (!chargesFee(older)) return false;
  // Only the older fee charges, and it stays in force until the newer fee's epoch.
  const { epoch } = await solanaRpc(network)
    .getEpochInfo({ commitment: "confirmed" })
    .send({ abortSignal: rpcAbortSignal() });
  return BigInt(epoch) < newer.epoch;
}

/**
 * Reads the owning token program of a mint so Token-2022 mints transfer
 * correctly. Refuses Token-2022 mints that charge a transfer fee.
 */
export async function readMintProgram(
  network: SolanaNetworkKey,
  mint: string,
): Promise<{ program: Address; decimals: number }> {
  const info = await solanaRpc(network)
    .getAccountInfo(address(mint), { encoding: "jsonParsed", commitment: "confirmed" })
    .send({ abortSignal: rpcAbortSignal() });
  const value = info.value;
  if (!value) throw new SolanaProviderError("Token mint was not found on this network.", "SOLANA_MINT_NOT_FOUND", 422);
  const owner = String(value.owner);
  if (owner !== SOLANA_PROGRAMS.token && owner !== SOLANA_PROGRAMS.token2022) {
    throw new SolanaProviderError("Account is not an SPL token mint.", "SOLANA_MINT_INVALID", 422);
  }
  const data = value.data as unknown;
  const mintInfo =
    typeof data === "object" && data !== null && "parsed" in data
      ? (data as { parsed?: { info?: unknown } }).parsed?.info
      : undefined;
  const decimals = isRecord(mintInfo) ? Number(mintInfo.decimals) : NaN;
  if (!Number.isInteger(decimals)) throw new SolanaProviderError("Mint decimals unavailable.", "SOLANA_MINT_INVALID", 422);
  if (owner === SOLANA_PROGRAMS.token2022 && (await chargesTransferFee(network, mintInfo))) {
    throw new SolanaProviderError(
      "This Token-2022 mint charges a transfer fee, so the recipient would receive less than the amount sent. Fee-charging mints are not supported.",
      "TOKEN_TRANSFER_FEE_UNSUPPORTED",
      422,
    );
  }
  return { program: address(owner), decimals };
}

async function finalize(
  network: SolanaNetworkKey,
  feePayer: string,
  instructions: readonly Instruction[],
  lookupTables: readonly string[] = [],
): Promise<PreparedSolanaTransaction> {
  const rpc = solanaRpc(network);
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send({ abortSignal: rpcAbortSignal() });
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(address(feePayer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(blockhash, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft),
  );
  if (lookupTables.length > 0) {
    const tables = await fetchAddressesForLookupTables(lookupTables.map((table) => address(table)), rpc);
    message = compressTransactionMessageUsingAddressLookupTables(message, tables) as typeof message;
  }
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message));
  const simulation = await rpc
    .simulateTransaction(transaction, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    })
    .send({ abortSignal: rpcAbortSignal() })
    .then((result) => ({
      ok: result.value.err === null,
      unitsConsumed: result.value.unitsConsumed === undefined || result.value.unitsConsumed === null
        ? null
        : Number(result.value.unitsConsumed),
      error: result.value.err === null ? null : describeRpcError(result.value.err),
    }))
    .catch(() => ({ ok: false, unitsConsumed: null, error: "Simulation unavailable" }));
  return {
    transaction,
    lastValidBlockHeight: Number(blockhash.lastValidBlockHeight),
    simulation,
  };
}

function priorityInstructions(): Instruction[] {
  return [
    getSetComputeUnitLimitInstruction({ units: 120_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 50_000n }),
  ];
}

export interface TransferRequest {
  readonly network: SolanaNetworkKey;
  readonly from: string;
  readonly to: string;
  /** Mint address, or the wrapped-SOL mint / "SOL" for native SOL. */
  readonly mint: string;
  readonly amount: string;
  readonly decimals: number;
}

export async function buildSolanaTransfer(request: TransferRequest): Promise<PreparedSolanaTransaction> {
  if (!isSolanaAddress(request.from) || !isSolanaAddress(request.to)) {
    throw new SolanaProviderError("Sender and recipient must be Solana addresses.", "SOLANA_ADDRESS_INVALID", 400);
  }
  if (request.from === request.to) {
    throw new SolanaProviderError("Sender and recipient are the same account.", "SOLANA_SELF_TRANSFER", 400);
  }
  if (!isBaseUnitAmount(request.amount) || request.amount === "0") {
    throw new SolanaProviderError("Transfer amount must be positive.", "SOLANA_AMOUNT_INVALID", 400);
  }
  const signer = createNoopSigner(address(request.from));
  const isNative = request.mint === "SOL" || request.mint === WRAPPED_SOL_MINT;
  if (isNative) {
    await assertSolanaWalletRecipient(request.network, request.to);
    return finalize(request.network, request.from, [
      ...priorityInstructions(),
      getTransferSolInstruction({
        source: signer,
        destination: address(request.to),
        amount: lamports(BigInt(request.amount)),
      }),
    ]);
  }
  if (!isSolanaAddress(request.mint)) {
    throw new SolanaProviderError("Token mint must be a Solana address.", "SOLANA_MINT_INVALID", 400);
  }
  const mint = address(request.mint);
  const [, { program, decimals }] = await Promise.all([
    assertSolanaWalletRecipient(request.network, request.to),
    readMintProgram(request.network, request.mint),
  ]);
  if (decimals !== request.decimals) {
    throw new SolanaProviderError("Mint decimals do not match the reviewed asset.", "SOLANA_MINT_DECIMALS_MISMATCH", 422);
  }
  const tokenProgram = program === TOKEN_2022_PROGRAM_ADDRESS ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS;
  const [sourceAta] = await findAssociatedTokenPda({ owner: address(request.from), mint, tokenProgram });
  const [destinationAta] = await findAssociatedTokenPda({ owner: address(request.to), mint, tokenProgram });
  return finalize(request.network, request.from, [
    ...priorityInstructions(),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      ata: destinationAta,
      owner: address(request.to),
      mint,
      tokenProgram,
    }),
    getTransferCheckedInstruction(
      {
        source: sourceAta,
        mint,
        destination: destinationAta,
        authority: signer,
        amount: BigInt(request.amount),
        decimals,
      },
      { programAddress: tokenProgram },
    ),
  ]);
}

/** Provider-supplied instruction (Relay and similar solver networks). */
export interface ExternalSolanaInstruction {
  readonly programId: string;
  readonly keys: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  /** Hex-encoded instruction data. */
  readonly data: string;
}

export function toKitInstruction(instruction: ExternalSolanaInstruction): Instruction {
  if (!isSolanaAddress(instruction.programId)) {
    throw new SolanaProviderError("Provider instruction has an invalid program id.", "SOLANA_INSTRUCTION_INVALID");
  }
  if (!/^(?:[0-9a-fA-F]{2})*$/u.test(instruction.data)) {
    throw new SolanaProviderError("Provider instruction data must be hex.", "SOLANA_INSTRUCTION_INVALID");
  }
  return {
    programAddress: address(instruction.programId),
    accounts: instruction.keys.map((key) => {
      if (!isSolanaAddress(key.pubkey)) {
        throw new SolanaProviderError("Provider instruction has an invalid account.", "SOLANA_INSTRUCTION_INVALID");
      }
      return {
        address: address(key.pubkey),
        role: key.isSigner
          ? key.isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : key.isWritable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
      };
    }),
    data: Uint8Array.from(Buffer.from(instruction.data, "hex")),
  };
}

/**
 * Assemble provider instructions into an unsigned v0 transaction. Every
 * signer account must be the fee payer: Kletia never prepares a transaction
 * that needs an additional, unknown signature.
 */
export async function assembleSolanaTransaction(input: {
  network: SolanaNetworkKey;
  feePayer: string;
  instructions: readonly ExternalSolanaInstruction[];
  addressLookupTables?: readonly string[];
}): Promise<PreparedSolanaTransaction> {
  if (!isSolanaAddress(input.feePayer)) {
    throw new SolanaProviderError("Fee payer must be a Solana address.", "SOLANA_ADDRESS_INVALID", 400);
  }
  if (input.instructions.length === 0 || input.instructions.length > 24) {
    throw new SolanaProviderError("Provider returned an unexpected instruction count.", "SOLANA_INSTRUCTION_INVALID");
  }
  for (const instruction of input.instructions) {
    for (const key of instruction.keys) {
      if (key.isSigner && key.pubkey !== input.feePayer) {
        throw new SolanaProviderError("Provider instruction requires an unexpected signer.", "SOLANA_FOREIGN_SIGNER");
      }
    }
  }
  const tables = (input.addressLookupTables ?? []).filter(isSolanaAddress).slice(0, 8);
  return finalize(input.network, input.feePayer, input.instructions.map(toKitInstruction), tables);
}
