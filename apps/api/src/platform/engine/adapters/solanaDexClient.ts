/**
 * Validation of venue-pinned exact-in Jupiter routes. Programs come from
 * the registry by Jupiter route label (`VENUE_CONTRACTS[].label`); pool
 * layouts are keyed by the same label and every offset was checked byte for
 * byte against deployed pools on 2026-10-14 (Raydium AMM v4 58oQ…LQo2,
 * Meteora DLMM HTvj…ashR and 5BKx…aqyF, Meteora DAMM v2 8Pm2…Pmie, Raydium
 * CLMM 8sLb…Lwxj and CYbD…tuxq, Whirlpool 83v8…5d6d and 7qbR…UJnm) and
 * against the account lists Jupiter's swap-instructions returned for them.
 */
import { createHash } from "node:crypto";
import { address, getAddressDecoder } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { VENUE_CONTRACTS, venueByLabel } from "@kletia/core";
import { swapMinimum, type SolanaDex, type SolanaDexQuote } from "../../../networks/solana/dexSwap.js";
import type { ExternalSolanaInstruction } from "../../../networks/solana/transactions.js";
import { PlatformError } from "../../errors.js";
import { bytesHex, computeBudgetMismatch, readSolanaAccounts, readU64, SOLANA_PROGRAM_IDS,
  type DecodedSolanaInstruction, type SolanaInstructionView } from "../chains/solana.js";

/** Anchor discriminator of Jupiter's V1 `route` instruction. */
const ROUTE_DISCRIMINATOR = "e517cb977ae3ad2a";
const decoder = getAddressDecoder();

/** Raydium AMM v4 authority (PDA "amm authority" of 675kPX…1Mp8), the same for every pool. */
export const RAYDIUM_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
/** Meteora DAMM v2 pool authority (PDA "pool_authority" of cpamdp…1sGG), the same for every pool. */
export const DAMM_V2_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";

/**
 * Jupiter `Swap` enum variants (V1 route plan) served per label, read from
 * the on-chain Jupiter v6 IDL: 17 Whirlpool { a_to_b }, 26 RaydiumClmm,
 * 38 MeteoraDlmm, 40 RaydiumClmmV2, 46 RaydiumCP, 47 WhirlpoolSwapV2
 * { a_to_b, remaining_accounts_info }, 105 RaydiumV2 (AMM v4 without the
 * OpenBook accounts), 108 MeteoraDammV2WithRemainingAccounts. Every other
 * variant (legacy Raydium 7 with OpenBook accounts, MeteoraDlmmSwapV2 75 with
 * Token-2022 slices, MeteoraDammV2 77, never seen live) fails closed.
 */
const KIND = { whirlpool: 17, clmm: 26, dlmm: 38, clmmV2: 40, cp: 46, whirlpoolV2: 47, ammV4: 105, dammV2: 108 } as const;

/** Byte offsets of one pool account layout. */
export interface PoolLayout {
  /** Anchor account name (8-byte discriminator); null for Raydium AMM v4 (no discriminator, exact size instead). */
  readonly account: string | null;
  /** Exact data length when the layout has no discriminator. */
  readonly size?: number;
  readonly mintA: number;
  readonly mintB: number;
  readonly vaultA: number;
  readonly vaultB: number;
  /** Config account (CLMM / CP amm_config, Whirlpool whirlpools_config). */
  readonly config: number | null;
  /** Observation (CLMM / CP) or oracle (DLMM) account. */
  readonly observation: number | null;
  /** Jupiter route-plan variants this label is executed with. */
  readonly kinds: readonly number[];
}

/**
 * Pool layouts keyed by Jupiter route label. A registry label without an
 * entry here is not quoted (refused and listed by `unverifiedDexLabels`).
 */
