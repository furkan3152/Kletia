/**
 * OpenAPI fragments of the data API (`/v1/data/*`, docs/platform/data.md):
 * portfolio, positions, history, market yields, prices and status, and the
 * CSV / JSON export. Merged by openapi.ts.
 */
import { DATA_EXPORT_DATASETS, LENDING_HEALTH_THRESHOLDS, NETWORK_KEYS } from "@kletia/core";
import { DATA_CACHE_TTL_MS, HISTORY_LIMITS, MAX_PRICE_SYMBOLS, WALLET_LIMITS } from "../data/index.js";
import { DATA_READS_PER_MINUTE } from "./limits.js";
import { arrayOf, bool, errors, KEY_REQUIRED, num, obj, ok, ref, REQUEST_ID_HEADER, str, type JsonObject } from "./openapiKit.js";

const TAGS = ["Data"];
const ISO = str({ format: "date-time" });
const NULLABLE_ISO: JsonObject = { type: ["string", "null"], format: "date-time" };
const NETWORK = str({ enum: [...NETWORK_KEYS] });
const NULLABLE_NUMBER: JsonObject = { type: ["number", "null"] };
const NULLABLE_STRING: JsonObject = { type: ["string", "null"] };
const SOURCE = str({
  enum: ["usd-par", "jupiter", "chainlink", "pyth", "venue-rate", "testnet", "unpriced", "adapter", "aave-oracle", "lending-metrics", "health-probe", "snapshot", "kletia"],
  description: "Where the value comes from.",
});
const FAILURES = arrayOf(ref("DataFailure"), { description: "Accounts, venues and markets that could not be read (unknown, never empty)." });

const BUDGET = `Spends the data budget (${DATA_READS_PER_MINUTE.key} units a minute per API key, ${DATA_READS_PER_MINUTE.address} per address without one; 429 RATE_LIMITED after)`;

const walletParameters: JsonObject[] = [
  { name: "evm", in: "query", required: false, description: `Comma-separated EVM addresses (at most ${WALLET_LIMITS.evm}). Name evm, solana or both.`, schema: str({ maxLength: 200, examples: ["0x4f183e308f24c81c05303821AD025812fBFd807D"] }) },
  { name: "solana", in: "query", required: false, description: `Comma-separated Solana addresses (at most ${WALLET_LIMITS.solana}).`, schema: str({ maxLength: 200 }) },
  { name: "lane", in: "query", required: false, description: "Production networks (default) or test networks; the two never mix.", schema: str({ enum: ["production", "testnet"] }) },
];

const networkParameter: JsonObject = { name: "network", in: "query", required: false, description: "One network (its lane wins over `lane`).", schema: NETWORK };
const laneParameter: JsonObject = { name: "lane", in: "query", required: false, schema: str({ enum: ["production", "testnet"] }) };
const historyLimitParameter: JsonObject = {
  name: "limit", in: "query", required: false, description: `Newest entries to return (default ${HISTORY_LIMITS.defaultLimit}).`,
  schema: { type: "integer", minimum: 1, maximum: HISTORY_LIMITS.maxLimit },
};

