import { Asset, Networks, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { STELLAR_MVP_ENABLED, STELLAR_TESTNET, assertStellarAccount } from "./config.js";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_HORIZON_ROUTE_RECORDS = 50;
const MAX_STELLAR_PATH_LENGTH = 5;

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(init?.headers || {}) },
    });
    if (!response.ok) {
      throw controlled(
        "STELLAR_UPSTREAM_REJECTED",
        "Stellar read service rejected the request.",
        502,
      );
    }
    const length = Number(response.headers.get("content-length") || "0");
    if (length > MAX_RESPONSE_BYTES) {
      throw controlled("STELLAR_RESPONSE_TOO_LARGE", "Stellar response was too large.", 502);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw controlled("STELLAR_RESPONSE_TOO_LARGE", "Stellar response was too large.", 502);
    }
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function readStellarReadiness() {
  if (!STELLAR_MVP_ENABLED) {
    return {
      enabled: false,
      status: "disabled" as const,
      network: STELLAR_TESTNET.id,
    };
  }
  const horizon = new URL("/", STELLAR_TESTNET.horizonUrl);
  const rpcServer = new rpc.Server(STELLAR_TESTNET.rpcUrl);
  const contractIds = [
    STELLAR_TESTNET.usdc.sac,
    STELLAR_TESTNET.aquarius.router,
    STELLAR_TESTNET.cctp.tokenMessengerMinter,
    STELLAR_TESTNET.cctp.messageTransmitter,
    STELLAR_TESTNET.cctp.forwarder,
  ];
  const [horizonRoot, rpcHealth, contractEntries] = await Promise.all([
    fetchJson(horizon),
    rpcServer.getHealth(),
    Promise.all(
      contractIds.map((contractId) =>
        rpcServer.getContractData(
          contractId,
          xdr.ScVal.scvLedgerKeyContractInstance(),
        ),
      ),
    ),
  ]);
  const root = horizonRoot as {
    network_passphrase?: unknown;
    core_latest_ledger?: unknown;
  };
  if (root.network_passphrase !== STELLAR_TESTNET.networkPassphrase) {
    throw controlled(
      "STELLAR_NETWORK_MISMATCH",
      "Configured Horizon is not Stellar Testnet.",
      503,
    );
  }
  if (rpcHealth.status !== "healthy") {
    throw controlled("STELLAR_RPC_UNHEALTHY", "Stellar RPC is not healthy.", 503);
  }
  if (
    contractEntries.length !== contractIds.length ||
    contractEntries.some((entry) => entry.val.type !== "contractData")
  ) {
    throw controlled(
      "STELLAR_CONTRACT_ATTESTATION_FAILED",
      "One or more reviewed Stellar Testnet contracts are unavailable.",
      503,
    );
  }
  return {
    enabled: true,
    status: "ready" as const,
    network: STELLAR_TESTNET.id,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    latestLedger: String(root.core_latest_ledger ?? "unknown"),
    rpcLatestLedger: rpcHealth.latestLedger,
    rpcOldestLedger: rpcHealth.oldestLedger,
    reviewedContractsAttested: true as const,
  };
}

type HorizonBalance = {
  balance?: unknown;
  asset_type?: unknown;
  asset_code?: unknown;
  asset_issuer?: unknown;
  is_authorized?: unknown;
  is_authorized_to_maintain_liabilities?: unknown;
  limit?: unknown;
};

type ReviewedPortfolioAsset =
  | {
      asset: { kind: "native"; symbol: "XLM"; decimals: 7 };
      balance: string;
      authorized: true;
    }
  | {
      asset: {
        kind: "stellar_classic";
        symbol: "USDC";
        code: "USDC";
        issuer: string;
        sac: string;
        decimals: 7;
      };
      balance: string;
      authorized: boolean;
      limit?: string;
    };

