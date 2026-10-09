/**
 * Kamino Lend (KLend) client: the pinned reserve read on-chain, the KTX
 * transaction API, and an allowlist check of every instruction a KTX
 * transaction carries.
 *
 * KTX builds complete v0 transactions whose reserve, market and vault
 * accounts are only reachable through address lookup tables. A transaction
 * is accepted only when, after resolving those tables:
 * - the step account is the fee payer and the only signer;
 * - every top-level instruction belongs to an allowlisted program and shape:
 *   compute budget (bounded price), the step account's own token-account
 *   creation, wrapped-SOL funding / sync / close of its own account, its own
 *   lookup table, memo, and KLend setup / refresh instructions;
 * - exactly one KLend deposit_v2 / withdraw_v2 instruction exists, naming the
 *   pinned market, market authority, reserve, the reserve's mint / vaults /
 *   collateral mint read from the reserve account, the step account's
 *   vanilla obligation and its own liquidity token account;
 * - the deposit amount equals the step amount exactly (KTX silently truncates
 *   extra decimals), and a withdrawal's collateral amount redeems for the
 *   requested amount at the reserve's on-chain exchange rate.
 * Anything else (a borrow, a transfer to another account, an unknown
 * program) refuses the payload.
 */
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { venueContracts, WRAPPED_SOL_MINT, type KaminoReserveVenue } from "@kletia/core";
import { KAMINO_API_URL, solanaRpc, SolanaProviderError, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { fetchProviderJson, isRecord } from "../../../networks/solana/http.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { bytesHex, computeBudgetMismatch, readU64, SOLANA_PROGRAM_IDS, type DecodedSolanaInstruction, type DecodedSolanaTransaction, type SolanaInstructionView } from "../chains/solana.js";

export type KaminoAction = "deposit" | "withdraw";

/** Anchor discriminators (sha256("global:<name>")[0..8]) of the KLend instructions KTX uses. */
export const KLEND_DISCRIMINATORS = Object.freeze({
  initUserMetadata: "75a9b045c5170fa2",
  initObligation: "fb0ae74c1b0b9f60",
  initObligationFarmsForReserve: "883f0fbad398a8a4",
  refreshReserve: "02da8aeb4fc91966",
  refreshObligation: "218493e497c04859",
  refreshObligationFarmsForReserve: "8c90fd150a4af803",
  deposit: "d8e0bf1bcc9766af",
  withdraw: "eb34779895c51407",
});

/** KLend instructions that only set up accounts or refresh state (they move no liquidity). */
export const SETUP_DISCRIMINATORS: ReadonlySet<string> = new Set<string>([
  KLEND_DISCRIMINATORS.initUserMetadata,
  KLEND_DISCRIMINATORS.initObligation,
  KLEND_DISCRIMINATORS.initObligationFarmsForReserve,
  KLEND_DISCRIMINATORS.refreshReserve,
  KLEND_DISCRIMINATORS.refreshObligation,
  KLEND_DISCRIMINATORS.refreshObligationFarmsForReserve,
]);

/** sha256("account:Reserve")[0..8]; the account is 8,624 bytes. */
const RESERVE_DISCRIMINATOR = "2bf2ccca1af73b7f";
const RESERVE_ACCOUNT_BYTES = 8_624;
const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
/** KLend scaled fractions are 60-bit fixed point. */
const FRACTION_ONE = 1n << 60n;
/** One token account's rent (1,488,440 lamports today) with headroom. */
const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_100_000n;

const decoder = getAddressDecoder();
const encoder = getAddressEncoder();

/** A reserve as stored on-chain (offsets verified against the live USDC and SOL reserves). */
export interface KaminoReserveState {
  readonly market: string;
  readonly liquidityMint: string;
  readonly supplyVault: string;
  readonly liquidityTokenProgram: string;
  readonly decimals: number;
  readonly collateralMint: string;
  readonly collateralVault: string;
  readonly collateralSupply: bigint;
  /** Total supplied liquidity (available + borrowed - fees), scaled by 2^60. */
  readonly totalLiquiditySf: bigint;
}

function u128(data: Uint8Array, offset: number): bigint {
  return (readU64(data, offset) ?? 0n) + ((readU64(data, offset + 8) ?? 0n) << 64n);
}

/**
 * Reads the pinned reserve and checks it against the registry: KLend owner,
 * Reserve discriminator, market, liquidity mint and (when pinned) supply vault.
 */
export async function readKaminoReserve(network: SolanaNetworkKey, venue: KaminoReserveVenue, liquidityMint: string): Promise<KaminoReserveState> {
  let value;
  try {
    ({ value } = await solanaRpc(network)
      .getAccountInfo(address(venue.reserve), { encoding: "base64", commitment: "confirmed" })
      .send({ abortSignal: rpcAbortSignal() }));
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The Kamino reserve could not be read. Try again shortly.", 502);
  }
  const data = value && Array.isArray(value.data) ? new Uint8Array(Buffer.from(String(value.data[0] ?? ""), "base64")) : null;
  if (!value || String(value.owner) !== venue.target || !data || data.length !== RESERVE_ACCOUNT_BYTES || bytesHex(data, 8) !== RESERVE_DISCRIMINATOR) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s reserve account is missing or not a KLend reserve. Kletia will not use it.`, 422);
  }
  const key = (offset: number) => String(decoder.decode(data.subarray(offset, offset + 32)));
  const available = readU64(data, 224) ?? 0n;
  const fees = u128(data, 344) + u128(data, 360) + u128(data, 376);
  const state: KaminoReserveState = {
    market: key(32),
    liquidityMint: key(128),
    supplyVault: key(160),
    decimals: Number(readU64(data, 272) ?? 0n),
    liquidityTokenProgram: key(408),
    collateralMint: key(2560),
    collateralSupply: readU64(data, 2592) ?? 0n,
    collateralVault: key(2600),
    totalLiquiditySf: available * FRACTION_ONE + u128(data, 232) - fees,
  };
  if (
    state.market !== venue.market ||
    state.liquidityMint !== liquidityMint ||
    (venue.supplyVault !== undefined && state.supplyVault !== venue.supplyVault) ||
    state.totalLiquiditySf <= 0n ||
    state.collateralSupply <= 0n
  ) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s on-chain reserve does not match the pinned market, mint or vault. Kletia will not use it.`, 422);
  }
  return state;
}

