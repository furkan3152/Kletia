/**
 * Data API routes (docs/platform/data.md), read-only:
 *
 *   GET /v1/data/portfolio?evm=&solana=&lane=     holdings, positions, totals, allocation, estimates
 *   GET /v1/data/positions?evm=&solana=&lane=     positions, debts and lending health
 *   GET /v1/data/history?evm=&solana=&limit=      the calling key's intents, receipts and links
 *   GET /v1/data/markets/yields?network=&asset=   venue APYs
 *   GET /v1/data/markets/prices?symbols=&network= USD prices
 *   GET /v1/data/markets/status                   network status and route statistics
 *   GET /v1/data/export?dataset=&format=          holdings, positions or history as CSV or JSON
 *
 * Every route is open to publishable keys; history needs a key (it lists the
 * key's own activity). Each read spends the data budget (limits.ts).
 */
import type { Request, RequestHandler, Response } from "express";
import {
  CHAINS,
  DATA_EXPORT_DATASETS,
  dataHistoryCsv,
  dataHoldingsCsv,
  dataPositionsCsv,
  isNetworkKey,
  type DataExportDataset,
  type DataLane,
  type DataWalletSet,
  type NetworkKey,
} from "@kletia/core";
import {
  HISTORY_LIMITS,
  MAX_PRICE_SYMBOLS,
  parseWalletSet,
  readDataPortfolio,
  readDataPositions,
  readDataPrices,
  readDataStatus,
  readDataYields,
  readHistory,
} from "../data/index.js";
import { requireApiKey } from "./auth.js";
import { authOf, handle, HttpError, integerQuery, invalidRequest, queryParam } from "./context.js";
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

/** The export as a download: the same rows as the read endpoints, as CSV or JSON. */
async function sendExport(req: Request, res: Response): Promise<void> {
  const dataset = exportDataset(req);
  const format = exportFormat(req);
  let json: unknown;
  let csv: string;
  if (dataset === "history") {
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

export function dataHandlers(): Record<string, RequestHandler[]> {
  return {
    "get /data/portfolio": [
      handle(async (req, res) => {
        const set = walletSet(req);
        takeDataReads(req, set.accounts.length);
        sendJson(res, { portfolio: await readDataPortfolio(set) });
      }),
    ],
    "get /data/positions": [
      handle(async (req, res) => {
        const set = walletSet(req);
        takeDataReads(req, set.accounts.length);
        sendJson(res, await readDataPositions(set));
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
    "get /data/export": [handle(sendExport)],
  };
}
