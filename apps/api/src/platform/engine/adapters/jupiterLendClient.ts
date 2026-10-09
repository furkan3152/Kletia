/**
 * Jupiter Lend (Earn) client: rates from the Jupiter Lend API, the lending
 * state read on-chain, and strict checks of the deposit / withdraw / redeem
 * instructions the API returns.
 *
 * The API is untrusted. Its instruction is accepted only when the program,
 * signer, every pinned account (the step account's own token accounts, the
 * underlying and jlToken mints, the lending / lending-admin PDAs derived from
 * the pinned program, the liquidity program and the accounts the on-chain
 * lending state names) and the discriminator plus u64 amount all match. The
 * engine then builds the transaction itself (compute budget, idempotent
 * token-account creation, the checked instruction); no provider transaction
 * is ever forwarded. Rates and share prices from the API are advisory and are
 * cross-checked against the on-chain exchange price.
 */
import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  createNoopSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { isBaseUnitAmount, isSolanaAddress, type JupiterLendVenue } from "@kletia/core";
import { JUPITER_API_KEY, JUPITER_API_URL, solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { fetchProviderJson, isRecord } from "../../../networks/solana/http.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { bytesHex, readU64, SOLANA_PROGRAM_IDS } from "../chains/solana.js";

export type JupiterLendInstructionKind = "deposit" | "withdraw" | "redeem";

/** Anchor discriminators: sha256("global:<name>")[0..8], confirmed against live API instructions. */
export const JUPITER_LEND_DISCRIMINATORS: Readonly<Record<JupiterLendInstructionKind, string>> = Object.freeze({
  deposit: "f223c68952e1f2b6",
  withdraw: "b712469c946da122",
  redeem: "b80c569546c461e1",
});

/** sha256("account:Lending")[0..8]. */
const LENDING_ACCOUNT_DISCRIMINATOR = "87c75210f983b6f1";
const LENDING_ACCOUNT_BYTES = 196;
/** Exchange prices are fixed-point with 12 decimals. */
export const EXCHANGE_PRICE_PRECISION = 10n ** 12n;
const RATES_TTL_MS = 60_000;

const encoder = getAddressEncoder();
const decoder = getAddressDecoder();
const text = new TextEncoder();

/** Accounts derived from the pinned program for one venue (no RPC). */
export interface JupiterLendAccounts {
  readonly program: string;
  readonly lending: string;
  readonly lendingAdmin: string;
  readonly fTokenMint: string;
}

/**
 * PDAs of the venue under its pinned program: lending = ("lending", mint,
 * fTokenMint), lending admin = ("lending_admin"), fToken mint = ("f_token_mint",
 * mint). The registry's jlToken mint must equal the derived fToken mint.
 */
export async function jupiterLendAccounts(venue: JupiterLendVenue, underlyingMint: string): Promise<JupiterLendAccounts> {
  const programAddress = address(venue.target);
  const mint = encoder.encode(address(underlyingMint));
  const [fTokenMint] = await getProgramDerivedAddress({ programAddress, seeds: [text.encode("f_token_mint"), mint] });
  if (String(fTokenMint) !== venue.receipt.address) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s receipt mint is not the fToken mint the Jupiter Lend program derives for ${venue.asset}. Kletia will not use it.`, 422);
  }
  const [lending] = await getProgramDerivedAddress({ programAddress, seeds: [text.encode("lending"), mint, encoder.encode(fTokenMint)] });
  const [lendingAdmin] = await getProgramDerivedAddress({ programAddress, seeds: [text.encode("lending_admin")] });
  return { program: venue.target, lending: String(lending), lendingAdmin: String(lendingAdmin), fTokenMint: String(fTokenMint) };
}

export async function associatedTokenAccount(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return String(ata);
}

/** The venue's Lending account as stored on-chain. */
export interface JupiterLendingState {
  readonly mint: string;
  readonly fTokenMint: string;
  readonly decimals: number;
  readonly rewardsRateModel: string;
  readonly liquidityExchangePrice: bigint;
  /** jlToken -> underlying price (12 decimals) at the last update; only grows. */
  readonly tokenExchangePrice: bigint;
  readonly lastUpdateTimestamp: number;
  readonly tokenReservesLiquidity: string;
  readonly supplyPositionOnLiquidity: string;
}

async function accountBytes(network: SolanaNetworkKey, account: string): Promise<{ owner: string; data: Uint8Array } | null> {
  let value;
  try {
    ({ value } = await solanaRpc(network)
      .getAccountInfo(address(account), { encoding: "base64", commitment: "confirmed" })
      .send({ abortSignal: rpcAbortSignal() }));
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "A Solana account could not be read. Try again shortly.", 502);
  }
  if (!value) return null;
  const data = Array.isArray(value.data) ? Buffer.from(String(value.data[0] ?? ""), "base64") : Buffer.alloc(0);
  return { owner: String(value.owner), data: new Uint8Array(data) };
}

/** Reads and checks the venue's Lending account (owner, discriminator, mints). */
export async function readJupiterLending(network: SolanaNetworkKey, venue: JupiterLendVenue, accounts: JupiterLendAccounts, underlyingMint: string): Promise<JupiterLendingState> {
  const account = await accountBytes(network, accounts.lending);
  const data = account?.data;
  if (!account || account.owner !== venue.target || !data || data.length < LENDING_ACCOUNT_BYTES || bytesHex(data, 8) !== LENDING_ACCOUNT_DISCRIMINATOR) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s lending account is missing or not owned by the pinned Jupiter Lend program. Kletia will not use it.`, 422);
  }
  const key = (offset: number) => String(decoder.decode(data.subarray(offset, offset + 32)));
  const state: JupiterLendingState = {
    mint: key(8),
    fTokenMint: key(40),
    decimals: data[74] as number,
    rewardsRateModel: key(75),
    liquidityExchangePrice: readU64(data, 107) ?? 0n,
    tokenExchangePrice: readU64(data, 115) ?? 0n,
    lastUpdateTimestamp: Number(readU64(data, 123) ?? 0n),
    tokenReservesLiquidity: key(131),
    supplyPositionOnLiquidity: key(163),
  };
  if (state.mint !== underlyingMint || state.fTokenMint !== venue.receipt.address || state.decimals !== venue.receipt.decimals || state.tokenExchangePrice <= 0n) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s on-chain lending state does not match the pinned ${venue.asset} venue. Kletia will not use it.`, 422);
  }
  return state;
}

/**
 * SPL token balance of `owner`'s associated account for `mint` (0 when the
 * account does not exist). The account must be a classic SPL token account
 * of that mint and owner.
 */
export async function readTokenBalance(network: SolanaNetworkKey, owner: string, mint: string): Promise<bigint> {
  const ata = await associatedTokenAccount(owner, mint);
  const account = await accountBytes(network, ata);
  if (!account) return 0n;
  const { data } = account;
  if (account.owner !== SOLANA_PROGRAM_IDS.token || data.length < 72 || String(decoder.decode(data.subarray(0, 32))) !== mint || String(decoder.decode(data.subarray(32, 64))) !== owner) {
    throw new PlatformError("VENUE_UNVERIFIED", "The account's token position could not be read from its associated token account.", 422);
  }
  return readU64(data, 64) ?? 0n;
}

/** Advisory venue figures from the Jupiter Lend API (never used to authorise a transaction). */
export interface JupiterLendRates {
  /** jlToken units per 10^decimals underlying, at the API's fresh exchange price. */
  readonly convertToShares: bigint;
  /** Underlying units per 10^decimals jlToken. */
  readonly convertToAssets: bigint;
  readonly supplyRateBps: number;
  readonly rewardsRateBps: number;
  readonly totalRateBps: number;
  /** Underlying that can be withdrawn now (withdrawals are rate-limited). */
  readonly withdrawable: bigint | null;
}

let ratesCache: { expiresAt: number; rows: unknown[] } | null = null;

function apiHeaders(): Record<string, string> {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}

function units(value: unknown): bigint | null {
  return typeof value === "string" && isBaseUnitAmount(value) ? BigInt(value) : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

function bps(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 100_000 ? parsed : 0;
}

/** Drops the cached token list (tests). */
export function resetJupiterLendCache(): void {
  ratesCache = null;
}

/** The API's row for the venue's jlToken; it must name the pinned underlying mint and decimals. */
export async function readJupiterLendRates(venue: JupiterLendVenue, underlyingMint: string): Promise<JupiterLendRates> {
  if (!ratesCache || ratesCache.expiresAt <= Date.now()) {
    const body = await fetchProviderJson<unknown>(`${JUPITER_API_URL}/lend/v1/earn/tokens`, { provider: "Jupiter Lend", headers: apiHeaders() });
    ratesCache = { rows: Array.isArray(body) ? body : [], expiresAt: Date.now() + RATES_TTL_MS };
  }
  const row = ratesCache.rows.find((entry) => isRecord(entry) && entry.address === venue.receipt.address);
  if (!isRecord(row) || row.assetAddress !== underlyingMint || Number(row.decimals) !== venue.receipt.decimals) {
    throw new PlatformError("VENUE_UNVERIFIED", `Jupiter Lend does not list ${venue.name} with the pinned ${venue.asset} mint.`, 422);
  }
  const convertToShares = units(row.convertToShares);
  const convertToAssets = units(row.convertToAssets);
  if (convertToShares === null || convertToAssets === null || convertToShares === 0n || convertToAssets === 0n) {
    throw new PlatformError("VENUE_UNVERIFIED", `Jupiter Lend returned no share price for ${venue.name}.`, 422);
  }
  const supply = isRecord(row.liquiditySupplyData) ? row.liquiditySupplyData : {};
  return {
    convertToShares,
    convertToAssets,
    supplyRateBps: bps(row.supplyRate),
    rewardsRateBps: bps(row.rewardsRate),
    totalRateBps: bps(row.totalRate),
    withdrawable: units(supply.withdrawable),
  };
}

/** Raw instruction as the API returns it. */
interface ApiInstruction {
  readonly programId: string;
  readonly accounts: readonly { readonly pubkey: string; readonly isSigner: boolean; readonly isWritable: boolean }[];
  readonly data: Uint8Array;
}

function parseApiInstruction(body: unknown): ApiInstruction {
  const list = isRecord(body) && Array.isArray(body.instructions) ? body.instructions : null;
  const raw = list && list.length === 1 ? list[0] : null;
  if (!isRecord(raw) || typeof raw.programId !== "string" || !Array.isArray(raw.accounts) || typeof raw.data !== "string" || raw.data.length > 200) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Jupiter Lend returned an unexpected instruction set.", 502);
  }
  const accounts = raw.accounts.map((entry) => {
    if (!isRecord(entry) || typeof entry.pubkey !== "string" || !isSolanaAddress(entry.pubkey) || typeof entry.isSigner !== "boolean" || typeof entry.isWritable !== "boolean") {
      throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Jupiter Lend returned a malformed instruction account.", 502);
    }
    return { pubkey: entry.pubkey, isSigner: entry.isSigner, isWritable: entry.isWritable };
  });
  if (!/^[A-Za-z0-9+/]+=*$/u.test(raw.data)) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Jupiter Lend returned malformed instruction data.", 502);
  }
  return { programId: raw.programId, accounts, data: new Uint8Array(Buffer.from(raw.data, "base64")) };
}

/** Requests the venue instruction (`amount`: underlying for deposit / withdraw, jlToken shares for redeem). */
export async function fetchJupiterLendInstruction(kind: JupiterLendInstructionKind, underlyingMint: string, signer: string, amount: bigint): Promise<ApiInstruction> {
  const body = await fetchProviderJson<unknown>(`${JUPITER_API_URL}/lend/v1/earn/${kind}-instructions`, {
    provider: "Jupiter Lend",
    method: "POST",
    headers: { "content-type": "application/json", ...apiHeaders() },
    body: JSON.stringify(kind === "redeem"
      ? { asset: underlyingMint, signer, shares: amount.toString() }
      : { asset: underlyingMint, signer, amount: amount.toString() }),
    maxBytes: 32_000,
  });
  return parseApiInstruction(body);
}

/** Expected accounts of a lend instruction, by position. */
export interface JupiterLendExpectation {
  readonly kind: JupiterLendInstructionKind;
  readonly owner: string;
  readonly amount: bigint;
  readonly underlyingMint: string;
  readonly accounts: JupiterLendAccounts;
  /**
   * On-chain lending state, pinning the liquidity accounts it names. Null at
   * verify: those fields can be re-pointed by the protocol admin, so a landed
   * transaction is bound by the derived and owner accounts only.
   */
  readonly state: JupiterLendingState | null;
  readonly liquidityProgram: string;
  readonly ownerUnderlying: string;
  readonly ownerReceipt: string;
}

function statePins(state: JupiterLendingState | null, reserves: number, position: number, rewards: number): [number, string][] {
  return state
    ? [[reserves, state.tokenReservesLiquidity], [position, state.supplyPositionOnLiquidity], [rewards, state.rewardsRateModel]]
    : [];
}

/**
 * Account positions per instruction (from the program IDL, confirmed against
 * live API instructions): deposit has 17 accounts, withdraw / redeem 18.
 */
function pinnedPositions(expected: JupiterLendExpectation): { readonly length: number; readonly pins: ReadonlyMap<number, string> } {
  const { accounts, state } = expected;
  if (expected.kind === "deposit") {
    return {
      length: 17,
      pins: new Map([
        [0, expected.owner],
        [1, expected.ownerUnderlying],
        [2, expected.ownerReceipt],
        [3, expected.underlyingMint],
        [4, accounts.lendingAdmin],
        [5, accounts.lending],
        [6, accounts.fTokenMint],
        ...statePins(state, 7, 8, 13),
        [12, expected.liquidityProgram],
        [14, SOLANA_PROGRAM_IDS.token],
        [15, SOLANA_PROGRAM_IDS.associatedToken],
        [16, SOLANA_PROGRAM_IDS.system],
      ]),
    };
  }
  return {
    length: 18,
    pins: new Map([
      [0, expected.owner],
      [1, expected.ownerReceipt],
      [2, expected.ownerUnderlying],
      [3, accounts.lendingAdmin],
      [4, accounts.lending],
      [5, expected.underlyingMint],
      [6, accounts.fTokenMint],
      ...statePins(state, 7, 8, 14),
      [13, expected.liquidityProgram],
      [15, SOLANA_PROGRAM_IDS.token],
      [16, SOLANA_PROGRAM_IDS.associatedToken],
      [17, SOLANA_PROGRAM_IDS.system],
    ]),
  };
}

/**
 * Checks one lend instruction (from the API before building, or from a
 * landed transaction at verify): program, account count, every pinned
 * account, discriminator and u64 amount. Returns a reason when it does not
 * match, null when it does. `amount` null accepts any positive amount
 * (a redeem of the whole position, whose share count moves between prepares).
 */
export function lendInstructionMismatch(
  instruction: { readonly program: string; readonly accounts: readonly string[]; readonly data: Uint8Array },
  expected: Omit<JupiterLendExpectation, "amount"> & { readonly amount: bigint | null },
  program: string,
): string | null {
  if (instruction.program !== program) return "it does not invoke the pinned Jupiter Lend program";
  const { length, pins } = pinnedPositions({ ...expected, amount: expected.amount ?? 0n });
  if (instruction.accounts.length !== length) return `it has ${instruction.accounts.length} accounts, not ${length}`;
  for (const [index, pinned] of pins) {
    if (instruction.accounts[index] !== pinned) return `account ${index} is ${String(instruction.accounts[index]).slice(0, 44)}, not ${pinned}`;
  }
  if (instruction.data.length !== 16 || bytesHex(instruction.data, 8) !== JUPITER_LEND_DISCRIMINATORS[expected.kind]) {
    return `it is not a ${expected.kind} instruction`;
  }
  const amount = readU64(instruction.data, 8);
  if (amount === null || amount <= 0n || (expected.amount !== null && amount !== expected.amount)) {
    return `it encodes amount ${amount?.toString() ?? "?"}, not ${expected.amount?.toString() ?? "a positive amount"}`;
  }
  return null;
}

/**
 * Validates the API instruction and returns it as a kit instruction. Only the
 * step account may sign, and only as account 0.
 */
export function checkedLendInstruction(raw: ApiInstruction, expected: JupiterLendExpectation, venue: JupiterLendVenue): Instruction {
  const mismatch = lendInstructionMismatch(
    { program: raw.programId, accounts: raw.accounts.map((entry) => entry.pubkey), data: raw.data },
    expected,
    venue.target,
  );
  if (mismatch) {
    throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", `Jupiter Lend returned a ${expected.kind} instruction Kletia will not sign: ${mismatch}.`, 502);
  }
  raw.accounts.forEach((entry, index) => {
    if (entry.isSigner && index !== 0) {
      throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", "Jupiter Lend's instruction requires a signature from an account other than the step account.", 502);
    }
  });
  return {
    programAddress: address(raw.programId),
    accounts: raw.accounts.map((entry, index) => ({
      address: address(entry.pubkey),
      role: index === 0
        ? AccountRole.WRITABLE_SIGNER
        : entry.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: raw.data,
  };
}

/** Idempotent creation of `owner`'s associated token account for `mint`, paid by `owner`. */
export async function createOwnTokenAccount(owner: string, mint: string): Promise<Instruction> {
  const ata = await associatedTokenAccount(owner, mint);
  return getCreateAssociatedTokenIdempotentInstruction({
    payer: createNoopSigner(address(owner)),
    ata: address(ata),
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
}

/* ------------------------------------------------------------------ math */

/** jlToken minted for `assets` at `price` (the program rounds down). */
export function sharesForAssets(assets: bigint, price: bigint): bigint {
  return (assets * EXCHANGE_PRICE_PRECISION) / price;
}

/** Underlying paid out for `shares` at `price` (rounded down). */
export function assetsForShares(shares: bigint, price: bigint): bigint {
  return (shares * price) / EXCHANGE_PRICE_PRECISION;
}

/** `value` scaled by an API per-unit rate (units per 10^decimals). */
export function scaleByRate(value: bigint, rate: bigint, decimals: number): bigint {
  return (value * rate) / 10n ** BigInt(decimals);
}

/** sha256 prefix helper kept for tests that recompute discriminators. */
export function anchorDiscriminator(name: string): string {
  return createHash("sha256").update(name).digest().subarray(0, 8).toString("hex");
}
