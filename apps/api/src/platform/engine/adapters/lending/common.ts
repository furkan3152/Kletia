/**
 * Shared pieces of the EVM lending adapters (Aave V3, Compound V3, Morpho
 * ERC-4626 vaults, Moonwell): the registry venue lookup, exact approvals,
 * native ETH wrap / unwrap legs, strict simulation, receipt-log proofs and
 * rate / TVL reads.
 *
 * Every address an adapter touches comes from @kletia/core: the market from
 * YIELD_VENUES (via the planner-resolved `action.venue`), the underlying from
 * ASSETS. On-chain reads only confirm those pins; a disagreement refuses the
 * step (fail closed). Outcomes are proven from receipt logs of the landed,
 * binding-matched transactions, never from the receipt status alone.
 */
import {
  BaseError,
  decodeErrorResult,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  formatAssetId,
  fromBaseUnits,
  getYieldVenue,
  isBaseUnitAmount,
  yieldVenuesFor,
  type AaveReserveVenue,
  type AssetAmount,
  type AssetDescriptor,
  type CometVenue,
  type CTokenVenue,
  type Erc4626Venue,
  type EvmTransactionRequest,
  type IntentStep,
  type NetworkKey,
  type ProtocolId,
  type ReceiptToken,
  type StepEvidence,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import type { ResolvedAsset } from "../../assets.js";
import { evmChainId, evmClient, isEvmNetwork, readAllowance, type EvmNetworkKey } from "../../chains/evm.js";
import { decodeStepRef } from "../../stepRef.js";
import { estimateGas } from "../evmTransfer.js";
import type { AdapterAction, AdapterRoute, PreparedPayload } from "../types.js";
import { evmEvents, type LandedEvmReceipt } from "../verification.js";

/** Wei tolerance for receipt-token rounding (aToken / Comet mints credit amount - 1). */
export const ROUNDING_WEI = 2n;
export const MAX_UINT256 = (1n << 256n) - 1n;
/** Share-price drift (bps) tolerated between prepare and execution for share-based receipts. */
export const SHARE_TOLERANCE_BPS = 10n;
export const SECONDS_PER_YEAR = 31_536_000;
export const APPROVE_GAS = 60_000n;
export const WRAP_GAS = 60_000n;
export const UNWRAP_GAS = 60_000n;

const READ_TIMEOUT_MS = 10_000;

export type EvmLendingVenue = AaveReserveVenue | CometVenue | Erc4626Venue | CTokenVenue;
export type EvmLendingKind = EvmLendingVenue["kind"];
export type VenueOfKind<K extends EvmLendingKind> = Extract<EvmLendingVenue, { kind: K }>;
export type LendingKind = "deposit" | "withdraw";

/** WETH9 (Base / OP / Ethereum) and aeWETH (Arbitrum) entry points used for native ETH. */
export const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
]);

export interface LendingContext<V extends EvmLendingVenue> {
  readonly venue: V;
  readonly network: EvmNetworkKey;
  readonly chainId: number;
  readonly kind: LendingKind;
  /** The step account: sender, beneficiary, receiver and owner of every venue call. */
  readonly owner: Address;
  /** The venue's underlying ERC-20 as pinned in ASSETS; baseToken() / asset() / underlying() must equal it. */
  readonly underlying: AssetDescriptor & { readonly address: string };
  readonly token: Address;
  /** The action moves native ETH: wrapped before a deposit, unwrapped after a withdraw. */
  readonly native: boolean;
}

/** WETH-style contract of the network's native ETH (deposit() / withdraw(uint256)). */
export function wrapsNative(network: NetworkKey, underlying: AssetDescriptor): boolean {
  return CHAINS[network].nativeAsset.symbol === "ETH" && underlying.category === "wrapped" && underlying.group === "ETH" && underlying.address !== null;
}

