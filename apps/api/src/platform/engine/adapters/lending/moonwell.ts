/**
 * Moonwell (Compound v2 fork) mToken supply and redeem on the markets the
 * registry pins (YIELD_VENUES kind "ctoken": USDC and WETH on Base and OP
 * Mainnet). The mToken is the target, the spender and the receipt (8
 * decimals); native ETH deposits go through the market's pinned WETH router.
 *
 * Moonwell specifics this adapter encodes:
 * - `mint` / `redeem` / `redeemUnderlying` return an error code instead of
 *   reverting on several failures (comptroller rejection, insufficient cash),
 *   so a successful receipt proves nothing: verification requires the `Mint`
 *   / `Redeem` event (non-indexed, decoded from data) and fails the step with
 *   VENUE_REJECTED (decoding `Failure`) when it is missing. Simulations decode
 *   the returned code too.
 * - mTokens credit msg.sender only: the recipient is always the account.
 * - Exit-liquidity gate: deposits are refused while the market has no cash or
 *   is more than 99% utilised (a new deposit could not be withdrawn until
 *   borrowers repay); withdrawals need cash >= amount.
 * - "Withdraw all" is `redeem(MAX)` (every mToken of the account).
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  fromBaseUnits,
  nativeAssetId,
  type CTokenVenue,
  type EvmTransactionRequest,
  type IntentStep,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { assetAmount, resolveAsset, type ResolvedAsset } from "../../assets.js";
import { estimateEvmFeeUsd, evmClient, type EvmNetworkKey } from "../../chains/evm.js";
import { assertEvmBalance } from "../evmTransfer.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter } from "../types.js";
import { evmEvents, stepOwner, verifyEvmReceipts, type EvmOutcome, type LandedEvmReceipt } from "../verification.js";
import {
  APPROVE_GAS,
  apyFromScaledRate,
  apyNote,
  assertPinned,
  assertSimulation,
  callGas,
  eventEvidence,
  evmCall,
  exactApproval,
  formatUnits,
  landedCall,
  lendingContext,
  lessBps,
  lessRounding,
  lowestFloor,
  MAX_UINT256,
  nativeLegFailure,
  observed,
  outcomeFailure,
  payloadRecords,
  plannedAllowance,
  ratio,
  receiptAsset,
  sameAddress,
  SHARE_TOLERANCE_BPS,
  simulate,
  simulatedUint,
  SIMULATION_UNAVAILABLE,
  stepVenue,
  supportsLending,
  tokenSymbol,
  transferred,
  underlyingAmount,
  unwrappedDebit,
  unwrappedWeth,
  unwrapTransaction,
  UNWRAP_GAS,
  withTimeout,
  WRAP_GAS,
  wrapsNative,
  wrapTransaction,
  type LendingContext,
  type LendingMetrics,
  type Simulation,
  LENDING_PREVIEW_TTL_SECONDS,
} from "./common.js";

export const MTOKEN_ABI = parseAbi([
  "function mint(uint256 mintAmount) returns (uint256)",
  "function redeem(uint256 redeemTokens) returns (uint256)",
  "function redeemUnderlying(uint256 redeemAmount) returns (uint256)",
  "function underlying() view returns (address)",
  "function comptroller() view returns (address)",
  "function decimals() view returns (uint8)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
  "function supplyRatePerTimestamp() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  // Non-view (they accrue interest first); read with eth_call only.
  "function exchangeRateCurrent() view returns (uint256)",
  "function balanceOfUnderlying(address owner) view returns (uint256)",
  "event Mint(address minter,uint256 mintAmount,uint256 mintTokens)",
  "event Redeem(address redeemer,uint256 redeemAmount,uint256 redeemTokens)",
  "event Failure(uint256 code,uint256 info,uint256 detail)",
  "event Transfer(address indexed from,address indexed to,uint256 amount)",
]);
export const COMPTROLLER_ABI = parseAbi([
  "function markets(address mToken) view returns (bool isListed,uint256 collateralFactorMantissa)",
  "function mintGuardianPaused(address mToken) view returns (bool)",
  "function supplyCaps(address mToken) view returns (uint256)",
]);
/** MWethDelegate markets pay redeems out in native ETH through a WETH unwrapper. */
export const PAYOUT_ABI = parseAbi([
  "function wethUnwrapper() view returns (address)",
  "function weth() view returns (address)",
]);
export const ROUTER_ABI = parseAbi([
  "function mint(address recipient) payable",
  "function weth() view returns (address)",
  "function mToken() view returns (address)",
]);

