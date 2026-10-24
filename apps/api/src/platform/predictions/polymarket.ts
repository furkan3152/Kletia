/**
 * Polymarket reads: Gamma (markets, events, search), the CLOB (order books)
 * and the Data API (positions, price history), parsed into the
 * venue-neutral models of @kletia/core `predictions.ts`. Keyless public
 * endpoints (docs.polymarket.com/getting-started/api); the base URLs can be
 * overridden with POLYMARKET_GAMMA_URL, POLYMARKET_CLOB_URL,
 * POLYMARKET_DATA_URL and POLYMARKET_GEOBLOCK_URL (https only).
 *
 * Parsing fails closed: a market whose version, outcome ids, tick size or
 * fee schedule cannot be read is left out (search, lists) or refused
 * (by id), never guessed. Outcome ids follow the docs' Protocol V2 rule:
 * `version` "v2" trades `positionIds`, "v1" the JSON-encoded `clobTokenIds`.
 */
import {
  POLYMARKET_POLYGON,
  POLYMARKET_ROUNDING,
  type PredictionBook,
  type PredictionBookLevel,
  type PredictionFeeSchedule,
  type PredictionMarket,
  type PredictionPosition,
  type PredictionPricePoint,
} from "@kletia/core";
import { PlatformError } from "../errors.js";
import { providerCode, type PredictionsIo, type VenueResponse } from "./io.js";

/* --------------------------------------------------------------- config */

function baseUrl(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("not https");
    return url.href.replace(/\/+$/u, "");
  } catch {
    console.warn(`[predictions] ${name} is not an https URL; using ${fallback}.`);
    return fallback;
  }
}

export const polymarketUrls = () => ({
  gamma: baseUrl("POLYMARKET_GAMMA_URL", POLYMARKET_POLYGON.gammaApi),
  clob: baseUrl("POLYMARKET_CLOB_URL", POLYMARKET_POLYGON.clobApi),
  data: baseUrl("POLYMARKET_DATA_URL", POLYMARKET_POLYGON.dataApi),
  geoblock: baseUrl("POLYMARKET_GEOBLOCK_URL", POLYMARKET_POLYGON.geoblockApi),
});

const PROVIDER = "Polymarket";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function jsonList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A venue answer's JSON, or PREDICTION_PRICE_UNAVAILABLE / <PROVIDER>_UNAVAILABLE for anything but 2xx. */
export function okBody(response: VenueResponse, what: string): unknown {
  if (response.status === 404) throw new PlatformError("PREDICTION_MARKET_NOT_FOUND", `${PROVIDER} has no ${what}.`, 404);
  if (response.status < 200 || response.status >= 300) throw new PlatformError(providerCode(PROVIDER, "UNAVAILABLE"), `${PROVIDER} could not answer for ${what} (HTTP ${response.status}).`, 502);
  return response.body;
}

/* --------------------------------------------------------------- markets */

const DECIMAL_ID = /^\d{1,90}$/u;
const CONDITION_ID = /^0x[0-9a-fA-F]{64}$/u;

/** A tick size as the rounding table spells it ("0.001"), or null. */
export function tickSizeOf(value: unknown): string | null {
  const parsed = num(value);
  if (parsed === null) return null;
  return Object.keys(POLYMARKET_ROUNDING).find((tick) => Math.abs(Number(tick) - parsed) < 1e-12) ?? null;
}

function feesOf(market: Record<string, unknown>): PredictionFeeSchedule | null {
  if (market.feesEnabled !== true) return { rate: 0, exponent: 1, takerOnly: true };
  const schedule = market.feeSchedule;
  if (!isRecord(schedule)) return null;
  const rate = num(schedule.rate);
  const exponent = num(schedule.exponent);
  if (rate === null || exponent === null || rate < 0 || rate > 1 || exponent <= 0 || exponent > 4) return null;
  return { rate, exponent, takerOnly: schedule.takerOnly !== false };
}

interface EventContext {
  readonly id: string | null;
  readonly title: string | null;
  readonly slug: string | null;
  readonly category: string | null;
}

