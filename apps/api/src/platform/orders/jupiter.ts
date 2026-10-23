/**
 * Jupiter native orders on Solana: limit orders through the Trigger API V1
 * and time-based DCA through the Recurring API V1 (OpenAPI specs:
 * developers.jup.ag/docs/openapi-spec/trigger/trigger.yaml and
 * .../recurring/recurring.yaml). Jupiter builds an unsigned transaction for
 * the owner; Kletia checks it (fee payer and sole signer, programs, compute
 * budget), and after the owner signs relays exactly that transaction through
 * the documented `/execute` endpoint. Requests carry JUPITER_API_KEY when set
 * and go through the shared provider fetch (timeouts, bounded bodies, 429
 * retries reported as PROVIDER_RATE_LIMITED), like the swap client.
 *
 * Jupiter now develops a vault-based Trigger V2 (custodial Privy vaults, JWT
 * sign-in); V1 keeps the order in an on-chain account of Jupiter's program
 * that only a keeper fill or the owner's cancel can move, so V1 is used.
 */
import { formatAmount, fromBaseUnits, isSolanaAddress, isSolanaSignature } from "@kletia/core";
import { JUPITER_API_KEY, JUPITER_API_URL, quoteJupiterSwap } from "../../networks/solana/index.js";
import { fetchProviderJson, isRecord } from "../../networks/solana/http.js";
import { PlatformError } from "../errors.js";
import { jupiterMint } from "../engine/assets.js";
import { orderAmount, refAmount, tokenRef } from "./amounts.js";
import { checkOrderTransaction } from "./solanaGuard.js";
import type {
  NativeOrder,
  NativeOrderProvider,
  NativeOrderQuote,
  NativeOrderRef,
  NativeOrderRequest,
  NativeOrderStatus,
  OrderSubmission,
  PreparedOrderDraft,
  RelayResult,
} from "./types.js";

/** Jupiter Limit Order V2 program: the `programVersion` the Trigger API V1 reports for its orders. */
export const JUPITER_TRIGGER_PROGRAM = "j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X";
/** Jupiter DCA program behind the Recurring API V1 (dev.jup.ag/docs/old/dca/integration). */
export const JUPITER_RECURRING_PROGRAM = "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M";

/** A prepared Jupiter transaction lands within its blockhash lifetime or never. */
const JUPITER_TTL_SECONDS = 90;
/** Recurring order lists embed every fill; a busy order is several hundred KB. */
const LIST_MAX_BYTES = 4_000_000;
const CUSTODY = "The sell amount moves from your wallet into an order account of Jupiter's program. Only a keeper fill at your terms or your own cancel can move it; Kletia never holds it.";

type JupiterApi = "trigger" | "recurring";

function headers(): Record<string, string> {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}

function endpoint(api: JupiterApi, path: string): string {
  return `${JUPITER_API_URL}/${api}/v1/${path}`;
}

async function post(api: JupiterApi, path: string, body: unknown): Promise<Record<string, unknown>> {
  const reply = await fetchProviderJson<unknown>(endpoint(api, path), {
    provider: "Jupiter",
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!isRecord(reply)) throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Jupiter returned an unreadable order response.", 502);
  return reply;
}

function unsignedTransaction(reply: Record<string, unknown>): { requestId: string; transaction: string } {
  const { requestId, transaction } = reply;
  if (typeof requestId !== "string" || !/^[\w-]{8,100}$/u.test(requestId) || typeof transaction !== "string") {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Jupiter returned an order response without a transaction.", 502);
  }
  return { requestId, transaction };
}

/* ------------------------------------------------------------ requests */

export async function createTriggerOrder(input: {
  readonly maker: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly makingAmount: bigint;
  readonly takingAmount: bigint;
  readonly expiredAt: number | null;
}): Promise<{ requestId: string; transaction: string; order: string }> {
  const reply = await post("trigger", "createOrder", {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    maker: input.maker,
    payer: input.maker,
    params: {
      makingAmount: input.makingAmount.toString(),
      takingAmount: input.takingAmount.toString(),
      ...(input.expiredAt !== null ? { expiredAt: String(input.expiredAt) } : {}),
    },
    computeUnitPrice: "auto",
    wrapAndUnwrapSol: true,
  });
  const order = reply.order;
  if (typeof order !== "string" || !isSolanaAddress(order)) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Jupiter returned a trigger order without its order account.", 502);
  }
  return { ...unsignedTransaction(reply), order };
}

