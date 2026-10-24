/**
 * OpenAPI fragments of the data API (`/v1/data/*`, docs/platform/data.md):
 * portfolio, positions, history, market yields, prices and status, on-chain
 * transactions, PnL, value snapshots, the assistant summary, tracking, and
 * the CSV / JSON export. Merged by openapi.ts.
 */
import {
  ACCOUNT_SESSION_HEADER,
  ACCOUNT_SESSION_TOKEN_PATTERN,
  DATA_EXPORT_DATASETS,
  DATA_PNL_PERIODS,
  DATA_SNAPSHOT_RANGES,
  DATA_TX_KINDS,
  LENDING_HEALTH_THRESHOLDS,
  NETWORK_KEYS,
} from "@kletia/core";
import { DATA_CACHE_TTL_MS, HISTORY_LIMITS, MAX_PRICE_SYMBOLS, TRANSACTION_LIMITS, WALLET_LIMITS } from "../data/index.js";
import { DATA_READS_PER_MINUTE } from "./limits.js";
import { arrayOf, bool, errors, int, jsonBody, KEY_REQUIRED, nullable, num, obj, ok, ref, REQUEST_ID_HEADER, str, type JsonObject } from "./openapiKit.js";

const TAGS = ["Data"];
const ISO = str({ format: "date-time" });
const NULLABLE_ISO: JsonObject = { type: ["string", "null"], format: "date-time" };
const NETWORK = str({ enum: [...NETWORK_KEYS] });
const NULLABLE_NUMBER: JsonObject = { type: ["number", "null"] };
const NULLABLE_STRING: JsonObject = { type: ["string", "null"] };
const SOURCE = str({
  enum: ["usd-par", "jupiter", "chainlink", "pyth", "venue-rate", "testnet", "unpriced", "adapter", "aave-oracle", "lending-metrics", "health-probe", "snapshot", "kletia", "kamino-api", "etherscan", "alchemy", "helius", "solana-rpc", "defillama", "coingecko", "fifo"],
  description: "Where the value comes from.",
});
const FAILURES = arrayOf(ref("DataFailure"), { description: "Accounts, venues and markets that could not be read (unknown, never empty)." });

const BUDGET = `Spends the data budget (${DATA_READS_PER_MINUTE.key} units a minute per API key, ${DATA_READS_PER_MINUTE.address} per address without one; 429 RATE_LIMITED after)`;

const walletParameters: JsonObject[] = [
  { name: "evm", in: "query", required: false, description: `Comma-separated EVM addresses (at most ${WALLET_LIMITS.evm}). Name evm, solana or both.`, schema: str({ maxLength: 200, examples: ["0x4f183e308f24c81c05303821AD025812fBFd807D"] }) },
  { name: "solana", in: "query", required: false, description: `Comma-separated Solana addresses (at most ${WALLET_LIMITS.solana}).`, schema: str({ maxLength: 200 }) },
  { name: "lane", in: "query", required: false, description: "Production networks (default) or test networks; the two never mix.", schema: str({ enum: ["production", "testnet"] }) },
];

