/**
 * Concentrated-liquidity swaps encoded by Kletia (protocols design 3.2, 3.3):
 * Uniswap V3 (SwapRouter02 + QuoterV2) and the Slipstream deployments of
 * Aerodrome (Base) and Velodrome (OP Mainnet). One adapter factory serves the
 * three protocols; the dialect of each pinned deployment decides the ABI.
 *
 * Every address comes from DEX_DEPLOYMENTS in @kletia/core:
 * - The router and quoter must report the pinned factory and the network's
 *   wrapped native token (`factory()`, `WETH9()`), read at plan and prepare.
 * - A pool is used only when the pinned factory's `getPool(...)` returns it
 *   and the pool's own `factory()` is that factory; any disagreement refuses
 *   the swap (VENUE_UNVERIFIED, fail closed).
 * - Quotes come from the pinned quoter by eth_call. Uniswap V3 tries every
 *   fee tier and, when no direct pool quotes, two hops through the wrapped
 *   native token or USDC; Slipstream tries every tick spacing of every pinned
 *   factory (Aerodrome has three) and keeps single pools. Classic (solidly)
 *   pools are not used.
 * - The best output wins and is held to the Chainlink band (oracleGuard).
 *   The minimum output is the quote less the slippage (at most 3 %) and is
 *   enforced on-chain by `amountOutMinimum` (floor "onchain").
 * - Transactions: an exact approval of the router that is called (and only
 *   that router) when the allowance is short, then one router multicall:
 *   exactInputSingle / exactInput to the account; native input sends value
 *   and refunds with refundETH(); native output swaps to the router and
 *   unwrapWETH9(minimum, account).
 * - Verify: binding-matched receipts, a Swap event from every recorded pool
 *   (re-derived from the factory) and from no other address, and the output
 *   credited to the account (ERC-20 Transfer, or the wrapped native token's
 *   Withdrawal by the router) of at least the lowest prepared floor.
 *
 * The step ref records the route (`provider`: deployment slug, fee / tick
 * spacing and the intermediate of a two-hop path) so prepare re-quotes the
 * same pools and verify re-derives them.
 */
import {
  concatHex,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  numberToHex,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  CHAINS,
  dexDeploymentsFor,
  findAssetBySymbol,
  formatAmount,
  fromBaseUnits,
  parseAssetId,
  type DexDeployment,
  type EvmTransactionRequest,
  type IntentStep,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { assetAmount, type ResolvedAsset } from "../../assets.js";
import { estimateEvmFeeUsd, evmChainId, isEvmNetwork, rawEthCall, readAllowance, erc20CreditFromLogs, type EvmNetworkKey } from "../../chains/evm.js";
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
  transferred,
  WETH_ABI,
} from "../lending/common.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter } from "../types.js";
import { evmEvents, lowestPreparedFloor, stepOwner, verifyEvmReceipts, type EvmOutcome, type LandedEvmReceipt } from "../verification.js";
import { oracleGuard } from "./oracleGuard.js";

export type DexProtocol = DexDeployment["protocol"];

/** Slippage applied at most, whatever the request asks. */
export const MAX_DEX_SLIPPAGE_BPS = 300;
/** Plan-time transactions stay valid for the asset-change preview this long. */
export const DEX_PREVIEW_TTL_SECONDS = 10 * 60;
/** The router call's deadline: the payload expiry plus this grace. */
export const DEADLINE_GRACE_SECONDS = 300;
/** SwapRouter02's ADDRESS_THIS sentinel (Constants.ADDRESS_THIS = address(2)): output stays in the router for unwrapWETH9. */
export const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
/** Pinned-deployment confirmations are re-read after this long (routers and quoters are immutable). */
const DEPLOYMENT_TTL_MS = 10 * 60 * 1000;
/** Router overhead on top of the quoter's swap gas estimate. */
const ROUTER_OVERHEAD_GAS = 120_000n;
const FALLBACK_SWAP_GAS = 300_000n;

/* --------------------------------------------------------------------- ABIs */

export const PINS_ABI = parseAbi([
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
]);

export const UNISWAP_FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
export const SLIPSTREAM_FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)"]);

export const UNISWAP_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
export const SLIPSTREAM_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** SwapRouter02 (IV3SwapRouter + PeripheryPaymentsWithFeeExtended + MulticallExtended). */
export const SWAP_ROUTER02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
]);

/** Slipstream SwapRouter (v3-periphery SwapRouter with tick spacings and the deadline in the params). */
export const SLIPSTREAM_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
]);

