/**
 * Debt and health of lending accounts, which the venue position reads (supply
 * side only) do not cover:
 *
 * - Aave V3 and SparkLend (same Pool interface): `Pool.getUserAccountData`
 *   per pool pinned in YIELD_VENUES gives collateral and debt in the pool's
 *   base currency and the health factor. The base currency is confirmed to be
 *   USD (`AaveOracle.BASE_CURRENCY() == 0x0`, unit from
 *   `BASE_CURRENCY_UNIT()`, found through `Pool.ADDRESSES_PROVIDER()` and
 *   `getPriceOracle()`); otherwise the debt stays unpriced.
 *   Interfaces: https://aave.com/docs/developers/smart-contracts/pool and
 *   https://aave.com/docs/developers/smart-contracts/oracles
 * - Compound V3: `Comet.borrowBalanceOf` (base asset owed) and
 *   `Comet.isLiquidatable` per Comet pinned in YIELD_VENUES. Comet has no
 *   health factor; it is reported null with the reason.
 *   Interface: https://docs.compound.finance/collateral-and-borrowing/
 * - Kamino: every pinned Kamino market's obligations of a Solana account
 *   from Kamino's API (`GET /kamino-market/{market}/users/{user}/obligations`,
 *   USD figures Kamino refreshes from its oracles): collateral as a supply
 *   position, debt as a borrow, health factor = liquidation limit /
 *   borrow-factor-adjusted debt (Kamino liquidates when the adjusted debt
 *   passes the limit), flagged like Aave's.
 *
 * Read-only `eth_call`s and API reads, each under its own timeout; a failed
 * read is a failure entry and an `unknown` health row, never "no debt".
 */
import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import {
  CHAINS,
  fromBaseUnits,
  isPreviewAccount,
  LENDING_HEALTH_THRESHOLDS,
  parseAccountId,
  YIELD_VENUES,
  type AaveReserveVenue,
  type AccountId,
  type CometVenue,
  type DataFailure,
  type DataPosition,
  type LendingHealth,
  type LendingHealthStatus,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { evmClient, isEvmNetwork } from "../engine/chains/evm.js";
import { listedAsset } from "../engine/holdings.js";
import { quoteAsset } from "../engine/preview/pricer.js";
import { KAMINO_API_URL } from "../../networks/solana/index.js";
import { PlatformError, toPlatformError } from "../errors.js";
import { historyFetch } from "./chain/fetch.js";

const READ_TIMEOUT_MS = 4_000;
const BASE_UNIT_TTL_MS = 60 * 60 * 1000;

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "function ADDRESSES_PROVIDER() view returns (address)",
]);
const PROVIDER_ABI = parseAbi(["function getPriceOracle() view returns (address)"]);
const ORACLE_ABI = parseAbi(["function BASE_CURRENCY() view returns (address)", "function BASE_CURRENCY_UNIT() view returns (uint256)"]);
const COMET_ABI = parseAbi([
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function isLiquidatable(address account) view returns (bool)",
]);

export interface AaveAccountData {
  readonly collateralBase: bigint;
  readonly debtBase: bigint;
  /** 18-decimal fixed point; type(uint256).max without debt. */
  readonly healthFactor: bigint;
}

/** The raw reads, replaceable in tests (`configureLendingReaders`). Read-only. */
export interface LendingReaders {
  aaveAccount(network: NetworkKey, pool: string, owner: string): Promise<AaveAccountData>;
  /** Units per USD of the pool's base currency; null when the base currency is not USD. */
  aaveBaseUnit(network: NetworkKey, pool: string): Promise<bigint | null>;
  cometBorrow(network: NetworkKey, comet: string, owner: string): Promise<{ readonly borrowed: bigint; readonly liquidatable: boolean }>;
  /** Kamino's obligations of `owner` in `market` (the API's JSON array). */
  kaminoObligations(market: string, owner: string): Promise<readonly KaminoObligation[]>;
}

export interface KaminoObligation {
  readonly obligationAddress?: string;
  readonly refreshedStats?: {
    readonly userTotalDeposit?: string;
    readonly userTotalBorrow?: string;
    readonly userTotalBorrowBorrowFactorAdjusted?: string;
    readonly borrowLiquidationLimit?: string;
  };
}

function client(network: NetworkKey) {
  if (!isEvmNetwork(network)) throw new Error(`${network} is not an EVM network`);
  return evmClient(network);
}