/** TokenErrorReporter.Error, in declaration order. */
const MTOKEN_ERRORS = [
  "NO_ERROR", "UNAUTHORIZED", "BAD_INPUT", "COMPTROLLER_REJECTION", "COMPTROLLER_CALCULATION_ERROR",
  "INTEREST_RATE_MODEL_ERROR", "INVALID_ACCOUNT_PAIR", "INVALID_CLOSE_AMOUNT_REQUESTED", "INVALID_COLLATERAL_FACTOR",
  "MATH_ERROR", "MARKET_NOT_FRESH", "MARKET_NOT_LISTED", "TOKEN_INSUFFICIENT_ALLOWANCE", "TOKEN_INSUFFICIENT_BALANCE",
  "TOKEN_INSUFFICIENT_CASH", "TOKEN_TRANSFER_IN_FAILED", "TOKEN_TRANSFER_OUT_FAILED",
] as const;

const MINT_GAS = 350_000n;
const ROUTER_MINT_GAS = 450_000n;
const REDEEM_GAS = 350_000n;
/** Deposits are refused above this utilisation: new supply could not leave until borrowers repay. */
const MAX_DEPOSIT_UTILIZATION_BPS = 9_900n;

type MoonwellContext = LendingContext<CTokenVenue>;

interface MarketState {
  readonly cash: bigint;
  readonly borrows: bigint;
  readonly reserves: bigint;
  readonly supplyRate: bigint;
  readonly mintPaused: boolean;
  readonly supplyCap: bigint;
}

function errorName(code: bigint): string {
  return MTOKEN_ERRORS[Number(code)] ?? `error ${code}`;
}

/** Confirms the market against the registry (underlying, comptroller, listing, decimals) and reads its state. */
async function readMarket(context: Pick<MoonwellContext, "venue" | "network" | "token">): Promise<MarketState> {
  const { venue } = context;
  const client = evmClient(context.network);
  const mToken = getAddress(venue.target);
  const comptroller = getAddress(venue.comptroller);
  const [underlying, reported, decimals, cash, borrows, reserves, supplyRate, market, mintPaused, supplyCap] = await withTimeout(Promise.all([
    client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "underlying" }),
    client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "comptroller" }),
    client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "decimals" }),
    client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "getCash" }),
    client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "totalBorrows" }),
    client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "totalReserves" }),
    client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "supplyRatePerTimestamp" }),
    client.readContract({ address: comptroller, abi: COMPTROLLER_ABI, functionName: "markets", args: [mToken] }),
    client.readContract({ address: comptroller, abi: COMPTROLLER_ABI, functionName: "mintGuardianPaused", args: [mToken] }),
    client.readContract({ address: comptroller, abi: COMPTROLLER_ABI, functionName: "supplyCaps", args: [mToken] }),
  ]));
  assertPinned(underlying, context.token, "underlying()", venue);
  assertPinned(reported, venue.comptroller, "comptroller()", venue);
  if (decimals !== venue.receipt.decimals) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} reports ${decimals} decimals, not ${venue.receipt.decimals}.`, 422);
  }
  if (!market[0]) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} is not listed by its comptroller.`, 422);
  }
  return { cash, borrows, reserves, supplyRate, mintPaused, supplyCap };
}

function supplied(state: MarketState): bigint {
  const total = state.cash + state.borrows - state.reserves;
  return total > 0n ? total : 0n;
}

/** The WETH router must wrap into the pinned WETH and mint the pinned market. */
async function assertRouter(context: MoonwellContext, router: string): Promise<void> {
  const client = evmClient(context.network);
  const [weth, market] = await withTimeout(Promise.all([
    client.readContract({ address: getAddress(router), abi: ROUTER_ABI, functionName: "weth" }),
    client.readContract({ address: getAddress(router), abi: ROUTER_ABI, functionName: "mToken" }),
  ]));
  assertPinned(weth, context.token, "router weth()", context.venue);
  assertPinned(market, context.venue.target, "router mToken()", context.venue);
}

