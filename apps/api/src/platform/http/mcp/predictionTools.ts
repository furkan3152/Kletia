/**
 * MCP tools of prediction markets, read-only like every Kletia
 * tool:
 *
 * - `search_prediction_markets`: open Polymarket markets for words, a
 *   category, or the busiest / soonest ending, with each outcome's implied
 *   probability;
 * - `plan_prediction_order`: the quote (max loss, payout, fees) and the
 *   unsigned steps for the user's own wallet. It never submits: the person
 *   signs in their wallet and the desk (or the API's /submit) relays it.
 *
 * With an API key the key's Rule Book chain decides; agent keys need
 * `predictions.enabled`.
 */
import { effectivePredictions, type PredictionMarket, type PredictionPolicyView } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { DEFAULT_PREDICTIONS_POLICY, listPredictionMarkets, preparePrediction } from "../../predictions/service.js";
import { PREDICTION_CATEGORIES } from "../../predictions/polymarket.js";
import { readKeyChain } from "../policies/chain.js";
import type { KletiaTool, ToolAnnotations, ToolCaller } from "./tools.js";

const RISK = "A share pays 1 pUSD if its outcome wins and 0 if it loses: the stake can be lost in full, and prices are odds, not guarantees.";

function annotations(title: string, idempotent: boolean): ToolAnnotations {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true };
}

async function callerPolicy(caller: ToolCaller): Promise<PredictionPolicyView> {
  if (!caller.keyId) return DEFAULT_PREDICTIONS_POLICY;
  const chain = await readKeyChain(caller.keyId);
  if (!chain || !chain.keyActive) throw new PlatformError("PREDICTION_POLICY_DENIED", "This key (or one of its ancestors) is revoked or expired.", 403);
  return effectivePredictions(chain.levels);
}

/** What an agent needs of a market: question, outcomes with implied probability, end, volume, link. */
export function marketSummary(market: PredictionMarket): Record<string, unknown> {
  return {
    id: market.id,
    question: market.question,
    ...(market.groupTitle ? { option: market.groupTitle, event: market.eventTitle } : {}),
    outcomes: market.outcomes.map((outcome) => ({ label: outcome.label, impliedProbability: outcome.price })),
    endDate: market.endDate,
    volume24hUsd: Math.round(market.volume24hUsd),
    url: market.url,
  };
}

export const SEARCH_PREDICTION_MARKETS_TOOL: KletiaTool = {
  name: "search_prediction_markets",
  description: `Open prediction markets on Polymarket (Polygon): by words (q), by category, or the busiest or soonest ending, each outcome with its price as an implied probability (0 to 1). ${RISK} Read-only.`,
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", maxLength: 120, description: "Words of the market, e.g. \"trump out as president\"." },
      category: { type: "string", enum: [...PREDICTION_CATEGORIES] },
      sort: { type: "string", enum: ["volume", "ending"] },
    },
    additionalProperties: false,
  },
  annotations: annotations("Search prediction markets", true),
  async run(args) {
    const view = await listPredictionMarkets({
      q: typeof args.q === "string" ? args.q : null,
      category: typeof args.category === "string" ? args.category : null,
      sort: typeof args.sort === "string" ? args.sort : null,
    });
    return { query: view.query, category: view.category, sort: view.sort, markets: view.markets.slice(0, 12).map(marketSummary), notAdded: view.venues.filter((venue) => !venue.enabled).map((venue) => ({ venue: venue.name, reason: venue.disabledReason })) };
  },
};

export const PLAN_PREDICTION_ORDER_TOOL: KletiaTool = {
  name: "plan_prediction_order",
  description: `Quote and prepare (never submit) a Polymarket order for the user's own wallet on Polygon (their Polymarket Safe or Deposit Wallet with \`wallet\`, from GET /v1/predictions/wallets; or the plain wallet itself): max loss, payout if the outcome wins, fees, and the unsigned steps (exact pUSD approvals, any operator approval with its disclosure, the order-book sign-in, the EIP-712 order). The person signs every step in their wallet; Kletia relays the signed order only through POST /v1/predictions/submit. ${RISK} Agent keys need predictions.enabled in their rule book.`,
  inputSchema: {
    type: "object",
    properties: {
      marketId: { type: "string", pattern: "^\\d{1,20}$", description: "From search_prediction_markets." },
      outcome: { type: "string", maxLength: 80, description: "An outcome label of the market (Yes, No, ...)." },
      side: { type: "string", enum: ["buy", "sell"] },
      amountUsd: { type: "string", pattern: "^\\d{1,7}(\\.\\d{1,2})?$", description: "buy: USD to spend, fees included." },
      shares: { type: "string", pattern: "^\\d{1,9}(\\.\\d{1,2})?$", description: "sell: shares." },
      account: { type: "string", maxLength: 200, description: "eip155:137:0x…: the user's EVM wallet (the signer)." },
      wallet: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "The user's Polymarket wallet (Safe or Deposit Wallet) that holds the funds; omitted, the account trades for itself." },
    },
    required: ["marketId", "outcome", "side", "account"],
    additionalProperties: false,
  },
  annotations: annotations("Plan a prediction order (unsigned)", false),
  async run(args, caller) {
    const prepared = await preparePrediction({ venue: "polymarket", orderType: "market", ...args }, await callerPolicy(caller));
    return {
      quote: prepared.quote,
      wallet: prepared.wallet,
      steps: prepared.steps.map((step) => ({ id: step.id, kind: step.kind, title: step.title, ...(step.kind === "transaction" && step.disclosure ? { disclosure: step.disclosure } : {}) })),
      expiresAt: prepared.expiresAt,
      warnings: prepared.warnings,
      signAt: "The person signs these steps in their own wallet (the Kletia desk's Predict view, or any wallet that signs EIP-712); nothing was submitted.",
    };
  },
};

export const PREDICTION_TOOLS: readonly KletiaTool[] = Object.freeze([SEARCH_PREDICTION_MARKETS_TOOL, PLAN_PREDICTION_ORDER_TOOL]);
