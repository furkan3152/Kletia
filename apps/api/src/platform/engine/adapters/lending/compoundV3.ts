/**
 * Compound V3 (Comet) base-asset supply and withdraw on every Comet the
 * registry pins (YIELD_VENUES kind "comet": USDC and WETH markets on Base,
 * Arbitrum One, Ethereum and OP Mainnet). The Comet proxy is the target, the
 * spender and the position token.
 *
 * Comet specifics this adapter encodes:
 * - `supply(base, amount)` repays an open borrow before crediting a supply,
 *   and `supply(base, MAX)` means "repay everything". Kletia never encodes MAX
 *   for a supply and refuses accounts with an open base borrow.
 * - `withdraw(base, amount)` above the balance silently opens a borrow when
 *   the account has collateral. Kletia refuses amounts above the balance and
 *   closes positions with `withdraw(base, MAX)` (= the whole balance, never a
 *   borrow); verification requires the burn to cover the amount.
 * - Outcomes: `Supply(from, dst, amount)` plus the Comet mint
 *   `Transfer(0 -> dst)` (a supply that only repaid debt mints nothing:
 *   SUPPLY_REPAID_DEBT); `Withdraw(src, to, amount)` plus the burn
 *   `Transfer(src -> 0)` and the base-token transfer.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, parseAbi, zeroAddress, type Hex } from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  fromBaseUnits,
  nativeAssetId,
  type CometVenue,
  type EvmTransactionRequest,
  type IntentStep,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { assetAmount, type ResolvedAsset } from "../../assets.js";
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
  simulate,
  SIMULATION_UNAVAILABLE,
  stepVenue,
  supportsLending,
  tokenSymbol,
  transferred,
  underlyingAmount,
  unwrappedWeth,
  unwrapTransaction,
  UNWRAP_GAS,
  withTimeout,
  WRAP_GAS,
  wrapTransaction,
  type LendingContext,
  type LendingMetrics,
} from "./common.js";

export const COMET_ABI = parseAbi([
  "function supply(address asset,uint256 amount)",
  "function withdraw(address asset,uint256 amount)",
  "function baseToken() view returns (address)",
  "function decimals() view returns (uint8)",
  "function isSupplyPaused() view returns (bool)",
  "function isWithdrawPaused() view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function getUtilization() view returns (uint256)",
  "function getSupplyRate(uint256 utilization) view returns (uint64)",
  "function totalSupply() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "event Supply(address indexed from,address indexed dst,uint256 amount)",
  "event Withdraw(address indexed src,address indexed to,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 amount)",
  "error Paused()",
  "error NotCollateralized()",
  "error BorrowTooSmall()",
  "error InsufficientReserves()",
  "error TransferInFailed()",
  "error TransferOutFailed()",
]);

const SUPPLY_GAS = 160_000n;
const WITHDRAW_GAS = 160_000n;

type CometContext = LendingContext<CometVenue>;

interface CometState {
  readonly supplyPaused: boolean;
  readonly withdrawPaused: boolean;
}

/** Confirms the Comet against the registry (base token, decimals) and reads its pause flags. */
async function readComet(context: Pick<CometContext, "venue" | "network" | "token" | "underlying">): Promise<CometState> {
  const client = evmClient(context.network);
  const comet = getAddress(context.venue.target);
  const [base, decimals, supplyPaused, withdrawPaused] = await withTimeout(Promise.all([
    client.readContract({ address: comet, abi: COMET_ABI, functionName: "baseToken" }),
    client.readContract({ address: comet, abi: COMET_ABI, functionName: "decimals" }),
    client.readContract({ address: comet, abi: COMET_ABI, functionName: "isSupplyPaused" }),
    client.readContract({ address: comet, abi: COMET_ABI, functionName: "isWithdrawPaused" }),
  ]));
  assertPinned(base, context.token, "base token", context.venue);
  if (decimals !== context.underlying.decimals || decimals !== context.venue.receipt.decimals) {
    throw new PlatformError("VENUE_UNVERIFIED", `${context.venue.name} reports ${decimals} decimals, not ${context.underlying.decimals}.`, 422);
  }
  return { supplyPaused, withdrawPaused };
}

function assertOpen(context: CometContext, state: CometState): void {
  const paused = context.kind === "deposit" ? state.supplyPaused : state.withdrawPaused;
  if (paused) {
    throw new PlatformError(
      "RESERVE_UNAVAILABLE",
      `${context.venue.name} on ${CHAINS[context.network].name} has ${context.kind === "deposit" ? "supply" : "withdrawals"} paused.`,
      422,
    );
  }
}