/**
 * The WETH unwrapper of a market whose redeems pay native ETH (Moonwell's
 * MWethDelegate: Base and OP mWETH), or null for markets that pay the
 * ERC-20 (`wethUnwrapper()` reverts). The answer must match the registry:
 * a pinned market must report exactly its pinned unwrapper (`nativePayout`),
 * an unpinned one must not report any, and the unwrapper must unwrap the
 * pinned WETH. The unwrapper is only matched in receipt logs, never called
 * or approved. An unreadable answer fails closed: the payout asset decides
 * the output.
 */
async function nativePayout(context: Pick<MoonwellContext, "venue" | "network" | "owner" | "underlying" | "token">): Promise<string | null> {
  if (!wrapsNative(context.network, context.underlying)) return null;
  const pinned = context.venue.nativePayout;
  const probe = await simulate(context.network, { from: context.owner, to: context.venue.target, data: encodeFunctionData({ abi: PAYOUT_ABI, functionName: "wethUnwrapper" }) });
  if (probe.status === "reverted") {
    if (pinned) {
      throw new PlatformError("VENUE_UNVERIFIED", `${context.venue.name} on ${CHAINS[context.network].name} no longer reports its pinned WETH unwrapper ${pinned}. Kletia will not use it.`, 422);
    }
    return null;
  }
  if (probe.status === "unavailable" || !/^0x[0-9a-fA-F]{64}$/u.test(probe.data)) {
    throw new PlatformError("RPC_UNAVAILABLE", `Could not read how ${context.venue.name} pays withdrawals. Try again shortly.`, 502);
  }
  const unwrapper = getAddress(`0x${probe.data.slice(26)}`);
  if (!pinned) {
    throw new PlatformError("VENUE_UNVERIFIED", `${context.venue.name} on ${CHAINS[context.network].name} pays withdrawals through an unpinned WETH unwrapper ${unwrapper}. Kletia will not use it.`, 422);
  }
  assertPinned(unwrapper, pinned, "wethUnwrapper()", context.venue);
  const weth = await withTimeout(evmClient(context.network).readContract({ address: unwrapper, abi: PAYOUT_ABI, functionName: "weth" }));
  assertPinned(weth, context.token, "unwrapper weth()", context.venue);
  return getAddress(pinned);
}

function title(context: MoonwellContext, amount: bigint, symbol: string, close: boolean): string {
  const chain = CHAINS[context.network].name;
  const what = close ? `all ${symbol}` : `${formatAmount(fromBaseUnits(amount, context.underlying.decimals))} ${symbol}`;
  return context.kind === "deposit" ? `Supply ${what} to Moonwell on ${chain}` : `Withdraw ${what} from Moonwell on ${chain}`;
}

/** A Moonwell call simulated from the account must not revert and must return NO_ERROR. */
function assertMoonwellSimulation(simulation: Simulation, what: string): void {
  assertSimulation(simulation, what);
  const code = simulatedUint(simulation);
  if (code !== null && code !== 0n) {
    throw new PlatformError("SIMULATION_FAILED", `Moonwell would reject the ${what} (${errorName(code)}).`, 422);
  }
}

interface Quote {
  readonly transactions: EvmTransactionRequest[];
  readonly input: bigint;
  readonly expected: bigint;
  readonly minimum: bigint;
  readonly output: ResolvedAsset;
  readonly gas: bigint;
  readonly warnings: string[];
}

