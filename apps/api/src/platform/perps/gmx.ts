/**
 * GMX v2 (synthetics) on Arbitrum One: markets from the GMX oracle keeper
 * API plus DataStore factors, positions from Reader.getAccountPositions, and
 * unsigned ExchangeRouter multicalls (sendWnt + sendTokens + createOrder) for
 * MarketIncrease / MarketDecrease orders. GMX keepers execute the order a
 * few seconds later at the oracle price; `acceptablePrice` bounds the fill
 * and an order that cannot fill within it is cancelled with the collateral
 * returned. The calls mirror @gmx-io/sdk 2.4.0 `createIncreaseOrderTxn` /
 * `createDecreaseOrderTxn`; addresses are pinned in @kletia/core
 * (`GMX_V2_ARBITRUM`, `GMX_V2_MARKETS`).
 *
 * Units: USD values and prices carry 30 decimals; a price is per unit of the
 * index token, so it carries `30 - indexDecimals` decimals.
 */
import { GMX_V2_ARBITRUM, GMX_V2_MARKETS, perpsLiquidationPrice, type EvmTransactionRequest, type GmxMarketPin, type PerpsMarket, type PerpsPosition, type PerpsSide } from "@kletia/core";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, zeroAddress, zeroHash, type Hex } from "viem";
import { PlatformError } from "../errors.js";
import type { PerpsIo } from "./io.js";

const PROVIDER = "GMX";
const FLOAT = 10n ** 30n;
/** Order types (gmx-synthetics Order.OrderType). */
export const GMX_ORDER_TYPE = Object.freeze({ MarketIncrease: 2, MarketDecrease: 4 });
/** The execution fee carries this margin over the current gas price (GMX refunds what the keeper does not use). */
const EXECUTION_FEE_BUFFER_PERCENT = 200n;
/** Oracle prices an order without swaps needs (gmx-synthetics GasUtils.estimateOrderOraclePriceCount). */
const ORDER_ORACLE_PRICES = 3n;
/** Largest age of a keeper price before quotes are refused. */
const MAX_TICKER_AGE_SECONDS = 120;

const ADDRESSES_TUPLE = {
  type: "tuple",
  name: "addresses",
  components: [
    { type: "address", name: "receiver" },
    { type: "address", name: "cancellationReceiver" },
    { type: "address", name: "callbackContract" },
    { type: "address", name: "uiFeeReceiver" },
    { type: "address", name: "market" },
    { type: "address", name: "initialCollateralToken" },
    { type: "address[]", name: "swapPath" },
  ],
} as const;
const NUMBERS_TUPLE = {
  type: "tuple",
  name: "numbers",
  components: [
    { type: "uint256", name: "sizeDeltaUsd" },
    { type: "uint256", name: "initialCollateralDeltaAmount" },
    { type: "uint256", name: "triggerPrice" },
    { type: "uint256", name: "acceptablePrice" },
    { type: "uint256", name: "executionFee" },
    { type: "uint256", name: "callbackGasLimit" },
    { type: "uint256", name: "minOutputAmount" },
    { type: "uint256", name: "validFromTime" },
  ],
} as const;

/** ExchangeRouter fragments (gmx-synthetics deployments/arbitrum/ExchangeRouter.json). */
export const GMX_EXCHANGE_ROUTER_ABI = [
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ type: "bytes[]", name: "data" }], outputs: [{ type: "bytes[]", name: "results" }] },
  { type: "function", name: "sendWnt", stateMutability: "payable", inputs: [{ type: "address", name: "receiver" }, { type: "uint256", name: "amount" }], outputs: [] },
  { type: "function", name: "sendTokens", stateMutability: "payable", inputs: [{ type: "address", name: "token" }, { type: "address", name: "receiver" }, { type: "uint256", name: "amount" }], outputs: [] },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "payable",
    inputs: [{
      type: "tuple",
      name: "params",
      components: [
        ADDRESSES_TUPLE,
        NUMBERS_TUPLE,
        { type: "uint8", name: "orderType" },
        { type: "uint8", name: "decreasePositionSwapType" },
        { type: "bool", name: "isLong" },
        { type: "bool", name: "shouldUnwrapNativeToken" },
        { type: "bool", name: "autoCancel" },
        { type: "bytes32", name: "referralCode" },
        { type: "bytes32[]", name: "dataList" },
      ],
    }],
    outputs: [{ type: "bytes32", name: "" }],
  },
] as const;