/** The pool Swap event (identical in Uniswap V3 and Slipstream pools). */
export const POOL_ABI = parseAbi([
  "function factory() view returns (address)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);


/* ------------------------------------------------------------------- routes */

/** One pool of a route: tokens in order and the fee tier (Uniswap) or tick spacing (Slipstream). */
export interface Hop {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly tier: number;
}

/** Intermediate token codes of a two-hop route (step ref): the wrapped native token or USDC. */
type Intermediate = "W" | "U";

export interface DexRoute {
  readonly deployment: DexDeployment;
  readonly hops: readonly Hop[];
  readonly pools: readonly Address[];
  readonly intermediate?: Intermediate;
  readonly amountOut: bigint;
  /** Quoter's gas estimate of the swap. */
  readonly gasEstimate: bigint;
}

function slugOf(deployment: DexDeployment): string {
  return deployment.id.slice(deployment.id.lastIndexOf(":") + 1);
}

/** The step-ref route: `<slug>:<tier>` or `<slug>:<tier>:<W|U>:<tier>` (at most 32 characters). */
export function encodeRoute(route: Pick<DexRoute, "deployment" | "hops" | "intermediate">): string {
  const [first, second] = route.hops;
  const slug = slugOf(route.deployment);
  return second && route.intermediate ? `${slug}:${first?.tier}:${route.intermediate}:${second.tier}` : `${slug}:${first?.tier}`;
}

export interface RecordedRoute {
  readonly deployment: DexDeployment;
  readonly tiers: readonly number[];
  readonly intermediate?: Intermediate;
}

/** Parses a recorded route against the pinned deployments of `protocol` on `network`; null when it names none. */
export function decodeRoute(protocol: DexProtocol, network: NetworkKey, value: string | undefined): RecordedRoute | null {
  if (!value) return null;
  const match = /^([a-z0-9-]{1,20}):(\d{1,6})(?::([WU]):(\d{1,6}))?$/u.exec(value);
  if (!match) return null;
  const deployment = dexDeploymentsFor(network, protocol).find((entry) => slugOf(entry) === match[1]);
  if (!deployment) return null;
  const tiers = [Number(match[2]), ...(match[4] ? [Number(match[4])] : [])];
  const allowed = deployment.dialect === "uniswap-v3" ? deployment.feeTiers : deployment.tickSpacings;
  if (!tiers.every((tier) => allowed?.includes(tier))) return null;
  if (tiers.length === 2 && deployment.dialect !== "uniswap-v3") return null;
  return { deployment, tiers, ...(match[3] ? { intermediate: match[3] as Intermediate } : {}) };
}

/* -------------------------------------------------------------------- reads */

async function call(network: EvmNetworkKey, to: string, data: Hex): Promise<Hex | null> {
  return rawEthCall(network, to, data);
}

function decodeAddress(raw: Hex | null): Address | null {
  if (!raw || !/^0x[0-9a-fA-F]{64}/u.test(raw)) return null;
  return getAddress(`0x${raw.slice(26, 66)}`);
}

const deploymentChecks = new Map<string, number>();
const poolCache = new Map<string, Address | null>();

/** Clears the pinned-deployment and pool caches (tests). */
export function resetDexCaches(): void {
  deploymentChecks.clear();
  poolCache.clear();
}

function unverified(deployment: DexDeployment, what: string, actual: string | null, pinned: string): PlatformError {
  return new PlatformError(
    "VENUE_UNVERIFIED",
    `${deployment.id}: ${what} reports ${actual ?? "nothing"}, not the pinned ${pinned}. Kletia will not swap there.`,
    422,
  );
}

/** Router and quoter must report the pinned factory and wrapped native token (cached 10 minutes once confirmed). */
export async function verifyDeployment(deployment: DexDeployment): Promise<void> {
  const confirmed = deploymentChecks.get(deployment.id);
  if (confirmed !== undefined && confirmed > Date.now()) return;
  const network = deployment.network as EvmNetworkKey;
  const factoryCall = encodeFunctionData({ abi: PINS_ABI, functionName: "factory" });
  const wethCall = encodeFunctionData({ abi: PINS_ABI, functionName: "WETH9" });
  const quoter = deployment.quoter;
  if (!quoter) throw unverified(deployment, "the deployment", null, "a quoter");
  const [routerFactory, routerWeth, quoterFactory, quoterWeth] = await Promise.all([
    call(network, deployment.router, factoryCall),
    call(network, deployment.router, wethCall),
    call(network, quoter, factoryCall),
    call(network, quoter, wethCall),
  ]);
  const checks: [string, Address | null, string][] = [
    ["the router's factory()", decodeAddress(routerFactory), deployment.factory],
    ["the router's WETH9()", decodeAddress(routerWeth), deployment.wrappedNative],
    ["the quoter's factory()", decodeAddress(quoterFactory), deployment.factory],
    ["the quoter's WETH9()", decodeAddress(quoterWeth), deployment.wrappedNative],
  ];
  for (const [what, actual, pinned] of checks) {
    if (!sameAddress(actual, pinned)) throw unverified(deployment, what, actual, pinned);
  }
  deploymentChecks.set(deployment.id, Date.now() + DEPLOYMENT_TTL_MS);
}

/**
 * The pool of `hop` from the pinned factory, or null when it has none.
 * Throws VENUE_UNVERIFIED when the pool does not name that factory.
 */
export async function poolFor(deployment: DexDeployment, hop: Hop): Promise<Address | null> {
  const network = deployment.network as EvmNetworkKey;
  const [a, b] = hop.tokenIn.toLowerCase() < hop.tokenOut.toLowerCase() ? [hop.tokenIn, hop.tokenOut] : [hop.tokenOut, hop.tokenIn];
  const key = `${deployment.id}:${a}:${b}:${hop.tier}`.toLowerCase();
  if (poolCache.has(key)) return poolCache.get(key) ?? null;
  const data = deployment.dialect === "uniswap-v3"
    ? encodeFunctionData({ abi: UNISWAP_FACTORY_ABI, functionName: "getPool", args: [a, b, hop.tier] })
    : encodeFunctionData({ abi: SLIPSTREAM_FACTORY_ABI, functionName: "getPool", args: [a, b, hop.tier] });
  const pool = decodeAddress(await call(network, deployment.factory, data));
  if (!pool || pool === zeroAddress) {
    // A missing pool can be created later: never cached.
    return null;
  }
  const reported = decodeAddress(await call(network, pool, encodeFunctionData({ abi: POOL_ABI, functionName: "factory" })));
  if (!sameAddress(reported, deployment.factory)) throw unverified(deployment, `pool ${pool}'s factory()`, reported, deployment.factory);
  poolCache.set(key, pool);
  return pool;
}

interface Quote {
  readonly amountOut: bigint;
  readonly gasEstimate: bigint;
}

/** Exact-in quote of one pool from the pinned quoter; null when the quoter reverts (no liquidity, no pool). */
async function quoteSingle(deployment: DexDeployment, hop: Hop, amountIn: bigint): Promise<Quote | null> {
  const network = deployment.network as EvmNetworkKey;
  const quoter = deployment.quoter as string;
  if (deployment.dialect === "uniswap-v3") {
    const raw = await call(network, quoter, encodeFunctionData({
      abi: UNISWAP_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, amountIn, fee: hop.tier, sqrtPriceLimitX96: 0n }],
    }));
    if (!raw || raw === "0x") return null;
    const [amountOut, , , gasEstimate] = decodeFunctionResult({ abi: UNISWAP_QUOTER_ABI, functionName: "quoteExactInputSingle", data: raw });
    return { amountOut, gasEstimate };
  }
  const raw = await call(network, quoter, encodeFunctionData({
    abi: SLIPSTREAM_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, amountIn, tickSpacing: hop.tier, sqrtPriceLimitX96: 0n }],
  }));
  if (!raw || raw === "0x") return null;
  const [amountOut, , , gasEstimate] = decodeFunctionResult({ abi: SLIPSTREAM_QUOTER_ABI, functionName: "quoteExactInputSingle", data: raw });
  return { amountOut, gasEstimate };
}

