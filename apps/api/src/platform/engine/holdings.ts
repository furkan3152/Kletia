/**
 * Wallet facts: the engine's one reader of balances and the chain facts that
 * depend on them (departure, clarify, journey, fee estimates).
 *
 * - Reads only what the caller asks for, within a budget: at most 8 balance
 *   (and token-account) reads and 2 name resolutions per call, 3 s overall,
 *   every read in parallel through `Promise.allSettled`.
 * - Unknown is never zero: a failed, skipped or over-budget read is reported
 *   as `unknown` (or `skipped`) without an amount; callers must not treat it
 *   as an empty wallet.
 * - Preview (demo) accounts are never read (`isPreviewAccount`), and only the
 *   request's own accounts are read.
 * - Caches: balances 15 s per (owner, network, asset), gas prices 12 s per
 *   network, Solana rent 1 h, token-account existence 30 s, names 15 s.
 *   Cache hits cost no budget.
 *
 * Everything here is a read-only RPC call; nothing is signed or sent.
 */
import {
  CHAINS,
  findAssetByAddress,
  findAssetBySymbol,
  fromBaseUnits,
  getAsset,
  isEvmAddress,
  isPreviewAccount,
  isSolanaAddress,
  nativeAssetId,
  parseAccountId,
  parseAssetId,
  type AccountId,
  type AssetId,
  type NetworkKey,
  type ParsedAccountId,
  type ProtocolId,
} from "@kletia/core";
import { SOLANA_RPC_URLS } from "../../networks/solana/index.js";
import { accountForNetwork } from "./accounts.js";
import { evmClient, isEvmNetwork, readEvmBalance } from "./chains/evm.js";
import { jsonRpc } from "./contracts/simulationRpc.js";
import { PlatformError } from "../errors.js";
import { accountCode as readAccountCode, type AccountCodeKind } from "./nameResolvers.js";
import { resolveRecipientName } from "./names.js";

/** Largest number of balance and token-account reads one call may make. */
export const MAX_BALANCE_READS = 8;
/** Largest number of name resolutions one call may make. */
export const MAX_NAME_READS = 2;
/** Overall deadline of one call. */
export const FACTS_DEADLINE_MS = 3_000;

export const BALANCE_TTL_MS = 15_000;
export const GAS_PRICE_TTL_MS = 12_000;
export const RENT_TTL_MS = 60 * 60 * 1000;
export const TOKEN_ACCOUNT_TTL_MS = 30_000;
export const NAME_TTL_MS = 15_000;
/** Largest number of gas-price reads one call may make (one per EVM network visited). */
const MAX_GAS_PRICE_READS = 6;
const CACHE_LIMIT = 2_000;

/** What a caller needs to know. `owner` defaults to the request's own account on the network's VM. */
export type FactNeed =
  | {
      readonly kind: "balance";
      readonly network: NetworkKey;
      /** Registry symbol, token address / mint, or CAIP-19 id of a listed asset. */
      readonly asset: string;
      readonly owner?: string;
    }
  | { readonly kind: "gasPrice"; readonly network: NetworkKey }
  | { readonly kind: "solanaRent"; readonly network: NetworkKey }
  | { readonly kind: "tokenAccount"; readonly network: NetworkKey; readonly mint: string; readonly owner?: string }
  | { readonly kind: "name"; readonly name: string; readonly network: NetworkKey };

export type FactStatus = "known" | "unknown" | "skipped";

export interface BalanceFact {
  readonly network: NetworkKey;
  /** Address read (empty when no own account exists on that VM). */
  readonly owner: string;
  readonly asset: AssetId | null;
  readonly symbol: string;
  readonly decimals: number | null;
  readonly status: FactStatus;
  /** Base units; present only when `status` is `known`. */
  readonly amount?: string;
  readonly formatted?: string;
  /** Why the balance is not known. */
  readonly reason?: string;
}

export interface GasPriceFact {
  readonly network: NetworkKey;
  readonly status: FactStatus;
  /** Wei per gas from `eth_gasPrice`. */
  readonly weiPerGas?: string;
  readonly reason?: string;
}

