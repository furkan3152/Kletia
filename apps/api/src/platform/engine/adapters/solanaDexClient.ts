/** Operation-specific validation of venue-pinned exact-in Jupiter routes. */
import { createHash } from "node:crypto";
import { address, getAddressDecoder } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { venueContracts } from "@kletia/core";
import { swapMinimum, type SolanaDex, type SolanaDexQuote } from "../../../networks/solana/dexSwap.js";
import type { ExternalSolanaInstruction } from "../../../networks/solana/transactions.js";
import { PlatformError } from "../../errors.js";
import { bytesHex, computeBudgetMismatch, readSolanaAccounts, readU64, SOLANA_PROGRAM_IDS,
  type DecodedSolanaInstruction, type SolanaInstructionView } from "../chains/solana.js";

const ROUTE_DISCRIMINATOR = "e517cb977ae3ad2a";
const decoder = getAddressDecoder();

export interface DexPool {
  readonly address: string;
  readonly program: string;
  readonly label: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly vaultA: string;
  readonly vaultB: string;
  readonly config: string;
  readonly observation: string | null;
}

/** The addresses come only from core; each layout is checked against the deployed pool. */
function layout(dex: SolanaDex, label: string) {
  const pins = venueContracts(dex, "solana", "program");
  if (dex === "orca" && label === "Whirlpool") return { program: pins[0], account: "Whirlpool", mintA: 101, mintB: 181, vaultA: 133, vaultB: 213, config: 8, observation: null };
  if (dex === "raydium" && label === "Raydium CLMM") return { program: pins[0], account: "PoolState", mintA: 73, mintB: 105, vaultA: 137, vaultB: 169, config: 9, observation: 201 };
  if (dex === "raydium" && label === "Raydium CP") return { program: pins[1], account: "PoolState", mintA: 168, mintB: 200, vaultA: 72, vaultB: 104, config: 8, observation: 296 };
  throw new PlatformError("VENUE_UNVERIFIED", "The DEX pool uses an unsupported venue layout.", 422);
}

export async function readDexPool(dex: SolanaDex, label: string, pool: string, inputMint: string, outputMint: string): Promise<DexPool> {
  const format = layout(dex, label);
  const [state] = await readSolanaAccounts("solana", [pool]);
  const discriminator = createHash("sha256").update(`account:${format.account}`).digest("hex").slice(0, 16);
  if (!format.program || !state || state.executable || state.owner !== format.program ||
      bytesHex(state.data, 8) !== discriminator || state.data.length < Math.max(format.mintB, format.vaultB, format.observation ?? 0) + 32) {
    throw new PlatformError("VENUE_UNVERIFIED", "The quoted pool is not owned by the pinned DEX program or has an unreadable layout.", 422);
  }
  const mintA = String(decoder.decode(state.data.subarray(format.mintA, format.mintA + 32)));
  const mintB = String(decoder.decode(state.data.subarray(format.mintB, format.mintB + 32)));
  if (!((mintA === inputMint && mintB === outputMint) || (mintA === outputMint && mintB === inputMint))) {
    throw new PlatformError("VENUE_UNVERIFIED", "The pool's on-chain mints do not match the reviewed swap assets.", 422);
  }
  const key = (offset: number) => String(decoder.decode(state.data.subarray(offset, offset + 32)));
  return { address: pool, program: format.program, label, mintA, mintB, vaultA: key(format.vaultA), vaultB: key(format.vaultB),
    config: key(format.config), observation: format.observation === null ? null : key(format.observation) };
}

export async function dexTokenAccount(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(SOLANA_PROGRAM_IDS.token) });
  return String(ata);
}

export interface DexExpectation {
  readonly dex: SolanaDex;
  readonly owner: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inputAccount: string;
  readonly outputAccount: string;
  readonly inputNative: boolean;
  readonly outputNative: boolean;
  readonly amount: bigint;
  readonly minimum: bigint;
  readonly slippageBps: number;
  readonly quote?: SolanaDexQuote;
  readonly pool?: DexPool;
}

interface RouteData {
  readonly kind: number;
  readonly label: string;
  readonly amount: bigint;
  readonly quotedOut: bigint;
  readonly minimum: bigint;
  readonly slippageBps: number;
  readonly direction?: boolean;
}