/** Uniswap V3 path: token (20 bytes) | fee (3 bytes) | token ... */
export function encodePath(hops: readonly Hop[]): Hex {
  const parts: Hex[] = [];
  hops.forEach((hop, index) => {
    if (index === 0) parts.push(hop.tokenIn.toLowerCase() as Hex);
    parts.push(numberToHex(hop.tier, { size: 3 }), hop.tokenOut.toLowerCase() as Hex);
  });
  return concatHex(parts);
}

/** Exact-in quote of a multi-pool Uniswap V3 path; null when the quoter reverts. */
async function quotePath(deployment: DexDeployment, hops: readonly Hop[], amountIn: bigint): Promise<Quote | null> {
  const raw = await call(deployment.network as EvmNetworkKey, deployment.quoter as string, encodeFunctionData({
    abi: UNISWAP_QUOTER_ABI,
    functionName: "quoteExactInput",
    args: [encodePath(hops), amountIn],
  }));
  if (!raw || raw === "0x") return null;
  const [amountOut, , , gasEstimate] = decodeFunctionResult({ abi: UNISWAP_QUOTER_ABI, functionName: "quoteExactInput", data: raw });
  return { amountOut, gasEstimate };
}

function tiersOf(deployment: DexDeployment): readonly number[] {
  return (deployment.dialect === "uniswap-v3" ? deployment.feeTiers : deployment.tickSpacings) ?? [];
}

