/**
 * Kamino Lend adapter: deposit into and withdraw an exact amount from a
 * pinned main-market reserve (USDC, SOL, USDT, PYUSD) through Kamino's KTX
 * transaction API, on Solana mainnet.
 *
 * - The reserve comes only from YIELD_VENUES (`action.venue`) and is read
 *   on-chain: owner, discriminator, market, mint and supply vault must match
 *   the pin (the market lists decoy USDC reserves, so never by symbol).
 * - KTX transactions are decoded with their address lookup tables resolved
 *   and checked instruction by instruction against an allowlist
 *   (kaminoClient.ts). The deposit amount must equal the step amount; a
 *   withdrawal's collateral amount must redeem for the requested amount.
 *   Every payload is rebuilt and simulated at prepare (a first deposit embeds
 *   a lookup-table slot that goes stale within minutes).
 * - The deposit leaves no token in the wallet: collateral is booked to the
 *   step account's vanilla obligation. The step output is that collateral
 *   (the reserve's collateral mint, held by the market authority), so a later
 *   step can never spend it as a wallet token.
 * - Verification binds the landed transaction by its KLend instruction
 *   (program, pinned accounts, amount) and proves the outcome from token
 *   deltas: the reserve vault received exactly the amount and collateral was
 *   minted (deposit), or the vault paid out and the step account received it
 *   (withdraw), no more than the burned collateral is worth. Other KLend
 *   instructions in the transaction may only set up or refresh.
 * - "Withdraw all" is refused: KTX takes exact amounts only and its collateral
 *   rounding cannot be bound to the whole position safely.
 */
import {
  findAssetBySymbol,
  formatAmount,
  formatAssetId,
  fromBaseUnits,
  getYieldVenue,
  isBaseUnitAmount,
  WRAPPED_SOL_MINT,
  yieldVenuesFor,
  type AssetAmount,
  type AssetDescriptor,
  type IntentStep,
  type KaminoReserveVenue,
} from "@kletia/core";
import { readSolanaLendingYields } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, sameAsset, type ResolvedAsset } from "../assets.js";
import { assertSolanaTransactionOwner, bytesHex, decodeSolanaTransaction, simulateSolanaTransaction, SOLANA_PROGRAM_IDS, type SolanaInstructionView } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { decodeStepRef } from "../stepRef.js";
import {
  checkKaminoTransaction,
  collateralForLiquidity,
  fetchKaminoTransaction,
  kaminoInstructionMismatch,
  liquidityForCollateral,
  SETUP_DISCRIMINATORS,
  liquidityTokenAccount,
  readKaminoReserve,
  vanillaObligation,
  type KaminoExpectation,
  type KaminoReserveState,
} from "./kaminoClient.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { effectiveSolDelta, SOL_RENT_TOLERANCE_LAMPORTS, stepOwner, tokenDelta, verifySolanaReferences } from "./verification.js";

/** Collateral exchange-rate drift tolerated between quote and execution. */
const COLLATERAL_TOLERANCE_BPS = 10n;
/** Rent of user metadata, obligation, farm state and lookup table on a first deposit (measured 0.0298 SOL incl. fee). */
const FIRST_DEPOSIT_RENT_SOL = 0.03;
/** Base fee only: KTX sets a compute-unit limit and no priority fee. */
const NETWORK_FEE_SOL = 0.00001;
const ESTIMATED_SECONDS = 15;

interface KaminoContext {
  readonly venue: KaminoReserveVenue;
  readonly kind: "deposit" | "withdraw";
  readonly owner: string;
  readonly underlying: ResolvedAsset;
  /** Reserve liquidity mint (wrapped SOL for the SOL reserve). */
  readonly mint: string;
  readonly tokenProgram: string;
}

function format(units: bigint | string, asset: Pick<ResolvedAsset, "decimals" | "symbol">): string {
  return `${formatAmount(fromBaseUnits(units, asset.decimals))} ${asset.symbol}`;
}

function lessBps(value: bigint, bps: bigint): bigint {
  return (value * (10_000n - bps)) / 10_000n;
}