export function dataSchemas(): JsonObject {
  return {
    DataUsdValue: obj(
      {
        usd: { ...NULLABLE_NUMBER, description: "Null when unknown (see reason); never 0 for unknown." },
        source: SOURCE,
        asOf: { ...NULLABLE_ISO, description: "When the value was read." },
        reason: str(),
      },
      ["usd", "source", "asOf"],
    ),
    DataFailure: obj({ subject: str(), code: str(), message: str() }, ["subject", "code", "message"]),
    DataHolding: obj(
      { account: ref("AccountId"), network: NETWORK, asset: ref("AssetId"), symbol: str(), amount: str({ description: "Base units." }), formatted: str(), value: ref("DataUsdValue") },
      ["account", "network", "asset", "symbol", "amount", "formatted", "value"],
    ),
    DataPosition: obj(
      {
        id: str({ description: "Registry venue id (`<network>:<protocol>:<slug>`), the pool or Comet of a debt, or `<network>:<protocol>:<symbol>` for a staking token." }),
        account: ref("AccountId"),
        network: NETWORK,
        protocol: NULLABLE_STRING,
        name: str(),
        kind: str({ enum: ["supply", "vault", "borrow", "staking"] }),
        symbol: str(),
        amount: { ...NULLABLE_STRING, description: "Underlying amount; null for an Aave debt (known in USD only)." },
        value: ref("DataUsdValue"),
        apy: { ...NULLABLE_NUMBER, description: "Supply APY as a fraction." },
        inWallet: bool({ description: "Staking tokens sit in the wallet: their value is counted with the holdings, not again." }),
      },
      ["id", "account", "network", "protocol", "name", "kind", "symbol", "amount", "value", "apy", "inWallet"],
    ),
    LendingHealth: obj(
      {
        account: ref("AccountId"),
        network: NETWORK,
        protocol: str(),
        market: str(),
        healthFactor: { ...NULLABLE_NUMBER, description: "Aave V3 and SparkLend; null for Compound V3 (no health factor) and unread markets." },
        status: str({ enum: ["ok", "warning", "critical", "no-debt", "unknown"], description: `warning below ${LENDING_HEALTH_THRESHOLDS.warning}, critical below ${LENDING_HEALTH_THRESHOLDS.critical} or when liquidatable.` }),
        source: SOURCE,
        asOf: NULLABLE_ISO,
        reason: str(),
      },
      ["account", "network", "protocol", "market", "healthFactor", "status", "source", "asOf"],
    ),
    DataAllocationSlice: obj({ key: str(), label: str(), usd: num(), share: num({ minimum: 0, maximum: 1 }) }, ["key", "label", "usd", "share"]),
    DataValueChange: obj(
      {
        usd: NULLABLE_NUMBER,
        pct: { ...NULLABLE_NUMBER, description: "Fraction of the earlier value." },
        since: NULLABLE_ISO,
        source: str({ const: "snapshot" }),
        estimate: bool({ const: true }),
        reason: str(),
      },
      ["usd", "pct", "since", "source", "estimate"],
    ),
    DataPortfolio: obj(
      {
        wallets: obj({ evm: arrayOf(str()), solana: arrayOf(str()), lane: str({ enum: ["production", "testnet"] }) }, ["evm", "solana", "lane"]),
        accounts: arrayOf(ref("AccountId")),
        totals: obj(
          {
            net: ref("DataUsdValue"),
            wallet: ref("DataUsdValue"),
            positions: ref("DataUsdValue"),
            debt: ref("DataUsdValue"),
            unpriced: { type: "integer", minimum: 0 },
            complete: bool({ description: "False when something was unpriced or unread: the totals cover the known part only." }),
          },
          ["net", "wallet", "positions", "debt", "unpriced", "complete"],
        ),
        change24h: { ...ref("DataValueChange"), description: "Against this API instance's reading from about 24 hours ago (an estimate)." },
        pnl: { ...ref("DataValueChange"), description: "Against the first reading of these wallets (an estimate: deposits and withdrawals count too)." },
        allocation: obj(
          { byNetwork: arrayOf(ref("DataAllocationSlice")), byAsset: arrayOf(ref("DataAllocationSlice")), byProtocol: arrayOf(ref("DataAllocationSlice")) },
          ["byNetwork", "byAsset", "byProtocol"],
        ),
        holdings: arrayOf(ref("DataHolding")),
        positions: arrayOf(ref("DataPosition")),
        health: arrayOf(ref("LendingHealth")),
        failures: FAILURES,
        asOf: ISO,
      },
      ["wallets", "accounts", "totals", "change24h", "pnl", "allocation", "holdings", "positions", "health", "failures", "asOf"],
    ),
    DataPortfolioResponse: obj({ portfolio: ref("DataPortfolio") }, ["portfolio"]),
    DataPositions: obj(
      { accounts: arrayOf(ref("AccountId")), positions: arrayOf(ref("DataPosition")), health: arrayOf(ref("LendingHealth")), failures: FAILURES, asOf: ISO },
      ["accounts", "positions", "health", "failures", "asOf"],
    ),
    DataHistoryEntry: obj(
      {
        kind: str({ enum: ["intent", "receipt", "link"] }),
        id: str(),
        at: ISO,
        status: str(),
        title: str(),
        networks: arrayOf(NETWORK),
        intentId: NULLABLE_STRING,
        source: str({ const: "kletia" }),
      },
      ["kind", "id", "at", "status", "title", "networks", "intentId", "source"],
    ),
    DataHistory: obj({ entries: arrayOf(ref("DataHistoryEntry")), filtered: bool(), asOf: ISO }, ["entries", "filtered", "asOf"]),
    DataYieldRow: obj(
      {
        venue: str(),
        protocol: str(),
        network: NETWORK,
        name: str(),
        asset: str(),
        apy: NULLABLE_NUMBER,
        apyBasis: str({ enum: ["rate", "share-price", "unavailable"] }),
        supplied: NULLABLE_STRING,
        utilization: NULLABLE_NUMBER,
        executable: bool(),
        depositText: str({ description: "A sentence for POST /v1/intents with an `[EDIT AMOUNT]` placeholder to replace." }),
        source: SOURCE,
        asOf: NULLABLE_ISO,
        reason: str(),
      },
      ["venue", "protocol", "network", "name", "asset", "apy", "apyBasis", "supplied", "utilization", "executable", "depositText", "source", "asOf"],
    ),
    DataYields: obj({ yields: arrayOf(ref("DataYieldRow")), failures: FAILURES, asOf: ISO }, ["yields", "failures", "asOf"]),
    DataPriceRow: obj({ symbol: str(), network: { type: ["string", "null"], enum: [...NETWORK_KEYS, null] }, asset: NULLABLE_STRING, value: ref("DataUsdValue") }, ["symbol", "network", "asset", "value"]),
    DataPrices: obj({ prices: arrayOf(ref("DataPriceRow")), asOf: ISO }, ["prices", "asOf"]),
    DataMarketStatus: obj(
      {
        networks: arrayOf(obj(
          { network: NETWORK, name: str(), environment: str({ enum: ["mainnet", "testnet"] }), ok: bool(), latencyMs: num(), height: NULLABLE_STRING, source: str({ const: "health-probe" }), asOf: ISO },
          ["network", "name", "environment", "ok", "latencyMs", "height", "source", "asOf"],
        )),
        routes: {
          oneOf: [
            arrayOf(obj(
              {
                venue: str(), network: NETWORK, destination: NETWORK, attempts: { type: "integer", minimum: 0 },
                p50Ms: NULLABLE_NUMBER, p95Ms: NULLABLE_NUMBER, failureRate: num(), rateLimited: { type: "integer", minimum: 0 },
                breaker: str({ enum: ["closed", "open", "half-open"] }),
              },
              ["venue", "network", "destination", "attempts", "p50Ms", "p95Ms", "failureRate", "rateLimited", "breaker"],
            )),
            { type: "null" },
          ],
        },
        routesReason: str(),
        asOf: ISO,
      },
      ["networks", "routes", "asOf"],
    ),
  };
}