/** Reader.getAccountPositions (gmx-synthetics deployments/arbitrum/Reader.json). */
export const GMX_READER_ABI = [{
  type: "function",
  name: "getAccountPositions",
  stateMutability: "view",
  inputs: [{ type: "address", name: "dataStore" }, { type: "address", name: "account" }, { type: "uint256", name: "start" }, { type: "uint256", name: "end" }],
  outputs: [{
    type: "tuple[]",
    name: "",
    components: [
      { type: "tuple", name: "addresses", components: [{ type: "address", name: "account" }, { type: "address", name: "market" }, { type: "address", name: "collateralToken" }] },
      {
        type: "tuple",
        name: "numbers",
        components: [
          { type: "uint256", name: "sizeInUsd" },
          { type: "uint256", name: "sizeInTokens" },
          { type: "uint256", name: "collateralAmount" },
          { type: "int256", name: "pendingImpactAmount" },
          { type: "uint256", name: "borrowingFactor" },
          { type: "uint256", name: "fundingFeeAmountPerSize" },
          { type: "uint256", name: "longTokenClaimableFundingAmountPerSize" },
          { type: "uint256", name: "shortTokenClaimableFundingAmountPerSize" },
          { type: "uint256", name: "increasedAtTime" },
          { type: "uint256", name: "decreasedAtTime" },
        ],
      },
      { type: "tuple", name: "flags", components: [{ type: "bool", name: "isLong" }] },
    ],
  }],
}] as const;

const DATA_STORE_ABI = [{ type: "function", name: "getUint", stateMutability: "view", inputs: [{ type: "bytes32", name: "key" }], outputs: [{ type: "uint256", name: "" }] }] as const;

/** keccak256(abi.encode(name)): gmx-synthetics Keys. */
export function gmxKey(name: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }], [name]));
}

export function gmxMarketKey(name: string, market: string, flag?: boolean): Hex {
  return flag === undefined
    ? keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [gmxKey(name), getAddress(market)]))
    : keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bool" }], [gmxKey(name), getAddress(market), flag]));
}

async function readUint(io: PerpsIo, key: Hex): Promise<bigint> {
  const data = encodeFunctionData({ abi: DATA_STORE_ABI, functionName: "getUint", args: [key] });
  return decodeFunctionResult({ abi: DATA_STORE_ABI, functionName: "getUint", data: await io.arbitrumCall(GMX_V2_ARBITRUM.dataStore, data) });
}

const factor = (value: bigint): number => Number((value * 1_000_000_000n) / FLOAT) / 1e9;
const usd30 = (value: bigint): number => Number((value * 100n) / FLOAT) / 100;

/** USD price of one whole index token from a 30-decimal GMX price. */
export function gmxPriceToUsd(value: bigint, indexDecimals: number): number {
  return Number(value) / 10 ** (30 - indexDecimals);
}

/** A USD price as a GMX contract price (8 significant decimals kept). */
export function gmxUsdToPrice(price: number, indexDecimals: number): bigint {
  const shift = 30 - indexDecimals - 8;
  const scaled = BigInt(Math.round(price * 1e8));
  return shift >= 0 ? scaled * 10n ** BigInt(shift) : scaled / 10n ** BigInt(-shift);
}

interface Ticker {
  readonly min: bigint;
  readonly max: bigint;
  readonly timestamp: number;
}

async function readTickers(io: PerpsIo): Promise<Map<string, Ticker>> {
  const body = await io.json(PROVIDER, `${GMX_V2_ARBITRUM.api}/prices/tickers`);
  const out = new Map<string, Ticker>();
  if (!Array.isArray(body)) return out;
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    const { tokenAddress, minPrice, maxPrice, timestamp } = entry as Record<string, unknown>;
    if (typeof tokenAddress !== "string" || typeof minPrice !== "string" || typeof maxPrice !== "string" || typeof timestamp !== "number") continue;
    if (!/^\d{1,60}$/u.test(minPrice) || !/^\d{1,60}$/u.test(maxPrice)) continue;
    out.set(tokenAddress.toLowerCase(), { min: BigInt(minPrice), max: BigInt(maxPrice), timestamp });
  }
  return out;
}

