/**
 * Curve stable-pool swaps on pinned pools.
 *
 * Every address comes from CURVE_POOLS in @kletia/core:
 * - Only same-network ERC-20 swaps whose two tokens are both coins of one
 *   pinned plain pool are served (native ETH pools are out of scope). The
 *   coin indices come from the pin's coin list, matched by registry address.
 * - Plan and prepare re-read `coins(i)` and `coins(j)` from the pool; any
 *   disagreement with the registry address refuses the swap
 *   (VENUE_UNVERIFIED, fail closed).
 * - The quote is the pool's own `get_dy(i, j, dx)` (fees included), held to
 *   the Chainlink band like every Kletia-encoded swap (oracleGuard).
 * - The minimum output is the quote less the slippage (at most 3 %) and is
 *   enforced on-chain by `min_dy` (floor "onchain").
 * - Transactions: an exact approval of the pool (the only spender) when the
 *   allowance is short, reset to zero first for tokens that need it
 *   (Ethereum USDT, `approvalReset`), then `exchange(i, j, dx, min_dy)` on the
 *   pool. The pool pays `msg.sender`, so the account receives the output.
 * - Verify: binding-matched receipts, the landed call is `exchange` with the
 *   recorded indices, the pool's `TokenExchange(buyer = account, i, dx, j, dy)`
 *   with `dy` at or above the lowest prepared floor, and the output token
 *   credited to the account by an ERC-20 Transfer at or above that floor.
 *
 * The step ref records the route (`provider`: `<pool slug>:<i>:<j>`) so
 * prepare re-quotes the same pool and verify re-derives it.
 */
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import {
  CHAINS,
  curvePoolsFor,
  findAssetBySymbol,
  formatAmount,
  fromBaseUnits,
  parseAssetId,
  type CurvePool,
  type EvmTransactionRequest,
  type IntentStep,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { assetAmount, type ResolvedAsset } from "../../assets.js";
import { erc20CreditFromLogs, estimateEvmFeeUsd, evmChainId, isEvmNetwork, rawEthCall, readAllowance, type EvmNetworkKey } from "../../chains/evm.js";
import { listedAsset } from "../../policy/feeds.js";
import { decodeStepRef } from "../../stepRef.js";
import { assertEvmBalance } from "../evmTransfer.js";
import {
  APPROVE_GAS,
  assertSimulation,
  callGas,
  eventEvidence,
  exactApprovalCalls,
  landedCall,
  observed,
  outcomeFailure,
  payloadRecords,
  sameAddress,
  simulate,
  SIMULATION_UNAVAILABLE,
} from "../lending/common.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter } from "../types.js";
import { lowestPreparedFloor, stepOwner, verifyEvmReceipts, type EvmOutcome, type LandedEvmReceipt } from "../verification.js";
import { oracleGuard } from "./oracleGuard.js";

const PROTOCOL = "curve" as const;
const LABEL = "Curve";

/** Slippage applied at most, whatever the request asks (same cap as the other Kletia-encoded swaps). */
export const MAX_CURVE_SLIPPAGE_BPS = 300;
/** Plan-time transactions stay valid for the asset-change preview this long. */
export const CURVE_PREVIEW_TTL_SECONDS = 10 * 60;
/** A plain-pool exchange (3pool with USDT legs measures ~150k); used when the call cannot be estimated. */
export const CURVE_FALLBACK_GAS = 250_000n;

/* --------------------------------------------------------------------- ABI */

/** Plain stable pool (3pool generation): uint256 coin index, int128 exchange indices, no return value from exchange. */
export const CURVE_PLAIN_POOL_ABI = parseAbi([
  "function coins(uint256 i) view returns (address)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
]);

const TOKEN_EXCHANGE = CURVE_PLAIN_POOL_ABI.filter((item) => item.type === "event" && item.name === "TokenExchange");

/* ------------------------------------------------------------------ routes */

function slugOf(pool: CurvePool): string {
  return pool.id.slice(pool.id.lastIndexOf(":") + 1);
}

/** Registry address of a pin's coin symbol on the pool's network (null when the registry has no such ERC-20). */
function coinAddress(pool: CurvePool, index: number): Address | null {
  const symbol = pool.coins[index];
  if (symbol === undefined) return null;
  const asset = findAssetBySymbol(pool.network, symbol);
  return asset?.address ? getAddress(asset.address) : null;
}

/** Index of `token` in the pin's coin list, or -1. */
function coinIndex(pool: CurvePool, token: string): number {
  return pool.coins.findIndex((_, index) => sameAddress(coinAddress(pool, index), token));
}

export interface CurveRoute {
  readonly pool: CurvePool;
  readonly i: number;
  readonly j: number;
}

/** The step-ref route: `<pool slug>:<i>:<j>`. */
export function encodeCurveRoute(route: CurveRoute): string {
  return `${slugOf(route.pool)}:${route.i}:${route.j}`;
}

/** Parses a recorded route against the pinned pools of `network`; null when it names none or an index is out of range. */
export function decodeCurveRoute(network: NetworkKey, value: string | undefined): CurveRoute | null {
  if (!value) return null;
  const match = /^([a-z0-9-]{1,24}):(\d{1,2}):(\d{1,2})$/u.exec(value);
  if (!match) return null;
  const pool = curvePoolsFor(network).find((entry) => slugOf(entry) === match[1]);
  if (!pool) return null;
  const i = Number(match[2]);
  const j = Number(match[3]);
  if (i === j || i >= pool.coins.length || j >= pool.coins.length) return null;
  return { pool, i, j };
}

/** Pinned pools of the network holding both tokens, with their indices. */
export function curveRoutesFor(network: NetworkKey, tokenIn: string, tokenOut: string): CurveRoute[] {
  if (sameAddress(tokenIn, tokenOut)) return [];
  return curvePoolsFor(network).flatMap((pool) => {
    if (pool.kind !== "plain") return [];
    const i = coinIndex(pool, tokenIn);
    const j = coinIndex(pool, tokenOut);
    return i >= 0 && j >= 0 && i !== j ? [{ pool, i, j }] : [];
  });
}

/* ------------------------------------------------------------------- reads */

function decodeAddress(raw: Hex | null): Address | null {
  if (!raw || !/^0x[0-9a-fA-F]{64}/u.test(raw)) return null;
  return getAddress(`0x${raw.slice(26, 66)}`);
}

function unverified(pool: CurvePool, what: string, actual: string | null, pinned: string): PlatformError {
  return new PlatformError(
    "VENUE_UNVERIFIED",
    `${pool.id}: ${what} reports ${actual ?? "nothing"}, not the pinned ${pinned}. Kletia will not swap there.`,
    422,
  );
}

/** The pool's `coins(i)` and `coins(j)` must be the registry addresses of the pin's coins (read at plan and prepare). */
export async function verifyCoins(route: CurveRoute): Promise<void> {
  const network = route.pool.network as EvmNetworkKey;
  for (const index of [route.i, route.j]) {
    const pinned = coinAddress(route.pool, index);
    if (!pinned) throw unverified(route.pool, `coin ${index}`, null, `${route.pool.coins[index] ?? "coin"} registry address`);
    const raw = await rawEthCall(network, route.pool.pool, encodeFunctionData({ abi: CURVE_PLAIN_POOL_ABI, functionName: "coins", args: [BigInt(index)] }));
    const actual = decodeAddress(raw);
    if (!sameAddress(actual, pinned)) throw unverified(route.pool, `coins(${index})`, actual, `${route.pool.coins[index]} ${pinned}`);
  }
}

/** The pool's `get_dy(i, j, dx)`; null when it reverts or returns nothing. */
async function quote(route: CurveRoute, amountIn: bigint): Promise<bigint | null> {
  const raw = await rawEthCall(route.pool.network as EvmNetworkKey, route.pool.pool, encodeFunctionData({
    abi: CURVE_PLAIN_POOL_ABI,
    functionName: "get_dy",
    args: [BigInt(route.i), BigInt(route.j), amountIn],
  }));
  if (!raw || raw === "0x") return null;
  try {
    return decodeFunctionResult({ abi: CURVE_PLAIN_POOL_ABI, functionName: "get_dy", data: raw });
  } catch {
    return null;
  }
}

interface QuotedRoute extends CurveRoute {
  readonly amountOut: bigint;
}

/** Verified quote of one route (coins re-read first); null when the pool does not quote the amount. */
async function quoteRoute(route: CurveRoute, amountIn: bigint): Promise<QuotedRoute | null> {
  await verifyCoins(route);
  const amountOut = await quote(route, amountIn);
  return amountOut !== null && amountOut > 0n ? { ...route, amountOut } : null;
}

/* ------------------------------------------------------------------ context */

interface CurveContext {
  readonly network: EvmNetworkKey;
  readonly chainId: number;
  readonly account: Address;
  readonly input: ResolvedAsset;
  readonly output: ResolvedAsset;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly routes: readonly CurveRoute[];
}

/** A listed ERC-20 registry asset that routes may use (no native leg, not transfer-only). */
function routableToken(asset: ResolvedAsset): Address | null {
  if (asset.isNative || !asset.address) return null;
  const listed = listedAsset(asset.id);
  if (!listed || listed.transferOnly === true || !listed.address || !sameAddress(listed.address, asset.address)) return null;
  return getAddress(asset.address);
}

/** True when a pinned Curve pool on the step's network holds both ERC-20s of this same-network swap. */
export function supportsCurveSwap(route: AdapterRoute): boolean {
  if (route.kind !== "swap" || route.network !== route.destinationNetwork || !isEvmNetwork(route.network)) return false;
  const tokenIn = routableToken(route.input);
  const tokenOut = routableToken(route.output);
  if (!tokenIn || !tokenOut) return false;
  return curveRoutesFor(route.network, tokenIn, tokenOut).length > 0;
}

function curveContext(action: AdapterAction): CurveContext {
  if (action.kind !== "swap") throw new PlatformError("VENUE_INVALID", `A ${LABEL} adapter received a ${action.kind} action.`, 500);
  if (!isEvmNetwork(action.network) || action.destinationNetwork !== action.network) {
    throw new PlatformError("NETWORK_UNSUPPORTED", `${LABEL} swaps execute on the step's own EVM network, not into ${CHAINS[action.destinationNetwork].name}.`, 422);
  }
  if (!supportsCurveSwap(action)) {
    throw new PlatformError("ROUTE_UNSUPPORTED", `No pinned ${LABEL} pool swaps ${action.input.symbol} for ${action.output.symbol} on ${CHAINS[action.network].name}.`, 422);
  }
  if (!sameAddress(action.recipient.address, action.account.address)) {
    throw new PlatformError("INTENT_UNSUPPORTED", `A ${LABEL} swap pays the acting account; send the result with a separate "send" step.`, 422);
  }
  const tokenIn = routableToken(action.input) as Address;
  const tokenOut = routableToken(action.output) as Address;
  return {
    network: action.network,
    chainId: evmChainId(action.network),
    account: getAddress(action.account.address),
    input: action.input,
    output: action.output,
    tokenIn,
    tokenOut,
    routes: curveRoutesFor(action.network, tokenIn, tokenOut),
  };
}

/* ------------------------------------------------------------- transactions */

function lessSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function units(amount: bigint, asset: Pick<ResolvedAsset, "decimals" | "symbol">): string {
  return `${formatAmount(fromBaseUnits(amount, asset.decimals))} ${asset.symbol}`;
}

function evmTransaction(context: CurveContext, to: string, data: Hex, gas: bigint | string, description: string): EvmTransactionRequest {
  return {
    vm: "evm",
    network: context.network,
    chainId: context.chainId,
    from: context.account,
    to: getAddress(to),
    data,
    value: "0",
    gas: gas.toString(),
    description,
  };
}

/** `exchange(i, j, dx, min_dy)`: the pool pulls dx from the caller and pays at least min_dy to it. */
export function exchangeCall(route: CurveRoute, amountIn: bigint, minimumOut: bigint): Hex {
  return encodeFunctionData({ abi: CURVE_PLAIN_POOL_ABI, functionName: "exchange", args: [BigInt(route.i), BigInt(route.j), amountIn, minimumOut] });
}

interface CurveQuote {
  readonly route: QuotedRoute;
  readonly transactions: EvmTransactionRequest[];
  readonly amountIn: bigint;
  readonly minimum: bigint;
  readonly gas: bigint;
  readonly slippageBps: number;
  readonly warnings: string[];
}

/**
 * Quote and transactions. `recorded` (prepare) re-quotes the planned pool and
 * indices; without it the best pinned pool is chosen (plan). Every quote
 * passes the Chainlink band.
 */
async function curveQuote(context: CurveContext, action: AdapterAction, stage: "plan" | "prepare", recorded: CurveRoute | null): Promise<CurveQuote> {
  const amountIn = BigInt(action.amount);
  if (amountIn <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to swap.", 422);
  let route: QuotedRoute | null;
  if (stage === "prepare") {
    if (!recorded) throw new PlatformError("PLAN_INVALID", `The step has no recorded ${LABEL} pool. Create a new intent.`, 422);
    // The recorded indices must still name this step's two tokens in the pin.
    if (coinIndex(recorded.pool, context.tokenIn) !== recorded.i || coinIndex(recorded.pool, context.tokenOut) !== recorded.j) {
      throw new PlatformError("PLAN_INVALID", `The recorded ${LABEL} pool route does not match the step's assets.`, 422);
    }
    await assertEvmBalance(context.network, context.account, context.tokenIn, amountIn, context.input.symbol, context.input.decimals);
    route = await quoteRoute(recorded, amountIn);
    if (!route) {
      throw new PlatformError("ROUTE_UNAVAILABLE", `The planned ${LABEL} pool no longer quotes this amount. Create a new intent to re-quote.`, 422);
    }
  } else {
    route = null;
    for (const candidate of context.routes) {
      const quoted = await quoteRoute(candidate, amountIn);
      if (quoted && (!route || quoted.amountOut > route.amountOut)) route = quoted;
    }
    if (!route) {
      throw new PlatformError("ROUTE_UNAVAILABLE", `No pinned ${LABEL} pool on ${CHAINS[context.network].name} quotes ${context.input.symbol} for ${context.output.symbol} right now.`, 422);
    }
  }
  const guard = await oracleGuard(context.network, context.input, amountIn, context.output, route.amountOut);
  const slippageBps = Math.min(Math.max(1, action.slippageBps), MAX_CURVE_SLIPPAGE_BPS);
  const minimum = lessSlippage(route.amountOut, slippageBps);
  if (minimum <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${units(amountIn, context.input)} buys too little ${context.output.symbol} to guarantee an output.`, 422);
  const pool = getAddress(route.pool.pool);
  // Plan reads the allowance best-effort (an unreadable one only adds the approval); prepare must read it.
  const allowance = stage === "plan"
    ? await readAllowance(context.network, context.tokenIn, context.account, pool).catch(() => 0n)
    : await readAllowance(context.network, context.tokenIn, context.account, pool);
  const transactions: EvmTransactionRequest[] = [];
  // Exact approval of the pool only; tokens that revert approve() over a non-zero allowance (Ethereum USDT) are reset to zero first.
  for (const call of exactApprovalCalls(context.network, context.tokenIn, pool, amountIn, allowance)) {
    transactions.push(evmTransaction(
      context,
      context.tokenIn,
      call.data,
      APPROVE_GAS,
      call.reset
        ? `Reset the ${context.input.symbol} allowance of the ${LABEL} pool to zero (${context.input.symbol} requires it before a new approval)`
        : `Approve ${units(amountIn, context.input)} for the ${LABEL} pool`,
    ));
  }
  const approvals = transactions.length;
  const data = exchangeCall(route, amountIn, minimum);
  const warnings = [
    ...guard.warnings,
    `Route: ${LABEL} (${route.pool.id}), ${route.pool.coins[route.i]} (coin ${route.i}) to ${route.pool.coins[route.j]} (coin ${route.j}), pool ${pool}.`,
  ];
  if (action.slippageBps > MAX_CURVE_SLIPPAGE_BPS) warnings.push(`Slippage capped at ${MAX_CURVE_SLIPPAGE_BPS / 100} % for ${LABEL} swaps.`);
  let gas: bigint | string = CURVE_FALLBACK_GAS;
  if (stage === "prepare" && approvals === 0) {
    // Only an exchange that needs no approval first can be dry-run before signing.
    const request = { from: context.account, to: pool, data, value: "0" };
    const simulation = await simulate(context.network, request, [...CURVE_PLAIN_POOL_ABI]);
    assertSimulation(simulation, `${LABEL} swap`);
    if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
    else gas = await callGas(context.network, request, CURVE_FALLBACK_GAS);
  }
  transactions.push(evmTransaction(
    context,
    pool,
    data,
    gas,
    `Swap ${units(amountIn, context.input)} for at least ${units(minimum, context.output)} on ${LABEL}`,
  ));
  return {
    route,
    transactions,
    amountIn,
    minimum,
    gas: CURVE_FALLBACK_GAS + BigInt(approvals) * APPROVE_GAS,
    slippageBps,
    warnings,
  };
}

/* ------------------------------------------------------------- verification */

/**
 * Outcome proof of a landed exchange: the pool call with the recorded
 * indices, the pool's TokenExchange to the account and the output token
 * credited to the account, both at or above the lowest prepared floor.
 */
export function proveCurveSwap(step: IntentStep, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const recorded = decodeCurveRoute(step.network, decodeStepRef(step.quoteRef)?.provider);
  const output = step.minimumOutput;
  const input = step.input;
  if (!recorded || !output || !input) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The step has no recorded ${LABEL} pool.` });
  const parsedIn = parseAssetId(input.asset);
  const parsedOut = parseAssetId(output.asset);
  if (!parsedIn || !parsedOut || parsedIn.isNative || parsedOut.isNative) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The step's assets are not ERC-20 coins of the pool." });
  if (coinIndex(recorded.pool, parsedIn.reference) !== recorded.i || coinIndex(recorded.pool, parsedOut.reference) !== recorded.j) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The recorded ${LABEL} indices do not match the step's assets.` });
  }
  const pool = getAddress(recorded.pool.pool);
  const account = stepOwner(step);
  const call = landedCall(receipts, pool);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `No landed transaction called the ${LABEL} pool.` });
  let args: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: CURVE_PLAIN_POOL_ABI, data: call.input as Hex });
    if (decoded.functionName !== "exchange") throw new Error("not exchange");
    args = decoded.args as readonly unknown[];
  } catch {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The ${LABEL} pool call is not an exchange.` });
  }
  if (args[0] !== BigInt(recorded.i) || args[1] !== BigInt(recorded.j)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The ${LABEL} exchange used coins ${String(args[0])} -> ${String(args[1])}, not the recorded ${recorded.i} -> ${recorded.j}.` });
  }
  const floor = lowestPreparedFloor(step);
  if (floor === null) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The step has no prepared output floor." });
  const exchanges = parseEventLogs({ abi: TOKEN_EXCHANGE, logs: [...call.logs], eventName: "TokenExchange", strict: true })
    .filter((event) => sameAddress(event.address, pool) && sameAddress(event.args.buyer, account)
      && event.args.sold_id === BigInt(recorded.i) && event.args.bought_id === BigInt(recorded.j));
  const exchange = exchanges[0];
  if (!exchange || exchanges.length !== 1) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The ${LABEL} pool emitted no TokenExchange for the account on coins ${recorded.i} -> ${recorded.j}.` });
  }
  const credited = erc20CreditFromLogs(call.logs, getAddress(parsedOut.reference), account);
  const bought = exchange.args.tokens_bought;
  if (bought < floor || credited < floor) {
    return outcomeFailure({
      code: "OUTCOME_NOT_PROVEN",
      message: `The exchange credited ${fromBaseUnits(credited < bought ? credited : bought, output.decimals)} ${output.symbol} to the account, below the guaranteed ${fromBaseUnits(floor, output.decimals)}.`,
    });
  }
  return {
    actualOutput: observed(output, credited),
    evidence: [eventEvidence(step, call, observedAt, `${LABEL} TokenExchange on ${recorded.pool.id} (${pool}): ${fromBaseUnits(credited, output.decimals)} ${output.symbol} credited to ${account}.`)],
  };
}

/* ------------------------------------------------------------------ adapter */

export const curveAdapter: ProtocolAdapter | null = {
  id: PROTOCOL,
  protocols: [PROTOCOL],
  label: LABEL,

  supports(route) {
    return supportsCurveSwap(route);
  },

  async plan(action): Promise<PlannedStep> {
    const context = curveContext(action);
    const now = Math.floor(Date.now() / 1000);
    const planned = await curveQuote(context, action, "plan", null);
    const fees = await estimateEvmFeeUsd(context.network, planned.gas);
    return {
      protocol: PROTOCOL,
      title: `Swap ${units(planned.amountIn, action.input)} for ${action.output.symbol} on ${CHAINS[context.network].name} via ${LABEL}`,
      mode: "wallet",
      input: assetAmount(action.input, planned.amountIn.toString()),
      expectedOutput: assetAmount(action.output, planned.route.amountOut.toString()),
      minimumOutput: assetAmount(action.output, planned.minimum.toString()),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: 15 * planned.transactions.length,
      settlement: { kind: "same-network" },
      warnings: planned.warnings,
      provider: encodeCurveRoute(planned.route),
      transactionCount: planned.transactions.length,
      slippageBps: planned.slippageBps,
      floor: "onchain",
      // Kletia encodes the payload itself: the preview simulates exactly these transactions.
      preview: { transactions: planned.transactions, approvalSpender: planned.route.pool.pool, expiresAt: now + CURVE_PREVIEW_TTL_SECONDS },
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const context = curveContext(action);
    const prepared = await curveQuote(context, action, "prepare", decodeCurveRoute(context.network, action.provider));
    const fees = await estimateEvmFeeUsd(context.network, prepared.gas);
    return {
      transactions: prepared.transactions,
      records: payloadRecords(context.network, prepared.transactions),
      input: assetAmount(action.input, prepared.amountIn.toString()),
      expectedOutput: assetAmount(action.output, prepared.route.amountOut.toString()),
      minimumOutput: assetAmount(action.output, prepared.minimum.toString()),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: prepared.warnings,
    };
  },

  async verify(context) {
    const observedAt = new Date(context.now).toISOString();
    const { result } = await verifyEvmReceipts(context, (receipts) => proveCurveSwap(context.step, receipts, observedAt));
    return result;
  },
};