export async function createRecurringOrder(input: {
  readonly user: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  readonly numberOfOrders: number;
  readonly interval: number;
}): Promise<{ requestId: string; transaction: string }> {
  if (input.inAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PlatformError("ORDER_INVALID", "The Recurring API takes amounts up to 2^53 base units.", 400, [{ path: "amount", message: "Too large for Jupiter Recurring." }]);
  }
  const reply = await post("recurring", "createOrder", {
    user: input.user,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    params: { time: { inAmount: Number(input.inAmount), numberOfOrders: input.numberOfOrders, interval: input.interval, minPrice: null, maxPrice: null, startAt: null } },
  });
  return unsignedTransaction(reply);
}

export async function cancelJupiterOrder(api: JupiterApi, owner: string, order: string): Promise<{ requestId: string; transaction: string }> {
  const body = api === "trigger" ? { maker: owner, order, computeUnitPrice: "auto" } : { user: owner, order, recurringType: "time" };
  return unsignedTransaction(await post(api, "cancelOrder", body));
}

/** Relays the owner-signed transaction through `/execute`; a failed execution is ORDER_RELAY_FAILED. */
export async function executeJupiterOrder(api: JupiterApi, requestId: string, signedTransaction: string): Promise<{ signature: string; order: string | null }> {
  const reply = await post(api, "execute", { requestId, signedTransaction });
  const signature = reply.signature;
  if (reply.status !== "Success" || typeof signature !== "string" || !isSolanaSignature(signature)) {
    const reason = typeof reply.error === "string" ? reply.error.slice(0, 200) : "the transaction did not land";
    throw new PlatformError("ORDER_RELAY_FAILED", `Jupiter did not execute the order: ${reason}.`, 502);
  }
  const order = typeof reply.order === "string" && isSolanaAddress(reply.order) ? reply.order : null;
  return { signature, order };
}

async function listJupiter(api: JupiterApi, owner: string, status: "active" | "history"): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({ user: owner, orderStatus: status, page: "1", includeFailedTx: "false" });
  if (api === "recurring") params.set("recurringType", "time");
  const reply = await fetchProviderJson<unknown>(endpoint(api, `get${api === "trigger" ? "Trigger" : "Recurring"}Orders?${params}`), {
    provider: "Jupiter",
    headers: headers(),
    maxBytes: LIST_MAX_BYTES,
  });
  const items = isRecord(reply) ? (api === "trigger" ? reply.orders : reply.time) : null;
  if (!Array.isArray(items)) throw new PlatformError("PROVIDER_UNAVAILABLE", "Jupiter returned an unreadable order list.", 502);
  return items.filter(isRecord);
}

/* ------------------------------------------------------------- mapping */

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function units(value: unknown): bigint {
  return typeof value === "string" && /^\d{1,40}$/u.test(value) ? BigInt(value) : 0n;
}

