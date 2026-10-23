/**
 * Save (ex-Solend) adapter: deposit an SPL token into a pinned main-pool
 * reserve for its cToken, and redeem cTokens for an exact amount or the whole
 * position, on Solana mainnet.
 *
 * - Venues come only from YIELD_VENUES (`action.venue`); the reserve is read
 *   on-chain and must match its pins (saveClient.ts `readSaveReserve`).
 * - The engine builds the transaction: compute budget, idempotent creation of
 *   the step account's own token account for what it receives, RefreshReserve
 *   (with the oracles the reserve names) and one DepositReserveLiquidity /
 *   RedeemReserveCollateral. Single signer: the step account. No
 *   provider-built transaction is involved.
 * - Neither instruction takes a minimum: the plan quotes the cTokens (or the
 *   liquidity) at the reserve's stored rate, which only moves in the user's
 *   favour on a withdrawal and by accrued interest on a deposit, and holds
 *   the guarantee 10 bps below it (`floor: "claimed"`). Verification proves
 *   it from token deltas.
 * - Verification binds the landed transaction by its Save instruction
 *   (program, tag, every account, amount) and refuses one carrying any Save
 *   instruction besides RefreshReserve; the outcome is the step account's
 *   token deltas (exact liquidity spent and cTokens minted; or cTokens burned
 *   and liquidity received, never more than the burned cTokens are worth).
 */
import {
  findAssetBySymbol,
  formatAmount,
  formatAssetId,
  fromBaseUnits,
  getYieldVenue,
  yieldVenuesFor,
  type AssetAmount,
  type AssetDescriptor,
  type IntentStep,
  type ParsedAccountId,
  type SaveReserveVenue,
  type VenueCapacity,
  type VenuePosition,
  type YieldVenue,
} from "@kletia/core";
import type { Instruction } from "@solana/kit";
import { PlatformError } from "../../errors.js";
import { assetAmount, sameAsset, type ResolvedAsset } from "../assets.js";
import { assertSolanaTransactionOwner, buildSolanaTransaction, type SolanaInstructionView } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { decodeStepRef } from "../stepRef.js";
import { associatedTokenAccount, createOwnTokenAccount, readTokenBalance } from "./jupiterLendClient.js";
import {
  collateralForLiquidity,
  collateralForWithdrawal,
  collateralRate,
  depositInstruction,
  liquidityForCollateral,
  readSaveReserve,
  redeemInstruction,
  refreshReserveInstruction,
  SAVE_INSTRUCTION,
  saveInstructionMismatch,
  saveShareRate,
  totalLiquidityWads,
  type SaveReserveState,
  type SaveUserAccounts,
} from "./saveClient.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { lowestPreparedFloor, stepOwner, tokenDelta, verifySolanaReferences } from "./verification.js";

/** Rate drift tolerated between quote and execution (interest accrued by RefreshReserve). */
const RATE_TOLERANCE_BPS = 10n;
/** [ATA create, RefreshReserve, deposit / redeem]; simulated well below this on mainnet. */
const COMPUTE_UNITS = 200_000;
/** Base fee plus the engine's priority fee for one transaction, in SOL. */
const NETWORK_FEE_SOL = 0.000015;
const ESTIMATED_SECONDS = 10;
const WAD = 10n ** 18n;

type LendKind = "deposit" | "withdraw";

interface SaveContext {
  readonly venue: SaveReserveVenue;
  readonly kind: LendKind;
  readonly underlying: ResolvedAsset;
  readonly receipt: ResolvedAsset;
  readonly user: SaveUserAccounts;
}

function lessBps(value: bigint, bps: bigint): bigint {
  return (value * (10_000n - bps)) / 10_000n;
}

function format(units: bigint | string, asset: Pick<ResolvedAsset, "decimals" | "symbol">): string {
  return `${formatAmount(fromBaseUnits(units, asset.decimals))} ${asset.symbol}`;
}

/** The venue's underlying: a classic SPL token (the program transfers with the Token program only). */
function underlyingOf(venue: SaveReserveVenue): AssetDescriptor | null {
  const asset = findAssetBySymbol(venue.network, venue.asset);
  return asset && asset.address !== null && asset.tokenProgram !== "token-2022" ? asset : null;
}