/** A fresh keeper price of `token` (USD per whole token), or a PERPS_PRICE_UNAVAILABLE refusal. */
function freshPrice(tickers: Map<string, Ticker>, token: string, decimals: number, nowSeconds: number): { readonly mid: number; readonly at: number } {
  const ticker = tickers.get(token.toLowerCase());
  if (!ticker || ticker.min === 0n || nowSeconds - ticker.timestamp > MAX_TICKER_AGE_SECONDS) {
    throw new PlatformError("PERPS_PRICE_UNAVAILABLE", "The GMX oracle price is missing or stale, so Kletia will not quote or build a GMX order.", 503);
  }
  return { mid: gmxPriceToUsd((ticker.min + ticker.max) / 2n, decimals), at: ticker.timestamp };
}

interface MarketInfoRow {
  readonly isListed: boolean;
  readonly openInterestLong: bigint;
  readonly openInterestShort: bigint;
  readonly netRateLong: bigint;
  readonly netRateShort: bigint;
}

const signedBig = (value: unknown): bigint | null => (typeof value === "string" && /^-?\d{1,70}$/u.test(value) ? BigInt(value) : null);

async function readMarketInfo(io: PerpsIo): Promise<Map<string, MarketInfoRow>> {
  const body = await io.json(PROVIDER, `${GMX_V2_ARBITRUM.api}/markets/info`);
  const markets = typeof body === "object" && body !== null && Array.isArray((body as { markets?: unknown }).markets) ? (body as { markets: unknown[] }).markets : [];
  const out = new Map<string, MarketInfoRow>();
  for (const entry of markets) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const values = [row.openInterestLong, row.openInterestShort, row.netRateLong, row.netRateShort].map(signedBig);
    if (typeof row.marketToken !== "string" || values.some((value) => value === null)) continue;
    const [openInterestLong, openInterestShort, netRateLong, netRateShort] = values as bigint[];
    out.set(row.marketToken.toLowerCase(), { isListed: row.isListed === true, openInterestLong: openInterestLong!, openInterestShort: openInterestShort!, netRateLong: netRateLong!, netRateShort: netRateShort! });
  }
  return out;
}

const HOURS_PER_YEAR = 24 * 365;

/**
 * The pinned GMX markets with a fresh keeper price. Funding plus borrowing
 * come from `/markets/info` net rates (annualized, 30 decimals, positive:
 * the side pays); the maintenance margin is the market's
 * MIN_COLLATERAL_FACTOR and the fee its POSITION_FEE_FACTOR (no-improvement
 * side) read from the DataStore.
 */
export async function readGmxMarkets(io: PerpsIo): Promise<PerpsMarket[]> {
  const [tickers, info] = await Promise.all([readTickers(io), readMarketInfo(io)]);
  const now = Math.floor(io.now() / 1000);
  return Promise.all(GMX_V2_MARKETS.map(async (pin): Promise<PerpsMarket> => {
    const price = freshPrice(tickers, pin.indexToken, pin.indexDecimals, now);
    const row = info.get(pin.marketToken.toLowerCase());
    const [minCollateralFactor, positionFeeFactor] = await Promise.all([
      readUint(io, gmxMarketKey("MIN_COLLATERAL_FACTOR", pin.marketToken)),
      readUint(io, gmxMarketKey("POSITION_FEE_FACTOR", pin.marketToken, false)),
    ]);
    const mmr = factor(minCollateralFactor);
    return {
      venue: "gmx-v2",
      symbol: pin.symbol,
      marketId: pin.marketToken,
      network: "arbitrum",
      markPrice: price.mid,
      fundingRate1h: row ? { long: factor(row.netRateLong) / HOURS_PER_YEAR, short: factor(row.netRateShort) / HOURS_PER_YEAR } : { long: 0, short: 0 },
      openInterestUsd: row ? { long: usd30(row.openInterestLong), short: usd30(row.openInterestShort) } : null,
      maxLeverage: mmr > 0 ? Math.min(100, Math.floor(1 / mmr)) : 1,
      maintenanceMarginRate: mmr,
      takerFeeRate: factor(positionFeeFactor),
      // GMX fills at the oracle price plus a price impact it computes at execution; acceptablePrice bounds it.
      impactPer10kUsd: 0,
      minSizeUsd: 10,
      minCollateralUsd: 2,
      observedAt: price.at,
      open: row?.isListed ?? false,
    };
  }));
}