function isoOrNull(value: unknown): string | null {
  const parsed = typeof value === "string" && value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function signatures(...values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string" && isSolanaSignature(value.trim())).map((value) => value.trim());
}

const TRIGGER_STATUS: Readonly<Record<string, NativeOrderStatus>> = { Open: "open", Completed: "filled", Cancelled: "cancelled", Expired: "expired" };

/** A Trigger API order (getTriggerOrders) as a native order; unknown statuses stay `unknown`. */
export function mapTriggerOrder(raw: Record<string, unknown>): NativeOrder {
  const inputMint = text(raw.inputMint);
  const outputMint = text(raw.outputMint);
  const input = tokenRef("solana", inputMint, { raw: text(raw.rawMakingAmount), human: text(raw.makingAmount) });
  const output = tokenRef("solana", outputMint, { raw: text(raw.rawTakingAmount), human: text(raw.takingAmount) });
  const trades = Array.isArray(raw.trades) ? raw.trades.filter(isRecord) : [];
  const bought = trades.reduce((sum, trade) => sum + units(trade.rawOutputAmount), 0n);
  const status = TRIGGER_STATUS[text(raw.status)] ?? "unknown";
  return {
    id: `jupiter-trigger:solana:${text(raw.orderKey)}`,
    protocol: "jupiter-trigger",
    mechanism: "limit",
    network: "solana",
    owner: text(raw.userPubkey),
    status,
    sell: refAmount(input, units(raw.rawMakingAmount)),
    buy: refAmount(output, units(raw.rawTakingAmount)),
    sold: refAmount(input, units(raw.rawMakingAmount) - units(raw.rawRemainingMakingAmount)),
    bought: refAmount(output, bought),
    createdAt: isoOrNull(raw.createdAt),
    expiresAt: isoOrNull(raw.expiredAt),
    schedule: null,
    transactions: signatures(raw.openTx, ...trades.map((trade) => trade.txId), raw.closeTx),
    cancellable: status === "open",
  };
}

/** A Recurring API time order (getRecurringOrders) as a native order. */
export function mapRecurringOrder(raw: Record<string, unknown>, active: boolean): NativeOrder {
  const input = tokenRef("solana", text(raw.inputMint), { raw: text(raw.rawInDeposited), human: text(raw.inDeposited) });
  const output = tokenRef("solana", text(raw.outputMint), { raw: text(raw.rawOutReceived), human: text(raw.outReceived) });
  const deposited = units(raw.rawInDeposited);
  const used = units(raw.rawInUsed);
  const status: NativeOrderStatus = active ? "open" : raw.userClosed === true ? "cancelled" : used >= deposited ? "filled" : "unknown";
  const period = Number(text(raw.cycleFrequency));
  const trades = Array.isArray(raw.trades) ? raw.trades.filter(isRecord) : [];
  return {
    id: `jupiter-recurring:solana:${text(raw.orderKey)}`,
    protocol: "jupiter-recurring",
    mechanism: "recurring",
    network: "solana",
    owner: text(raw.userPubkey),
    status,
    sell: refAmount(input, deposited),
    buy: null,
    sold: refAmount(input, used),
    bought: refAmount(output, units(raw.rawOutReceived)),
    createdAt: isoOrNull(raw.createdAt),
    expiresAt: null,
    schedule: Number.isInteger(period) && period > 0 ? { perPart: refAmount(input, units(raw.rawInAmountPerCycle)), periodSeconds: period } : null,
    transactions: signatures(raw.openTx, ...trades.slice(0, 20).map((trade) => trade.txId), raw.closeTx),
    cancellable: active,
  };
}

/* ------------------------------------------------------------ providers */

async function marketOut(request: NativeOrderRequest, amount: bigint, warnings: string[]): Promise<bigint | null> {
  try {
    const quote = await quoteJupiterSwap({ inputMint: jupiterMint(request.sell), outputMint: jupiterMint(request.buy), amount: amount.toString() });
    return BigInt(quote.outAmount);
  } catch {
    warnings.push("No Jupiter market quote is available for this pair right now.");
    return null;
  }
}

function vsMarket(limit: bigint, market: bigint | null): number | null {
  if (market === null || market === 0n) return null;
  return Math.round((Number((limit * 1_000_000n) / market) / 10_000 - 100) * 100) / 100;
}

function ownerOf(request: NativeOrderRequest): string {
  if (!isSolanaAddress(request.owner)) throw new PlatformError("ORDER_INVALID", "owner must be a Solana address for a Jupiter order.", 400, [{ path: "owner", message: "A base58 Solana address." }]);
  return request.owner;
}

async function findOrder(api: JupiterApi, ref: NativeOrderRef, owner: string): Promise<NativeOrder> {
  for (const status of ["active", "history"] as const) {
    const match = (await listJupiter(api, owner, status)).find((raw) => raw.orderKey === ref.nativeId);
    if (match) return api === "trigger" ? mapTriggerOrder(match) : mapRecurringOrder(match, status === "active");
  }
  throw new PlatformError("ORDER_NOT_FOUND", "No open or recent Jupiter order of this owner has this id.", 404);
}

async function listBoth(api: JupiterApi, owner: string): Promise<NativeOrder[]> {
  const [active, history] = await Promise.all([listJupiter(api, owner, "active"), listJupiter(api, owner, "history")]);
  return api === "trigger"
    ? [...active, ...history].map(mapTriggerOrder)
    : [...active.map((raw) => mapRecurringOrder(raw, true)), ...history.map((raw) => mapRecurringOrder(raw, false))];
}

async function cancelDraft(api: JupiterApi, ref: NativeOrderRef, owner: string): Promise<PreparedOrderDraft> {
  const order = await findOrder(api, ref, owner);
  if (!order.cancellable) throw new PlatformError("ORDER_NOT_CANCELLABLE", `The order is ${order.status}; only open orders can be cancelled.`, 409);
  const built = await cancelJupiterOrder(api, owner, ref.nativeId);
  const messageHash = checkOrderTransaction(built.transaction, owner, api === "trigger" ? JUPITER_TRIGGER_PROGRAM : JUPITER_RECURRING_PROGRAM);
  return {
    protocol: order.protocol,
    action: "cancel",
    network: "solana",
    owner,
    orderId: order.id,
    steps: [{ kind: "solana-transaction", network: "solana", transaction: built.transaction, encoding: "base64", messageHash, description: `Cancel the Jupiter order and return the unfilled ${order.sell.symbol} to your wallet` }],
    submit: "kletia",
    ttlSeconds: JUPITER_TTL_SECONDS,
    warnings: [],
    relay: { kind: "jupiter-execute", api, requestId: built.requestId },
  };
}

async function relayJupiter(draft: PreparedOrderDraft, submission: OrderSubmission): Promise<RelayResult> {
  if (draft.relay.kind !== "jupiter-execute" || !submission.signedTransaction) throw new PlatformError("ORDER_INVALID", "Submit the signed transaction.", 400);
  const result = await executeJupiterOrder(draft.relay.api, draft.relay.requestId, submission.signedTransaction);
  const orderId = draft.orderId ?? (result.order ? `${draft.protocol}:solana:${result.order}` : null);
  return { orderId, reference: result.signature, status: draft.action === "cancel" ? "cancelled" : "submitted" };
}

function title(request: NativeOrderRequest): string {
  return `${formatAmount(fromBaseUnits(request.sellAmount, request.sell.decimals))} ${request.sell.symbol}`;
}

export const jupiterTriggerProvider: NativeOrderProvider = {
  protocol: "jupiter-trigger",
  networks: ["solana"],
  mechanisms: ["limit"],

  async quote(request): Promise<NativeOrderQuote> {
    const warnings: string[] = [];
    const buyAmount = request.buyAmount as bigint;
    const market = await marketOut(request, request.sellAmount, warnings);
    if (market !== null && buyAmount <= market) warnings.push("The limit is at or below the market: the order may fill as soon as it is placed.");
    return {
      protocol: "jupiter-trigger",
      mechanism: "limit",
      network: "solana",
      sell: orderAmount(request.sell, request.sellAmount),
      buy: orderAmount(request.buy, buyAmount),
      market: market === null ? null : orderAmount(request.buy, market),
      limitVsMarketPct: vsMarket(buyAmount, market),
      schedule: null,
      expiresAt: request.plan.expiresAt === null ? null : new Date(request.plan.expiresAt * 1000).toISOString(),
      fees: "Jupiter takes its limit-order fee from each fill; the network fee to place and cancel is paid by your wallet.",
      custody: CUSTODY,
      warnings,
    };
  },

  async prepare(request): Promise<PreparedOrderDraft> {
    const owner = ownerOf(request);
    const built = await createTriggerOrder({
      maker: owner,
      inputMint: jupiterMint(request.sell),
      outputMint: jupiterMint(request.buy),
      makingAmount: request.sellAmount,
      takingAmount: request.buyAmount as bigint,
      expiredAt: request.plan.expiresAt,
    });
    const messageHash = checkOrderTransaction(built.transaction, owner, JUPITER_TRIGGER_PROGRAM);
    const buy = orderAmount(request.buy, request.buyAmount as bigint);
    return {
      protocol: "jupiter-trigger",
      action: "create",
      network: "solana",
      owner,
      orderId: `jupiter-trigger:solana:${built.order}`,
      steps: [{ kind: "solana-transaction", network: "solana", transaction: built.transaction, encoding: "base64", messageHash, description: `Place a limit order: ${title(request)} for at least ${formatAmount(buy.formatted)} ${buy.symbol}` }],
      submit: "kletia",
      ttlSeconds: JUPITER_TTL_SECONDS,
      warnings: [],
      relay: { kind: "jupiter-execute", api: "trigger", requestId: built.requestId },
    };
  },

  list: (owner) => listBoth("trigger", owner),
  status: (ref, owner) => findOrder("trigger", ref, owner),
  cancel: (ref, owner) => cancelDraft("trigger", ref, owner),
  relay: relayJupiter,
};

export const jupiterRecurringProvider: NativeOrderProvider = {
  protocol: "jupiter-recurring",
  networks: ["solana"],
  mechanisms: ["recurring"],

  async quote(request): Promise<NativeOrderQuote> {
    const warnings: string[] = [];
    const { count, periodSeconds } = schedule(request);
    const perPart = request.sellAmount / BigInt(count);
    const market = await marketOut(request, perPart, warnings);
    if (request.sellAmount % BigInt(count) !== 0n) warnings.push("The amount does not split evenly; Jupiter adds the remainder to the parts.");
    return {
      protocol: "jupiter-recurring",
      mechanism: "recurring",
      network: "solana",
      sell: orderAmount(request.sell, request.sellAmount),
      buy: null,
      market: market === null ? null : orderAmount(request.buy, market),
      limitVsMarketPct: null,
      schedule: { parts: count, periodSeconds, perPart: orderAmount(request.sell, perPart), endsAt: new Date(Date.now() + count * periodSeconds * 1000).toISOString() },
      expiresAt: null,
      fees: "Jupiter takes 0.1% of each part; the network fee to place and cancel is paid by your wallet.",
      custody: CUSTODY,
      warnings: [...warnings, "Each part buys at the market price of its moment (no price floor)."],
    };
  },

  async prepare(request): Promise<PreparedOrderDraft> {
    const owner = ownerOf(request);
    const { count, periodSeconds } = schedule(request);
    const built = await createRecurringOrder({
      user: owner,
      inputMint: jupiterMint(request.sell),
      outputMint: jupiterMint(request.buy),
      inAmount: request.sellAmount,
      numberOfOrders: count,
      interval: periodSeconds,
    });
    const messageHash = checkOrderTransaction(built.transaction, owner, JUPITER_RECURRING_PROGRAM);
    return {
      protocol: "jupiter-recurring",
      action: "create",
      network: "solana",
      owner,
      // The order account is known once Jupiter executes the creation.
      orderId: null,
      steps: [{ kind: "solana-transaction", network: "solana", transaction: built.transaction, encoding: "base64", messageHash, description: `Start a DCA: ${title(request)} into ${request.buy.symbol} in ${count} parts` }],
      submit: "kletia",
      ttlSeconds: JUPITER_TTL_SECONDS,
      warnings: [],
      relay: { kind: "jupiter-execute", api: "recurring", requestId: built.requestId },
    };
  },

  list: (owner) => listBoth("recurring", owner),
  status: (ref, owner) => findOrder("recurring", ref, owner),
  cancel: (ref, owner) => cancelDraft("recurring", ref, owner),
  relay: relayJupiter,
};

function schedule(request: NativeOrderRequest): { count: number; periodSeconds: number } {
  const { count, periodSeconds, price } = request.plan;
  if (price !== null) {
    throw new PlatformError("ORDER_UNSUPPORTED", "Jupiter Recurring orders here run without a price floor; leave out the price.", 422, undefined, undefined, { reason: "dca-price" });
  }
  return { count: count as number, periodSeconds: periodSeconds as number };
}