function venueAssetMatches(network: NetworkKey, venue: EvmLendingVenue, input: ResolvedAsset, allowNative: boolean): boolean {
  const underlying = findAssetBySymbol(network, venue.asset);
  if (!underlying?.address) return false;
  if (input.isNative) return allowNative && wrapsNative(network, underlying);
  return underlying.id.toLowerCase() === input.id.toLowerCase();
}

/**
 * True when the registry has a `kind` venue of `protocol` on the route's
 * network that executes the route's action for its input asset. Native ETH
 * counts only when the adapter wraps / unwraps it (`native`).
 */
export function supportsLending(
  route: AdapterRoute,
  protocol: ProtocolId,
  kind: EvmLendingKind,
  native: { readonly deposit: boolean; readonly withdraw: boolean },
): boolean {
  if ((route.kind !== "deposit" && route.kind !== "withdraw") || route.network !== route.destinationNetwork || !isEvmNetwork(route.network)) {
    return false;
  }
  const allowNative = route.kind === "deposit" ? native.deposit : native.withdraw;
  return yieldVenuesFor(route.network, protocol).some((venue) =>
    venue.kind === kind &&
    venue.actions.includes(route.kind as LendingKind) &&
    venueAssetMatches(route.network, venue as EvmLendingVenue, route.input, allowNative));
}

/**
 * The planner-resolved venue of a deposit / withdraw, re-validated against
 * the registry: kind, protocol, network, executable action and underlying
 * asset. Anything else is an engine bug (500); a native input the venue
 * cannot take is a 422.
 */
export function lendingContext<K extends EvmLendingKind>(action: AdapterAction, kind: K, protocol: ProtocolId): LendingContext<VenueOfKind<K>> {
  if (action.kind !== "deposit" && action.kind !== "withdraw") {
    throw new PlatformError("VENUE_INVALID", `A ${protocol} adapter received a ${action.kind} action.`, 500);
  }
  if (!isEvmNetwork(action.network) || action.destinationNetwork !== action.network) {
    throw new PlatformError("NETWORK_UNSUPPORTED", `Lending venues execute on the step's own EVM network, not ${CHAINS[action.network].name}.`, 422);
  }
  const network = action.network;
  const venue = getYieldVenue(action.venue ?? "");
  if (!venue || venue.kind !== kind || venue.protocol !== protocol || venue.network !== network || !venue.actions.includes(action.kind)) {
    throw new PlatformError("VENUE_INVALID", `The step's venue is not a ${protocol} ${kind} venue that takes ${action.kind}s on ${CHAINS[network].name}.`, 500);
  }
  const underlying = findAssetBySymbol(network, venue.asset);
  if (!underlying || underlying.address === null) {
    throw new PlatformError("VENUE_INVALID", `${venue.name} lists ${venue.asset}, which is not a pinned ERC-20 on ${CHAINS[network].name}.`, 500);
  }
  const native = action.input.isNative;
  if (native && !wrapsNative(network, underlying)) {
    throw new PlatformError("INTENT_UNSUPPORTED", `${venue.name} holds ${underlying.symbol}; ${action.input.symbol} cannot be used there.`, 422);
  }
  if (!native && action.input.id.toLowerCase() !== underlying.id.toLowerCase()) {
    throw new PlatformError("VENUE_INVALID", `${venue.name} holds ${underlying.symbol}, not ${action.input.symbol}.`, 500);
  }
  if (action.recipient.address.toLowerCase() !== action.account.address.toLowerCase()) {
    throw new PlatformError("INTENT_UNSUPPORTED", `A ${action.kind} pays the acting account; send the result with a separate "send" step.`, 422);
  }
  return {
    venue: venue as VenueOfKind<K>,
    network,
    chainId: evmChainId(network),
    kind: action.kind,
    owner: getAddress(action.account.address),
    underlying: underlying as AssetDescriptor & { readonly address: string },
    token: getAddress(underlying.address),
    native,
  };
}

/** The registry venue a recorded step executes against (verify / poll). */
export function stepVenue<K extends EvmLendingKind>(step: IntentStep, kind: K): VenueOfKind<K> | null {
  const venue = getYieldVenue(step.venue ?? "");
  if (!venue || venue.kind !== kind || venue.network !== step.network || venue.protocol !== step.protocol) return null;
  return venue as VenueOfKind<K>;
}

