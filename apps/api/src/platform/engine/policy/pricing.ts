/**
 * The Rule Book's conservative USD oracle (policy design §5.1). Separate
 * from the advisory `engine/prices.ts`, which may return null freely for
 * fee display; here a missing price is a refusal wherever a USD rule needs
 * it (the evaluator in @kletia/core fails closed on null).
 *
 * - Chainlink `latestRoundData()` by read-only `eth_call`: answer > 0 and
 *   `max(0, now - updatedAt) ≤ heartbeat + 300 s`; `decimals()` read on-chain.
 * - Jupiter Price v3: `usdPrice > 0`, `liquidity ≥ 100,000` and
 *   `currentSlot - blockId ≤ 900`. Without a readable current slot Jupiter
 *   readings are not fresh (freshness cannot be shown).
 * - The price is the **maximum** of fresh sources (a wrong price can only
 *   tighten), USD stablecoins are floored at $1.00, testnet assets are $0,
 *   and sources that disagree by more than 25 % add a warning.
 * - Every source read has a 2 s deadline; readings are cached 30 s
 *   (failures 5 s). Amounts are converted to integer micro-dollars, rounded up.
 */
import { CHAINS, parseAssetId, type AssetId, type AssetRef, type NetworkKey } from "@kletia/core";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { JUPITER_API_KEY, JUPITER_API_URL, solanaRpc } from "../../../networks/solana/index.js";
import { assetFromRef, isUsdStablecoin } from "../assets.js";
import { rawEthCall, type EvmNetworkKey } from "../chains/evm.js";
import { fetchProviderJson } from "../http.js";
import { isRecord } from "../util.js";
import {
  CHAINLINK_GRACE_SECONDS,
  JUPITER_MAX_SLOT_LAG,
  JUPITER_MIN_LIQUIDITY_USD,
  listedAsset,
  priceSourcesFor,
  type ChainlinkFeed,
  type JupiterFeed,
  type PriceSource,
} from "./feeds.js";

/** Fixed-point scale of every USD price here: USD per whole token × 10^18. */
export const PRICE_SCALE = 18;
const ONE_USD = 10n ** BigInt(PRICE_SCALE);
export const SOURCE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 30_000;
const FAILURE_TTL_MS = 5_000;
const SLOT_TTL_MS = 10_000;
/** Sources whose highest and lowest fresh readings differ by more than this ratio add a warning. */
const DISAGREEMENT_RATIO_BPS = 12_500n;

export interface PriceReading {
  readonly source: "chainlink" | "jupiter";
  /** Proxy address or mint. */
  readonly id: string;
  /** USD per whole token × 10^18. */
  readonly usd18: bigint;
  /** Unix seconds of the reading (Chainlink `updatedAt`; Jupiter: read time). */
  readonly observedAt: number;
}

export interface PriceQuote {
  readonly asset: AssetId;
  readonly network: NetworkKey;
  /** USD per whole token × 10^18 (conservative: max of fresh sources, stable floor applied). */
  readonly usd18: bigint;
  /** `testnet`: $0 by rule; `oracle`: from fresh sources. */
  readonly basis: "oracle" | "testnet";
  /** Fresh readings the price was taken from. */
  readonly readings: readonly PriceReading[];
  /** The $1.00 floor raised the price (USD stablecoin below the peg). */
  readonly floored: boolean;
  readonly warnings: readonly string[];
}

/** Read seams (tests, embedders). Every method may throw; a throw is "source unavailable". */
export interface PolicyPricingTransport {
  /** Raw `eth_call` (null when the call reverts). */
  ethCall(network: EvmNetworkKey, to: string, data: Hex): Promise<Hex | null>;
  /** Raw Jupiter Price v3 body for these mints. */
  jupiterPrices(mints: readonly string[]): Promise<unknown>;
  /** Current Solana mainnet slot. */
  solanaSlot(): Promise<bigint>;
  /** Unix ms. */
  now(): number;
}

const defaultTransport: PolicyPricingTransport = {
  ethCall: (network, to, data) => rawEthCall(network, to, data),
  jupiterPrices: (mints) =>
    fetchProviderJson(`${JUPITER_API_URL}/price/v3?ids=${mints.map(encodeURIComponent).join(",")}`, {
      provider: "Jupiter",
      timeoutMs: SOURCE_TIMEOUT_MS,
      ...(JUPITER_API_KEY ? { headers: { "x-api-key": JUPITER_API_KEY } } : {}),
    }),
  solanaSlot: async () => BigInt(await solanaRpc("solana").getSlot({ commitment: "confirmed" }).send({ abortSignal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) })),
  now: () => Date.now(),
};

