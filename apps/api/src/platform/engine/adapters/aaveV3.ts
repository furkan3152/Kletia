/**
 * Aave V3 supply and withdraw on every reserve the registry pins
 * (YIELD_VENUES kind "aave-reserve": Base, Arbitrum One, Ethereum, OP
 * Mainnet, Polygon). The Pool, data provider and aToken come from the
 * planner-resolved venue; on-chain reads only confirm them.
 *
 * - Supply: native ETH is wrapped into the pinned WETH first; an exact
 *   approval of the Pool when the allowance is short; then
 *   Pool.supply(asset, amount, onBehalfOf = account, 0).
 * - Withdraw: Pool.withdraw(asset, amount, to = account), or
 *   type(uint256).max to close the position (also when the exact amount is
 *   the whole position: an exact full-balance withdraw can round past the
 *   scaled balance). Simulated from the account before planning and signing
 *   (no approval is involved). Frozen reserves still allow withdrawals;
 *   paused or inactive ones do not. Native ETH output is unwrapped after.
 * - Verify: the Pool Supply / Withdraw event bound to the landed calldata,
 *   the aToken mint and the underlying transfer (never the receipt status
 *   alone); the observed amount becomes the step's actual output.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  fromBaseUnits,
  nativeAssetId,
  yieldVenuesFor,
  type AaveReserveVenue,
  type EvmTransactionRequest,
  type IntentStep,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { assetAmount, type ResolvedAsset } from "../assets.js";
import { estimateEvmFeeUsd, evmClient, type EvmNetworkKey } from "../chains/evm.js";
import { assertEvmBalance } from "./evmTransfer.js";
import {
  APPROVE_GAS,
  apyFromPerSecond,
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
  SECONDS_PER_YEAR,
  simulate,
  SIMULATION_UNAVAILABLE,
  stepVenue,
  supportsLending,
  tokenSymbol,
  transferred,
  underlyingAmount,
  UNWRAP_GAS,
  unwrappedWeth,
  unwrapTransaction,
  withTimeout,
  WRAP_GAS,
  wrapTransaction,
  type LendingContext,
  type LendingMetrics,
} from "./lending/common.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter } from "./types.js";
import { evmEvents, stepOwner, verifyEvmReceipts, type EvmOutcome, type LandedEvmReceipt } from "./verification.js";

export const POOL_ABI = parseAbi([
  "function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)",
  "function withdraw(address asset,uint256 amount,address to) returns (uint256)",
  "function getReserveData(address asset) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))",
  "function getVirtualUnderlyingBalance(address asset) view returns (uint128)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)",
  "event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)",
  "error NotEnoughAvailableUserBalance()",
  "error InvalidAmount()",
  "error ReserveInactive()",
  "error ReservePaused()",
  "error ReserveFrozen()",
  "error SupplyCapExceeded()",
  "error HealthFactorLowerThanLiquidationThreshold()",
  "error WithdrawToAToken()",
]);
export const DATA_PROVIDER_ABI = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
  "function getPaused(address asset) view returns (bool)",
  "function getReserveCaps(address asset) view returns (uint256 borrowCap,uint256 supplyCap)",
]);

const SUPPLY_GAS = 260_000n;
const WITHDRAW_GAS = 300_000n;
const RAY = 10n ** 27n;

interface AaveMarket {
  readonly pool: Address;
  readonly dataProvider: Address;
  readonly assets: readonly string[];
}

function reservesOn(network: NetworkKey): AaveReserveVenue[] {
  return yieldVenuesFor(network, "aave-v3").filter((venue): venue is AaveReserveVenue => venue.kind === "aave-reserve");
}

/** Aave V3 markets (pool, data provider, reserve symbols) per network, derived from YIELD_VENUES. */
export const AAVE_V3_MARKETS: Readonly<Partial<Record<NetworkKey, AaveMarket>>> = Object.freeze(
  Object.fromEntries(
    reservesNetworks().map((network) => {
      const reserves = reservesOn(network);
      const first = reserves[0] as AaveReserveVenue;
      return [network, { pool: getAddress(first.target), dataProvider: getAddress(first.dataProvider), assets: reserves.map((venue) => venue.asset) }];
    }),
  ),
);