/** Best direct pool of one deployment: every tier, pools proven by the factory, quotes from the pinned quoter. */
async function bestDirect(deployment: DexDeployment, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<DexRoute | null> {
  const results = await Promise.all(tiersOf(deployment).map(async (tier): Promise<DexRoute | null> => {
    const hop = { tokenIn, tokenOut, tier };
    const pool = await poolFor(deployment, hop);
    if (!pool) return null;
    const quote = await quoteSingle(deployment, hop, amountIn);
    if (!quote || quote.amountOut <= 0n) return null;
    return { deployment, hops: [hop], pools: [pool], amountOut: quote.amountOut, gasEstimate: quote.gasEstimate };
  }));
  return pickBest(results);
}

function pickBest(routes: readonly (DexRoute | null)[]): DexRoute | null {
  let best: DexRoute | null = null;
  for (const route of routes) {
    if (route && (!best || route.amountOut > best.amountOut)) best = route;
  }
  return best;
}

/** Address of an intermediate code on the deployment's network. */
function intermediateToken(deployment: DexDeployment, code: Intermediate): Address | null {
  if (code === "W") return getAddress(deployment.wrappedNative);
  const usdc = findAssetBySymbol(deployment.network, "USDC");
  return usdc?.address ? getAddress(usdc.address) : null;
}

/**
 * Two hops through the wrapped native token or USDC (Uniswap V3 only): the
 * best tier of each leg, then the exact path quoted as it will execute.
 */
async function bestTwoHop(deployment: DexDeployment, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<DexRoute | null> {
  const routes = await Promise.all((["W", "U"] as const).map(async (code): Promise<DexRoute | null> => {
    const middle = intermediateToken(deployment, code);
    if (!middle || sameAddress(middle, tokenIn) || sameAddress(middle, tokenOut)) return null;
    const first = await bestDirect(deployment, tokenIn, middle, amountIn);
    if (!first) return null;
    const second = await bestDirect(deployment, middle, tokenOut, first.amountOut);
    if (!second) return null;
    const hops = [first.hops[0] as Hop, second.hops[0] as Hop];
    const quote = await quotePath(deployment, hops, amountIn);
    if (!quote || quote.amountOut <= 0n) return null;
    return { deployment, hops, pools: [first.pools[0] as Address, second.pools[0] as Address], intermediate: code, amountOut: quote.amountOut, gasEstimate: quote.gasEstimate };
  }));
  return pickBest(routes);
}

/** Re-quotes exactly the recorded route (prepare): the same deployment, tiers and pools. */
async function quoteRecorded(recorded: RecordedRoute, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<DexRoute> {
  const { deployment } = recorded;
  await verifyDeployment(deployment);
  const middle = recorded.intermediate ? intermediateToken(deployment, recorded.intermediate) : null;
  const tokens = middle ? [tokenIn, middle, tokenOut] : [tokenIn, tokenOut];
  const hops = recorded.tiers.map((tier, index) => ({ tokenIn: tokens[index] as Address, tokenOut: tokens[index + 1] as Address, tier }));
  if (hops.length !== tokens.length - 1) throw new PlatformError("PLAN_INVALID", "The recorded swap route does not match the step's assets.", 422);
  const pools: Address[] = [];
  for (const hop of hops) {
    const pool = await poolFor(deployment, hop);
    if (!pool) throw new PlatformError("ROUTE_UNAVAILABLE", `The planned pool of ${deployment.id} no longer exists.`, 422);
    pools.push(pool);
  }
  const quote = hops.length === 1 ? await quoteSingle(deployment, hops[0] as Hop, amountIn) : await quotePath(deployment, hops, amountIn);
  if (!quote || quote.amountOut <= 0n) {
    throw new PlatformError("ROUTE_UNAVAILABLE", `The planned pool of ${deployment.id} no longer quotes this amount. Create a new intent to re-quote.`, 422);
  }
  return { deployment, hops, pools, ...(recorded.intermediate ? { intermediate: recorded.intermediate } : {}), amountOut: quote.amountOut, gasEstimate: quote.gasEstimate };
}

/* ------------------------------------------------------------------ context */

export interface SwapContext {
  readonly protocol: DexProtocol;
  readonly label: string;
  readonly network: EvmNetworkKey;
  readonly chainId: number;
  readonly account: Address;
  readonly input: ResolvedAsset;
  readonly output: ResolvedAsset;
  /** ERC-20 the pools trade (the wrapped native token for a native leg). */
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly nativeIn: boolean;
  readonly nativeOut: boolean;
  readonly deployments: readonly DexDeployment[];
}

/** A registry asset that routes may use (listed, not transfer-only). */
function routable(asset: ResolvedAsset): boolean {
  if (asset.isNative) return true;
  const listed = listedAsset(asset.id);
  return listed !== null && listed.transferOnly !== true && listed.address !== null;
}

function poolToken(asset: ResolvedAsset, wrappedNative: string): Address | null {
  if (asset.isNative) return getAddress(wrappedNative);
  return asset.address ? getAddress(asset.address) : null;
}

/** True when `protocol` has a pinned deployment serving this same-network swap of two registry assets. */
export function supportsSwap(route: AdapterRoute, protocol: DexProtocol): boolean {
  if (route.kind !== "swap" || route.network !== route.destinationNetwork || !isEvmNetwork(route.network)) return false;
  const deployments = dexDeploymentsFor(route.network, protocol).filter((entry) => entry.dialect !== "solidly-v2");
  const first = deployments[0];
  if (!first || !routable(route.input) || !routable(route.output)) return false;
  // A native leg trades as the network's pinned wrapped native token (ETH -> WETH, POL -> WPOL).
  const tokenIn = poolToken(route.input, first.wrappedNative);
  const tokenOut = poolToken(route.output, first.wrappedNative);
  // Wrapping or unwrapping (ETH <-> WETH) is not a swap.
  return tokenIn !== null && tokenOut !== null && !sameAddress(tokenIn, tokenOut);
}

export function swapContext(action: AdapterAction, protocol: DexProtocol, label: string): SwapContext {
  if (action.kind !== "swap") throw new PlatformError("VENUE_INVALID", `A ${label} adapter received a ${action.kind} action.`, 500);
  if (!isEvmNetwork(action.network) || action.destinationNetwork !== action.network) {
    throw new PlatformError("NETWORK_UNSUPPORTED", `${label} swaps execute on the step's own EVM network, not into ${CHAINS[action.destinationNetwork].name}.`, 422);
  }
  if (!supportsSwap(action, protocol)) {
    throw new PlatformError("ROUTE_UNSUPPORTED", `${label} does not swap ${action.input.symbol} for ${action.output.symbol} on ${CHAINS[action.network].name}.`, 422);
  }
  if (!sameAddress(action.recipient.address, action.account.address)) {
    throw new PlatformError("INTENT_UNSUPPORTED", `A ${label} swap pays the acting account; send the result with a separate "send" step.`, 422);
  }
  const deployments = dexDeploymentsFor(action.network, protocol).filter((entry) => entry.dialect !== "solidly-v2");
  const wrapped = (deployments[0] as DexDeployment).wrappedNative;
  return {
    protocol,
    label,
    network: action.network,
    chainId: evmChainId(action.network),
    account: getAddress(action.account.address),
    input: action.input,
    output: action.output,
    tokenIn: poolToken(action.input, wrapped) as Address,
    tokenOut: poolToken(action.output, wrapped) as Address,
    nativeIn: action.input.isNative,
    nativeOut: action.output.isNative,
    deployments,
  };
}

/** Best route across the protocol's pinned deployments (every one verified first; a mismatch refuses the swap). */
export async function bestRoute(context: SwapContext, amountIn: bigint): Promise<DexRoute> {
  for (const deployment of context.deployments) await verifyDeployment(deployment);
  const direct = pickBest(await Promise.all(context.deployments.map((deployment) => bestDirect(deployment, context.tokenIn, context.tokenOut, amountIn))));
  const route = direct ?? pickBest(await Promise.all(context.deployments
    .filter((deployment) => deployment.dialect === "uniswap-v3")
    .map((deployment) => bestTwoHop(deployment, context.tokenIn, context.tokenOut, amountIn))));
  if (!route) {
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      `No ${context.label} pool on ${CHAINS[context.network].name} quotes ${context.input.symbol} for ${context.output.symbol} right now.`,
      422,
    );
  }
  return route;
}

/* -------------------------------------------------------------- transactions */

export function lessSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function units(amount: bigint, asset: Pick<ResolvedAsset, "decimals" | "symbol">): string {
  return `${formatAmount(fromBaseUnits(amount, asset.decimals))} ${asset.symbol}`;
}

function evmTransaction(context: SwapContext, to: string, data: Hex, value: bigint, gas: bigint | string, description: string): EvmTransactionRequest {
  return {
    vm: "evm",
    network: context.network,
    chainId: context.chainId,
    from: context.account,
    to: getAddress(to),
    data,
    value: value.toString(),
    gas: gas.toString(),
    description,
  };
}

/** The router multicall of a route: the swap and its native refund / unwrap leg. */
export function routerCall(context: SwapContext, route: DexRoute, amountIn: bigint, minimumOut: bigint, deadline: bigint): Hex {
  const { deployment, hops } = route;
  if (deployment.dialect === "uniswap-v3") {
    const recipient = context.nativeOut ? ADDRESS_THIS : context.account;
    const swap = hops.length === 1
      ? encodeFunctionData({
        abi: SWAP_ROUTER02_ABI,
        functionName: "exactInputSingle",
        args: [{ tokenIn: (hops[0] as Hop).tokenIn, tokenOut: (hops[0] as Hop).tokenOut, fee: (hops[0] as Hop).tier, recipient, amountIn, amountOutMinimum: minimumOut, sqrtPriceLimitX96: 0n }],
      })
      : encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: "exactInput", args: [{ path: encodePath(hops), recipient, amountIn, amountOutMinimum: minimumOut }] });
    const calls: Hex[] = [swap];
    if (context.nativeIn) calls.push(encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: "refundETH" }));
    if (context.nativeOut) calls.push(encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: "unwrapWETH9", args: [minimumOut, context.account] }));
    return encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: "multicall", args: [deadline, calls] });
  }
  const hop = hops[0] as Hop;
  if (hops.length !== 1) throw new PlatformError("PLAN_INVALID", "Slipstream swaps use one pool.", 422);
  // The Slipstream router keeps native output itself when it is the recipient (then unwraps to the account).
  const recipient = context.nativeOut ? getAddress(deployment.router) : context.account;
  const calls: Hex[] = [encodeFunctionData({
    abi: SLIPSTREAM_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{ tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, tickSpacing: hop.tier, recipient, deadline, amountIn, amountOutMinimum: minimumOut, sqrtPriceLimitX96: 0n }],
  })];
  if (context.nativeIn) calls.push(encodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, functionName: "refundETH" }));
  if (context.nativeOut) calls.push(encodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, functionName: "unwrapWETH9", args: [minimumOut, context.account] }));
  return encodeFunctionData({ abi: SLIPSTREAM_ROUTER_ABI, functionName: "multicall", args: [calls] });
}

