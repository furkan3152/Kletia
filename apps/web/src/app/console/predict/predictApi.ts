/**
 * /v1/predictions through the shared Kletia client, plus Polymarket's own
 * location check, which must come from the person's browser (it answers for
 * the requesting IP). Prepare, session and submit are never retried by the
 * client: a repeated relay could place an order twice.
 */
import type { PolymarketOrderDraft, PredictionBook, PredictionMarket, PredictionPosition, PredictionPrepared, PredictionPricePoint, PredictionQuote, PredictionRequest, PredictionTypedData, PredictionVenue } from "@kletia/core";
import { POLYMARKET_POLYGON } from "@kletia/core";

import { getKletiaClient } from "../../../shared/platform/kletiaClient";

export interface PredictionMarketsResponse {
  readonly venues: readonly PredictionVenue[];
  readonly markets: readonly PredictionMarket[];
  readonly query: string | null;
  readonly category: string | null;
  readonly sort: "volume" | "ending";
  readonly categories: readonly string[];
}

export interface PredictionOutcomeView {
  readonly label: string;
  readonly tokenId: string;
  readonly price: number | null;
  readonly book: PredictionBook | null;
  readonly history: readonly PredictionPricePoint[];
  readonly unavailable: string | null;
}

export interface PredictionMarketResponse {
  readonly market: PredictionMarket;
  readonly outcomes: readonly PredictionOutcomeView[];
  readonly restrictionNote: string;
  readonly termsUrl: string;
}

export interface PredictionPositionsResponse {
  readonly holder: string;
  readonly positions: readonly PredictionPosition[];
  readonly truncated: boolean;
  readonly tradable: boolean;
}

export interface PredictionQuoteResponse {
  readonly request: PredictionRequest;
  readonly market: Pick<PredictionMarket, "id" | "question" | "endDate" | "url" | "negRisk" | "version">;
  readonly quote: PredictionQuote;
}

export interface PredictionSubmitBody {
  readonly venue: "polymarket";
  readonly account: string;
  readonly order: PolymarketOrderDraft;
  readonly ticket: string;
  readonly signature: string;
  readonly session?: string;
  readonly auth?: { readonly timestamp: number; readonly signature: string };
}

export interface PredictionSubmitResponse {
  readonly status: "accepted";
  readonly orderId: string;
  readonly orderStatus: string;
  readonly makingAmount: string | null;
  readonly takingAmount: string | null;
  readonly transactionsHashes: readonly string[];
  readonly session?: string;
  readonly sessionExpiresAt?: number;
}

export interface PredictionRedeemPrepared {
  readonly venue: "polymarket";
  readonly network: "polygon";
  readonly account: string;
  readonly market: { readonly id: string; readonly question: string };
  readonly steps: PredictionPrepared["steps"];
  readonly note: string;
}

export interface GeoblockAnswer {
  readonly blocked: boolean;
  readonly country: string | null;
  readonly region: string | null;
}

export const predictApi = {
  markets: (query: { readonly q?: string; readonly category?: string; readonly sort?: string }, signal?: AbortSignal) => {
    const params: Record<string, string> = {};
    if (query.q) params.q = query.q;
    if (query.category) params.category = query.category;
    if (query.sort) params.sort = query.sort;
    return getKletiaClient().request<PredictionMarketsResponse>("GET", "/predictions/markets", undefined, { query: params, ...(signal ? { signal } : {}) });
  },
  market: (id: string, signal?: AbortSignal) => getKletiaClient().request<PredictionMarketResponse>("GET", `/predictions/markets/${encodeURIComponent(id)}`, undefined, { ...(signal ? { signal } : {}) }),
  positions: (account: string, signal?: AbortSignal) =>
    getKletiaClient().request<PredictionPositionsResponse>("GET", "/predictions/positions", undefined, { query: { account }, ...(signal ? { signal } : {}) }),
  quote: (request: PredictionRequest) => getKletiaClient().request<PredictionQuoteResponse>("POST", "/predictions/quote", request, { maxRetries: 0 }),
  prepare: (request: PredictionRequest) => getKletiaClient().request<{ readonly prepared: PredictionPrepared }>("POST", "/predictions/prepare", request, { maxRetries: 0 }).then((body) => body.prepared),
  submit: (body: PredictionSubmitBody) => getKletiaClient().request<PredictionSubmitResponse>("POST", "/predictions/submit", body, { maxRetries: 0 }),
  redeem: (account: string, conditionId: string) =>
    getKletiaClient().request<{ readonly prepared: PredictionRedeemPrepared }>("POST", "/predictions/redeem", { account, conditionId }, { maxRetries: 0 }).then((body) => body.prepared),
  signIn: (account: string) => getKletiaClient().request<{ readonly typedData: PredictionTypedData }>("POST", "/predictions/session", { account }, { maxRetries: 0 }),
};

/** Polymarket's location check for this browser (polymarket.com/api/geoblock, CORS open). Unreadable: null. */
export async function checkGeoblock(signal?: AbortSignal): Promise<GeoblockAnswer | null> {
  try {
    const response = await fetch(POLYMARKET_POLYGON.geoblockApi, { ...(signal ? { signal } : {}), credentials: "omit" });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.blocked !== "boolean") return null;
    return { blocked: body.blocked, country: typeof body.country === "string" ? body.country : null, region: typeof body.region === "string" ? body.region : null };
  } catch {
    return null;
  }
}