/* ------------------------------------------------------------------ reads */

export async function withTimeout<T>(promise: Promise<T>, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PlatformError("RPC_TIMEOUT", "An EVM RPC read timed out. Try again shortly.", 504)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** Fails closed when an on-chain read disagrees with the registry pin. */
export function assertPinned(actual: string, pinned: string, what: string, venue: EvmLendingVenue): void {
  if (!sameAddress(actual, pinned)) {
    throw new PlatformError(
      "VENUE_UNVERIFIED",
      `${venue.name} on ${CHAINS[venue.network].name} reports ${what} ${String(actual).slice(0, 42)}, not the pinned ${pinned}. Kletia will not use it.`,
      422,
    );
  }
}

const symbolCache = new Map<string, string>();

/** On-chain ERC-20 symbol (sanitised, cached), or `fallback` when unreadable. */
export async function tokenSymbol(network: EvmNetworkKey, address: string, fallback: string): Promise<string> {
  const key = `${network}:${address.toLowerCase()}`;
  const cached = symbolCache.get(key);
  if (cached) return cached;
  const symbol = await withTimeout(evmClient(network).readContract({ address: getAddress(address), abi: erc20Abi, functionName: "symbol" }))
    .then((value) => String(value).replace(/[^\w$.-]/gu, "").slice(0, 16))
    .catch(() => "");
  if (!symbol) return fallback;
  symbolCache.set(key, symbol);
  return symbol;
}

/** A receipt / share token as an asset (never in ASSETS: receipt symbols are ambiguous). */
export function receiptAsset(network: EvmNetworkKey, receipt: ReceiptToken, symbol: string, name: string): ResolvedAsset {
  const address = getAddress(receipt.address);
  return {
    network,
    id: formatAssetId(network, "erc20", address),
    symbol,
    name,
    decimals: receipt.decimals,
    address,
    isNative: false,
    canonical: false,
    verified: true,
  };
}

export function formatUnits(units: bigint | string, decimals: number, symbol: string): string {
  return `${formatAmount(fromBaseUnits(units, decimals))} ${symbol}`;
}

/** `value` reduced by `bps` basis points, rounded down. */
export function lessBps(value: bigint, bps: bigint): bigint {
  return (value * (10_000n - bps)) / 10_000n;
}

export function lessRounding(value: bigint): bigint {
  return value > ROUNDING_WEI ? value - ROUNDING_WEI : 0n;
}

/* ------------------------------------------------------------ simulation */

export type Simulation =
  | { readonly status: "ok"; readonly data: Hex }
  | { readonly status: "reverted"; readonly reason: string }
  | { readonly status: "unavailable" };

function revertData(error: BaseError): Hex | undefined {
  const deepest = error.walk() as { data?: unknown };
  const data = typeof deepest.data === "object" && deepest.data !== null ? (deepest.data as { data?: unknown }).data : deepest.data;
  return typeof data === "string" && /^0x[0-9a-fA-F]*$/u.test(data) ? (data as Hex) : undefined;
}

function isRevert(error: unknown): error is BaseError {
  if (!(error instanceof BaseError)) return false;
  const found = error.walk((cause) => {
    const code = (cause as { code?: unknown }).code;
    const text = `${(cause as BaseError).shortMessage ?? ""} ${(cause as BaseError).details ?? ""}`;
    return code === 3 || /revert/iu.test(text);
  });
  return found !== null && found !== undefined;
}

/**
 * eth_call of a prepared transaction from the step account. A revert is
 * reported with its decoded custom error when `abi` knows it; an RPC that
 * cannot answer is "unavailable" (callers decide whether that blocks).
 * Uses a raw eth_call so no CCIP-Read lookup can be triggered.
 */
export async function simulate(
  network: EvmNetworkKey,
  request: { readonly from: string; readonly to: string; readonly data: string; readonly value?: string },
  abi?: Abi,
): Promise<Simulation> {
  try {
    const data = await withTimeout(evmClient(network).request({
      method: "eth_call",
      params: [{ from: getAddress(request.from), to: getAddress(request.to), data: request.data as Hex, value: toHex(BigInt(request.value ?? "0")) }, "latest"],
    }));
    return { status: "ok", data: (typeof data === "string" ? data : "0x") as Hex };
  } catch (error) {
    if (!isRevert(error)) return { status: "unavailable" };
    const raw = revertData(error);
    let reason = error.shortMessage.split("\n")[0]?.slice(0, 160) ?? "Execution reverted.";
    if (raw && raw.length >= 10 && abi) {
      try {
        reason = `${decodeErrorResult({ abi, data: raw }).errorName} (${reason})`;
      } catch {
        // Unknown selector: keep the node's message.
      }
    }
    return { status: "reverted", reason };
  }
}

/** Refuses a plan / prepare whose venue call reverts in simulation. */
export function assertSimulation(simulation: Simulation, what: string): void {
  if (simulation.status === "reverted") {
    throw new PlatformError("SIMULATION_FAILED", `The ${what} would revert on-chain: ${simulation.reason}`, 422);
  }
}

export const SIMULATION_UNAVAILABLE = "Simulation was unavailable; the transaction was not dry-run before signing.";

/* ---------------------------------------------------------- transactions */

export function evmCall(
  context: Pick<LendingContext<EvmLendingVenue>, "network" | "chainId" | "owner">,
  to: string,
  data: Hex,
  value: bigint,
  gas: bigint | string,
  description: string,
): EvmTransactionRequest {
  return {
    vm: "evm",
    network: context.network,
    chainId: context.chainId,
    from: context.owner,
    to: getAddress(to),
    data,
    value: value.toString(),
    gas: gas.toString(),
    description,
  };
}

/** Exact-amount ERC-20 approval of `spender`, or null when the allowance already covers `amount`. */
export async function exactApproval(
  context: LendingContext<EvmLendingVenue>,
  spender: string,
  amount: bigint,
  allowance?: bigint,
): Promise<EvmTransactionRequest | null> {
  const current = allowance ?? (await readAllowance(context.network, context.token, context.owner, spender));
  if (current >= amount) return null;
  return evmCall(
    context,
    context.token,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), amount] }),
    0n,
    APPROVE_GAS,
    `Approve ${formatUnits(amount, context.underlying.decimals, context.underlying.symbol)} for ${context.venue.name}`,
  );
}