export interface SolanaRentFact {
  readonly network: NetworkKey;
  readonly status: FactStatus;
  /** Rent-exempt minimum of an account with no data (a fee payer may not sit between 0 and it). */
  readonly walletLamports?: string;
  /** Rent-exempt minimum of a 165-byte token account. */
  readonly tokenAccountLamports?: string;
  readonly reason?: string;
}

export interface TokenAccountFact {
  readonly network: NetworkKey;
  readonly owner: string;
  readonly mint: string;
  readonly status: FactStatus;
  /** True when the owner already holds a token account for the mint. */
  readonly exists?: boolean;
  readonly reason?: string;
}

export interface NameFact {
  readonly name: string;
  readonly network: NetworkKey;
  readonly status: FactStatus;
  readonly address?: string;
  readonly protocol?: ProtocolId;
  readonly reason?: string;
  /**
   * Unknown because the records could not be read (deadline, read budget,
   * resolver unavailable), not because the name has no address: callers
   * must not report "no address" for it.
   */
  readonly unavailable?: true;
}

export interface WalletFacts {
  readonly balances: readonly BalanceFact[];
  readonly gasPrices: readonly GasPriceFact[];
  readonly rent: readonly SolanaRentFact[];
  readonly tokenAccounts: readonly TokenAccountFact[];
  readonly names: readonly NameFact[];
  /** Network reads made by this call (cache hits excluded). */
  readonly reads: number;
  /** True when at least one need was skipped because it targets a preview account. */
  readonly preview: boolean;
}

export interface FactBudget {
  /** Balance and token-account reads (capped at MAX_BALANCE_READS). */
  readonly balances?: number;
  /** Name resolutions (capped at MAX_NAME_READS). */
  readonly names?: number;
  /** Overall deadline in milliseconds (capped at FACTS_DEADLINE_MS). */
  readonly deadlineMs?: number;
}

/** The raw reads, replaceable in tests (`configureHoldingsReaders`). Every reader is read-only. */
export interface HoldingsReaders {
  evmBalance(network: NetworkKey, owner: string, token: string | null): Promise<bigint>;
  /** Lamports (`mint` null) or the summed token amount of the owner's accounts for `mint`. */
  solanaBalance(network: NetworkKey, owner: string, mint: string | null): Promise<bigint>;
  gasPrice(network: NetworkKey): Promise<bigint>;
  solanaRent(network: NetworkKey, bytes: number): Promise<bigint>;
  /** True when the owner holds at least one token account for `mint`. */
  solanaTokenAccountExists(network: NetworkKey, owner: string, mint: string): Promise<boolean>;
  resolveName(name: string, network: NetworkKey): Promise<{ readonly address: string; readonly protocol: ProtocolId }>;
  /**
   * What lives at a raw EVM address on one network (nameResolvers.accountCode): nothing, an
   * EIP-7702 delegation, or contract code. Throws when it cannot be read (never "none" for unknown).
   */
  accountCode(network: NetworkKey, address: string): Promise<AccountCodeKind>;
}

function solanaUrl(network: NetworkKey): string {
  const url = (SOLANA_RPC_URLS as Readonly<Record<string, string>>)[network];
  if (!url) throw new Error(`${network} is not a Solana network`);
  return url;
}

async function solanaCall(network: NetworkKey, method: string, params: readonly unknown[], timeoutMs: number): Promise<unknown> {
  const outcome = await jsonRpc(solanaUrl(network), method, params, timeoutMs);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.result;
}

