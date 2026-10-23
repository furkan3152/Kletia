/**
 * /v1/orders through the shared Kletia client: quote, prepare, submit the
 * wallet's signature, list an owner's orders, and prepare a cancel.
 */
import type { KletiaClient } from "@kletia/sdk";

import { sdkSignal } from "../../../shared/platform/kletiaClient";
import type { NativeOrderView, OrderAmountView, OrderListFailureView, OrderPreparationView } from "./ordersModel";

export interface OrderQuoteView {
  readonly protocol: string;
  readonly mechanism: string;
  readonly network: string;
  readonly sell: OrderAmountView;
  readonly buy: OrderAmountView | null;
  readonly market: OrderAmountView | null;
  readonly limitVsMarketPct: number | null;
  readonly schedule: { readonly parts: number; readonly periodSeconds: number; readonly perPart: OrderAmountView; readonly endsAt: string } | null;
  readonly expiresAt: string | null;
  readonly fees: string;
  readonly custody: string;
  readonly warnings: readonly string[];
}

export interface SubmittedOrderView {
  readonly id: string | null;
  readonly status: "submitted" | "cancelled";
  readonly reference: string;
}

export async function quoteOrder(client: KletiaClient, body: Record<string, unknown>, signal?: AbortSignal): Promise<OrderQuoteView> {
  const reply = await client.request<{ quote: OrderQuoteView }>("POST", "/orders/quote", body, { signal: sdkSignal(signal) });
  return reply.quote;
}

export async function prepareOrder(client: KletiaClient, body: Record<string, unknown>): Promise<OrderPreparationView> {
  const reply = await client.request<{ preparation: OrderPreparationView }>("POST", "/orders/prepare", body);
  return reply.preparation;
}

export async function cancelOrder(client: KletiaClient, id: string, owner: string): Promise<OrderPreparationView> {
  const reply = await client.request<{ preparation: OrderPreparationView }>("POST", `/orders/${encodeURIComponent(id)}/cancel`, { owner });
  return reply.preparation;
}

export async function submitOrder(client: KletiaClient, preparationId: string, signed: { readonly signedTransaction: string } | { readonly signature: string }): Promise<SubmittedOrderView> {
  const reply = await client.request<{ order: SubmittedOrderView }>("POST", "/orders/submit", { preparationId, ...signed }, { idempotencyKey: false });
  return reply.order;
}

export async function listOrders(client: KletiaClient, owners: readonly string[], signal?: AbortSignal): Promise<{ orders: NativeOrderView[]; failures: OrderListFailureView[] }> {
  const reply = await client.request<{ orders: NativeOrderView[]; failures: OrderListFailureView[] }>("GET", "/orders", undefined, {
    signal: sdkSignal(signal),
    query: { owner: owners.join(",") },
  });
  return { orders: Array.isArray(reply?.orders) ? reply.orders : [], failures: Array.isArray(reply?.failures) ? reply.failures : [] };
}
