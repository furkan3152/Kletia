/**
 * Typed loaders for the public Kletia Platform API v1 endpoints the web app
 * reads. Every loader takes the shared client and an AbortSignal so it can be
 * passed straight to `useApiResource` / `useApiAction`.
 */
import {
  KletiaApiError,
  type ApiKeyRecord,
  type HealthReport,
  type KletiaClient,
  type NetworkCapabilities,
  type QuoteRequest,
  type QuoteResponse,
} from "@kletia/sdk";
import type { IntentTurnRequest, IntentTurnResponse, Journey, ProtocolDescriptor } from "@kletia/core";

import type { PortfolioReads } from "../../app/console/state/holdings";
import { sdkSignal, type PlatformError } from "./kletiaClient";

export type { ApiKeyRecord, HealthReport, NetworkCapabilities, QuoteRequest, QuoteResponse };

export function fetchHealth(client: KletiaClient, signal?: AbortSignal): Promise<HealthReport> {
  return client.request<HealthReport>("GET", "/health", undefined, { signal: sdkSignal(signal) });
}

export async function fetchNetworks(
  client: KletiaClient,
  signal?: AbortSignal,
): Promise<NetworkCapabilities[]> {
  const body = await client.request<{ networks: NetworkCapabilities[] }>("GET", "/networks", undefined, {
    signal: sdkSignal(signal),
  });
  return Array.isArray(body?.networks) ? body.networks : [];
}

export async function fetchProtocols(
  client: KletiaClient,
  signal?: AbortSignal,
): Promise<ProtocolDescriptor[]> {
  const body = await client.request<{ protocols: ProtocolDescriptor[] }>("GET", "/protocols", undefined, {
    signal: sdkSignal(signal),
  });
  return Array.isArray(body?.protocols) ? body.protocols : [];
}

export type { PortfolioReads };

/**
 * Holdings of several accounts in one request (`GET /v1/portfolio?accounts=`).
 * On an API without that route (404) it reads one account at a time, at most
 * the six production accounts; `source` then says "per-account" so the
 * caller can skip the batch next time (`skipBatch`). Unreadable accounts are
 * failures, never empty portfolios.
 */
export async function fetchPortfolios(
  client: KletiaClient,
  signal: AbortSignal | undefined,
  accounts: readonly string[],
  options: { readonly skipBatch?: boolean } = {},
): Promise<PortfolioReads> {
  // Loaded on first use, so the site pages that share this module never carry the holdings model.
  const { readPortfolios } = await import("../../app/console/state/holdings");
  return readPortfolios(
    {
      batch: async (list) => {
        try {
          return await client.request<unknown>("GET", "/portfolio", undefined, {
            signal: sdkSignal(signal),
            query: { accounts: list.join(",") },
          });
        } catch (error) {
          if (error instanceof KletiaApiError && error.status === 404) return null;
          throw error;
        }
      },
      single: (account) => client.portfolio(account, { signal: sdkSignal(signal) }),
    },
    accounts,
    options,
  );
}

export function requestQuote(
  client: KletiaClient,
  signal: AbortSignal | undefined,
  request: QuoteRequest,
): Promise<QuoteResponse> {
  return client.request<QuoteResponse>("POST", "/quotes", request, { signal: sdkSignal(signal) });
}

const RAW_BODY_LIMIT = 200_000;

/* ------------------------------------------------------------ clarify turns */

/** How a clarify turn is asked for (`POST /v1/intents?clarify=true&…`). */
export interface TurnFlags {
  /** Plan without storing (every turn but the commit turn). */
  readonly dryRun: boolean;
  /** The plan-stage fare. */
  readonly preview?: boolean;
  /** The journey on that fare (it implies the fare). */
  readonly journey?: boolean;
  /** `none`: no account reads for the journey (demo or indicative plans). */
  readonly journeyReads?: "none";
}

/** A planned turn's response, with the journey the HTTP layer adds when asked. */
export type TurnResponse = IntentTurnResponse & { readonly journey?: Journey | null };