/** Token accounts of `owner` for `mint` (jsonParsed), as `[amount]` base-unit strings. */
async function solanaTokenAmounts(network: NetworkKey, owner: string, mint: string): Promise<bigint[]> {
  const result = await solanaCall(network, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }], FACTS_DEADLINE_MS);
  const value = (result as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) throw new Error("malformed getTokenAccountsByOwner result");
  return value.map((entry: unknown) => {
    const amount = (entry as { account?: { data?: { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown } } } } } })
      ?.account?.data?.parsed?.info;
    if (amount?.mint !== mint || typeof amount.tokenAmount?.amount !== "string" || !/^\d+$/u.test(amount.tokenAmount.amount)) {
      throw new Error("malformed token account");
    }
    return BigInt(amount.tokenAmount.amount);
  });
}

const DEFAULT_READERS: HoldingsReaders = {
  async evmBalance(network, owner, token) {
    if (!isEvmNetwork(network)) throw new Error(`${network} is not an EVM network`);
    return readEvmBalance(network, owner, token);
  },
  async solanaBalance(network, owner, mint) {
    if (mint === null) {
      const result = await solanaCall(network, "getBalance", [owner, { commitment: "confirmed" }], FACTS_DEADLINE_MS);
      const value = (result as { value?: unknown } | null)?.value;
      // Above 2^53 lamports (about 9M SOL) JSON already rounded the number; the rounding is a few lamports at most.
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("malformed getBalance result");
      return BigInt(value);
    }
    return (await solanaTokenAmounts(network, owner, mint)).reduce((total, amount) => total + amount, 0n);
  },
  async gasPrice(network) {
    if (!isEvmNetwork(network)) throw new Error(`${network} is not an EVM network`);
    return evmClient(network).getGasPrice();
  },
  async solanaRent(network, bytes) {
    const result = await solanaCall(network, "getMinimumBalanceForRentExemption", [bytes, { commitment: "confirmed" }], FACTS_DEADLINE_MS);
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new Error("malformed rent result");
    return BigInt(result);
  },
  async solanaTokenAccountExists(network, owner, mint) {
    return (await solanaTokenAmounts(network, owner, mint)).length > 0;
  },
  async resolveName(name, network) {
    const resolved = await resolveRecipientName(name, network);
    return { address: resolved.address, protocol: resolved.protocol };
  },
  async accountCode(network, address) {
    const kind = await readAccountCode(network, address, FACTS_DEADLINE_MS);
    if (kind === "unknown") throw new Error("account code unavailable");
    return kind;
  },
};

/** Offline fixtures record no contract code: an address they do not describe is an externally owned account. */
const FIXTURE_ACCOUNT_CODE: HoldingsReaders["accountCode"] = async () => "none";

let readers: HoldingsReaders = DEFAULT_READERS;

/**
 * Replaces the raw readers (tests and the offline eval); `null` restores the
 * RPC readers. Clears every cache. Replaced readers are offline fixtures: a
 * set that does not give `accountCode` reads every address as having no code
 * (an externally owned account); a test of contract or unknown code passes
 * its own reader.
 */
export function configureHoldingsReaders(next: Partial<HoldingsReaders> | null): void {
  readers = next === null ? DEFAULT_READERS : { ...DEFAULT_READERS, accountCode: FIXTURE_ACCOUNT_CODE, ...next };
  resetHoldingsCaches();
}

/**
 * Replaces only the account-code reader of the installed readers, keeping the balances and names a test or
 * harness installed; null restores the fixture reader ("none" everywhere). Clears the account-code cache.
 */
export function configureAccountCodeReader(next: HoldingsReaders["accountCode"] | null): void {
  readers = { ...readers, accountCode: next ?? (readers === DEFAULT_READERS ? DEFAULT_READERS.accountCode : FIXTURE_ACCOUNT_CODE) };
  codeCache.clear();
}

interface Cached<T> {
  readonly value: T;
  readonly at: number;
}

const balanceCache = new Map<string, Cached<bigint>>();
const gasPriceCache = new Map<string, Cached<bigint>>();
const rentCache = new Map<string, Cached<{ wallet: bigint; token: bigint }>>();
const tokenAccountCache = new Map<string, Cached<boolean>>();
const nameCache = new Map<string, Cached<{ address: string; protocol: ProtocolId }>>();
const codeCache = new Map<string, Cached<AccountCodeKind>>();
/** Balance reads in flight, by cache key. */
const balanceReads = new Map<string, Promise<bigint>>();