async function cometRead(context: CometContext, functionName: "balanceOf" | "borrowBalanceOf"): Promise<bigint> {
  return withTimeout(evmClient(context.network).readContract({
    address: getAddress(context.venue.target),
    abi: COMET_ABI,
    functionName,
    args: [context.owner],
  }));
}

async function supplyApy(context: Pick<CometContext, "venue" | "network">): Promise<number | null> {
  const client = evmClient(context.network);
  const comet = getAddress(context.venue.target);
  const utilization = await withTimeout(client.readContract({ address: comet, abi: COMET_ABI, functionName: "getUtilization" }));
  const rate = await withTimeout(client.readContract({ address: comet, abi: COMET_ABI, functionName: "getSupplyRate", args: [utilization] }));
  return apyFromScaledRate(rate, 10n ** 18n);
}

function title(context: CometContext, amount: bigint, symbol: string, close: boolean): string {
  const chain = CHAINS[context.network].name;
  const what = close ? `all ${symbol}` : `${formatAmount(fromBaseUnits(amount, context.underlying.decimals))} ${symbol}`;
  return context.kind === "deposit" ? `Supply ${what} to Compound V3 on ${chain}` : `Withdraw ${what} from Compound V3 on ${chain}`;
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

async function supplyQuote(action: AdapterAction, context: CometContext, stage: "plan" | "prepare"): Promise<Quote> {
  const { venue, network, owner, token } = context;
  const amount = BigInt(action.amount);
  if (amount <= 0n || amount >= MAX_UINT256) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to supply.", 422);
  if (stage === "prepare") {
    await assertEvmBalance(network, owner, context.native ? null : token, amount, action.input.symbol, action.input.decimals);
  }
  const [state, borrowed, apy] = await Promise.all([
    readComet(context),
    cometRead(context, "borrowBalanceOf"),
    stage === "plan" ? supplyApy(context).catch(() => null) : Promise.resolve(null),
  ]);
  assertOpen(context, state);
  if (borrowed > 0n) {
    throw new PlatformError(
      "VENUE_BORROW_OPEN",
      `The account owes ${formatUnits(borrowed, context.underlying.decimals, context.underlying.symbol)} on ${venue.name}; a supply would repay that borrow instead of earning. Repay it first or use another venue.`,
      422,
    );
  }
  const comet = getAddress(venue.spender);
  const allowance = stage === "plan" ? await plannedAllowance(context, comet) : undefined;
  const transactions: EvmTransactionRequest[] = [];
  if (context.native) transactions.push(wrapTransaction(context, amount));
  const approval = await exactApproval(context, comet, amount, allowance);
  if (approval) transactions.push(approval);
  const data = encodeFunctionData({ abi: COMET_ABI, functionName: "supply", args: [token, amount] });
  const warnings: string[] = [];
  let gas: bigint | string = SUPPLY_GAS;
  if (stage === "prepare" && transactions.length === 0) {
    const request = { from: owner, to: venue.target, data };
    const simulation = await simulate(network, request, COMET_ABI);
    assertSimulation(simulation, `supply to ${venue.name}`);
    if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
    gas = await callGas(network, request, SUPPLY_GAS);
  }
  transactions.push(evmCall(context, venue.target, data, 0n, gas, title(context, amount, context.underlying.symbol, false)));
  const symbol = await tokenSymbol(network, venue.receipt.address, `c${context.underlying.symbol}v3`);
  return {
    transactions,
    input: amount,
    expected: amount,
    // Comet credits the present value of the rounded-down principal (amount - 1 wei).
    minimum: lessRounding(amount),
    output: receiptAsset(network, venue.receipt, symbol, `Compound V3 ${context.underlying.symbol}`),
    gas: SUPPLY_GAS + (approval ? APPROVE_GAS : 0n) + (context.native ? WRAP_GAS : 0n),
    warnings: [...warnings, ...apyNote(apy === null ? null : { supplyApy: apy, apySource: "rate" })],
  };
}

async function withdrawQuote(action: AdapterAction, context: CometContext): Promise<Quote> {
  const { venue, network, owner, token } = context;
  const client = evmClient(network);
  const [state, position, liquidity] = await Promise.all([
    readComet(context),
    cometRead(context, "balanceOf"),
    withTimeout(client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(venue.target)] })),
  ]);
  assertOpen(context, state);
  const symbol = context.underlying.symbol;
  if (position === 0n) {
    throw new PlatformError("POSITION_EMPTY", `The account has no ${symbol} supplied to Compound V3 on ${CHAINS[network].name}.`, 422);
  }
  const requested = action.closePosition ? position : BigInt(action.amount);
  if (requested <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to withdraw.", 422);
  if (requested > position) {
    // Above the balance Comet would open a borrow against collateral instead of failing.
    throw new PlatformError(
      "INSUFFICIENT_BALANCE",
      `The account has ${formatUnits(position, context.underlying.decimals, symbol)} supplied to Compound V3 on ${CHAINS[network].name}; ${formatUnits(requested, context.underlying.decimals, symbol)} was requested.`,
      422,
    );
  }
  if (liquidity < requested) {
    throw new PlatformError(
      "VENUE_ILLIQUID",
      `${venue.name} on ${CHAINS[network].name} holds ${formatUnits(liquidity, context.underlying.decimals, symbol)} right now (borrowers hold the rest); ${formatUnits(requested, context.underlying.decimals, symbol)} cannot be withdrawn yet.`,
      422,
    );
  }
  // MAX withdraws exactly the balance at execution and can never open a borrow.
  const close = action.closePosition === true || requested === position;
  const data = encodeFunctionData({ abi: COMET_ABI, functionName: "withdraw", args: [token, close ? MAX_UINT256 : requested] });
  const request = { from: owner, to: venue.target, data };
  const simulation = await simulate(network, request, COMET_ABI);
  assertSimulation(simulation, `withdrawal from ${venue.name}`);
  const warnings = simulation.status === "unavailable" ? [SIMULATION_UNAVAILABLE] : [];
  const gas = simulation.status === "ok" ? await callGas(network, request, WITHDRAW_GAS) : WITHDRAW_GAS.toString();
  const minimum = close ? lessRounding(requested) : requested;
  const transactions = [evmCall(context, venue.target, data, 0n, gas, title(context, requested, symbol, action.closePosition === true))];
  if (context.native) {
    transactions.push(unwrapTransaction(context, minimum));
    if (close) warnings.push("Interest accrued after preparing stays in the account as WETH.");
  }
  return {
    transactions,
    input: requested,
    expected: requested,
    minimum,
    output: action.input,
    gas: WITHDRAW_GAS + (context.native ? UNWRAP_GAS : 0n),
    warnings,
  };
}