function reservesNetworks(): NetworkKey[] {
  return (Object.keys(CHAINS) as NetworkKey[]).filter((network) => reservesOn(network).length > 0);
}

type AaveContext = LendingContext<AaveReserveVenue>;

interface ReserveState {
  readonly liquidityRate: bigint;
  readonly accruedToTreasury: bigint;
  readonly liquidityIndex: bigint;
  readonly active: boolean;
  readonly frozen: boolean;
  readonly paused: boolean;
}

/** Reads the reserve and confirms it against the registry: aToken (Pool and data provider) and decimals. */
async function readReserve(context: Pick<AaveContext, "venue" | "network" | "token" | "underlying">): Promise<ReserveState> {
  const { venue, network, token } = context;
  const client = evmClient(network);
  const pool = getAddress(venue.target);
  const dataProvider = getAddress(venue.dataProvider);
  const [tokens, config, paused, data] = await withTimeout(Promise.all([
    client.readContract({ address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveTokensAddresses", args: [token] }),
    client.readContract({ address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveConfigurationData", args: [token] }),
    client.readContract({ address: dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getPaused", args: [token] }),
    client.readContract({ address: pool, abi: POOL_ABI, functionName: "getReserveData", args: [token] }),
  ]));
  assertPinned(tokens[0], venue.receipt.address, "aToken (data provider)", venue);
  assertPinned(data.aTokenAddress, venue.receipt.address, "aToken (pool)", venue);
  if (config[0] !== BigInt(context.underlying.decimals)) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} reports ${config[0]} decimals, not ${context.underlying.decimals}.`, 422);
  }
  return {
    liquidityRate: data.currentLiquidityRate,
    accruedToTreasury: data.accruedToTreasury,
    liquidityIndex: data.liquidityIndex,
    active: config[8],
    frozen: config[9],
    paused,
  };
}

/** Supply needs an active, unpaused, unfrozen reserve; withdrawals only active and unpaused. */
async function openReserve(context: AaveContext): Promise<ReserveState> {
  const state = await readReserve(context);
  if (!state.active || state.paused || (context.kind === "deposit" && state.frozen)) {
    throw new PlatformError(
      "RESERVE_UNAVAILABLE",
      `${context.venue.name} on ${CHAINS[context.network].name} is ${!state.active ? "inactive" : state.paused ? "paused" : "frozen"}; it does not accept ${context.kind === "deposit" ? "supply" : "withdrawals"} right now.`,
      422,
    );
  }
  return state;
}

function reserveApy(state: ReserveState): number | null {
  return apyFromPerSecond(Number(state.liquidityRate) / 1e27 / SECONDS_PER_YEAR);
}

/** Underlying the Pool can pay out now (virtual balance on 3.1+, else the aToken's cash). */
async function exitLiquidity(context: Pick<AaveContext, "venue" | "network" | "token">): Promise<bigint> {
  const client = evmClient(context.network);
  return withTimeout(
    client
      .readContract({ address: getAddress(context.venue.target), abi: POOL_ABI, functionName: "getVirtualUnderlyingBalance", args: [context.token] })
      .catch(() => client.readContract({ address: context.token, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(context.venue.receipt.address)] })),
  );
}

async function aTokenBalance(context: AaveContext): Promise<bigint> {
  return withTimeout(evmClient(context.network).readContract({
    address: getAddress(context.venue.receipt.address),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [context.owner],
  }));
}

async function assertSupplyCap(context: AaveContext, amount: bigint, state: ReserveState): Promise<void> {
  const client = evmClient(context.network);
  const [caps, supply] = await withTimeout(Promise.all([
    client.readContract({ address: getAddress(context.venue.dataProvider), abi: DATA_PROVIDER_ABI, functionName: "getReserveCaps", args: [context.token] }),
    client.readContract({ address: getAddress(context.venue.receipt.address), abi: erc20Abi, functionName: "totalSupply" }),
  ]));
  const cap = caps[1] * 10n ** BigInt(context.underlying.decimals);
  const treasury = (state.accruedToTreasury * state.liquidityIndex) / RAY;
  if (caps[1] > 0n && supply + treasury + amount > cap) {
    throw new PlatformError(
      "RESERVE_UNAVAILABLE",
      `${context.venue.name} is at its supply cap (${formatUnits(cap, context.underlying.decimals, context.underlying.symbol)}); ${formatUnits(amount, context.underlying.decimals, context.underlying.symbol)} does not fit.`,
      422,
    );
  }
}

function title(context: AaveContext, amount: bigint, symbol: string, close: boolean): string {
  const chain = CHAINS[context.network].name;
  const what = close ? `all ${symbol}` : `${formatAmount(fromBaseUnits(amount, context.underlying.decimals))} ${symbol}`;
  return context.kind === "deposit"
    ? `Supply ${what} to Aave V3 on ${chain}`
    : `Withdraw ${what} from Aave V3 on ${chain}`;
}

interface Quote {
  readonly transactions: EvmTransactionRequest[];
  readonly input: bigint;
  readonly expected: bigint;
  readonly minimum: bigint;
  /** Output asset: the aToken for supply, the underlying (or native ETH) for withdraw. */
  readonly output: ResolvedAsset;
  readonly gas: bigint;
  readonly warnings: string[];
}

async function supplyQuote(action: AdapterAction, context: AaveContext, stage: "plan" | "prepare"): Promise<Quote> {
  const { venue, network, owner, token } = context;
  const amount = BigInt(action.amount);
  if (amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to supply.", 422);
  if (stage === "prepare") {
    await assertEvmBalance(network, owner, context.native ? null : token, amount, action.input.symbol, action.input.decimals);
  }
  const state = await openReserve(context);
  await assertSupplyCap(context, amount, state);
  const pool = getAddress(venue.spender);
  const allowance = stage === "plan" ? await plannedAllowance(context, pool) : undefined;
  const transactions: EvmTransactionRequest[] = [];
  if (context.native) transactions.push(wrapTransaction(context, amount));
  const approval = await exactApproval(context, pool, amount, allowance);
  if (approval) transactions.push(approval);
  const data = encodeFunctionData({ abi: POOL_ABI, functionName: "supply", args: [token, amount, owner, 0] });
  const warnings: string[] = [];
  let gas: bigint | string = SUPPLY_GAS;
  if (stage === "prepare" && transactions.length === 0) {
    // Only an un-approved, un-wrapped supply can be dry-run before signing.
    const request = { from: owner, to: venue.target, data };
    const simulation = await simulate(network, request, POOL_ABI);
    assertSimulation(simulation, `supply to ${venue.name}`);
    if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
    gas = await callGas(network, request, SUPPLY_GAS);
  }
  transactions.push(evmCall(context, venue.target, data, 0n, gas, title(context, amount, context.underlying.symbol, false)));
  const symbol = await tokenSymbol(network, venue.receipt.address, `a${context.underlying.symbol}`);
  return {
    transactions,
    input: amount,
    expected: amount,
    // The aToken mint rounds the scaled amount down (credits amount - 1 wei).
    minimum: lessRounding(amount),
    output: receiptAsset(network, venue.receipt, symbol, `Aave ${context.underlying.symbol}`),
    gas: SUPPLY_GAS + (approval ? APPROVE_GAS : 0n) + (context.native ? WRAP_GAS : 0n),
    warnings: [...warnings, ...(stage === "plan" ? apyNote({ supplyApy: reserveApy(state), apySource: "rate" }) : [])],
  };
}

async function withdrawQuote(action: AdapterAction, context: AaveContext): Promise<Quote> {
  const { venue, network, owner, token } = context;
  await openReserve(context);
  const client = evmClient(network);
  const [position, liquidity, account] = await Promise.all([
    aTokenBalance(context),
    exitLiquidity(context),
    withTimeout(client.readContract({ address: getAddress(venue.target), abi: POOL_ABI, functionName: "getUserAccountData", args: [owner] })).catch(() => null),
  ]);
  const symbol = context.underlying.symbol;
  if (position === 0n) {
    throw new PlatformError("POSITION_EMPTY", `The account has no ${symbol} supplied to Aave V3 on ${CHAINS[network].name}.`, 422);
  }
  const requested = action.closePosition ? position : BigInt(action.amount);
  if (requested <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to withdraw.", 422);
  if (requested > position) {
    throw new PlatformError(
      "INSUFFICIENT_BALANCE",
      `The account has ${formatUnits(position, context.underlying.decimals, symbol)} supplied to Aave V3 on ${CHAINS[network].name}; ${formatUnits(requested, context.underlying.decimals, symbol)} was requested.`,
      422,
    );
  }
  if (liquidity < requested) {
    throw new PlatformError(
      "VENUE_ILLIQUID",
      `Aave V3 ${symbol} on ${CHAINS[network].name} can pay out ${formatUnits(liquidity, context.underlying.decimals, symbol)} right now (borrowers hold the rest); ${formatUnits(requested, context.underlying.decimals, symbol)} cannot be withdrawn yet.`,
      422,
    );
  }
  // The whole position is withdrawn with MAX: an exact full-balance amount can round past the scaled balance.
  const close = action.closePosition === true || requested === position;
  const data = encodeFunctionData({ abi: POOL_ABI, functionName: "withdraw", args: [token, close ? MAX_UINT256 : requested, owner] });
  const request = { from: owner, to: venue.target, data };
  const simulation = await simulate(network, request, POOL_ABI);
  assertSimulation(simulation, `withdrawal from ${venue.name}`);
  const warnings = simulation.status === "unavailable" ? [SIMULATION_UNAVAILABLE] : [];
  if (account && account[1] > 0n) {
    warnings.push("The account has an open Aave borrow; the withdrawal lowers its health factor (it was simulated against it).");
  }
  const gas = simulation.status === "ok" ? await callGas(network, request, WITHDRAW_GAS) : WITHDRAW_GAS.toString();
  // A close credits at least the position read now (interest only adds); rounding may shave a wei.
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

async function quote(action: AdapterAction, stage: "plan" | "prepare"): Promise<{ context: AaveContext; quote: Quote }> {
  const context = lendingContext(action, "aave-reserve", "aave-v3");
  const result = context.kind === "deposit" ? await supplyQuote(action, context, stage) : await withdrawQuote(action, context);
  return { context, quote: result };
}

/* ------------------------------------------------------------ verification */

function proveSupply(step: IntentStep, venue: AaveReserveVenue, underlying: Address, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the Aave Pool." });
  const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.input as Hex });
  if (decoded.functionName !== "supply" || !sameAddress(decoded.args[0], underlying) || !sameAddress(decoded.args[2], account)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Pool call is not a supply of the venue's asset for the step account." });
  }
  const amount = decoded.args[1];
  const supplied = evmEvents([call], { address: venue.target, abi: POOL_ABI, eventName: "Supply" }).find((event) =>
    sameAddress(event.args.reserve, underlying) && sameAddress(event.args.user, account) && sameAddress(event.args.onBehalfOf, account) && event.args.amount === amount);
  if (!supplied) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Pool emitted no Supply event for the prepared amount and account." });
  const pulled = transferred([call], underlying, account, venue.receipt.address);
  if (pulled !== amount) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The supplied tokens did not move from the account to the aToken." });
  const minted = transferred([call], venue.receipt.address, zeroAddress, account);
  if (minted < lessRounding(amount)) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The aToken mint to the account is below the supplied amount." });
  const nativeLeg = nativeLegFailure(receipts, underlying, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const receipt = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  return {
    actualOutput: observed(receipt, amount),
    evidence: [eventEvidence(step, call, observedAt, `Aave Pool Supply: ${formatUnits(amount, receipt.decimals, step.input?.symbol ?? "")} credited to ${account} (${receipt.symbol} minted).`)],
  };
}

function proveWithdraw(step: IntentStep, venue: AaveReserveVenue, underlying: Address, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the Aave Pool." });
  const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.input as Hex });
  if (decoded.functionName !== "withdraw" || !sameAddress(decoded.args[0], underlying) || !sameAddress(decoded.args[2], account)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Pool call is not a withdrawal of the venue's asset to the step account." });
  }
  const requested = decoded.args[1];
  const event = evmEvents([call], { address: venue.target, abi: POOL_ABI, eventName: "Withdraw" }).find((entry) =>
    sameAddress(entry.args.reserve, underlying) && sameAddress(entry.args.user, account) && sameAddress(entry.args.to, account));
  if (!event) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The Pool emitted no Withdraw event for the step account." });
  const amount = event.args.amount;
  const floor = requested === MAX_UINT256 ? (lowestFloor(step) ?? 1n) : requested;
  if (requested === MAX_UINT256 ? amount < floor : amount !== requested) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The Pool withdrew ${amount} base units; the plan required ${requested === MAX_UINT256 ? "at least " : ""}${floor}.` });
  }
  if (transferred([call], underlying, venue.receipt.address, account) !== amount) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The withdrawn tokens did not move from the aToken to the account." });
  }
  const nativeLeg = nativeLegFailure(receipts, underlying, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const output = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  // A native ETH output is what the step's own unwrap transaction released.
  const received = output.asset === nativeAssetId(step.network) ? unwrappedWeth(receipts, underlying) : amount;
  if (received === null) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The ETH withdrawal landed without its unwrap transaction." });
  return {
    actualOutput: observed(output, received),
    evidence: [eventEvidence(step, call, observedAt, `Aave Pool Withdraw: ${formatUnits(amount, output.decimals, output.symbol)} paid to ${account}.`)],
  };
}

/* ----------------------------------------------------------------- metrics */

/** Supply APY, aToken supply (TVL), withdraw liquidity and utilisation of an Aave reserve. */
export async function aaveMetrics(venue: AaveReserveVenue): Promise<LendingMetrics> {
  const network = venue.network as EvmNetworkKey;
  const underlying = findAssetBySymbol(network, venue.asset);
  if (!underlying?.address) throw new PlatformError("VENUE_INVALID", `${venue.name} has no pinned underlying.`, 500);
  const context = { venue, network, token: getAddress(underlying.address), underlying };
  const [state, supplied, liquidity] = await Promise.all([
    readReserve(context),
    withTimeout(evmClient(network).readContract({ address: getAddress(venue.receipt.address), abi: erc20Abi, functionName: "totalSupply" })),
    exitLiquidity(context),
  ]);
  const warnings = [
    ...(!state.active ? ["The reserve is inactive."] : []),
    ...(state.paused ? ["The reserve is paused."] : []),
    ...(state.frozen ? ["The reserve is frozen: withdrawals only, no new supply."] : []),
  ];
  return {
    venue: venue.id,
    protocol: venue.protocol,
    network,
    name: venue.name,
    asset: venue.asset,
    supplyApy: reserveApy(state),
    apySource: "rate",
    totalSupplied: underlyingAmount(context, supplied),
    exitLiquidity: underlyingAmount(context, liquidity),
    utilization: ratio(supplied > liquidity ? supplied - liquidity : 0n, supplied),
    observedAt: new Date().toISOString(),
    warnings,
  };
}

export const aaveV3Adapter: ProtocolAdapter = {
  id: "aave-v3",
  protocols: ["aave-v3"],
  label: "Aave V3",

  supports(route) {
    return supportsLending(route, "aave-v3", "aave-reserve", { deposit: true, withdraw: true });
  },

  async plan(action): Promise<PlannedStep> {
    const { context, quote: planned } = await quote(action, "plan");
    const fees = await estimateEvmFeeUsd(context.network, planned.gas);
    return {
      protocol: "aave-v3",
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
    const venue = stepVenue(context.step, "aave-reserve");
    const underlying = venue ? findAssetBySymbol(venue.network, venue.asset)?.address : null;
    if (!venue || !underlying || !context.step.minimumOutput) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The step has no Aave V3 registry venue or output." } };
    }
    const observedAt = new Date(context.now).toISOString();
    const { result } = await verifyEvmReceipts(context, (receipts) =>
      context.step.kind === "withdraw"
        ? proveWithdraw(context.step, venue, getAddress(underlying), receipts, observedAt)
        : proveSupply(context.step, venue, getAddress(underlying), receipts, observedAt));
    return result;
  },
};