export interface GmxRawPosition {
  readonly pin: GmxMarketPin;
  readonly isLong: boolean;
  readonly sizeInUsd: bigint;
  readonly sizeInTokens: bigint;
  readonly collateralAmount: bigint;
}

/** Positions of `account` in the pinned USDC-collateral markets, and how many others it holds. */
export async function readGmxRawPositions(io: PerpsIo, account: string): Promise<{ readonly positions: GmxRawPosition[]; readonly unsupported: number }> {
  const data = encodeFunctionData({ abi: GMX_READER_ABI, functionName: "getAccountPositions", args: [getAddress(GMX_V2_ARBITRUM.dataStore), getAddress(account), 0n, 100n] });
  const rows = decodeFunctionResult({ abi: GMX_READER_ABI, functionName: "getAccountPositions", data: await io.arbitrumCall(GMX_V2_ARBITRUM.reader, data) });
  const positions: GmxRawPosition[] = [];
  let unsupported = 0;
  for (const row of rows) {
    const pin = GMX_V2_MARKETS.find((entry) => entry.marketToken.toLowerCase() === row.addresses.market.toLowerCase());
    if (!pin || row.addresses.collateralToken.toLowerCase() !== GMX_V2_ARBITRUM.usdc.toLowerCase() || row.numbers.sizeInUsd === 0n) {
      unsupported += 1;
      continue;
    }
    positions.push({ pin, isLong: row.flags.isLong, sizeInUsd: row.numbers.sizeInUsd, sizeInTokens: row.numbers.sizeInTokens, collateralAmount: row.numbers.collateralAmount });
  }
  return { positions, unsupported };
}

/** Entry price of a raw position (USD per whole index token). */
function entryPriceOf(position: GmxRawPosition): number {
  return position.sizeInTokens === 0n ? 0 : usd30(position.sizeInUsd) / (Number(position.sizeInTokens) / 10 ** position.pin.indexDecimals);
}

export function gmxPositionView(position: GmxRawPosition, market: PerpsMarket | null): PerpsPosition {
  const side: PerpsSide = position.isLong ? "long" : "short";
  const sizeUsd = usd30(position.sizeInUsd);
  const sizeBase = Number(position.sizeInTokens) / 10 ** position.pin.indexDecimals;
  const collateralUsd = Number(position.collateralAmount) / 1e6;
  const entryPrice = entryPriceOf(position);
  const markPrice = market?.markPrice ?? null;
  return {
    venue: "gmx-v2",
    symbol: position.pin.symbol,
    marketId: position.pin.marketToken,
    network: "arbitrum",
    side,
    sizeUsd,
    sizeBase,
    collateralUsd,
    entryPrice,
    markPrice,
    leverage: collateralUsd > 0 ? Math.round((sizeUsd / collateralUsd) * 100) / 100 : null,
    liquidationPrice: market ? perpsLiquidationPrice({ side, entryPrice, sizeUsd, collateralUsd, maintenanceMarginRate: market.maintenanceMarginRate }) : null,
    unrealizedPnlUsd: markPrice === null ? null : (position.isLong ? 1 : -1) * sizeBase * (markPrice - entryPrice),
  };
}

/**
 * Execution fee in wei: (ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1 + 3 oracle prices
 * × ESTIMATED_GAS_FEE_PER_ORACLE_PRICE + order gas limit ×
 * ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR) × gas price, doubled so a gas price
 * rise between prepare and signing cannot revert the order
 * (gmx-synthetics GasUtils.adjustGasLimitForEstimate).
 */
export async function gmxExecutionFee(io: PerpsIo, increase: boolean): Promise<bigint> {
  const [base, perOracle, multiplier, orderGas, gasPrice] = await Promise.all([
    readUint(io, gmxKey("ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1")),
    readUint(io, gmxKey("ESTIMATED_GAS_FEE_PER_ORACLE_PRICE")),
    readUint(io, gmxKey("ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR")),
    readUint(io, gmxKey(increase ? "INCREASE_ORDER_GAS_LIMIT" : "DECREASE_ORDER_GAS_LIMIT")),
    io.arbitrumGasPrice(),
  ]);
  if (orderGas === 0n || gasPrice === 0n) throw new PlatformError("PERPS_PRICE_UNAVAILABLE", "GMX gas settings could not be read, so the execution fee is unknown.", 503);
  const gasLimit = base + perOracle * ORDER_ORACLE_PRICES + (orderGas * multiplier) / FLOAT;
  return (gasLimit * gasPrice * EXECUTION_FEE_BUFFER_PERCENT) / 100n;
}