function underlyingOf(venue: KaminoReserveVenue): AssetDescriptor | null {
  return findAssetBySymbol(venue.network, venue.asset);
}

function resolvedUnderlying(asset: AssetDescriptor): ResolvedAsset {
  return {
    network: asset.network,
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    address: asset.address,
    isNative: asset.address === null,
    canonical: true,
    verified: true,
    category: asset.category,
    ...(asset.group ? { group: asset.group } : {}),
  };
}

/** The reserve's collateral token as the deposit output (booked to the obligation, never a wallet token). */
function collateralAsset(venue: KaminoReserveVenue, reserve: Pick<KaminoReserveState, "collateralMint" | "decimals">): ResolvedAsset {
  return {
    network: venue.network,
    id: formatAssetId(venue.network, "token", reserve.collateralMint),
    symbol: `k${venue.asset}`.slice(0, 16),
    name: `${venue.name} collateral (in your Kamino obligation)`,
    decimals: reserve.decimals,
    address: reserve.collateralMint,
    isNative: false,
    canonical: false,
    verified: true,
  };
}

function venueServes(venue: KaminoReserveVenue, route: AdapterRoute): boolean {
  const underlying = underlyingOf(venue);
  return underlying !== null && venue.actions.includes(route.kind as "deposit" | "withdraw") && underlying.id === route.input.id;
}

function kaminoContext(action: AdapterAction): KaminoContext {
  if (action.kind !== "deposit" && action.kind !== "withdraw") {
    throw new PlatformError("VENUE_INVALID", `The Kamino adapter received a ${action.kind} action.`, 500);
  }
  if (action.network !== "solana" || action.destinationNetwork !== "solana") {
    throw new PlatformError("NETWORK_UNSUPPORTED", "Kamino Lend runs on Solana mainnet only.", 422);
  }
  const venue = getYieldVenue(action.venue ?? "");
  if (!venue || venue.kind !== "kamino-reserve" || venue.protocol !== "kamino" || venue.network !== "solana" || !venue.actions.includes(action.kind)) {
    throw new PlatformError("VENUE_INVALID", `The step's venue is not a Kamino reserve that takes ${action.kind}s.`, 500);
  }
  const underlying = underlyingOf(venue);
  if (!underlying || underlying.id !== action.input.id) {
    throw new PlatformError("VENUE_INVALID", `${venue.name} holds ${venue.asset}, not ${action.input.symbol}.`, 500);
  }
  if (action.recipient.address !== action.account.address) {
    throw new PlatformError("INTENT_UNSUPPORTED", `A ${action.kind} pays the acting account; send the result with a separate "send" step.`, 422);
  }
  if (action.closePosition) {
    throw new PlatformError("INTENT_UNSUPPORTED", `Kamino withdrawals take an exact amount; Kletia does not close a whole Kamino position. Name the ${underlying.symbol} amount to withdraw.`, 422);
  }
  return {
    venue,
    kind: action.kind,
    owner: action.account.address,
    underlying: resolvedUnderlying(underlying),
    mint: underlying.address ?? WRAPPED_SOL_MINT,
    tokenProgram: underlying.tokenProgram === "token-2022" ? SOLANA_PROGRAM_IDS.token2022 : SOLANA_PROGRAM_IDS.token,
  };
}

async function expectation(context: KaminoContext, reserve: KaminoReserveState, amount: bigint): Promise<KaminoExpectation> {
  return {
    kind: context.kind,
    owner: context.owner,
    venue: context.venue,
    reserve,
    obligation: await vanillaObligation(context.venue, context.owner),
    ownerLiquidity: await liquidityTokenAccount(context.owner, context.mint, reserve.liquidityTokenProgram),
    amount,
  };
}

async function apyNote(venue: KaminoReserveVenue): Promise<string[]> {
  const rows = await Promise.race([
    readSolanaLendingYields().catch(() => []),
    new Promise<[]>((resolve) => setTimeout(() => resolve([]), 4_000).unref()),
  ]);
  const row = rows.find((entry) => entry.reserve === venue.reserve);
  return row ? [`Variable yield: about ${(row.supplyApy * 100).toFixed(2)}% supply APY at planning (Kamino reserve metrics); not guaranteed.`] : [];
}