export function resetHoldingsCaches(): void {
  balanceCache.clear();
  gasPriceCache.clear();
  rentCache.clear();
  tokenAccountCache.clear();
  nameCache.clear();
  codeCache.clear();
  balanceReads.clear();
}

function recall<T>(cache: Map<string, Cached<T>>, key: string, ttlMs: number): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T): T {
  cache.delete(key);
  cache.set(key, { value, at: Date.now() });
  // Oldest entries first (insertion order): keep the cache bounded.
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

function normalizedOwner(network: NetworkKey, owner: string): string {
  return CHAINS[network].namespace === "eip155" ? owner.toLowerCase() : owner;
}

/** Races a read against the call's deadline; a late read rejects (and is reported unknown). */
function beforeDeadline<T>(read: Promise<T>, deadline: number): Promise<T> {
  read.catch(() => undefined);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("deadline"));
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), remaining);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface ListedAsset {
  readonly id: AssetId;
  readonly symbol: string;
  readonly decimals: number;
  /** Token contract or mint; null for the native asset. */
  readonly address: string | null;
}

/** A listed asset on `network` (native symbol, registry symbol, address / mint or CAIP-19 id); no network reads. */
export function listedAsset(network: NetworkKey, raw: string): ListedAsset | null {
  const input = raw.trim();
  const chain = CHAINS[network];
  if (input.includes("/")) {
    const parsed = parseAssetId(input);
    if (!parsed || parsed.chain.key !== network) return null;
    if (parsed.isNative) return listedAsset(network, chain.nativeAsset.symbol);
    return listedAsset(network, parsed.reference);
  }
  if (input.toUpperCase() === chain.nativeAsset.symbol.toUpperCase()) {
    const native = getAsset(nativeAssetId(chain));
    return { id: nativeAssetId(chain), symbol: native?.symbol ?? chain.nativeAsset.symbol, decimals: chain.nativeAsset.decimals, address: null };
  }
  const descriptor = isEvmAddress(input) || isSolanaAddress(input) ? findAssetByAddress(network, input) : findAssetBySymbol(network, input);
  if (!descriptor) return null;
  return { id: descriptor.id, symbol: descriptor.symbol, decimals: descriptor.decimals, address: descriptor.address };
}

/** The address of the request's own account on `network`'s VM, or of `owner` when it is one of them. */
function ownerOn(accounts: readonly ParsedAccountId[], network: NetworkKey, owner: string | undefined): ParsedAccountId | null {
  const namespace = CHAINS[network].namespace;
  if (owner !== undefined) {
    const wanted = normalizedOwner(network, owner);
    return accounts.find((account) => account.chain.namespace === namespace && normalizedOwner(network, account.address) === wanted) ?? null;
  }
  try {
    return accountForNetwork(accounts, network);
  } catch {
    return null;
  }
}

function isPreviewOn(account: ParsedAccountId): boolean {
  return isPreviewAccount(account.id);
}

/** Shared read budget of one call. */
class Budget {
  balances: number;
  names: number;
  gasPrices = MAX_GAS_PRICE_READS;
  reads = 0;
  constructor(readonly deadline: number, balances: number, names: number) {
    this.balances = balances;
    this.names = names;
  }
  take(kind: "balances" | "names" | "gasPrices"): boolean {
    if (this[kind] <= 0) return false;
    this[kind] -= 1;
    this.reads += 1;
    return true;
  }
}

