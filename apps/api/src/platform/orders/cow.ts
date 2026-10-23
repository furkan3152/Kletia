/**
 * CoW Protocol native orders on Ethereum, Arbitrum One and Base.
 *
 * Limit orders: Kletia builds the EIP-712 `Order` typed data (and a
 * GPv2VaultRelayer approval when the allowance is short); the owner signs it
 * and Kletia POSTs that exact order with the owner's signature to the CoW
 * orderbook. Solvers settle it at the limit price or better; the tokens stay
 * in the wallet until settlement.
 *
 * TWAP: a ComposableCoW conditional order, which only a Safe whose fallback
 * handler is the ExtensibleFallbackHandler (with ComposableCoW as the CoW
 * domain verifier) can create. Kletia returns the Safe transactions; an
 * account without code is told plainly that TWAP needs a Safe.
 */
import { randomBytes } from "node:crypto";
import { encodeFunctionData, erc20Abi, getAddress, isAddressEqual, type Hex } from "viem";
import { formatAmount, fromBaseUnits, isEvmAddress } from "@kletia/core";
import { fetchProviderJson, isRecord } from "../../networks/solana/http.js";
import { PlatformError } from "../errors.js";
import { evmChainId, rawEthCall, readAllowance, readCode, readErc20Metadata, readStorageSlot, type EvmNetworkKey } from "../engine/chains/evm.js";
import { orderAmount, refAmount, tokenRef, type TokenRef } from "./amounts.js";
import {
  COMPOSABLE_COW,
  COW_API_NETWORKS,
  COW_BUY_ETH_ADDRESS,
  COW_TWAP_HANDLER,
  GPV2_SETTLEMENT,
  GPV2_VAULT_RELAYER,
  SAFE_EXTENSIBLE_FALLBACK_HANDLER,
  SAFE_FALLBACK_HANDLER_SLOT,
  conditionalOrderHash,
  cowAppData,
  cowCancellationTypedData,
  cowOrderDigest,
  cowOrderTypedData,
  cowOrderUid,
  createTwapCalldata,
  invalidateOrderCalldata,
  removeTwapCalldata,
  twapStaticInput,
  type CowOrder,
} from "./cowProtocol.js";
import { typedDataDigest } from "./evmGuard.js";
import { priceUnits } from "./plan.js";
import type {
  NativeOrder,
  NativeOrderProvider,
  NativeOrderQuote,
  NativeOrderRef,
  NativeOrderRequest,
  NativeOrderStatus,
  OrderNetwork,
  OrderSignRequest,
  OrderSubmission,
  PreparedOrderDraft,
  RelayResult,
} from "./types.js";

const COW_API_ORIGIN = (process.env.COW_API_ORIGIN?.trim() || "https://api.cow.fi").replace(/\/+$/u, "");
/** Limit orders without an expiry stay valid this long. */
const DEFAULT_VALIDITY_SECONDS = 30 * 86_400;
/** A signature request stays usable this long (the order itself is valid until validTo). */
const SIGNING_TTL_SECONDS = 30 * 60;
/** TWAP parts without a stated price accept at most this much below the quote at preparation. */
const TWAP_PRICE_PROTECTION_BPS = 1_000n;
const CUSTODY = "Your tokens stay in your wallet until a solver settles the order through GPv2Settlement; the GPv2VaultRelayer approval lets only settlement at your terms move them. Kletia never holds them.";

function network(value: OrderNetwork): EvmNetworkKey & OrderNetwork {
  if (!COW_API_NETWORKS[value]) throw new PlatformError("ORDER_UNSUPPORTED", "CoW Protocol orders run on Ethereum, Arbitrum and Base.", 422, undefined, undefined, { reason: "network" });
  return value as EvmNetworkKey & OrderNetwork;
}

function api(net: OrderNetwork, path: string): string {
  return `${COW_API_ORIGIN}/${COW_API_NETWORKS[net]}/api/v1/${path}`;
}