/** One clarify exchange exactly as sent and received (Studio's response tab prints it byte for byte). */
export interface TurnExchange {
  readonly method: "POST";
  /** Path with the query, e.g. "/v1/intents?clarify=true&dryRun=true&preview=true". */
  readonly path: string;
  /** The request body exactly as sent. */
  readonly requestText: string;
  readonly status: number;
  readonly ok: boolean;
  readonly requestId: string | null;
  /** The response body exactly as received. */
  readonly responseText: string;
  /** Parsed JSON body; null when it was not JSON. */
  readonly body: unknown;
  readonly latencyMs: number;
}

const TURN_TIMEOUT_MS = 25_000;

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `/v1/intents?clarify=true…` for these flags (the query order is fixed, so exchanges read the same). */
export function turnPath(flags: TurnFlags): string {
  const query = new URLSearchParams({ clarify: "true" });
  if (flags.dryRun) query.set("dryRun", "true");
  if (flags.preview || flags.journey) query.set("preview", "true");
  if (flags.journey) query.set("journey", "true");
  if (flags.journey && flags.journeyReads) query.set("journeyReads", flags.journeyReads);
  return `/v1/intents?${query.toString()}`;
}

/**
 * One clarify turn: plain fetch rather than the SDK, so a refusal keeps
 * every field the API sent (hints, details) and the exchange can be
 * shown exactly. Rejects only when the API could not be reached (or the
 * caller aborted); every HTTP answer resolves.
 */
export async function postIntentTurn(
  origin: string,
  request: IntentTurnRequest,
  flags: TurnFlags,
  { signal, fetchImpl = fetch }: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {},
): Promise<TurnExchange> {
  const path = turnPath(flags);
  const requestText = JSON.stringify(request);
  const timeout = AbortSignal.timeout(TURN_TIMEOUT_MS);
  const combined = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
  const startedAt = Date.now();
  const response = await fetchImpl(`${origin}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: requestText,
    signal: combined,
  });
  const responseText = await response.text();
  const body = parseJson(responseText);
  return {
    method: "POST",
    path,
    requestText,
    status: response.status,
    ok: response.ok,
    requestId: response.headers.get("x-request-id"),
    responseText: responseText.length > RAW_BODY_LIMIT ? `${responseText.slice(0, RAW_BODY_LIMIT)}…` : responseText,
    body,
    latencyMs: Date.now() - startedAt,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The turn response of a successful exchange, checked for the shape each
 * status promises; null for anything else (never guessed into a plan).
 */
export function turnResponseOf(exchange: Pick<TurnExchange, "ok" | "body">): TurnResponse | null {
  if (!exchange.ok || !isObject(exchange.body)) return null;
  const body = exchange.body;
  if (!isObject(body.thread)) return null;
  switch (body.status) {
    case "needs_input":
      return Array.isArray(body.questions) && isObject(body.draft) ? (body as unknown as TurnResponse) : null;
    case "planned":
      return isObject(body.intent) && typeof body.intent.id === "string" && Array.isArray(body.intent.steps) && typeof body.sentence === "string"
        ? (body as unknown as TurnResponse)
        : null;
    case "cancelled":
      return body as unknown as TurnResponse;
    default:
      return null;
  }
}

/** A refused or unreadable turn as a render-ready API failure (the explorer's and Studio's error panel). */
export function turnPlatformError(exchange: Pick<TurnExchange, "status" | "body" | "requestId" | "ok">): PlatformError {
  const error = isObject(exchange.body) && isObject(exchange.body.error) ? exchange.body.error : {};
  const issues = Array.isArray(error.issues)
    ? error.issues.slice(0, 12).flatMap((issue) =>
        isObject(issue) && typeof issue.message === "string" ? [{ path: typeof issue.path === "string" ? issue.path : "", message: issue.message.slice(0, 400) }] : [],
      )
    : [];
  if (exchange.ok) {
    return { code: "INVALID_RESPONSE", message: "The Kletia API returned a turn this page cannot read.", status: exchange.status, issues: [], requestId: exchange.requestId, retryable: false, unreachable: false };
  }
  return {
    code: typeof error.code === "string" ? error.code : `HTTP_${exchange.status}`,
    message: typeof error.message === "string" ? error.message.slice(0, 600) : `The Kletia API answered ${exchange.status}.`,
    status: exchange.status,
    issues,
    requestId: exchange.requestId,
    retryable: exchange.status === 429 || exchange.status >= 500,
    unreachable: false,
  };
}