/** Collateral minted for `liquidity` at the reserve's stored rate (rounded down). */
export function collateralForLiquidity(state: KaminoReserveState, liquidity: bigint): bigint {
  return (liquidity * state.collateralSupply * FRACTION_ONE) / state.totalLiquiditySf;
}

/** Liquidity redeemed for `collateral` at the reserve's stored rate (rounded down; the live rate only grows). */
export function liquidityForCollateral(state: KaminoReserveState, collateral: bigint): bigint {
  return (collateral * state.totalLiquiditySf) / (state.collateralSupply * FRACTION_ONE);
}

/** The step account's vanilla obligation: PDA(tag 0, id 0, owner, market, default, default). */
export async function vanillaObligation(venue: KaminoReserveVenue, owner: string): Promise<string> {
  const [obligation] = await getProgramDerivedAddress({
    programAddress: address(venue.target),
    seeds: [new Uint8Array([0]), new Uint8Array([0]), encoder.encode(address(owner)), encoder.encode(address(venue.market)), encoder.encode(address(DEFAULT_PUBKEY)), encoder.encode(address(DEFAULT_PUBKEY))],
  });
  return String(obligation);
}

export async function liquidityTokenAccount(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) });
  return String(ata);
}

/**
 * Requests a KTX transaction. `amount` is a decimal string in whole units of
 * the reserve's token. A withdrawal without a Kamino obligation is
 * POSITION_EMPTY.
 */
export async function fetchKaminoTransaction(kind: KaminoAction, request: { readonly wallet: string; readonly venue: KaminoReserveVenue; readonly amount: string }): Promise<string> {
  let body: unknown;
  try {
    body = await fetchProviderJson<unknown>(`${KAMINO_API_URL}/ktx/klend/${kind}`, {
      provider: "Kamino",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: request.wallet, market: request.venue.market, reserve: request.venue.reserve, amount: request.amount }),
      maxBytes: 64_000,
    });
  } catch (error) {
    if (kind === "withdraw" && error instanceof SolanaProviderError && /obligation does not exist|OBLIGATION_NOT_FOUND/iu.test(error.message)) {
      throw new PlatformError("POSITION_EMPTY", `There is no Kamino position to withdraw from ${request.venue.name}.`, 422);
    }
    throw error;
  }
  if (!isRecord(body) || typeof body.transaction !== "string" || body.transaction.length === 0) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Kamino returned no transaction.", 502);
  }
  return body.transaction;
}