async function mintQuote(action: AdapterAction, context: MoonwellContext, stage: "plan" | "prepare"): Promise<Quote> {
  const { venue, network, owner, token } = context;
  const amount = BigInt(action.amount);
  if (amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to supply.", 422);
  if (stage === "prepare") {
    await assertEvmBalance(network, owner, context.native ? null : token, amount, action.input.symbol, action.input.decimals);
  }
  const client = evmClient(network);
  const [state, exchangeRate] = await Promise.all([
    readMarket(context),
    withTimeout(client.readContract({ address: getAddress(venue.target), abi: MTOKEN_ABI, functionName: "exchangeRateCurrent" })),
  ]);
  const symbol = context.underlying.symbol;
  if (state.mintPaused) {
    throw new PlatformError("RESERVE_UNAVAILABLE", `${venue.name} on ${CHAINS[network].name} has supply paused.`, 422);
  }
  const total = supplied(state);
  if (state.supplyCap > 0n && total + amount >= state.supplyCap) {
    throw new PlatformError(
      "RESERVE_UNAVAILABLE",
      `${venue.name} is at its supply cap (${formatUnits(state.supplyCap, context.underlying.decimals, symbol)}); ${formatUnits(amount, context.underlying.decimals, symbol)} does not fit.`,
      422,
    );
  }
  if (state.cash === 0n || (total > 0n && state.borrows * 10_000n > total * MAX_DEPOSIT_UTILIZATION_BPS)) {
    throw new PlatformError(
      "VENUE_ILLIQUID",
      `${venue.name} on ${CHAINS[network].name} has ${formatUnits(state.cash, context.underlying.decimals, symbol)} of exit liquidity (${state.cash === 0n ? "fully" : "over 99%"} borrowed); a new deposit could not be withdrawn until borrowers repay.`,
      422,
    );
  }
  if (exchangeRate <= 0n) throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} reports no exchange rate.`, 422);
  const expected = (amount * 10n ** 18n) / exchangeRate;
  if (expected <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${formatUnits(amount, context.underlying.decimals, symbol)} mints no ${venue.name} tokens.`, 422);
  // Interest accrued before the mint lowers the tokens minted: hold them to the share-price tolerance.
  const minimum = lessBps(expected, SHARE_TOLERANCE_BPS);
  const warnings: string[] = [];
  const transactions: EvmTransactionRequest[] = [];
  let gas: bigint;
  const router = context.native ? venue.nativeRouter : undefined;
  if (router) {
    await assertRouter(context, router);
    const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "mint", args: [owner] });
    let routerGas: bigint | string = ROUTER_MINT_GAS;
    if (stage === "prepare") {
      const request = { from: owner, to: router, data, value: amount.toString() };
      const simulation = await simulate(network, request);
      assertSimulation(simulation, `supply to ${venue.name}`);
      if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
      routerGas = await callGas(network, request, ROUTER_MINT_GAS);
    }
    transactions.push(evmCall(context, router, data, amount, routerGas, `${title(context, amount, "ETH", false)} (via the Moonwell WETH router)`));
    gas = ROUTER_MINT_GAS;
  } else {
    if (context.native) transactions.push(wrapTransaction(context, amount));
    const allowance = stage === "plan" ? await plannedAllowance(context, venue.spender) : undefined;
    const approval = await exactApproval(context, venue.spender, amount, allowance);
    if (approval) transactions.push(approval);
    const data = encodeFunctionData({ abi: MTOKEN_ABI, functionName: "mint", args: [amount] });
    let mintGas: bigint | string = MINT_GAS;
    if (stage === "prepare" && transactions.length === 0) {
      const request = { from: owner, to: venue.target, data };
      const simulation = await simulate(network, request);
      assertMoonwellSimulation(simulation, `supply to ${venue.name}`);
      if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
      mintGas = await callGas(network, request, MINT_GAS);
    }
    transactions.push(evmCall(context, venue.target, data, 0n, mintGas, title(context, amount, symbol, false)));
    gas = MINT_GAS + (approval ? APPROVE_GAS : 0n) + (context.native ? WRAP_GAS : 0n);
  }
  const receiptSymbol = await tokenSymbol(network, venue.receipt.address, `m${symbol}`);
  const utilization = ratio(state.borrows, total);
  if (utilization !== null && utilization > 0.95) {
    warnings.push(`${venue.name} is ${(utilization * 100).toFixed(1)}% borrowed; withdrawals may have to wait for repayments.`);
  }
  return {
    transactions,
    input: amount,
    expected,
    minimum,
    output: receiptAsset(network, venue.receipt, receiptSymbol, venue.name),
    gas,
    warnings: [...warnings, ...(stage === "plan" ? apyNote({ supplyApy: apyFromScaledRate(state.supplyRate, 10n ** 18n), apySource: "rate" }) : [])],
  };
}

