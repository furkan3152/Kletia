/**
 * The eval shape of a hand-off (corpus accept `H:<regex>`), one line:
 *
 *   perps:open long ETH 100 USDC 5x
 *   perps:open short BTC $500 50 USDC 10x @hyperliquid
 *   order:limit sell 1 WETH for USDC at 4000 on base [cow-protocol]
 *   order:dca sell 500 USDC for SOL every day x10 on solana [jupiter-recurring]
 *   order:cancel jupiter-trigger:solana:<id>
 *   automation:every 1 week mon max - => buy $50 of ETH on base
 *   automation:price SOL@solana below 120 => sell half of my SOL on solana
 *   automation:apy USDC base,arbitrum => rebalance 100
 *   predictions:search "trump out as president"
 *   predictions:buy Yes $20 #666861
 *   predictions:sell Yes "trump"
 */
import { parseAccountId, type IntentHandoff } from "@kletia/core";

function perpsShape(input: Extract<IntentHandoff, { surface: "perps" }>["input"]): string {
  return [
    `perps:${input.action} ${input.side} ${input.market}`,
    ...(input.sizeUsd ? [`$${input.sizeUsd}`] : []),
    ...(input.collateral ? [`${input.collateral} USDC`] : []),
    ...(input.leverage !== undefined ? [`${Number(input.leverage.toFixed(2))}x`] : []),
    ...(input.venue ? [`@${input.venue}`] : []),
  ].join(" ");
}

function orderShape(input: Extract<IntentHandoff, { surface: "orders" }>["input"]): string {
  if (input.action === "cancel") return `order:cancel ${input.orderId}`;
  const order = input.order;
  const side = order.amountIn === "buy" ? `buy ${order.amount} ${order.buy} with ${order.sell}` : `sell ${order.amount} ${order.sell} for ${order.buy}`;
  const terms = order.kind === "limit" ? ` at ${order.price ?? "?"}` : ` every ${order.period ?? "?"} x${order.count ?? "?"}`;
  return `order:${order.kind} ${side}${terms} on ${input.network} [${input.protocol}]`;
}

function automationShape(input: Extract<IntentHandoff, { surface: "automations" }>["input"]): string {
  const { trigger, action } = input.draft;
  const network = (account: string) => parseAccountId(account)?.chain.key ?? "?";
  const when = trigger.kind === "schedule"
    ? `every ${trigger.every.count} ${trigger.every.unit} ${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(trigger.startAt).getUTCDay()]} max ${trigger.maxRuns ?? "-"}`
    : trigger.kind === "price" ? `price ${trigger.asset}@${trigger.network} ${trigger.direction} ${trigger.priceUsd}`
    : trigger.kind === "balance" ? `balance ${trigger.asset}@${network(trigger.account)} ${trigger.direction} ${trigger.amount}`
    : trigger.kind === "apy" ? `apy ${trigger.asset} ${trigger.networks.join(",")}`
    : `incoming ${trigger.asset}@${network(trigger.account)}`;
  const run = action.kind === "rebalance" ? `rebalance ${action.amount ?? "-"}` : action.text ?? "actions";
  return `automation:${when} => ${run}`;
}

function predictionsShape(input: Extract<IntentHandoff, { surface: "predictions" }>["input"]): string {
  if (input.action === "search") return `predictions:search "${input.query}"`;
  if (input.action === "sell") return `predictions:sell ${input.shares ? `${input.shares} ` : ""}${input.outcome ? `${input.outcome} ` : ""}"${input.query}"`;
  return `predictions:buy ${input.outcome} $${input.amountUsd} #${input.marketId}`;
}

export function handoffShape(handoff: IntentHandoff): string {
  switch (handoff.surface) {
    case "perps":
      return perpsShape(handoff.input);
    case "orders":
      return orderShape(handoff.input);
    case "predictions":
      return predictionsShape(handoff.input);
    default:
      return automationShape(handoff.input);
  }
}
