/**
 * Native orders end to end: quote, prepare (or cancel) into a stored
 * preparation, list an owner's orders across protocols, and submit: the
 * owner's signed transaction or signature is matched to the stored
 * preparation (fail closed) and only then relayed to the protocol.
 */
import { CHAINS, parseAccountId, isEvmAddress, isSolanaAddress } from "@kletia/core";
import { PlatformError, toPlatformError, type PlatformIssue } from "../errors.js";
import { resolveAsset } from "../engine/assets.js";
import type { EvmNetworkKey } from "../engine/chains/evm.js";
import { verifyTypedDataSignature } from "./evmGuard.js";
import { planAmounts, planNativeOrder, type NativeOrderInput } from "./plan.js";
import { loadPreparation, preparationView, savePreparation, submissionFingerprint, type PreparationView } from "./preparations.js";
import { nativeOrderProviders, parseOrderId, providerFor } from "./registry.js";
import { verifySignedOrderTransaction } from "./solanaGuard.js";
import { ORDER_NETWORKS, type NativeOrder, type NativeOrderPlan, type NativeOrderQuote, type NativeOrderRequest, type OrderNetwork, type RelayResult } from "./types.js";

export const MAX_ORDER_OWNERS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, issues: PlatformIssue[]): PlatformError {
  return new PlatformError("ORDER_INVALID", message, 400, issues);
}

/** An address, or the address of a CAIP-10 account. */
export function ownerAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const account = text.includes(":") ? parseAccountId(text) : null;
  const address = account ? account.address : text;
  return isEvmAddress(address) || isSolanaAddress(address) ? address : null;
}

const INPUT_FIELDS = new Set(["kind", "sell", "buy", "amount", "amountIn", "price", "period", "count", "network", "expiresAt", "owner"]);

/** The JSON body of quote and prepare: the planNativeOrder input plus `owner`. */
export function parseOrderBody(body: unknown): { input: NativeOrderInput; owner: string } {
  if (!isRecord(body)) throw invalid("Send the order as a JSON object.", [{ path: "", message: "Expected an object." }]);
  const unknown = Object.keys(body).filter((key) => !INPUT_FIELDS.has(key));
  if (unknown.length > 0) throw invalid("The order has unknown fields.", unknown.map((path) => ({ path, message: "Unknown field." })));
  const owner = ownerAddress(body.owner);
  if (!owner) throw invalid("owner is the wallet that signs: an EVM address, a Solana address or a CAIP-10 account.", [{ path: "owner", message: "Invalid owner." }]);
  return { input: body as unknown as NativeOrderInput, owner };
}

async function resolveRequest(body: unknown): Promise<NativeOrderRequest> {
  const { input, owner } = parseOrderBody(body);
  const plan = planNativeOrder(input);
  const svm = CHAINS[plan.network].vm === "svm";
  if (svm ? !isSolanaAddress(owner) : !isEvmAddress(owner)) {
    throw invalid(`A ${CHAINS[plan.network].name} order is signed by a ${svm ? "Solana" : "EVM"} wallet.`, [{ path: "owner", message: "Wrong wallet family for the network." }]);
  }
  const [sell, buy] = await Promise.all([resolveAsset(plan.network, plan.sell), resolveAsset(plan.network, plan.buy)]);
  const { sellAmount, buyAmount } = planAmounts(plan, sell.decimals, buy.decimals);
  return { plan, owner, sell, buy, sellAmount, buyAmount };
}

export async function quoteNativeOrder(body: unknown): Promise<{ plan: NativeOrderPlan; quote: NativeOrderQuote }> {
  const request = await resolveRequest(body);
  return { plan: request.plan, quote: await providerFor(request.plan.protocol).quote(request) };
}

export async function prepareNativeOrder(body: unknown): Promise<{ plan: NativeOrderPlan; preparation: PreparationView }> {
  const request = await resolveRequest(body);
  const draft = await providerFor(request.plan.protocol).prepare(request);
  return { plan: request.plan, preparation: preparationView(savePreparation(draft)) };
}

export async function cancelNativeOrder(id: string, body: unknown): Promise<{ preparation: PreparationView }> {
  const ref = parseOrderId(id);
  const owner = isRecord(body) ? ownerAddress(body.owner) : null;
  if (!owner) throw invalid("Send { owner }: the wallet that owns the order.", [{ path: "owner", message: "Invalid owner." }]);
  const draft = await providerFor(ref.protocol).cancel(ref, owner);
  return { preparation: preparationView(savePreparation(draft)) };
}

export interface OrderListFailure {
  readonly protocol: string;
  readonly network: OrderNetwork;
  readonly owner: string;
  readonly code: string;
  readonly message: string;
}

/**
 * Orders of up to four owners on every protocol and network their wallet
 * family reaches (or only `network`). A protocol that cannot be read is
 * reported in `failures`, never as an empty list.
 */