function eventContext(event: unknown): EventContext {
  if (!isRecord(event)) return { id: null, title: null, slug: null, category: null };
  const tags = Array.isArray(event.tags) ? event.tags.filter(isRecord) : [];
  return { id: str(event.id), title: str(event.title), slug: str(event.slug), category: tags.map((tag) => str(tag.label)).find((label) => label !== null) ?? null };
}

/** One Gamma market, or null when it cannot be traded as read (unknown version, ids, tick size). */
export function parseGammaMarket(raw: unknown, context?: EventContext): PredictionMarket | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const question = str(raw.question);
  const conditionId = str(raw.conditionId);
  const version = raw.version;
  if (!id || !question || !conditionId || !CONDITION_ID.test(conditionId) || (version !== "v1" && version !== "v2")) return null;
  const labels = jsonList(raw.outcomes);
  const ids = version === "v2" ? (Array.isArray(raw.positionIds) ? raw.positionIds : null) : jsonList(raw.clobTokenIds);
  const prices = jsonList(raw.outcomePrices) ?? [];
  if (!labels || !ids || labels.length !== ids.length || labels.length < 2) return null;
  if (!labels.every((label) => typeof label === "string" && label.trim().length > 0) || !ids.every((value) => typeof value === "string" && DECIMAL_ID.test(value))) return null;
  const tickSize = tickSizeOf(raw.orderPriceMinTickSize);
  if (!tickSize) return null;
  const event = context ?? eventContext(Array.isArray(raw.events) ? raw.events[0] : null);
  const closed = raw.closed === true;
  const resolvedStatus = raw.resolutionStatus === "resolved" || raw.umaResolutionStatus === "resolved";
  const settled = prices.length === labels.length && prices.map((price) => num(price)).every((price) => price === 0 || price === 1);
  return {
    venue: "polymarket",
    id,
    slug: str(raw.slug) ?? id,
    question,
    eventId: event.id,
    eventTitle: event.title,
    groupTitle: str(raw.groupItemTitle),
    category: event.category,
    image: str(raw.image),
    endDate: str(raw.endDate),
    active: raw.active === true,
    closed,
    acceptingOrders: raw.acceptingOrders === true && raw.enableOrderBook !== false,
    version,
    conditionId: conditionId.toLowerCase(),
    negRisk: raw.negRisk === true,
    tickSize,
    minOrderSize: num(raw.orderMinSize) ?? 5,
    outcomes: labels.map((label, index) => ({ label: (label as string).trim(), tokenId: ids[index] as string, price: num(prices[index]) })),
    volumeUsd: num(raw.volumeNum) ?? num(raw.volume) ?? 0,
    volume24hUsd: num(raw.volume24hr) ?? 0,
    liquidityUsd: num(raw.liquidityNum) ?? num(raw.liquidity) ?? 0,
    fees: feesOf(raw),
    matchDelaySeconds: Math.max(0, num(raw.secondsDelay) ?? 0),
    resolved: closed && (resolvedStatus || settled),
    url: `https://polymarket.com/event/${event.slug ?? str(raw.slug) ?? id}`,
    description: str(raw.description)?.slice(0, 600) ?? null,
  };
}

/** Markets of Gamma events (each with its event's title and category). */
export function marketsOfEvents(events: unknown): PredictionMarket[] {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => {
    if (!isRecord(event) || !Array.isArray(event.markets)) return [];
    const context = eventContext(event);
    return event.markets.flatMap((market) => parseGammaMarket(market, context) ?? []);
  });
}

/** A market is listed for trading when it is open and takes orders. */
export const tradable = (market: PredictionMarket): boolean => market.active && !market.closed && market.acceptingOrders;

export type MarketSort = "volume" | "ending";

/** Categories the market list offers (Gamma tag slugs). */
export const PREDICTION_CATEGORIES = Object.freeze(["politics", "sports", "crypto", "economy", "finance", "tech", "geopolitics"] as const);
export type PredictionCategory = (typeof PREDICTION_CATEGORIES)[number];

