/**
 * The Rule Book's conservative USD oracle. Separate from the advisory
 * `engine/prices.ts`, which may return null freely for fee display; here a
 * missing price is a refusal wherever a USD rule needs it (the evaluator
 * in @kletia/core fails closed on null).
 *
 * - Chainlink `latestRoundData()` by read-only `eth_call`: answer > 0 and
 *   `max(0, now - updatedAt) ≤ heartbeat + 300 s`; `decimals()` read on-chain.
 *   On Arbitrum One, OP Mainnet and Base a reading counts only while the
 *   network's sequencer uptime feed reports up for more than an hour; an
 *   unreadable uptime feed drops the reading (fail closed).
 * - Derived prices (wstETH, rETH, weETH): the product of fresh Chainlink
 *   factors and, for wstETH, `stEthPerToken()` within sane bounds.
 * - Jupiter Price v3: `usdPrice > 0`, `liquidity ≥ 100,000` and
 *   `currentSlot - blockId ≤ 900`. Without a readable current slot Jupiter
 *   readings are not fresh (freshness cannot be shown).
 * - Pyth push feeds (Solana): the account must be the shard-0 PDA of the feed
 *   id under the push oracle and owned by the receiver, the update
 *   `PriceUpdateV2` with Full verification and the expected feed id,
 *   `price > 0`, `publish_time` within 60 s of now and `conf / price ≤ 2 %`;
 *   anything else ignores the source.
 * - The price is the **maximum** of fresh sources (a wrong price can only
 *   tighten), USD stablecoins are floored at $1.00, testnet assets are $0,
 *   and sources that disagree by more than 25 % add a warning.
 * - Every source read has a 2 s deadline; readings are cached 30 s
 *   (failures 5 s). Amounts are converted to integer micro-dollars, rounded up.
 */
import { createHash } from "node:crypto";
import { CHAINS, parseAssetId, type AssetId, type AssetRef, type NetworkKey } from "@kletia/core";
import { address, getAddressDecoder, getProgramDerivedAddress } from "@solana/kit";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { JUPITER_API_KEY, JUPITER_API_URL, solanaRpc } from "../../../networks/solana/index.js";
import { assetFromRef, isUsdStablecoin } from "../assets.js";
import { rawEthCall, type EvmNetworkKey } from "../chains/evm.js";
import { readSolanaAccounts } from "../chains/solana.js";
import { fetchProviderJson } from "../http.js";
import { isRecord } from "../util.js";
import {
  CHAINLINK_GRACE_SECONDS,
  JUPITER_MAX_SLOT_LAG,
  JUPITER_MIN_LIQUIDITY_USD,
  listedAsset,
  priceSourcesFor,
  PYTH_MAX_AGE_SECONDS,
  PYTH_MAX_CONFIDENCE_BPS,
  PYTH_PUSH_ORACLE,
  PYTH_RECEIVER,
  SEQUENCER_GRACE_SECONDS,
  SEQUENCER_UPTIME_FEEDS,
  type ChainlinkFeed,
  type DerivedFeed,
  type JupiterFeed,
  type PriceSource,
  type PythFeed,
  type SequencerFeed,
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
  readonly source: "chainlink" | "jupiter" | "derived" | "pyth";
  /** Proxy address, mint, derived feed id or Pyth push-feed account. */
  readonly id: string;
  /** USD per whole token × 10^18. */
  readonly usd18: bigint;
  /** Unix seconds of the reading (Chainlink `updatedAt`; derived: the oldest factor's; Jupiter: read time; Pyth: `publish_time`). */
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
  /** A Solana mainnet account (owner and data), null when it does not exist. */
  solanaAccount(address: string): Promise<{ readonly owner: string; readonly data: Uint8Array } | null>;
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
  solanaAccount: async (account) => (await readSolanaAccounts("solana", [account]))[0] ?? null,
  now: () => Date.now(),
};

/** Partial seams without `solanaAccount` read no Pyth account (those sources stay unavailable, never live). */
const noSolanaAccount: PolicyPricingTransport["solanaAccount"] = async () => {
  throw new Error("Solana accounts are not configured");
};