export async function listNativeOrders(owners: readonly string[], network?: OrderNetwork): Promise<{ orders: NativeOrder[]; failures: OrderListFailure[] }> {
  const jobs: { protocol: string; network: OrderNetwork; owner: string; run: () => Promise<readonly NativeOrder[]> }[] = [];
  for (const owner of owners) {
    const svm = isSolanaAddress(owner);
    for (const provider of nativeOrderProviders()) {
      for (const net of provider.networks) {
        if ((network && net !== network) || (CHAINS[net].vm === "svm") !== svm) continue;
        jobs.push({ protocol: provider.protocol, network: net, owner, run: () => provider.list(owner, net) });
      }
    }
  }
  const results = await Promise.allSettled(jobs.map((job) => job.run()));
  const orders: NativeOrder[] = [];
  const failures: OrderListFailure[] = [];
  results.forEach((result, index) => {
    const job = jobs[index]!;
    if (result.status === "fulfilled") orders.push(...result.value);
    else {
      const error = toPlatformError(result.reason);
      failures.push({ protocol: job.protocol, network: job.network, owner: job.owner, code: error.code, message: error.message });
    }
  });
  orders.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return { orders, failures };
}

/** Owners of GET /v1/orders?owner=a,b: addresses or CAIP-10 accounts, at most four. */
export function parseOwners(raw: string | undefined): string[] {
  const values = (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.length > MAX_ORDER_OWNERS) {
    throw invalid(`owner lists 1-${MAX_ORDER_OWNERS} wallets, comma-separated.`, [{ path: "owner", message: "1-4 owners." }]);
  }
  const owners = values.map(ownerAddress);
  const bad = owners.findIndex((owner) => owner === null);
  if (bad >= 0) throw invalid("owner holds EVM or Solana addresses (or CAIP-10 accounts).", [{ path: `owner[${bad}]`, message: "Invalid address." }]);
  return [...new Set(owners as string[])];
}

export function parseOrderNetwork(raw: string | undefined): OrderNetwork | undefined {
  if (raw === undefined || raw === "") return undefined;
  const network = ORDER_NETWORKS.find((entry) => entry === raw.toLowerCase());
  if (!network) throw invalid(`network is one of ${ORDER_NETWORKS.join(", ")}.`, [{ path: "network", message: "Unknown order network." }]);
  return network;
}

export interface SubmittedOrder {
  readonly id: string | null;
  readonly preparationId: string;
  readonly protocol: string;
  readonly network: OrderNetwork;
  readonly action: "create" | "cancel";
  readonly status: RelayResult["status"];
  readonly reference: string;
}

/**
 * Relays the owner's signature for a preparation. The signed transaction
 * must carry the prepared message byte for byte (sha256) and the owner's
 * valid signature; a typed-data signature must be the owner's over the
 * stored digest. A repeat of the relayed submission returns the same result.
 */
export async function submitNativeOrder(body: unknown): Promise<{ order: SubmittedOrder; replayed: boolean }> {
  if (!isRecord(body) || typeof body.preparationId !== "string") {
    throw invalid("Send { preparationId, signedTransaction } (Solana) or { preparationId, signature } (EIP-712).", [{ path: "preparationId", message: "Required." }]);
  }
  const entry = loadPreparation(body.preparationId);
  const { draft } = entry;
  const last = draft.steps[draft.steps.length - 1];
  if (draft.submit !== "kletia" || !last || (last.kind !== "solana-transaction" && last.kind !== "eip712")) {
    throw invalid("This preparation is executed by the wallet or Safe; there is nothing to submit.", [{ path: "preparationId", message: "Not submitted through Kletia." }]);
  }
  const field = last.kind === "solana-transaction" ? "signedTransaction" : "signature";
  const payload = body[field];
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 8_192) throw invalid(`Send ${field}.`, [{ path: field, message: "Required." }]);
  const fingerprint = submissionFingerprint(payload);
  const view = (result: RelayResult): SubmittedOrder => ({ id: result.orderId, preparationId: entry.id, protocol: draft.protocol, network: draft.network, action: draft.action, status: result.status, reference: result.reference });
  if (entry.state === "done" && entry.result) {
    if (entry.fingerprint === fingerprint) return { order: view(entry.result), replayed: true };
    throw new PlatformError("ORDER_PREPARATION_USED", "This preparation was already submitted with another signature.", 409);
  }
  if (entry.state === "relaying") throw new PlatformError("ORDER_PREPARATION_USED", "This preparation is being relayed right now.", 409);

  let expectedSignature: string | null = null;
  if (last.kind === "solana-transaction") expectedSignature = await verifySignedOrderTransaction(payload, draft.owner, last.messageHash);
  else await verifyTypedDataSignature(draft.network as EvmNetworkKey, last.typedData, last.digest, draft.owner, payload, draft.ownerIsContract ?? false);

  entry.state = "relaying";
  try {
    const result = await providerFor(draft.protocol).relay(draft, field === "signedTransaction" ? { signedTransaction: payload } : { signature: payload });
    if (expectedSignature !== null && result.reference !== expectedSignature) {
      throw new PlatformError("ORDER_RELAY_FAILED", "The protocol reported a different transaction than the one signed.", 502);
    }
    entry.state = "done";
    entry.result = result;
    entry.fingerprint = fingerprint;
    return { order: view(result), replayed: false };
  } catch (error) {
    entry.state = "ready";
    throw error;
  }
}

export async function orderStatus(id: string, owner: unknown): Promise<NativeOrder> {
  const ref = parseOrderId(id);
  const address = ownerAddress(owner);
  if (!address) throw invalid("owner is the wallet that owns the order.", [{ path: "owner", message: "Invalid owner." }]);
  return providerFor(ref.protocol).status(ref, address);
}
