/**
 * Pure aggregation of a wallet set's reads (no I/O): wallet holdings, venue
 * positions, staking tokens and debts into one list each, totals that cover
 * the priced part only (and say so), and allocation by network, asset and
 * protocol. Unknown values stay null with a reason: nothing unpriced is
 * counted as $0, and nothing unread is reported as empty.
 */
import {
  CHAINS,
  getAsset,
  getProtocol,
  JOURNEY_VALUE_SOURCES,
  VENUE_CONTRACTS,
  type AccountId,
  type DataAllocation,
  type DataAllocationSlice,
  type DataFailure,
  type DataHolding,
  type DataPortfolioTotals,
  type DataPosition,
  type DataPositionKind,
  type DataSource,
  type DataUsdValue,
  type NetworkKey,
  type ProtocolId,
  type VenuePosition,
} from "@kletia/core";
import type { AccountPortfolio, PortfolioFailure } from "../engine/portfolio.js";
import type { LendingAccountsResult } from "./lending.js";

const round2 = (value: number): number => Math.round(value * 100) / 100;

const SOURCES: ReadonlySet<string> = new Set(JOURNEY_VALUE_SOURCES);

function sourceOf(raw: string): DataSource {
  return SOURCES.has(raw) ? (raw as DataSource) : "unpriced";
}

/** The USD value of a priced amount, or null with why it is not known. */
function holdingValue(usd: number | null, source: string, pricedAt: string | null, testnet: boolean): DataUsdValue {
  if (usd !== null && Number.isFinite(usd)) return { usd: round2(usd), source: sourceOf(source), asOf: pricedAt };
  return {
    usd: null,
    source: testnet ? "testnet" : "unpriced",
    asOf: null,
    reason: testnet ? "Test-network assets have no market price." : "No price source covers this asset.",
  };
}

export function holdingsOf(portfolios: readonly AccountPortfolio[]): DataHolding[] {
  return portfolios.flatMap((portfolio) =>
    portfolio.holdings
      .filter((holding) => holding.amount !== "0")
      .map((holding) => ({
        account: portfolio.account,
        network: portfolio.network,
        asset: holding.asset,
        symbol: holding.symbol,
        amount: holding.amount,
        formatted: holding.formatted,
        value: holdingValue(holding.usd, holding.priceSource, holding.pricedAt, CHAINS[portfolio.network].environment === "testnet"),
      })),
  );
}

/** The staking protocol whose token `address` is on `network` (registry pins), or null. */
function stakingProtocol(network: NetworkKey, address: string): ProtocolId | null {
  const wanted = CHAINS[network].vm === "evm" ? address.toLowerCase() : address;
  const pin = VENUE_CONTRACTS.find((contract) =>
    contract.network === network &&
    (contract.role === "lst-token" || contract.role === "pool-mint") &&
    (CHAINS[network].vm === "evm" ? contract.address.toLowerCase() : contract.address) === wanted);
  return pin?.protocol ?? null;
}

/** Liquid-staking tokens among the holdings, as staking positions (their value is already in the wallet total). */
export function stakingPositions(holdings: readonly DataHolding[]): DataPosition[] {
  return holdings.flatMap((holding) => {
    const asset = getAsset(holding.asset);
    if (asset?.category !== "liquid-staking") return [];
    const protocol = asset.address ? stakingProtocol(holding.network, asset.address) : null;
    const position: DataPosition = {
      id: `${holding.network}:${protocol ?? "staking"}:${holding.symbol}`,
      account: holding.account,
      network: holding.network,
      protocol,
      name: protocol ? `${getProtocol(protocol)?.name ?? protocol} ${holding.symbol}` : `${holding.symbol} (liquid staking)`,
      kind: "staking",
      symbol: holding.symbol,
      amount: holding.formatted,
      value: holding.value,
      apy: null,
      inWallet: true,
    };
    return [position];
  });
}

const VAULT_KINDS: ReadonlySet<string> = new Set(["erc4626", "spark-vault", "yearn-vault", "fluid-ftoken"]);

/** Venue positions (aTokens, Comet balances, vault shares, mTokens, jlTokens) of one account. */
export function venuePositions(account: AccountId, positions: readonly VenuePosition[], venueKind: (venue: string) => string | null): DataPosition[] {
  return positions.map((position) => {
    const kind: DataPositionKind = VAULT_KINDS.has(venueKind(position.venue) ?? "") ? "vault" : "supply";
    return {
      id: position.venue,
      account,
      network: position.network,
      protocol: position.protocol,
      name: position.name,
      kind,
      symbol: position.underlying.symbol,
      amount: position.underlying.formatted,
      value: position.usd !== null && Number.isFinite(position.usd)
        ? { usd: round2(position.usd), source: "adapter", asOf: position.observedAt }
        : { usd: null, source: "unpriced", asOf: null, reason: `${position.underlying.symbol} could not be priced.` },
      apy: position.apy,
      inWallet: false,
    };
  });
}

/** Venues or accounts that could not be read, as failures (unknown, never empty). */
export function readFailures(portfolios: readonly AccountPortfolio[], failures: readonly PortfolioFailure[], lending: LendingAccountsResult): DataFailure[] {
  return [
    ...failures.map((failure) => ({ subject: failure.account, code: failure.code, message: failure.message })),
    ...portfolios.flatMap((portfolio) =>
      (portfolio.positionsUnavailable ?? []).map((entry) => ({ subject: entry.venue === "*" ? portfolio.account : entry.venue, code: entry.code, message: entry.message }))),
    ...lending.failures,
  ];
}

