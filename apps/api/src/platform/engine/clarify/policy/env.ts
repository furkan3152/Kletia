/**
 * The policy's view of the request (Env) and the small helpers every
 * question uses: needs, spendable balances, funding, phrasing.
 */
import {
  CHAINS,
  NATIVE_FEE_RESERVE,
  type AssumptionSource,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  ALIASES,
  canonicalOn,
  decimalsOf,
  dexNetworks,
  hasAccount,
  isUsdWord,
  lane,
  laneOf,
  NETWORK_ORDER,
  networkName,
  SWAP_NETWORKS,
  transferOnly,
  USD_ORDER,
} from "../catalog.js";
import type { ReasonCode } from "../copy.js";
import {
  cmp,
  formatDecimal,
  isDecimal,
  parseDecimal,
  portion,
  sub,
  tidy,
} from "../decimal.js";
import type {
  Assumption,
  FactsView,
  Kind,
  Option,
  TurnContext,
  WorkStep,
} from "../types.js";

export interface Env {
  readonly ctx: TurnContext;
  readonly facts: FactsView;
}

/* ------------------------------------------------------------ helpers */

export function exactNeed(amount: ThreadAmount | undefined): string | null {
  return amount?.t === "exact" ? amount.value : null;
}

export function usdStable(env: Env, network: NetworkKey, need: string | null, side: "spend" | "receive"): { symbol: string; alternatives: string[] } | null {
  const listed = USD_ORDER.filter((symbol) => canonicalOn(network, symbol) && !transferOnly(network, symbol));
  if (listed.length === 0) return null;
  if (side === "spend" && need) {
    const covering = listed.filter((symbol) => {
      const balance = env.facts.balance(network, symbol);
      return balance !== undefined && cmp(balance, need) >= 0;
    });
    if (covering.length > 0) return { symbol: covering[0] as string, alternatives: listed.filter((symbol) => symbol !== covering[0]) };
  }
  return { symbol: listed[0] as string, alternatives: listed.slice(1) };
}

/** The listed symbol a raw token stands for on a network (canonical, alias, USD words); funding checks only. */
export function symbolOnNetwork(env: Env, network: NetworkKey, raw: string | undefined, usd: boolean | undefined): string | null {
  if (!raw) return usd ? usdStable(env, network, null, "spend")?.symbol ?? null : null;
  const canonical = canonicalOn(network, raw);
  if (canonical) return canonical;
  const upper = raw.toUpperCase();
  const alias = ALIASES.find((entry) => (entry.network === network || entry.network === "*") && entry.from === upper);
  if (alias) return canonicalOn(network, alias.to);
  // An ambiguous symbol ("ETH" on Polygon) never makes a network a candidate the user did not name.
  if (isUsdWord(raw)) return usdStable(env, network, null, "spend")?.symbol ?? null;
  return null;
}

/** Balance minus what the person keeps back and the native fee reserve, times bps (R6, "keep N"). */
export function spendable(env: Env, network: NetworkKey, symbol: string, bps: number, keep = "0"): bigint | undefined {
  const held = env.facts.balance(network, symbol);
  if (held === undefined) return undefined;
  const left = sub(held, keep);
  if (left <= 0n) return 0n;
  const balance = formatDecimal(left);
  const share = portion(balance, bps);
  if (CHAINS[network].nativeAsset.symbol.toUpperCase() !== symbol.toUpperCase()) return share;
  const cap = sub(balance, NATIVE_FEE_RESERVE[network]);
  return share < cap ? share : cap;
}

/**
 * "keep N": what the person keeps back of this step's asset on this network, as a decimal string,
 * subtracted before a share of the holding is taken. Null when an entry cannot be applied here (another asset or
 * network, or not an exact amount): the amount is then asked, never planned around the keep.
 */
export function keptHere(step: WorkStep, network: NetworkKey, from: string): string | null {
  let total = 0n;
  for (const entry of step.keep ?? []) {
    if (entry.amount.t !== "exact" || !isDecimal(entry.amount.value)) return null;
    if (entry.asset && (canonicalOn(network, entry.asset) ?? entry.asset).toUpperCase() !== from.toUpperCase()) return null;
    if (entry.network && entry.network !== network) return null;
    total += parseDecimal(entry.amount.value);
  }
  return formatDecimal(total);
}

interface Funding {
  known: boolean;
  covering: NetworkKey[];
  balances: Map<NetworkKey, string>;
}