/** One V1 route-plan entry. Unknown/future enum variants and extra bytes fail closed. */
export function decodeDexRouteData(data: Uint8Array, dex: SolanaDex): RouteData | null {
  if (data.length < 35 || bytesHex(data, 8) !== ROUTE_DISCRIMINATOR) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(8, true) !== 1) return null;
  let offset = 13;
  let label: string;
  let direction: boolean | undefined;
  const kind = data[12];
  if (dex === "raydium" && (kind === 26 || kind === 40)) label = "Raydium CLMM";
  else if (dex === "raydium" && kind === 46) label = "Raydium CP";
  else if (dex === "orca" && (kind === 17 || kind === 47)) {
    label = "Whirlpool";
    if (data[offset] !== 0 && data[offset] !== 1) return null;
    direction = data[offset++] === 1;
    // Classic SPL only: Token-2022 transfer-hook remaining-accounts slices are unsupported.
    if (kind === 47 && data[offset++] !== 0) return null;
  } else return null;
  if (data.length !== offset + 22 || data[offset] !== 100 || data[offset + 1] !== 0 || data[offset + 2] !== 1) return null;
  offset += 3;
  const amount = readU64(data, offset);
  const quotedOut = readU64(data, offset + 8);
  const slippageBps = view.getUint16(offset + 16, true);
  const feeBps = data[offset + 18];
  if (amount === null || amount <= 0n || quotedOut === null || quotedOut <= 0n || slippageBps < 1 || slippageBps > 300 || feeBps !== 0) return null;
  return { kind: kind as number, label, amount, quotedOut, slippageBps, minimum: swapMinimum(quotedOut, slippageBps), ...(direction !== undefined ? { direction } : {}) };
}

export function dexRouteMismatch(ix: SolanaInstructionView, expected: DexExpectation): string | null {
  const route = decodeDexRouteData(ix.data, expected.dex);
  if (ix.program !== SOLANA_PROGRAM_IDS.jupiterV6 || !route) return "is not a supported single-hop exact-in Jupiter route";
  if (route.amount !== expected.amount || route.slippageBps !== expected.slippageBps || route.minimum < expected.minimum) return "changes the input amount, slippage or minimum output";
  if (expected.quote && (route.label !== expected.quote.label || route.quotedOut !== BigInt(expected.quote.outAmount))) return "does not encode the reviewed DEX quote";
  const accounts = ix.accounts;
  if (accounts[0] !== SOLANA_PROGRAM_IDS.token || accounts[1] !== expected.owner || accounts[2] !== expected.inputAccount ||
      accounts[3] !== expected.outputAccount || accounts[4] !== SOLANA_PROGRAM_IDS.jupiterV6 || accounts[5] !== expected.outputMint ||
      accounts[6] !== SOLANA_PROGRAM_IDS.jupiterV6 || accounts[8] !== SOLANA_PROGRAM_IDS.jupiterV6) return "changes the token program, wallet, mint, token account or fee destination";
  const format = layout(expected.dex, route.label);
  if (accounts[9] !== format.program) return "invokes a foreign DEX program";
  if (expected.pool && (!accounts.slice(10).includes(expected.pool.address) || expected.pool.label !== route.label ||
      (route.direction !== undefined && route.direction !== (expected.inputMint === expected.pool.mintA)))) return "changes the reviewed pool or swap direction";
  if (expected.pool) {
    const pool = expected.pool;
    const inputIsA = pool.mintA === expected.inputMint;
    const inputVault = inputIsA ? pool.vaultA : pool.vaultB;
    const outputVault = inputIsA ? pool.vaultB : pool.vaultA;
    const ownerA = inputIsA ? expected.inputAccount : expected.outputAccount;
    const ownerB = inputIsA ? expected.outputAccount : expected.inputAccount;
    const require = (pins: readonly (readonly [number, string | null])[]) => pins.every(([index, value]) => value !== null && accounts[index] === value);
    if (route.kind === 26 || route.kind === 40) {
      if (!require([[10, expected.owner], [11, pool.config], [12, pool.address], [13, expected.inputAccount], [14, expected.outputAccount],
        [15, inputVault], [16, outputVault], [17, pool.observation], [18, SOLANA_PROGRAM_IDS.token]])) return "changes the CLMM authority, token account, vault or observation";
      if (route.kind === 40 && !require([[19, SOLANA_PROGRAM_IDS.token2022], [20, SOLANA_PROGRAM_IDS.memo], [21, expected.inputMint], [22, expected.outputMint]])) return "changes the CLMM V2 mint or token programs";
    } else if (route.kind === 46) {
      if (!require([[10, expected.owner], [12, pool.config], [13, pool.address], [14, expected.inputAccount], [15, expected.outputAccount],
        [16, inputVault], [17, outputVault], [18, SOLANA_PROGRAM_IDS.token], [19, SOLANA_PROGRAM_IDS.token],
        [20, expected.inputMint], [21, expected.outputMint], [22, pool.observation]])) return "changes the CP mint, token account, vault or observation";
    } else if (route.kind === 17) {
      if (!require([[10, SOLANA_PROGRAM_IDS.token], [11, expected.owner], [12, pool.address], [13, ownerA], [14, pool.vaultA], [15, ownerB], [16, pool.vaultB]])) return "changes the Whirlpool authority, token account or vault";
    } else if (route.kind === 47) {
      if (!require([[10, SOLANA_PROGRAM_IDS.token], [11, SOLANA_PROGRAM_IDS.token], [12, SOLANA_PROGRAM_IDS.memo], [13, expected.owner],
        [14, pool.address], [15, pool.mintA], [16, pool.mintB], [17, ownerA], [18, pool.vaultA], [19, ownerB], [20, pool.vaultB]])) return "changes the Whirlpool V2 authority, mint, token account or vault";
    }
  }
  return null;
}

