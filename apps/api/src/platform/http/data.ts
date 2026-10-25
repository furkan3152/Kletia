/**
 * Data API routes (docs/platform/data.md), read-only:
 *
 *   GET /v1/data/portfolio?evm=&solana=&lane=     holdings, positions, totals, allocation, estimates
 *   GET /v1/data/positions?evm=&solana=&lane=     positions, debts and lending health
 *   GET /v1/data/history?evm=&solana=&limit=      the calling key's intents, receipts and links
 *   GET /v1/data/markets/yields?network=&asset=   venue APYs
 *   GET /v1/data/markets/prices?symbols=&network= USD prices
 *   GET /v1/data/markets/status                   network status and route statistics
 *   GET /v1/data/export?dataset=&format=          holdings, positions, history or transactions as CSV or JSON
 *   GET /v1/data/transactions?…                    on-chain history of the wallets (filters, cursor)
 *   GET /v1/data/transactions/:id                  one transaction (<network>:<hash>)
 *   GET /v1/data/pnl?period=                       FIFO cost-basis estimates by asset
 *   GET /v1/data/snapshots?range=                  value series of a tracked set
 *   GET /v1/data/summary                           one compact object for an assistant
 *   GET|POST|DELETE /v1/data/tracking              opt a signed-in desk wallet set in or out
 *
 * Every route is open to publishable keys; history needs a key (it lists the
 * key's own activity). Each read spends the data budget (limits.ts).
 *
 * The reads that take wallet addresses (DATA_BODY_READS) also answer POST
 * with the parameters in a JSON body: addresses in a URL end up in access
 * logs (Kletia's host, proxies, browser history), a body does not. The SDK
 * and the web app use POST; GET stays for compatibility and is deprecated.
 *
 * Callers of the history routes (transactions, pnl, snapshots, summary):
 * a desk wallet session (`Kletia-Account-Session`, first-party origin) reads
 * its tracked set only (its own wallets, each proven by a sign-in); an API
 * key reads the addresses it names (`evm`, `solana`: public on-chain data,
 * links only to the key's own intents); without either, 401.
 */
import type { Request, RequestHandler, Response } from "express";
import {
  ACCOUNT_SESSION_HEADER,
  CHAINS,
  DATA_EXPORT_DATASETS,
  DATA_PNL_PERIODS,
  DATA_TX_KINDS,
  dataHistoryCsv,
  dataHoldingsCsv,
  dataPositionsCsv,
  dataTransactionsCsv,
  isNetworkKey,
  type DataExportDataset,
  type DataLane,
  type DataPnlPeriod,
  type DataTxKind,
  type DataTxQuery,
  type DataWalletSet,
  type NetworkKey,
} from "@kletia/core";
import {
  HISTORY_LIMITS,
  isSnapshotRange,
  MAX_PRICE_SYMBOLS,
  parseWalletSet,
  pnl,
  positions,
  readDataPortfolio,
  readDataPrices,
  readDataStatus,
  readDataYields,
  readHistory,
  sessionScope,
  snapshots,
  startTracking,
  stopTracking,
  summary,
  trackingOf,
  trackingView,
  transaction,
  TRANSACTION_LIMITS,
  transactions,
  walletScope,
  type DataScope,
} from "../data/index.js";
import { PlatformError } from "../errors.js";
import { accountSessionOf, originOf, requireAccountOrigin, requireAccountSession } from "./accounts/auth.js";
import { requireApiKey } from "./auth.js";
import { authOf, booleanQuery, handle, HttpError, integerQuery, invalidRequest, isRecord, pathParam, queryParam } from "./context.js";
import { takeDataReads } from "./limits.js";

const ADDRESS_LIST_LENGTH = 200;

function sendJson(res: Response, body: unknown): void {
  res.status(200).json(body);
}