export const POOL_LAYOUTS: Readonly<Record<string, PoolLayout>> = Object.freeze({
  // AmmInfo (752 bytes): 16 u64 parameters, fees, PnL, swap totals, then base vault 336, quote vault 368, base mint 400, quote mint 432.
  "Raydium": { account: null, size: 752, mintA: 400, mintB: 432, vaultA: 336, vaultB: 368, config: null, observation: null, kinds: [KIND.ammV4] },
  "Raydium CLMM": { account: "PoolState", mintA: 73, mintB: 105, vaultA: 137, vaultB: 169, config: 9, observation: 201, kinds: [KIND.clmm, KIND.clmmV2] },
  "Raydium CP": { account: "PoolState", mintA: 168, mintB: 200, vaultA: 72, vaultB: 104, config: 8, observation: 296, kinds: [KIND.cp] },
  "Whirlpool": { account: "Whirlpool", mintA: 101, mintB: 181, vaultA: 133, vaultB: 213, config: 8, observation: null, kinds: [KIND.whirlpool, KIND.whirlpoolV2] },
  // LbPair: token_x_mint 88, token_y_mint 120, reserve_x 152, reserve_y 184, oracle 552.
  "Meteora DLMM": { account: "LbPair", mintA: 88, mintB: 120, vaultA: 152, vaultB: 184, config: null, observation: 552, kinds: [KIND.dlmm] },
  // Pool: token_a_mint 168, token_b_mint 200, token_a_vault 232, token_b_vault 264.
  "Meteora DAMM v2": { account: "Pool", mintA: 168, mintB: 200, vaultA: 232, vaultB: 264, config: null, observation: null, kinds: [KIND.dammV2] },
});

/** Registry labels of `dex` (Solana) that have a verified layout, in registry order. */
export function dexLabels(dex: SolanaDex): string[] {
  return VENUE_CONTRACTS.filter((entry) => entry.protocol === dex && entry.network === "solana" && entry.label !== undefined && POOL_LAYOUTS[entry.label])
    .map((entry) => entry.label as string);
}

/** Registry labels of `dex` without a verified layout (refused; reported by tests). */
export function unverifiedDexLabels(dex: SolanaDex): string[] {
  return VENUE_CONTRACTS.filter((entry) => entry.protocol === dex && entry.network === "solana" && entry.label !== undefined && !POOL_LAYOUTS[entry.label])
    .map((entry) => entry.label as string);
}

/** The layout and pinned program of a label, only when the registry assigns that label to `dex`. */
function layout(dex: SolanaDex, label: string): PoolLayout & { readonly program: string } {
  const venue = venueByLabel(label);
  const format = POOL_LAYOUTS[label];
  if (!venue || venue.protocol !== dex || venue.network !== "solana" || !format) {
    throw new PlatformError("VENUE_UNVERIFIED", "The DEX pool uses an unsupported venue layout.", 422);
  }
  return { ...format, program: venue.address };
}

function kindLabel(dex: SolanaDex, kind: number): string | null {
  for (const label of dexLabels(dex)) if (POOL_LAYOUTS[label]?.kinds.includes(kind)) return label;
  return null;
}

export interface DexPool {
  readonly address: string;
  readonly program: string;
  readonly label: string;
  readonly mintA: string;
  readonly mintB: string;
  readonly vaultA: string;
  readonly vaultB: string;
  readonly config: string | null;
  readonly observation: string | null;
}

/** Decodes a pool account (owner, discriminator or size, mints) without reading the chain. */
export function decodeDexPool(dex: SolanaDex, label: string, pool: string, state: { readonly owner: string; readonly executable?: boolean; readonly data: Uint8Array } | null): DexPool {
  const format = layout(dex, label);
  const end = Math.max(format.mintA, format.mintB, format.vaultA, format.vaultB, format.config ?? 0, format.observation ?? 0) + 32;
  const discriminator = format.account === null ? null : createHash("sha256").update(`account:${format.account}`).digest("hex").slice(0, 16);
  if (!state || state.executable || state.owner !== format.program || state.data.length < end ||
      (discriminator !== null && bytesHex(state.data, 8) !== discriminator) ||
      (format.size !== undefined && state.data.length !== format.size)) {
    throw new PlatformError("VENUE_UNVERIFIED", "The quoted pool is not owned by the pinned DEX program or has an unreadable layout.", 422);
  }
  const key = (offset: number) => String(decoder.decode(state.data.subarray(offset, offset + 32)));
  return { address: pool, program: format.program, label, mintA: key(format.mintA), mintB: key(format.mintB), vaultA: key(format.vaultA),
    vaultB: key(format.vaultB), config: format.config === null ? null : key(format.config), observation: format.observation === null ? null : key(format.observation) };
}