const DEFAULT_READERS: LendingReaders = {
  async aaveAccount(network, pool, owner) {
    const [collateralBase, debtBase, , , , healthFactor] = await client(network).readContract({
      address: getAddress(pool), abi: POOL_ABI, functionName: "getUserAccountData", args: [getAddress(owner)],
    });
    return { collateralBase, debtBase, healthFactor };
  },
  async aaveBaseUnit(network, pool) {
    const evm = client(network);
    const provider = await evm.readContract({ address: getAddress(pool), abi: POOL_ABI, functionName: "ADDRESSES_PROVIDER" });
    const oracle = await evm.readContract({ address: provider, abi: PROVIDER_ABI, functionName: "getPriceOracle" });
    const [currency, unit] = await Promise.all([
      evm.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "BASE_CURRENCY" }),
      evm.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "BASE_CURRENCY_UNIT" }),
    ]);
    // Aave V3 markets quote in USD: BASE_CURRENCY is the zero address then.
    return (currency as Address) === zeroAddress && unit > 0n ? unit : null;
  },
  async cometBorrow(network, comet, owner) {
    const evm = client(network);
    const account = getAddress(owner);
    const [borrowed, liquidatable] = await Promise.all([
      evm.readContract({ address: getAddress(comet), abi: COMET_ABI, functionName: "borrowBalanceOf", args: [account] }),
      evm.readContract({ address: getAddress(comet), abi: COMET_ABI, functionName: "isLiquidatable", args: [account] }),
    ]);
    return { borrowed, liquidatable };
  },
  async kaminoObligations(market, owner) {
    const body = await historyFetch(`${KAMINO_API_URL}/kamino-market/${market}/users/${owner}/obligations`, { provider: "Kamino", timeoutMs: READ_TIMEOUT_MS });
    if (!Array.isArray(body)) throw new PlatformError("PROVIDER_UNAVAILABLE", "Kamino returned an invalid obligations response.", 502);
    return body as KaminoObligation[];
  },
};

let readers: LendingReaders = DEFAULT_READERS;
const baseUnits = new Map<string, { readonly unit: bigint | null; readonly at: number }>();

/** Replaces the raw readers (tests); `null` restores the RPC readers. */
export function configureLendingReaders(next: Partial<LendingReaders> | null): void {
  readers = next === null ? DEFAULT_READERS : { ...DEFAULT_READERS, ...next };
  baseUnits.clear();
}

function timed<T>(read: Promise<T>): Promise<T> {
  read.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError("RPC_TIMEOUT", "The lending read timed out.", 504)), READ_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function baseUnit(network: NetworkKey, pool: string): Promise<bigint | null> {
  const key = `${network}|${pool.toLowerCase()}`;
  const cached = baseUnits.get(key);
  if (cached && Date.now() - cached.at < BASE_UNIT_TTL_MS) return cached.unit;
  const unit = await timed(readers.aaveBaseUnit(network, pool));
  baseUnits.set(key, { unit, at: Date.now() });
  return unit;
}

/** The status of a health factor (a fraction like 1.42). */
export function healthStatus(healthFactor: number): LendingHealthStatus {
  if (healthFactor < LENDING_HEALTH_THRESHOLDS.critical) return "critical";
  if (healthFactor < LENDING_HEALTH_THRESHOLDS.warning) return "warning";
  return "ok";
}

/** Health factors at or above this are "no debt" sentinels (type(uint256).max) rather than readings. */
const NO_DEBT_HEALTH = 10n ** 30n;

interface AavePool {
  readonly protocol: ProtocolId;
  readonly name: string;
  readonly pool: string;
}

/** Distinct Aave-family pools pinned on `network`. */
export function aavePools(network: NetworkKey): AavePool[] {
  const pools = new Map<string, AavePool>();
  for (const venue of YIELD_VENUES) {
    if (venue.kind !== "aave-reserve" || venue.network !== network) continue;
    const reserve = venue as AaveReserveVenue;
    const key = `${reserve.protocol}|${reserve.spender.toLowerCase()}`;
    if (!pools.has(key)) pools.set(key, { protocol: reserve.protocol, name: reserve.protocol === "sparklend" ? "SparkLend" : "Aave V3", pool: reserve.spender });
  }
  return [...pools.values()];
}

function comets(network: NetworkKey): CometVenue[] {
  return YIELD_VENUES.filter((venue): venue is CometVenue => venue.kind === "comet" && venue.network === network);
}