function walletSet(req: Request): DataWalletSet {
  return parseWalletSet({
    evm: queryParam(req, "evm", ADDRESS_LIST_LENGTH),
    solana: queryParam(req, "solana", ADDRESS_LIST_LENGTH),
    lane: queryParam(req, "lane", 16),
  });
}

/** The wallet set when the request names one; history without wallets lists everything of the key. */
function optionalWalletSet(req: Request): DataWalletSet | null {
  const evm = queryParam(req, "evm", ADDRESS_LIST_LENGTH);
  const solana = queryParam(req, "solana", ADDRESS_LIST_LENGTH);
  return (evm ?? "") === "" && (solana ?? "") === "" ? null : walletSet(req);
}

function networkQuery(req: Request): NetworkKey | undefined {
  const value = queryParam(req, "network", 32);
  if (value === undefined || value === "") return undefined;
  if (!isNetworkKey(value)) throw invalidRequest("network must be a Kletia network key (e.g. base, solana).", [{ path: "network", message: "Unknown network." }]);
  return value;
}

function laneQuery(req: Request, network: NetworkKey | undefined): DataLane {
  const value = queryParam(req, "lane", 16);
  if (value !== undefined && value !== "" && value !== "production" && value !== "testnet") {
    throw invalidRequest("lane must be production or testnet.", [{ path: "lane", message: "Expected production or testnet." }]);
  }
  if (network) return CHAINS[network].lane === "testnet" ? "testnet" : "production";
  return value === "testnet" ? "testnet" : "production";
}

function symbolsQuery(req: Request): string[] | undefined {
  const raw = queryParam(req, "symbols", 400);
  if (raw === undefined || raw.trim() === "") return undefined;
  const symbols = [...new Set(raw.split(",").map((symbol) => symbol.trim()).filter(Boolean))];
  if (symbols.length > MAX_PRICE_SYMBOLS || symbols.some((symbol) => !/^[A-Za-z0-9.$_-]{1,16}$/u.test(symbol))) {
    throw invalidRequest(`symbols takes 1 to ${MAX_PRICE_SYMBOLS} comma-separated symbols.`, [{ path: "symbols", message: "Invalid symbol list." }]);
  }
  return symbols;
}

function historyLimit(req: Request): number {
  return integerQuery(req, "limit", HISTORY_LIMITS.defaultLimit, 1, HISTORY_LIMITS.maxLimit);
}

function keyOf(req: Request): string {
  const keyId = authOf(req).keyId;
  if (!keyId) throw new HttpError(401, "API_KEY_REQUIRED", "This endpoint requires an API key.");
  return keyId;
}

function exportDataset(req: Request): DataExportDataset {
  const value = queryParam(req, "dataset", 16) ?? "holdings";
  if (!(DATA_EXPORT_DATASETS as readonly string[]).includes(value)) {
    throw invalidRequest(`dataset must be one of ${DATA_EXPORT_DATASETS.join(", ")}.`, [{ path: "dataset", message: "Unknown dataset." }]);
  }
  return value as DataExportDataset;
}

function exportFormat(req: Request): "csv" | "json" {
  const value = queryParam(req, "format", 8) ?? "csv";
  if (value !== "csv" && value !== "json") throw invalidRequest("format must be csv or json.", [{ path: "format", message: "Expected csv or json." }]);
  return value;
}

/* ------------------------------------------------- history callers */

/** Runs the account guards when the request carries a desk wallet session; otherwise passes. */
const optionalSession: RequestHandler = (req, res, next) => {
  if (!req.get(ACCOUNT_SESSION_HEADER)) {
    next();
    return;
  }
  requireAccountOrigin(req, res, (originError?: unknown) => {
    if (originError) next(originError);
    else requireAccountSession(req, res, next);
  });
};