let transport: PolicyPricingTransport = defaultTransport;

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}
const readings = new Map<string, CacheEntry<PriceReading | null>>();
const sequencers = new Map<string, CacheEntry<boolean>>();
const sequencerInflight = new Map<string, Promise<boolean>>();
const decimals = new Map<string, number>();
const inflight = new Map<string, Promise<PriceReading | null>>();
let slot: CacheEntry<bigint | null> | null = null;
let slotInflight: Promise<bigint | null> | null = null;

/** Replaces read seams (partial); null restores the live transport. Clears every cache. */
export function configurePolicyPricing(next: Partial<PolicyPricingTransport> | null): void {
  transport = next ? { ...defaultTransport, solanaAccount: noSolanaAccount, ...next } : defaultTransport;
  resetPolicyPricing();
}

/** Clears cached readings, feed decimals and the slot. */
export function resetPolicyPricing(): void {
  readings.clear();
  sequencers.clear();
  sequencerInflight.clear();
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
const RATE_ABI = parseAbi(["function stEthPerToken() view returns (uint256)"]);

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

/**
 * True when the sequencer of an L2 has been up for more than
 * SEQUENCER_GRACE_SECONDS (cached like a reading). False while it is down,
 * shortly after a restart, or when the uptime feed cannot be read.
 */
async function sequencerReady(feed: SequencerFeed): Promise<boolean> {
  const key = `seq:${feed.network}:${feed.address.toLowerCase()}`;
  const cached = sequencers.get(key);
  if (cached && cached.expiresAt > transport.now()) return cached.value;
  const pending = sequencerInflight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const raw = await withDeadline(transport.ethCall(feed.network, feed.address, LATEST_ROUND_CALL));
    if (!raw) return false;
    const [, answer, startedAt] = decodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", data: raw });
    // A zero startedAt is an uninitialised round (Arbitrum before the first update): not a status.
    if (answer !== 0n || startedAt === 0n) return false;
    const nowSeconds = BigInt(Math.floor(transport.now() / 1000));
    return nowSeconds > startedAt && nowSeconds - startedAt > BigInt(SEQUENCER_GRACE_SECONDS);
  })()
    .catch(() => false)
    .then((value) => {
      sequencers.set(key, { value, expiresAt: transport.now() + (value ? CACHE_TTL_MS : FAILURE_TTL_MS) });
      sequencerInflight.delete(key);
      return value;
    });
  sequencerInflight.set(key, request);
  return request;
}