/** WETH price from the keeper tickers (prices the execution fee in USD). */
export async function gmxEthUsd(io: PerpsIo): Promise<number> {
  const eth = GMX_V2_MARKETS.find((pin) => pin.symbol === "ETH")!;
  return freshPrice(await readTickers(io), eth.indexToken, 18, Math.floor(io.now() / 1000)).mid;
}

export interface GmxOrderInput {
  readonly account: string;
  readonly pin: GmxMarketPin;
  readonly isLong: boolean;
  readonly increase: boolean;
  readonly sizeDeltaUsd: bigint;
  /** USDC base units sent (increase) or withdrawn (decrease). */
  readonly collateralDelta: bigint;
  readonly acceptablePrice: bigint;
  readonly executionFee: bigint;
}

/** The ExchangeRouter multicall of one market order (value = execution fee). */
export function gmxOrderTransaction(input: GmxOrderInput): EvmTransactionRequest {
  const account = getAddress(input.account);
  const orderVault = getAddress(GMX_V2_ARBITRUM.orderVault);
  const usdc = getAddress(GMX_V2_ARBITRUM.usdc);
  const calls: Hex[] = [encodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, functionName: "sendWnt", args: [orderVault, input.executionFee] })];
  if (input.increase) calls.push(encodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, functionName: "sendTokens", args: [usdc, orderVault, input.collateralDelta] }));
  calls.push(encodeFunctionData({
    abi: GMX_EXCHANGE_ROUTER_ABI,
    functionName: "createOrder",
    args: [{
      addresses: {
        receiver: account,
        cancellationReceiver: zeroAddress,
        callbackContract: zeroAddress,
        uiFeeReceiver: zeroAddress,
        market: getAddress(input.pin.marketToken),
        initialCollateralToken: usdc,
        swapPath: [],
      },
      numbers: {
        sizeDeltaUsd: input.sizeDeltaUsd,
        // The GMX interface sends the collateral amount on increases too (the OrderVault records what arrived).
        initialCollateralDeltaAmount: input.collateralDelta,
        triggerPrice: 0n,
        acceptablePrice: input.acceptablePrice,
        executionFee: input.executionFee,
        callbackGasLimit: 0n,
        minOutputAmount: 0n,
        validFromTime: 0n,
      },
      orderType: input.increase ? GMX_ORDER_TYPE.MarketIncrease : GMX_ORDER_TYPE.MarketDecrease,
      decreasePositionSwapType: 0,
      isLong: input.isLong,
      shouldUnwrapNativeToken: false,
      autoCancel: false,
      referralCode: zeroHash,
      dataList: [],
    }],
  }));
  const usd = Number(input.sizeDeltaUsd / 10n ** 28n) / 100;
  return {
    vm: "evm",
    network: "arbitrum",
    chainId: GMX_V2_ARBITRUM.chainId,
    from: account,
    to: getAddress(GMX_V2_ARBITRUM.exchangeRouter),
    data: encodeFunctionData({ abi: GMX_EXCHANGE_ROUTER_ABI, functionName: "multicall", args: [calls] }),
    value: input.executionFee.toString(),
    description: `GMX ${input.increase ? "increase" : "decrease"} ${input.isLong ? "long" : "short"} ${input.pin.symbol} by ${usd} USD`,
  };
}

/** USDC approval of exactly `amount` to the GMX Router (the spender ExchangeRouter.sendTokens pulls through). */
export function gmxApproveTransaction(account: string, amount: bigint): EvmTransactionRequest {
  return {
    vm: "evm",
    network: "arbitrum",
    chainId: GMX_V2_ARBITRUM.chainId,
    from: getAddress(account),
    to: getAddress(GMX_V2_ARBITRUM.usdc),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(GMX_V2_ARBITRUM.router), amount] }),
    value: "0",
    description: `Approve ${Number(amount) / 1e6} USDC to the GMX Router`,
  };
}

/** USDC allowance of `account` to the GMX Router. */
export async function gmxAllowance(io: PerpsIo, account: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(account), getAddress(GMX_V2_ARBITRUM.router)] });
  return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: await io.arbitrumCall(GMX_V2_ARBITRUM.usdc, data) });
}