const SESSION_HEADER: JsonObject = {
  name: ACCOUNT_SESSION_HEADER,
  in: "header",
  required: false,
  description: "A wallet session from the Kletia desk (first-party Origin): the read covers that wallet's tracked set only, and evm / solana are ignored.",
  schema: str({ pattern: ACCOUNT_SESSION_TOKEN_PATTERN.source }),
};
const TX_PROVIDER = str({ enum: ["etherscan", "alchemy", "helius", "solana-rpc"] });
const TX_ASSET = obj(
  { symbol: str(), address: { ...NULLABLE_STRING, description: "Contract or mint; null for the gas asset." }, decimals: { type: ["integer", "null"] }, id: { ...NULLABLE_STRING, description: "Kletia asset id when listed." } },
  ["symbol", "address", "decimals", "id"],
);
const CALLER_NOTE =
  "Caller: a desk wallet session (its tracked set; 404 DATA_NOT_TRACKED until tracking is on) or an API key with `evm` / `solana` (public on-chain data; Kletia links only to the key's own intents); else 401 DATA_CALLER_REQUIRED.";

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
      { accounts: arrayOf(ref("AccountId")), positions: arrayOf(ref("DataPosition")), health: arrayOf(ref("LendingHealth")), failures: FAILURES, extras: ref("DataCoverageExtras"), asOf: ISO },
      ["accounts", "positions", "health", "failures", "asOf"],
    ),
    DataSection: obj(
      { rows: arrayOf({ type: "object" }), reason: { ...NULLABLE_STRING, description: "Null when read in full; otherwise why rows are missing." }, source: str({ enum: ["perps", "orders", "automations", "policy", "predictions"] }), asOf: NULLABLE_ISO },
      ["rows", "reason", "source", "asOf"],
    ),
    DataCoverageExtras: obj(
      {
        perps: { ...ref("DataSection"), description: "Open perps positions (GMX v2, Hyperliquid, Drift) with the account." },
        orders: { ...ref("DataSection"), description: "Open native orders (CoW Protocol, Jupiter Trigger and Recurring)." },
        automations: { ...ref("DataSection"), description: "The caller's automations (an API key's or the desk wallet's)." },
        agentSpend: { ...ref("DataSection"), description: "24 h / 7 d USD spend of the agent keys below the calling API key." },
        predictions: { ...ref("DataSection"), description: "Polymarket positions of the set's EVM wallets on Polygon and of the Polymarket wallet found for each (Safe, Deposit Wallet or Proxy; shares, average and current price, value, cost, PnL, redeemable) with the account and `holderKind` (account, safe, deposit, proxy)." },
        predictionWallets: arrayOf(
          obj(
            { account: str(), address: str(), kind: str({ enum: ["safe", "proxy", "deposit"] }), owner: str(), tradable: bool(), onProfile: bool(), balances: nullable(obj({ pusd: str(), usdce: str() }, ["pusd", "usdce"])) },
            ["account", "address", "kind", "owner", "tradable", "onProfile", "balances"],
          ),
          { description: "The Polymarket wallets found for the set's EVM wallets (derived, then checked on Polygon) whose positions `predictions` includes." },
        ),
      },
      ["perps", "orders", "automations", "agentSpend", "predictions", "predictionWallets"],
    ),
    DataTxLeg: obj(
      {
        asset: TX_ASSET,
        amount: NULLABLE_STRING,
        direction: str({ enum: ["in", "out"] }),
        usdAtTime: { ...NULLABLE_NUMBER, description: "USD at the transaction's time; null with a reason (unlisted token, no price found)." },
        priceSource: { type: ["string", "null"], enum: ["defillama", "coingecko", null] },
        reason: str(),
      },
      ["asset", "amount", "direction", "usdAtTime", "priceSource"],
    ),
    DataTransaction: obj(
      {
        id: str({ description: "`<network>:<hash or signature>`." }),
        network: NETWORK,
        hash: str(),
        account: ref("AccountId"),
        time: ISO,
        block: { type: ["integer", "null"] },
        kind: str({ enum: [...DATA_TX_KINDS] }),
        status: str({ enum: ["success", "failed"] }),
        legs: arrayOf(ref("DataTxLeg")),
        fee: { oneOf: [obj({ asset: TX_ASSET, amount: str(), usd: NULLABLE_NUMBER, reason: str() }, ["asset", "amount", "usd"]), { type: "null" }], description: "Paid by this wallet; null when someone else paid or the provider does not report fees." },
        counterparty: NULLABLE_STRING,
        protocol: { oneOf: [obj({ id: NULLABLE_STRING, label: str(), role: NULLABLE_STRING }, ["id", "label", "role"]), { type: "null" }] },
        method: NULLABLE_STRING,
        kletiaIntentId: { ...NULLABLE_STRING, description: "The Kletia intent this transaction was a step of, when the caller may see it." },
        kletiaReceiptId: NULLABLE_STRING,
        source: TX_PROVIDER,
        explorerUrl: str(),
      },
      ["id", "network", "hash", "account", "time", "block", "kind", "status", "legs", "fee", "counterparty", "protocol", "method", "kletiaIntentId", "kletiaReceiptId", "source", "explorerUrl"],
    ),
    DataTxCoverage: obj(
      {
        account: ref("AccountId"),
        network: NETWORK,
        provider: { type: ["string", "null"], enum: ["etherscan", "alchemy", "helius", "solana-rpc", null] },
        status: str({ enum: ["ok", "partial", "not-configured", "unsupported", "failed"] }),
        reason: str(),
        env: arrayOf(str(), { description: "Environment variables that would enable this account's history." }),
      },
      ["account", "network", "provider", "status"],
    ),
    DataTransactionPage: obj(
      { transactions: arrayOf(ref("DataTransaction")), cursor: { ...NULLABLE_STRING, description: "Pass back for older rows; null at the end." }, coverage: arrayOf(ref("DataTxCoverage")), asOf: ISO },
      ["transactions", "cursor", "coverage", "asOf"],
    ),
    DataTransactionResponse: obj({ transaction: ref("DataTransaction") }, ["transaction"]),
    DataPnl: obj(
      {
        period: str({ enum: [...DATA_PNL_PERIODS] }),
        since: NULLABLE_ISO,
        method: str({ const: "fifo" }),
        estimate: bool({ const: true }),
        assets: arrayOf(obj(
          { key: str(), symbol: str(), openQuantity: num(), costBasisUsd: NULLABLE_NUMBER, realizedUsd: NULLABLE_NUMBER, unrealizedUsd: NULLABLE_NUMBER, currentUsd: NULLABLE_NUMBER, reason: str() },
          ["key", "symbol", "openQuantity", "costBasisUsd", "realizedUsd", "unrealizedUsd", "currentUsd"],
        )),
        totals: obj({ realizedUsd: num(), unrealizedUsd: num(), complete: bool() }, ["realizedUsd", "unrealizedUsd", "complete"]),
        coverage: arrayOf(ref("DataTxCoverage")),
        source: str({ const: "fifo" }),
        asOf: ISO,
      },
      ["period", "since", "method", "estimate", "assets", "totals", "coverage", "source", "asOf"],
    ),
    DataSnapshotSeries: obj(
      {
        range: str({ enum: [...DATA_SNAPSHOT_RANGES] }),
        points: arrayOf(obj({ at: ISO, usd: num(), complete: bool() }, ["at", "usd", "complete"])),
        change: { oneOf: [obj({ usd: num(), pct: NULLABLE_NUMBER }, ["usd", "pct"]), { type: "null" }] },
        tracked: bool(),
        reason: str(),
        source: str({ const: "snapshot" }),
        asOf: ISO,
      },
      ["range", "points", "change", "tracked", "source", "asOf"],
    ),
    DataSummary: obj(
      {
        wallets: obj({ evm: arrayOf(str()), solana: arrayOf(str()), lane: str({ enum: ["production", "testnet"] }) }, ["evm", "solana", "lane"]),
        totals: obj({ netUsd: NULLABLE_NUMBER, walletUsd: NULLABLE_NUMBER, positionsUsd: NULLABLE_NUMBER, debtUsd: NULLABLE_NUMBER, complete: bool() }, ["netUsd", "walletUsd", "positionsUsd", "debtUsd", "complete"]),
        change24h: ref("DataValueChange"),
        allocation: obj({ byNetwork: arrayOf(ref("DataAllocationSlice")), byAsset: arrayOf(ref("DataAllocationSlice")) }, ["byNetwork", "byAsset"]),
        topPositions: arrayOf(obj({ name: str(), network: NETWORK, kind: str(), usd: NULLABLE_NUMBER }, ["name", "network", "kind", "usd"])),
        perps: obj({ open: int({ minimum: 0 }), unrealizedPnlUsd: NULLABLE_NUMBER }, ["open", "unrealizedPnlUsd"]),
        risks: arrayOf(obj(
          {
            flag: str({ enum: ["LOW_HEALTH", "LIQUIDATABLE", "PERP_NEAR_LIQUIDATION", "CONCENTRATION", "UNPRICED", "UNREAD", "HISTORY_INCOMPLETE"] }),
            severity: str({ enum: ["info", "warning", "critical"] }),
            subject: str(),
            message: str(),
          },
          ["flag", "severity", "subject", "message"],
        )),
        activity: obj(
          { last24h: int({ minimum: 0 }), last7d: int({ minimum: 0 }), last30d: int({ minimum: 0 }), byKind: { type: "object", additionalProperties: int({ minimum: 0 }) }, complete: bool() },
          ["last24h", "last7d", "last30d", "byKind", "complete"],
        ),
        pnl: obj({ realizedUsd: NULLABLE_NUMBER, unrealizedUsd: NULLABLE_NUMBER, estimate: bool({ const: true }), reason: str() }, ["realizedUsd", "unrealizedUsd", "estimate"]),
        sources: arrayOf(str()),
        asOf: ISO,
      },
      ["wallets", "totals", "change24h", "allocation", "topPositions", "perps", "risks", "activity", "pnl", "sources", "asOf"],
    ),
    DataSummaryResponse: obj({ summary: ref("DataSummary") }, ["summary"]),
    DataTracking: obj(
      { id: str(), wallets: obj({ evm: arrayOf(str()), solana: arrayOf(str()) }, ["evm", "solana"]), lane: str({ enum: ["production", "testnet"] }), createdAt: ISO, lastSnapshotAt: NULLABLE_ISO },
      ["id", "wallets", "lane", "createdAt", "lastSnapshotAt"],
    ),
    DataTrackingResponse: obj({ tracking: { oneOf: [ref("DataTracking"), { type: "null" }] } }, ["tracking"]),
    DataTrackingRequest: obj(
      {
        lane: str({ enum: ["production", "testnet"], default: "production" }),
        proofs: arrayOf(str({ pattern: ACCOUNT_SESSION_TOKEN_PATTERN.source }), { maxItems: 3, description: "Session tokens of other wallets signed in at the same site: each adds that wallet." }),
      },
    ),
    DataTrackingStopped: obj({ deleted: bool({ description: "True when the set was deleted (its creator); false when the wallet only left it." }) }, ["deleted"]),
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