async function balanceFact(need: Extract<FactNeed, { kind: "balance" }>, accounts: readonly ParsedAccountId[], budget: Budget, flags: { preview: boolean }): Promise<BalanceFact> {
  const asset = listedAsset(need.network, need.asset);
  const symbol = asset?.symbol ?? need.asset.slice(0, 32);
  const account = ownerOn(accounts, need.network, need.owner);
  const base = { network: need.network, owner: account?.address ?? "", asset: asset?.id ?? null, symbol, decimals: asset?.decimals ?? null };
  if (!account) return { ...base, status: "skipped", reason: "No own account on this network's VM." };
  if (isPreviewOn(account)) {
    flags.preview = true;
    return { ...base, status: "skipped", reason: "Preview accounts are never read." };
  }
  if (!asset) return { ...base, status: "unknown", reason: "The asset is not listed on this network." };
  const key = `${need.network}|${normalizedOwner(need.network, account.address)}|${asset.id.toLowerCase()}`;
  const known = (amount: bigint): BalanceFact => ({ ...base, status: "known", amount: amount.toString(), formatted: fromBaseUnits(amount, asset.decimals) });
  const cached = recall(balanceCache, key, BALANCE_TTL_MS);
  if (cached !== undefined) return known(cached);
  // A read of the same (owner, network, asset) already under way is shared, not repeated.
  let read = balanceReads.get(key);
  if (!read) {
    if (!budget.take("balances")) return { ...base, status: "unknown", reason: "Read budget exhausted." };
    const started = (CHAINS[need.network].vm === "evm"
      ? readers.evmBalance(need.network, account.address, asset.address)
      : readers.solanaBalance(need.network, account.address, asset.address)
    ).then((amount) => {
      if (typeof amount !== "bigint" || amount < 0n) throw new Error("invalid balance");
      return remember(balanceCache, key, amount);
    }).finally(() => balanceReads.delete(key));
    balanceReads.set(key, started);
    read = started;
  }
  try {
    return known(await beforeDeadline(read, budget.deadline));
  } catch {
    return { ...base, status: "unknown", reason: "The balance could not be read." };
  }
}

async function gasPriceFact(network: NetworkKey, budget: Budget): Promise<GasPriceFact> {
  if (CHAINS[network].vm !== "evm") return { network, status: "skipped", reason: "Not an EVM network." };
  const cached = recall(gasPriceCache, network, GAS_PRICE_TTL_MS);
  if (cached !== undefined) return { network, status: "known", weiPerGas: cached.toString() };
  if (!budget.take("gasPrices")) return { network, status: "unknown", reason: "Read budget exhausted." };
  try {
    const value = await beforeDeadline(readers.gasPrice(network), budget.deadline);
    if (typeof value !== "bigint" || value <= 0n) throw new Error("invalid gas price");
    return { network, status: "known", weiPerGas: remember(gasPriceCache, network, value).toString() };
  } catch {
    return { network, status: "unknown", reason: "The gas price could not be read." };
  }
}

async function rentFact(network: NetworkKey, budget: Budget): Promise<SolanaRentFact> {
  if (CHAINS[network].vm !== "svm") return { network, status: "skipped", reason: "Not a Solana network." };
  const cached = recall(rentCache, network, RENT_TTL_MS);
  const known = (value: { wallet: bigint; token: bigint }): SolanaRentFact => ({
    network, status: "known", walletLamports: value.wallet.toString(), tokenAccountLamports: value.token.toString(),
  });
  if (cached) return known(cached);
  budget.reads += 2;
  try {
    const [wallet, token] = await beforeDeadline(Promise.all([readers.solanaRent(network, 0), readers.solanaRent(network, 165)]), budget.deadline);
    if (typeof wallet !== "bigint" || typeof token !== "bigint" || wallet <= 0n || token <= 0n) throw new Error("invalid rent");
    return known(remember(rentCache, network, { wallet, token }));
  } catch {
    return { network, status: "unknown", reason: "Rent could not be read." };
  }
}

