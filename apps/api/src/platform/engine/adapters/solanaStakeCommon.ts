/**
 * Shared pieces of the direct Solana staking adapters (protocols design 3.4):
 * SPL stake pools (Jito, Sanctum JupSOL), Marinade and native staking.
 *
 * - Every program and account the adapters touch is pinned in
 *   VENUE_CONTRACTS (`pinnedSolana`), or derived from a pin (PDAs, the user's
 *   associated token account) and cross-checked against the on-chain state.
 * - Liquid-staking deposits are quoted from the venue's own state and held to
 *   `STAKE_TOLERANCE_BPS` below that quote; verification proves the LST minted
 *   to the step account from the landed transaction's token deltas.
 * - Transactions are engine-built (`buildSolanaTransaction`): the wallet is
 *   the only signer and fee payer, and every prepared payload is simulated;
 *   a failing simulation refuses the prepare.
 */
import {
  formatAmount,
  fromBaseUnits,
  venueContracts,
  type AssetAmount,
  type IntentStep,
  type ProtocolId,
  type VenueContractRole,
} from "@kletia/core";
import { AccountRole, address as toAddress, getAddressDecoder, type Address, type Instruction } from "@solana/kit";
import { isSolanaNetworkKey, solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef } from "../assets.js";
import { buildSolanaTransaction, type SolanaTransactionObservation } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import type { AdapterAction, AdapterRoute, PreparedPayload, VerificationResult, VerifyContext } from "./types.js";
import { effectiveSolDelta, lowestPreparedFloor, SOL_RENT_TOLERANCE_LAMPORTS, stepOwner, tokenDelta, verifySolanaReferences } from "./verification.js";

/** Guaranteed output below the venue's own quote (rounding between plan and execution). */
export const STAKE_TOLERANCE_BPS = 5n;
/** Base fee plus the engine's priority fee for one staking transaction, in SOL. */
export const STAKE_NETWORK_FEE_SOL = 0.00002;
/** Seconds until a deposit's output is in the wallet. */
export const STAKE_ESTIMATED_SECONDS = 15;

export const STAKE_SYSVARS = Object.freeze({
  rent: "SysvarRent111111111111111111111111111111111",
  clock: "SysvarC1ock11111111111111111111111111111111",
  stakeHistory: "SysvarStakeHistory1111111111111111111111111",
  stakeConfig: "StakeConfig11111111111111111111111111111111",
});

const addressDecoder = getAddressDecoder();

/** The single pinned address of `role` for `protocol` on `network`; refuses a missing or ambiguous pin. */
export function pinnedSolana(protocol: ProtocolId, network: SolanaNetworkKey, role: VenueContractRole): string {
  const pins = venueContracts(protocol, network, role);
  if (pins.length !== 1) {
    throw new PlatformError("VENUE_INVALID", `${protocol} has ${pins.length === 0 ? "no" : "more than one"} pinned ${role} on ${network}.`, 500);
  }
  return pins[0] as string;
}

/** A 32-byte public key at `offset` (base58), or null when the data is too short. */
export function readPubkey(data: Uint8Array, offset: number): string | null {
  if (data.length < offset + 32) return null;
  return String(addressDecoder.decode(data.subarray(offset, offset + 32)));
}