function resolvedUnderlying(asset: AssetDescriptor): ResolvedAsset {
  return {
    network: asset.network,
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    address: asset.address,
    isNative: false,
    canonical: true,
    verified: true,
    category: asset.category,
    ...(asset.group ? { group: asset.group } : {}),
  };
}

/** The cToken as an asset (never in ASSETS: receipt symbols are ambiguous). */
function receiptAsset(venue: SaveReserveVenue): ResolvedAsset {
  return {
    network: venue.network,
    id: formatAssetId(venue.network, "token", venue.receipt.address),
    symbol: `c${venue.asset}`.slice(0, 16),
    name: `${venue.name} (cToken)`,
    decimals: venue.receipt.decimals,
    address: venue.receipt.address,
    isNative: false,
    canonical: false,
    verified: true,
  };
}

function venueServes(venue: SaveReserveVenue, route: AdapterRoute): boolean {
  const underlying = underlyingOf(venue);
  return underlying !== null && venue.actions.includes(route.kind as LendKind) && underlying.id === route.input.id;
}

async function userAccounts(owner: string, venue: SaveReserveVenue, mint: string): Promise<SaveUserAccounts> {
  const [liquidity, collateral] = await Promise.all([associatedTokenAccount(owner, mint), associatedTokenAccount(owner, venue.receipt.address)]);
  return { owner, liquidity, collateral };
}

async function saveContext(action: AdapterAction): Promise<SaveContext> {
  if (action.kind !== "deposit" && action.kind !== "withdraw") {
    throw new PlatformError("VENUE_INVALID", `The Save adapter received a ${action.kind} action.`, 500);
  }
  if (action.network !== "solana" || action.destinationNetwork !== "solana") {
    throw new PlatformError("NETWORK_UNSUPPORTED", "Save runs on Solana mainnet only.", 422);
  }
  const venue = getYieldVenue(action.venue ?? "");
  if (!venue || venue.kind !== "save-reserve" || venue.protocol !== "save" || venue.network !== "solana" || !venue.actions.includes(action.kind)) {
    throw new PlatformError("VENUE_INVALID", `The step's venue is not a Save reserve that takes ${action.kind}s.`, 500);
  }
  const underlying = underlyingOf(venue);
  if (!underlying || underlying.id !== action.input.id) {
    throw new PlatformError("VENUE_INVALID", `${venue.name} holds ${venue.asset}, not ${action.input.symbol}.`, 500);
  }
  if (action.recipient.address !== action.account.address) {
    throw new PlatformError("INTENT_UNSUPPORTED", `A ${action.kind} pays the acting account; send the result with a separate "send" step.`, 422);
  }
  return {
    venue,
    kind: action.kind,
    underlying: resolvedUnderlying(underlying),
    receipt: receiptAsset(venue),
    user: await userAccounts(action.account.address, venue, underlying.address as string),
  };
}

async function feeUsd(): Promise<number | undefined> {
  const price = await nativeUsdPrice("solana");
  return price === null ? undefined : NETWORK_FEE_SOL * price;
}

interface SaveQuote {
  /** Deposit: liquidity units. Withdraw: cTokens redeemed. */
  readonly instructionAmount: bigint;
  readonly input: AssetAmount;
  readonly expectedOutput: AssetAmount;
  readonly minimumOutput: AssetAmount;
  readonly title: string;
  readonly warnings: string[];
  readonly state: SaveReserveState;
}