const txParameters: JsonObject[] = [
  networkParameter,
  { name: "kind", in: "query", required: false, schema: str({ enum: [...DATA_TX_KINDS] }) },
  { name: "asset", in: "query", required: false, description: "Symbol or token address / mint.", schema: str({ maxLength: 64 }) },
  { name: "protocol", in: "query", required: false, description: "Protocol id or label (aave-v3, Polymarket).", schema: str({ maxLength: 64 }) },
  { name: "from", in: "query", required: false, schema: ISO },
  { name: "to", in: "query", required: false, schema: ISO },
  { name: "kletiaOnly", in: "query", required: false, description: "Only transactions that were steps of the caller's Kletia intents.", schema: bool() },
  { name: "cursor", in: "query", required: false, schema: str({ maxLength: 4000 }) },
  { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: TRANSACTION_LIMITS.maxLimit, default: TRANSACTION_LIMITS.defaultLimit }) },
];

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
      `The positions part of the portfolio read (same cache). With \`extras=true\`: open perps positions, open native orders, the caller's automations and its agent keys' spend, each with a reason when unread. ${BUDGET}: one unit per account (two with extras).`,
      [...walletParameters, { name: "extras", in: "query", required: false, schema: bool() }, SESSION_HEADER],
      ok("DataPositions", "Positions and health."),
    ),
    "/v1/data/transactions": get(
      "listDataTransactions",
      "On-chain transaction history of a wallet set",
      `Every transaction of every account, newest first, classified (send, receive, swap, bridge, deposit, borrow, stake, perp, order, prediction …) with legs, USD at the time (DefiLlama), fee, protocol from Kletia's registry and the Kletia intent it was a step of. EVM through Etherscan V2 (ETHERSCAN_API_KEY) or Alchemy (ALCHEMY_API_KEY); Solana through Helius (HELIUS_API_KEY) or plain RPC. Accounts without a configured provider are listed in \`coverage\` with the reason. ${CALLER_NOTE} ${BUDGET}: one unit per account.`,
      [...walletParameters, ...txParameters, SESSION_HEADER],
      ok("DataTransactionPage", "A page of transactions."),
    ),
    "/v1/data/transactions/{id}": get(
      "getDataTransaction",
      "One transaction of a wallet set",
      `\`<network>:<hash or signature>\` of a transaction that involves one of the wallets. ${CALLER_NOTE} ${BUDGET}: one unit per account.`,
      [{ name: "id", in: "path", required: true, schema: str({ maxLength: 140 }) }, ...walletParameters, SESSION_HEADER],
      ok("DataTransactionResponse", "The transaction."),
    ),
    "/v1/data/pnl": get(
      "getDataPnl",
      "Realized and unrealized PnL estimates by asset (FIFO)",
      `FIFO cost basis over the newest history (and a tracked set's cached transactions), valued now with the portfolio's prices. Moves between the set's own wallets, bridges, deposits, staking and loans neither acquire nor dispose. Unknown prices or older history make a part null and \`totals.complete\` false. ${CALLER_NOTE} ${BUDGET}: two units per account.`,
      [...walletParameters, { name: "period", in: "query", required: false, schema: str({ enum: [...DATA_PNL_PERIODS], default: "all" }) }, SESSION_HEADER],
      ok("DataPnl", "PnL by asset."),
    ),
    "/v1/data/snapshots": get(
      "getDataSnapshots",
      "Value series of a tracked wallet set",
      `Hourly points for 24h and 7d, daily for 30d and all, written by the snapshot job (once an hour per tracked set, kept across restarts with a database). Untracked wallets answer an empty series with \`tracked: false\`. ${CALLER_NOTE} ${BUDGET}: one unit.`,
      [...walletParameters, { name: "range", in: "query", required: false, schema: str({ enum: [...DATA_SNAPSHOT_RANGES], default: "30d" }) }, SESSION_HEADER],
      ok("DataSnapshotSeries", "The series."),
    ),
    "/v1/data/summary": get(
      "getDataSummary",
      "One compact object about a wallet set, for an assistant",
      `Totals, top allocation slices and positions, risk flags (low health, liquidatable, perps near liquidation, concentration, unpriced, unread), activity counts of the newest history and PnL estimates, with every source named. ${CALLER_NOTE} ${BUDGET}: two units per account.`,
      [...walletParameters, SESSION_HEADER],
      ok("DataSummaryResponse", "The summary."),
    ),
    "/v1/data/tracking": {
      get: {
        operationId: "getDataTracking", tags: TAGS, summary: "The tracked set of the signed-in desk wallet",
        description: "Desk wallet session only (first-party Origin). `tracking: null` when the wallet is not tracked.",
        parameters: [{ ...SESSION_HEADER, required: true }],
        responses: { "200": ok("DataTrackingResponse", "The tracked set."), ...errors("403") },
      },
      post: {
        operationId: "startDataTracking", tags: TAGS, summary: "Turn tracking on (value snapshots and a transaction cache)",
        description: `Creates the set of the signed-in wallet, or adds wallets to it. Every other wallet must be proven by its own sign-in at the same site (its session token in \`proofs\`). At most ${WALLET_LIMITS.evm} EVM and ${WALLET_LIMITS.solana} Solana wallets; a wallet belongs to one set (409 DATA_WALLET_TRACKED).`,
        parameters: [{ ...SESSION_HEADER, required: true }],
        requestBody: jsonBody("DataTrackingRequest", false),
        responses: { "201": ok("DataTrackingResponse", "The tracked set."), ...errors("403", "409", "422") },
      },
      delete: {
        operationId: "stopDataTracking", tags: TAGS, summary: "Turn tracking off",
        description: "The set's creator deletes it with its snapshots and cached transactions; another member's wallet only leaves it.",
        parameters: [{ ...SESSION_HEADER, required: true }],
        responses: { "200": ok("DataTrackingStopped", "Stopped."), ...errors("403") },
      },
    },
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
      `\`dataset=holdings|positions\` takes a wallet set (one unit per account); \`dataset=history\` needs an API key (one unit); \`dataset=transactions\` is one page of \`GET /v1/data/transactions\` with the same filters and caller rules (one row per leg). ${BUDGET}.`,
      [
        { name: "dataset", in: "query", required: false, schema: str({ enum: [...DATA_EXPORT_DATASETS], default: "holdings" }) },
        { name: "format", in: "query", required: false, schema: str({ enum: ["csv", "json"], default: "csv" }) },
        ...walletParameters,
        historyLimitParameter,
        ...txParameters.filter((parameter) => parameter.name !== "limit"),
        SESSION_HEADER,
      ],
      csvResponse,
    ),
  };
}

/** The Data tag. */
export const DATA_TAG: JsonObject = { name: "Data", description: "Read-only dashboard data: a wallet set's holdings, positions, health, on-chain history, PnL and value series across every network, plus venue yields, prices and network status." };
