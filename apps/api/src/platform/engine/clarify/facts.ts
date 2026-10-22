/**
 * Wallet facts for one clarify turn, read only through holdings.readFacts:
 * the policy runs synchronously over a snapshot, every lookup the snapshot
 * cannot answer is recorded, the recorded needs are read (within one turn's
 * budget: at most 8 balance and 2 name reads), and the policy runs again
 * until it asks for nothing new. Unknown is never zero: a read that failed,
 * was skipped (preview accounts, no account of that family) or did not fit
 * the budget stays unknown. Nothing read here is stored in the thread.
 */
import { findAssetBySymbol, fromBaseUnits, getProtocol, GOAL_LIMITS, YIELD_VENUES, type ProtocolId, type AccountId, type Goal, type NetworkKey } from "@kletia/core";
import { FACTS_DEADLINE_MS, MAX_BALANCE_READS, MAX_NAME_READS, readFacts, type FactNeed } from "../holdings.js";
import { quoteAsset } from "../preview/pricer.js";
import { positionAmount, readSnapshot, readVenueApy, type Snapshot } from "../solver/snapshot.js";
import { decimalsOf } from "./catalog.js";
import type { FactsView, UsdPrice } from "./types.js";

/** At most this many position reads (one network and protocol each) per turn. */
const MAX_POSITION_READS = 4;

/** A snapshot that read nothing: every position of the network unknown. */
const EMPTY_POSITIONS = (accounts: readonly AccountId[], _network: NetworkKey): Snapshot => ({
  accounts, observedAt: new Date(0).toISOString(), holdings: [], positions: [], positionNetworks: [], prices: new Map(), apy: new Map(),
  sweep: { status: "skipped", networks: [], failures: [], peakConcurrency: 0, ms: 0 },
});

/** At most this many price reads per turn (dollar amounts of a token, D11). */
const MAX_PRICE_READS = 4;

let clock: number | null = null;

/**
 * Fixes "now" for price ages (the snapshot's and D11's): tests and the
 * offline eval, whose fixed prices carry a fixed reading time. Null restores
 * the real clock.
 */
export function configureFactsClock(now: number | null): void {
  clock = now;
}

const nowMs = () => clock ?? Date.now();

type BalanceEntry = { readonly units: bigint; readonly decimals: number } | null;

const balanceKey = (network: NetworkKey, symbol: string) => `${network}|${symbol.toUpperCase()}`;
const nameKey = (name: string, network: NetworkKey) => `${network}|${name.toLowerCase()}`;

/** The facts of one turn: answers from what was read, records what was not. */
export class TurnFacts implements FactsView {
  private readonly balances = new Map<string, BalanceEntry>();
  /** Address, null (no address), or undefined when the records could not be read this turn. */
  private readonly names = new Map<string, string | null | undefined>();
  private readonly wanted = new Map<string, FactNeed>();
  private balanceReads = 0;
  private nameReads = 0;
  private readonly started = Date.now();
  /** When true, lookups the snapshot cannot answer are not recorded (option previews, frozen turns). */
  frozen = false;
  /** Lookups recorded since the last `read()` (or since freezing) that the snapshot could not answer. */
  misses = 0;
  /** The solver's snapshot of this turn (positions), when goal steps had one read. */
  private snapshot: Snapshot | null = null;
  /** Snapshots read this turn, by the goals they were read for. */
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly wantedSnapshots = new Map<string, readonly Goal[]>();
  private readonly prices = new Map<string, UsdPrice | null>();
  private readonly wantedPrices = new Map<string, { network: NetworkKey; symbol: string }>();
  private priceReads = 0;
  private readonly apys = new Map<string, number | null>();
  private readonly positionSnapshots = new Map<string, Snapshot>();
  private readonly wantedPositions = new Map<string, { network: NetworkKey; protocol: ProtocolId }>();
  private positionReads = 0;
  private readonly wantedApys = new Set<string>();

