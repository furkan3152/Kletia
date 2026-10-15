/**
 * Test seam for the goal solver (packages P4/P5): the clarify corpus' fixture
 * wallets as solver snapshots (holdings, positions, stub prices and APYs) and
 * as the policy's facts, plus a round-trip helper that runs expanded steps
 * through the existing policy, the canonical sentence and the grammar.
 * Offline and deterministic: nothing here reads a network.
 */
import { fileURLToPath } from "node:url";
import {
  assetsForNetwork,
  CHAINS,
  findAssetBySymbol,
  parseAccountId,
  YIELD_VENUES,
  type AccountId,
  type AssetId,
  type Goal,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { loadCorpus, roundTripDifferences, type Corpus, type CorpusWallet } from "../clarify/corpusHarness.js";
import { decimalsOf } from "../clarify/catalog.js";
import { analyze } from "../clarify/policy.js";
import { render } from "../clarify/render.js";
import type { Analysis, FactsView, TurnContext, WorkState, WorkStep } from "../clarify/types.js";
import type { Snapshot, SnapshotApy, SnapshotHolding, SnapshotPosition, SnapshotPrice } from "../solver/snapshot.js";

const CORPUS_PATH = fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url));
let corpus: Corpus | null = null;

export function fixtureCorpus(): Corpus {
  corpus ??= loadCorpus(CORPUS_PATH);
  return corpus;
}

export function fixtureWallet(id: string): CorpusWallet {
  const wallet = fixtureCorpus().fixtures.wallets[id];
  if (!wallet) throw new Error(`unknown wallet ${id}`);
  return wallet;
}

/** The design's stub prices (§6): SOL $151.02, ETH $3,412.50, POL $0.51; stablecoins at par. */
export const STUB_PRICES: Readonly<Record<string, number>> = Object.freeze({ SOL: 151.02, ETH: 3412.5, WETH: 3412.5, POL: 0.51, WPOL: 0.51 });

export const T0 = Date.parse("2026-10-15T12:00:00Z");

export function goalOf(partial: Partial<Goal> & Pick<Goal, "kind">): Goal {
  return { spend: {}, want: {}, holder: { t: "self" }, constraints: {}, confidence: "frame", ...partial };
}

function priceFor(network: NetworkKey, symbol: string, overrides: Readonly<Record<string, number | null>>): number | null {
  const key = symbol.toUpperCase();
  const override = Object.entries(overrides).find(([name]) => name.toUpperCase() === key);
  if (override) return override[1];
  const stub = Object.entries(STUB_PRICES).find(([name]) => name.toUpperCase() === key);
  if (stub) return stub[1];
  const listed = findAssetBySymbol(network, symbol);
  return listed?.category === "stablecoin" ? 1 : null;
}

export interface SnapshotOptions {
  /** APY per YIELD_VENUES id (fraction); venues not listed are unknown. */
  readonly apy?: Readonly<Record<string, number | null>>;
  /** Price overrides by symbol (null: unpriced). */
  readonly prices?: Readonly<Record<string, number | null>>;
  /** Read the wallet's positions (default true when it has any). */
  readonly positions?: boolean;
  /** Networks whose balances could not be read (unknown, never zero). */
  readonly unknownNetworks?: readonly NetworkKey[];
  /** Balance overrides, "network:SYMBOL" -> decimal ("base:ETH": "0"). */
  readonly balances?: Readonly<Record<string, string>>;
}