async function tokenAccountFact(need: Extract<FactNeed, { kind: "tokenAccount" }>, accounts: readonly ParsedAccountId[], budget: Budget, flags: { preview: boolean }): Promise<TokenAccountFact> {
  const account = ownerOn(accounts, need.network, need.owner);
  const base = { network: need.network, owner: account?.address ?? "", mint: need.mint };
  if (CHAINS[need.network].vm !== "svm") return { ...base, status: "skipped", reason: "Not a Solana network." };
  if (!account) return { ...base, status: "skipped", reason: "No own Solana account." };
  if (isPreviewOn(account)) {
    flags.preview = true;
    return { ...base, status: "skipped", reason: "Preview accounts are never read." };
  }
  if (!isSolanaAddress(need.mint)) return { ...base, status: "unknown", reason: "Not a mint address." };
  const key = `${need.network}|${account.address}|${need.mint}`;
  const cached = recall(tokenAccountCache, key, TOKEN_ACCOUNT_TTL_MS);
  if (cached !== undefined) return { ...base, status: "known", exists: cached };
  if (!budget.take("balances")) return { ...base, status: "unknown", reason: "Read budget exhausted." };
  try {
    const exists = await beforeDeadline(readers.solanaTokenAccountExists(need.network, account.address, need.mint), budget.deadline);
    if (typeof exists !== "boolean") throw new Error("invalid answer");
    return { ...base, status: "known", exists: remember(tokenAccountCache, key, exists) };
  } catch {
    return { ...base, status: "unknown", reason: "The token account could not be read." };
  }
}

