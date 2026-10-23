/**
 * Plan mode of the intent eval: a ready turn is planned with
 * `createIntentDetailed({ dryRun })` exactly the way `POST
 * /v1/intents?clarify=true` plans it (the canonical sentence, or structured
 * actions when a step has no sentence shape), against offline venues and the
 * fixture's names, and the planned graph's end state is compared with what
 * the turn decided.
 *
 * Offline venues: every registry adapter keeps its own `supports` (so the
 * venues that can serve a route are the production ones), its `plan` is
 * replaced by a fixed-price stub and it can never prepare, verify or poll.
 * Nothing here reads a network; the holdings and price readers are the ones
 * `installWallet` configured.
 *
 * End state (the oracle of plan mode): which holdings are spent (network,
 * asset and, when concrete, amount), what lands where and for whom (network,
 * asset, holder), which positions open or close, and who is paid. Two route
 * shapes with the same end state (a bridge then a swap, or one cross-network
 * swap) are equal; a dropped recipient, a spend from another holding or an
 * asset that lands elsewhere is not.
 */
import {
  CHAINS,
  findAssetBySymbol,
  fromBaseUnits,
  getYieldVenue,
  isNetworkKey,
  parseAccountId,
  type AccountId,
  type IntentGraph,
  type IntentRequest,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { isPlatformError } from "../../errors.js";
import { assetAmount } from "../assets.js";
import { ADAPTERS, configureAdapters } from "../adapters/registry.js";
import type { AdapterAction, PlannedStep, ProtocolAdapter } from "../adapters/types.js";
import { closestSentence, toActionSpecs } from "../clarify/render.js";
import type { ResolvedAction, TurnContext } from "../clarify/types.js";
import type { Corpus } from "../clarify/corpusHarness.js";
import { nameResolvers, registerNameResolver, resetNameResolvers, type NameResolver } from "../names.js";
import { createIntentDetailed } from "../service.js";

/** USD per whole token of the offline venue stubs (the eval prices plus the listed tokens they lack). */
export const PLAN_STUB_PRICES: Readonly<Record<string, number>> = Object.freeze({
  SOL: 151.02, ETH: 3412.5, WETH: 3412.5, POL: 0.51, WPOL: 0.51,
  USDC: 1, USDT: 1, USDT0: 1, DAI: 1, USDS: 1, PYUSD: 1, USDBC: 1, EURC: 1.08,
  WSTETH: 4121.3, CBETH: 3720.1, RETH: 3866.2, WEETH: 3616.1, METH: 3582.6, ETHX: 3549, SFRXETH: 3787.9,
  JITOSOL: 185.3, MSOL: 193.1, JUPSOL: 166.4,
  CBBTC: 98_000, JUP: 0.82, BONK: 0.000021, WIF: 1.75, AERO: 1.1, ARB: 0.42, OP: 1.6,
});

function stubPrice(symbol: string): number {
  return PLAN_STUB_PRICES[symbol.toUpperCase()] ?? 1;
}

/** Output base units for `amount` input base units at the stub prices (no fees: the oracle compares assets and holders). */
function stubOutput(action: AdapterAction, inputUnits: string): string {
  const input = Number(fromBaseUnits(inputUnits, action.input.decimals));
  const usd = input * stubPrice(action.input.symbol);
  const out = usd / stubPrice(action.output.symbol);
  const fixed = out.toFixed(Math.min(action.output.decimals, 12));
  const [whole, fraction = ""] = fixed.split(".");
  const units = `${whole}${fraction.padEnd(action.output.decimals, "0").slice(0, action.output.decimals)}`.replace(/^0+(?=\d)/u, "");
  return units === "" ? "0" : units;
}

/** A position the fixture wallet holds at the action's venue (closePosition withdraws), in base units. */
function positionUnits(action: AdapterAction, positions: Readonly<Record<string, string>>): string {
  const venue = getYieldVenue(action.venue ?? "");
  const key = venue ? `${venue.network}/${venue.protocol}/${venue.asset}` : "";
  const found = Object.entries(positions).find(([entry]) => entry.toLowerCase() === key.toLowerCase());
  const amount = found?.[1] ?? "1";
  const [whole, fraction = ""] = amount.split(".");
  return `${whole}${fraction.padEnd(action.input.decimals, "0").slice(0, action.input.decimals)}`.replace(/^0+(?=\d)/u, "") || "0";
}

/**
 * The registry adapters with offline plans: `supports`, `explicitOnly`,
 * `protocols` and gas top-up support are the adapter's own; `plan` prices the
 * route at the stub prices (a closePosition withdraw reports the fixture's
 * position); prepare, verify and poll are refused (plan mode never executes).
 */
export function offlineVenueAdapters(positions: Readonly<Record<string, string>> = {}): ProtocolAdapter[] {
  return ADAPTERS.map((adapter): ProtocolAdapter => {
    const plan = async (action: AdapterAction): Promise<PlannedStep> => {
      const inputUnits = action.kind === "withdraw" && action.closePosition ? positionUnits(action, positions) : action.amount;
      const output = stubOutput(action, inputUnits);
      const cross = action.network !== action.destinationNetwork;
      return {
        protocol: adapter.id,
        title: `${adapter.label} ${action.kind} ${action.input.symbol}`,
        mode: "wallet",
        input: assetAmount(action.input, inputUnits),
        expectedOutput: assetAmount(action.output, output),
        minimumOutput: assetAmount(action.output, ((BigInt(output) * 9_950n) / 10_000n).toString()),
        estimatedSeconds: cross ? 30 : 15,
        settlement: cross ? { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: 30 } : { kind: "same-network" },
        warnings: [],
        transactionCount: 1,
        slippageBps: action.slippageBps,
        floor: "onchain",
      };
    };
    const refuse = async (): Promise<never> => {
      throw new Error("The eval's offline venues never prepare, verify or poll.");
    };
    return {
      ...adapter,
      plan,
      prepare: refuse,
      verify: refuse,
      ...(adapter.poll ? { poll: refuse } : {}),
    } as ProtocolAdapter;
  });
}

/** Name resolvers that answer from the fixture names (ENS, Basenames, SNS); a name the fixture lacks has no address. */
function fixtureResolvers(corpus: Corpus): NameResolver[] {
  const lookup = (protocol: ProtocolId) => async (name: string, network: NetworkKey) => {
    const entry = corpus.fixtures.names[name.toLowerCase()];
    const address = entry ? entry[network] ?? (CHAINS[network].vm === "evm" ? entry.evm : undefined) : undefined;
    return address ? { name, address, protocol, detail: "eval fixture" } : null;
  };
  const evm = (Object.keys(CHAINS) as NetworkKey[]).filter((network) => CHAINS[network].vm === "evm");
  return [
    { id: "eval-ens", protocol: "ens", suffixes: [".eth"], networks: evm, resolve: lookup("ens") },
    { id: "eval-basenames", protocol: "basenames", suffixes: [".base.eth"], networks: ["base"], resolve: lookup("basenames") },
    { id: "eval-sns", protocol: "sns", suffixes: [".sns"], networks: ["solana", "solana-devnet"], resolve: lookup("sns") },
  ];
}

/**
 * Runs `task` with the offline venues and the fixture's name resolvers
 * installed, restoring the adapter set and the resolvers afterwards. The
 * caller installs the wallet (holdings and price readers) first.
 */
export async function withPlanWorld<T>(corpus: Corpus, walletId: string, task: () => Promise<T>): Promise<T> {
  const saved = nameResolvers();
  resetNameResolvers();
  for (const resolver of fixtureResolvers(corpus)) registerNameResolver(resolver);
  configureAdapters(offlineVenueAdapters(corpus.fixtures.wallets[walletId]?.positions ?? {}));
  try {
    return await task();
  } finally {
    configureAdapters(null);
    resetNameResolvers();
    for (const resolver of saved) registerNameResolver(resolver);
  }
}

export type PlanOutcome =
  | { readonly ok: true; readonly graph: IntentGraph }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Plans ready actions the way clarifyTurn does (a dry run): the canonical
 * sentence when there is one, else structured actions with the closest
 * sentence as the request text.
 */
export async function planActions(actions: readonly ResolvedAction[], sentence: string | null, ctx: TurnContext): Promise<PlanOutcome> {
  const request: IntentRequest = {
    accounts: ctx.accounts as IntentRequest["accounts"],
    ...(ctx.defaultNetwork ? { defaultNetwork: ctx.defaultNetwork } : {}),
    ...(sentence ? { text: sentence } : { text: closestSentence(actions).slice(0, 1_000), actions: toActionSpecs(actions) }),
  } as IntentRequest;
  return planRequest(request);
}

/** Plans one request as a dry run; a refusal comes back as its code. */
export async function planRequest(request: IntentRequest): Promise<PlanOutcome> {
  try {
    const created = await createIntentDetailed(request, { dryRun: true });
    return { ok: true, graph: created.intent };
  } catch (error) {
    if (isPlatformError(error)) return { ok: false, code: error.code, message: error.message.slice(0, 200) };
    return { ok: false, code: "CRASH", message: String((error as Error)?.message ?? error).slice(0, 200) };
  }
}

// ------------------------------------------------------------- end state

/**
 * What a plan leaves behind, as sorted keys:
 * - `spends`: "network:ASSET" of each holding the wallet pays from, with the
 *   amount ("max" when the whole holding or an unresolved share);
 * - `receives`: "network:ASSET@holder" of each output that is not passed on
 *   to a later step ("self" for the person's own accounts);
 * - `positions`: "+protocol:network:ASSET" opened, "-protocol:network:ASSET" closed or reduced;
 * - `recipients`: everyone else who is paid.
 */
export interface EndState {
  readonly spends: Readonly<Record<string, string>>;
  readonly receives: readonly string[];
  readonly positions: readonly string[];
  readonly recipients: readonly string[];
}

const upper = (symbol: string | undefined) => (symbol ?? "").toUpperCase();

/** The asset a resolved step delivers. */
function outputOf(action: ResolvedAction): string {
  return upper(action.to && action.to !== "" ? action.to : action.from);
}

/** End state of ready actions (the decision): a later step with "max" spends the previous output (render.ts's rule). */
export function endStateOfActions(actions: readonly ResolvedAction[]): EndState {
  const spends: Record<string, string> = {};
  const receives = new Set<string>();
  const positions = new Set<string>();
  const recipients = new Set<string>();
  actions.forEach((action, index) => {
    const dependent = action.amount === "max" && index > 0 && action.kind !== "withdraw";
    const next = actions[index + 1];
    const consumed = next !== undefined && next.amount === "max" && next.kind !== "withdraw" && (next.portionBps ?? 10_000) === 10_000;
    if (action.kind === "withdraw") {
      positions.add(`-${action.protocol ?? "?"}:${action.network}:${upper(action.from)}`);
    } else if (!dependent && action.amount !== "") {
      const key = `${action.network}:${upper(action.from)}`;
      spends[key] = action.amount === "max" ? `max${action.portionBps && action.portionBps !== 10_000 ? `(${action.portionBps})` : ""}` : action.amount;
    }
    if (action.recipient) recipients.add(action.recipient.toLowerCase());
    if (consumed) return;
    const landing = action.toNetwork ?? action.network;
    if (action.kind === "deposit") positions.add(`+${action.protocol ?? "?"}:${action.network}:${upper(action.from)}`);
    else receives.add(`${landing}:${outputOf(action)}@${action.recipient ? action.recipient.toLowerCase() : "self"}`);
  });
  return { spends: sortRecord(spends), receives: [...receives].sort(), positions: [...positions].sort(), recipients: [...recipients].sort() };
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** True when `account` is one of the request's own accounts (same address on the step's VM). */
function ownAccount(account: AccountId | undefined, accounts: readonly string[]): boolean {
  if (!account) return true;
  const parsed = parseAccountId(account);
  if (!parsed) return false;
  return accounts.some((entry) => {
    const own = parseAccountId(entry);
    return own !== null && own.chain.vm === parsed.chain.vm && own.address.toLowerCase() === parsed.address.toLowerCase();
  });
}

/** End state of a planned graph; `accounts` are the request's own accounts, `names` maps resolved addresses back to the names said. */
export function endStateOfGraph(graph: IntentGraph, accounts: readonly string[]): EndState {
  const spends: Record<string, string> = {};
  const receives = new Set<string>();
  const positions = new Set<string>();
  const recipients = new Set<string>();
  const consumedBy = new Map<string, number>();
  for (const step of graph.steps) {
    if (step.funding) consumedBy.set(step.funding.from, (consumedBy.get(step.funding.from) ?? 0) + step.funding.portionBps);
  }
  for (const step of graph.steps) {
    const input = step.input;
    const venue = step.venue ? getYieldVenue(step.venue) : null;
    if (step.kind === "withdraw") {
      positions.add(`-${step.protocol}:${step.network}:${upper(input?.symbol ?? venue?.asset)}`);
    } else if (!step.funding && input) {
      spends[`${step.network}:${upper(input.symbol)}`] = input.formatted;
    }
    const own = ownAccount(step.recipient, accounts);
    const holder = own ? "self" : (step.recipientName ?? parseAccountId(step.recipient as AccountId)?.address ?? String(step.recipient)).toLowerCase();
    if (!own) recipients.add(holder);
    if ((consumedBy.get(step.id) ?? 0) >= 10_000) continue;
    const landing = step.settlement?.destinationNetwork ?? step.network;
    if (step.kind === "deposit") positions.add(`+${step.protocol}:${step.network}:${upper(input?.symbol ?? venue?.asset)}`);
    else if (step.expectedOutput) receives.add(`${landing}:${upper(step.expectedOutput.symbol)}@${holder}`);
  }
  return { spends: sortRecord(spends), receives: [...receives].sort(), positions: [...positions].sort(), recipients: [...recipients].sort() };
}

const decimalEqual = (a: string, b: string) => {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-9);
};