/** A fixture wallet as the solver's snapshot. */
export function snapshotOf(walletId: string, options: SnapshotOptions = {}): Snapshot {
  const wallet = fixtureWallet(walletId);
  const accounts = wallet.accounts as AccountId[];
  const families = new Set(accounts.map((account) => parseAccountId(account)?.chain.namespace));
  const holdings: SnapshotHolding[] = [];
  const prices = new Map<AssetId, SnapshotPrice>();
  const overrides = options.prices ?? {};
  for (const network of Object.keys(CHAINS) as NetworkKey[]) {
    if (!families.has(CHAINS[network].namespace)) continue;
    const row = wallet.balances?.[network];
    for (const asset of assetsForNetwork(network)) {
      const price = priceFor(network, asset.symbol, overrides);
      if (price !== null) prices.set(asset.id, { asset: asset.id, usd: price, source: asset.category === "stablecoin" ? "usd-par" : "jupiter", at: T0, readAt: T0, stale: false });
      if (!row || options.unknownNetworks?.includes(network)) {
        holdings.push({ network, asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, status: "unknown", usd: null, source: "facts", reason: "read-failed" });
        continue;
      }
      const key = Object.keys(row).find((entry) => entry.toUpperCase() === asset.symbol.toUpperCase());
      const override = Object.entries(options.balances ?? {}).find(([name]) => name.toUpperCase() === `${network}:${asset.symbol}`.toUpperCase());
      const formatted = override ? override[1] : key ? (row[key] as string) : "0";
      const [whole = "0", fraction = ""] = formatted.split(".");
      const units = (BigInt(whole) * 10n ** BigInt(asset.decimals) + BigInt((fraction + "0".repeat(asset.decimals)).slice(0, asset.decimals) || "0")).toString();
      holdings.push({
        network, asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, status: "known", units, formatted,
        usd: price === null ? null : Math.round(Number(formatted) * price * 100) / 100, source: "facts",
      });
    }
  }
  const positions: SnapshotPosition[] = [];
  const positionNetworks = new Set<NetworkKey>();
  if (options.positions ?? Object.keys(wallet.positions ?? {}).length > 0) {
    for (const [key, amount] of Object.entries(wallet.positions ?? {})) {
      const [network, protocol, symbol] = key.split("/") as [NetworkKey, ProtocolId, string];
      const venue = YIELD_VENUES.find((entry) => entry.network === network && entry.protocol === protocol && entry.asset.toUpperCase() === symbol.toUpperCase());
      if (!venue) continue;
      positionNetworks.add(network);
      const price = priceFor(network, symbol, overrides);
      positions.push({ venue: venue.id, network, protocol, symbol: venue.asset, status: "known", units: amount, formatted: amount, decimals: decimalsOf(network, symbol), usd: price === null ? null : Number(amount) * price, apy: null });
    }
  }
  const apy = new Map<string, SnapshotApy>();
  for (const [venueId, value] of Object.entries(options.apy ?? {})) {
    const venue = YIELD_VENUES.find((entry) => entry.id === venueId);
    if (!venue) continue;
    apy.set(venueId, { venue: venueId, network: venue.network, protocol: venue.protocol, status: "known", apy: value, paused: false, frozen: false, at: new Date(T0).toISOString() });
  }
  return {
    accounts,
    observedAt: new Date(T0).toISOString(),
    holdings,
    positions,
    positionNetworks: [...positionNetworks],
    prices,
    apy,
    sweep: { status: "complete", networks: [], failures: [], peakConcurrency: 0, ms: 0 },
  };
}

/** A fixture wallet as the policy's facts (balances, names, positions). */
export function factsOf(walletId: string): FactsView {
  const wallet = fixtureWallet(walletId);
  const names = fixtureCorpus().fixtures.names;
  return {
    balance(network, symbol) {
      const row = wallet.balances?.[network];
      if (!row) return undefined;
      const key = Object.keys(row).find((entry) => entry.toUpperCase() === symbol.toUpperCase());
      return key ? (row[key] as string) : "0";
    },
    resolveName(name, network) {
      const entry = names[name.toLowerCase()];
      return entry ? entry[network] ?? (CHAINS[network].vm === "evm" ? entry.evm ?? null : null) : null;
    },
    position(network, protocol, symbol) {
      const key = Object.keys(wallet.positions ?? {}).find((entry) => entry.toLowerCase() === `${network}/${protocol}/${symbol}`.toLowerCase());
      return key ? wallet.positions?.[key] : undefined;
    },
  };
}

export function contextOf(walletId: string): TurnContext {
  return { accounts: fixtureWallet(walletId).accounts, contracts: [] };
}

export interface PolicyRun {
  readonly analysis: Analysis;
  readonly sentence: string | null;
  /** Differences between the resolved actions and what the grammar compiles the sentence into (empty: same). */
  readonly roundTrip: readonly string[];
}

/** Runs expanded steps through the existing policy, the canonical sentence and the grammar. */
export function runPolicy(walletId: string, steps: readonly WorkStep[]): PolicyRun {
  const state: WorkState = {
    id: "th_test", rev: 1, status: "needs_input", steps: structuredClone([...steps]) as WorkStep[], open: [], corrections: [], turns: [], undo: [],
  };
  const ctx = contextOf(walletId);
  const analysis = analyze(state, ctx, factsOf(walletId));
  const sentence = analysis.resolved ? render(analysis.resolved) : null;
  const roundTrip = analysis.resolved && sentence ? roundTripDifferences(analysis.resolved, sentence, ctx) : [];
  return { analysis, sentence, roundTrip };
}
