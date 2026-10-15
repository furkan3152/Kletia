/**
 * Wallet facts for one clarify turn (clarify design §4.10), read only through
 * holdings.readFacts: the policy runs synchronously over a snapshot, every
 * lookup the snapshot cannot answer is recorded, the recorded needs are read
 * (within one turn's budget: at most 8 balance and 2 name reads), and the
 * policy runs again until it asks for nothing new. Unknown is never zero: a
 * read that failed, was skipped (preview accounts, no account of that
 * family) or did not fit the budget stays unknown. Nothing read here is
 * stored in the thread.
 */
import { fromBaseUnits, type AccountId, type NetworkKey } from "@kletia/core";
import { FACTS_DEADLINE_MS, MAX_BALANCE_READS, MAX_NAME_READS, readFacts, type FactNeed } from "../holdings.js";
import { positionAmount, type Snapshot } from "../solver/snapshot.js";
import { decimalsOf } from "./catalog.js";
import type { FactsView } from "./types.js";

type BalanceEntry = { readonly units: bigint; readonly decimals: number } | null;

const balanceKey = (network: NetworkKey, symbol: string) => `${network}|${symbol.toUpperCase()}`;
const nameKey = (name: string, network: NetworkKey) => `${network}|${name.toLowerCase()}`;

/** The facts of one turn: answers from what was read, records what was not. */
export class TurnFacts implements FactsView {
  private readonly balances = new Map<string, BalanceEntry>();
  private readonly names = new Map<string, string | null>();
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

  constructor(private readonly accounts: readonly AccountId[]) {}

  balance(network: NetworkKey, symbol: string): string | undefined {
    const key = balanceKey(network, symbol);
    if (this.balances.has(key)) {
      const entry = this.balances.get(key) ?? null;
      return entry ? fromBaseUnits(entry.units, entry.decimals) : undefined;
    }
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

  resolveName(name: string, network: NetworkKey): string | null {
    const key = nameKey(name, network);
    if (this.names.has(key)) return this.names.get(key) ?? null;
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
    if (!this.snapshot) return undefined;
    const amount = positionAmount(this.snapshot, network, protocol, symbol);
    if (amount === undefined || !/^\d+(\.\d+)?$/u.test(amount) || !/[1-9]/u.test(amount)) return undefined;
    return amount;
  }

  /** Attaches the solver's snapshot (positions); null detaches it. */
  useSnapshot(snapshot: Snapshot | null): void {
    this.snapshot = snapshot;
  }

  /** True when the last policy run asked for facts that can still be read this turn. */
  get pending(): boolean {
    return this.wanted.size > 0;
  }

  /**
   * Reads what the last run asked for, within what is left of this turn's
   * budget; anything that does not fit is settled as unknown.
   */
  async read(): Promise<void> {
    const needs = [...this.wanted.values()];
    this.wanted.clear();
    this.misses = 0;
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
      this.names.set(nameKey(need.name, need.network), fact.status === "known" && fact.address ? fact.address : null);
    });
    // Charged conservatively (a holdings cache hit costs no network read but still counts here).
    this.balanceReads += Math.min(balanceNeeds.length, balanceBudget);
    this.nameReads += Math.min(nameNeeds.length, nameBudget);
  }
}

/** Runs `step` over the facts until it asks for nothing new (at most `rounds` reads). */
export async function withFacts<T>(facts: TurnFacts, step: () => T, rounds = 6): Promise<T> {
  let result = step();
  for (let round = 0; round < rounds && facts.pending; round += 1) {
    await facts.read();
    result = step();
  }
  return result;
}