function sameAccounts(ix: SolanaInstructionView, accounts: readonly string[]): boolean {
  return ix.accounts.length === accounts.length && ix.accounts.every((value, index) => value === accounts[index]);
}

/** Refuse arbitrary setup, transfers, approvals, closes, extra routes and other signers. */
export function checkDexInstructions(instructions: readonly SolanaInstructionView[], expected: DexExpectation): SolanaInstructionView {
  const reject = (message: string): never => { throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", `The DEX transaction ${message}.`, 502); };
  if (instructions.length === 0 || instructions.length > 16) reject("has an unexpected instruction count");
  let main: SolanaInstructionView | undefined;
  let wrapped = false;
  let synced = false;
  let closed = false;
  const budgets = new Set<number>();
  const created = new Set<string>();
  const nativeAccount = expected.inputNative ? expected.inputAccount : expected.outputNative ? expected.outputAccount : null;
  for (const ix of instructions) {
    const roles = (ix as Partial<DecodedSolanaInstruction>).metas;
    if (roles?.some((meta) => meta.signer && meta.address !== expected.owner)) reject("requires another signer");
    if (ix.program === SOLANA_PROGRAM_IDS.jupiterV6) {
      const why = dexRouteMismatch(ix, expected);
      if (main || why) reject(why ?? "contains more than one swap");
      if (roles && (!roles[1]?.signer || !roles[2]?.writable || !roles[3]?.writable)) reject("has invalid wallet or token-account roles");
      main = ix;
      continue;
    }
    if (ix.program === SOLANA_PROGRAM_IDS.computeBudget) {
      const why = computeBudgetMismatch(ix.data);
      if (main || why || ix.accounts.length !== 0 || budgets.has(ix.data[0] as number)) reject(why ?? "changes or duplicates the compute budget");
      budgets.add(ix.data[0] as number);
      continue;
    }
    if (ix.program === SOLANA_PROGRAM_IDS.associatedToken) {
      const mint = ix.accounts[1] === expected.inputAccount ? expected.inputMint : ix.accounts[1] === expected.outputAccount ? expected.outputMint : null;
      const ata = ix.accounts[1];
      if (main || !mint || !ata || created.has(ata) || ix.data.length > 1 || (ix.data.length === 1 && ix.data[0] !== 1) ||
          !sameAccounts(ix, [expected.owner, ata, expected.owner, mint, SOLANA_PROGRAM_IDS.system, SOLANA_PROGRAM_IDS.token])) reject("creates an unrelated token account");
      created.add(ata);
      continue;
    }
    if (ix.program === SOLANA_PROGRAM_IDS.system) {
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      if (main || wrapped || !expected.inputNative || ix.data.length !== 12 || view.getUint32(0, true) !== 2 ||
          readU64(ix.data, 4) !== expected.amount || !sameAccounts(ix, [expected.owner, expected.inputAccount])) reject("contains an unrelated SOL transfer");
      wrapped = true;
      continue;
    }
    if (ix.program === SOLANA_PROGRAM_IDS.token) {
      if (!main && !synced && nativeAccount && ix.data.length === 1 && ix.data[0] === 17 && sameAccounts(ix, [nativeAccount])) {
        if (expected.inputNative && !wrapped) reject("syncs SOL before funding it");
        synced = true;
        continue;
      }
      if (main && !closed && nativeAccount && ix.data.length === 1 && ix.data[0] === 9 &&
          sameAccounts(ix, [nativeAccount, expected.owner, expected.owner])) {
        closed = true;
        continue;
      }
      reject("contains an unrelated token operation or approval");
    }
    reject("invokes an unapproved top-level program");
  }
  if (!main || (expected.inputNative && (!wrapped || !synced)) || (nativeAccount && !closed)) reject("omits the swap or native-SOL setup/cleanup");
  return main as SolanaInstructionView;
}

export function externalDexViews(instructions: readonly ExternalSolanaInstruction[]): DecodedSolanaInstruction[] {
  return instructions.map((ix) => ({ program: ix.programId, accounts: ix.keys.map((key) => key.pubkey),
    metas: ix.keys.map((key) => ({ address: key.pubkey, signer: key.isSigner, writable: key.isWritable })), data: Uint8Array.from(Buffer.from(ix.data, "hex")) }));
}

/** Pool account in the official direct-route CPI account layouts (CLMM/Whirlpool/CP). */
export function dexRoutePool(ix: SolanaInstructionView, dex: SolanaDex): { label: string; pool: string } | null {
  const route = decodeDexRouteData(ix.data, dex);
  if (!route) return null;
  // CP: payer, authority, config, pool. Whirlpool V2 adds a second token program and a memo program.
  const pool = ix.accounts[route.kind === 47 ? 14 : route.label === "Raydium CP" ? 13 : 12];
  return pool ? { label: route.label, pool } : null;
}