/** Allowance the plan assumes (0 when unreadable, which only adds an approval to the estimate). */
export async function plannedAllowance(context: LendingContext<EvmLendingVenue>, spender: string): Promise<bigint> {
  return readAllowance(context.network, context.token, context.owner, spender).catch(() => 0n);
}

/** Wraps native ETH into the venue's WETH (pinned in ASSETS) before a deposit. */
export function wrapTransaction(context: LendingContext<EvmLendingVenue>, amount: bigint): EvmTransactionRequest {
  return evmCall(
    context,
    context.token,
    encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }),
    amount,
    WRAP_GAS,
    `Wrap ${formatUnits(amount, 18, "ETH")} into ${context.underlying.symbol}`,
  );
}

/** Unwraps WETH into native ETH after a withdraw. */
export function unwrapTransaction(context: LendingContext<EvmLendingVenue>, amount: bigint): EvmTransactionRequest {
  return evmCall(
    context,
    context.token,
    encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [amount] }),
    0n,
    UNWRAP_GAS,
    `Unwrap ${formatUnits(amount, 18, context.underlying.symbol)} into ETH`,
  );
}

export function payloadRecords(network: NetworkKey, transactions: readonly EvmTransactionRequest[]): PreparedPayload["records"] {
  return transactions.map((transaction) => ({ vm: "evm" as const, network, to: transaction.to, description: transaction.description }));
}