  constructor(private readonly accounts: readonly AccountId[]) {}

  balance(network: NetworkKey, symbol: string): string | undefined {
    const key = balanceKey(network, symbol);
    if (this.balances.has(key)) {
      const entry = this.balances.get(key) ?? null;
      return entry ? fromBaseUnits(entry.units, entry.decimals) : undefined;
    }
    // A goal turn's snapshot already read this balance (its chips show it): answered from it, no second read.
    const held = this.snapshotHolding(network, symbol);
    if (held !== undefined) return held;
    this.misses += 1;
    if (!this.frozen) this.wanted.set(`b|${key}`, { kind: "balance", network, asset: symbol });
    return undefined;
  }

  /** The balance in base units (departure.ts reads), or null when unknown. */
  balanceUnits(network: NetworkKey, symbol: string): bigint | null {
    const key = balanceKey(network, symbol);
    if (this.balances.has(key)) return this.balances.get(key)?.units ?? null;
    this.misses += 1;
    if (!this.frozen) this.wanted.set(`b|${key}`, { kind: "balance", network, asset: symbol });
    return null;
  }

  /** A known balance of the snapshots read this turn (decimal), or undefined. */
  private snapshotHolding(network: NetworkKey, symbol: string): string | undefined {
    const upper = symbol.toUpperCase();
    for (const snapshot of [this.snapshot, ...this.snapshots.values()]) {
      const holding = snapshot?.holdings.find((entry) => entry.network === network && entry.symbol.toUpperCase() === upper && entry.status === "known" && entry.formatted !== undefined);
      if (holding?.formatted !== undefined) return holding.formatted;
    }
    return undefined;
  }

  resolveName(name: string, network: NetworkKey): string | null | undefined {
    const key = nameKey(name, network);
    if (this.names.has(key)) return this.names.get(key);
    this.misses += 1;
    if (!this.frozen) this.wanted.set(`n|${key}`, { kind: "name", name, network });
    return null;
  }

  /**
   * The supplied amount of a position, from the solver's snapshot when one
   * was attached (`useSnapshot`); undefined without one (the planner reads
   * positions itself). Only a positive, unambiguous amount is answered: no
   * position, an unread or failed venue, or positions at several venues of
   * the protocol stay undefined, so the policy asks instead of assuming.
   */
  position(network: NetworkKey, protocol: string, symbol: string): string | undefined {
    // The solver's snapshot when it read this network's positions; else this turn's own read of them.
    const key = `${network}|${protocol}`;
    const source = this.snapshot?.positionNetworks.includes(network) ? this.snapshot : this.positionSnapshots.get(key);
    if (!source) {
      if (!protocol || !getProtocol(protocol as ProtocolId)) return undefined;
      this.misses += 1;
      if (!this.frozen) this.wantedPositions.set(key, { network, protocol: protocol as ProtocolId });
      return undefined;
    }
    const amount = positionAmount(source, network, protocol, symbol);
    if (amount === undefined || !/^\d+(\.\d+)?$/u.test(amount) || !/[1-9]/u.test(amount)) return undefined;
    return amount;
  }

  /**
   * The positions held at `protocol` on `network`, from the same reads as
   * `position`; undefined until read, or when any of its venues there could
   * not be read (a failed read is never "no position").
   */
  positionsAt(network: NetworkKey, protocol: string): readonly { readonly symbol: string; readonly amount: string }[] | undefined {
    const key = `${network}|${protocol}`;
    const source = this.snapshot?.positionNetworks.includes(network) ? this.snapshot : this.positionSnapshots.get(key);
    if (!source) {
      if (!protocol || !getProtocol(protocol as ProtocolId)) return undefined;
      this.misses += 1;
      if (!this.frozen) this.wantedPositions.set(key, { network, protocol: protocol as ProtocolId });
      return undefined;
    }
    const rows = source.positions.filter((entry) => entry.network === network && entry.protocol === protocol);
    if (rows.length === 0 || rows.some((entry) => entry.status !== "known" || entry.units === undefined || entry.formatted === undefined)) return undefined;
    return rows
      .filter((entry) => BigInt(entry.units as string) > 0n)
      .map((entry) => ({ symbol: entry.symbol, amount: entry.formatted as string }));
  }