let transport: PolicyPricingTransport = defaultTransport;

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}
const readings = new Map<string, CacheEntry<PriceReading | null>>();
const decimals = new Map<string, number>();
const inflight = new Map<string, Promise<PriceReading | null>>();
let slot: CacheEntry<bigint | null> | null = null;
let slotInflight: Promise<bigint | null> | null = null;

/** Replaces read seams (partial); null restores the live transport. Clears every cache. */
export function configurePolicyPricing(next: Partial<PolicyPricingTransport> | null): void {
  transport = next ? { ...defaultTransport, ...next } : defaultTransport;
  resetPolicyPricing();
}

/** Clears cached readings, feed decimals and the slot. */
export function resetPolicyPricing(): void {
  readings.clear();
  decimals.clear();
  inflight.clear();
  slot = null;
  slotInflight = null;
}

async function withDeadline<T>(promise: Promise<T>, ms = SOURCE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("price source timed out")), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const DECIMALS_CALL = encodeFunctionData({ abi: FEED_ABI, functionName: "decimals" });
const LATEST_ROUND_CALL = encodeFunctionData({ abi: FEED_ABI, functionName: "latestRoundData" });

/** Scales an integer with `from` decimals to PRICE_SCALE, rounding up (conservative). */
export function toUsd18(value: bigint, from: number): bigint {
  if (from === PRICE_SCALE) return value;
  if (from < PRICE_SCALE) return value * 10n ** BigInt(PRICE_SCALE - from);
  const divisor = 10n ** BigInt(from - PRICE_SCALE);
  return (value + divisor - 1n) / divisor;
}

/**
 * A finite positive JS number (Jupiter's `usdPrice`) as USD × 10^18, rounded
 * up. Reads the shortest decimal that round-trips (the JSON text Jupiter
 * sent), not the binary expansion: 0.3 is 0.3. Null when unusable.
 */
export function usd18FromNumber(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1e15) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? "";
  const digits = BigInt(`${match[1]}${fraction}`);
  const exponent = Number(match[3] ?? "0") - fraction.length;
  const result = exponent >= 0 ? digits * 10n ** BigInt(exponent) * 10n ** BigInt(PRICE_SCALE) : toUsd18(digits, -exponent);
  return result > 0n ? result : null;
}

async function feedDecimals(feed: ChainlinkFeed): Promise<number> {
  const key = `${feed.network}:${feed.address.toLowerCase()}`;
  const known = decimals.get(key);
  if (known !== undefined) return known;
  const raw = await withDeadline(transport.ethCall(feed.network, feed.address, DECIMALS_CALL));
  if (!raw) throw new Error("decimals() reverted");
  const value = Number(decodeFunctionResult({ abi: FEED_ABI, functionName: "decimals", data: raw }));
  if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error("decimals() out of range");
  decimals.set(key, value);
  return value;
}

async function readChainlink(feed: ChainlinkFeed): Promise<PriceReading | null> {
  const places = await feedDecimals(feed);
  const raw = await withDeadline(transport.ethCall(feed.network, feed.address, LATEST_ROUND_CALL));
  if (!raw) return null;
  const [, answer, , updatedAt] = decodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", data: raw });
  if (answer <= 0n) return null;
  const nowSeconds = BigInt(Math.floor(transport.now() / 1000));
  const age = nowSeconds > updatedAt ? nowSeconds - updatedAt : 0n;
  if (age > BigInt(feed.heartbeatSeconds + CHAINLINK_GRACE_SECONDS)) return null;
  return { source: "chainlink", id: feed.address, usd18: toUsd18(answer, places), observedAt: Number(updatedAt) };
}

async function currentSlot(): Promise<bigint | null> {
  const now = transport.now();
  if (slot && slot.expiresAt > now) return slot.value;
  slotInflight ??= withDeadline(transport.solanaSlot())
    .then((value) => (typeof value === "bigint" && value > 0n ? value : null))
    .catch(() => null)
    .then((value) => {
      slot = { value, expiresAt: transport.now() + (value === null ? FAILURE_TTL_MS : SLOT_TTL_MS) };
      slotInflight = null;
      return value;
    });
  return slotInflight;
}

