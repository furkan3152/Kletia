/**
 * The desk's holdings snapshot: balances of the connected wallets on
 * every network of one lane, read from `GET /v1/portfolio?accounts=`
 * (or, on an API without that route, one `GET /v1/portfolio/{account}`
 * per account). Pure (node --test loads it).
 *
 * Every portfolio comes from the network, so it is validated here: a holding
 * that does not parse is dropped, a portfolio whose account and network
 * disagree is rejected, and USD values are read from `usd` (the API's field;
 * `usdValue` is the Solana module's internal name and never reaches v1).
 * Amounts stay exact strings; nothing is rounded through a float except the
 * advisory USD totals.
 */
import {
  CHAINS,
  NETWORK_KEYS,
  parseAccountId,
  toBaseUnits,
  type AccountId,
  type NetworkKey,
} from "@kletia/core";

export type HoldingsLane = "production" | "testnet";

/** One balance, exactly as the API formats it. */
export interface Holding {
  readonly asset: string;
  readonly symbol: string;
  /** Base units, a non-negative integer string. */
  readonly amount: string;
  readonly decimals: number;
  /** The API's own decimal rendering ("120.4"); printed as is. */
  readonly formatted: string;
  /** Advisory USD value; null when the asset is unpriced. */
  readonly usd: number | null;
  readonly isNative: boolean;
}

export interface NetworkHoldings {
  readonly account: AccountId;
  readonly network: NetworkKey;
  /** Sum of the priced holdings, in USD (advisory, cents). */
  readonly totalUsd: number;
  /** Holdings with a balance but no USD price. */
  readonly unpriced: number;
  /** Every holding with a balance, best first: by USD value, then by amount. Rows print the first two. */
  readonly top: readonly Holding[];
  /** The last read of this account failed; values are from `observedAt`. */
  readonly stale: boolean;
  readonly observedAt: string;
}

export interface HoldingsSnapshot {
  readonly lane: HoldingsLane;
  readonly observedAt: string;
  readonly byNetwork: Readonly<Partial<Record<NetworkKey, NetworkHoldings>>>;
  /** Networks (same lane) whose account holds at least `amount` of `symbol`, best first. */
  fundedFor(symbol: string, amount: string): readonly NetworkKey[];
}

/** An account the API could not read (`failures` of the batch route). */
export interface PortfolioFailure {
  readonly account: string;
  readonly code: string;
  readonly message: string;
}

/** Holdings a row prints: the top two. */
export const ROW_HOLDINGS = 2;

const BASE_UNITS = /^(?:0|[1-9]\d*)$/u;
const MAX_HOLDINGS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function laneOfNetwork(network: NetworkKey): HoldingsLane {
  return CHAINS[network].lane === "testnet" ? "testnet" : "production";
}

function parseHolding(value: unknown): Holding | null {
  if (!isRecord(value)) return null;
  const { asset, symbol, amount, decimals, formatted, usd, isNative } = value;
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 32) return null;
  if (typeof amount !== "string" || !BASE_UNITS.test(amount)) return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  if (typeof formatted !== "string" || formatted.length === 0 || formatted.length > 64) return null;
  if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0)) return null;
  return {
    asset: typeof asset === "string" ? asset : "",
    symbol,
    amount,
    decimals,
    formatted,
    usd,
    isNative: isNative === true,
  };
}

function compareHoldings(a: Holding, b: Holding): number {
  const usdA = a.usd ?? -1;
  const usdB = b.usd ?? -1;
  if (usdA !== usdB) return usdB - usdA;
  // Same USD (or both unpriced): the larger amount first, compared exactly.
  const scale = Math.max(a.decimals, b.decimals);
  const unitsA = BigInt(a.amount) * 10n ** BigInt(scale - a.decimals);
  const unitsB = BigInt(b.amount) * 10n ** BigInt(scale - b.decimals);
  return unitsA === unitsB ? 0 : unitsA > unitsB ? -1 : 1;
}

/**
 * One account's portfolio (`GET /v1/portfolio/{account}`, or one entry of the
 * batch route's `portfolios`). Null when the body is not a portfolio, or when
 * its account and network disagree.
 */
export function parsePortfolio(body: unknown): NetworkHoldings | null {
  if (!isRecord(body)) return null;
  const parsed = parseAccountId(body.account);
  if (!parsed) return null;
  const network = parsed.chain.key;
  if (body.network !== undefined && body.network !== network) return null;
  if (!Array.isArray(body.holdings)) return null;
  const holdings = body.holdings
    .slice(0, MAX_HOLDINGS)
    .map(parseHolding)
    .filter((holding): holding is Holding => holding !== null && holding.amount !== "0")
    .sort(compareHoldings);
  const priced = holdings.reduce((total, holding) => total + (holding.usd ?? 0), 0);
  return {
    account: parsed.id,
    network,
    totalUsd: Math.round(priced * 100) / 100,
    unpriced: holdings.filter((holding) => holding.usd === null).length,
    top: holdings,
    stale: false,
    observedAt: typeof body.observedAt === "string" ? body.observedAt : "",
  };
}