async function cowJson(net: OrderNetwork, path: string, init: RequestInit = {}): Promise<unknown> {
  return fetchProviderJson<unknown>(api(net, path), {
    provider: "CoW Protocol",
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
}

function ownerOf(owner: string): string {
  if (!isEvmAddress(owner)) throw new PlatformError("ORDER_INVALID", "owner must be an EVM address for a CoW order.", 400, [{ path: "owner", message: "A 0x address." }]);
  return getAddress(owner);
}

function sellToken(request: NativeOrderRequest): string {
  if (request.sell.isNative) {
    throw new PlatformError("ORDER_UNSUPPORTED", `CoW orders sell ERC-20 tokens; sell W${request.sell.symbol} instead of ${request.sell.symbol}.`, 422, undefined, [`sell ${request.plan.amount} W${request.sell.symbol}`], {
      reason: "native-sell",
    });
  }
  return getAddress(request.sell.address as string);
}

function buyToken(request: NativeOrderRequest): string {
  return request.buy.isNative ? COW_BUY_ETH_ADDRESS : getAddress(request.buy.address as string);
}

/* --------------------------------------------------------------- quotes */

interface CowQuote {
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  readonly feeAmount: bigint;
}

/** POST /quote: what the market gives now (sell kind: buyAmount after fees; buy kind: sellAmount plus fee). */
export async function cowQuote(net: OrderNetwork, input: { from: string; sellToken: string; buyToken: string; kind: "sell" | "buy"; amount: bigint }): Promise<CowQuote> {
  const reply = await cowJson(net, "quote", {
    method: "POST",
    body: JSON.stringify({
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      from: input.from,
      receiver: input.from,
      kind: input.kind,
      ...(input.kind === "sell" ? { sellAmountBeforeFee: input.amount.toString() } : { buyAmountAfterFee: input.amount.toString() }),
      signingScheme: "eip712",
      appData: "{}",
    }),
  });
  const quote = isRecord(reply) && isRecord(reply.quote) ? reply.quote : null;
  const read = (value: unknown) => (typeof value === "string" && /^\d{1,78}$/u.test(value) ? BigInt(value) : null);
  const sellAmount = read(quote?.sellAmount);
  const buyAmount = read(quote?.buyAmount);
  const feeAmount = read(quote?.feeAmount) ?? 0n;
  if (sellAmount === null || buyAmount === null) throw new PlatformError("PROVIDER_UNAVAILABLE", "CoW Protocol returned an unreadable quote.", 502);
  return { sellAmount, buyAmount, feeAmount };
}

/** How much better than the market the limit is, in percent (positive: waits for the price to move). */
function betterThanMarket(kind: "sell" | "buy", ours: bigint, market: bigint | null): number | null {
  if (market === null || market === 0n || ours === 0n) return null;
  const ratio = kind === "sell" ? (ours * 1_000_000n) / market : (market * 1_000_000n) / ours;
  return Math.round((Number(ratio) / 10_000 - 100) * 100) / 100;
}

async function tryQuote(net: OrderNetwork, input: Parameters<typeof cowQuote>[1], warnings: string[]): Promise<CowQuote | null> {
  try {
    return await cowQuote(net, input);
  } catch {
    warnings.push("CoW Protocol has no quote for this pair right now.");
    return null;
  }
}

/* ------------------------------------------------------------- accounts */

async function hasCode(net: EvmNetworkKey, owner: string): Promise<boolean> {
  return (await readCode(net, owner)) !== "0x";
}

const SAFE_ABI = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;
const HANDLER_ABI = [
  { type: "function", name: "domainVerifiers", stateMutability: "view", inputs: [{ name: "safe", type: "address" }, { name: "domainSeparator", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
] as const;
const SETTLEMENT_ABI = [{ type: "function", name: "domainSeparator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] }] as const;

function twapUnsupported(message: string, reason: string): PlatformError {
  return new PlatformError("ORDER_UNSUPPORTED", message, 422, undefined, undefined, { reason });
}

function wordAddress(word: string | null): string | null {
  return word && /^0x[0-9a-fA-F]{64}$/u.test(word) ? getAddress(`0x${word.slice(-40)}`) : null;
}

/**
 * TWAP needs a Safe that delegates CoW signatures to ComposableCoW: code at
 * the owner, `getThreshold()`, the ExtensibleFallbackHandler in the Safe's
 * fallback-handler slot, and ComposableCoW as the verifier of the
 * GPv2Settlement domain. Each missing piece is refused with its reason.
 */
export async function assertTwapSafe(net: EvmNetworkKey, owner: string): Promise<void> {
  if (!(await hasCode(net, owner))) {
    throw twapUnsupported("CoW TWAP orders are ComposableCoW conditional orders that only a Safe can create; this owner is a plain account (EOA). Use a limit order, or a Safe.", "twap-requires-safe");
  }
  const threshold = await rawEthCall(net, owner, encodeFunctionData({ abi: SAFE_ABI, functionName: "getThreshold" }));
  if (!threshold || threshold === "0x") throw twapUnsupported("The owner contract is not a Safe; CoW TWAP orders need a Safe.", "twap-requires-safe");
  const handler = wordAddress(await readStorageSlot(net, owner, SAFE_FALLBACK_HANDLER_SLOT));
  if (!handler || !isAddressEqual(handler as Hex, SAFE_EXTENSIBLE_FALLBACK_HANDLER)) {
    throw twapUnsupported("The Safe's fallback handler is not CoW's ExtensibleFallbackHandler, so it cannot sign TWAP parts. Upgrade the fallback handler in the Safe (CoW Swap's TWAP setup does this), then try again.", "safe-not-configured");
  }
  const separator = await rawEthCall(net, GPV2_SETTLEMENT, encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: "domainSeparator" }));
  const verifier = separator
    ? wordAddress(await rawEthCall(net, SAFE_EXTENSIBLE_FALLBACK_HANDLER, encodeFunctionData({ abi: HANDLER_ABI, functionName: "domainVerifiers", args: [getAddress(owner), separator as Hex] })))
    : null;
  if (!verifier || !isAddressEqual(verifier as Hex, COMPOSABLE_COW)) {
    throw twapUnsupported("The Safe does not use ComposableCoW as its CoW domain verifier, so TWAP parts would not verify. Complete CoW Swap's TWAP setup in the Safe, then try again.", "safe-not-configured");
  }
}

function approveCalldata(amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GPV2_VAULT_RELAYER, amount] });
}

/* -------------------------------------------------------------- listing */

const STATUS: Readonly<Record<string, NativeOrderStatus>> = { open: "open", fulfilled: "filled", cancelled: "cancelled", expired: "expired" };
const decimalsCache = new Map<string, number>();

/** Decimals of a token the registry does not list, read on-chain once per process; null when unreadable. */
export type TokenDecimalsReader = (net: OrderNetwork, address: string) => Promise<number | null>;

const readDecimals: TokenDecimalsReader = async (net, address) => {
  const key = `${net}:${address.toLowerCase()}`;
  if (!decimalsCache.has(key)) {
    try {
      decimalsCache.set(key, (await readErc20Metadata(network(net), address)).decimals);
    } catch {
      return null;
    }
  }
  return decimalsCache.get(key) ?? null;
};

async function token(net: OrderNetwork, address: string, decimalsOf: TokenDecimalsReader): Promise<TokenRef> {
  const known = tokenRef(net, address);
  if (address.toLowerCase() === COW_BUY_ETH_ADDRESS.toLowerCase()) return { ...known, symbol: "ETH", decimals: 18 };
  return known.decimals !== null ? known : { ...known, decimals: await decimalsOf(net, address) };
}

function units(value: unknown): bigint {
  return typeof value === "string" && /^\d{1,78}$/u.test(value) ? BigInt(value) : 0n;
}

/** A CoW orderbook order as a native order. */
export async function mapCowOrder(net: OrderNetwork, raw: Record<string, unknown>, decimalsOf: TokenDecimalsReader = readDecimals): Promise<NativeOrder> {
  const [sell, buy] = await Promise.all([token(net, String(raw.sellToken), decimalsOf), token(net, String(raw.buyToken), decimalsOf)]);
  const status = STATUS[String(raw.status)] ?? "unknown";
  const appData = typeof raw.fullAppData === "string" ? raw.fullAppData : "";
  const validTo = Number(raw.validTo);
  return {
    id: `cow-protocol:${net}:${String(raw.uid)}`,
    protocol: "cow-protocol",
    mechanism: raw.signingScheme === "eip1271" && /"orderClass"\s*:\s*"twap"/u.test(appData) ? "twap" : "limit",
    network: net,
    owner: getAddress(String(raw.owner)),
    status,
    sell: refAmount(sell, units(raw.sellAmount)),
    buy: refAmount(buy, units(raw.buyAmount)),
    sold: refAmount(sell, units(raw.executedSellAmountBeforeFees)),
    bought: refAmount(buy, units(raw.executedBuyAmount)),
    createdAt: typeof raw.creationDate === "string" ? new Date(raw.creationDate).toISOString() : null,
    expiresAt: Number.isInteger(validTo) && validTo > 0 ? new Date(validTo * 1000).toISOString() : null,
    schedule: null,
    transactions: [],
    cancellable: status === "open",
  };
}

function isUid(value: string): boolean {
  return /^0x[0-9a-fA-F]{112}$/u.test(value);
}

async function readOrder(ref: NativeOrderRef, owner: string): Promise<NativeOrder> {
  if (!isUid(ref.nativeId)) throw new PlatformError("ORDER_NOT_FOUND", "A CoW order id ends with its 56-byte order uid.", 404);
  let raw: unknown;
  try {
    raw = await cowJson(ref.network, `orders/${ref.nativeId}`);
  } catch (error) {
    if ((error as { status?: number }).status === 422) throw new PlatformError("ORDER_NOT_FOUND", "CoW Protocol has no order with this uid.", 404);
    throw error;
  }
  if (!isRecord(raw) || !isEvmAddress(raw.owner) || !isAddressEqual(raw.owner as Hex, owner as Hex)) {
    throw new PlatformError("ORDER_NOT_FOUND", "No CoW order of this owner has this uid.", 404);
  }
  return mapCowOrder(ref.network, raw);
}

/* ------------------------------------------------------------- provider */

function limitOrder(request: NativeOrderRequest, owner: string, now: number): CowOrder {
  const kind = request.plan.amountIn === "buy" ? "buy" : "sell";
  return {
    sellToken: sellToken(request),
    buyToken: buyToken(request),
    receiver: owner,
    sellAmount: request.sellAmount.toString(),
    buyAmount: (request.buyAmount as bigint).toString(),
    validTo: request.plan.expiresAt ?? now + DEFAULT_VALIDITY_SECONDS,
    appData: cowAppData("limit").hash,
    feeAmount: "0",
    kind,
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };
}

async function approvalStep(net: EvmNetworkKey & OrderNetwork, owner: string, token: string, amount: bigint, symbol: string, safe: boolean): Promise<OrderSignRequest | null> {
  const allowance = await readAllowance(net, token, owner, GPV2_VAULT_RELAYER);
  if (allowance >= amount) return null;
  const common = { network: net, chainId: evmChainId(net), to: token, data: approveCalldata(amount), value: "0" as const, description: `Approve the CoW GPv2VaultRelayer to spend exactly the ${symbol} this order sells` };
  return safe ? { kind: "safe-transaction", safe: owner, operation: 0, ...common } : { kind: "evm-transaction", ...common };
}

function partsOf(request: NativeOrderRequest): { n: bigint; t: number; part: bigint } {
  const n = BigInt(request.plan.count as number);
  return { n, t: request.plan.periodSeconds as number, part: request.sellAmount / n };
}

async function twapLimit(request: NativeOrderRequest, owner: string, part: bigint, warnings: string[]): Promise<bigint> {
  if (request.plan.price !== null) return priceUnits(part, request.sell.decimals, request.plan.price, request.buy.decimals, "up");
  const quote = await tryQuote(request.plan.network, { from: owner, sellToken: sellToken(request), buyToken: buyToken(request), kind: "sell", amount: part }, warnings);
  if (!quote) throw twapUnsupported("No CoW quote is available to protect the TWAP parts; add a price (least bought per one sold).", "price-required");
  return (quote.buyAmount * (10_000n - TWAP_PRICE_PROTECTION_BPS)) / 10_000n;
}

export const cowProvider: NativeOrderProvider = {
  protocol: "cow-protocol",
  networks: ["ethereum", "arbitrum", "base"],
  mechanisms: ["limit", "twap"],

  async quote(request): Promise<NativeOrderQuote> {
    const net = network(request.plan.network);
    const owner = ownerOf(request.owner);
    const warnings: string[] = [];
    const base = { protocol: "cow-protocol" as const, network: net, custody: CUSTODY, fees: "No fee is paid upfront: solvers take network and protocol fees from the surplus at settlement. An approval, when needed, costs gas." };
    if (request.plan.mechanism === "twap") {
      const { n, t, part } = partsOf(request);
      const limit = await twapLimit(request, owner, part, warnings);
      if (request.sellAmount % n !== 0n) warnings.push(`The amount does not split evenly; ${fromBaseUnits(request.sellAmount % n, request.sell.decimals)} ${request.sell.symbol} stays unsold.`);
      warnings.push("TWAP orders are created by a Safe; preparing checks the Safe's CoW setup.");
      return {
        ...base,
        mechanism: "twap",
        sell: orderAmount(request.sell, part * n),
        buy: orderAmount(request.buy, limit * n),
        market: null,
        limitVsMarketPct: null,
        schedule: { parts: Number(n), periodSeconds: t, perPart: orderAmount(request.sell, part), endsAt: new Date(Date.now() + Number(n) * t * 1000).toISOString() },
        expiresAt: null,
        warnings,
      };
    }
    const kind = request.plan.amountIn === "buy" ? "buy" : "sell";
    const quote = await tryQuote(net, { from: owner, sellToken: sellToken(request), buyToken: buyToken(request), kind, amount: kind === "sell" ? request.sellAmount : (request.buyAmount as bigint) }, warnings);
    const market = quote === null ? null : kind === "sell" ? quote.buyAmount : quote.sellAmount + quote.feeAmount;
    const ours = kind === "sell" ? (request.buyAmount as bigint) : request.sellAmount;
    const pct = betterThanMarket(kind, ours, market);
    if (pct !== null && pct <= 0) warnings.push("The limit is at or past the market price: the order may fill as soon as it is placed.");
    return {
      ...base,
      mechanism: "limit",
      sell: orderAmount(request.sell, request.sellAmount),
      buy: orderAmount(request.buy, request.buyAmount as bigint),
      market: market === null ? null : kind === "sell" ? orderAmount(request.buy, market) : orderAmount(request.sell, market),
      limitVsMarketPct: pct,
      schedule: null,
      expiresAt: new Date((request.plan.expiresAt ?? Math.floor(Date.now() / 1000) + DEFAULT_VALIDITY_SECONDS) * 1000).toISOString(),
      warnings,
    };
  },

  async prepare(request): Promise<PreparedOrderDraft> {
    const net = network(request.plan.network);
    const owner = ownerOf(request.owner);
    const chainId = evmChainId(net);
    if (request.plan.mechanism === "twap") return prepareTwap(request, net, owner, chainId);
    const order = limitOrder(request, owner, Math.floor(Date.now() / 1000));
    const ownerIsContract = await hasCode(net, owner);
    const typedData = cowOrderTypedData(order, chainId);
    const digest = cowOrderDigest(order, chainId);
    const uid = cowOrderUid(digest, owner, order.validTo);
    const approval = await approvalStep(net, owner, order.sellToken, request.sellAmount, request.sell.symbol, ownerIsContract);
    const buy = orderAmount(request.buy, request.buyAmount as bigint);
    const sign: OrderSignRequest = {
      kind: "eip712",
      network: net,
      chainId,
      typedData,
      digest,
      description: `Sign the CoW limit order: ${formatAmount(fromBaseUnits(request.sellAmount, request.sell.decimals))} ${request.sell.symbol} for at least ${formatAmount(buy.formatted)} ${buy.symbol}`,
    };
    return {
      protocol: "cow-protocol",
      action: "create",
      network: net,
      owner,
      orderId: `cow-protocol:${net}:${uid}`,
      steps: approval ? [approval, sign] : [sign],
      submit: "kletia",
      ttlSeconds: SIGNING_TTL_SECONDS,
      warnings: approval ? ["Send the approval first and wait for it to confirm; CoW refuses orders without allowance."] : [],
      relay: { kind: "cow-create", order: { ...order, appData: cowAppData("limit").json, appDataHash: order.appData, from: owner }, signingScheme: ownerIsContract ? "eip1271" : "eip712" },
      ownerIsContract,
    };
  },

  async list(owner, net) {
    const reply = await cowJson(network(net), `account/${ownerOf(owner)}/orders?limit=20`);
    if (!Array.isArray(reply)) throw new PlatformError("PROVIDER_UNAVAILABLE", "CoW Protocol returned an unreadable order list.", 502);
    return Promise.all(reply.filter(isRecord).map((raw) => mapCowOrder(net, raw)));
  },

  status: (ref, owner) => readOrder(ref, ownerOf(owner)),

  async cancel(ref, ownerInput): Promise<PreparedOrderDraft> {
    const net = network(ref.network);
    const owner = ownerOf(ownerInput);
    const chainId = evmChainId(net);
    const common = { protocol: "cow-protocol" as const, action: "cancel" as const, network: net, owner, orderId: `cow-protocol:${net}:${ref.nativeId}`, ttlSeconds: SIGNING_TTL_SECONDS, warnings: [] };
    const twap = /^twap-(0x[0-9a-fA-F]{64})$/u.exec(ref.nativeId);
    if (twap) {
      await assertTwapSafe(net, owner);
      const step: OrderSignRequest = { kind: "safe-transaction", network: net, chainId, safe: owner, to: COMPOSABLE_COW, data: removeTwapCalldata(twap[1] as Hex), value: "0", operation: 0, description: "Remove the TWAP order from ComposableCoW (no further parts are signed)" };
      return { ...common, steps: [step], submit: "wallet", relay: { kind: "none" } };
    }
    const order = await readOrder(ref, owner);
    if (!order.cancellable) throw new PlatformError("ORDER_NOT_CANCELLABLE", `The order is ${order.status}; only open orders can be cancelled.`, 409);
    if (await hasCode(net, owner)) {
      const step: OrderSignRequest = { kind: "safe-transaction", network: net, chainId, safe: owner, to: GPV2_SETTLEMENT, data: invalidateOrderCalldata(ref.nativeId), value: "0", operation: 0, description: "Invalidate the order on GPv2Settlement from the owner contract" };
      return { ...common, steps: [step], submit: "wallet", relay: { kind: "none" } };
    }
    const typedData = cowCancellationTypedData([ref.nativeId], chainId);
    const step: OrderSignRequest = { kind: "eip712", network: net, chainId, typedData, digest: typedDataDigest(typedData), description: "Sign the cancellation of the CoW order (no gas)" };
    return { ...common, steps: [step], submit: "kletia", relay: { kind: "cow-cancel", uid: ref.nativeId } };
  },

  async relay(draft, submission): Promise<RelayResult> {
    const signature = submission.signature;
    if (!signature) throw new PlatformError("ORDER_INVALID", "Submit the signature.", 400);
    if (draft.relay.kind === "cow-cancel") {
      await cowJson(draft.network, "orders", { method: "DELETE", body: JSON.stringify({ orderUids: [draft.relay.uid], signature, signingScheme: "eip712" }) });
      return { orderId: draft.orderId, reference: draft.relay.uid, status: "cancelled" };
    }
    if (draft.relay.kind !== "cow-create") throw new PlatformError("ORDER_INVALID", "This preparation is sent by the wallet.", 400);
    const uid = await cowJson(draft.network, "orders", { method: "POST", body: JSON.stringify({ ...draft.relay.order, signingScheme: draft.relay.signingScheme, signature }) });
    const expected = draft.orderId?.split(":")[2];
    if (typeof uid !== "string" || uid.toLowerCase() !== expected?.toLowerCase()) {
      throw new PlatformError("ORDER_RELAY_FAILED", "CoW Protocol stored a different order than the one signed.", 502);
    }
    return { orderId: draft.orderId, reference: uid, status: "submitted" };
  },
};

async function prepareTwap(request: NativeOrderRequest, net: EvmNetworkKey & OrderNetwork, owner: string, chainId: number): Promise<PreparedOrderDraft> {
  await assertTwapSafe(net, owner);
  const warnings: string[] = [];
  const { n, t, part } = partsOf(request);
  const minPartLimit = await twapLimit(request, owner, part, warnings);
  const params = {
    handler: COW_TWAP_HANDLER,
    salt: `0x${randomBytes(32).toString("hex")}` as Hex,
    staticInput: twapStaticInput({
      sellToken: sellToken(request),
      buyToken: buyToken(request),
      receiver: owner,
      partSellAmount: part,
      minPartLimit,
      t0: 0n,
      n,
      t: BigInt(t),
      span: 0n,
      appData: cowAppData("twap").hash,
    }),
  };
  const hash = conditionalOrderHash(params);
  const approval = await approvalStep(net, owner, sellToken(request), part * n, request.sell.symbol, true);
  const create: OrderSignRequest = {
    kind: "safe-transaction",
    network: net,
    chainId,
    safe: owner,
    to: COMPOSABLE_COW,
    data: createTwapCalldata(params),
    value: "0",
    operation: 0,
    description: `Create the TWAP: ${n} parts of ${formatAmount(fromBaseUnits(part, request.sell.decimals))} ${request.sell.symbol}, one every ${t} s, starting when the Safe transaction lands`,
  };
  return {
    protocol: "cow-protocol",
    action: "create",
    network: net,
    owner,
    orderId: `cow-protocol:${net}:twap-${hash}`,
    steps: approval ? [approval, create] : [create],
    submit: "wallet",
    ttlSeconds: SIGNING_TTL_SECONDS,
    warnings: [...warnings, "Execute the steps in the Safe (as one batch or in order). CoW's watch-tower then posts each part when it is due."],
    relay: { kind: "none" },
  };
}