async function redeemQuote(action: AdapterAction, context: MoonwellContext): Promise<Quote> {
  const { venue, network, owner } = context;
  const client = evmClient(network);
  const mToken = getAddress(venue.target);
  const [state, tokens] = await Promise.all([
    readMarket(context),
    withTimeout(client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "balanceOf", args: [owner] })),
  ]);
  const symbol = context.underlying.symbol;
  if (tokens === 0n) {
    throw new PlatformError("POSITION_EMPTY", `The account has no ${symbol} supplied to Moonwell on ${CHAINS[network].name}.`, 422);
  }
  const position = await withTimeout(client.readContract({ address: mToken, abi: MTOKEN_ABI, functionName: "balanceOfUnderlying", args: [owner] }));
  const requested = action.closePosition ? position : BigInt(action.amount);
  if (requested <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to withdraw.", 422);
  if (requested > position) {
    throw new PlatformError(
      "INSUFFICIENT_BALANCE",
      `The account has ${formatUnits(position, context.underlying.decimals, symbol)} supplied to Moonwell on ${CHAINS[network].name}; ${formatUnits(requested, context.underlying.decimals, symbol)} was requested.`,
      422,
    );
  }
  if (state.cash < requested) {
    throw new PlatformError(
      "VENUE_ILLIQUID",
      `${venue.name} on ${CHAINS[network].name} holds ${formatUnits(state.cash, context.underlying.decimals, symbol)} of cash right now (borrowers hold the rest); ${formatUnits(requested, context.underlying.decimals, symbol)} cannot be withdrawn yet.`,
      422,
    );
  }
  const close = action.closePosition === true || requested === position;
  const data = close
    ? encodeFunctionData({ abi: MTOKEN_ABI, functionName: "redeem", args: [MAX_UINT256] })
    : encodeFunctionData({ abi: MTOKEN_ABI, functionName: "redeemUnderlying", args: [requested] });
  const request = { from: owner, to: venue.target, data };
  const simulation = await simulate(network, request);
  assertMoonwellSimulation(simulation, `withdrawal from ${venue.name}`);
  const warnings = simulation.status === "unavailable" ? [SIMULATION_UNAVAILABLE] : [];
  const gas = simulation.status === "ok" ? await callGas(network, request, REDEEM_GAS) : REDEEM_GAS.toString();
  const minimum = close ? lessRounding(requested) : requested;
  // MWethDelegate markets unwrap on the way out: the account receives native ETH, never WETH.
  const unwrapper = await nativePayout(context);
  const paid = unwrapper ? CHAINS[network].nativeAsset.symbol : symbol;
  const transactions = [evmCall(context, venue.target, data, 0n, gas, title(context, requested, paid, action.closePosition === true))];
  if (unwrapper && !context.native) {
    warnings.push(`${venue.name} pays withdrawals in native ETH (Moonwell unwraps its WETH), so this step delivers ETH.`);
  }
  if (context.native && !unwrapper) {
    transactions.push(unwrapTransaction(context, minimum));
    if (close) warnings.push("Interest accrued after preparing stays in the account as WETH.");
  }
  return {
    transactions,
    input: requested,
    expected: requested,
    minimum,
    output: unwrapper ? await resolveAsset(network, CHAINS[network].nativeAsset.symbol) : action.input,
    gas: REDEEM_GAS + (context.native && !unwrapper ? UNWRAP_GAS : 0n),
    warnings,
  };
}

async function quote(action: AdapterAction, stage: "plan" | "prepare"): Promise<{ context: MoonwellContext; quote: Quote }> {
  const context = lendingContext(action, "ctoken", "moonwell");
  const result = context.kind === "deposit" ? await mintQuote(action, context, stage) : await redeemQuote(action, context);
  return { context, quote: result };
}

/* ------------------------------------------------------------ verification */

/** The market's Failure event explains a missing Mint / Redeem (error codes do not revert). */
function rejection(receipt: LandedEvmReceipt, venue: CTokenVenue, what: string): EvmOutcome {
  const [failure] = evmEvents([receipt], { address: venue.target, abi: MTOKEN_ABI, eventName: "Failure" });
  const reason = failure ? ` (${errorName(failure.args.code)}, info ${failure.args.info}, detail ${failure.args.detail})` : "";
  return outcomeFailure({ code: "VENUE_REJECTED", message: `Moonwell did not ${what}: the transaction succeeded but emitted no ${what === "mint" ? "Mint" : "Redeem"} event${reason}.` });
}