  /**
   * The solver's snapshot for `goals`, or undefined until it is read. A
   * frozen turn (option previews) reuses the last snapshot read for
   * other goals rather than reading again.
   */
  goalSnapshot(goals: readonly Goal[]): Snapshot | undefined {
    const key = JSON.stringify(goals);
    const found = this.snapshots.get(key);
    if (found) return found;
    this.misses += 1;
    if (this.frozen) return this.snapshot ?? undefined;
    this.wantedSnapshots.set(key, goals);
    return undefined;
  }

  /** The USD price of a listed token (D11), or undefined when unpriced or not read yet (never guessed). */
  usdPrice(network: NetworkKey, symbol: string): UsdPrice | undefined {
    const key = balanceKey(network, symbol);
    if (this.prices.has(key)) return this.prices.get(key) ?? undefined;
    this.misses += 1;
    if (!this.frozen) this.wantedPrices.set(key, { network, symbol });
    return undefined;
  }

  /** A venue's supply APY (fraction), null when it does not report one, undefined until read. */
  venueApy(venueId: string): number | null | undefined {
    if (this.apys.has(venueId)) return this.apys.get(venueId) ?? null;
    this.misses += 1;
    if (!this.frozen) this.wantedApys.add(venueId);
    return undefined;
  }

  /** Attaches the solver's snapshot (positions); null detaches it. */
  useSnapshot(snapshot: Snapshot | null): void {
    this.snapshot = snapshot;
  }

  /** True when the last policy run asked for facts that can still be read this turn. */
  get pending(): boolean {
    return this.wanted.size > 0 || this.wantedSnapshots.size > 0 || this.wantedPrices.size > 0 || this.wantedApys.size > 0 || this.wantedPositions.size > 0;
  }

  /**
   * Reads what the last run asked for, within what is left of this turn's
   * budget; anything that does not fit is settled as unknown.
   */
  async read(): Promise<void> {
    const needs = [...this.wanted.values()];
    this.wanted.clear();
    this.misses = 0;
    await Promise.all([this.readSnapshots(), this.readPrices(), this.readApys(), this.readPositions()]);
    if (needs.length === 0) return;
    const balanceNeeds = needs.filter((need): need is Extract<FactNeed, { kind: "balance" }> => need.kind === "balance");
    const nameNeeds = needs.filter((need): need is Extract<FactNeed, { kind: "name" }> => need.kind === "name");
    const balanceBudget = Math.max(0, MAX_BALANCE_READS - this.balanceReads);
    const nameBudget = Math.max(0, MAX_NAME_READS - this.nameReads);
    const deadlineMs = Math.max(1, FACTS_DEADLINE_MS - (Date.now() - this.started));
    const facts = await readFacts(this.accounts, [...balanceNeeds, ...nameNeeds], { balances: balanceBudget, names: nameBudget, deadlineMs });
    facts.balances.forEach((fact, index) => {
      const need = balanceNeeds[index] as Extract<FactNeed, { kind: "balance" }>;
      const known = fact.status === "known" && fact.amount !== undefined;
      this.balances.set(balanceKey(need.network, need.asset), known
        ? { units: BigInt(fact.amount as string), decimals: fact.decimals ?? decimalsOf(need.network, need.asset) }
        : null);
    });
    facts.names.forEach((fact, index) => {
      const need = nameNeeds[index] as Extract<FactNeed, { kind: "name" }>;
      this.names.set(nameKey(need.name, need.network), fact.status === "known" && fact.address ? fact.address : fact.unavailable ? undefined : null);
    });
    // Charged conservatively (a holdings cache hit costs no network read but still counts here).
    this.balanceReads += Math.min(balanceNeeds.length, balanceBudget);
    this.nameReads += Math.min(nameNeeds.length, nameBudget);
  }