async function readChainlink(feed: ChainlinkFeed): Promise<PriceReading | null> {
  const gate = SEQUENCER_UPTIME_FEEDS[feed.network];
  if (gate && !(await sequencerReady(gate))) return null;
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

/** Anchor discriminator of the receiver's `PriceUpdateV2` account. */
const PRICE_UPDATE_DISCRIMINATOR = createHash("sha256").update("account:PriceUpdateV2").digest("hex").slice(0, 16);
const addressDecoder = getAddressDecoder();

export interface PythPriceUpdate {
  readonly writeAuthority: string;
  /** Full: every Wormhole guardian signature was verified; Partial carries the number checked. */
  readonly verification: "full" | "partial";
  /** Lower-case hex. */
  readonly feedId: string;
  readonly price: bigint;
  readonly conf: bigint;
  readonly exponent: number;
  /** Unix seconds. */
  readonly publishTime: number;
}

/**
 * Decodes a Pyth receiver `PriceUpdateV2` account: discriminator (8),
 * write_authority (32), verification_level (enum: 0 Partial { u8 }, 1 Full),
 * then the price message: feed_id (32), price i64, conf u64, exponent i32,
 * publish_time i64, prev_publish_time i64, ema_price i64, ema_conf u64, and
 * posted_slot u64. Null when the bytes are not such an account.
 */
export function decodePythPriceUpdate(data: Uint8Array): PythPriceUpdate | null {
  if (data.length < 133 || Buffer.from(data.subarray(0, 8)).toString("hex") !== PRICE_UPDATE_DISCRIMINATOR) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const level = data[40];
  if (level !== 0 && level !== 1) return null;
  let offset = level === 0 ? 42 : 41;
  if (data.length < offset + 92) return null;
  const feedId = Buffer.from(data.subarray(offset, offset + 32)).toString("hex");
  offset += 32;
  const price = view.getBigInt64(offset, true);
  const conf = view.getBigUint64(offset + 8, true);
  const exponent = view.getInt32(offset + 16, true);
  const publishTime = Number(view.getBigInt64(offset + 20, true));
  const writeAuthority = String(addressDecoder.decode(data.subarray(8, 40)));
  return { writeAuthority, verification: level === 1 ? "full" : "partial", feedId, price, conf, exponent, publishTime };
}

const pythAccounts = new Map<string, Promise<string>>();

/** The shard-0 push-feed account of a feed id: PDA([0u16 LE, feed_id], push oracle). */
export function pythFeedAccount(feedId: string): Promise<string> {
  let pending = pythAccounts.get(feedId);
  if (!pending) {
    pending = getProgramDerivedAddress({ programAddress: address(PYTH_PUSH_ORACLE), seeds: [new Uint8Array(2), Buffer.from(feedId, "hex")] }).then(([pda]) => String(pda));
    pythAccounts.set(feedId, pending);
  }
  return pending;
}

async function readPyth(feed: PythFeed): Promise<PriceReading | null> {
  if (!/^[0-9a-f]{64}$/u.test(feed.feedId) || (await pythFeedAccount(feed.feedId)) !== feed.account) return null;
  const state = await withDeadline(transport.solanaAccount(feed.account));
  if (!state || state.owner !== PYTH_RECEIVER) return null;
  const update = decodePythPriceUpdate(state.data);
  if (!update || update.verification !== "full" || update.feedId !== feed.feedId) return null;
  if (update.price <= 0n || update.exponent > 0 || update.exponent < -PRICE_SCALE) return null;
  if (update.conf * 10_000n > update.price * BigInt(PYTH_MAX_CONFIDENCE_BPS)) return null;
  const nowSeconds = Math.floor(transport.now() / 1000);
  if (Math.abs(nowSeconds - update.publishTime) > PYTH_MAX_AGE_SECONDS) return null;
  return { source: "pyth", id: feed.account, usd18: toUsd18(update.price, -update.exponent), observedAt: update.publishTime };
}

/**
 * Product of fresh factor readings (each at 18 decimals) and the optional
 * on-chain rate; null when any factor is stale or the rate is out of bounds.
 */
async function readDerived(feed: DerivedFeed): Promise<PriceReading | null> {
  if (feed.factors.length === 0) return null;
  const factors = await Promise.all(feed.factors.map((factor) => readPriceSource(factor)));
  if (factors.some((reading) => reading === null)) return null;
  const fresh = factors as PriceReading[];
  let usd18 = fresh[0]!.usd18;
  for (const reading of fresh.slice(1)) usd18 = (usd18 * reading.usd18 + ONE_USD - 1n) / ONE_USD;
  if (feed.rate) {
    const raw = await withDeadline(transport.ethCall(feed.rate.network, feed.rate.address, encodeFunctionData({ abi: RATE_ABI, functionName: feed.rate.functionName })));
    if (!raw) return null;
    const rate = decodeFunctionResult({ abi: RATE_ABI, functionName: feed.rate.functionName, data: raw });
    if (rate < feed.rate.min || rate > feed.rate.max) return null;
    usd18 = (usd18 * rate + ONE_USD - 1n) / ONE_USD;
  }
  if (usd18 <= 0n) return null;
  return { source: "derived", id: feed.id, usd18, observedAt: Math.min(...fresh.map((reading) => reading.observedAt)) };
}

function sourceKey(source: PriceSource): string {
  if (source.kind === "chainlink") return `cl:${source.network}:${source.address.toLowerCase()}`;
  if (source.kind === "pyth") return `pyth:${source.account}`;
  return source.kind === "derived" ? source.id : `jup:${source.mint}`;
}

/** One fresh reading of a source (cached 30 s, failures 5 s); null when stale, invalid or unreachable. */
export async function readPriceSource(source: PriceSource): Promise<PriceReading | null> {
  const key = sourceKey(source);
  const now = transport.now();
  const cached = readings.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = (source.kind === "chainlink" ? readChainlink(source)
    : source.kind === "derived" ? readDerived(source)
      : source.kind === "pyth" ? readPyth(source)
        : readJupiter(source))
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
 * Conservative USD price of an asset, or null when no
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