/** What the step's KTX transaction must do. */
export interface KaminoExpectation {
  readonly kind: KaminoAction;
  readonly owner: string;
  readonly venue: KaminoReserveVenue;
  readonly reserve: KaminoReserveState;
  readonly obligation: string;
  /** The step account's token account for the reserve mint (a wrapped-SOL account for SOL). */
  readonly ownerLiquidity: string;
  /** Deposit: liquidity units, exact. Withdraw: requested liquidity units (the collateral is bounded by rate). */
  readonly amount: bigint;
}

/** Pinned accounts of deposit_v2 / withdraw_v2 by position (17 accounts each). */
function mainPins(expected: Omit<KaminoExpectation, "amount">): ReadonlyMap<number, string> {
  const { reserve, venue } = expected;
  const [farms] = venueContracts("kamino", venue.network, "farms-program");
  const shared: [number, string][] = [
    [0, expected.owner],
    [1, expected.obligation],
    [2, venue.market],
    [3, venue.marketAuthority],
    [4, venue.reserve],
    [5, reserve.liquidityMint],
    [7, reserve.collateralMint],
    [9, expected.ownerLiquidity],
    [10, venue.target],
    [11, SOLANA_PROGRAM_IDS.token],
    [12, reserve.liquidityTokenProgram],
    [13, INSTRUCTIONS_SYSVAR],
    ...(farms ? [[16, farms] as [number, string]] : []),
  ];
  return new Map(expected.kind === "deposit"
    ? [...shared, [6, reserve.supplyVault], [8, reserve.collateralVault]]
    : [...shared, [6, reserve.collateralVault], [8, reserve.supplyVault]]);
}

/**
 * Checks a KLend main instruction (unsigned payload or landed transaction):
 * program, discriminator, 17 accounts with every pinned position, and a
 * positive u64 amount (exactly `amount` for a deposit when given). Returns
 * a reason, or null when it matches.
 */
export function kaminoInstructionMismatch(instruction: SolanaInstructionView, expected: Omit<KaminoExpectation, "amount"> & { readonly amount: bigint | null }): string | null {
  if (instruction.program !== expected.venue.target) return "it does not invoke the pinned KLend program";
  const discriminator = expected.kind === "deposit" ? KLEND_DISCRIMINATORS.deposit : KLEND_DISCRIMINATORS.withdraw;
  if (instruction.data.length !== 16 || bytesHex(instruction.data, 8) !== discriminator) return `it is not a KLend ${expected.kind}`;
  if (instruction.accounts.length !== 17) return `it has ${instruction.accounts.length} accounts, not 17`;
  for (const [index, pinned] of mainPins(expected)) {
    if (instruction.accounts[index] !== pinned) return `account ${index} is ${String(instruction.accounts[index]).slice(0, 44)}, not ${pinned}`;
  }
  const amount = readU64(instruction.data, 8);
  if (amount === null || amount <= 0n) return "it encodes no amount";
  if (expected.kind === "deposit" && expected.amount !== null && amount !== expected.amount) {
    return `it deposits ${amount.toString()} units, not ${expected.amount.toString()}`;
  }
  return null;
}

export interface CheckedKaminoTransaction {
  readonly main: DecodedSolanaInstruction;
  /** Deposit: liquidity units. Withdraw: collateral units burned. */
  readonly instructionAmount: bigint;
  /** The transaction creates the step account's Kamino user metadata / obligation (first deposit, about 0.03 SOL rent). */
  readonly createsObligation: boolean;
}

function reject(reason: string): never {
  throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", `Kamino returned a transaction Kletia will not sign: ${reason}.`, 502);
}

function u32(data: Uint8Array): number | null {
  return data.length >= 4 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) : null;
}

/**
 * Allowlist check of a decoded KTX transaction (see the module comment).
 * Returns the main instruction, its amount and whether it sets up a new
 * obligation; throws PROVIDER_TRANSACTION_REJECTED otherwise.
 */