async function quote(context: SaveContext, action: AdapterAction): Promise<SaveQuote> {
  const { venue, underlying, receipt } = context;
  const state = await readSaveReserve(venue, underlying.address as string);
  const rate = collateralRate(state);
  if (context.kind === "deposit") {
    const amount = BigInt(action.amount);
    if (amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "A Save deposit needs a positive amount.", 422);
    // The reserve refuses deposits past its limit (in liquidity units).
    const supplied = totalLiquidityWads(state) / WAD;
    if (supplied + amount > state.depositLimit) {
      const room = state.depositLimit > supplied ? state.depositLimit - supplied : 0n;
      throw new PlatformError("RESERVE_UNAVAILABLE", `${venue.name} takes ${format(room, underlying)} more before its deposit limit.`, 422);
    }
    const minted = collateralForLiquidity(rate, amount);
    if (minted <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${format(amount, underlying)} mints no ${receipt.symbol}.`, 422);
    return {
      instructionAmount: amount,
      input: assetAmount(underlying, amount.toString()),
      expectedOutput: assetAmount(receipt, minted.toString()),
      minimumOutput: assetAmount(receipt, lessBps(minted, RATE_TOLERANCE_BPS).toString()),
      title: `Deposit ${format(amount, underlying)} into ${venue.name}`,
      warnings: [`Creates your ${receipt.symbol} token account if it does not exist (about 0.002 SOL rent, paid by the account).`],
      state,
    };
  }
  const balance = await readTokenBalance("solana", context.user.owner, venue.receipt.address);
  const value = liquidityForCollateral(rate, balance);
  if (action.closePosition) {
    if (balance === 0n) throw new PlatformError("POSITION_EMPTY", `There is no ${underlying.symbol} position to withdraw at ${venue.name}.`, 422);
    if (value > state.available) {
      throw new PlatformError("RESERVE_UNAVAILABLE", `${venue.name} has ${format(state.available, underlying)} available to withdraw now; your position is ${format(value, underlying)}.`, 422);
    }
    // Interest accrued by RefreshReserve only raises what each cToken redeems for.
    return {
      instructionAmount: balance,
      input: assetAmount(underlying, value.toString()),
      expectedOutput: assetAmount(underlying, value.toString()),
      minimumOutput: assetAmount(underlying, (value > 1n ? value - 1n : 0n).toString()),
      title: `Withdraw all ${underlying.symbol} from ${venue.name} (about ${format(value, underlying)})`,
      warnings: [`Redeems all ${format(balance, receipt)}.`],
      state,
    };
  }
  const amount = BigInt(action.amount);
  const collateral = collateralForWithdrawal(rate, amount);
  if (collateral > balance) {
    throw new PlatformError("INSUFFICIENT_BALANCE", `Your ${venue.name} position is ${format(value, underlying)}; it cannot cover a ${format(amount, underlying)} withdrawal.`, 422);
  }
  if (amount > state.available) {
    throw new PlatformError("RESERVE_UNAVAILABLE", `${venue.name} has ${format(state.available, underlying)} available to withdraw now.`, 422);
  }
  return {
    instructionAmount: collateral,
    input: assetAmount(underlying, amount.toString()),
    expectedOutput: assetAmount(underlying, amount.toString()),
    minimumOutput: assetAmount(underlying, amount.toString()),
    title: `Withdraw ${format(amount, underlying)} from ${venue.name}`,
    warnings: [`Redeems ${format(collateral, receipt)}.`],
    state,
  };
}

/** [own token account for the credited token, RefreshReserve, deposit / redeem]. */
async function saveInstructions(context: SaveContext, saved: SaveQuote): Promise<Instruction[]> {
  const { venue, user, kind } = context;
  const credited = kind === "deposit" ? venue.receipt.address : (context.underlying.address as string);
  const main = kind === "deposit"
    ? depositInstruction(venue, user, saved.instructionAmount)
    : redeemInstruction(venue, user, saved.instructionAmount);
  return [await createOwnTokenAccount(user.owner, credited), refreshReserveInstruction(venue, saved.state), main];
}

function stepVenue(step: IntentStep): SaveReserveVenue | null {
  const venue = getYieldVenue(step.venue ?? "");
  return venue && venue.kind === "save-reserve" && venue.network === step.network && step.protocol === "save" ? venue : null;
}

function observedAmount(ref: Pick<AssetAmount, "asset" | "symbol" | "decimals">, units: bigint): AssetAmount {
  return { asset: ref.asset, symbol: ref.symbol, decimals: ref.decimals, amount: units.toString(), formatted: fromBaseUnits(units, ref.decimals) };
}

/* ---------------------------------------------------------- journey facts */

function reserveVenue(venue: YieldVenue): { venue: SaveReserveVenue; underlying: AssetDescriptor } {
  const underlying = venue.kind === "save-reserve" ? underlyingOf(venue) : null;
  if (venue.kind !== "save-reserve" || !underlying) throw new PlatformError("VENUE_INVALID", `${venue.name} is not a Save reserve with a pinned SPL underlying.`, 500);
  return { venue, underlying };
}

/** The account's cTokens at `venue`, valued at the reserve's stored rate; null when empty. */
export async function savePosition(venue: YieldVenue, owner: ParsedAccountId): Promise<VenuePosition | null> {
  const { venue: reserve, underlying } = reserveVenue(venue);
  const balance = await readTokenBalance("solana", owner.address, reserve.receipt.address);
  if (balance === 0n) return null;
  const state = await readSaveReserve(reserve, underlying.address as string);
  const rate = collateralRate(state);
  const value = liquidityForCollateral(rate, balance);
  const asset = resolvedUnderlying(underlying);
  return {
    venue: reserve.id,
    network: reserve.network,
    protocol: "save",
    name: reserve.name,
    receipt: assetAmount(receiptAsset(reserve), balance.toString()),
    underlying: assetAmount(asset, value.toString()),
    rate: saveShareRate(rate).toString(),
    usd: null,
    apy: null,
    withdrawableNow: assetAmount(asset, (value < state.available ? value : state.available).toString()),
    observedAt: new Date().toISOString(),
  };
}

/** Room under the deposit limit, liquidity available to withdraw and the cToken rate. */
export async function saveCapacity(venue: YieldVenue): Promise<VenueCapacity> {
  const { venue: reserve, underlying } = reserveVenue(venue);
  const state = await readSaveReserve(reserve, underlying.address as string);
  const supplied = totalLiquidityWads(state) / WAD;
  return {
    venue: reserve.id,
    capRemaining: (state.depositLimit > supplied ? state.depositLimit - supplied : 0n).toString(),
    exitLiquidity: state.available.toString(),
    paused: false,
    frozen: false,
    shareRate: saveShareRate(collateralRate(state)).toString(),
    observedAt: new Date().toISOString(),
    apy: null,
  };
}

export const saveAdapter: ProtocolAdapter = {
  id: "save",
  protocols: ["save"],
  label: "Save",

  supports(route) {
    if ((route.kind !== "deposit" && route.kind !== "withdraw") || route.network !== "solana" || route.destinationNetwork !== "solana") return false;
    if (!sameAsset(route.input, route.output) || route.input.isNative) return false;
    return yieldVenuesFor("solana", "save").some((venue) => venue.kind === "save-reserve" && venueServes(venue, route));
  },

  async plan(action): Promise<PlannedStep> {
    const context = await saveContext(action);
    const saved = await quote(context, action);
    const fees = await feeUsd();
    return {
      protocol: "save",
      title: saved.title,
      mode: "wallet",
      input: saved.input,
      expectedOutput: saved.expectedOutput,
      minimumOutput: saved.minimumOutput,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: ESTIMATED_SECONDS,
      settlement: { kind: "same-network" },
      warnings: saved.warnings,
      transactionCount: 1,
      slippageBps: Number(RATE_TOLERANCE_BPS),
      floor: "claimed",
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const context = await saveContext(action);
    const saved = await quote(context, action);
    const built = await buildSolanaTransaction("solana", context.user.owner, await saveInstructions(context, saved), COMPUTE_UNITS);
    if (built.simulation && !built.simulation.ok) {
      throw new PlatformError(
        "SIMULATION_FAILED",
        `The Save ${context.kind} would fail on-chain (${built.simulation.error.slice(0, 160)}). Check the account's ${context.kind === "deposit" ? context.underlying.symbol : context.receipt.symbol} balance.`,
        422,
      );
    }
    const info = assertSolanaTransactionOwner(built.transaction, context.user.owner);
    if (!info.programs.includes(context.venue.target)) {
      throw new PlatformError("TRANSFER_BUILD_FAILED", "The Save transaction does not invoke the pinned program.", 500);
    }
    const fees = await feeUsd();
    return {
      transactions: [
        {
          vm: "svm",
          network: "solana",
          feePayer: context.user.owner,
          transaction: built.transaction,
          encoding: "base64",
          lastValidBlockHeight: built.lastValidBlockHeight,
          description: saved.title,
        },
      ],
      records: [{ vm: "svm", network: "solana", feePayer: context.user.owner, to: context.venue.target, description: saved.title }],
      input: saved.input,
      expectedOutput: saved.expectedOutput,
      minimumOutput: saved.minimumOutput,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: built.simulation ? [] : ["Simulation was unavailable; the wallet will simulate before signing."],
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const venue = stepVenue(step);
    const underlying = venue ? underlyingOf(venue) : null;
    if (!venue || !underlying || !step.input || !step.minimumOutput || (step.kind !== "deposit" && step.kind !== "withdraw")) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The Save step has no registry venue or recorded amounts." } };
    }
    const kind: LendKind = step.kind;
    const owner = stepOwner(step);
    const mint = underlying.address as string;
    const user = await userAccounts(owner, venue, mint);
    // A redeem pays at most its cTokens' worth at the rate read now (at least the rate it ran at).
    let rate: bigint | null = null;
    if (kind === "withdraw") {
      try {
        rate = collateralRate(await readSaveReserve(venue, mint));
      } catch {
        return { status: "pending", evidence: [], reason: "The Save reserve could not be read yet.", stale: false };
      }
    }
    const amount = BigInt(step.input.amount);
    const closePosition = kind === "withdraw" && decodeStepRef(step.quoteRef)?.closePosition === true;
    const floor = lowestPreparedFloor(step) ?? BigInt(step.minimumOutput.amount);
    const minimum = step.minimumOutput;
    const observed: { actual?: AssetAmount } = {};
    const { result } = await verifySolanaReferences(context, (observations) => {
      const saves: SolanaInstructionView[] = observations.flatMap((observation) => observation.instructions ?? []).filter((entry) => entry.program === venue.target);
      const reasons = saves.map((entry) => saveInstructionMismatch(entry, { kind, venue, user, amount: kind === "deposit" ? amount : null }));
      const matched = saves.filter((_, index) => reasons[index] === null);
      if (matched.length !== 1) {
        const reason = matched.length > 1 ? "it carries more than one" : (reasons.find((entry) => entry !== null) ?? "it carries no Save instruction");
        return { failure: { code: "REFERENCE_MISMATCH", message: `The transaction is not this step's Save ${kind}: ${reason}.` } };
      }
      const main = matched[0] as SolanaInstructionView;
      // Any other Save instruction may only refresh: a borrow or another reserve's move would blur the deltas below.
      if (saves.some((entry) => entry !== main && !(entry.data.length === 1 && entry.data[0] === SAVE_INSTRUCTION.refreshReserve))) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The transaction carries Save instructions besides this step's ${kind} that move liquidity.` } };
      }
      const liquidityDelta = tokenDelta(observations, owner, mint);
      const receiptDelta = tokenDelta(observations, owner, venue.receipt.address);
      if (kind === "deposit") {
        if (-liquidityDelta !== amount) {
          return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The deposit did not move exactly ${step.input?.formatted} ${underlying.symbol} out of the step account.` } };
        }
        if (receiptDelta <= 0n || receiptDelta < floor) {
          return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The deposit did not credit at least ${fromBaseUnits(floor, minimum.decimals)} ${minimum.symbol} to the step account.` } };
        }
        observed.actual = observedAmount(minimum, receiptDelta);
        return;
      }
      const collateral = new DataView(main.data.buffer, main.data.byteOffset).getBigUint64(1, true);
      if (-receiptDelta !== collateral) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The withdrawal did not burn exactly the redeemed ${venue.name} cTokens from the step account.` } };
      }
      const worth = liquidityForCollateral(rate as bigint, collateral);
      const tolerance = worth / 1_000n + 2n;
      if (liquidityDelta <= 0n || liquidityDelta < floor || liquidityDelta > worth + tolerance || (!closePosition && worth + tolerance < floor)) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The withdrawal credited ${fromBaseUnits(liquidityDelta > 0n ? liquidityDelta : 0n, minimum.decimals)} ${underlying.symbol}; the step needs at least ${fromBaseUnits(floor, minimum.decimals)} and the redeemed cTokens are worth about ${fromBaseUnits(worth, minimum.decimals)}.` } };
      }
      observed.actual = observedAmount(minimum, liquidityDelta);
    });
    if (result.status === "confirmed" && observed.actual) return { ...result, actualOutput: observed.actual };
    return result;
  },

  positionOf: savePosition,
  venueCapacity: saveCapacity,
};
