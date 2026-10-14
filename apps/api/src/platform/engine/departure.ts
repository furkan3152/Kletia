/**
 * Departure: where the money of an intent starts (`IntentRequest.sourceNetwork`),
 * with one set of rules shared by the planner and the clarify layer.
 *
 * A fixed departure S, for the first action A (on network N):
 * - N is S: nothing changes (`chosen: "request"`).
 * - The sentence named N (or the structured action did): the sentence wins
 *   (`chosen: "text"`, a warning says the departure was not used).
 * - S and N are on different capital lanes, or no bridge serves the asset
 *   from S to N: SOURCE_UNREACHABLE.
 * - A is a withdraw: it starts where the position is (`chosen: "text"`, warning).
 * - A's input is not on S (SOL from Base, a token only N lists): A runs
 *   where its input lives (`chosen: "text"`, warning). An input S also
 *   lists that no bridge moves to N (between testnets) is SOURCE_UNREACHABLE.
 * - A is a transfer to a third party: it becomes one bridge leg from S that
 *   pays the recipient on N, spending exactly the stated input; the
 *   recipient receives what arrives (at least the step's minimum, shown).
 * - A is a swap, deposit, stake or bridge: a bridge from S to N is
 *   prepended and A spends what arrives (`bridged: true`); the planner's
 *   merge may then turn bridge + swap into one cross-network swap.
 *
 * `auto` reads balances (holdings.ts: at most 5 reads, 3 s, 15 s cache,
 * preview accounts never read): A's own network when it covers the amount,
 * else the network with the largest covering balance (as a fixed departure
 * from there), else SOURCE_REQUIRED with `details.candidates`. Unknown is
 * never zero: when a balance cannot be read, nothing is chosen on it.
 *
 * Portable inputs (v1): canonical USDC between the mainnet networks that list
 * it, native ETH between Base, Arbitrum One, Ethereum and OP Mainnet; bridges
 * never run between testnets.
 */