/** Gas for a simulated call (estimate + 20%), else the fallback. */
export async function callGas(
  network: EvmNetworkKey,
  request: { readonly from: string; readonly to: string; readonly data: string; readonly value?: string },
  fallback: bigint,
): Promise<string> {
  return (await estimateGas(network, { ...request, value: request.value ?? "0" })) ?? fallback.toString();
}

/* ---------------------------------------------------------- verification */

/** The last landed receipt whose target is `to` (the venue call of the step). */
export function landedCall(receipts: readonly LandedEvmReceipt[], to: string): LandedEvmReceipt | null {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index] as LandedEvmReceipt;
    if (sameAddress(receipt.to, to)) return receipt;
  }
  return null;
}

/** Sum of ERC-20 `Transfer(from -> to)` amounts emitted by `token` across receipts. */
export function transferred(receipts: readonly LandedEvmReceipt[], token: string, from: string, to: string): bigint {
  return evmEvents(receipts, { address: token, abi: erc20Abi, eventName: "Transfer" })
    .filter((event) => sameAddress(event.args.from, from) && sameAddress(event.args.to, to))
    .reduce((total, event) => total + event.args.value, 0n);
}

/** WETH credited to `account` by wrapping (WETH9 Deposit or an aeWETH mint). */
export function wrappedCredit(receipts: readonly LandedEvmReceipt[], weth: string, account: string): bigint {
  const deposits = evmEvents(receipts, { address: weth, abi: WETH_ABI, eventName: "Deposit" })
    .filter((event) => sameAddress(event.args.dst, account))
    .reduce((total, event) => total + event.args.wad, 0n);
  return deposits + transferred(receipts, weth, zeroAddress, account);
}

/** WETH burned from `account` by unwrapping (WETH9 Withdrawal or an aeWETH burn). */
export function unwrappedDebit(receipts: readonly LandedEvmReceipt[], weth: string, account: string): bigint {
  const withdrawals = evmEvents(receipts, { address: weth, abi: WETH_ABI, eventName: "Withdrawal" })
    .filter((event) => sameAddress(event.args.src, account))
    .reduce((total, event) => total + event.args.wad, 0n);
  return withdrawals + transferred(receipts, weth, account, zeroAddress);
}

/**
 * Proves the native legs of a step around its venue call: every wrap
 * (`deposit()`) credited exactly its value to the account, every unwrap
 * (`withdraw(wad)`) burned exactly `wad` from it. Approvals to the same WETH
 * contract are skipped. Returns a failure message, or null when proven.
 */
export function nativeLegFailure(receipts: readonly LandedEvmReceipt[], weth: string, account: string): string | null {
  for (const receipt of receipts.filter((entry) => sameAddress(entry.to, weth))) {
    let call;
    try {
      call = decodeFunctionData({ abi: WETH_ABI, data: receipt.input as Hex });
    } catch {
      continue;
    }
    if (call.functionName === "deposit" && (receipt.value <= 0n || wrappedCredit([receipt], weth, account) !== receipt.value)) {
      return "The wrap transaction did not credit the wrapped ETH to the account.";
    }
    if (call.functionName === "withdraw" && unwrappedDebit([receipt], weth, account) !== call.args[0]) {
      return "The unwrap transaction did not burn the prepared WETH amount from the account.";
    }
  }
  return null;
}

/**
 * The lowest output guarantee of any payload prepared for the step (the
 * current minimum and every recorded prepare floor): a payload that lands
 * after a re-prepare is held to the weakest guarantee it could carry.
 */
export function lowestFloor(step: IntentStep): bigint | null {
  const values = [step.minimumOutput?.amount, ...(decodeStepRef(step.quoteRef)?.floors ?? []).map((floor) => floor.min)]
    .filter((value): value is string => isBaseUnitAmount(value))
    .map((value) => BigInt(value));
  return values.length > 0 ? values.reduce((low, value) => (value < low ? value : low)) : null;
}