/** Which candidate networks hold enough (or any, when the amount is not exact). */
export function funding(env: Env, networks: readonly NetworkKey[], symbolOn: (network: NetworkKey) => string | null, amount: ThreadAmount | undefined): Funding {
  const balances = new Map<NetworkKey, string>();
  let known = true;
  for (const network of networks) {
    const symbol = symbolOn(network);
    if (!symbol) continue;
    const balance = env.facts.balance(network, symbol);
    if (balance === undefined) known = false;
    else balances.set(network, balance);
  }
  const need = exactNeed(amount);
  const covering = [...balances.entries()]
    .filter(([network, balance]) => {
      if (need) return cmp(balance, need) >= 0;
      const usable = spendable(env, network, symbolOn(network) as string, 10_000);
      return usable !== undefined && usable > 0n;
    })
    .map(([network]) => network);
  return { known: known && balances.size > 0, covering, balances };
}

export function byLargest(networks: readonly NetworkKey[], balances: Map<NetworkKey, string>): NetworkKey[] {
  return [...networks].sort((a, b) => {
    const order = cmp(balances.get(b) ?? "0", balances.get(a) ?? "0");
    return order !== 0 ? order : NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b);
  });
}

export function networkOption(network: NetworkKey, detail?: string, extra: Partial<Option> = {}): Option {
  return { id: network, label: networkName(network), ...(detail ? { detail } : {}), value: { network }, ...extra };
}

export function held(env: Env, network: NetworkKey, symbol: string): string | undefined {
  const balance = env.facts.balance(network, symbol);
  return balance === undefined ? undefined : tidy(balance, Math.min(decimalsOf(network, symbol), 6));
}

export function holdDetail(env: Env, balances: Map<NetworkKey, string>, network: NetworkKey, symbol: string | null, need: string | null): string | undefined {
  const balance = balances.get(network);
  if (balance === undefined || !symbol) return undefined;
  const enough = need === null || cmp(balance, need) >= 0;
  return `You hold ${held(env, network, symbol)} ${symbol}${enough ? "" : " (not enough)"}`;
}

/** Stores an assumed value (R0: never over a stated one), with its reason code so the chip stays put. */
export function remember(step: WorkStep, name: "network" | "provider", value: string, why: { source: AssumptionSource; code: ReasonCode }): void {
  const current = step[name];
  if (!current || current.by === "assumed") (step as Record<string, unknown>)[name] = { v: value, by: "assumed", why };
}

export function amountPhrase(step: WorkStep, symbol?: string): string {
  const asset = symbol ?? step.from?.v ?? (step.usdFrom ? "USD" : "it");
  if (step.amount?.v.t === "exact") return `${step.amount.v.value} ${asset}`;
  return asset === "it" ? "it" : `the ${asset}`;
}

/** Swap networks where both tokens are known (grammar inferSwapNetwork), limited to a named venue's networks. */
export function swapCandidates(env: Env, step: WorkStep, from = step.from?.v, to = step.to?.v): NetworkKey[] {
  const tokens = [from ?? (step.usdFrom ? "usd" : undefined), to ?? (step.usdTo ? "usd" : undefined)].filter((token): token is string => token !== undefined);
  const venue = dexNetworks(step.protocol?.v);
  const current = laneOf(env.ctx.accounts);
  const lanePool = SWAP_NETWORKS.filter((network) => lane(network) === current);
  const pool = venue ? lanePool.filter((network) => venue.includes(network)) : lanePool;
  const networks = pool.filter((network) => tokens.every((token) => symbolOnNetwork(env, network, token, false) !== null));
  const usable = networks.filter((network) => hasAccount(env.ctx.accounts, network));
  if (usable.length > 0) return usable;
  if (networks.length > 0) return networks;
  const evmKnown = tokens.some((token) => SWAP_NETWORKS.some((network) => CHAINS[network].vm === "evm" && canonicalOn(network, token)) && !canonicalOn("solana", token));
  return !evmKnown && (!venue || venue.includes("solana")) ? ["solana"] : [];
}

export function refuseUnsupported(message: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422, [{ path: "text", message: "Not supported." }]);
}

export const STEP_VERBS: Readonly<Partial<Record<Kind, readonly [string, string]>>> = {
  swap: ["swaps", "swap"],
  deposit: ["deposits", "deposit"],
  withdraw: ["withdraws", "withdraw"],
  stake: ["stakes", "stake"],
  transfer: ["sends", "send"],
};

export function dedupe(list: Assumption[]): Assumption[] {
  const seen = new Set<string>();
  return list.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
}
