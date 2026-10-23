/**
 * /v1/perps through the shared Kletia client. Prepare and submit are never
 * retried by the client: a repeated relay could place an order twice.
 */
import type { PerpsMarket, PerpsPosition, PerpsPrepared, PerpsQuote, PerpsRequest, PerpsVenue, PerpsVenueChoice, PerpsVenueId } from "@kletia/core";

import { getKletiaClient } from "../../../shared/platform/kletiaClient";

export interface PerpsUnavailable {
  readonly venue: PerpsVenueId;
  readonly code: string;
  readonly message: string;
}

export interface PerpsMarketsResponse {
  readonly venues: readonly PerpsVenue[];
  readonly markets: readonly PerpsMarket[];
  readonly unavailable: readonly PerpsUnavailable[];
}

export interface PerpsPositionsResponse {
  readonly account: string;
  readonly positions: readonly PerpsPosition[];
  readonly unavailable: readonly PerpsUnavailable[];
  readonly unsupported: number;
}

export interface PerpsQuoteResponse {
  readonly request: PerpsRequest;
  readonly best: (PerpsVenueChoice & { readonly quote: PerpsQuote | null }) | null;
  readonly choices: readonly PerpsVenueChoice[];
}

export interface PerpsSubmitBody {
  readonly venue: "hyperliquid";
  readonly account: string;
  readonly action: Readonly<Record<string, unknown>>;
  readonly nonce: number;
  readonly signature: string;
}

export const perpsApi = {
  markets: (signal?: AbortSignal) => getKletiaClient().request<PerpsMarketsResponse>("GET", "/perps/markets", undefined, { ...(signal ? { signal } : {}) }),
  positions: (account: string, signal?: AbortSignal) =>
    getKletiaClient().request<PerpsPositionsResponse>("GET", "/perps/positions", undefined, { query: { account }, ...(signal ? { signal } : {}) }),
  quote: (request: PerpsRequest) => getKletiaClient().request<PerpsQuoteResponse>("POST", "/perps/quote", request, { maxRetries: 0 }),
  prepare: (request: PerpsRequest) => getKletiaClient().request<{ readonly prepared: PerpsPrepared }>("POST", "/perps/prepare", request, { maxRetries: 0 }).then((body) => body.prepared),
  submit: (body: PerpsSubmitBody) => getKletiaClient().request<{ readonly status: "ok"; readonly response: unknown }>("POST", "/perps/submit", body, { maxRetries: 0 }),
};