import {
  CHAINS,
  findAssetByAddress,
  findAssetBySymbol,
  getProtocol,
  isEvmAddress,
  isSolanaAddress,
  nativeAssetId,
  getAsset,
  toBaseUnits,
  fromBaseUnits,
  type AccountId,
  type AssetDescriptor,
  type IntentActionSpec,
  type IntentDeparture,
  type IntentRequest,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../errors.js";
import { candidateAdapters } from "./adapters/registry.js";
import { resolvedFromDescriptor } from "./assets.js";
import { knownAmount, onlyPreviewAccounts, readFacts, FACTS_DEADLINE_MS } from "./holdings.js";

/** At most this many balance reads per plan. */
export const MAX_DEPARTURE_READS = 5;

/** Native ETH moves between these networks (Relay, LI.FI, deBridge). */
const ETH_PORTABLE: ReadonlySet<NetworkKey> = new Set(["base", "arbitrum", "ethereum", "optimism"]);

/** One balance the departure step wants to know: the request's own account on `network`. */
export interface DepartureBalanceRead {
  readonly network: NetworkKey;
  /** Registry symbol on that network. */
  readonly asset: string;
}

/** Reads balances in base units, one entry per read (null: unknown, never zero). */
export type DepartureBalanceReader = (reads: readonly DepartureBalanceRead[]) => Promise<readonly (bigint | null)[]>;

/** The default reader: holdings.readFacts within the departure budget. */
export function holdingsBalanceReader(accounts: readonly AccountId[]): DepartureBalanceReader {
  return async (reads) => {
    const facts = await readFacts(
      accounts,
      reads.slice(0, MAX_DEPARTURE_READS).map((read) => ({ kind: "balance" as const, network: read.network, asset: read.asset })),
      { balances: MAX_DEPARTURE_READS, deadlineMs: FACTS_DEADLINE_MS },
    );
    return reads.map((read, index) => (index < MAX_DEPARTURE_READS ? knownAmount(facts.balances[index]) : null));
  };
}

export interface DepartureOutcome {
  readonly actions: IntentActionSpec[];
  readonly explicitNetwork: boolean[];
  /** Absent when the request behaves as if no sourceNetwork was sent (auto with preview accounts). */
  readonly departure?: IntentDeparture;
  readonly warnings: string[];
}

function name(network: NetworkKey): string {
  return CHAINS[network].name;
}

function reasonText(text: string): string {
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}

/** A balance for a reason line: at most 4 decimals, trailing zeros kept to 2 ("120.40"). */
function shortAmount(units: bigint, decimals: number): string {
  const [whole, fraction = ""] = fromBaseUnits(units, decimals).split(".");
  const kept = fraction.slice(0, 4).replace(/0+$/u, "").padEnd(2, "0");
  return `${whole}.${kept}`;
}

function unreachable(message: string, details: Record<string, unknown>): PlatformError {
  return new PlatformError("SOURCE_UNREACHABLE", message, 422, [{ path: "sourceNetwork", message: "Cannot fund the first step from this network." }], undefined, details);
}

/** The registry asset an action names on its network (symbol, native symbol, address / mint or CAIP-19). */
function namedAsset(network: NetworkKey, raw: string | undefined): AssetDescriptor | null {
  if (!raw) return null;
  const input = raw.trim();
  if (input.includes("/")) {
    const asset = getAsset(input);
    return asset && asset.network === network ? asset : null;
  }
  if (input.toUpperCase() === CHAINS[network].nativeAsset.symbol.toUpperCase()) {
    // Arc's gas asset is USDC, listed as its ERC-20 interface rather than a native entry.
    return getAsset(nativeAssetId(network)) ?? findAssetBySymbol(network, input);
  }
  if (isEvmAddress(input) || isSolanaAddress(input)) return findAssetByAddress(network, input);
  return findAssetBySymbol(network, input);
}

/** The symbols a bridge from `source` to `destination` moves for `asset` (on `destination`), or null when it is not portable. */
export function portableSymbol(asset: AssetDescriptor | null, source: NetworkKey, destination: NetworkKey): { readonly from: string; readonly to: string } | null {
  if (!asset || source === destination) return null;
  if (CHAINS[source].environment !== CHAINS[destination].environment || CHAINS[source].environment !== "mainnet") return null;
  if (asset.group === "USDC" && asset.symbol.toUpperCase() === "USDC" && !asset.transferOnly) {
    const there = findAssetBySymbol(source, "USDC");
    return there && there.group === "USDC" && !there.transferOnly ? { from: there.symbol, to: asset.symbol } : null;
  }
  if (asset.address === null && asset.symbol.toUpperCase() === "ETH" && ETH_PORTABLE.has(destination) && ETH_PORTABLE.has(source)) {
    return { from: CHAINS[source].nativeAsset.symbol, to: asset.symbol };
  }
  return null;
}

/** True when some active bridge adapter can move `symbols` from `source` to `destination` under the request's constraints. */
function bridgeServes(source: NetworkKey, destination: NetworkKey, symbols: { from: string; to: string }, request: IntentRequest): boolean {
  const input = namedAsset(source, symbols.from);
  const output = namedAsset(destination, symbols.to);
  if (!input || !output) return false;
  return candidateAdapters(
    { kind: "bridge", network: source, destinationNetwork: destination, input: resolvedFromDescriptor(input), output: resolvedFromDescriptor(output) },
    request.constraints,
  ).length > 0;
}

interface Funding {
  readonly actions: IntentActionSpec[];
  readonly explicitNetwork: boolean[];
  readonly bridged: boolean;
  readonly warnings: string[];
  /** The departure the money effectively leaves from. */
  readonly network: NetworkKey;
  readonly chosenText: boolean;
}

/** The fixed-departure rules for `source` (also applied to the network `auto` chose). */
function fundFrom(source: NetworkKey, actions: readonly IntentActionSpec[], explicitNetwork: readonly boolean[], request: IntentRequest): Funding {
  const [first, ...rest] = actions;
  const unchanged = (network: NetworkKey, chosenText: boolean, warnings: string[] = []): Funding =>
    ({ actions: [...actions], explicitNetwork: [...explicitNetwork], bridged: false, warnings, network, chosenText });
  if (!first || first.network === source) return unchanged(source, false);
  const where = first.network;
  if (explicitNetwork[0]) {
    return unchanged(where, true, [`The sentence names ${name(where)}; the departure ${name(source)} was not used.`]);
  }
  if (CHAINS[source].environment !== CHAINS[where].environment) {
    throw unreachable(
      `${name(source)} (${CHAINS[source].environment}) and ${name(where)} (${CHAINS[where].environment}) are on different capital lanes; start on a ${CHAINS[where].environment} network.`,
      { sourceNetwork: source, actionNetwork: where, kind: first.kind },
    );
  }
  if (first.kind === "withdraw") {
    return unchanged(where, true, [`A withdrawal starts where the position is (${name(where)}); the departure ${name(source)} was not used.`]);
  }
  if (first.kind === "call" || first.kind === "action") {
    return unchanged(where, true, [`The registered contract runs on ${name(where)}; the departure ${name(source)} was not used.`]);
  }
  const asset = namedAsset(where, first.from);
  const symbols = portableSymbol(asset, source, where);
  if (!symbols) {
    const symbol = asset?.symbol ?? first.from ?? "the input";
    // The asset is on the departure too, but nothing moves it to the action's network (testnets): unreachable.
    if (asset && namedAsset(source, asset.symbol)) {
      throw unreachable(
        `No bridge serves ${asset.symbol} from ${name(source)} to ${name(where)}. Start from ${name(where)}, or name another departure.`,
        { sourceNetwork: source, actionNetwork: where, asset: asset.symbol, kind: first.kind },
      );
    }
    return unchanged(where, true, [`${symbol} cannot be bridged from ${name(source)} to ${name(where)}; the ${first.kind} runs where it is, on ${name(where)}.`]);
  }
  if (!bridgeServes(source, where, symbols, request)) {
    throw unreachable(
      `No bridge serves ${symbols.to} from ${name(source)} to ${name(where)} here. Start from ${name(where)}, or name another departure.`,
      { sourceNetwork: source, actionNetwork: where, asset: symbols.to, kind: first.kind },
    );
  }
  const amount = first.amount;
  if (amount === undefined || amount === "max") return unchanged(where, true);
  if (first.kind === "transfer") {
    // One leg from the departure that pays the recipient: the exact input is spent, the recipient gets what arrives.
    const leg: IntentActionSpec = {
      kind: "bridge",
      network: source,
      from: symbols.from,
      to: symbols.to,
      amount,
      toNetwork: where,
      ...(first.recipient ? { recipient: first.recipient } : {}),
      ...(first.protocol && getProtocol(first.protocol)?.crossChain ? { protocol: first.protocol } : {}),
    };
    return {
      actions: [leg, ...rest],
      explicitNetwork: [false, ...explicitNetwork.slice(1)],
      bridged: true,
      network: source,
      chosenText: false,
      warnings: [`Sent from ${name(source)}: ${amount} ${symbols.from} leaves ${name(source)} and the recipient receives what arrives on ${name(where)} after bridge fees (at least the step's minimum).`],
    };
  }
  const bridge: IntentActionSpec = { kind: "bridge", network: source, from: symbols.from, to: symbols.to, amount, toNetwork: where };
  const { params, ...spend } = first;
  const kept = params ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== "portionBps")) : undefined;
  const spending: IntentActionSpec = {
    ...spend,
    amount: "max",
    ...(kept && Object.keys(kept).length > 0 ? { params: kept } : {}),
  };
  return {
    actions: [bridge, spending, ...rest],
    explicitNetwork: [false, ...explicitNetwork],
    bridged: true,
    network: source,
    chosenText: false,
    warnings: [],
  };
}