export async function searchGamma(io: PredictionsIo, query: string): Promise<PredictionMarket[]> {
  const params = new URLSearchParams({ q: query, events_status: "active", limit_per_type: "10", search_tags: "false", search_profiles: "false", keep_closed_markets: "0" });
  const body = okBody(await io.request(PROVIDER, `${polymarketUrls().gamma}/public-search?${params}`), "search results");
  return marketsOfEvents(isRecord(body) ? body.events : null);
}

export async function listGammaEvents(io: PredictionsIo, options: { readonly category?: PredictionCategory; readonly sort: MarketSort; readonly limit: number }): Promise<PredictionMarket[]> {
  const params = new URLSearchParams({
    closed: "false",
    active: "true",
    limit: String(options.limit),
    order: options.sort === "ending" ? "endDate" : "volume24hr",
    ascending: options.sort === "ending" ? "true" : "false",
    ...(options.sort === "ending" ? { end_date_min: new Date(io.now()).toISOString() } : {}),
    ...(options.category ? { tag_slug: options.category } : {}),
  });
  return marketsOfEvents(okBody(await io.request(PROVIDER, `${polymarketUrls().gamma}/events?${params}`), "events"));
}

export async function readGammaMarket(io: PredictionsIo, marketId: string): Promise<PredictionMarket> {
  if (!/^\d{1,20}$/u.test(marketId)) throw new PlatformError("PREDICTION_MARKET_NOT_FOUND", "A Polymarket market id is a number from GET /v1/predictions/markets.", 404);
  const market = parseGammaMarket(okBody(await io.request(PROVIDER, `${polymarketUrls().gamma}/markets/${marketId}`), `market ${marketId}`));
  if (!market) throw new PlatformError("PREDICTION_MARKET_NOT_FOUND", `Market ${marketId} is not one Kletia can read (unknown protocol version, outcome ids or tick size).`, 404);
  return market;
}

/** The market of a condition id (open or closed), or null. */
export async function readGammaMarketByCondition(io: PredictionsIo, conditionId: string): Promise<PredictionMarket | null> {
  const params = new URLSearchParams({ condition_ids: conditionId, closed: "any", limit: "1" });
  const body = okBody(await io.request(PROVIDER, `${polymarketUrls().gamma}/markets?${params}`), `condition ${conditionId}`);
  const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.markets) ? body.markets : [];
  return parseGammaMarket(list[0]);
}

/* ------------------------------------------------------------------ book */

function levels(value: unknown, best: "high" | "low"): PredictionBookLevel[] {
  if (!Array.isArray(value)) return [];
  const out = value.flatMap((level) => {
    if (!isRecord(level)) return [];
    const price = num(level.price);
    const size = num(level.size);
    return price !== null && size !== null && price > 0 && price < 1 && size > 0 ? [{ price, size }] : [];
  });
  return out.sort((a, b) => (best === "high" ? b.price - a.price : a.price - b.price));
}

/** The CLOB's book of one outcome, best levels first (the CLOB lists them worst first). */
export function parseClobBook(raw: unknown, tokenId: string, nowMs: number): PredictionBook {
  if (!isRecord(raw) || str(raw.asset_id) !== tokenId) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", "Polymarket's order book did not answer for this outcome.", 503);
  const tickSize = tickSizeOf(raw.tick_size);
  if (!tickSize) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", "Polymarket's order book lists a tick size Kletia does not know, so nothing is built.", 503);
  const stamp = num(raw.timestamp);
  return {
    tokenId,
    bids: levels(raw.bids, "high"),
    asks: levels(raw.asks, "low"),
    tickSize,
    minOrderSize: num(raw.min_order_size) ?? 5,
    negRisk: raw.neg_risk === true,
    lastTradePrice: num(raw.last_trade_price),
    // The CLOB stamps books in milliseconds; a book without a stamp is taken as read now.
    observedAt: Math.floor((stamp ?? nowMs) / 1000),
  };
}