/** A wallet session's tracked set, else an API key's named addresses (401 without either). */
async function scopeOf(req: Request): Promise<DataScope> {
  if (req.accountSession) {
    const scope = await sessionScope(accountSessionOf(req).wallet);
    if (!scope) throw new PlatformError("DATA_NOT_TRACKED", "Tracking is off for this wallet. Turn it on first (POST /v1/data/tracking).", 404);
    return scope;
  }
  const auth = authOf(req);
  if (!auth.keyId) throw new PlatformError("DATA_CALLER_REQUIRED", "Send an API key with evm= / solana= addresses, or a wallet session from the Kletia desk.", 401);
  return walletScope({ evm: queryParam(req, "evm", ADDRESS_LIST_LENGTH), solana: queryParam(req, "solana", ADDRESS_LIST_LENGTH), lane: queryParam(req, "lane", 16) }, auth);
}

function choice<T extends string>(req: Request, name: string, values: readonly T[]): T | undefined {
  const value = queryParam(req, name, 32);
  if (value === undefined || value === "") return undefined;
  if (!(values as readonly string[]).includes(value)) throw invalidRequest(`${name} must be one of ${values.join(", ")}.`, [{ path: name, message: "Unknown value." }]);
  return value as T;
}

function timeQuery(req: Request, name: string): string | undefined {
  const value = queryParam(req, name, 40);
  if (value === undefined || value === "") return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalidRequest(`${name} must be an ISO time.`, [{ path: name, message: "Invalid time." }]);
  return new Date(time).toISOString();
}

