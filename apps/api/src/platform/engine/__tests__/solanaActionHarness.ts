/**
 * Solana Actions test doubles: kit-built unsigned transactions with chosen
 * instructions, program / program-data account images for pins, token
 * account images, an action transport returning canned responses, and RPC
 * handlers (accounts, lookup tables, simulateTransaction, blockhash, landed
 * transactions) on the shared JSON-RPC router.
 */
import { randomBytes } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { ActionTransport } from "../contracts/directory.js";
import type { RpcRouter } from "./contractHarness.js";

export const SOL_USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const SOL_OTHER = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
export const JUP6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const NOOP = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
export const ACME_PROGRAM = "6Ld9vWuj2dW1WJAxyukvuJ1zZM5cKgpkdaurKRt5T6iP";
export const ACME_HELPER = "5wvVJvxnru7C5MZKKaSdf6fBSKrBMBzNJRb3qo4FCknK";
export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE = "ComputeBudget111111111111111111111111111111";
export const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
export const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

export function randomAddress(): string {
  return getBase58Decoder().decode(randomBytes(32));
}

export interface TestInstruction {
  readonly program: string;
  readonly accounts?: readonly { readonly address: string; readonly role?: "signer" | "writable" | "readonly" | "writable-signer" }[];
  readonly data?: Uint8Array;
}

const ROLES = {
  signer: AccountRole.READONLY_SIGNER,
  "writable-signer": AccountRole.WRITABLE_SIGNER,
  writable: AccountRole.WRITABLE,
  readonly: AccountRole.READONLY,
} as const;

/** An unsigned transaction fee-paid by `feePayer` (v0 by default). */
export function buildTransaction(feePayer: string, instructions: readonly TestInstruction[], options: { readonly legacy?: boolean; readonly blockhash?: string } = {}): string {
  const message = pipe(
    createTransactionMessage({ version: options.legacy ? "legacy" : 0 }),
    (draft) => setTransactionMessageFeePayer(address(feePayer), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(options.blockhash ?? "11111111111111111111111111111111"), lastValidBlockHeight: 1_000n }, draft),
    (draft) => appendTransactionMessageInstructions(instructions.map((instruction) => ({
      programAddress: address(instruction.program),
      accounts: (instruction.accounts ?? []).map((account) => ({ address: address(account.address), role: ROLES[account.role ?? "readonly"] })),
      data: instruction.data ?? new Uint8Array(),
    })), draft),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message as never));
}

/** Fills the first signature slot with non-zero bytes (a pre-signed transaction). */
export function presign(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  bytes.fill(7, 1, 65);
  return bytes.toString("base64");
}

const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};
const u64 = (value: bigint) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};

export const ix = {
  systemTransfer: (from: string, to: string, lamports: bigint): TestInstruction => ({
    program: SYSTEM,
    accounts: [{ address: from, role: "writable-signer" }, { address: to, role: "writable" }],
    data: Buffer.concat([u32(2), u64(lamports)]),
  }),
  systemAssign: (account: string, owner: string): TestInstruction => ({
    program: SYSTEM,
    accounts: [{ address: account, role: "writable-signer" }],
    data: Buffer.concat([u32(1), Buffer.from(getAddressEncoder().encode(address(owner)))]),
  }),
  advanceNonce: (nonce: string, authority: string): TestInstruction => ({
    program: SYSTEM,
    accounts: [{ address: nonce, role: "writable" }, { address: "SysvarRecentB1ockHashes11111111111111111111" }, { address: authority, role: "signer" }],
    data: u32(4),
  }),
  tokenApprove: (source: string, delegate: string, owner: string): TestInstruction => ({
    program: TOKEN,
    accounts: [{ address: source, role: "writable" }, { address: delegate }, { address: owner, role: "signer" }],
    data: Buffer.concat([Buffer.from([4]), u64(1n)]),
  }),
  tokenSetAuthority: (account: string, owner: string): TestInstruction => ({
    program: TOKEN,
    accounts: [{ address: account, role: "writable" }, { address: owner, role: "signer" }],
    data: Buffer.from([6, 2, 0]),
  }),
  tokenTransfer: (source: string, destination: string, owner: string): TestInstruction => ({
    program: TOKEN,
    accounts: [{ address: source, role: "writable" }, { address: destination, role: "writable" }, { address: owner, role: "signer" }],
    data: Buffer.concat([Buffer.from([3]), u64(1n)]),
  }),
  closeAccount: (account: string, destination: string, owner: string): TestInstruction => ({
    program: TOKEN,
    accounts: [{ address: account, role: "writable" }, { address: destination, role: "writable" }, { address: owner, role: "signer" }],
    data: Buffer.from([9]),
  }),
  syncNative: (account: string): TestInstruction => ({ program: TOKEN, accounts: [{ address: account, role: "writable" }], data: Buffer.from([17]) }),
  initializeAccount3: (account: string, mint: string, owner: string): TestInstruction => ({
    program: TOKEN,
    accounts: [{ address: account, role: "writable" }, { address: mint }],
    data: Buffer.concat([Buffer.from([18]), Buffer.from(getAddressEncoder().encode(address(owner)))]),
  }),
  createAta: (payer: string, ata: string, owner: string, mint: string, kind = 1): TestInstruction => ({
    program: ATA,
    accounts: [{ address: payer, role: "writable-signer" }, { address: ata, role: "writable" }, { address: owner }, { address: mint }, { address: SYSTEM }, { address: TOKEN }],
    data: Buffer.from([kind]),
  }),
  computeUnits: (units: number): TestInstruction => ({ program: COMPUTE, data: Buffer.concat([Buffer.from([2]), u32(units)]) }),
  computePrice: (microLamports: bigint): TestInstruction => ({ program: COMPUTE, data: Buffer.concat([Buffer.from([3]), u64(microLamports)]) }),
  heapFrame: (bytes: number): TestInstruction => ({ program: COMPUTE, data: Buffer.concat([Buffer.from([1]), u32(bytes)]) }),
  program: (program: string, accounts: readonly string[] = [], data: Uint8Array = Buffer.from([1, 2, 3])): TestInstruction => ({
    program,
    accounts: accounts.map((entry) => ({ address: entry, role: "writable" as const })),
    data,
  }),
  memo: (text: string): TestInstruction => ({ program: MEMO, data: Buffer.from(text) }),
  lighthouse: (): TestInstruction => ({ program: LIGHTHOUSE, data: Buffer.from([9, 9]) }),
};