export async function readStellarPortfolio(accountInput: unknown) {
  if (!STELLAR_MVP_ENABLED) {
    throw controlled("STELLAR_DISABLED", "Stellar Public Testnet Beta is disabled.", 503);
  }
  const account = assertStellarAccount(accountInput);
  const url = new URL(`/accounts/${encodeURIComponent(account)}`, STELLAR_TESTNET.horizonUrl);
  const payload = (await fetchJson(url)) as {
    balances?: HorizonBalance[];
    sequence?: unknown;
    last_modified_ledger?: unknown;
    last_modified_time?: unknown;
  };
  if (!Array.isArray(payload.balances)) {
    throw controlled("STELLAR_PORTFOLIO_INVALID", "Horizon portfolio response was invalid.", 502);
  }
  const assets = payload.balances.flatMap<ReviewedPortfolioAsset>((balance) => {
    const amount = String(balance.balance ?? "");
    if (!/^\d+(?:\.\d{1,7})?$/u.test(amount)) return [];
    if (balance.asset_type === "native") {
      return [{
        asset: { kind: "native" as const, symbol: "XLM", decimals: 7 },
        balance: amount,
        authorized: true as const,
      }];
    }
    if (
      balance.asset_code === STELLAR_TESTNET.usdc.symbol &&
      balance.asset_issuer === STELLAR_TESTNET.usdc.issuer
    ) {
      return [{
        asset: {
          kind: "stellar_classic" as const,
          symbol: "USDC",
          code: STELLAR_TESTNET.usdc.symbol,
          issuer: STELLAR_TESTNET.usdc.issuer,
          sac: STELLAR_TESTNET.usdc.sac,
          decimals: 7,
        },
        balance: amount,
        authorized:
          balance.is_authorized !== false &&
          balance.is_authorized_to_maintain_liabilities !== false,
        limit: typeof balance.limit === "string" ? balance.limit : undefined,
      }];
    }
    return [];
  });
  return {
    schemaVersion: "kletia_stellar_portfolio_v1" as const,
    network: STELLAR_TESTNET.id,
    account,
    sequence: String(payload.sequence ?? ""),
    lastModifiedLedger:
      Number.isSafeInteger(Number(payload.last_modified_ledger)) && Number(payload.last_modified_ledger) > 0
        ? String(payload.last_modified_ledger)
        : null,
    lastModifiedTime:
      typeof payload.last_modified_time === "string" ? payload.last_modified_time : null,
    assets,
    reviewedAssetsOnly: true,
    mockData: false as const,
    observedAt: new Date().toISOString(),
  };
}

type StellarAssetInput =
  | { kind: "native"; symbol: "XLM" }
  | { kind: "stellar_classic"; symbol: "USDC"; code: "USDC"; issuer: string };

function parseAsset(input: unknown): { sdk: Asset; descriptor: StellarAssetInput } {
  const symbol = String(input ?? "").trim().toUpperCase();
  if (symbol === "XLM") {
    return { sdk: Asset.native(), descriptor: { kind: "native", symbol: "XLM" } };
  }
  if (symbol === "USDC") {
    return {
      sdk: new Asset(STELLAR_TESTNET.usdc.symbol, STELLAR_TESTNET.usdc.issuer),
      descriptor: {
        kind: "stellar_classic",
        symbol: "USDC",
        code: "USDC",
        issuer: STELLAR_TESTNET.usdc.issuer,
      },
    };
  }
  throw controlled("STELLAR_ASSET_UNSUPPORTED", "Stellar MVP supports XLM and reviewed Testnet USDC.");
}

function parseAmount(value: unknown): string {
  const amount = String(value ?? "").trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(amount)) {
    throw controlled("AMOUNT_REQUIRED", "Enter a positive amount with at most seven decimals.");
  }
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > 7 || BigInt(`${whole || "0"}${fraction.padEnd(7, "0")}`) <= 0n) {
    throw controlled("AMOUNT_INVALID", "Enter a positive amount with at most seven decimals.");
  }
  return amount;
}

function stellarAmountAtomic(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(`${whole || "0"}${fraction.padEnd(7, "0")}`);
}

type HorizonPathAsset =
  | { asset_type: "native" }
  | {
      asset_type: "credit_alphanum4" | "credit_alphanum12";
      asset_code: string;
      asset_issuer: string;
    };

