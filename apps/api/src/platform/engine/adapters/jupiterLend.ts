/**
 * Jupiter Lend Earn adapter: deposit an SPL token into its jlToken vault and
 * withdraw it (an exact amount, or the whole position by redeeming every
 * jlToken share) on Solana mainnet.
 *
 * - Venues come only from YIELD_VENUES (`action.venue`); the lending, lending
 *   admin and jlToken mint accounts are derived from the pinned program and
 *   the on-chain Lending account must agree with the registry.
 * - The engine builds the transaction: compute budget, idempotent creation of
 *   the step account's own token account, and the one Jupiter Lend instruction
 *   the API returns after every account, the discriminator and the amount
 *   were checked (jupiterLendClient.ts). Single signer: the step account.
 * - Verification binds the landed transaction by that instruction (program,
 *   pinned accounts, discriminator, amount) and proves the outcome from the
 *   step account's token deltas: the exact underlying spent and jlToken
 *   minted (deposit), or the underlying received and jlToken burned (withdraw).
 */
import {
  findAssetBySymbol,
  formatAmount,
  formatAssetId,
  fromBaseUnits,
  getYieldVenue,
  isBaseUnitAmount,
  yieldVenuesFor,
  type AssetAmount,
  type AssetDescriptor,
  type IntentStep,
  type JupiterLendVenue,
  type PreparedStepRecord,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { assetAmount, sameAsset, type ResolvedAsset } from "../assets.js";
import { assertSolanaTransactionOwner, buildSolanaTransaction, type SolanaInstructionView } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { decodeStepRef } from "../stepRef.js";
import {
  assetsForShares,
  associatedTokenAccount,
  checkedLendInstruction,
  createOwnTokenAccount,
  fetchJupiterLendInstruction,
  jupiterLendAccounts,
  lendInstructionMismatch,
  readJupiterLending,
  readJupiterLendRates,
  readTokenBalance,
  scaleByRate,
  sharesForAssets,
  type JupiterLendAccounts,
  type JupiterLendExpectation,
  type JupiterLendInstructionKind,
  type JupiterLendingState,
  type JupiterLendRates,
} from "./jupiterLendClient.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { stepOwner, tokenDelta, verifySolanaReferences } from "./verification.js";

/** Share-price drift tolerated between quote and execution (the deposit instruction has no minimum-out). */
const SHARE_TOLERANCE_BPS = 10n;
/** Largest gap tolerated between the API's fresh share price and the on-chain price of the last update. */
const PRICE_AGREEMENT_BPS = 100n;
/** Compute units for [ATA create, lend instruction]; simulated at about 63k. */
const COMPUTE_UNITS = 200_000;
/** Base fee plus the engine's priority fee for one transaction, in SOL. */
const NETWORK_FEE_SOL = 0.000015;
const ESTIMATED_SECONDS = 10;

type LendKind = "deposit" | "withdraw";

interface LendContext {
  readonly venue: JupiterLendVenue;
  readonly kind: LendKind;
  readonly owner: string;
  readonly underlying: ResolvedAsset;
  readonly mint: string;
  readonly receipt: ResolvedAsset;
  readonly accounts: JupiterLendAccounts;
}

function lessBps(value: bigint, bps: bigint): bigint {
  return (value * (10_000n - bps)) / 10_000n;
}

function format(units: bigint | string, asset: Pick<ResolvedAsset, "decimals" | "symbol">): string {
  return `${formatAmount(fromBaseUnits(units, asset.decimals))} ${asset.symbol}`;
}

function underlyingOf(venue: JupiterLendVenue): AssetDescriptor | null {
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

/** The jlToken as an asset (never in ASSETS: receipt symbols are ambiguous). */
function receiptAsset(venue: JupiterLendVenue): ResolvedAsset {
  return {
    network: venue.network,
    id: formatAssetId(venue.network, "token", venue.receipt.address),
    symbol: `jl${venue.asset}`.slice(0, 16),
    name: `${venue.name} (jlToken)`,
    decimals: venue.receipt.decimals,
    address: venue.receipt.address,
    isNative: false,
    canonical: false,
    verified: true,
  };
}

function venueServes(venue: JupiterLendVenue, route: AdapterRoute): boolean {
  const underlying = underlyingOf(venue);
  return underlying !== null && venue.actions.includes(route.kind as LendKind) && underlying.id === route.input.id;
}

/**
 * The planner-resolved venue re-validated against the registry: kind,
 * protocol, network, executable action and underlying. Anything else is an
 * engine bug (500); a native SOL input is a 422 (jlWSOL is discovery-only).
 */
async function lendContext(action: AdapterAction): Promise<LendContext> {
  if (action.kind !== "deposit" && action.kind !== "withdraw") {
    throw new PlatformError("VENUE_INVALID", `The Jupiter Lend adapter received a ${action.kind} action.`, 500);
  }
  if (action.network !== "solana" || action.destinationNetwork !== "solana") {
    throw new PlatformError("NETWORK_UNSUPPORTED", "Jupiter Lend runs on Solana mainnet only.", 422);
  }
  const venue = getYieldVenue(action.venue ?? "");
  if (!venue || venue.kind !== "jupiter-lend" || venue.protocol !== "jupiter-lend" || venue.network !== "solana" || !venue.actions.includes(action.kind)) {
    throw new PlatformError("VENUE_INVALID", `The step's venue is not a Jupiter Lend venue that takes ${action.kind}s.`, 500);
  }
  if (action.input.isNative) {
    throw new PlatformError("INTENT_UNSUPPORTED", "Jupiter Lend deposits and withdrawals take SPL tokens; swap SOL into USDC or USDT first.", 422);
  }
  const underlying = underlyingOf(venue);
  if (!underlying || underlying.id !== action.input.id) {
    throw new PlatformError("VENUE_INVALID", `${venue.name} holds ${venue.asset}, not ${action.input.symbol}.`, 500);
  }
  if (action.recipient.address !== action.account.address) {
    throw new PlatformError("INTENT_UNSUPPORTED", `A ${action.kind} pays the acting account; send the result with a separate "send" step.`, 422);
  }
  const mint = underlying.address as string;
  return {
    venue,
    kind: action.kind,
    owner: action.account.address,
    underlying: resolvedUnderlying(underlying),
    mint,
    receipt: receiptAsset(venue),
    accounts: await jupiterLendAccounts(venue, mint),
  };
}

async function expectation(context: LendContext, kind: JupiterLendInstructionKind, amount: bigint, state: JupiterLendingState | null): Promise<JupiterLendExpectation> {
  return {
    kind,
    owner: context.owner,
    amount,
    underlyingMint: context.mint,
    accounts: context.accounts,
    state,
    liquidityProgram: context.venue.liquidityProgram,
    ownerUnderlying: await associatedTokenAccount(context.owner, context.mint),
    ownerReceipt: await associatedTokenAccount(context.owner, context.venue.receipt.address),
  };
}

function apyNote(rates: JupiterLendRates): string[] {
  if (rates.totalRateBps <= 0) return [];
  const percent = (value: number) => `${(value / 100).toFixed(2)}%`;
  const parts = rates.rewardsRateBps > 0 ? ` (${percent(rates.supplyRateBps)} supply + ${percent(rates.rewardsRateBps)} rewards)` : "";
  return [`Variable yield: about ${percent(rates.totalRateBps)} APY${parts} at planning; not guaranteed.`];
}

async function feeUsd(): Promise<number | undefined> {
  const price = await nativeUsdPrice("solana");
  return price === null ? undefined : NETWORK_FEE_SOL * price;
}

/** The amounts and the checked instruction of one lend action (plan and prepare share it). */
interface LendQuote {
  readonly instructionKind: JupiterLendInstructionKind;
  /** Instruction amount: underlying (deposit / withdraw) or jlToken shares (redeem). */
  readonly instructionAmount: bigint;
  readonly input: AssetAmount;
  readonly expectedOutput: AssetAmount;
  readonly minimumOutput: AssetAmount;
  readonly title: string;
  readonly warnings: string[];
  readonly expected: JupiterLendExpectation;
  readonly rates: JupiterLendRates;
}

async function quote(context: LendContext, action: AdapterAction): Promise<LendQuote> {
  const { venue, underlying, receipt, owner } = context;
  const [rates, state] = await Promise.all([
    readJupiterLendRates(venue, context.mint),
    readJupiterLending("solana", venue, context.accounts, context.mint),
  ]);
  const warnings = apyNote(rates);
  if (context.kind === "deposit") {
    const amount = BigInt(action.amount);
    // The on-chain price only grows, so the last-update price bounds the shares from above.
    const ceiling = sharesForAssets(amount, state.tokenExchangePrice);
    const quoted = scaleByRate(amount, rates.convertToShares, underlying.decimals);
    // The API rounds its per-unit rate to whole units: allow that rounding on top of the on-chain bound.
    const rounding = amount / 10n ** BigInt(underlying.decimals) + 1n;
    if (quoted > ceiling + rounding || quoted < lessBps(ceiling, PRICE_AGREEMENT_BPS)) {
      throw new PlatformError("VENUE_UNVERIFIED", `Jupiter Lend's share price for ${venue.name} disagrees with the on-chain exchange price. Kletia will not quote it.`, 422);
    }
    if (quoted <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${format(amount, underlying)} mints no ${receipt.symbol}.`, 422);
    const expected = await expectation(context, "deposit", amount, state);
    warnings.push(`Creates your ${receipt.symbol} token account if it does not exist (about 0.002 SOL rent, paid by the account).`);
    return {
      instructionKind: "deposit",
      instructionAmount: amount,
      input: assetAmount(underlying, amount.toString()),
      expectedOutput: assetAmount(receipt, quoted.toString()),
      minimumOutput: assetAmount(receipt, lessBps(quoted, SHARE_TOLERANCE_BPS).toString()),
      title: `Deposit ${format(amount, underlying)} into ${venue.name}`,
      warnings,
      expected,
      rates,
    };
  }
  const shares = await readTokenBalance("solana", owner, venue.receipt.address);
  // Value of the position: the API's fresh price, bounded by the on-chain last-update price.
  const floorValue = assetsForShares(shares, state.tokenExchangePrice);
  const freshValue = scaleByRate(shares, rates.convertToAssets, receipt.decimals);
  // The API's per-unit rate is rounded down to whole units, so it may sit just below the on-chain value.
  const rounding = shares / 10n ** BigInt(receipt.decimals) + 1n;
  if (shares > 0n && (freshValue + rounding < floorValue || freshValue > floorValue + (floorValue * PRICE_AGREEMENT_BPS) / 10_000n + rounding)) {
    throw new PlatformError("VENUE_UNVERIFIED", `Jupiter Lend's share price for ${venue.name} disagrees with the on-chain exchange price. Kletia will not quote it.`, 422);
  }
  const value = freshValue > floorValue ? freshValue : floorValue;
  if (action.closePosition) {
    const empty = assetAmount(underlying, "0");
    if (shares === 0n) {
      const expected = await expectation(context, "redeem", 0n, state);
      return { instructionKind: "redeem", instructionAmount: 0n, input: empty, expectedOutput: empty, minimumOutput: empty, title: `Withdraw all ${underlying.symbol} from ${venue.name}`, warnings, expected, rates };
    }
    if (rates.withdrawable !== null && floorValue > rates.withdrawable) {
      throw new PlatformError("RESERVE_UNAVAILABLE", `${venue.name} can release ${format(rates.withdrawable, underlying)} right now (withdrawals are rate-limited); your position is ${format(value, underlying)}. Withdraw a smaller amount or try later.`, 422);
    }
    // Sized at the on-chain price of the last update: redeeming at the (higher) current price pays at least this.
    const minimum = floorValue > 1n ? floorValue - 1n : 0n;
    return {
      instructionKind: "redeem",
      instructionAmount: shares,
      input: assetAmount(underlying, floorValue.toString()),
      expectedOutput: assetAmount(underlying, floorValue.toString()),
      minimumOutput: assetAmount(underlying, minimum.toString()),
      title: `Withdraw all ${underlying.symbol} from ${venue.name} (about ${format(floorValue, underlying)})`,
      warnings: [...warnings, `Redeems all ${format(shares, receipt)}.`],
      expected: await expectation(context, "redeem", shares, state),
      rates,
    };
  }
  const amount = BigInt(action.amount);
  if (amount > value) {
    throw new PlatformError("INSUFFICIENT_BALANCE", `Your ${venue.name} position is ${format(value, underlying)}; it cannot cover a ${format(amount, underlying)} withdrawal.`, 422);
  }
  if (rates.withdrawable !== null && amount > rates.withdrawable) {
    throw new PlatformError("RESERVE_UNAVAILABLE", `${venue.name} can release ${format(rates.withdrawable, underlying)} right now (withdrawals are rate-limited). Withdraw a smaller amount or try later.`, 422);
  }
  return {
    instructionKind: "withdraw",
    instructionAmount: amount,
    input: assetAmount(underlying, amount.toString()),
    expectedOutput: assetAmount(underlying, amount.toString()),
    minimumOutput: assetAmount(underlying, (amount - 1n).toString()),
    title: `Withdraw ${format(amount, underlying)} from ${venue.name}`,
    warnings,
    expected: await expectation(context, "withdraw", amount, state),
    rates,
  };
}

/** Fetches the API instruction for the quote and checks it (plan and prepare). */
async function checkedInstruction(context: LendContext, lend: LendQuote) {
  const raw = await fetchJupiterLendInstruction(lend.instructionKind, context.mint, context.owner, lend.instructionAmount);
  return checkedLendInstruction(raw, lend.expected, context.venue);
}

/** The registry venue a recorded step executes against (verify). */
function stepVenue(step: IntentStep): JupiterLendVenue | null {
  const venue = getYieldVenue(step.venue ?? "");
  return venue && venue.kind === "jupiter-lend" && venue.network === step.network && step.protocol === "jupiter-lend" ? venue : null;
}

/** The lowest output guarantee of any payload prepared for the step (current minimum and recorded prepare floors). */
function lowestFloor(step: IntentStep): bigint | null {
  const values = [step.minimumOutput?.amount, ...(decodeStepRef(step.quoteRef)?.floors ?? []).map((floor) => floor.min)]
    .filter((value): value is string => isBaseUnitAmount(value))
    .map((value) => BigInt(value));
  return values.length > 0 ? values.reduce((low, value) => (value < low ? value : low)) : null;
}

function observedAmount(ref: Pick<AssetAmount, "asset" | "symbol" | "decimals">, units: bigint): AssetAmount {
  return { asset: ref.asset, symbol: ref.symbol, decimals: ref.decimals, amount: units.toString(), formatted: fromBaseUnits(units, ref.decimals) };
}

export const jupiterLendAdapter: ProtocolAdapter = {
  id: "jupiter-lend",
  protocols: ["jupiter-lend"],
  label: "Jupiter Lend",

  supports(route) {
    if ((route.kind !== "deposit" && route.kind !== "withdraw") || route.network !== "solana" || route.destinationNetwork !== "solana") return false;
    // The planner routes deposits and withdrawals with output = input (the receipt is the adapter's).
    if (!sameAsset(route.input, route.output) || route.input.isNative) return false;
    return yieldVenuesFor("solana", "jupiter-lend").some((venue) => venue.kind === "jupiter-lend" && venueServes(venue, route));
  },

  async plan(action): Promise<PlannedStep> {
    const context = await lendContext(action);
    const lend = await quote(context, action);
    // A quote that would fail at prepare must not plan: check the API instruction now too.
    if (lend.instructionAmount > 0n) await checkedInstruction(context, lend);
    const fees = await feeUsd();
    return {
      protocol: "jupiter-lend",
      title: lend.title,
      mode: "wallet",
      input: lend.input,
      expectedOutput: lend.expectedOutput,
      minimumOutput: lend.minimumOutput,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: ESTIMATED_SECONDS,
      settlement: { kind: "same-network" },
      warnings: lend.warnings,
      transactionCount: 1,
      slippageBps: Number(SHARE_TOLERANCE_BPS),
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const context = await lendContext(action);
    const lend = await quote(context, action);
    if (lend.instructionAmount <= 0n) {
      throw new PlatformError("POSITION_EMPTY", `There is no ${context.underlying.symbol} position to withdraw at ${context.venue.name}.`, 422);
    }
    const instruction = await checkedInstruction(context, lend);
    // The account that receives tokens is created idempotently in the same transaction (jlToken on deposit, underlying on withdraw).
    const credited = context.kind === "deposit" ? context.venue.receipt.address : context.mint;
    const built = await buildSolanaTransaction("solana", context.owner, [await createOwnTokenAccount(context.owner, credited), instruction], COMPUTE_UNITS);
    if (built.simulation && !built.simulation.ok) {
      throw new PlatformError(
        "SIMULATION_FAILED",
        `The ${context.kind} would fail on-chain (${built.simulation.error.slice(0, 160)}). Check the account's ${context.kind === "deposit" ? context.underlying.symbol : context.receipt.symbol} balance.`,
        422,
      );
    }
    const info = assertSolanaTransactionOwner(built.transaction, context.owner);
    if (!info.programs.includes(context.venue.target)) {
      throw new PlatformError("TRANSFER_BUILD_FAILED", "The Jupiter Lend transaction does not invoke the pinned program.", 500);
    }
    const description = lend.title;
    const records: PreparedStepRecord["transactions"] = [
      { vm: "svm", network: "solana", feePayer: context.owner, to: context.venue.target, description },
    ];
    const fees = await feeUsd();
    return {
      transactions: [
        {
          vm: "svm",
          network: "solana",
          feePayer: context.owner,
          transaction: built.transaction,
          encoding: "base64",
          lastValidBlockHeight: built.lastValidBlockHeight,
          description,
        },
      ],
      records,
      input: lend.input,
      expectedOutput: lend.expectedOutput,
      minimumOutput: lend.minimumOutput,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: built.simulation ? [] : ["Simulation was unavailable; the wallet will simulate before signing."],
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const venue = stepVenue(step);
    const underlying = venue ? underlyingOf(venue) : null;
    if (!venue || !underlying || !step.input || !step.minimumOutput || (step.kind !== "deposit" && step.kind !== "withdraw")) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The Jupiter Lend step has no registry venue or recorded amounts." } };
    }
    const owner = stepOwner(step);
    const mint = underlying.address as string;
    const closePosition = step.kind === "withdraw" && decodeStepRef(step.quoteRef)?.closePosition === true;
    const kind: JupiterLendInstructionKind = step.kind === "deposit" ? "deposit" : closePosition ? "redeem" : "withdraw";
    const lendContextForVerify: LendContext = {
      venue,
      kind: step.kind,
      owner,
      underlying: resolvedUnderlying(underlying),
      mint,
      receipt: receiptAsset(venue),
      accounts: await jupiterLendAccounts(venue, mint),
    };
    const expected = await expectation(lendContextForVerify, kind, 0n, null);
    const amount = BigInt(step.input.amount);
    const floor = lowestFloor(step) ?? BigInt(step.minimumOutput.amount);
    const minimum = step.minimumOutput;
    const observed: { actual?: AssetAmount } = {};
    const { result } = await verifySolanaReferences(context, (observations) => {
      const candidates: SolanaInstructionView[] = observations.flatMap((observation) => observation.instructions ?? []).filter((instruction) => instruction.program === venue.target);
      const reasons = candidates.map((instruction) => lendInstructionMismatch(instruction, { ...expected, amount: kind === "redeem" ? null : amount }, venue.target));
      const matched = candidates.filter((_, index) => reasons[index] === null);
      if (matched.length !== 1) {
        const reason = reasons.find((entry) => entry !== null) ?? "it carries no Jupiter Lend instruction";
        return { failure: { code: "REFERENCE_MISMATCH", message: `The transaction is not this step's Jupiter Lend ${kind}: ${matched.length > 1 ? "it carries more than one" : reason}.` } };
      }
      const underlyingDelta = tokenDelta(observations, owner, mint);
      const receiptDelta = tokenDelta(observations, owner, venue.receipt.address);
      if (step.kind === "deposit") {
        if (-underlyingDelta !== amount) {
          return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The deposit did not move exactly ${step.input?.formatted} ${underlying.symbol} out of the step account.` } };
        }
        if (receiptDelta <= 0n || receiptDelta < floor) {
          return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The deposit did not credit at least ${fromBaseUnits(floor, minimum.decimals)} ${minimum.symbol} to the step account.` } };
        }
        observed.actual = observedAmount(minimum, receiptDelta);
        return;
      }
      const redeemed = kind === "redeem" ? (matched[0] as SolanaInstructionView) : null;
      const shares = redeemed ? new DataView(redeemed.data.buffer, redeemed.data.byteOffset).getBigUint64(8, true) : null;
      if (receiptDelta >= 0n || (shares !== null && -receiptDelta !== shares)) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The withdrawal did not burn the step account's ${venue.name} shares.` } };
      }
      if (underlyingDelta <= 0n || underlyingDelta < floor) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The withdrawal did not credit at least ${fromBaseUnits(floor, minimum.decimals)} ${underlying.symbol} to the step account.` } };
      }
      observed.actual = observedAmount(minimum, underlyingDelta);
    });
    if (result.status === "confirmed" && observed.actual) return { ...result, actualOutput: observed.actual };
    return result;
  },
};