/** The batch route's body: `{ portfolios, failures, observedAt }`. Malformed entries are dropped. */
export function parsePortfolioBatch(body: unknown): {
  readonly portfolios: readonly NetworkHoldings[];
  readonly failures: readonly PortfolioFailure[];
  readonly observedAt: string | null;
} {
  if (!isRecord(body) || !Array.isArray(body.portfolios)) {
    return { portfolios: [], failures: [], observedAt: null };
  }
  const portfolios = body.portfolios
    .map(parsePortfolio)
    .filter((portfolio): portfolio is NetworkHoldings => portfolio !== null);
  const failures = (Array.isArray(body.failures) ? body.failures : []).flatMap((entry): PortfolioFailure[] =>
    isRecord(entry) && typeof entry.account === "string"
      ? [{
          account: entry.account,
          code: typeof entry.code === "string" ? entry.code : "UNKNOWN",
          message: typeof entry.message === "string" ? entry.message : "",
        }]
      : [],
  );
  return { portfolios, failures, observedAt: typeof body.observedAt === "string" ? body.observedAt : null };
}

/** Exact comparison: does `holding` hold at least `amount` (a decimal string)? */
function holdsAtLeast(holding: Holding, amount: string): boolean {
  let required: bigint;
  try {
    required = BigInt(toBaseUnits(amount, holding.decimals));
  } catch {
    // More precision than the asset has, or not a decimal: never "enough".
    return false;
  }
  return BigInt(holding.amount) >= required;
}

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Builds the snapshot of one lane. Portfolios of the other lane are ignored.
 * An account that failed keeps its previous reading, marked stale; one with
 * no previous reading is left out (unknown is never shown as empty).
 */
export function buildHoldingsSnapshot({
  lane,
  portfolios,
  failures = [],
  previous = null,
  observedAt,
}: {
  readonly lane: HoldingsLane;
  readonly portfolios: readonly NetworkHoldings[];
  readonly failures?: readonly PortfolioFailure[];
  readonly previous?: HoldingsSnapshot | null;
  readonly observedAt: string;
}): HoldingsSnapshot {
  const byNetwork: Partial<Record<NetworkKey, NetworkHoldings>> = {};
  for (const portfolio of portfolios) {
    if (laneOfNetwork(portfolio.network) !== lane) continue;
    byNetwork[portfolio.network] = { ...portfolio, observedAt: portfolio.observedAt || observedAt };
  }
  if (previous && previous.lane === lane) {
    for (const failure of failures) {
      const parsed = parseAccountId(failure.account);
      if (!parsed || byNetwork[parsed.chain.key]) continue;
      const last = previous.byNetwork[parsed.chain.key];
      if (last && last.account === parsed.id) byNetwork[parsed.chain.key] = { ...last, stale: true };
    }
  }
  return snapshotOf(lane, observedAt, byNetwork);
}

function snapshotOf(
  lane: HoldingsLane,
  observedAt: string,
  byNetwork: Partial<Record<NetworkKey, NetworkHoldings>>,
): HoldingsSnapshot {
  const frozen = Object.freeze({ ...byNetwork });
  return Object.freeze({
    lane,
    observedAt,
    byNetwork: frozen,
    fundedFor(symbol: string, amount: string): readonly NetworkKey[] {
      const wanted = normalizedSymbol(symbol);
      const funded: { readonly network: NetworkKey; readonly holding: Holding }[] = [];
      for (const network of NETWORK_KEYS) {
        const entry = frozen[network];
        if (!entry) continue;
        const holding = entry.top.find((candidate) => normalizedSymbol(candidate.symbol) === wanted);
        if (holding && holdsAtLeast(holding, amount)) funded.push({ network, holding });
      }
      // Best first: the largest balance of the asset; registry order breaks ties.
      return funded
        .sort((a, b) => compareHoldings({ ...a.holding, usd: null }, { ...b.holding, usd: null }))
        .map((entry) => entry.network);
    },
  });
}

/** Totals for a lane header ("Production · $142.03 priced · 1 unpriced"). */
export function laneTotals(snapshot: HoldingsSnapshot): { readonly totalUsd: number; readonly unpriced: number } {
  let total = 0;
  let unpriced = 0;
  for (const entry of Object.values(snapshot.byNetwork)) {
    if (!entry) continue;
    total += entry.totalUsd;
    unpriced += entry.unpriced;
  }
  return { totalUsd: Math.round(total * 100) / 100, unpriced };
}