type ValidatedHorizonRoute = {
  sourceAmount: string;
  sourceAmountAtomic: bigint;
  destinationAmount: string;
  destinationAmountAtomic: bigint;
  path: HorizonPathAsset[];
  pathIdentities: string[];
};

function assetIdentity(asset: Asset): string {
  return asset.isNative() ? "native" : `${asset.code}:${asset.issuer}`;
}

function parseHorizonAsset(
  record: Record<string, unknown>,
  prefix: "" | "source_" | "destination_",
): { sdk: Asset; descriptor: HorizonPathAsset; identity: string } {
  const assetType = record[`${prefix}asset_type`];
  const assetCode = record[`${prefix}asset_code`];
  const assetIssuer = record[`${prefix}asset_issuer`];
  if (assetType === "native") {
    if (
      (assetCode !== undefined && assetCode !== null && assetCode !== "") ||
      (assetIssuer !== undefined && assetIssuer !== null && assetIssuer !== "")
    ) {
      throw controlled(
        "STELLAR_ROUTE_IDENTITY_INVALID",
        "Horizon returned a native path asset with credit-asset fields.",
        502,
      );
    }
    const sdk = Asset.native();
    return {
      sdk,
      descriptor: { asset_type: "native" },
      identity: assetIdentity(sdk),
    };
  }
  if (
    (assetType !== "credit_alphanum4" && assetType !== "credit_alphanum12") ||
    typeof assetCode !== "string" ||
    typeof assetIssuer !== "string" ||
    !StrKey.isValidEd25519PublicKey(assetIssuer)
  ) {
    throw controlled(
      "STELLAR_ROUTE_IDENTITY_INVALID",
      "Horizon returned an invalid path asset identity.",
      502,
    );
  }
  const expectedType = assetCode.length <= 4
    ? "credit_alphanum4"
    : "credit_alphanum12";
  if (assetType !== expectedType) {
    throw controlled(
      "STELLAR_ROUTE_IDENTITY_INVALID",
      "Horizon returned an asset type that did not match its asset code.",
      502,
    );
  }
  let sdk: Asset;
  try {
    sdk = new Asset(assetCode, assetIssuer);
  } catch {
    throw controlled(
      "STELLAR_ROUTE_IDENTITY_INVALID",
      "Horizon returned an invalid credit asset.",
      502,
    );
  }
  return {
    sdk,
    descriptor: {
      asset_type: assetType,
      asset_code: assetCode,
      asset_issuer: assetIssuer,
    },
    identity: assetIdentity(sdk),
  };
}

function parseHorizonQuoteAmount(value: unknown): {
  display: string;
  atomic: bigint;
} {
  const display = String(value ?? "");
  if (!/^\d+(?:\.\d{1,7})?$/u.test(display)) {
    throw controlled(
      "STELLAR_ROUTE_AMOUNT_INVALID",
      "Horizon returned an invalid path amount.",
      502,
    );
  }
  const atomic = stellarAmountAtomic(display);
  if (atomic <= 0n) {
    throw controlled(
      "STELLAR_ROUTE_AMOUNT_INVALID",
      "Horizon returned a non-positive path amount.",
      502,
    );
  }
  return { display, atomic };
}