export function checkKaminoTransaction(decoded: DecodedSolanaTransaction, expected: KaminoExpectation): CheckedKaminoTransaction {
  const { owner, reserve } = expected;
  if (decoded.feePayer !== owner || decoded.signers.length !== 1 || decoded.signers[0] !== owner) reject("it is not fee-paid and signed solely by the step account");
  const wrapsSol = reserve.liquidityMint === WRAPPED_SOL_MINT;
  const tokenPrograms = new Set<string>([SOLANA_PROGRAM_IDS.token, SOLANA_PROGRAM_IDS.token2022]);
  let main: DecodedSolanaInstruction | null = null;
  let createsObligation = false;
  for (const [index, instruction] of decoded.instructions.entries()) {
    const { program, accounts, data } = instruction;
    const at = `instruction ${index}`;
    if (program === SOLANA_PROGRAM_IDS.computeBudget) {
      const budget = computeBudgetMismatch(data);
      if (budget) reject(`${at} ${budget}`);
    } else if (program === SOLANA_PROGRAM_IDS.system) {
      // Only wrapped-SOL funding: the step account into its own wrapped-SOL account.
      const lamports = readU64(data, 4);
      const ceiling = (expected.kind === "deposit" ? expected.amount : 0n) + TOKEN_ACCOUNT_RENT_LAMPORTS;
      if (!wrapsSol || u32(data) !== 2 || data.length !== 12 || accounts[0] !== owner || accounts[1] !== expected.ownerLiquidity || lamports === null || lamports > ceiling) {
        reject(`${at} moves SOL somewhere other than the step account's own wrapped-SOL account`);
      }
    } else if (program === SOLANA_PROGRAM_IDS.associatedToken) {
      if (!(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) reject(`${at} is not a token-account creation`);
      if (accounts[0] !== owner || accounts[1] !== expected.ownerLiquidity || accounts[2] !== owner || accounts[3] !== reserve.liquidityMint || accounts[5] !== reserve.liquidityTokenProgram) {
        reject(`${at} creates a token account other than the step account's own ${expected.venue.asset} account`);
      }
    } else if (tokenPrograms.has(program)) {
      const syncNative = data.length === 1 && data[0] === 17 && accounts.length === 1 && accounts[0] === expected.ownerLiquidity;
      const close = data.length === 1 && data[0] === 9 && accounts[0] === expected.ownerLiquidity && accounts[1] === owner && accounts[2] === owner;
      if (!wrapsSol || !(syncNative || close)) reject(`${at} is a token instruction other than wrapping or unwrapping the step account's SOL`);
    } else if (program === SOLANA_PROGRAM_IDS.addressLookupTable) {
      const kind = u32(data);
      if ((kind !== 0 && kind !== 2) || accounts[1] !== owner || accounts[2] !== owner) reject(`${at} touches a lookup table the step account does not own`);
    } else if (program === SOLANA_PROGRAM_IDS.memo) {
      // Memos carry no value.
    } else if (program === expected.venue.target) {
      const discriminator = bytesHex(data, 8);
      if (discriminator === KLEND_DISCRIMINATORS.deposit || discriminator === KLEND_DISCRIMINATORS.withdraw) {
        if (main) reject("it carries more than one KLend deposit or withdrawal");
        main = instruction;
        continue;
      }
      if (!SETUP_DISCRIMINATORS.has(discriminator)) reject(`${at} is a KLend instruction other than setup, refresh or the ${expected.kind}`);
      if (discriminator === KLEND_DISCRIMINATORS.initObligation) {
        // Vanilla obligation only (tag 0, id 0), owned by the step account.
        if (data.length !== 10 || data[8] !== 0 || data[9] !== 0 || accounts[0] !== owner || accounts[2] !== expected.obligation) reject(`${at} creates an obligation other than the step account's vanilla obligation`);
        createsObligation = true;
      }
      if (discriminator === KLEND_DISCRIMINATORS.initUserMetadata) {
        if (accounts[0] !== owner) reject(`${at} creates user metadata for another account`);
        createsObligation = true;
      }
    } else {
      reject(`${at} invokes ${program.slice(0, 44)}, which is not allowlisted`);
    }
  }
  if (!main) return reject(`it carries no KLend ${expected.kind}`);
  const mismatch = kaminoInstructionMismatch(main, expected);
  if (mismatch) reject(`its ${expected.kind}: ${mismatch}`);
  const checkedMain = main as DecodedSolanaInstruction;
  const signers = checkedMain.metas.filter((meta) => meta.signer).map((meta) => meta.address);
  if (signers.some((signer) => signer !== owner)) reject("its main instruction requires another signer");
  const instructionAmount = readU64(checkedMain.data, 8) as bigint;
  if (expected.kind === "withdraw") {
    // The collateral must redeem for the requested amount at the on-chain rate (KTX converts; the rate only grows).
    const value = liquidityForCollateral(reserve, instructionAmount);
    const tolerance = expected.amount / 1_000n + 2n;
    if (value + tolerance < expected.amount || value > expected.amount + tolerance) {
      reject(`its withdrawal redeems about ${value.toString()} units, not the requested ${expected.amount.toString()}`);
    }
  }
  return { main: checkedMain, instructionAmount, createsObligation };
}