async function readJupiter(feed: JupiterFeed): Promise<PriceReading | null> {
  const [body, current] = await Promise.all([withDeadline(transport.jupiterPrices([feed.mint])), currentSlot()]);
  if (current === null || !isRecord(body)) return null;
  const entry = body[feed.mint];
  if (!isRecord(entry)) return null;
  const usd18 = usd18FromNumber(entry.usdPrice);
  const liquidity = entry.liquidity;
  const blockId = entry.blockId;
  if (usd18 === null || typeof liquidity !== "number" || !(liquidity >= JUPITER_MIN_LIQUIDITY_USD)) return null;
  if (typeof blockId !== "number" || !Number.isSafeInteger(blockId) || blockId <= 0) return null;
  const lag = current - BigInt(blockId);
  if (lag > BigInt(JUPITER_MAX_SLOT_LAG)) return null;
  return { source: "jupiter", id: feed.mint, usd18, observedAt: Math.floor(transport.now() / 1000) };
}

function sourceKey(source: PriceSource): string {
  return source.kind === "chainlink" ? `cl:${source.network}:${source.address.toLowerCase()}` : `jup:${source.mint}`;
}

/** One fresh reading of a source (cached 30 s, failures 5 s); null when stale, invalid or unreachable. */
export async function readPriceSource(source: PriceSource): Promise<PriceReading | null> {
  const key = sourceKey(source);
  const now = transport.now();
  const cached = readings.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = (source.kind === "chainlink" ? readChainlink(source) : readJupiter(source))
    .catch(() => null)
    .then((value) => {
      readings.set(key, { value, expiresAt: transport.now() + (value === null ? FAILURE_TTL_MS : CACHE_TTL_MS) });
      inflight.delete(key);
      return value;
    });
  inflight.set(key, request);
  return request;
}

/** Registry metadata decides (never the symbol an adapter reported). */
function stablecoin(asset: AssetId): boolean {
  const listed = listedAsset(asset);
  if (!listed) return false;
  return isUsdStablecoin(assetFromRef({ asset: listed.id, symbol: listed.symbol, decimals: listed.decimals }));
}

/**
 * Conservative USD price of an asset (policy design §5.1), or null when no
 * fresh source prices it. Testnet assets are $0 by rule.
 */
export async function policyPrice(asset: AssetRef & { readonly network: NetworkKey }): Promise<PriceQuote | null> {
  const parsed = parseAssetId(asset.asset);
  const network = parsed?.chain.key ?? asset.network;
  if (!parsed || parsed.chain.key !== asset.network) return null;
  if (CHAINS[network].environment === "testnet") {
    return { asset: asset.asset, network, usd18: 0n, basis: "testnet", readings: [], floored: false, warnings: [] };
  }
  const sources = priceSourcesFor(asset.asset);
  if (sources.length === 0) return null;
  const fresh = (await Promise.all(sources.map((source) => readPriceSource(source)))).filter((reading): reading is PriceReading => reading !== null);
  if (fresh.length === 0) return null;
  const high = fresh.reduce((max, reading) => (reading.usd18 > max ? reading.usd18 : max), 0n);
  const low = fresh.reduce((min, reading) => (reading.usd18 < min ? reading.usd18 : min), high);
  const warnings: string[] = [];
  if (low > 0n && high * 10_000n > low * DISAGREEMENT_RATIO_BPS) {
    warnings.push(`Price sources for ${asset.symbol} disagree by more than 25 %; the highest was used.`);
  }
  const floored = stablecoin(asset.asset) && high < ONE_USD;
  return { asset: asset.asset, network, usd18: floored ? ONE_USD : high, basis: "oracle", readings: fresh, floored, warnings };
}

/** Prices several assets at once (deduplicated); the map holds null for unpriced assets. */
export async function policyPrices(assets: readonly (AssetRef & { readonly network: NetworkKey })[]): Promise<Map<string, PriceQuote | null>> {
  const unique = new Map<string, AssetRef & { readonly network: NetworkKey }>();
  for (const asset of assets) if (!unique.has(asset.asset)) unique.set(asset.asset, asset);
  const entries = await Promise.all([...unique.values()].map(async (asset) => [asset.asset, await policyPrice(asset).catch(() => null)] as const));
  return new Map(entries);
}

/** ceil(amount × price × 10^6 / 10^decimals): integer micro-dollars, rounded up. */
export function notionalUsdMicros(amount: string | bigint, decimalsOfAsset: number, quote: Pick<PriceQuote, "usd18">): bigint {
  const units = BigInt(amount);
  if (units <= 0n || quote.usd18 <= 0n) return 0n;
  const numerator = units * quote.usd18 * 1_000_000n;
  const denominator = 10n ** BigInt(decimalsOfAsset) * ONE_USD;
  return (numerator + denominator - 1n) / denominator;
}

/** USD per whole token as a JS number (display / advisory fee use only). */
export function quoteUsdNumber(quote: Pick<PriceQuote, "usd18">): number {
  return Number(quote.usd18 / 10n ** 9n) / 1e9;
}