function validateHorizonRoute(input: {
  record: Record<string, unknown>;
  source: Asset;
  destination: Asset;
  mode: "strict_send" | "strict_receive";
  requestedAmountAtomic: bigint;
}): ValidatedHorizonRoute {
  const source = parseHorizonAsset(input.record, "source_");
  const destination = parseHorizonAsset(input.record, "destination_");
  if (
    source.identity !== assetIdentity(input.source) ||
    destination.identity !== assetIdentity(input.destination)
  ) {
    throw controlled(
      "STELLAR_ROUTE_ENDPOINT_MISMATCH",
      "Horizon returned a path for different source or destination assets.",
      502,
    );
  }
  if (!Array.isArray(input.record.path)) {
    throw controlled(
      "STELLAR_ROUTE_PATH_INVALID",
      "Horizon returned an invalid path sequence.",
      502,
    );
  }
  if (input.record.path.length > MAX_STELLAR_PATH_LENGTH) {
    throw controlled(
      "STELLAR_ROUTE_PATH_TOO_LONG",
      "Horizon returned a path longer than Stellar path-payment limits.",
      502,
    );
  }
  const path = input.record.path.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw controlled(
        "STELLAR_ROUTE_PATH_INVALID",
        "Horizon returned an invalid intermediate path asset.",
        502,
      );
    }
    return parseHorizonAsset(entry as Record<string, unknown>, "");
  });
  const fullPathIdentities = [
    source.identity,
    ...path.map((asset) => asset.identity),
    destination.identity,
  ];
  if (new Set(fullPathIdentities).size !== fullPathIdentities.length) {
    throw controlled(
      "STELLAR_ROUTE_CYCLE_REJECTED",
      "Horizon returned a cyclic or repeated-asset path.",
      502,
    );
  }
  const sourceAmount = parseHorizonQuoteAmount(input.record.source_amount);
  const destinationAmount = parseHorizonQuoteAmount(input.record.destination_amount);
  const fixedAmount = input.mode === "strict_send" ? sourceAmount : destinationAmount;
  if (fixedAmount.atomic !== input.requestedAmountAtomic) {
    throw controlled(
      "STELLAR_ROUTE_AMOUNT_MISMATCH",
      "Horizon returned a path that was not bound to the requested amount.",
      502,
    );
  }
  return {
    sourceAmount: sourceAmount.display,
    sourceAmountAtomic: sourceAmount.atomic,
    destinationAmount: destinationAmount.display,
    destinationAmountAtomic: destinationAmount.atomic,
    path: path.map((asset) => asset.descriptor),
    pathIdentities: path.map((asset) => asset.identity),
  };
}

function compareHorizonRoutes(
  left: ValidatedHorizonRoute,
  right: ValidatedHorizonRoute,
  mode: "strict_send" | "strict_receive",
): number {
  const leftPrimary = mode === "strict_send"
    ? left.destinationAmountAtomic
    : left.sourceAmountAtomic;
  const rightPrimary = mode === "strict_send"
    ? right.destinationAmountAtomic
    : right.sourceAmountAtomic;
  if (leftPrimary !== rightPrimary) {
    if (mode === "strict_send") return leftPrimary > rightPrimary ? -1 : 1;
    return leftPrimary < rightPrimary ? -1 : 1;
  }
  if (left.path.length !== right.path.length) {
    return left.path.length - right.path.length;
  }
  return left.pathIdentities.join(">").localeCompare(right.pathIdentities.join(">"));
}