function get(operationId: string, summary: string, description: string, parameters: JsonObject[], response: JsonObject, extra: JsonObject = {}): JsonObject {
  return { get: { operationId, tags: TAGS, summary, description, parameters, responses: { "200": response, ...errors() }, ...extra } };
}

export function dataPaths(): JsonObject {
  const csvResponse: JsonObject = {
    description: "The dataset as a download (`Content-Disposition: attachment`).",
    headers: { "X-Request-Id": REQUEST_ID_HEADER, "Content-Disposition": { schema: str() } },
    content: {
      "text/csv": { schema: str({ description: "RFC 4180 CSV with a header row; unknown values are empty cells; text cells that start like a formula are prefixed with an apostrophe." }) },
      "application/json": { schema: { type: "object" } },
    },
  };
  return {
    "/v1/data/portfolio": get(
      "getDataPortfolio",
      "Everything a wallet set holds, across every network of the lane",
      `Wallet holdings, venue positions (lending, savings, vaults, Jupiter Lend), liquid-staking tokens, Aave V3, SparkLend and Compound V3 debt with health, totals, allocation by network, asset and protocol, the 24-hour change and a PnL estimate against this API's earlier readings. Each value carries \`source\` and \`asOf\`; unknown values are null with a \`reason\`. Cached ${DATA_CACHE_TTL_MS.portfolio / 1000} s per wallet set. ${BUDGET}: one unit per account of the wallet set.`,
      walletParameters,
      ok("DataPortfolioResponse", "The portfolio."),
    ),
    "/v1/data/positions": get(
      "getDataPositions",
      "Positions, debts and lending health of a wallet set",
      `The positions part of the portfolio read (same cache). ${BUDGET}: one unit per account.`,
      walletParameters,
      ok("DataPositions", "Positions and health."),
    ),
    "/v1/data/history": get(
      "getDataHistory",
      "Kletia activity of the calling key",
      `The key's intents, the receipts issued for them and its intent links, newest first. With \`evm\` / \`solana\`, only intents planned for those wallets (links are left out). ${BUDGET}: one unit.`,
      [...walletParameters.slice(0, 2), historyLimitParameter],
      ok("DataHistory", "The timeline."),
      { security: KEY_REQUIRED },
    ),
    "/v1/data/markets/yields": get(
      "getDataYields",
      "Supply APYs of every venue Kletia knows",
      `Every lending, savings and vault venue of the lane, best APY first; a venue whose rate cannot be read is listed with \`apy: null\` and the reason. Cached ${DATA_CACHE_TTL_MS.yields / 1000} s. ${BUDGET}: one unit.`,
      [networkParameter, laneParameter, { name: "asset", in: "query", required: false, description: "Underlying symbol, e.g. USDC.", schema: str({ maxLength: 16 }) }],
      ok("DataYields", "Yields."),
    ),
    "/v1/data/markets/prices": get(
      "getDataPrices",
      "USD prices of listed assets",
      `Advisory prices (stablecoins at par, Jupiter, Chainlink) with source and reading time. Cached ${DATA_CACHE_TTL_MS.prices / 1000} s. ${BUDGET}: one unit.`,
      [{ name: "symbols", in: "query", required: false, description: `Comma-separated symbols (at most ${MAX_PRICE_SYMBOLS}); default ETH, SOL, POL, cbBTC, wstETH, USDC and USDT.`, schema: str({ maxLength: 400 }) }, networkParameter, laneParameter],
      ok("DataPrices", "Prices."),
    ),
    "/v1/data/markets/status": get(
      "getDataStatus",
      "Network status and route statistics",
      `The health probe of every network; route statistics per venue and network pair when the deployment records them (else \`routes: null\` with the reason). Cached ${DATA_CACHE_TTL_MS.status / 1000} s. ${BUDGET}: one unit.`,
      [],
      ok("DataMarketStatus", "Status."),
    ),
    "/v1/data/export": get(
      "exportData",
      "Export holdings, positions or history as CSV or JSON",
      `\`dataset=holdings|positions\` takes a wallet set (one unit per account); \`dataset=history\` needs an API key (one unit). ${BUDGET}.`,
      [
        { name: "dataset", in: "query", required: false, schema: str({ enum: [...DATA_EXPORT_DATASETS], default: "holdings" }) },
        { name: "format", in: "query", required: false, schema: str({ enum: ["csv", "json"], default: "csv" }) },
        ...walletParameters,
        historyLimitParameter,
      ],
      csvResponse,
    ),
  };
}

/** The Data tag. */
export const DATA_TAG: JsonObject = { name: "Data", description: "Read-only dashboard data: a wallet set's holdings, positions, health and activity across every network, plus venue yields, prices and network status." };