async function quote(action: AdapterAction, stage: "plan" | "prepare"): Promise<{ context: CometContext; quote: Quote }> {
  const context = lendingContext(action, "comet", "compound-v3");
  const result = context.kind === "deposit" ? await supplyQuote(action, context, stage) : await withdrawQuote(action, context);
  return { context, quote: result };
}

/* ------------------------------------------------------------ verification */

function proveSupply(step: IntentStep, venue: CometVenue, base: string, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the Comet." });
  const decoded = decodeFunctionData({ abi: COMET_ABI, data: call.input as Hex });
  if (decoded.functionName !== "supply" || !sameAddress(decoded.args[0], base)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Comet call is not a supply of the base asset." });
  }
  const amount = decoded.args[1];
  const supplied = evmEvents([call], { address: venue.target, abi: COMET_ABI, eventName: "Supply" }).find((event) =>
    sameAddress(event.args.from, account) && sameAddress(event.args.dst, account) && event.args.amount === amount);
  if (!supplied) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Comet emitted no Supply event for the prepared amount and account." });
  if (transferred([call], base, account, venue.target) !== amount) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The supplied tokens did not move from the account to the Comet." });
  }
  const minted = transferred([call], venue.target, zeroAddress, account);
  if (minted < lessRounding(amount)) {
    return outcomeFailure({
      code: "SUPPLY_REPAID_DEBT",
      message: `The supply repaid an open Compound borrow: only ${minted} of ${amount} base units were credited as a supply position.`,
    });
  }
  const nativeLeg = nativeLegFailure(receipts, base, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const receipt = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  return {
    actualOutput: observed(receipt, minted),
    evidence: [eventEvidence(step, call, observedAt, `Comet Supply: ${formatUnits(amount, receipt.decimals, step.input?.symbol ?? "")} from ${account}; ${formatUnits(minted, receipt.decimals, receipt.symbol)} credited.`)],
  };
}