async function readAquariusComparison(input: {
  mode: "strict_send" | "strict_receive";
  source: Asset;
  destination: Asset;
  amount: string;
}) {
  const atomic = stellarAmountAtomic(input.amount);
  if (atomic > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      comparisonStatus: "not_executed" as const,
      reason: "The amount exceeds the Aquarius JSON safe-integer boundary.",
    };
  }
  const endpoint = input.mode === "strict_send"
    ? "find-path/"
    : "find-path-strict-receive/";
  const payload = (await fetchJson(
    new URL(`${STELLAR_TESTNET.aquarius.apiUrl}/${endpoint}`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: input.source.contractId(Networks.TESTNET),
        token_out_address: input.destination.contractId(Networks.TESTNET),
        amount: Number(atomic),
      }),
    },
  )) as {
    success?: unknown;
    swap_chain_xdr?: unknown;
    amount?: unknown;
    amount_with_fee?: unknown;
    pools?: unknown;
    tokens_addresses?: unknown;
  };
  const quotedAmount = String(payload.amount_with_fee ?? payload.amount ?? "");
  if (
    payload.success !== true ||
    typeof payload.swap_chain_xdr !== "string" ||
    payload.swap_chain_xdr.length > 64_000 ||
    !/^\d+$/u.test(quotedAmount) ||
    BigInt(quotedAmount) <= 0n ||
    !Array.isArray(payload.pools) ||
    !Array.isArray(payload.tokens_addresses)
  ) {
    throw controlled("AQUARIUS_QUOTE_INVALID", "Aquarius returned an invalid path quote.", 502);
  }
  try {
    xdr.ScVal.fromXdr(payload.swap_chain_xdr, "base64");
  } catch {
    throw controlled("AQUARIUS_QUOTE_INVALID", "Aquarius path XDR was invalid.", 502);
  }
  const pools = payload.pools;
  const tokenContracts = payload.tokens_addresses;
  if (
    tokenContracts.length < 2 ||
    tokenContracts.length > MAX_STELLAR_PATH_LENGTH + 2 ||
    pools.length !== tokenContracts.length - 1 ||
    pools.some((value) => typeof value !== "string" || !StrKey.isValidContract(value)) ||
    tokenContracts.some(
      (value) => typeof value !== "string" || !StrKey.isValidContract(value),
    )
  ) {
    throw controlled(
      "AQUARIUS_QUOTE_INVALID",
      "Aquarius returned an invalid token or pool sequence.",
      502,
    );
  }
  const typedPools = pools as string[];
  const typedTokenContracts = tokenContracts as string[];
  if (
    typedTokenContracts[0] !== input.source.contractId(Networks.TESTNET) ||
    typedTokenContracts.at(-1) !== input.destination.contractId(Networks.TESTNET) ||
    new Set(typedTokenContracts).size !== typedTokenContracts.length ||
    new Set(typedPools).size !== typedPools.length
  ) {
    throw controlled(
      "AQUARIUS_QUOTE_INVALID",
      "Aquarius returned mismatched endpoints or a cyclic path.",
      502,
    );
  }
  const health = await new rpc.Server(STELLAR_TESTNET.rpcUrl).getHealth();
  return {
    comparisonStatus: "syntax_validated_untrusted_quote" as const,
    router: STELLAR_TESTNET.aquarius.router,
    apiUrl: STELLAR_TESTNET.aquarius.apiUrl,
    quotedAmountAtomic: quotedAmount,
    pools: typedPools,
    tokenContracts: typedTokenContracts,
    observedAtLedger: health.latestLedger,
    xdrSyntaxValidated: true as const,
    routerInvocationBound: false as const,
    enforcingSimulationBound: false as const,
    executionEnabled: false as const,
    reason:
      "Aquarius response syntax and endpoint continuity were checked, but the API quote is untrusted and is not bound to an exact router invocation, hydrated transaction, or enforcing simulation.",
  };
}

function horizonAssetQuery(asset: Asset): Record<string, string> {
  if (asset.isNative()) return { asset_type: "native" };
  return {
    asset_type: "credit_alphanum4",
    asset_code: asset.code,
    asset_issuer: asset.issuer!,
  };
}