/* --------------------------------------------------------- account images */

export interface AccountImage {
  readonly owner: string;
  readonly lamports: bigint;
  readonly executable?: boolean;
  readonly data: Uint8Array;
}

/** Upgradeable program account and its program-data header. */
export function programImages(program: string, slot: bigint, authority: string | null): { program: AccountImage; programData: AccountImage; programDataAddress: string } {
  const programDataAddress = randomAddress();
  const programBytes = Buffer.concat([u32(2), Buffer.from(getAddressEncoder().encode(address(programDataAddress)))]);
  const header = Buffer.concat([u32(3), u64(slot), authority ? Buffer.concat([Buffer.from([1]), Buffer.from(getAddressEncoder().encode(address(authority)))]) : Buffer.from([0])]);
  void program;
  return {
    program: { owner: UPGRADEABLE_LOADER, lamports: 1_141_440n, executable: true, data: programBytes },
    programData: { owner: UPGRADEABLE_LOADER, lamports: 5_000_000_000n, data: header },
    programDataAddress,
  };
}

/** An SPL token account image (165 bytes). */
export function tokenAccountImage(mint: string, owner: string, amount: bigint, options: { delegate?: string; closeAuthority?: string } = {}): AccountImage {
  const data = Buffer.alloc(165);
  Buffer.from(getAddressEncoder().encode(address(mint))).copy(data, 0);
  Buffer.from(getAddressEncoder().encode(address(owner))).copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  if (options.delegate) {
    data.writeUInt32LE(1, 72);
    Buffer.from(getAddressEncoder().encode(address(options.delegate))).copy(data, 76);
  }
  data[108] = 1;
  if (options.closeAuthority) {
    data.writeUInt32LE(1, 129);
    Buffer.from(getAddressEncoder().encode(address(options.closeAuthority))).copy(data, 133);
  }
  return { owner: TOKEN, lamports: 2_039_280n, data };
}

export function walletImage(lamports: bigint): AccountImage {
  return { owner: SYSTEM, lamports, data: new Uint8Array() };
}

export function accountJson(image: AccountImage | null | undefined): unknown {
  if (!image) return null;
  return {
    data: [Buffer.from(image.data).toString("base64"), "base64"],
    executable: image.executable ?? false,
    lamports: Number(image.lamports),
    owner: image.owner,
    rentEpoch: 0,
    space: image.data.length,
  };
}

/** Installs getMultipleAccounts / getAccountInfo / getLatestBlockhash over account images. */
export function installSolanaAccounts(router: RpcRouter, accounts: Map<string, AccountImage>): void {
  const lookup = (key: unknown, slice?: { offset: number; length: number }) => {
    const image = accounts.get(String(key));
    if (!image) return null;
    return accountJson(slice ? { ...image, data: image.data.subarray(slice.offset, slice.offset + slice.length) } : image);
  };
  router.handlers.set("getMultipleAccounts", ([keys, config]) => ({
    context: { slot: 400_000_000 },
    value: (keys as unknown[]).map((entry) => lookup(entry, (config as { dataSlice?: { offset: number; length: number } })?.dataSlice)),
  }));
  router.handlers.set("getLatestBlockhash", () => ({
    context: { slot: 400_000_000 },
    value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 380_000_150 },
  }));
}

/* ----------------------------------------------------------- transport */

export interface CannedResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly json: unknown;
}

export class CannedTransport implements ActionTransport {
  readonly requests: { method: "get" | "post"; url: string; body?: unknown }[] = [];
  get: ActionTransport["get"];
  post: ActionTransport["post"];
  constructor(public responder: (method: "get" | "post", url: string, body?: unknown) => CannedResponse | Promise<CannedResponse>) {
    this.get = async (url) => {
      this.requests.push({ method: "get", url });
      const response = await this.responder("get", url);
      return { status: response.status ?? 200, headers: response.headers ?? {}, json: response.json };
    };
    this.post = async (url, body) => {
      this.requests.push({ method: "post", url, body });
      const response = await this.responder("post", url, body);
      return { status: response.status ?? 200, headers: response.headers ?? {}, json: response.json };
    };
  }
}

export { getAddressDecoder };