function proveMint(step: IntentStep, venue: CTokenVenue, underlying: string, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const floor = lowestFloor(step) ?? 1n;
  const receipt = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  const routed = venue.nativeRouter ? landedCall(receipts, venue.nativeRouter) : null;
  if (routed && venue.nativeRouter) {
    const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: routed.input as Hex });
    if (decoded.functionName !== "mint" || !sameAddress(decoded.args[0], account) || routed.value <= 0n) {
      return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The router call is not a mint for the step account." });
    }
    const minted = evmEvents([routed], { address: venue.target, abi: MTOKEN_ABI, eventName: "Mint" }).find((event) =>
      sameAddress(event.args.minter, venue.nativeRouter) && event.args.mintAmount === routed.value);
    if (!minted) return rejection(routed, venue, "mint");
    const forwarded = transferred([routed], venue.target, venue.nativeRouter, account);
    if (minted.args.mintTokens < floor || forwarded < minted.args.mintTokens) {
      return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The router forwarded ${forwarded} mTokens (minted ${minted.args.mintTokens}); the plan guaranteed at least ${floor}.` });
    }
    return {
      actualOutput: observed(receipt, forwarded),
      evidence: [eventEvidence(step, routed, observedAt, `Moonwell Mint via the WETH router: ${formatUnits(routed.value, 18, "ETH")} for ${formatUnits(forwarded, receipt.decimals, receipt.symbol)}.`)],
    };
  }
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the Moonwell market." });
  const decoded = decodeFunctionData({ abi: MTOKEN_ABI, data: call.input as Hex });
  if (decoded.functionName !== "mint") return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The market call is not a mint." });
  const amount = decoded.args[0];
  const minted = evmEvents([call], { address: venue.target, abi: MTOKEN_ABI, eventName: "Mint" }).find((event) =>
    sameAddress(event.args.minter, account) && event.args.mintAmount === amount);
  if (!minted) return rejection(call, venue, "mint");
  const tokens = minted.args.mintTokens;
  if (tokens < floor) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `Moonwell minted ${tokens} mTokens; the plan guaranteed at least ${floor}.` });
  if (transferred([call], venue.target, venue.target, account) !== tokens) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The mToken transfer to the account does not match the Mint event." });
  }
  if (transferred([call], underlying, account, venue.target) !== amount) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The supplied tokens did not move from the account to the market." });
  }
  const nativeLeg = nativeLegFailure(receipts, underlying, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  return {
    actualOutput: observed(receipt, tokens),
    evidence: [eventEvidence(step, call, observedAt, `Moonwell Mint: ${formatUnits(amount, step.input?.decimals ?? 0, step.input?.symbol ?? "")} for ${formatUnits(tokens, receipt.decimals, receipt.symbol)}.`)],
  };
}

async function proveRedeem(step: IntentStep, venue: CTokenVenue, underlying: string, receipts: readonly LandedEvmReceipt[], observedAt: string): Promise<EvmOutcome> {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the Moonwell market." });
  const decoded = decodeFunctionData({ abi: MTOKEN_ABI, data: call.input as Hex });
  if (decoded.functionName !== "redeem" && decoded.functionName !== "redeemUnderlying") {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The market call is not a redeem." });
  }
  const redeemed = evmEvents([call], { address: venue.target, abi: MTOKEN_ABI, eventName: "Redeem" }).find((event) => sameAddress(event.args.redeemer, account));
  if (!redeemed) return rejection(call, venue, "redeem");
  const { redeemAmount, redeemTokens } = redeemed.args;
  if (decoded.functionName === "redeemUnderlying" && redeemAmount !== decoded.args[0]) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `Moonwell redeemed ${redeemAmount} base units; ${decoded.args[0]} were requested.` });
  }
  if (decoded.functionName === "redeem") {
    const floor = decoded.args[0] === MAX_UINT256 ? (lowestFloor(step) ?? 1n) : 1n;
    if (redeemAmount < floor) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `Moonwell redeemed ${redeemAmount} base units; the plan required at least ${floor}.` });
  }
  // Moonwell moves redeemed mTokens to the market itself (not to the zero address).
  if (transferred([call], venue.target, account, venue.target) !== redeemTokens) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The mToken burn does not match the Redeem event." });
  }
  const output = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  const native = output.asset === nativeAssetId(step.network);
  const unwrapped = unwrappedWeth(receipts, underlying);
  if (native && unwrapped === null) {
    // MWethDelegate payout: the market hands the WETH to its pinned unwrapper, which unwraps it and
    // sends ETH to the redeemer (reverting the redeem if that send fails).
    const unwrapper = venue.nativePayout ? getAddress(venue.nativePayout) : null;
    if (!unwrapper || transferred([call], underlying, venue.target, unwrapper) !== redeemAmount || unwrappedDebit([call], underlying, unwrapper) !== redeemAmount) {
      return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The redeemed WETH was not unwrapped into ETH for the account by the market's unwrapper." });
    }
  } else if (transferred([call], underlying, venue.target, account) !== redeemAmount) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The redeemed tokens did not move from the market to the account." });
  }
  const nativeLeg = nativeLegFailure(receipts, underlying, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const received = native && unwrapped !== null ? unwrapped : redeemAmount;
  return {
    actualOutput: observed(output, received),
    evidence: [eventEvidence(step, call, observedAt, `Moonwell Redeem: ${formatUnits(redeemAmount, output.decimals, output.symbol)} paid to ${account}.`)],
  };
}

/* ----------------------------------------------------------------- metrics */

/** Supply APY, supplied underlying (TVL), cash and utilisation of a Moonwell market. */
export async function moonwellMetrics(venue: CTokenVenue): Promise<LendingMetrics> {
  const network = venue.network as EvmNetworkKey;
  const underlying = findAssetBySymbol(network, venue.asset);
  if (!underlying?.address) throw new PlatformError("VENUE_INVALID", `${venue.name} has no pinned underlying.`, 500);
  const context = { venue, network, token: getAddress(underlying.address), underlying };
  const state = await readMarket(context);
  const total = supplied(state);
  const utilization = ratio(state.borrows, total);
  return {
    venue: venue.id,
    protocol: venue.protocol,
    network,
    name: venue.name,
    asset: venue.asset,
    supplyApy: apyFromScaledRate(state.supplyRate, 10n ** 18n),
    apySource: "rate",
    totalSupplied: underlyingAmount(context, total),
    exitLiquidity: underlyingAmount(context, state.cash),
    utilization,
    observedAt: new Date().toISOString(),
    warnings: [
      ...(state.mintPaused ? ["Supply is paused."] : []),
      ...(state.cash === 0n || (utilization !== null && utilization > 0.99) ? ["No exit liquidity: deposits are refused until borrowers repay."] : []),
    ],
  };
}

export const moonwellAdapter: ProtocolAdapter = {
  id: "moonwell",
  protocols: ["moonwell"],
  label: "Moonwell",

  supports(route) {
    return supportsLending(route, "moonwell", "ctoken", { deposit: true, withdraw: true });
  },

  async plan(action): Promise<PlannedStep> {
    const { context, quote: planned } = await quote(action, "plan");
    const fees = await estimateEvmFeeUsd(context.network, planned.gas);
    return {
      protocol: "moonwell",
      title: title(context, planned.input, action.input.symbol, action.closePosition === true),
      mode: "wallet",
      input: assetAmount(action.input, planned.input.toString()),
      expectedOutput: assetAmount(planned.output, planned.expected.toString()),
      minimumOutput: assetAmount(planned.output, planned.minimum.toString()),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: 10 * planned.transactions.length,
      settlement: { kind: "same-network" },
      warnings: planned.warnings,
      transactionCount: planned.transactions.length,
      slippageBps: action.slippageBps,
      // The plan already encodes the payload (no provider involved): the preview simulates it.
      preview: { transactions: planned.transactions, approvalSpender: context.venue.spender, expiresAt: Math.floor(Date.now() / 1000) + LENDING_PREVIEW_TTL_SECONDS },
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const { context, quote: prepared } = await quote(action, "prepare");
    const fees = await estimateEvmFeeUsd(context.network, prepared.gas);
    return {
      transactions: prepared.transactions,
      records: payloadRecords(context.network, prepared.transactions),
      input: assetAmount(action.input, prepared.input.toString()),
      expectedOutput: assetAmount(prepared.output, prepared.expected.toString()),
      minimumOutput: assetAmount(prepared.output, prepared.minimum.toString()),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: prepared.warnings,
    };
  },

  async verify(context) {
    const venue = stepVenue(context.step, "ctoken");
    const underlying = venue ? findAssetBySymbol(venue.network, venue.asset)?.address : null;
    if (!venue || !underlying || !context.step.minimumOutput) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The step has no Moonwell registry market or output." } };
    }
    const observedAt = new Date(context.now).toISOString();
    const { result } = await verifyEvmReceipts(context, (receipts) =>
      context.step.kind === "withdraw"
        ? proveRedeem(context.step, venue, getAddress(underlying), receipts, observedAt)
        : proveMint(context.step, venue, getAddress(underlying), receipts, observedAt));
    return result;
  },
};