export function eventEvidence(step: IntentStep, receipt: LandedEvmReceipt | null, observedAt: string, detail: string): StepEvidence {
  return {
    kind: "receipt",
    network: step.network,
    ...(receipt ? { reference: receipt.reference } : {}),
    observedAt,
    detail,
  };
}

export function outcomeFailure(code: string, message: string): { failure: { code: string; message: string } } {
  return { failure: { code, message } };
}

/** An observed amount of a recorded asset (actualOutput). */
export function observed(asset: Pick<AssetAmount, "asset" | "symbol" | "decimals">, units: bigint): AssetAmount {
  return { asset: asset.asset, symbol: asset.symbol, decimals: asset.decimals, amount: units.toString(), formatted: fromBaseUnits(units, asset.decimals) };
}

/* ------------------------------------------------------------- metrics */

/** Live rate and size of a venue, read on-chain (advisory; never used to authorise a transaction). */
export interface LendingMetrics {
  readonly venue: string;
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly name: string;
  readonly asset: string;
  /** Variable supply APY as a fraction (0.045 = 4.5%), compounded per second; null when unreadable. */
  readonly supplyApy: number | null;
  /** `rate`: the venue's current supply rate; `share-price`: realised share-price growth over `apyWindowSeconds`. */
  readonly apySource: "rate" | "share-price" | "unavailable";
  readonly apyWindowSeconds?: number;
  /** Underlying supplied to the venue (TVL). */
  readonly totalSupplied: AssetAmount | null;
  /** Underlying that can leave the venue now (withdraw liquidity); null when the venue does not expose it. */
  readonly exitLiquidity: AssetAmount | null;
  /** Borrowed share of the supplied underlying (0..1); null when not applicable. */
  readonly utilization: number | null;
  readonly observedAt: string;
  readonly warnings: readonly string[];
}

/** APY from a per-second rate: (1 + r)^year - 1. */
export function apyFromPerSecond(rate: number): number | null {
  if (!Number.isFinite(rate) || rate < 0) return null;
  const apy = Math.expm1(SECONDS_PER_YEAR * Math.log1p(rate));
  return Number.isFinite(apy) ? Math.round(apy * 1e8) / 1e8 : null;
}

/** APY from a fixed-point per-second rate (`scale` = 1e18 for Comet / Moonwell). */
export function apyFromScaledRate(rate: bigint, scale: bigint): number | null {
  return apyFromPerSecond(Number(rate) / Number(scale));
}

export function underlyingAmount(context: { readonly underlying: AssetDescriptor }, units: bigint): AssetAmount {
  const { underlying } = context;
  return { asset: underlying.id, symbol: underlying.symbol, decimals: underlying.decimals, amount: units.toString(), formatted: fromBaseUnits(units, underlying.decimals) };
}

/** The ratio a/b as a number in [0, 1]; null when b is zero. */
export function ratio(a: bigint, b: bigint): number | null {
  if (b <= 0n) return null;
  return Math.min(1, Math.max(0, Number((a * 1_000_000n) / b) / 1_000_000));
}

/** Plan-time note with the venue's current rate (variable; informational only). */
export function apyNote(metrics: Pick<LendingMetrics, "supplyApy" | "apySource" | "apyWindowSeconds"> | null): string[] {
  if (!metrics || metrics.supplyApy === null) return [];
  const percent = (metrics.supplyApy * 100).toFixed(2);
  const source = metrics.apySource === "share-price"
    ? `realised share-price growth over the last ${Math.round((metrics.apyWindowSeconds ?? 0) / 86_400)} days`
    : "the current on-chain supply rate";
  return [`Variable yield: about ${percent}% APY at planning (${source}); not guaranteed.`];
}

/** Metrics read with a short budget for planning: a slow or failed read yields null, never an error. */
export async function bestEffort<T>(read: () => Promise<T>, timeoutMs = 4_000): Promise<T | null> {
  try {
    return await withTimeout(read(), timeoutMs);
  } catch {
    return null;
  }
}

export function zeroIfMissing(value: unknown): bigint {
  return typeof value === "bigint" ? value : 0n;
}