/** The network with the most priced value (Auto's "most funds" caption); null when nothing is priced. */
export function mostFunded(snapshot: HoldingsSnapshot | null): NetworkKey | null {
  if (!snapshot) return null;
  let best: NetworkKey | null = null;
  let bestUsd = 0;
  for (const network of NETWORK_KEYS) {
    const entry = snapshot.byNetwork[network];
    if (entry && entry.totalUsd > bestUsd) {
      best = network;
      bestUsd = entry.totalUsd;
    }
  }
  return best;
}

/** The first `count` holdings of a network as "120.40 USDC" (amounts exactly as the API formats them). */
export function holdingLabels(entry: NetworkHoldings | null | undefined, count = ROW_HOLDINGS): readonly string[] {
  return entry ? entry.top.slice(0, count).map((holding) => `${holding.formatted} ${holding.symbol}`) : [];
}

/** USD for display: "$127.50"; null prints nothing (unpriced). */
export function formatUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// --- Reading -------------------------------------------------------------------

/** Most accounts one batch request carries (the API's limit). */
export const MAX_BATCH_ACCOUNTS = 12;
/** Most accounts read one by one when the API has no batch route: the six production accounts. */
export const MAX_FALLBACK_ACCOUNTS = 6;

/** Where portfolios come from (`platformApi.fetchPortfolios` wires the SDK client in). */
export interface PortfolioSource {
  /** `GET /v1/portfolio?accounts=…`; resolves null when the API has no batch route (404). */
  batch(accounts: readonly string[]): Promise<unknown>;
  /** `GET /v1/portfolio/{account}`. */
  single(account: string): Promise<unknown>;
}

export interface PortfolioReads {
  readonly portfolios: readonly NetworkHoldings[];
  readonly failures: readonly PortfolioFailure[];
  readonly observedAt: string;
  /** "per-account" when the API had no batch route: the caller can skip the batch next time. */
  readonly source: "batch" | "per-account";
}

function failureOf(account: string, error: unknown): PortfolioFailure {
  const record = isRecord(error) ? error : {};
  return {
    account,
    code: typeof record.code === "string" ? record.code : "UNAVAILABLE",
    message: error instanceof Error ? error.message : "The portfolio could not be read.",
  };
}

/**
 * Reads the portfolios of `accounts` (duplicates removed, request order
 * kept): one batch request, or, on an API without the batch route, one read
 * per account for at most six accounts. An account that cannot be read is a
 * failure, never an empty portfolio; any other batch error is thrown so the
 * caller keeps its last snapshot.
 */
export async function readPortfolios(
  source: PortfolioSource,
  accounts: readonly string[],
  { skipBatch = false, now = () => new Date().toISOString() }: { readonly skipBatch?: boolean; readonly now?: () => string } = {},
): Promise<PortfolioReads> {
  const unique = [...new Set(accounts)];
  if (!skipBatch) {
    const requested = unique.slice(0, MAX_BATCH_ACCOUNTS);
    const body = requested.length > 0 ? await source.batch(requested) : { portfolios: [], failures: [] };
    if (body !== null) {
      const parsed = parsePortfolioBatch(body);
      const canonical = (account: string) => parseAccountId(account)?.id ?? account;
      const wanted = new Set(requested.map(canonical));
      // Only what was asked for: a portfolio of another account is ignored.
      const portfolios = parsed.portfolios.filter((portfolio) => wanted.has(portfolio.account));
      const read = new Set([...portfolios.map((portfolio) => portfolio.account), ...parsed.failures.map((failure) => canonical(failure.account))]);
      const missing = requested
        .filter((account) => !read.has(canonical(account)))
        .map((account) => ({ account, code: "NOT_READ", message: "The API returned no portfolio for this account." }));
      const skipped = unique.slice(MAX_BATCH_ACCOUNTS).map((account) => ({ account, code: "NOT_READ", message: "Too many accounts for one request." }));
      return {
        portfolios,
        failures: [...parsed.failures, ...missing, ...skipped],
        observedAt: parsed.observedAt ?? now(),
        source: "batch",
      };
    }
  }
  const read = unique.slice(0, MAX_FALLBACK_ACCOUNTS);
  const settled = await Promise.allSettled(read.map((account) => source.single(account)));
  const portfolios: NetworkHoldings[] = [];
  const failures: PortfolioFailure[] = [];
  settled.forEach((result, index) => {
    const account = read[index]!;
    if (result.status === "rejected") {
      failures.push(failureOf(account, result.reason));
      return;
    }
    const portfolio = parsePortfolio(result.value);
    if (portfolio) portfolios.push(portfolio);
    else failures.push({ account, code: "INVALID_RESPONSE", message: "The portfolio response did not parse." });
  });
  for (const account of unique.slice(MAX_FALLBACK_ACCOUNTS)) {
    failures.push({ account, code: "NOT_READ", message: "Read one account at a time: at most six accounts." });
  }
  return { portfolios, failures, observedAt: now(), source: "per-account" };
}