/** Pinned Kamino markets of `network` with their names ("Kamino Main"). */
function kaminoMarkets(network: NetworkKey): { readonly market: string; readonly name: string }[] {
  const markets = new Map<string, string>();
  for (const venue of YIELD_VENUES) {
    if (venue.kind !== "kamino-reserve" || venue.network !== network || markets.has(venue.market)) continue;
    markets.set(venue.market, venue.name.slice(0, venue.name.lastIndexOf(" ")));
  }
  return [...markets.entries()].map(([market, name]) => ({ market, name }));
}

export interface LendingAccountsResult {
  readonly debts: readonly DataPosition[];
  readonly health: readonly LendingHealth[];
  readonly failures: readonly DataFailure[];
}

interface LendingRead {
  readonly debt: DataPosition | null;
  /** Collateral the position reads do not see (Kamino obligations). */
  readonly supply?: DataPosition | null;
  readonly health: LendingHealth;
  readonly failure: DataFailure | null;
}

function failureOf(subject: string, error: unknown): DataFailure {
  const platform = toPlatformError(error);
  return { subject, code: platform.code, message: platform.message };
}

async function aaveAccount(account: AccountId, network: NetworkKey, owner: string, pool: AavePool, asOf: string) {
  const market = `${network}:${pool.protocol}:${pool.pool}`;
  const unknown = (reason: string): LendingHealth => ({ account, network, protocol: pool.protocol, market, healthFactor: null, status: "unknown", source: "adapter", asOf: null, reason });
  try {
    const data = await timed(readers.aaveAccount(network, pool.pool, owner));
    if (data.debtBase === 0n) {
      const health: LendingHealth = { account, network, protocol: pool.protocol, market, healthFactor: null, status: "no-debt", source: "adapter", asOf, reason: "No debt in this pool." };
      return { debt: null, health, failure: null };
    }
    const unit = await baseUnit(network, pool.pool).catch(() => null);
    const factor = data.healthFactor >= NO_DEBT_HEALTH ? null : Number(data.healthFactor) / 1e18;
    const health: LendingHealth = factor === null
      ? unknown("The pool reported debt without a health factor.")
      : { account, network, protocol: pool.protocol, market, healthFactor: Math.round(factor * 1e4) / 1e4, status: healthStatus(factor), source: "adapter", asOf };
    const debt: DataPosition = {
      id: market,
      account,
      network,
      protocol: pool.protocol,
      name: `${pool.name} debt`,
      kind: "borrow",
      symbol: "USD",
      amount: null,
      value: unit === null
        ? { usd: null, source: "unpriced", asOf: null, reason: "The pool's base currency could not be confirmed as USD." }
        : { usd: Math.round((Number(data.debtBase) / Number(unit)) * 100) / 100, source: "aave-oracle", asOf },
      apy: null,
      inWallet: false,
    };
    return { debt, health, failure: null };
  } catch (error) {
    const failure = failureOf(market, error);
    return { debt: null, health: unknown(`The account could not be read (${failure.code}).`), failure };
  }
}

async function cometAccount(account: AccountId, network: NetworkKey, owner: string, comet: CometVenue, asOf: string) {
  const market = comet.id;
  const base = { account, network, protocol: comet.protocol, market, healthFactor: null, source: "adapter" as const };
  try {
    const { borrowed, liquidatable } = await timed(readers.cometBorrow(network, comet.target, owner));
    if (borrowed === 0n) return { debt: null, health: { ...base, status: "no-debt" as const, asOf, reason: "No debt in this market." }, failure: null };
    const asset = listedAsset(network, comet.asset);
    const decimals = asset?.decimals ?? comet.receipt.decimals;
    const formatted = fromBaseUnits(borrowed, decimals);
    const quote = asset ? await quoteAsset(asset.id) : null;
    const health: LendingHealth = liquidatable
      ? { ...base, status: "critical", asOf, reason: "The account can be liquidated now." }
      : { ...base, status: "unknown", asOf, reason: "Compound V3 has no health factor; the account cannot be liquidated now." };
    const debt: DataPosition = {
      id: comet.id,
      account,
      network,
      protocol: comet.protocol,
      name: `${comet.name} debt`,
      kind: "borrow",
      symbol: comet.asset,
      amount: formatted,
      value: quote
        ? { usd: Math.round(Number(formatted) * quote.usd * 100) / 100, source: quote.source, asOf: quote.at }
        : { usd: null, source: "unpriced", asOf: null, reason: `${comet.asset} could not be priced.` },
      apy: null,
      inWallet: false,
    };
    return { debt, health, failure: null };
  } catch (error) {
    const failure = failureOf(market, error);
    return { debt: null, health: { ...base, status: "unknown" as const, asOf: null, reason: `The account could not be read (${failure.code}).` }, failure };
  }
}