/** Sum of the priced values; an empty list is a real $0 unless something went unread (`unread`), then unknown. */
function sum(values: readonly DataUsdValue[], source: DataSource, asOf: string, empty: string, unread: boolean): DataUsdValue {
  const known = values.filter((value) => value.usd !== null);
  if (values.length > 0 && known.length === 0) return { usd: null, source, asOf: null, reason: "None of these values could be priced." };
  if (values.length === 0 && unread) return { usd: null, source, asOf: null, reason: "Some sources could not be read." };
  const total = round2(known.reduce((acc, value) => acc + (value.usd as number), 0));
  return values.length === 0 ? { usd: 0, source, asOf, reason: empty } : { usd: total, source, asOf };
}

/**
 * Totals of the priced part: net = wallet + positions (staking tokens are in
 * the wallet already) - debt. `complete` is false when anything had no price
 * or could not be read; `net.reason` then says the totals are partial.
 */
export function totalsOf(holdings: readonly DataHolding[], positions: readonly DataPosition[], failures: readonly DataFailure[], asOf: string): DataPortfolioTotals {
  const counted = positions.filter((position) => !position.inWallet);
  const unread = failures.length > 0;
  const wallet = sum(holdings.map((holding) => holding.value), "kletia", asOf, "No balances.", unread);
  const supplied = sum(counted.filter((position) => position.kind !== "borrow").map((position) => position.value), "kletia", asOf, "No venue positions.", unread);
  const debt = sum(counted.filter((position) => position.kind === "borrow").map((position) => position.value), "kletia", asOf, "No debt.", unread);
  const unpriced = holdings.filter((holding) => holding.value.usd === null).length + counted.filter((position) => position.value.usd === null).length;
  const complete = unpriced === 0 && failures.length === 0;
  const parts = [wallet.usd, supplied.usd, debt.usd];
  const net: DataUsdValue = parts.every((part) => part === null)
    ? { usd: null, source: "kletia", asOf: null, reason: failures.length > 0 ? "Nothing could be read." : "Nothing could be priced." }
    : {
        usd: round2((wallet.usd ?? 0) + (supplied.usd ?? 0) - (debt.usd ?? 0)),
        source: "kletia",
        asOf,
        ...(complete ? {} : { reason: `Partial: ${unpriced} unpriced value(s) and ${failures.length} unread source(s) are left out.` }),
      };
  return { net, wallet, positions: supplied, debt, unpriced, complete };
}

function slices(entries: Iterable<readonly [string, string, number]>): DataAllocationSlice[] {
  const byKey = new Map<string, { label: string; usd: number }>();
  for (const [key, label, usd] of entries) {
    const current = byKey.get(key);
    byKey.set(key, { label, usd: (current?.usd ?? 0) + usd });
  }
  const gross = [...byKey.values()].reduce((acc, entry) => acc + entry.usd, 0);
  return [...byKey.entries()]
    .filter(([, entry]) => entry.usd > 0)
    .map(([key, entry]) => ({ key, label: entry.label, usd: round2(entry.usd), share: gross > 0 ? Math.round((entry.usd / gross) * 1e4) / 1e4 : 0 }))
    .sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key));
}

/**
 * DataAllocation of the priced gross value (holdings plus supplied positions; debt
 * and unpriced values are left out) by network, asset symbol and protocol
 * ("wallet" for holdings that are not deployed anywhere).
 */
export function allocationOf(holdings: readonly DataHolding[], positions: readonly DataPosition[]): DataAllocation {
  const staked = new Set(positions.filter((position) => position.inWallet).map((position) => `${position.account}|${position.symbol}`));
  type Part = { network: NetworkKey; symbol: string; protocol: string; protocolLabel: string; usd: number };
  const parts: Part[] = [
    ...holdings.filter((holding) => holding.value.usd !== null).map((holding) => {
      const position = staked.has(`${holding.account}|${holding.symbol}`) ? positions.find((entry) => entry.inWallet && entry.account === holding.account && entry.symbol === holding.symbol) : undefined;
      const protocol = position?.protocol ?? (position ? "staking" : "wallet");
      return { network: holding.network, symbol: holding.symbol, protocol, protocolLabel: protocolLabel(protocol), usd: holding.value.usd as number };
    }),
    ...positions.filter((position) => !position.inWallet && position.kind !== "borrow" && position.value.usd !== null).map((position) => ({
      network: position.network,
      symbol: position.symbol,
      protocol: position.protocol ?? "other",
      protocolLabel: protocolLabel(position.protocol ?? "other"),
      usd: position.value.usd as number,
    })),
  ];
  return {
    byNetwork: slices(parts.map((part) => [part.network, CHAINS[part.network].name, part.usd] as const)),
    byAsset: slices(parts.map((part) => [part.symbol.toUpperCase(), part.symbol, part.usd] as const)),
    byProtocol: slices(parts.map((part) => [part.protocol, part.protocolLabel, part.usd] as const)),
  };
}

function protocolLabel(protocol: string): string {
  if (protocol === "wallet") return "Wallet (not deployed)";
  if (protocol === "staking") return "Liquid staking";
  if (protocol === "other") return "Other";
  return getProtocol(protocol)?.name ?? protocol;
}
