/**
 * Recorded Polymarket reads (fixtures/predictions, captured on 2026-10-24
 * from the public Gamma, CLOB and Data APIs and trimmed to the fields Kletia
 * reads) behind the PredictionsIo port, plus Polygon reads answered from
 * test options. The CLOB's authenticated answers (credentials, order
 * acceptance, open orders, cancels) use the documented response shapes
 * (docs.polymarket.com "Wallets and Authentication", "Place Orders",
 * "Manage Orders"). Any request outside the recording throws, so a test
 * never reaches the network.
 */
import { readFileSync } from "node:fs";
import { POLYMARKET_POLYGON } from "@kletia/core";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, parseAbi, type Hex } from "viem";
import type { PredictionsIo, VenueRequest, VenueResponse } from "../../predictions/io.js";

export const loadPrediction = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/predictions/${name}`, import.meta.url), "utf8"));

export const MARKET_666861 = loadPrediction("gamma-market-666861.json") as Record<string, unknown>;
export const MARKET_FEES = loadPrediction("gamma-market-fees.json") as Record<string, unknown>;
export const MARKET_NEGRISK = loadPrediction("gamma-market-negrisk.json") as Record<string, unknown>;
export const BOOK_YES = loadPrediction("clob-book-666861-yes.json") as Record<string, unknown>;
export const SEARCHES = { "trump out as president": loadPrediction("gamma-search-trump-out.json"), ...(loadPrediction("eval-search.json") as Record<string, unknown>) } as Record<string, unknown>;
export const EVENTS_POLITICS = loadPrediction("gamma-events-politics.json");
export const POSITIONS_OPEN = loadPrediction("data-positions-open.json");
export const HISTORY_YES = loadPrediction("data-history-666861-yes.json");

export const YES_TOKEN = "59252515735652674747158950210016502214756531287333895140318848923768750410355";
export const NO_TOKEN = "2849827372590072151380088930233312280478318575453624773762283369907909283027";
/** The book's own timestamp (ms) plus five seconds: the recorded book is fresh. */
export const RECORDED_NOW = Number(BOOK_YES.timestamp) + 5_000;

/** Documented CLOB answers (docs examples; credentials are placeholders, never real). */
export const CREDENTIALS = { apiKey: "7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2", secret: "dGhpcyBpcyBhIHRlc3Qgc2VjcmV0IGZvciBrbGV0aWE=", passphrase: "9fH3kL7m2qW8xP4r" };
export const ORDER_ACCEPTED = { success: true, errorMsg: "", orderID: "0x5759cc30f8b7a99ab65cad16225685d21e5f81d13d639546291328facc69ab36", status: "matched", makingAmount: "20000000", takingAmount: "465116200", transactionsHashes: ["0x" + "ab".repeat(32)], tradeIDs: ["t-1"] };

export interface ChainState {
  readonly pusd?: bigint;
  readonly usdce?: bigint;
  /** pUSD / USDC.e allowance per lower-case "token:spender". */
  readonly allowances?: Readonly<Record<string, bigint>>;
  /** ERC-1155 operator approvals per lower-case "ledger:operator". */
  readonly operators?: Readonly<Record<string, boolean>>;
  /** Share balance per token or position id. */
  readonly shares?: Readonly<Record<string, bigint>>;
  readonly payoutDenominator?: bigint;
  /** Code at the account (default: a plain wallet). */
  readonly code?: Hex;
}

export interface PredictionFixtureOptions {
  readonly now?: number;
  readonly chain?: ChainState;
  readonly geoblock?: unknown;
  /** Answer of POST /order (status, body). */
  readonly order?: VenueResponse;
  /** Answer of GET /auth/derive-api-key (default: the documented credentials). */
  readonly derive?: VenueResponse;
  readonly markets?: Readonly<Record<string, unknown>>;
  readonly books?: Readonly<Record<string, unknown>>;
}

export interface RecordedRequest {
  readonly url: string;
  readonly init: VenueRequest;
}

export interface PredictionFixtureIo extends PredictionsIo {
  readonly requests: RecordedRequest[];
}

const readAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
]);

const ok = (body: unknown): VenueResponse => ({ status: 200, body });
const uint = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);

export function predictionFixtureIo(options: PredictionFixtureOptions = {}): PredictionFixtureIo {
  const requests: RecordedRequest[] = [];
  const chain = options.chain ?? {};
  const markets: Record<string, unknown> = { "666861": MARKET_666861, [String(MARKET_FEES.id)]: MARKET_FEES, [String(MARKET_NEGRISK.id)]: MARKET_NEGRISK, ...options.markets };
  const books: Record<string, unknown> = { [YES_TOKEN]: BOOK_YES, ...options.books };
  return {
    requests,
    async request(_provider, url, init = {}) {
      requests.push({ url, init });
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (parsed.hostname === "gamma-api.polymarket.com") {
        if (path === "/public-search") return ok(SEARCHES[(parsed.searchParams.get("q") ?? "").toLowerCase()] ?? { events: [] });
        if (path === "/events") return ok(EVENTS_POLITICS);
        const byId = /^\/markets\/(\d+)$/u.exec(path);
        if (byId) return markets[byId[1] as string] ? ok(markets[byId[1] as string]) : { status: 404, body: { error: "not found" } };
        if (path === "/markets" && parsed.searchParams.get("condition_ids")) {
          const wanted = parsed.searchParams.get("condition_ids")?.toLowerCase();
          return ok(Object.values(markets).filter((market) => String((market as Record<string, unknown>).conditionId).toLowerCase() === wanted));
        }
      }
      if (parsed.hostname === "clob.polymarket.com") {
        if (path === "/book") {
          const book = books[parsed.searchParams.get("token_id") ?? ""];
          return book ? ok(book) : { status: 404, body: { error: "No orderbook exists for the requested token id" } };
        }
        if (path === "/auth/derive-api-key") return options.derive ?? ok(CREDENTIALS);
        if (path === "/auth/api-key") return ok(CREDENTIALS);
        if (path === "/balance-allowance/update") return ok({});
        if (path === "/order" && init.method === "POST") return options.order ?? ok(ORDER_ACCEPTED);
        if (path === "/order" && init.method === "DELETE") {
          const id = (JSON.parse(init.body ?? "{}") as { orderID?: string }).orderID;
          return ok({ canceled: [id], not_canceled: {} });
        }
        if (path === "/data/orders") {
          return ok({ data: [{ id: ORDER_ACCEPTED.orderID, status: "LIVE", market: MARKET_666861.conditionId, asset_id: YES_TOKEN, side: "BUY", original_size: "50", size_matched: "10", price: "0.04", outcome: "Yes", order_type: "GTC", created_at: 1792829000 }], next_cursor: "LTE=" });
        }
      }
      if (parsed.hostname === "data-api.polymarket.com") {
        if (path === "/v2/positions") return ok(POSITIONS_OPEN);
        if (path === "/v2/prices-history") return ok(parsed.searchParams.get("token_id") === YES_TOKEN ? HISTORY_YES : { data: [] });
      }
      if (url === POLYMARKET_POLYGON.geoblockApi) return ok(options.geoblock ?? { blocked: false, ip: "203.0.113.42", country: "PT", region: "11" });
      throw new Error(`unrecorded request ${url}`);
    },
    async polygonCall(to, data) {
      const call = decodeFunctionData({ abi: readAbi, data });
      const target = to.toLowerCase();
      switch (call.functionName) {
        case "balanceOf":
          if (call.args.length === 2) return uint(chain.shares?.[String(call.args[1])] ?? 0n);
          return uint(target === POLYMARKET_POLYGON.pusd.toLowerCase() ? chain.pusd ?? 0n : chain.usdce ?? 0n);
        case "allowance":
          return uint(chain.allowances?.[`${target}:${String(call.args[1]).toLowerCase()}`] ?? 0n);
        case "isApprovedForAll":
          return encodeAbiParameters([{ type: "bool" }], [chain.operators?.[`${target}:${String(call.args[1]).toLowerCase()}`] ?? false]);
        case "payoutDenominator":
          return uint(chain.payoutDenominator ?? 0n);
        default:
          throw new Error(`unrecorded eth_call ${data.slice(0, 10)}`);
      }
    },
    async polygonCode() {
      return chain.code ?? "0x";
    },
    now: () => options.now ?? RECORDED_NOW,
  };
}

/** ERC-20 calls the prepared steps make, decoded (approve / transfer targets and amounts). */
export function decodeErc20(data: string): { readonly name: string; readonly args: readonly unknown[] } {
  const call = decodeFunctionData({ abi: erc20Abi, data: data as Hex });
  return { name: call.functionName, args: call.args ?? [] };
}