function proveWithdraw(step: IntentStep, venue: CometVenue, base: string, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the Comet." });
  const decoded = decodeFunctionData({ abi: COMET_ABI, data: call.input as Hex });
  if (decoded.functionName !== "withdraw" || !sameAddress(decoded.args[0], base)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Comet call is not a withdrawal of the base asset." });
  }
  const requested = decoded.args[1];
  const event = evmEvents([call], { address: venue.target, abi: COMET_ABI, eventName: "Withdraw" }).find((entry) =>
    sameAddress(entry.args.src, account) && sameAddress(entry.args.to, account));
  if (!event) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Comet emitted no Withdraw event for the step account." });
  const amount = event.args.amount;
  const floor = requested === MAX_UINT256 ? (lowestFloor(step) ?? 1n) : requested;
  if (requested === MAX_UINT256 ? amount < floor : amount !== requested) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The Comet withdrew ${amount} base units; the plan required ${requested === MAX_UINT256 ? "at least " : ""}${floor}.` });
  }
  // A withdrawal beyond the supply balance becomes a borrow: the burned position must cover the amount.
  const burned = transferred([call], venue.target, account, zeroAddress);
  if (burned < lessRounding(amount)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `Only ${burned} of ${amount} base units came out of the supply position; the rest was borrowed.` });
  }
  if (transferred([call], base, venue.target, account) !== amount) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The withdrawn tokens did not move from the Comet to the account." });
  }
  const nativeLeg = nativeLegFailure(receipts, base, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const output = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  // A native ETH output is what the step's own unwrap transaction released.
  const received = output.asset === nativeAssetId(step.network) ? unwrappedWeth(receipts, base) : amount;
  if (received === null) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The ETH withdrawal landed without its unwrap transaction." });
  return {
    actualOutput: observed(output, received),
    evidence: [eventEvidence(step, call, observedAt, `Comet Withdraw: ${formatUnits(amount, output.decimals, output.symbol)} paid to ${account}.`)],
  };
}

/* ----------------------------------------------------------------- metrics */

/** Supply APY, total supply (TVL), cash and utilisation of a Comet market. */
export async function compoundMetrics(venue: CometVenue): Promise<LendingMetrics> {
  const network = venue.network as EvmNetworkKey;
  const underlying = findAssetBySymbol(network, venue.asset);
  if (!underlying?.address) throw new PlatformError("VENUE_INVALID", `${venue.name} has no pinned underlying.`, 500);
  const context = { venue, network, token: getAddress(underlying.address), underlying };
  const client = evmClient(network);
  const comet = getAddress(venue.target);
  const [state, apy, supplied, cash, utilization] = await Promise.all([
    readComet(context),
    supplyApy(context),
    withTimeout(client.readContract({ address: comet, abi: COMET_ABI, functionName: "totalSupply" })),
    withTimeout(client.readContract({ address: context.token, abi: erc20Abi, functionName: "balanceOf", args: [comet] })),
    withTimeout(client.readContract({ address: comet, abi: COMET_ABI, functionName: "getUtilization" })),
  ]);
  return {
    venue: venue.id,
    protocol: venue.protocol,
    network,
    name: venue.name,
    asset: venue.asset,
    supplyApy: apy,
    apySource: "rate",
    totalSupplied: underlyingAmount(context, supplied),
    exitLiquidity: underlyingAmount(context, cash),
    utilization: ratio(utilization, 10n ** 18n),
    observedAt: new Date().toISOString(),
    warnings: [...(state.supplyPaused ? ["Supply is paused."] : []), ...(state.withdrawPaused ? ["Withdrawals are paused."] : [])],
  };
}

export const compoundV3Adapter: ProtocolAdapter = {
  id: "compound-v3",
  protocols: ["compound-v3"],
  label: "Compound V3",

  supports(route) {
    return supportsLending(route, "compound-v3", "comet", { deposit: true, withdraw: true });
  },

  async plan(action): Promise<PlannedStep> {
    const { context, quote: planned } = await quote(action, "plan");
    const fees = await estimateEvmFeeUsd(context.network, planned.gas);
    return {
      protocol: "compound-v3",
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
    const venue = stepVenue(context.step, "comet");
    const base = venue ? findAssetBySymbol(venue.network, venue.asset)?.address : null;
    if (!venue || !base || !context.step.minimumOutput) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The step has no Compound V3 registry venue or output." } };
    }
    const observedAt = new Date(context.now).toISOString();
    const { result } = await verifyEvmReceipts(context, (receipts) =>
      context.step.kind === "withdraw"
        ? proveWithdraw(context.step, venue, getAddress(base), receipts, observedAt)
        : proveSupply(context.step, venue, getAddress(base), receipts, observedAt));
    return result;
  },
};