function describeRoute(context: SwapContext, route: DexRoute): string {
  const tier = (value: number) => (route.deployment.dialect === "uniswap-v3" ? `${(value / 10_000).toString()} %` : `tick spacing ${value}`);
  const middle = route.intermediate ? ` through ${route.intermediate === "W" ? (context.nativeIn || context.nativeOut ? `W${CHAINS[context.network].nativeAsset.symbol}` : "the wrapped native token") : "USDC"}` : "";
  return `Route: ${context.label} (${route.deployment.id}), ${route.hops.map((hop) => tier(hop.tier)).join(" then ")} pool${route.hops.length > 1 ? "s" : ""}${middle}, ${route.pools.join(", ")}.`;
}

export interface SwapQuote {
  readonly route: DexRoute;
  readonly transactions: EvmTransactionRequest[];
  readonly amountIn: bigint;
  readonly expected: bigint;
  readonly minimum: bigint;
  readonly gas: bigint;
  readonly slippageBps: number;
  readonly warnings: string[];
}

/**
 * Quote and transactions of a swap. `recorded` (prepare) re-quotes the
 * planned route; without it the best route is searched (plan). Every quote
 * passes the Chainlink band.
 */
export async function swapQuote(
  context: SwapContext,
  action: AdapterAction,
  stage: "plan" | "prepare",
  deadline: bigint,
  recorded: RecordedRoute | null,
): Promise<SwapQuote> {
  const amountIn = BigInt(action.amount);
  if (amountIn <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to swap.", 422);
  if (stage === "prepare") {
    if (!recorded) throw new PlatformError("PLAN_INVALID", `The step has no recorded ${context.label} route. Create a new intent.`, 422);
    await assertEvmBalance(context.network, context.account, context.nativeIn ? null : context.tokenIn, amountIn, context.input.symbol, context.input.decimals);
  }
  const route = recorded ? await quoteRecorded(recorded, context.tokenIn, context.tokenOut, amountIn) : await bestRoute(context, amountIn);
  const guard = await oracleGuard(context.network, context.input, amountIn, context.output, route.amountOut);
  const slippageBps = Math.min(Math.max(1, action.slippageBps), MAX_DEX_SLIPPAGE_BPS);
  const minimum = lessSlippage(route.amountOut, slippageBps);
  if (minimum <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${units(amountIn, context.input)} buys too little ${context.output.symbol} to guarantee an output.`, 422);
  const router = getAddress(route.deployment.router);
  const transactions: EvmTransactionRequest[] = [];
  let approvals = 0;
  if (!context.nativeIn) {
    // Plan reads the allowance best-effort (an unreadable one only adds the approval); prepare must read it.
    const allowance = stage === "plan"
      ? await readAllowance(context.network, context.tokenIn, context.account, router).catch(() => 0n)
      : await readAllowance(context.network, context.tokenIn, context.account, router);
    // Exact approval of the router; tokens that revert approve() over a non-zero allowance (Ethereum USDT) are reset to zero first.
    for (const call of exactApprovalCalls(context.network, context.tokenIn, router, amountIn, allowance)) {
      approvals += 1;
      transactions.push(evmTransaction(
        context,
        context.tokenIn,
        call.data,
        0n,
        APPROVE_GAS,
        call.reset
          ? `Reset the ${context.input.symbol} allowance of the ${context.label} router to zero (${context.input.symbol} requires it before a new approval)`
          : `Approve ${units(amountIn, context.input)} for the ${context.label} router`,
      ));
    }
  }
  const approved = approvals === 0;
  const data = routerCall(context, route, amountIn, minimum, deadline);
  const value = context.nativeIn ? amountIn : 0n;
  const fallbackGas = route.gasEstimate > 0n && route.gasEstimate < 2_000_000n ? route.gasEstimate + ROUTER_OVERHEAD_GAS : FALLBACK_SWAP_GAS;
  const warnings = [...guard.warnings, describeRoute(context, route)];
  if (action.slippageBps > MAX_DEX_SLIPPAGE_BPS) warnings.push(`Slippage capped at ${MAX_DEX_SLIPPAGE_BPS / 100} % for ${context.label} swaps.`);
  let gas: bigint | string = fallbackGas;
  if (stage === "prepare" && approved) {
    // Only a swap that needs no approval first can be dry-run before signing.
    const request = { from: context.account, to: router, data, value: value.toString() };
    const simulation = await simulate(context.network, request, [...(route.deployment.dialect === "uniswap-v3" ? SWAP_ROUTER02_ABI : SLIPSTREAM_ROUTER_ABI)]);
    assertSimulation(simulation, `${context.label} swap`);
    if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
    else gas = await callGas(context.network, request, fallbackGas);
  }
  transactions.push(evmTransaction(
    context,
    router,
    data,
    value,
    gas,
    `Swap ${units(amountIn, context.input)} for at least ${units(minimum, context.output)} on ${context.label}`,
  ));
  return {
    route,
    transactions,
    amountIn,
    expected: route.amountOut,
    minimum,
    gas: fallbackGas + BigInt(approvals) * APPROVE_GAS,
    slippageBps,
    warnings,
  };
}

/* ------------------------------------------------------------- verification */

const SWAP_EVENT = POOL_ABI.find((item) => item.type === "event" && item.name === "Swap");
const ROUTER_DECODE_ABI = [...SWAP_ROUTER02_ABI, ...SLIPSTREAM_ROUTER_ABI];

/**
 * Wrapped native the router unwrapped for the account: WETH9 `Withdrawal`
 * events by the router, plus burns from the router (Arbitrum's aeWETH burns
 * with a Transfer to the zero address instead of a Withdrawal event).
 */
function routerUnwrapped(call: LandedEvmReceipt, wrappedNative: string, router: string): bigint {
  const withdrawals = evmEvents([call], { address: wrappedNative, abi: WETH_ABI, eventName: "Withdrawal" })
    .filter((event) => sameAddress(event.args.src, router))
    .reduce((total, event) => total + event.args.wad, 0n);
  return withdrawals + transferred([call], wrappedNative, router, zeroAddress);
}

/**
 * Outcome proof of a landed swap: the router call, a Swap from every
 * recorded pool and from no other address, and the output credited to the
 * account at or above the lowest prepared floor.
 */
export async function proveSwap(
  step: IntentStep,
  protocol: DexProtocol,
  label: string,
  receipts: readonly LandedEvmReceipt[],
  observedAt: string,
): Promise<EvmOutcome> {
  const recorded = decodeRoute(protocol, step.network, decodeStepRef(step.quoteRef)?.provider);
  const output = step.minimumOutput;
  const input = step.input;
  if (!recorded || !output || !input) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The step has no recorded ${label} route.` });
  const { deployment } = recorded;
  const account = stepOwner(step);
  const call = landedCall(receipts, deployment.router);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `No landed transaction called the ${label} router.` });
  try {
    decodeFunctionData({ abi: ROUTER_DECODE_ABI, data: call.input as Hex });
  } catch {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The ${label} router call is not a swap multicall.` });
  }
  const parsedIn = parseAssetId(input.asset);
  const parsedOut = parseAssetId(output.asset);
  if (!parsedIn || !parsedOut) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The step's assets are not readable." });
  const nativeOut = parsedOut.isNative;
  const tokenOf = (parsed: NonNullable<typeof parsedIn>) => getAddress(parsed.isNative ? deployment.wrappedNative : parsed.reference);
  const tokenIn = tokenOf(parsedIn);
  const tokenOut = tokenOf(parsedOut);
  const middle = recorded.intermediate ? intermediateToken(deployment, recorded.intermediate) : null;
  const tokens = middle ? [tokenIn, middle, tokenOut] : [tokenIn, tokenOut];
  const pools: Address[] = [];
  for (const [index, tier] of recorded.tiers.entries()) {
    const pool = await poolFor(deployment, { tokenIn: tokens[index] as Address, tokenOut: tokens[index + 1] as Address, tier });
    if (!pool) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The pinned factory has no pool for hop ${index + 1} of the route.` });
    pools.push(pool);
  }
  const swaps = parseEventLogs({ abi: [SWAP_EVENT as NonNullable<typeof SWAP_EVENT>], logs: [...call.logs], eventName: "Swap", strict: true });
  const foreign = swaps.find((event) => !pools.some((pool) => sameAddress(pool, event.address)));
  if (foreign) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `A Swap event came from ${foreign.address}, which is not a pool of the pinned factory on the recorded route.` });
  const missing = pools.find((pool) => !swaps.some((event) => sameAddress(event.address, pool)));
  if (missing) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The recorded pool ${missing} emitted no Swap event.` });
  const floor = lowestPreparedFloor(step);
  if (floor === null) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The step has no prepared output floor." });
  const credited = nativeOut ? routerUnwrapped(call, deployment.wrappedNative, deployment.router) : erc20CreditFromLogs(call.logs, tokenOut, account);
  if (credited < floor) {
    return outcomeFailure({
      code: "OUTCOME_NOT_PROVEN",
      message: `The swap credited ${fromBaseUnits(credited, output.decimals)} ${output.symbol}${nativeOut ? " (unwrapped by the router)" : ""} to the account, below the guaranteed ${fromBaseUnits(floor, output.decimals)}.`,
    });
  }
  return {
    actualOutput: observed(output, credited),
    evidence: [eventEvidence(step, call, observedAt, `${label} Swap through ${pools.join(", ")}: ${fromBaseUnits(credited, output.decimals)} ${output.symbol} credited to ${account}.`)],
  };
}

/* ------------------------------------------------------------------ adapter */

export interface ConcentratedAdapterOptions {
  readonly id: DexProtocol;
  readonly label: string;
}

/** A Kletia-encoded concentrated-liquidity swap adapter over the protocol's pinned deployments. */
export function createConcentratedAdapter(options: ConcentratedAdapterOptions): ProtocolAdapter {
  const { id, label } = options;
  const protocols: readonly ProtocolId[] = [id];
  return {
    id,
    protocols,
    label,

    supports(route) {
      return supportsSwap(route, id);
    },

    async plan(action): Promise<PlannedStep> {
      const context = swapContext(action, id, label);
      const now = Math.floor(Date.now() / 1000);
      const planned = await swapQuote(context, action, "plan", BigInt(now + DEX_PREVIEW_TTL_SECONDS + DEADLINE_GRACE_SECONDS), null);
      const fees = await estimateEvmFeeUsd(context.network, planned.gas);
      return {
        protocol: id,
        title: `Swap ${units(planned.amountIn, action.input)} for ${action.output.symbol} on ${CHAINS[context.network].name} via ${label}`,
        mode: "wallet",
        input: assetAmount(action.input, planned.amountIn.toString()),
        expectedOutput: assetAmount(action.output, planned.expected.toString()),
        minimumOutput: assetAmount(action.output, planned.minimum.toString()),
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        estimatedSeconds: 15 * planned.transactions.length,
        settlement: { kind: "same-network" },
        warnings: planned.warnings,
        provider: encodeRoute(planned.route),
        transactionCount: planned.transactions.length,
        slippageBps: planned.slippageBps,
        floor: "onchain",
        // Kletia encodes the payload itself: the preview simulates exactly these transactions.
        preview: { transactions: planned.transactions, approvalSpender: planned.route.deployment.router, expiresAt: now + DEX_PREVIEW_TTL_SECONDS },
      };
    },

    async prepare({ action, now, expiresAt }): Promise<PreparedPayload> {
      const context = swapContext(action, id, label);
      const recorded = decodeRoute(id, context.network, action.provider);
      const deadline = BigInt((expiresAt ?? Math.floor(now / 1000) + 90) + DEADLINE_GRACE_SECONDS);
      const prepared = await swapQuote(context, action, "prepare", deadline, recorded);
      const fees = await estimateEvmFeeUsd(context.network, prepared.gas);
      return {
        transactions: prepared.transactions,
        records: payloadRecords(context.network, prepared.transactions),
        input: assetAmount(action.input, prepared.amountIn.toString()),
        expectedOutput: assetAmount(action.output, prepared.expected.toString()),
        minimumOutput: assetAmount(action.output, prepared.minimum.toString()),
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        warnings: prepared.warnings,
      };
    },

    async verify(context) {
      const observedAt = new Date(context.now).toISOString();
      const { result } = await verifyEvmReceipts(context, (receipts) => proveSwap(context.step, id, label, receipts, observedAt));
      return result;
    },
  };
}