/** Unsigned little-endian u64 at `offset`, or null when the data is too short. */
export function readU64Le(data: Uint8Array, offset: number): bigint | null {
  if (data.length < offset + 8) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

export function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function u32Le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function lessBps(value: bigint, bps: bigint): bigint {
  return (value * (10_000n - bps)) / 10_000n;
}

/** Account meta shorthand for engine-built instructions. */
export function meta(address: string, role: "w" | "r" | "ws" | "rs"): { address: Address; role: AccountRole } {
  const roles = { w: AccountRole.WRITABLE, r: AccountRole.READONLY, ws: AccountRole.WRITABLE_SIGNER, rs: AccountRole.READONLY_SIGNER } as const;
  return { address: toAddress(address), role: roles[role] };
}

export function instruction(program: string, accounts: ReturnType<typeof meta>[], data: Uint8Array): Instruction {
  return { programAddress: toAddress(program), accounts, data };
}

/** The current epoch of `network` (stake pools only take deposits once updated for it). */
export async function currentEpoch(network: SolanaNetworkKey): Promise<bigint> {
  try {
    const info = await solanaRpc(network).getEpochInfo({ commitment: "confirmed" }).send({ abortSignal: rpcAbortSignal() });
    return BigInt(info.epoch);
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The Solana RPC could not report the current epoch. Try again shortly.", 502);
  }
}

/**
 * Shape every liquid-staking deposit shares: a stake of native SOL on
 * `network` into `mint`, minted to the acting account itself.
 */
export function assertLiquidStakeAction(
  action: Pick<AdapterAction, "kind" | "network" | "destinationNetwork" | "input" | "output" | "amount" | "account" | "recipient">,
  label: string,
  symbol: string,
  mint: string,
  network: SolanaNetworkKey = "solana",
): bigint {
  if (action.kind !== "stake" || action.network !== network || action.destinationNetwork !== network) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${label} stakes SOL on ${network === "solana" ? "Solana mainnet" : network}.`, 422);
  }
  if (!action.input.isNative) throw new PlatformError("INTENT_UNSUPPORTED", `${label} stakes native SOL.`, 422);
  if (action.output.isNative || action.output.address !== mint) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${label} mints ${symbol}, not ${action.output.symbol}.`, 422);
  }
  if (action.recipient.address !== action.account.address) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${label} mints ${symbol} to the staking account; send it on with a separate "send" step.`, 422);
  }
  if (!/^\d+$/u.test(action.amount) || BigInt(action.amount) <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to stake.", 422);
  return BigInt(action.amount);
}

/** True for a route of native SOL into `mint` on Solana mainnet. */
export function liquidStakeRoute(route: AdapterRoute, mint: string): boolean {
  return (
    route.kind === "stake" &&
    route.network === "solana" &&
    route.destinationNetwork === "solana" &&
    route.input.isNative &&
    !route.output.isNative &&
    route.output.address === mint
  );
}

export async function stakeFeeUsd(network: SolanaNetworkKey): Promise<number | undefined> {
  const price = network === "solana" ? await nativeUsdPrice(network) : null;
  return price === null ? undefined : STAKE_NETWORK_FEE_SOL * price;
}

export function stakeTitle(amount: bigint, label: string, symbol: string | null, network: SolanaNetworkKey): string {
  const sol = formatAmount(fromBaseUnits(amount, 9));
  const where = network === "solana" ? "Solana" : "Solana Devnet";
  return symbol ? `Stake ${sol} SOL with ${label} for ${symbol} on ${where}` : `Stake ${sol} SOL with ${label} on ${where}`;
}

export function noUnstakeWarning(label: string, symbol: string): string {
  return `Kletia does not unstake ${symbol}: ${label} withdrawals go through its own program. To exit, swap it back (for example "swap 1 ${symbol} to SOL on solana"); the swap rate can sit below the staking rate.`;
}

export interface BuiltStake {
  readonly transaction: string;
  readonly lastValidBlockHeight: number;
  readonly warnings: string[];
}

/**
 * Compiles and simulates an engine-built staking transaction. A simulation
 * that fails refuses (SIMULATION_FAILED); an unavailable simulation at
 * prepare is disclosed as a warning (the wallet simulates before signing).
 */
export async function buildStakeTransaction(
  network: SolanaNetworkKey,
  owner: string,
  instructions: readonly Instruction[],
  computeUnits: number,
  what: string,
): Promise<BuiltStake> {
  const built = await buildSolanaTransaction(network, owner, instructions, computeUnits);
  const warnings: string[] = [];
  if (built.simulation && !built.simulation.ok) {
    throw new PlatformError(
      "SIMULATION_FAILED",
      `The ${what} would fail on-chain (${built.simulation.error.slice(0, 160)}). Check the SOL balance of the staking account.`,
      422,
    );
  }
  if (!built.simulation) warnings.push("Simulation was unavailable; the wallet will simulate before signing.");
  return { transaction: built.transaction, lastValidBlockHeight: built.lastValidBlockHeight, warnings };
}

/** One-transaction prepared payload of a staking step. */
export function stakePayload(
  network: SolanaNetworkKey,
  owner: string,
  program: string,
  built: BuiltStake,
  description: string,
  amounts: { input: AssetAmount; expectedOutput: AssetAmount; minimumOutput: AssetAmount },
  extra: { feesUsd?: number; quoteId?: string; extraCosts?: readonly AssetAmount[]; warnings?: readonly string[] } = {},
): PreparedPayload {
  return {
    transactions: [
      { vm: "svm", network, feePayer: owner, transaction: built.transaction, encoding: "base64", lastValidBlockHeight: built.lastValidBlockHeight, description },
    ],
    records: [{ vm: "svm", network, feePayer: owner, to: program, description }],
    ...amounts,
    ...(extra.feesUsd !== undefined ? { feesUsd: extra.feesUsd } : {}),
    ...(extra.quoteId ? { quoteId: extra.quoteId } : {}),
    ...(extra.extraCosts && extra.extraCosts.length > 0 ? { extraCosts: extra.extraCosts } : {}),
    warnings: [...built.warnings, ...(extra.warnings ?? [])],
  };
}

/**
 * Verifies a liquid-staking deposit: the landed transaction (fee-paid by the
 * step account, after the first prepare, invoking the prepared program) spent
 * the step's SOL from the step account and credited at least the lowest
 * guaranteed output of any payload prepared for the step in `mint`.
 * `bind` may reject a transaction whose instruction is not the prepared one.
 */
export async function verifyLiquidStake(
  context: VerifyContext,
  expected: { protocol: ProtocolId; label: string; mint: string; bind?: (step: IntentStep, observations: readonly SolanaTransactionObservation[]) => string | null },
): Promise<VerificationResult> {
  const { step } = context;
  const output = step.minimumOutput;
  const outputAsset = output ? assetFromRef(output) : null;
  if (
    step.kind !== "stake" ||
    step.protocol !== expected.protocol ||
    !isSolanaNetworkKey(step.network) ||
    !step.input ||
    !output ||
    !outputAsset ||
    outputAsset.address !== expected.mint
  ) {
    return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: `The step is not a ${expected.label} stake.` } };
  }
  const owner = stepOwner(step);
  const observed: { actual?: AssetAmount } = {};
  const { result } = await verifySolanaReferences(context, (observations) => {
    const mismatch = (message: string) => ({ failure: { code: "REFERENCE_MISMATCH", message } });
    const bound = expected.bind?.(step, observations);
    if (bound) return mismatch(bound);
    const spent = -effectiveSolDelta(observations, owner) + SOL_RENT_TOLERANCE_LAMPORTS;
    if (spent < BigInt(step.input?.amount ?? "0")) {
      return mismatch(`The transaction did not stake ${step.input?.formatted} SOL from the step account.`);
    }
    const received = tokenDelta(observations, owner, expected.mint);
    const floor = lowestPreparedFloor(step) ?? BigInt(output.amount);
    if (received <= 0n || received < floor) {
      return mismatch(`${expected.label} credited ${received} ${outputAsset.symbol} base units; the plan guaranteed at least ${floor}.`);
    }
    observed.actual = assetAmount(outputAsset, received.toString());
  });
  if (result.status === "confirmed" && observed.actual) return { ...result, actualOutput: observed.actual };
  return result;
}