export async function readStellarPathQuote(input: {
  mode?: unknown;
  assetIn?: unknown;
  assetOut?: unknown;
  amount?: unknown;
}) {
  if (!STELLAR_MVP_ENABLED) {
    throw controlled("STELLAR_DISABLED", "Stellar Public Testnet Beta is disabled.", 503);
  }
  const mode = input.mode === "strict_receive" ? "strict_receive" : "strict_send";
  const source = parseAsset(input.assetIn);
  const destination = parseAsset(input.assetOut);
  if (source.sdk.equals(destination.sdk)) {
    throw controlled("STELLAR_ROUTE_TRIVIAL", "Choose two different Stellar assets.");
  }
  const amount = parseAmount(input.amount);
  const endpoint = mode === "strict_send" ? "/paths/strict-send" : "/paths/strict-receive";
  const url = new URL(endpoint, STELLAR_TESTNET.horizonUrl);
  const sourceQuery = horizonAssetQuery(source.sdk);
  const destinationQuery = horizonAssetQuery(destination.sdk);
  if (mode === "strict_send") {
    Object.entries(sourceQuery).forEach(([key, value]) => url.searchParams.set(`source_${key}`, value));
    url.searchParams.set("source_amount", amount);
    url.searchParams.set("destination_assets", destination.sdk.toString());
  } else {
    Object.entries(destinationQuery).forEach(([key, value]) => url.searchParams.set(`destination_${key}`, value));
    url.searchParams.set("destination_amount", amount);
    url.searchParams.set("source_assets", source.sdk.toString());
  }
  url.searchParams.set("limit", String(MAX_HORIZON_ROUTE_RECORDS));
  const payload = (await fetchJson(url)) as {
    _embedded?: { records?: Array<Record<string, unknown>> };
  };
  const records = payload._embedded?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw controlled("STELLAR_ROUTE_UNAVAILABLE", "No live SDEX path satisfied the requested bounds.", 409);
  }
  if (records.length > MAX_HORIZON_ROUTE_RECORDS) {
    throw controlled(
      "STELLAR_ROUTE_RESPONSE_INVALID",
      "Horizon returned more path records than requested.",
      502,
    );
  }
  const requestedAmountAtomic = stellarAmountAtomic(amount);
  const validatedRoutes = records
    .map((record) =>
      validateHorizonRoute({
        record,
        source: source.sdk,
        destination: destination.sdk,
        mode,
        requestedAmountAtomic,
      }),
    )
    // Testnet pathfinding is permissionless. A syntactically valid route may
    // traverse an arbitrary issuer with a manipulated order book. Until Kletia
    // has a reviewed intermediate-asset registry, only the direct XLM/Circle
    // USDC pair is eligible for execution.
    .filter((route) => route.pathIdentities.length === 0)
    .sort((left, right) => compareHorizonRoutes(left, right, mode));
  if (validatedRoutes.length === 0) {
    throw controlled(
      "STELLAR_REVIEWED_ROUTE_UNAVAILABLE",
      "No live direct XLM/Circle USDC SDEX route satisfied the requested bounds.",
      409,
    );
  }
  const routes = validatedRoutes.slice(0, 5).map((route) => ({
    sourceAmount: route.sourceAmount,
    destinationAmount: route.destinationAmount,
    path: route.path,
    intermediateAssetIdentities: route.pathIdentities,
  }));
  let aquarius: Awaited<ReturnType<typeof readAquariusComparison>> | {
    comparisonStatus: "unavailable";
    router: string;
    reason: string;
  };
  try {
    aquarius = await readAquariusComparison({
      mode,
      source: source.sdk,
      destination: destination.sdk,
      amount,
    });
  } catch {
    aquarius = {
      comparisonStatus: "unavailable",
      router: STELLAR_TESTNET.aquarius.router,
      reason: "Aquarius live quote was unavailable; no AMM result was fabricated.",
    };
  }
  return {
    schemaVersion: "kletia_stellar_route_quote_v1" as const,
    network: STELLAR_TESTNET.id,
    mode,
    sourceAsset: source.descriptor,
    destinationAsset: destination.descriptor,
    routes,
    selectedRoute: routes[0],
    executionPolicy: {
      venue: "stellar_classic_path_payment" as const,
      slippageBps: 50 as const,
      intermediateAssets: "reviewed_direct_pair_only" as const,
      warning:
        "Unreviewed intermediate issuers are excluded. This is a live Horizon execution quote from the direct XLM/Circle Testnet USDC order book, but Testnet liquidity can be artificial or thin and is not a fair-market-price guarantee.",
    },
    source: "stellar_horizon_pathfinding" as const,
    aquarius,
    quoteExpiresAt: Date.now() + 60_000,
    mockData: false as const,
  };
}

export function validateStellarHash(value: unknown): string {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw controlled("STELLAR_TRANSACTION_HASH_INVALID", "A Stellar transaction hash is required.");
  }
  return hash;
}

export function validateStellarContractId(value: unknown): string {
  const contract = String(value ?? "").trim();
  if (!StrKey.isValidContract(contract)) {
    throw controlled("STELLAR_CONTRACT_INVALID", "Stellar contract ID is invalid.");
  }
  return contract;
}