/** The first action's input amount in base units, or null when it has none or it is not a listed asset. */
function firstNeed(first: IntentActionSpec | undefined): { asset: AssetDescriptor; units: bigint } | null {
  if (!first || first.amount === undefined || first.amount === "max") return null;
  if (first.kind === "withdraw" || first.kind === "call" || first.kind === "action") return null;
  const asset = namedAsset(first.network, first.from);
  if (!asset) return null;
  try {
    return { asset, units: BigInt(toBaseUnits(first.amount, asset.decimals)) };
  } catch {
    return null;
  }
}

/**
 * Applies `request.sourceNetwork` to the actions the grammar (or the caller)
 * produced. `explicitNetwork[i]` says whether action i's clause named its
 * network. Throws SOURCE_UNREACHABLE or SOURCE_REQUIRED (PlatformError).
 */
export async function resolveDeparture(
  actions: readonly IntentActionSpec[],
  explicitNetwork: readonly boolean[],
  request: IntentRequest,
  accounts: readonly AccountId[] = request.accounts,
  readBalance: DepartureBalanceReader = holdingsBalanceReader(accounts),
): Promise<DepartureOutcome> {
  const source = request.sourceNetwork;
  const first = actions[0];
  const keep = (departure?: IntentDeparture, warnings: string[] = []): DepartureOutcome =>
    ({ actions: [...actions], explicitNetwork: [...explicitNetwork], ...(departure ? { departure } : {}), warnings });
  if (!source || !first) return keep();
  if (source !== "auto") {
    const funding = fundFrom(source, actions, explicitNetwork, request);
    return {
      actions: funding.actions,
      explicitNetwork: funding.explicitNetwork,
      departure: {
        network: funding.network,
        chosen: funding.chosenText ? "text" : "request",
        ...(funding.bridged ? { bridged: true, reason: reasonText(`Bridges from ${name(source)} to ${name(first.network)} first.`) } : {}),
      },
      warnings: funding.warnings,
    };
  }
  // auto: preview (demo) accounts behave as if no departure was sent.
  if (onlyPreviewAccounts(accounts)) return keep();
  if (explicitNetwork[0]) return keep({ network: first.network, chosen: "text" });
  const need = firstNeed(first);
  if (!need) return keep({ network: first.network, chosen: "auto" });
  const where = first.network;
  const others = (Object.keys(CHAINS) as NetworkKey[])
    .filter((network) => network !== where && portableSymbol(need.asset, network, where) !== null)
    .filter((network) => bridgeServes(network, where, portableSymbol(need.asset, network, where) as { from: string; to: string }, request))
    .slice(0, MAX_DEPARTURE_READS - 1);
  const reads: DepartureBalanceRead[] = [
    { network: where, asset: need.asset.symbol },
    ...others.map((network) => ({ network, asset: (portableSymbol(need.asset, network, where) as { from: string }).from })),
  ];
  const balances = await readBalance(reads);
  const own = balances[0] ?? null;
  const decimalsOn = (network: NetworkKey, symbol: string) => namedAsset(network, symbol)?.decimals ?? need.asset.decimals;
  // Same asset on every network: USDC has 6 decimals except where the registry says otherwise; compare in whole units.
  const covers = (units: bigint | null, network: NetworkKey, symbol: string): boolean => {
    if (units === null) return false;
    const decimals = decimalsOn(network, symbol);
    return units * 10n ** BigInt(need.asset.decimals) >= need.units * 10n ** BigInt(decimals);
  };
  if (own === null) {
    return keep({ network: where, chosen: "auto", reason: reasonText(`The ${need.asset.symbol} balance on ${name(where)} could not be read; the plan starts there.`) });
  }
  const ownText = `${name(where)} holds ${shortAmount(own, need.asset.decimals)} ${need.asset.symbol}`;
  if (covers(own, where, need.asset.symbol)) return keep({ network: where, chosen: "auto", reason: reasonText(ownText) });
  const funded = others
    .map((network, index) => ({ network, read: reads[index + 1] as DepartureBalanceRead, units: balances[index + 1] ?? null }))
    .filter((entry) => covers(entry.units, entry.network, entry.read.asset))
    .sort((a, b) => {
      const left = (a.units as bigint) * 10n ** BigInt(decimalsOn(b.network, b.read.asset));
      const right = (b.units as bigint) * 10n ** BigInt(decimalsOn(a.network, a.read.asset));
      return left === right ? 0 : left > right ? -1 : 1;
    });
  const best = funded[0];
  if (best) {
    const funding = fundFrom(best.network, actions, explicitNetwork, request);
    return {
      actions: funding.actions,
      explicitNetwork: funding.explicitNetwork,
      departure: {
        network: funding.network,
        chosen: "auto",
        ...(funding.bridged ? { bridged: true } : {}),
        reason: reasonText(`${ownText}; ${name(best.network)} ${shortAmount(best.units as bigint, decimalsOn(best.network, best.read.asset))}`),
      },
      warnings: funding.warnings,
    };
  }
  const unknown = balances.slice(1).some((balance) => balance === null);
  if (unknown) {
    return keep({ network: where, chosen: "auto", reason: reasonText(`${ownText}; other balances could not be read.`) });
  }
  throw sourceRequired(need.asset.symbol, first.amount as string, where, reads.map((read, index) => ({
    network: read.network,
    units: balances[index] ?? null,
    decimals: decimalsOn(read.network, read.asset),
    enough: covers(balances[index] ?? null, read.network, read.asset),
  })), `No network holds ${first.amount} ${need.asset.symbol} for this ${first.kind}. Say where the money comes from.`);
}