function transactionQuery(req: Request): DataTxQuery {
  const network = networkQuery(req);
  const kind = choice<DataTxKind>(req, "kind", DATA_TX_KINDS);
  const asset = queryParam(req, "asset", 64);
  const protocol = queryParam(req, "protocol", 64);
  const from = timeQuery(req, "from");
  const to = timeQuery(req, "to");
  const cursor = queryParam(req, "cursor", 4_000);
  return {
    ...(network ? { network } : {}),
    ...(kind ? { kind } : {}),
    ...(asset ? { asset } : {}),
    ...(protocol ? { protocol } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(booleanQuery(req, "kletiaOnly") ? { kletiaOnly: true } : {}),
    ...(cursor ? { cursor } : {}),
    limit: integerQuery(req, "limit", TRANSACTION_LIMITS.defaultLimit, 1, TRANSACTION_LIMITS.maxLimit),
  };
}

/**
 * One unit per account of a history read: provider pages are cached a minute
 * and paced per provider, so further rounds of a page cost the providers,
 * not the caller's budget (a tracked set of 12 accounts fits a desk load).
 */
function historyUnits(scope: DataScope, perAccount = 1): number {
  return scope.wallets.accounts.length * perAccount;
}

function proofsOf(body: unknown): string[] {
  if (body === undefined || body === null) return [];
  if (!isRecord(body)) throw invalidRequest("The body must be a JSON object.");
  const proofs = body.proofs ?? [];
  if (!Array.isArray(proofs) || proofs.length > 3 || proofs.some((token) => typeof token !== "string" || token.length > 200)) {
    throw invalidRequest("proofs takes up to 3 wallet session tokens.", [{ path: "proofs", message: "Expected session tokens." }]);
  }
  return proofs as string[];
}

function bodyLane(body: unknown): DataLane {
  const lane = isRecord(body) ? body.lane : undefined;
  if (lane === undefined) return "production";
  if (lane !== "production" && lane !== "testnet") throw invalidRequest("lane must be production or testnet.", [{ path: "lane", message: "Expected production or testnet." }]);
  return lane;
}

/** The export as a download: the same rows as the read endpoints, as CSV or JSON. */
async function sendExport(req: Request, res: Response): Promise<void> {
  const dataset = exportDataset(req);
  const format = exportFormat(req);
  let json: unknown;
  let csv: string;
  if (dataset === "transactions") {
    const scope = await scopeOf(req);
    takeDataReads(req, historyUnits(scope));
    const page = await transactions(scope, transactionQuery(req));
    json = page;
    csv = dataTransactionsCsv(page);
  } else if (dataset === "history") {
    const keyId = keyOf(req);
    const wallets = optionalWalletSet(req);
    takeDataReads(req, 1);
    const history = await readHistory(keyId, { wallets, limit: historyLimit(req) });
    json = history;
    csv = dataHistoryCsv(history);
  } else {
    const set = walletSet(req);
    takeDataReads(req, set.accounts.length);
    const portfolio = await readDataPortfolio(set);
    json = dataset === "holdings"
      ? { holdings: portfolio.holdings, failures: portfolio.failures, asOf: portfolio.asOf }
      : { positions: portfolio.positions, health: portfolio.health, failures: portfolio.failures, asOf: portfolio.asOf };
    csv = dataset === "holdings" ? dataHoldingsCsv(portfolio) : dataPositionsCsv(portfolio);
  }
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Disposition", `attachment; filename="kletia-${dataset}-${day}.${format}"`);
  if (format === "json") {
    sendJson(res, json);
    return;
  }
  res.status(200).type("text/csv; charset=utf-8").send(csv);
}

/**
 * The reads that name wallet addresses also answer POST with the same
 * parameters in a JSON body (`evm` and `solana` as a string or an array),
 * so addresses stay out of URLs and the access logs that record them. GET
 * keeps working and is deprecated for these reads.
 */
export const DATA_BODY_READS = Object.freeze([
  "/data/portfolio",
  "/data/positions",
  "/data/history",
  "/data/export",
  "/data/transactions",
  "/data/transactions/:id",
  "/data/pnl",
  "/data/snapshots",
  "/data/summary",
] as const);

const BODY_FIELD_LENGTH = 4_000;

/** POST variants: the JSON body becomes the parameters the GET handlers read (never merged with the URL query). */
const bodyAsQuery: RequestHandler = (req, _res, next) => {
  const body: unknown = req.body ?? {};
  if (!isRecord(body)) {
    next(invalidRequest("The body must be a JSON object of the read's parameters."));
    return;
  }
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    let text: string | null = null;
    if (typeof value === "string") text = value;
    else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
    else if (typeof value === "boolean") text = value ? "true" : "false";
    else if (Array.isArray(value) && value.length <= 8 && value.every((entry) => typeof entry === "string" && !entry.includes(","))) text = value.join(",");
    if (text === null || text.length > BODY_FIELD_LENGTH || !/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(name)) {
      next(invalidRequest(`Body field ${name.slice(0, 32)} must be a string, number, boolean or a list of strings.`, [{ path: name.slice(0, 32), message: "Invalid value." }]));
      return;
    }
    query[name] = text;
  }
  Object.defineProperty(req, "query", { value: query, configurable: true, enumerable: true, writable: true });
  next();
};

export function dataHandlers(): Record<string, RequestHandler[]> {
  const reads = getDataHandlers();
  const posts = Object.fromEntries(
    DATA_BODY_READS.map((path) => {
      const handlers = reads[`get ${path}`];
      if (!handlers) throw new Error(`Data read ${path} has no GET handler.`);
      return [`post ${path}`, [bodyAsQuery, ...handlers]];
    }),
  );
  return { ...reads, ...posts };
}