const usdFigure = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** One Kamino market of a Solana account: its obligations' collateral and debt (USD) and the lowest health factor. */
async function kaminoAccount(account: AccountId, network: NetworkKey, owner: string, market: { readonly market: string; readonly name: string }, asOf: string): Promise<LendingRead> {
  const id = `${network}:kamino:${market.market}`;
  const base = { account, network, protocol: "kamino" as const, market: id };
  try {
    const obligations = await timed(readers.kaminoObligations(market.market, owner));
    let deposit = 0;
    let debt = 0;
    let lowest: number | null = null;
    for (const obligation of obligations) {
      const stats = obligation.refreshedStats;
      const [supplied, borrowed, adjusted, limit] = [stats?.userTotalDeposit, stats?.userTotalBorrow, stats?.userTotalBorrowBorrowFactorAdjusted, stats?.borrowLiquidationLimit].map(usdFigure);
      if (supplied === null || borrowed === null || adjusted === null || limit === null) throw new PlatformError("PROVIDER_UNAVAILABLE", "Kamino reported an obligation without its figures.", 502);
      deposit += supplied;
      debt += borrowed;
      if (adjusted > 0) lowest = Math.min(lowest ?? Number.POSITIVE_INFINITY, limit / adjusted);
    }
    const position = (kind: "supply" | "borrow", usd: number): DataPosition => ({
      id: `${id}:${kind}`, account, network, protocol: "kamino", name: `${market.name} ${kind === "supply" ? "collateral" : "debt"}`, kind, symbol: "USD", amount: null,
      value: { usd: Math.round(usd * 100) / 100, source: "kamino-api", asOf }, apy: null, inWallet: false,
    });
    const health: LendingHealth = lowest === null
      ? { ...base, healthFactor: null, status: "no-debt", source: "kamino-api", asOf }
      : { ...base, healthFactor: Math.round(lowest * 1e4) / 1e4, status: healthStatus(lowest), source: "kamino-api", asOf };
    return { supply: deposit > 0 ? position("supply", deposit) : null, debt: debt > 0 ? position("borrow", debt) : null, health, failure: null };
  } catch (error) {
    const failure = failureOf(id, error);
    return { debt: null, health: { ...base, healthFactor: null, status: "unknown", source: "kamino-api", asOf: null, reason: `The obligations could not be read (${failure.code}).` }, failure };
  }
}

/**
 * Debt and health of every account in `accounts`: EVM accounts at the pinned
 * Aave V3, SparkLend and Compound V3 markets of their network, Solana
 * accounts at the pinned Kamino markets (with the obligations' collateral);
 * health rows for loans and unreadable markets only. Preview accounts are
 * never read.
 */
export async function readLendingAccounts(accounts: readonly AccountId[]): Promise<LendingAccountsResult> {
  const asOf = new Date().toISOString();
  const reads: Promise<LendingRead>[] = [];
  for (const account of accounts) {
    const parsed = parseAccountId(account);
    if (!parsed || isPreviewAccount(account)) continue;
    const network = parsed.chain.key;
    if (CHAINS[network].vm === "evm") {
      for (const pool of aavePools(network)) reads.push(aaveAccount(account, network, parsed.address, pool, asOf));
      for (const comet of comets(network)) reads.push(cometAccount(account, network, parsed.address, comet, asOf));
    } else {
      for (const market of kaminoMarkets(network)) reads.push(kaminoAccount(account, network, parsed.address, market, asOf));
    }
  }
  const results = await Promise.all(reads);
  return {
    debts: results.flatMap((result) => [...(result.supply ? [result.supply] : []), ...(result.debt ? [result.debt] : [])]),
    // Markets without debt are left out: a health row is a loan, or a market that could not be read.
    health: results.map((result) => result.health).filter((row) => row.status !== "no-debt"),
    failures: results.flatMap((result) => (result.failure ? [result.failure] : [])),
  };
}