  /** The snapshots the last run asked for (the snapshot keeps its own read budget and deadline). */
  private async readSnapshots(): Promise<void> {
    const wanted = [...this.wantedSnapshots.entries()];
    this.wantedSnapshots.clear();
    for (const [key, goals] of wanted) {
      const deadlineMs = Math.max(1, FACTS_DEADLINE_MS - (Date.now() - this.started));
      const snapshot = await readSnapshot(this.accounts, goals, { deadlineMs, ...(clock !== null ? { now: clock } : {}) });
      this.snapshots.set(key, snapshot);
      this.snapshot = snapshot;
    }
  }

  /**
   * The venue positions the last run asked for (a withdrawal's network): one
   * network and protocol per read, at most MAX_POSITION_READS a turn; the rest
   * stay unknown.
   */
  private async readPositions(): Promise<void> {
    const wanted = [...this.wantedPositions.entries()];
    this.wantedPositions.clear();
    await Promise.all(wanted.map(async ([key, need]) => {
      if (this.positionReads >= MAX_POSITION_READS) return;
      this.positionReads += 1;
      const goal: Goal = {
        kind: "exit", spend: { from: { network: need.network, custody: { kind: "position", protocol: need.protocol } } }, want: {}, holder: { t: "self" }, constraints: {}, confidence: "exact",
      };
      const deadlineMs = Math.max(1, FACTS_DEADLINE_MS - (Date.now() - this.started));
      // Positions only: no balance reads beyond the turn's own budget (the snapshot would read the gas asset).
      this.positionSnapshots.set(key, await readSnapshot(this.accounts, [goal], { deadlineMs, balances: 0, ...(clock !== null ? { now: clock } : {}) }));
    }));
    // Needs past the cap stay unknown: recorded as read so the policy stops asking for them.
    for (const [key, need] of wanted) {
      if (!this.positionSnapshots.has(key)) this.positionSnapshots.set(key, EMPTY_POSITIONS(this.accounts, need.network));
    }
  }

  /** The venue APYs the last run asked for (at most 6 a turn, read in parallel). */
  private async readApys(): Promise<void> {
    const wanted = [...this.wantedApys];
    this.wantedApys.clear();
    await Promise.all(wanted.map(async (id, index) => {
      const venue = YIELD_VENUES.find((entry) => entry.id === id);
      this.apys.set(id, venue && index < 6 ? await readVenueApy(venue, nowMs()).catch(() => null) : null);
    }));
  }

  /** The prices the last run asked for (at most MAX_PRICE_READS a turn; the rest stay unpriced). */
  private async readPrices(): Promise<void> {
    const wanted = [...this.wantedPrices.entries()];
    this.wantedPrices.clear();
    await Promise.all(wanted.map(async ([key, need]) => {
      const asset = findAssetBySymbol(need.network, need.symbol);
      if (!asset || this.priceReads >= MAX_PRICE_READS) {
        this.prices.set(key, null);
        return;
      }
      this.priceReads += 1;
      const quote = await quoteAsset(asset.id).catch(() => null);
      const parsed = quote ? Date.parse(quote.at) : NaN;
      const at = Number.isFinite(parsed) ? parsed : nowMs();
      // A market reading older than the goal limit is never used to convert an amount (oracles keep their heartbeat).
      const stale = quote !== null && quote.source !== "chainlink" && nowMs() - at > GOAL_LIMITS.priceMaxAgeMs;
      this.prices.set(key, quote && Number.isFinite(quote.usd) && quote.usd > 0 && quote.source !== "unpriced" && !stale
        ? { usd: quote.usd, source: quote.source, at }
        : null);
    }));
  }
}