interface KaminoQuote {
  readonly transaction: string;
  readonly input: AssetAmount;
  readonly expectedOutput: AssetAmount;
  readonly minimumOutput: AssetAmount;
  readonly title: string;
  readonly warnings: string[];
  readonly feesUsd?: number;
  readonly simulated: boolean;
}

/**
 * Reads the reserve, fetches a fresh KTX transaction, decodes it with its
 * lookup tables and checks it. `simulate` also dry-runs it (prepare, and
 * plan for withdrawals, which need an existing position).
 */
async function quote(context: KaminoContext, action: AdapterAction, simulate: boolean): Promise<KaminoQuote> {
  const { venue, underlying } = context;
  const amount = BigInt(action.amount);
  if (amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `A Kamino ${context.kind} needs a positive amount.`, 422);
  const reserve = await readKaminoReserve("solana", venue, context.mint);
  if (reserve.liquidityTokenProgram !== context.tokenProgram || reserve.decimals !== underlying.decimals) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name}'s reserve uses a different token program or decimals than the pinned ${underlying.symbol}. Kletia will not use it.`, 422);
  }
  const expected = await expectation(context, reserve, amount);
  // KTX takes whole-unit decimals and truncates extra digits: send the exact value, then check the encoded units.
  const transaction = await fetchKaminoTransaction(context.kind, { wallet: context.owner, venue, amount: fromBaseUnits(amount, underlying.decimals) });
  assertSolanaTransactionOwner(transaction, context.owner);
  const checked = checkKaminoTransaction(await decodeSolanaTransaction("solana", transaction), expected);
  let simulated = false;
  if (simulate) {
    const simulation = await simulateSolanaTransaction("solana", transaction);
    if (simulation && !simulation.ok) {
      throw new PlatformError(
        "SIMULATION_FAILED",
        `The Kamino ${context.kind} would fail on-chain (${simulation.error.slice(0, 160)}). Check the account's ${context.kind === "deposit" ? `${underlying.symbol} balance` : `${venue.name} position`}.`,
        422,
      );
    }
    simulated = simulation !== null;
  }
  const warnings = await apyNote(venue);
  const price = await nativeUsdPrice("solana");
  const feeSol = NETWORK_FEE_SOL + (checked.createsObligation ? FIRST_DEPOSIT_RENT_SOL : 0);
  if (checked.createsObligation) {
    warnings.push(`First Kamino deposit for this account: creates its Kamino user account and obligation (about ${FIRST_DEPOSIT_RENT_SOL} SOL rent, included in the fees).`);
  }
  const fees = price === null ? {} : { feesUsd: feeSol * price };
  if (context.kind === "deposit") {
    const collateral = collateralAsset(venue, reserve);
    const minted = collateralForLiquidity(reserve, amount);
    if (minted <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${format(amount, underlying)} mints no ${venue.name} collateral.`, 422);
    warnings.push(`The deposit is held in your Kamino obligation as ${collateral.symbol} collateral, not as a wallet token; withdraw it with "withdraw … from kamino".`);
    return {
      transaction,
      input: assetAmount(underlying, amount.toString()),
      expectedOutput: assetAmount(collateral, minted.toString()),
      minimumOutput: assetAmount(collateral, lessBps(minted, COLLATERAL_TOLERANCE_BPS).toString()),
      title: `Deposit ${format(amount, underlying)} into ${venue.name}`,
      warnings,
      ...fees,
      simulated,
    };
  }
  // The live rate only grows, so the collateral redeems for at least its value at the stored rate.
  const redeemed = liquidityForCollateral(reserve, checked.instructionAmount);
  const floor = (redeemed < amount ? redeemed : amount) - 1n;
  warnings.push("If this obligation has borrows, withdrawing collateral lowers its health; Kamino refuses withdrawals that would make it unsafe.");
  return {
    transaction,
    input: assetAmount(underlying, amount.toString()),
    expectedOutput: assetAmount(underlying, amount.toString()),
    minimumOutput: assetAmount(underlying, (floor > 0n ? floor : 0n).toString()),
    title: `Withdraw ${format(amount, underlying)} from ${venue.name}`,
    warnings,
    ...fees,
    simulated,
  };
}

function stepVenue(step: IntentStep): KaminoReserveVenue | null {
  const venue = getYieldVenue(step.venue ?? "");
  return venue && venue.kind === "kamino-reserve" && venue.network === step.network && step.protocol === "kamino" ? venue : null;
}

function lowestFloor(step: IntentStep): bigint | null {
  const values = [step.minimumOutput?.amount, ...(decodeStepRef(step.quoteRef)?.floors ?? []).map((floor) => floor.min)]
    .filter((value): value is string => isBaseUnitAmount(value))
    .map((value) => BigInt(value));
  return values.length > 0 ? values.reduce((low, value) => (value < low ? value : low)) : null;
}

function observedAmount(ref: Pick<AssetAmount, "asset" | "symbol" | "decimals">, units: bigint): AssetAmount {
  return { asset: ref.asset, symbol: ref.symbol, decimals: ref.decimals, amount: units.toString(), formatted: fromBaseUnits(units, ref.decimals) };
}

export const kaminoAdapter: ProtocolAdapter = {
  id: "kamino",
  protocols: ["kamino"],
  label: "Kamino Lend",

  supports(route) {
    if ((route.kind !== "deposit" && route.kind !== "withdraw") || route.network !== "solana" || route.destinationNetwork !== "solana") return false;
    if (!sameAsset(route.input, route.output)) return false;
    return yieldVenuesFor("solana", "kamino").some((venue) => venue.kind === "kamino-reserve" && venueServes(venue, route));
  },

  async plan(action): Promise<PlannedStep> {
    const context = kaminoContext(action);
    // Withdrawals need an existing position: dry-run them at planning so an empty or short position fails early.
    const kamino = await quote(context, action, context.kind === "withdraw");
    return {
      protocol: "kamino",
      title: kamino.title,
      mode: "wallet",
      input: kamino.input,
      expectedOutput: kamino.expectedOutput,
      minimumOutput: kamino.minimumOutput,
      ...(kamino.feesUsd !== undefined ? { feesUsd: kamino.feesUsd } : {}),
      estimatedSeconds: ESTIMATED_SECONDS,
      settlement: { kind: "same-network" },
      warnings: kamino.warnings,
      transactionCount: 1,
      slippageBps: Number(COLLATERAL_TOLERANCE_BPS),
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const context = kaminoContext(action);
    const kamino = await quote(context, action, true);
    const description = kamino.title;
    return {
      transactions: [
        { vm: "svm", network: "solana", feePayer: context.owner, transaction: kamino.transaction, encoding: "base64", description },
      ],
      records: [{ vm: "svm", network: "solana", feePayer: context.owner, to: context.venue.target, description }],
      input: kamino.input,
      expectedOutput: kamino.expectedOutput,
      minimumOutput: kamino.minimumOutput,
      ...(kamino.feesUsd !== undefined ? { feesUsd: kamino.feesUsd } : {}),
      warnings: kamino.simulated ? [] : ["Simulation was unavailable; the wallet will simulate before signing."],
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const venue = stepVenue(step);
    const underlying = venue ? underlyingOf(venue) : null;
    if (!venue || !underlying || !step.input || !step.minimumOutput || (step.kind !== "deposit" && step.kind !== "withdraw")) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The Kamino step has no registry venue or recorded amounts." } };
    }
    const owner = stepOwner(step);
    const mint = underlying.address ?? WRAPPED_SOL_MINT;
    let reserve: KaminoReserveState;
    try {
      reserve = await readKaminoReserve("solana", venue, mint);
    } catch {
      return { status: "pending", evidence: [], reason: "The Kamino reserve could not be read yet.", stale: false };
    }
    const kind = step.kind;
    const amount = BigInt(step.input.amount);
    const expected = { ...(await expectation({ venue, kind, owner, underlying: resolvedUnderlying(underlying), mint, tokenProgram: reserve.liquidityTokenProgram }, reserve, amount)) };
    const floor = lowestFloor(step) ?? BigInt(step.minimumOutput.amount);
    const minimum = step.minimumOutput;
    const authority = venue.marketAuthority;
    const observed: { actual?: AssetAmount } = {};
    const { result } = await verifySolanaReferences(context, (observations) => {
      const candidates: SolanaInstructionView[] = observations
        .flatMap((observation) => observation.instructions ?? [])
        .filter((instruction) => instruction.program === venue.target && instruction.data.length === 16);
      const reasons = candidates.map((instruction) => kaminoInstructionMismatch(instruction, { ...expected, amount: kind === "deposit" ? amount : null }));
      const matched = candidates.filter((_, index) => reasons[index] === null);
      if (matched.length !== 1) {
        const reason = matched.length > 1 ? "it carries more than one" : (reasons.find((entry) => entry !== null) ?? "it carries no KLend instruction");
        return { failure: { code: "REFERENCE_MISMATCH", message: `The transaction is not this step's Kamino ${kind}: ${reason}.` } };
      }
      const main = matched[0] as SolanaInstructionView;
      // Any other KLend instruction may only set up or refresh: a borrow, repay or another reserve's
      // deposit / withdrawal would move liquidity the token deltas below would attribute to this step.
      const others = observations
        .flatMap((observation) => observation.instructions ?? [])
        .filter((instruction) => instruction !== main && instruction.program === venue.target);
      if (others.some((instruction) => !SETUP_DISCRIMINATORS.has(bytesHex(instruction.data, 8)))) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The transaction carries KLend instructions besides this step's ${kind} that move liquidity.` } };
      }
      const instructionAmount = new DataView(main.data.buffer, main.data.byteOffset).getBigUint64(8, true);
      const vaultDelta = tokenDelta(observations, authority, mint);
      const collateralDelta = tokenDelta(observations, authority, reserve.collateralMint);
      if (kind === "deposit") {
        if (vaultDelta !== amount || (mint !== WRAPPED_SOL_MINT && -tokenDelta(observations, owner, mint) !== amount)) {
          return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The reserve did not receive exactly ${step.input?.formatted} ${underlying.symbol} from the step account.` } };
        }
        if (collateralDelta <= 0n || collateralDelta < floor) {
          return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The deposit did not book at least ${fromBaseUnits(floor, minimum.decimals)} ${minimum.symbol} collateral.` } };
        }
        observed.actual = observedAmount(minimum, collateralDelta);
        return;
      }
      const paid = -vaultDelta;
      const credited = mint === WRAPPED_SOL_MINT
        ? effectiveSolDelta(observations, owner) + SOL_RENT_TOLERANCE_LAMPORTS
        : tokenDelta(observations, owner, mint);
      // The bound instruction alone must cover the floor, and the reserve may pay out no more than the
      // redeemed collateral is worth (the rate read now is at least the one it executed at).
      const worth = liquidityForCollateral(reserve, instructionAmount);
      const tolerance = worth / 1_000n + 2n;
      if (worth + tolerance < floor || paid > worth + tolerance) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The withdrawal redeems collateral worth about ${fromBaseUnits(worth, minimum.decimals)} ${underlying.symbol}; the reserve paid ${fromBaseUnits(paid > 0n ? paid : 0n, minimum.decimals)} against a floor of ${fromBaseUnits(floor, minimum.decimals)}.` } };
      }
      if (-collateralDelta !== instructionAmount || paid <= 0n || paid < floor || credited < paid) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The withdrawal did not pay at least ${fromBaseUnits(floor, minimum.decimals)} ${underlying.symbol} from the reserve to the step account.` } };
      }
      observed.actual = observedAmount(minimum, paid);
    });
    if (result.status === "confirmed" && observed.actual) return { ...result, actualOutput: observed.actual };
    return result;
  },
};