export async function readClobBook(io: PredictionsIo, tokenId: string): Promise<PredictionBook> {
  const response = await io.request(PROVIDER, `${polymarketUrls().clob}/book?token_id=${tokenId}`);
  if (response.status === 404) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", "This outcome has no order book (the market may be closed).", 503);
  if (response.status < 200 || response.status >= 300) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", `Polymarket's order book could not be read (HTTP ${response.status}).`, 503);
  return parseClobBook(response.body, tokenId, io.now());
}

/* ------------------------------------------------------------- history */

export function parseHistory(raw: unknown): PredictionPricePoint[] {
  const rows = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) return [];
    const t = num(row.timestamp);
    const p = num(row.price);
    return t !== null && p !== null && p >= 0 && p <= 1 ? [{ t, p }] : [];
  });
}

/** One week of an outcome's price, six-hour points (Data API v2 /prices-history). */
export async function readHistory(io: PredictionsIo, tokenId: string): Promise<PredictionPricePoint[]> {
  const params = new URLSearchParams({ token_id: tokenId, interval: "1w", bucket_seconds: "21600" });
  const response = await io.request(PROVIDER, `${polymarketUrls().data}/v2/prices-history?${params}`);
  return response.status >= 200 && response.status < 300 ? parseHistory(response.body) : [];
}

/* ------------------------------------------------------------ positions */

export function parsePositions(raw: unknown, holder: string): PredictionPosition[] {
  const rows = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
  return rows.flatMap((row): PredictionPosition[] => {
    if (!isRecord(row)) return [];
    const conditionId = str(row.condition_id);
    const tokenId = str(row.token_id);
    const shares = num(row.current_size);
    if (!conditionId || !CONDITION_ID.test(conditionId) || !tokenId || !DECIMAL_ID.test(tokenId) || shares === null || shares <= 0) return [];
    return [{
      venue: "polymarket",
      holder,
      conditionId: conditionId.toLowerCase(),
      tokenId,
      title: str(row.title) ?? "Unknown market",
      slug: str(row.slug),
      eventSlug: str(row.event_slug),
      outcome: str(row.outcome) ?? `Outcome ${num(row.outcome_index) ?? "?"}`,
      outcomeIndex: num(row.outcome_index) ?? 0,
      shares,
      avgPrice: num(row.avg_price) ?? 0,
      currentPrice: num(row.current_price) ?? 0,
      valueUsd: num(row.current_value) ?? 0,
      costUsd: num(row.total_cost_usdc) ?? 0,
      pnlUsd: num(row.total_pnl) ?? 0,
      redeemable: row.redeemable === true,
      negRisk: row.negative_risk === true,
      endDate: str(row.end_date),
    }];
  });
}

export interface PositionsRead {
  readonly positions: PredictionPosition[];
  /** More positions exist than one read returns (the list is cut, never guessed). */
  readonly truncated: boolean;
}

export async function readPositions(io: PredictionsIo, holder: string): Promise<PositionsRead> {
  const params = new URLSearchParams({ user: holder, limit: "100" });
  const body = okBody(await io.request(PROVIDER, `${polymarketUrls().data}/v2/positions?${params}`), "positions");
  const pagination = isRecord(body) && isRecord(body.pagination) ? body.pagination : {};
  return { positions: parsePositions(body, holder), truncated: pagination.has_more === true };
}

/* ------------------------------------------------------------- geoblock */

export interface GeoblockState {
  readonly blocked: boolean;
  readonly country: string | null;
  readonly region: string | null;
}

/** Polymarket's location check for the requesting IP (this server's, when the API asks). Unreadable: blocked (fail closed). */
export async function readGeoblock(io: PredictionsIo): Promise<GeoblockState> {
  try {
    const response = await io.request(PROVIDER, polymarketUrls().geoblock);
    const body = response.body;
    if (response.status !== 200 || !isRecord(body) || typeof body.blocked !== "boolean") return { blocked: true, country: null, region: null };
    return { blocked: body.blocked, country: str(body.country), region: str(body.region) };
  } catch {
    return { blocked: true, country: null, region: null };
  }
}
