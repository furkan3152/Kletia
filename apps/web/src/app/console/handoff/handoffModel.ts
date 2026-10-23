/**
 * Hand-offs on the desk (pure, no React): a sentence Kletia read as
 * a perps trade, a native order or an automation opens that view prefilled
 * from `handoff.input`. The person checks the form, quotes and signs there:
 * nothing here quotes, prepares or signs. node --test loads it.
 */
import type { IntentHandoff, PerpsHandoffInput, ValidatedAutomationDraft } from "@kletia/core";
import { ORDER_NETWORK_KEYS, ORDER_PERIODS, type OrderFormState, type OrderNetworkKey, type OrderPeriodName } from "../orders/ordersModel.ts";
import { DEFAULT_TICKET, type PerpsTicket } from "../perps/perpsModel.ts";

/** One line for the task thread: what Kletia read and where it goes. */
export function handoffLine(handoff: Pick<IntentHandoff, "surface" | "summary">): string {
  const where = handoff.surface === "perps" ? "Perps" : handoff.surface === "orders" ? "Orders" : "Automations";
  return `${handoff.summary}. Opened in ${where}: check it there, then sign. Nothing was signed here.`;
}

export interface PerpsPrefill {
  readonly ticket: PerpsTicket;
  /** Close and reduce act on a position: the view points to it instead of filling the ticket. */
  readonly position: { readonly action: "close" | "decrease"; readonly symbol: string; readonly side: "long" | "short"; readonly sizeUsd?: string } | null;
}

/** The Perps ticket (or the position to act on) of a perps hand-off; leverage within the ticket's 1-100 slider. */
export function perpsPrefill(input: PerpsHandoffInput): PerpsPrefill {
  const ticket: PerpsTicket = {
    ...DEFAULT_TICKET,
    symbol: input.market,
    side: input.side,
    venue: input.venue ?? "best",
    collateral: input.collateral ?? "",
    leverage: input.leverage !== undefined ? Math.min(100, Math.max(1, Math.round(input.leverage * 100) / 100)) : DEFAULT_TICKET.leverage,
  };
  const position = input.action === "open" ? null : { action: input.action, symbol: input.market, side: input.side, ...(input.sizeUsd ? { sizeUsd: input.sizeUsd } : {}) };
  return { ticket, position };
}

/**
 * The Orders form of an order hand-off, or null with the reason when the form
 * cannot hold it (the desk then says so instead of changing the order).
 */
export function orderPrefill(
  handoff: Extract<IntentHandoff, { surface: "orders" }>["input"],
  base: OrderFormState,
  now: number,
): { readonly form: OrderFormState } | { readonly problem: string } {
  if (handoff.action === "cancel") return { problem: `Cancel order ${handoff.orderId} from the list below.` };
  const order = handoff.order;
  const network = ORDER_NETWORK_KEYS.find((entry) => entry === handoff.network) as OrderNetworkKey | undefined;
  if (!network) return { problem: `Orders run on ${ORDER_NETWORK_KEYS.join(", ")}.` };
  if (order.kind === "dca" && !(ORDER_PERIODS as readonly string[]).includes(order.period ?? "")) {
    return { problem: `The form schedules parts every ${ORDER_PERIODS.join(", ")}; this order asks for every ${order.period ?? "?"}.` };
  }
  return {
    form: {
      ...base,
      mode: order.kind,
      side: order.amountIn === "buy" ? "buy" : "sell",
      network,
      sell: order.sell,
      buy: order.buy,
      amount: order.amount,
      price: order.price ?? "",
      expiryDays: order.expiresAt ? String(Math.max(1, Math.round((Date.parse(order.expiresAt) - now) / 86_400_000))) : "",
      ...(order.kind === "dca" ? { period: order.period as OrderPeriodName, count: String(order.count ?? "") } : {}),
    },
  };
}

/** The automation draft of an automation hand-off (POST /v1/automations as it stands). */
export function automationPrefill(handoff: Extract<IntentHandoff, { surface: "automations" }>["input"]): ValidatedAutomationDraft {
  return handoff.draft;
}