/** Reads the routed pool: owned by its label's program, its layout's discriminator (or size), and exactly the two swap mints. */
export async function readDexPool(dex: SolanaDex, label: string, pool: string, inputMint: string, outputMint: string): Promise<DexPool> {
  layout(dex, label);
  const [state] = await readSolanaAccounts("solana", [pool]);
  const decoded = decodeDexPool(dex, label, pool, state ?? null);
  if (!((decoded.mintA === inputMint && decoded.mintB === outputMint) || (decoded.mintA === outputMint && decoded.mintB === inputMint))) {
    throw new PlatformError("VENUE_UNVERIFIED", "The pool's on-chain mints do not match the reviewed swap assets.", 422);
  }
  return decoded;
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

/** One V1 route-plan entry of a label `dex` owns. Unknown or foreign enum variants and extra bytes fail closed. */
export function decodeDexRouteData(data: Uint8Array, dex: SolanaDex): RouteData | null {
  if (data.length < 35 || bytesHex(data, 8) !== ROUTE_DISCRIMINATOR) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(8, true) !== 1) return null;
  let offset = 13;
  let direction: boolean | undefined;
  const kind = data[12] as number;
  const label = kindLabel(dex, kind);
  if (!label) return null;
  if (kind === KIND.whirlpool || kind === KIND.whirlpoolV2) {
    if (data[offset] !== 0 && data[offset] !== 1) return null;
    direction = data[offset++] === 1;
    // Classic SPL only: Token-2022 transfer-hook remaining-accounts slices are unsupported.
    if (kind === KIND.whirlpoolV2 && data[offset++] !== 0) return null;
  }
  // percent 100, input index 0, output index 1, then u64 amount, u64 quoted out, u16 slippage, u8 platform fee.
  if (data.length !== offset + 22 || data[offset] !== 100 || data[offset + 1] !== 0 || data[offset + 2] !== 1) return null;
  offset += 3;
  const amount = readU64(data, offset);
  const quotedOut = readU64(data, offset + 8);
  const slippageBps = view.getUint16(offset + 16, true);
  const feeBps = data[offset + 18];
  if (amount === null || amount <= 0n || quotedOut === null || quotedOut <= 0n || slippageBps < 1 || slippageBps > 300 || feeBps !== 0) return null;
  return { kind, label, amount, quotedOut, slippageBps, minimum: swapMinimum(quotedOut, slippageBps), ...(direction !== undefined ? { direction } : {}) };
}