/**
 * Differences between the decided end state and the planned one (empty:
 * the same). A decided "max" matches any planned amount of that holding;
 * receipt tokens of a deposit are part of its position; a native gas asset
 * and its wrapped form are one asset.
 */
export function compareEndStates(decided: EndState, planned: EndState): string[] {
  const out: string[] = [];
  const canon = (key: string) => key.replace(/:WETH(?=@|$)/u, ":ETH").replace(/:WPOL(?=@|$)/u, ":POL").replace(/:WSOL(?=@|$)/u, ":SOL");
  const decidedSpends = new Map(Object.entries(decided.spends).map(([key, value]) => [canon(key), value]));
  const plannedSpends = new Map(Object.entries(planned.spends).map(([key, value]) => [canon(key), value]));
  for (const [key, value] of decidedSpends) {
    const got = plannedSpends.get(key);
    if (got === undefined) out.push(`spend ${key} ${value} not planned`);
    else if (!value.startsWith("max") && !decimalEqual(value, got)) out.push(`spend ${key}: decided ${value}, planned ${got}`);
  }
  for (const key of plannedSpends.keys()) if (!decidedSpends.has(key)) out.push(`planned spend ${key} not decided`);
  const set = (list: readonly string[]) => new Set(list.map(canon));
  const pairs: [string, readonly string[], readonly string[]][] = [
    ["receive", decided.receives, planned.receives],
    ["position", decided.positions, planned.positions],
    ["recipient", decided.recipients, planned.recipients],
  ];
  for (const [label, left, right] of pairs) {
    const a = set(left);
    const b = set(right);
    for (const key of a) if (!b.has(key)) out.push(`${label} ${key} decided, not planned`);
    for (const key of b) if (!a.has(key)) out.push(`${label} ${key} planned, not decided`);
  }
  return out;
}

/** A network key or null (structured expectations name networks as keys). */
export function asNetwork(value: unknown): NetworkKey | null {
  return isNetworkKey(value) ? value : null;
}

/** A listed symbol's canonical spelling on a network, or the input upper-cased. */
export function listedSymbol(network: NetworkKey, symbol: string): string {
  return findAssetBySymbol(network, symbol)?.symbol.toUpperCase() ?? symbol.toUpperCase();
}