async function nameFact(need: Extract<FactNeed, { kind: "name" }>, budget: Budget): Promise<NameFact> {
  const name = need.name.trim().toLowerCase();
  const base = { name, network: need.network };
  const key = `${need.network}|${name}`;
  const cached = recall(nameCache, key, NAME_TTL_MS);
  if (cached) return { ...base, status: "known", address: cached.address, protocol: cached.protocol };
  if (!budget.take("names")) return { ...base, status: "unknown", reason: "Read budget exhausted.", unavailable: true };
  const read = readers.resolveName(name, need.network);
  // A read that outlives this turn's deadline still fills the cache for the next one.
  read.then((resolved) => remember(nameCache, key, resolved), () => undefined);
  try {
    const resolved = await beforeDeadline(read, budget.deadline);
    return { ...base, status: "known", address: resolved.address, protocol: resolved.protocol };
  } catch (error) {
    // The resolver said the name has no address (a 4xx), or the records could not be read in time.
    const definite = error instanceof PlatformError ? error.status < 500 : !(error instanceof Error && error.message === "deadline");
    return definite
      ? { ...base, status: "unknown", reason: "The name could not be resolved." }
      : { ...base, status: "unknown", reason: "The name records could not be read in time.", unavailable: true };
  }
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

/**
 * Reads the facts `needs` asks for, for the request's `accounts`, within
 * `budget`. Duplicate needs are read once. The result lists one fact per
 * distinct need, in the order of the needs.
 */
export async function readFacts(accounts: readonly AccountId[], needs: readonly FactNeed[], budget: FactBudget = {}): Promise<WalletFacts> {
  const parsed = accounts.map((account) => parseAccountId(account)).filter((account): account is ParsedAccountId => account !== null);
  const deadline = Date.now() + Math.max(1, Math.min(FACTS_DEADLINE_MS, budget.deadlineMs ?? FACTS_DEADLINE_MS));
  const shared = new Budget(
    deadline,
    Math.max(0, Math.min(MAX_BALANCE_READS, budget.balances ?? MAX_BALANCE_READS)),
    Math.max(0, Math.min(MAX_NAME_READS, budget.names ?? MAX_NAME_READS)),
  );
  const flags = { preview: false };
  const seen = new Set<string>();
  const unique = needs.filter((need) => {
    const key = JSON.stringify(need);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Budgets are taken synchronously in need order (each fact function takes its unit before its first await).
  const balances = unique.filter((need): need is Extract<FactNeed, { kind: "balance" }> => need.kind === "balance");
  const gas = [...new Set(unique.filter((need) => need.kind === "gasPrice").map((need) => need.network))];
  const rent = [...new Set(unique.filter((need) => need.kind === "solanaRent").map((need) => need.network))];
  const tokens = unique.filter((need): need is Extract<FactNeed, { kind: "tokenAccount" }> => need.kind === "tokenAccount");
  const names = unique.filter((need): need is Extract<FactNeed, { kind: "name" }> => need.kind === "name");
  const [balanceResults, gasResults, rentResults, tokenResults, nameResults] = await Promise.all([
    Promise.allSettled(balances.map((need) => balanceFact(need, parsed, shared, flags))),
    Promise.allSettled(gas.map((network) => gasPriceFact(network, shared))),
    Promise.allSettled(rent.map((network) => rentFact(network, shared))),
    Promise.allSettled(tokens.map((need) => tokenAccountFact(need, parsed, shared, flags))),
    Promise.allSettled(names.map((need) => nameFact(need, shared))),
  ]);
  return {
    balances: balanceResults.map((result, index) => settledValue(result, {
      network: balances[index]!.network, owner: "", asset: null, symbol: balances[index]!.asset.slice(0, 32), decimals: null, status: "unknown" as const, reason: "The balance could not be read.",
    })),
    gasPrices: gasResults.map((result, index) => settledValue(result, { network: gas[index]!, status: "unknown" as const })),
    rent: rentResults.map((result, index) => settledValue(result, { network: rent[index]!, status: "unknown" as const })),
    tokenAccounts: tokenResults.map((result, index) => settledValue(result, {
      network: tokens[index]!.network, owner: "", mint: tokens[index]!.mint, status: "unknown" as const,
    })),
    names: nameResults.map((result, index) => settledValue(result, { name: names[index]!.name, network: names[index]!.network, status: "unknown" as const })),
    reads: shared.reads,
    preview: flags.preview,
  };
}

/** Largest number of account-code reads one call may make (the receiving network and the other EVM networks of its lane). */
export const MAX_CODE_READS = 6;
export const CODE_TTL_MS = 15_000;

/** One account-code read: the kind, or "unknown" when it could not be read in time (never "none"). */
export interface AccountCodeFact {
  readonly network: NetworkKey;
  readonly address: string;
  readonly kind: AccountCodeKind | "unknown";
}

/**
 * Reads what lives at raw EVM addresses, at most MAX_CODE_READS a
 * call, in parallel within the deadline; cached 15 s. A read that fails,
 * does not answer in time or does not fit the budget is "unknown".
 */
export async function readAccountCodes(needs: readonly { readonly network: NetworkKey; readonly address: string }[], deadlineMs: number = FACTS_DEADLINE_MS): Promise<AccountCodeFact[]> {
  const deadline = Date.now() + Math.max(1, Math.min(FACTS_DEADLINE_MS, deadlineMs));
  let budget = MAX_CODE_READS;
  return Promise.all(needs.map(async (need) => {
    const base = { network: need.network, address: need.address };
    if (CHAINS[need.network].vm !== "evm" || !isEvmAddress(need.address)) return { ...base, kind: "unknown" as const };
    const key = `${need.network}|${need.address.toLowerCase()}`;
    const cached = recall(codeCache, key, CODE_TTL_MS);
    if (cached !== undefined) return { ...base, kind: cached };
    if (budget <= 0) return { ...base, kind: "unknown" as const };
    budget -= 1;
    try {
      const kind = await beforeDeadline(readers.accountCode(need.network, need.address), deadline);
      if (kind !== "none" && kind !== "delegated" && kind !== "contract") throw new Error("invalid account code");
      return { ...base, kind: remember(codeCache, key, kind) };
    } catch {
      return { ...base, kind: "unknown" as const };
    }
  }));
}

/** The known balance of a fact in base units, or null when it is not known (never zero for unknown). */
export function knownAmount(fact: Pick<BalanceFact, "status" | "amount"> | undefined): bigint | null {
  return fact?.status === "known" && fact.amount !== undefined ? BigInt(fact.amount) : null;
}

/** True when every account of the request is a preview (demo) account. */
export function onlyPreviewAccounts(accounts: readonly AccountId[]): boolean {
  return accounts.length > 0 && accounts.every((account) => isPreviewAccount(account));
}