/** Index of the pool account in the instruction for a route-plan variant (the venue's CPI account list starts at 9). */
function poolIndex(kind: number): number {
  if (kind === KIND.whirlpoolV2) return 14;
  if (kind === KIND.cp) return 13;
  if (kind === KIND.ammV4 || kind === KIND.dammV2) return 11;
  if (kind === KIND.dlmm) return 10;
  return 12;
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
  if (expected.pool && (accounts[poolIndex(route.kind)] !== expected.pool.address || expected.pool.label !== route.label ||
      (route.direction !== undefined && route.direction !== (expected.inputMint === expected.pool.mintA)))) return "changes the reviewed pool or swap direction";
  if (expected.pool) {
    const pool = expected.pool;
    const inputIsA = pool.mintA === expected.inputMint;
    const inputVault = inputIsA ? pool.vaultA : pool.vaultB;
    const outputVault = inputIsA ? pool.vaultB : pool.vaultA;
    const ownerA = inputIsA ? expected.inputAccount : expected.outputAccount;
    const ownerB = inputIsA ? expected.outputAccount : expected.inputAccount;
    const token = SOLANA_PROGRAM_IDS.token;
    const require = (pins: readonly (readonly [number, string | null])[]) => pins.every(([index, value]) => value !== null && accounts[index] === value);
    if (route.kind === KIND.clmm || route.kind === KIND.clmmV2) {
      if (!require([[10, expected.owner], [11, pool.config], [12, pool.address], [13, expected.inputAccount], [14, expected.outputAccount],
        [15, inputVault], [16, outputVault], [17, pool.observation], [18, token]])) return "changes the CLMM authority, token account, vault or observation";
      if (route.kind === KIND.clmmV2 && !require([[19, SOLANA_PROGRAM_IDS.token2022], [20, SOLANA_PROGRAM_IDS.memo], [21, expected.inputMint], [22, expected.outputMint]])) return "changes the CLMM V2 mint or token programs";
    } else if (route.kind === KIND.cp) {
      if (!require([[10, expected.owner], [12, pool.config], [13, pool.address], [14, expected.inputAccount], [15, expected.outputAccount],
        [16, inputVault], [17, outputVault], [18, token], [19, token],
        [20, expected.inputMint], [21, expected.outputMint], [22, pool.observation]])) return "changes the CP mint, token account, vault or observation";
    } else if (route.kind === KIND.whirlpool) {
      if (!require([[10, token], [11, expected.owner], [12, pool.address], [13, ownerA], [14, pool.vaultA], [15, ownerB], [16, pool.vaultB]])) return "changes the Whirlpool authority, token account or vault";
    } else if (route.kind === KIND.whirlpoolV2) {
      if (!require([[10, token], [11, token], [12, SOLANA_PROGRAM_IDS.memo], [13, expected.owner],
        [14, pool.address], [15, pool.mintA], [16, pool.mintB], [17, ownerA], [18, pool.vaultA], [19, ownerB], [20, pool.vaultB]])) return "changes the Whirlpool V2 authority, mint, token account or vault";
    } else if (route.kind === KIND.ammV4) {
      // swap_base_in_v2: token program, amm, authority, coin vault, pc vault, user source, user destination, user owner.
      if (!require([[10, token], [11, pool.address], [12, RAYDIUM_AMM_AUTHORITY], [13, pool.vaultA], [14, pool.vaultB],
        [15, expected.inputAccount], [16, expected.outputAccount], [17, expected.owner]])) return "changes the Raydium AMM authority, token account or vault";
    } else if (route.kind === KIND.dlmm) {
      // lb_pair, bitmap extension (checked by the program), reserves, user accounts, mints, oracle, host fee (none), user, token programs.
      if (!require([[10, pool.address], [12, pool.vaultA], [13, pool.vaultB], [14, expected.inputAccount], [15, expected.outputAccount],
        [16, pool.mintA], [17, pool.mintB], [18, pool.observation], [19, format.program], [20, expected.owner], [21, token], [22, token]])) return "changes the DLMM reserve, oracle, mint, host fee or token account";
    } else if (route.kind === KIND.dammV2) {
      // pool authority, pool, user accounts, vaults, mints, payer, token programs, referral (none).
      if (!require([[10, DAMM_V2_POOL_AUTHORITY], [11, pool.address], [12, expected.inputAccount], [13, expected.outputAccount],
        [14, pool.vaultA], [15, pool.vaultB], [16, pool.mintA], [17, pool.mintB], [18, expected.owner], [19, token], [20, token],
        [21, format.program]])) return "changes the DAMM v2 authority, vault, mint, referral or token account";
    } else {
      return "is not a supported single-hop exact-in Jupiter route";
    }
  }
  return null;
}

function sameAccounts(ix: SolanaInstructionView, accounts: readonly string[]): boolean {
  return ix.accounts.length === accounts.length && ix.accounts.every((value, index) => value === accounts[index]);
}

/**
 * The provider's bundle, strictly: compute budget before the swap, the
 * wallet's own ATA creations, the exact SOL wrap / sync / close, and exactly
 * one Jupiter route. Arbitrary setup, transfers, approvals, closes, extra
 * routes and other signers are refused. Returns the route instruction.
 */
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
      created.add(ata as string);
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

/** The label and pool account the route instruction encodes, from the venue's CPI account layout. */
export function dexRoutePool(ix: SolanaInstructionView, dex: SolanaDex): { label: string; pool: string } | null {
  const route = decodeDexRouteData(ix.data, dex);
  if (!route) return null;
  const pool = ix.accounts[poolIndex(route.kind)];
  return pool ? { label: route.label, pool } : null;
}