function getDataHandlers(): Record<string, RequestHandler[]> {
  return {
    "get /data/portfolio": [
      handle(async (req, res) => {
        const set = walletSet(req);
        takeDataReads(req, set.accounts.length);
        sendJson(res, { portfolio: await readDataPortfolio(set) });
      }),
    ],
    "get /data/positions": [
      optionalSession,
      handle(async (req, res) => {
        const extras = booleanQuery(req, "extras");
        const scope = req.accountSession ? await scopeOf(req) : walletScope({ evm: queryParam(req, "evm", ADDRESS_LIST_LENGTH), solana: queryParam(req, "solana", ADDRESS_LIST_LENGTH), lane: queryParam(req, "lane", 16) }, authOf(req));
        takeDataReads(req, scope.wallets.accounts.length * (extras ? 2 : 1));
        sendJson(res, await positions(scope, { extras }));
      }),
    ],
    "get /data/transactions": [
      optionalSession,
      handle(async (req, res) => {
        const scope = await scopeOf(req);
        const query = transactionQuery(req);
        takeDataReads(req, historyUnits(scope));
        sendJson(res, await transactions(scope, query));
      }),
    ],
    "get /data/transactions/:id": [
      optionalSession,
      handle(async (req, res) => {
        const scope = await scopeOf(req);
        takeDataReads(req, scope.wallets.accounts.length);
        sendJson(res, { transaction: await transaction(scope, pathParam(req, "id").slice(0, 140)) });
      }),
    ],
    "get /data/pnl": [
      optionalSession,
      handle(async (req, res) => {
        const scope = await scopeOf(req);
        const period = choice<DataPnlPeriod>(req, "period", DATA_PNL_PERIODS) ?? "all";
        takeDataReads(req, historyUnits(scope, 2));
        sendJson(res, await pnl(scope, { period }));
      }),
    ],
    "get /data/snapshots": [
      optionalSession,
      handle(async (req, res) => {
        const scope = await scopeOf(req);
        const range = queryParam(req, "range", 8) ?? "30d";
        if (!isSnapshotRange(range)) throw invalidRequest("range must be 24h, 7d, 30d or all.", [{ path: "range", message: "Unknown range." }]);
        takeDataReads(req, 1);
        sendJson(res, await snapshots(scope, { range }));
      }),
    ],
    "get /data/summary": [
      optionalSession,
      handle(async (req, res) => {
        const scope = await scopeOf(req);
        takeDataReads(req, historyUnits(scope, 2));
        sendJson(res, { summary: await summary(scope) });
      }),
    ],
    "get /data/tracking": [
      requireAccountOrigin,
      requireAccountSession,
      handle(async (req, res) => {
        const record = await trackingOf(accountSessionOf(req).wallet);
        sendJson(res, { tracking: record ? trackingView(record) : null });
      }),
    ],
    "post /data/tracking": [
      requireAccountOrigin,
      requireAccountSession,
      handle(async (req, res) => {
        const record = await startTracking(accountSessionOf(req).wallet, { lane: bodyLane(req.body), proofs: proofsOf(req.body), origin: originOf(req) });
        res.status(201).json({ tracking: trackingView(record) });
      }),
    ],
    "delete /data/tracking": [
      requireAccountOrigin,
      requireAccountSession,
      handle(async (req, res) => {
        sendJson(res, await stopTracking(accountSessionOf(req).wallet));
      }),
    ],
    "get /data/history": [
      requireApiKey,
      handle(async (req, res) => {
        const keyId = keyOf(req);
        const wallets = optionalWalletSet(req);
        takeDataReads(req, 1);
        sendJson(res, await readHistory(keyId, { wallets, limit: historyLimit(req) }));
      }),
    ],
    "get /data/markets/yields": [
      handle(async (req, res) => {
        const network = networkQuery(req);
        const asset = queryParam(req, "asset", 16);
        takeDataReads(req, 1);
        sendJson(res, await readDataYields({ lane: laneQuery(req, network), ...(network ? { network } : {}), ...(asset ? { asset } : {}) }));
      }),
    ],
    "get /data/markets/prices": [
      handle(async (req, res) => {
        const network = networkQuery(req);
        const symbols = symbolsQuery(req);
        takeDataReads(req, 1);
        sendJson(res, await readDataPrices(symbols, { lane: laneQuery(req, network), ...(network ? { network } : {}) }));
      }),
    ],
    "get /data/markets/status": [
      handle(async (req, res) => {
        takeDataReads(req, 1);
        sendJson(res, await readDataStatus());
      }),
    ],
    "get /data/export": [optionalSession, handle(sendExport)],
  };
}