function sourceRequired(
  asset: string | null,
  amount: string | null,
  toNetwork: NetworkKey,
  candidates: readonly { network: NetworkKey; units: bigint | null; decimals: number; enough: boolean }[],
  message: string,
): PlatformError {
  return new PlatformError(
    "SOURCE_REQUIRED",
    message,
    422,
    [{ path: "sourceNetwork", message: "No funded departure was found." }],
    undefined,
    {
      ...(asset ? { asset } : {}),
      ...(amount ? { amount } : {}),
      toNetwork,
      candidates: candidates.map((candidate) => ({
        network: candidate.network,
        balance: candidate.units === null ? null : fromBaseUnits(candidate.units, candidate.decimals),
        enough: candidate.enough,
      })),
    },
  );
}

export interface FundedSource {
  readonly network: NetworkKey;
  readonly departure: IntentDeparture;
}

/**
 * `auto` for a bridge whose sentence names no source ("bridge 25 USDC to
 * solana"): the network on the destination's lane, other than the
 * destination, with the largest balance that covers the amount. Throws
 * SOURCE_REQUIRED (with `details.candidates`) when none does or nothing can
 * be read (preview accounts are never read).
 */
export async function pickFundedSource(
  missing: { readonly asset: string | null; readonly amount: string | null; readonly toNetwork: NetworkKey },
  accounts: readonly AccountId[],
  request: IntentRequest,
  readBalance: DepartureBalanceReader = holdingsBalanceReader(accounts),
): Promise<FundedSource> {
  const destination = missing.toNetwork;
  const wanted = namedAsset(destination, missing.asset ?? undefined) ??
    (missing.asset ? (Object.keys(CHAINS) as NetworkKey[]).map((network) => namedAsset(network, missing.asset ?? undefined)).find((asset) => asset !== null) ?? null : null);
  const ask = (candidates: Parameters<typeof sourceRequired>[3], message: string) =>
    sourceRequired(missing.asset, missing.amount, destination, candidates, message);
  const wantedText = `${missing.amount ?? ""} ${missing.asset ?? "funds"}`.trim();
  if (!wanted || missing.amount === null) throw ask([], `Say where the money comes from (e.g. "from base to ${destination}").`);
  if (onlyPreviewAccounts(accounts)) throw ask([], `Say where the ${wantedText} comes from: preview accounts have no balances to read.`);
  // The asset as it exists on the destination (USDC there for USDC elsewhere) decides portability.
  const there = namedAsset(destination, wanted.symbol) ?? wanted;
  const candidates = (Object.keys(CHAINS) as NetworkKey[])
    .filter((network) => network !== destination)
    .map((network) => ({ network, symbols: portableSymbol(there, network, destination) }))
    .filter((entry): entry is { network: NetworkKey; symbols: { from: string; to: string } } => entry.symbols !== null)
    .filter((entry) => bridgeServes(entry.network, destination, entry.symbols, request))
    .slice(0, MAX_DEPARTURE_READS);
  if (candidates.length === 0) throw ask([], `No bridge brings ${wanted.symbol} to ${name(destination)} here. Say where the money comes from.`);
  const reads = candidates.map((entry) => ({ network: entry.network, asset: entry.symbols.from }));
  const balances = await readBalance(reads);
  const rows = candidates.map((entry, index) => {
    const asset = namedAsset(entry.network, entry.symbols.from);
    const decimals = asset?.decimals ?? wanted.decimals;
    let units: bigint | null = null;
    let needed: bigint | null = null;
    try {
      needed = BigInt(toBaseUnits(missing.amount as string, decimals));
      units = balances[index] ?? null;
    } catch {
      units = null;
    }
    return { network: entry.network, units, decimals, enough: units !== null && needed !== null && units >= needed };
  });
  const funded = rows.filter((row) => row.enough).sort((a, b) => {
    const left = (a.units as bigint) * 10n ** BigInt(b.decimals);
    const right = (b.units as bigint) * 10n ** BigInt(a.decimals);
    return left === right ? 0 : left > right ? -1 : 1;
  });
  const best = funded[0];
  if (!best) {
    const unread = rows.some((row) => row.units === null);
    throw ask(rows, unread
      ? `No readable network holds ${wantedText} for this bridge (some balances could not be read). Say where the money comes from.`
      : `No network holds ${wantedText} for this bridge. Say where the money comes from.`);
  }
  const others = rows.filter((row) => row !== best && row.units !== null).slice(0, 2)
    .map((row) => `${name(row.network)} ${shortAmount(row.units as bigint, row.decimals)}`);
  return {
    network: best.network,
    departure: {
      network: best.network,
      chosen: "auto",
      reason: reasonText([`${name(best.network)} holds ${shortAmount(best.units as bigint, best.decimals)} ${wanted.symbol}`, ...others].join("; ")),
    },
  };
}
