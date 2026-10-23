/**
 * ERC-4626 vault families: one deposit / withdraw / redeem engine with a
 * `VaultFamily` per protocol (provenance, encoders, exit liquidity, APY).
 * Morpho vaults (MetaMorpho v1.0 / v1.1 and Vault V2) are defined here;
 * Spark Savings, Fluid fTokens and Yearn V3 vaults live in their own
 * modules (sparkSavings.ts, fluid.ts, yearn.ts). A vault is never resolved
 * by name or symbol: the planner hands over a registry id bound to
 * (network, address), and each family accepts only its own venue kind.
 *
 * Before every plan and prepare the vault must prove itself on-chain through
 * its family's `verify` (Morpho: the pinned factory confirms it, `asset()` is
 * the pinned underlying, `decimals()` the pinned share decimals; Vault V2
 * gates must be unset for deposits). Deposit limits and exit liquidity are
 * the family's: MetaMorpho v1 `maxDeposit` / `maxWithdraw` cover the amount;
 * Vault V2 returns 0 from every `max*` function, so it is simulated instead.
 *
 * Plain ERC-4626 `deposit` has no on-chain minimum-shares argument: the plan
 * guarantees `previewDeposit` less SHARE_TOLERANCE_BPS and verification holds
 * the Deposit event to it (families with floor-carrying overloads, like
 * Fluid, also pass it on-chain). "Withdraw all" redeems the share balance
 * read at prepare (`redeem(balanceOf)`; `maxRedeem` rounds below the balance).
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Abi, type Address, type Hex } from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  fromBaseUnits,
  nativeAssetId,
  type AssetDescriptor,
  type Erc4626Venue,
  type EvmTransactionRequest,
  type FluidFTokenVenue,
  type IntentStep,
  type ParsedAccountId,
  type ProtocolId,
  type SparkVaultVenue,
  type VenueCapacity,
  type VenuePosition,
  type YearnVaultVenue,
  type YieldVenue,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { assetAmount, type ResolvedAsset } from "../../assets.js";
import { estimateEvmFeeUsd, evmClient, type EvmNetworkKey } from "../../chains/evm.js";
import { assertEvmBalance } from "../evmTransfer.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter } from "../types.js";
import { evmEvents, stepOwner, verifyEvmReceipts, type EvmOutcome, type LandedEvmReceipt } from "../verification.js";
import {
  APPROVE_GAS,
  apyNote,
  assertPinned,
  assertSimulation,
  bestEffort,
  callGas,
  CAPACITY_PROBE,
  eventEvidence,
  evmCall,
  exactApprovals,
  formatUnits,
  landedCall,
  lendingContext,
  lessBps,
  lowestFloor,
  nativeLegFailure,
  observed,
  outcomeFailure,
  payloadRecords,
  plannedAllowance,
  rate18,
  receiptAmount,
  receiptAsset,
  received,
  sameAddress,
  SECONDS_PER_YEAR,
  SHARE_TOLERANCE_BPS,
  simulate,
  simulatedUint,
  SIMULATION_UNAVAILABLE,
  smaller,
  stepVenue,
  supportsLending,
  tokenSymbol,
  transferred,
  UNCAPPED,
  underlyingAmount,
  unwrappedWeth,
  unwrapTransaction,
  UNWRAP_GAS,
  withTimeout,
  WRAP_GAS,
  wrapTransaction,
  SMOOTHED_APY_WINDOW_SECONDS,
  tvlUsdOf,
  type LendingContext,
  type LendingMetrics,
  LENDING_PREVIEW_TTL_SECONDS,
} from "./common.js";

export const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets,address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets,address receiver,address owner) returns (uint256 shares)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256 assets)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function receiveSharesGate() view returns (address)",
  "function sendSharesGate() view returns (address)",
  "function receiveAssetsGate() view returns (address)",
  "function sendAssetsGate() view returns (address)",
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "error ERC4626ExceededMaxDeposit(address receiver,uint256 assets,uint256 max)",
  "error ERC4626ExceededMaxWithdraw(address owner,uint256 assets,uint256 max)",
  "error ERC4626ExceededMaxRedeem(address owner,uint256 shares,uint256 max)",
  "error NotEnoughLiquidity()",
  "error AllCapsReached()",
]);
export const FACTORY_ABI = parseAbi([
  "function isMetaMorpho(address target) view returns (bool)",
  "function isVaultV2(address target) view returns (bool)",
]);

const DEPOSIT_GAS = 700_000n;
/** Loss (bps) a full redeem tolerates between prepare and execution. */
export const REDEEM_TOLERANCE_BPS = 1n;
const WITHDRAW_GAS = 900_000n;
/** Window of the realised share-price APY. */
const APY_WINDOW_SECONDS = 7 * 86_400;
/** Nominal block times used to find the block one APY window ago (the elapsed time is then read from the blocks). */
const BLOCK_SECONDS: Readonly<Record<EvmNetworkKey, number>> = {
  base: 2,
  optimism: 2,
  polygon: 2,
  arbitrum: 0.25,
  ethereum: 12,
  arc: 1,
  "arbitrum-sepolia": 0.25,
};

/* ------------------------------------------------------------- families */

export type VaultVenue = Erc4626Venue | SparkVaultVenue | FluidFTokenVenue | YearnVaultVenue;
export type VaultContext<V extends VaultVenue = VaultVenue> = LendingContext<V>;
/** What the read paths (provenance, metrics, positions) know about a vault. */
export interface VaultRef<V extends VaultVenue = VaultVenue> {
  readonly venue: V;
  readonly network: EvmNetworkKey;
  /** The pinned underlying ERC-20. */
  readonly token: Address;
  readonly underlying: AssetDescriptor;
}

export interface VaultState {
  /** Non-zero access gates (Morpho Vault V2); a gated vault takes no deposits. */
  readonly gates: readonly string[];
  /** The vault takes no deposits (Yearn `isShutdown`); withdrawals still run. */
  readonly shutdown?: boolean;
}

export interface VaultApy {
  readonly apy: number;
  readonly source: "rate" | "share-price";
  readonly window?: number;
}

/** A decoded venue call of a landed step transaction, or the reason it is not one the family encodes. */
export type DecodedVaultCall =
  | { readonly functionName: "deposit"; readonly amount: bigint; readonly receiver: string }
  | { readonly functionName: "withdraw" | "redeem"; readonly amount: bigint; readonly receiver: string; readonly owner: string }
  | { readonly refused: string };

/**
 * One ERC-4626 protocol: how its vaults prove themselves, what they accept,
 * how much can leave them and exactly which calls Kletia encodes for them.
 * Every method reads only the pinned venue; a read that disagrees with the
 * registry throws VENUE_UNVERIFIED (fail closed).
 */
export interface VaultFamily<V extends VaultVenue = VaultVenue> {
  readonly protocol: ProtocolId;
  readonly kind: V["kind"];
  /** Adapter label ("Morpho Vaults"). */
  readonly label: string;
  /** Protocol name in titles ("Morpho"); omitted when the venue name already contains it. */
  readonly shortName: string;
  /** ABI of every venue call the family encodes (simulation errors decode against it). */
  readonly abi: Abi;
  /** Provenance against the registry pins, re-read before every plan, prepare and fact read. */
  verify(ref: VaultRef<V>): Promise<VaultState>;
  /** Refuses a deposit the vault cannot take now (gates, shutdown, caps, minimums). */
  assertDeposit(context: VaultContext<V>, state: VaultState, amount: bigint): Promise<void>;
  /** Underlying `shares` are worth now; never a revert on short liquidity. */
  positionValue(ref: VaultRef<V>, shares: bigint): Promise<bigint>;
  /** Underlying `owner` can take out now, or null when the vault does not report it (the simulation decides). */
  exitLiquidity(ref: VaultRef<V>, owner: Address, state: VaultState): Promise<bigint | null>;
  /** Why exit liquidity is short, for the VENUE_ILLIQUID message. */
  illiquidReason(venue: V): string;
  /** Underlying the vault can still take (null: no cap or unknown). */
  capRemaining(ref: VaultRef<V>, state: VaultState): Promise<bigint | null>;
  /** Underlying that can leave the vault as a whole now (null: not exposed). */
  venueExitLiquidity(ref: VaultRef<V>): Promise<bigint | null>;
  encodeDeposit(context: VaultContext<V>, assets: bigint, minShares: bigint): Promise<Hex>;
  encodeWithdraw(context: VaultContext<V>, assets: bigint): Promise<Hex>;
  encodeRedeem(context: VaultContext<V>, shares: bigint, minAssets: bigint): Promise<Hex>;
  /** Decodes a landed venue call; anything but the family's own encodings is refused. */
  decodeCall(data: Hex): DecodedVaultCall;
  /** Where deposited underlying goes (the vault, or Fluid's Liquidity layer). */
  assetSink(venue: V): string;
  /** Where withdrawn underlying comes from; null when the vault pays out through a third contract it chooses (PSM pockets). */
  assetSource(venue: V): string | null;
  apy(ref: VaultRef<V>): Promise<VaultApy | null>;
}

/* ---------------------------------------------------------- shared reads */

export async function vaultRead<F extends "balanceOf" | "maxDeposit" | "maxWithdraw" | "previewDeposit" | "previewWithdraw" | "previewRedeem" | "convertToAssets">(
  context: Pick<VaultRef, "venue" | "network">,
  functionName: F,
  arg: F extends "balanceOf" | "maxDeposit" | "maxWithdraw" ? `0x${string}` : bigint,
): Promise<bigint> {
  return withTimeout(evmClient(context.network).readContract({
    address: getAddress(context.venue.target),
    abi: VAULT_ABI,
    functionName,
    args: [arg],
  } as never)) as Promise<bigint>;
}

/** `asset()` and `decimals()` against the pins (shared by every family). */
export async function assertVaultAsset(ref: VaultRef): Promise<void> {
  const client = evmClient(ref.network);
  const vault = getAddress(ref.venue.target);
  const [asset, decimals] = await withTimeout(Promise.all([
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "asset" }),
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "decimals" }),
  ]));
  assertPinned(asset, ref.token, "asset()", ref.venue);
  if (decimals !== ref.venue.receipt.decimals) {
    throw new PlatformError("VENUE_UNVERIFIED", `${ref.venue.name} reports ${decimals} share decimals, not ${ref.venue.receipt.decimals}.`, 422);
  }
}

/** Refuses a deposit above the vault's `maxDeposit(account)` (caps, deposit limits). */
export async function assertMaxDeposit(context: VaultContext, amount: bigint, why: string): Promise<void> {
  const cap = await vaultRead(context, "maxDeposit", context.owner);
  if (cap < amount) {
    throw new PlatformError(
      "RESERVE_UNAVAILABLE",
      `${context.venue.name} accepts at most ${formatUnits(cap, context.underlying.decimals, context.underlying.symbol)} more right now (${why}).`,
      422,
    );
  }
}

/** `maxDeposit` of a neutral address as venue-wide headroom (null when uncapped). */
export async function probeCap(ref: VaultRef): Promise<bigint | null> {
  const cap = await vaultRead(ref, "maxDeposit", CAPACITY_PROBE);
  return cap >= UNCAPPED ? null : cap;
}

/**
 * APY realised by the share price over the last week (net of the vault's
 * fees), from historical eth_call reads; null when the RPC cannot serve them
 * or the vault is younger than a day.
 */
export async function realisedApy(venue: VaultVenue): Promise<VaultApy | null> {
  const network = venue.network as EvmNetworkKey;
  const client = evmClient(network);
  const vault = getAddress(venue.target);
  const latest = await withTimeout(client.getBlock({ blockTag: "latest" }));
  const back = BigInt(Math.round(APY_WINDOW_SECONDS / BLOCK_SECONDS[network]));
  if (latest.number === null || latest.number <= back) return null;
  const pastNumber = latest.number - back;
  const unit = 10n ** BigInt(venue.receipt.decimals) * 1_000_000n;
  const [past, now, then] = await withTimeout(Promise.all([
    client.getBlock({ blockNumber: pastNumber }),
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "convertToAssets", args: [unit], blockNumber: latest.number }),
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "convertToAssets", args: [unit], blockNumber: pastNumber }),
  ]));
  const elapsed = Number(latest.timestamp - past.timestamp);
  if (elapsed < 86_400 || then <= 0n || now <= 0n) return null;
  const apy = (Number(now) / Number(then)) ** (SECONDS_PER_YEAR / elapsed) - 1;
  return Number.isFinite(apy) ? { apy: Math.round(apy * 1e8) / 1e8, source: "share-price", window: elapsed } : null;
}

/** Decodes standard three-argument withdraw / redeem and two-argument deposit calls. */
export function decodeStandardCall(abi: Abi, data: Hex): DecodedVaultCall {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi, data });
  } catch {
    return { refused: "The vault call is not one Kletia encodes for this vault." };
  }
  const args = (decoded.args ?? []) as readonly unknown[];
  if (decoded.functionName === "deposit" && args.length === 2) {
    return { functionName: "deposit", amount: args[0] as bigint, receiver: String(args[1]) };
  }
  if ((decoded.functionName === "withdraw" || decoded.functionName === "redeem") && args.length === 3) {
    return { functionName: decoded.functionName, amount: args[0] as bigint, receiver: String(args[1]), owner: String(args[2]) };
  }
  return { refused: "The vault call is not one Kletia encodes for this vault." };
}

/* --------------------------------------------------------------- Morpho */

function isV2(venue: Erc4626Venue): boolean {
  return venue.generation === "vault-v2";
}

/** Morpho: factory provenance, pinned underlying and share decimals, Vault V2 gates. */
export const morphoFamily: VaultFamily<Erc4626Venue> = {
  protocol: "morpho",
  kind: "erc4626",
  label: "Morpho Vaults",
  shortName: "Morpho",
  abi: VAULT_ABI,
  illiquidReason: () => "its markets are borrowed",

  async verify(ref) {
    const { venue, network } = ref;
    const client = evmClient(network);
    const vault = getAddress(venue.target);
    const factory = getAddress(venue.factory);
    const v2 = isV2(venue);
    const gateNames = ["receiveSharesGate", "sendSharesGate", "receiveAssetsGate", "sendAssetsGate"] as const;
    const [confirmed, asset, decimals, ...gates] = await withTimeout(Promise.all([
      v2
        ? client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "isVaultV2", args: [vault] })
        : client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "isMetaMorpho", args: [vault] }),
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: "asset" }),
      client.readContract({ address: vault, abi: VAULT_ABI, functionName: "decimals" }),
      ...(v2 ? gateNames.map((functionName) => client.readContract({ address: vault, abi: VAULT_ABI, functionName })) : []),
    ]));
    if (confirmed !== true) {
      throw new PlatformError(
        "VENUE_UNVERIFIED",
        `${venue.name} on ${CHAINS[network].name} is not confirmed by its pinned Morpho factory ${venue.factory}. Kletia will not use it.`,
        422,
      );
    }
    assertPinned(asset, ref.token, "asset()", venue);
    if (decimals !== venue.receipt.decimals) {
      throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} reports ${decimals} share decimals, not ${venue.receipt.decimals}.`, 422);
    }
    return {
      gates: gates.map((gate, index) => (sameAddress(gate as string, zeroAddress) ? "" : gateNames[index] as string)).filter(Boolean),
    };
  },

  async assertDeposit(context, state, amount) {
    const cap = isV2(context.venue) ? null : await vaultRead(context, "maxDeposit", context.owner);
    if (state.gates.length > 0) {
      throw new PlatformError(
        "VENUE_UNVERIFIED",
        `${context.venue.name} has access gates set (${state.gates.join(", ")}); Kletia only deposits into ungated vaults.`,
        422,
      );
    }
    if (cap !== null && cap < amount) {
      throw new PlatformError(
        "RESERVE_UNAVAILABLE",
        `${context.venue.name} accepts at most ${formatUnits(cap, context.underlying.decimals, context.underlying.symbol)} more right now (its market caps are reached).`,
        422,
      );
    }
  },

  positionValue(ref, shares) {
    return vaultRead(ref, "previewRedeem", shares);
  },

  async exitLiquidity(ref, owner) {
    return isV2(ref.venue) ? null : vaultRead(ref, "maxWithdraw", owner);
  },

  async capRemaining(ref) {
    return isV2(ref.venue) ? null : probeCap(ref);
  },

  async venueExitLiquidity() {
    return null;
  },

  async encodeDeposit(context, assets) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [assets, context.owner] });
  },

  async encodeWithdraw(context, assets) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [assets, context.owner, context.owner] });
  },

  async encodeRedeem(context, shares) {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [shares, context.owner, context.owner] });
  },

  decodeCall(data) {
    return decodeStandardCall(VAULT_ABI, data);
  },

  assetSink(venue) {
    return venue.target;
  },

  assetSource(venue) {
    return venue.target;
  },

  apy(ref) {
    return realisedApy(ref.venue);
  },
};

/* --------------------------------------------------------------- engine */

function title(family: VaultFamily, context: VaultContext, amount: bigint, symbol: string, close: boolean): string {
  const what = close ? `all ${symbol}` : `${formatAmount(fromBaseUnits(amount, context.underlying.decimals))} ${symbol}`;
  const named = context.venue.name.toLowerCase().includes(family.shortName.toLowerCase());
  const where = `${context.venue.name}${named ? "" : ` (${family.shortName})`} on ${CHAINS[context.network].name}`;
  return context.kind === "deposit" ? `Deposit ${what} into ${where}` : `Withdraw ${what} from ${where}`;
}

interface Quote {
  readonly transactions: EvmTransactionRequest[];
  readonly input: bigint;
  readonly expected: bigint;
  readonly minimum: bigint;
  readonly output: ResolvedAsset;
  readonly gas: bigint;
  readonly warnings: string[];
}

function apyWarnings(apy: VaultApy | null): string[] {
  return apyNote(apy ? { supplyApy: apy.apy, apySource: apy.source, ...(apy.window !== undefined ? { apyWindowSeconds: apy.window } : {}) } : null);
}

async function depositQuote<V extends VaultVenue>(family: VaultFamily<V>, action: AdapterAction, context: VaultContext<V>, stage: "plan" | "prepare"): Promise<Quote> {
  const { venue, network, owner, token } = context;
  const amount = BigInt(action.amount);
  if (amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to deposit.", 422);
  if (stage === "prepare") {
    await assertEvmBalance(network, owner, context.native ? null : token, amount, action.input.symbol, action.input.decimals);
  }
  const [state, shares, apy] = await Promise.all([
    family.verify(context),
    vaultRead(context, "previewDeposit", amount),
    stage === "plan" ? bestEffort(() => family.apy(context)) : Promise.resolve(null),
  ]);
  await family.assertDeposit(context, state, amount);
  if (shares <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${formatUnits(amount, context.underlying.decimals, context.underlying.symbol)} buys no shares of ${venue.name}.`, 422);
  // Hold the shares to the preview less the share-price tolerance (on-chain where the family's deposit takes a minimum).
  const minimum = lessBps(shares, SHARE_TOLERANCE_BPS);
  const vault = getAddress(venue.spender);
  const allowance = stage === "plan" ? await plannedAllowance(context, vault) : undefined;
  const transactions: EvmTransactionRequest[] = [];
  if (context.native) transactions.push(wrapTransaction(context, amount));
  const approvals = await exactApprovals(context, vault, amount, allowance);
  transactions.push(...approvals);
  const data = await family.encodeDeposit(context, amount, minimum);
  const warnings: string[] = [];
  let gas: bigint | string = DEPOSIT_GAS;
  if (stage === "prepare" && transactions.length === 0) {
    const request = { from: owner, to: venue.target, data };
    const simulation = await simulate(network, request, family.abi);
    assertSimulation(simulation, `deposit into ${venue.name}`);
    if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
    const minted = simulatedUint(simulation);
    if (minted !== null && minted < minimum) {
      throw new PlatformError("SIMULATION_FAILED", `${venue.name} would mint fewer shares than previewed; try again shortly.`, 422);
    }
    gas = await callGas(network, request, DEPOSIT_GAS);
  }
  transactions.push(evmCall(context, venue.target, data, 0n, gas, title(family, context, amount, context.underlying.symbol, false)));
  const symbol = await tokenSymbol(network, venue.receipt.address, `${venue.slug}-shares`);
  return {
    transactions,
    input: amount,
    expected: shares,
    minimum,
    output: receiptAsset(network, venue.receipt, symbol, venue.name),
    gas: DEPOSIT_GAS + APPROVE_GAS * BigInt(approvals.length) + (context.native ? WRAP_GAS : 0n),
    warnings: [...warnings, ...apyWarnings(apy)],
  };
}

async function withdrawQuote<V extends VaultVenue>(family: VaultFamily<V>, action: AdapterAction, context: VaultContext<V>): Promise<Quote> {
  const { venue, network, owner } = context;
  const [state, shares] = await Promise.all([family.verify(context), vaultRead(context, "balanceOf", owner)]);
  const symbol = context.underlying.symbol;
  if (shares === 0n) {
    throw new PlatformError("POSITION_EMPTY", `The account holds no ${venue.name} shares on ${CHAINS[network].name}.`, 422);
  }
  const position = await family.positionValue(context, shares);
  const requested = action.closePosition ? position : BigInt(action.amount);
  if (requested <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to withdraw.", 422);
  if (requested > position) {
    throw new PlatformError(
      "INSUFFICIENT_BALANCE",
      `The account's ${venue.name} shares redeem for ${formatUnits(position, context.underlying.decimals, symbol)}; ${formatUnits(requested, context.underlying.decimals, symbol)} was requested.`,
      422,
    );
  }
  // The whole position leaves by redeeming every share (an exact full-balance withdraw can round past it).
  const close = action.closePosition === true || requested === position;
  // Redeeming a fixed share count pays at least the preview (the share price only grows) unless the
  // vault realises a loss before execution: hold it to one basis point below the preview.
  const minimum = close ? lessBps(position, REDEEM_TOLERANCE_BPS) : requested;
  const available = await family.exitLiquidity(context, owner, state);
  if (available !== null && available < minimum) {
    throw new PlatformError(
      "VENUE_ILLIQUID",
      `${venue.name} can pay out ${formatUnits(available, context.underlying.decimals, symbol)} to this account right now (${family.illiquidReason(venue)}); ${formatUnits(requested, context.underlying.decimals, symbol)} cannot be withdrawn yet.`,
      422,
    );
  }
  const data = close ? await family.encodeRedeem(context, shares, minimum) : await family.encodeWithdraw(context, requested);
  const request = { from: owner, to: venue.target, data };
  const simulation = await simulate(network, request, family.abi);
  assertSimulation(simulation, `withdrawal from ${venue.name}`);
  const paid = simulatedUint(simulation);
  if (close && paid !== null && paid < minimum) {
    throw new PlatformError("SIMULATION_FAILED", `${venue.name} would pay less than previewed for the shares; try again shortly.`, 422);
  }
  const warnings = simulation.status === "unavailable" ? [SIMULATION_UNAVAILABLE] : [];
  if (state.gates.length > 0) warnings.push(`${venue.name} has access gates set (${state.gates.join(", ")}); the withdrawal was simulated against them.`);
  const gas = simulation.status === "ok" ? await callGas(network, request, WITHDRAW_GAS) : WITHDRAW_GAS.toString();
  const transactions = [evmCall(context, venue.target, data, 0n, gas, title(family, context, requested, symbol, action.closePosition === true))];
  if (context.native) {
    transactions.push(unwrapTransaction(context, minimum));
    if (close) warnings.push("Anything above the guaranteed amount stays in the account as WETH.");
  }
  return {
    transactions,
    input: requested,
    expected: requested,
    minimum,
    output: action.input,
    gas: WITHDRAW_GAS + (context.native ? UNWRAP_GAS : 0n),
    warnings,
  };
}

async function quote<V extends VaultVenue>(family: VaultFamily<V>, action: AdapterAction, stage: "plan" | "prepare"): Promise<{ context: VaultContext<V>; quote: Quote }> {
  const context = lendingContext(action, family.kind, family.protocol) as unknown as VaultContext<V>;
  const result = context.kind === "deposit" ? await depositQuote(family, action, context, stage) : await withdrawQuote(family, action, context);
  return { context, quote: result };
}

/* ------------------------------------------------------------ verification */

function proveDeposit<V extends VaultVenue>(family: VaultFamily<V>, step: IntentStep, venue: V, asset: string, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the vault." });
  const decoded = family.decodeCall(call.input as Hex);
  if ("refused" in decoded) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: decoded.refused });
  if (decoded.functionName !== "deposit" || !sameAddress(decoded.receiver, account)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault call is not a deposit for the step account." });
  }
  const assets = decoded.amount;
  const event = evmEvents([call], { address: venue.target, abi: VAULT_ABI, eventName: "Deposit" }).find((entry) =>
    sameAddress(entry.args.sender, account) && sameAddress(entry.args.owner, account) && entry.args.assets === assets);
  if (!event) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault emitted no Deposit event for the prepared amount and account." });
  const shares = event.args.shares;
  const floor = lowestFloor(step) ?? 1n;
  if (shares < floor) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The vault minted ${shares} shares; the plan guaranteed at least ${floor}.` });
  }
  if (transferred([call], venue.target, zeroAddress, account) !== shares) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault's share mint to the account does not match its Deposit event." });
  }
  if (transferred([call], asset, account, family.assetSink(venue)) !== assets) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The deposited tokens did not move from the account to the vault." });
  }
  const nativeLeg = nativeLegFailure(receipts, asset, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const receipt = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  return {
    actualOutput: observed(receipt, shares),
    evidence: [eventEvidence(step, call, observedAt, `Vault Deposit: ${formatUnits(assets, step.input?.decimals ?? 0, step.input?.symbol ?? "")} for ${formatUnits(shares, receipt.decimals, receipt.symbol)}.`)],
  };
}

function proveWithdraw<V extends VaultVenue>(family: VaultFamily<V>, step: IntentStep, venue: V, asset: string, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the vault." });
  const decoded = family.decodeCall(call.input as Hex);
  if ("refused" in decoded) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: decoded.refused });
  if (decoded.functionName === "deposit" || !sameAddress(decoded.receiver, account) || !sameAddress(decoded.owner, account)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault call is not a withdrawal of the step account's shares to itself." });
  }
  const event = evmEvents([call], { address: venue.target, abi: VAULT_ABI, eventName: "Withdraw" }).find((entry) =>
    sameAddress(entry.args.sender, account) && sameAddress(entry.args.receiver, account) && sameAddress(entry.args.owner, account));
  if (!event) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault emitted no Withdraw event for the step account." });
  const { assets, shares } = event.args;
  if (decoded.functionName === "withdraw" && assets !== decoded.amount) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The vault paid ${assets} base units; ${decoded.amount} were requested.` });
  }
  if (decoded.functionName === "redeem") {
    const floor = lowestFloor(step) ?? 1n;
    if (shares !== decoded.amount || assets < floor) {
      return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The vault redeemed ${shares} shares for ${assets} base units; the plan required ${decoded.amount} shares for at least ${floor}.` });
    }
  }
  if (transferred([call], venue.target, account, zeroAddress) !== shares) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault's share burn does not match its Withdraw event." });
  }
  const source = family.assetSource(venue);
  const paidOut = source === null ? received([call], asset, account) : transferred([call], asset, source, account);
  if (paidOut !== assets) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The withdrawn tokens did not move from the vault to the account." });
  }
  const nativeLeg = nativeLegFailure(receipts, asset, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const output = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  // A native ETH output is what the step's own unwrap transaction released.
  const receivedOutput = output.asset === nativeAssetId(step.network) ? unwrappedWeth(receipts, asset) : assets;
  if (receivedOutput === null) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The ETH withdrawal landed without its unwrap transaction." });
  return {
    actualOutput: observed(output, receivedOutput),
    evidence: [eventEvidence(step, call, observedAt, `Vault Withdraw: ${formatUnits(shares, venue.receipt.decimals, "shares")} burned for ${formatUnits(assets, output.decimals, output.symbol)}.`)],
  };
}

/* ----------------------------------------------------------- read paths */

export function vaultRef<V extends VaultVenue>(venue: V): VaultRef<V> {
  const network = venue.network as EvmNetworkKey;
  const underlying = findAssetBySymbol(network, venue.asset);
  if (!underlying?.address) throw new PlatformError("VENUE_INVALID", `${venue.name} has no pinned underlying.`, 500);
  return { venue, network, token: getAddress(underlying.address), underlying };
}

/** Underlying per whole share as an 18-decimal fixed-point string. */
async function shareRate<V extends VaultVenue>(family: VaultFamily<V>, ref: VaultRef<V>): Promise<string> {
  return rate18(await vaultRead(ref, "convertToAssets", 10n ** BigInt(ref.venue.receipt.decimals)), ref.underlying.decimals);
}

/** APY, total assets (TVL), exit liquidity and provenance warnings of a curated vault. */
export async function vaultMetrics<V extends VaultVenue>(family: VaultFamily<V>, venue: V): Promise<LendingMetrics> {
  const context = vaultRef(venue);
  const [state, total, apy, exit] = await Promise.all([
    family.verify(context),
    withTimeout(evmClient(context.network).readContract({ address: getAddress(venue.target), abi: VAULT_ABI, functionName: "totalAssets" })),
    bestEffort(() => family.apy(context), 8_000),
    bestEffort(() => family.venueExitLiquidity(context)),
  ]);
  // Seam S8: the share price's growth over the last week; a family whose rate already is that is not read twice.
  const smoothed = apy?.source === "share-price" && (apy.window ?? 0) >= SMOOTHED_APY_WINDOW_SECONDS - 86_400
    ? { apy: apy.apy, window: apy.window as number }
    : await bestEffort(() => realisedApy(venue), 8_000).then((value) => (value ? { apy: value.apy, window: value.window ?? 0 } : null));
  const totalSupplied = underlyingAmount(context, total);
  return {
    venue: venue.id,
    protocol: venue.protocol,
    network: context.network,
    name: venue.name,
    asset: venue.asset,
    supplyApy: apy?.apy ?? null,
    apySource: apy ? apy.source : "unavailable",
    apyWindowSeconds: apy?.source === "share-price" && apy.window !== undefined ? apy.window : smoothed?.window ?? null,
    smoothedApy: smoothed?.apy ?? null,
    tvlUsd: await tvlUsdOf(totalSupplied),
    totalSupplied,
    exitLiquidity: exit === null ? null : underlyingAmount(context, exit),
    utilization: null,
    observedAt: new Date().toISOString(),
    warnings: [
      ...(state.gates.length > 0 ? [`Access gates set: ${state.gates.join(", ")}.`] : []),
      ...(state.shutdown ? ["The vault is shut down: withdrawals only, no new deposits."] : []),
    ],
  };
}

/** Realised APY, total assets (TVL) and provenance warnings of a curated Morpho vault. */
export function morphoMetrics(venue: Erc4626Venue): Promise<LendingMetrics> {
  return vaultMetrics(morphoFamily, venue);
}

function familyVenue<V extends VaultVenue>(family: VaultFamily<V>, venue: YieldVenue): V {
  if (venue.kind !== family.kind || venue.protocol !== family.protocol) {
    throw new PlatformError("VENUE_INVALID", `${venue.name} is not one of the ${family.label} venues.`, 500);
  }
  return venue as V;
}

/** The owner's shares, what they are worth and what can leave now (journey facts). */
async function vaultPosition<V extends VaultVenue>(family: VaultFamily<V>, venue: V, owner: ParsedAccountId): Promise<VenuePosition | null> {
  const ref = vaultRef(venue);
  const account = getAddress(owner.address);
  const [state, shares] = await Promise.all([family.verify(ref), vaultRead(ref, "balanceOf", account)]);
  if (shares === 0n) return null;
  const [value, rate, liquidity, apy, symbol] = await Promise.all([
    family.positionValue(ref, shares),
    shareRate(family, ref),
    family.exitLiquidity(ref, account, state),
    bestEffort(() => family.apy(ref)),
    tokenSymbol(ref.network, venue.receipt.address, `${venue.slug}-shares`),
  ]);
  return {
    venue: venue.id,
    network: ref.network,
    protocol: family.protocol,
    name: venue.name,
    receipt: receiptAmount(ref.network, venue.receipt, symbol, shares),
    underlying: underlyingAmount(ref, value),
    rate,
    usd: null,
    apy: apy?.apy ?? null,
    withdrawableNow: liquidity === null ? null : underlyingAmount(ref, smaller(value, liquidity)),
    observedAt: new Date().toISOString(),
  };
}

/** Deposit headroom, exit liquidity, shutdown and the share rate of a vault. */
async function vaultCapacity<V extends VaultVenue>(family: VaultFamily<V>, venue: V): Promise<VenueCapacity> {
  const ref = vaultRef(venue);
  const state = await family.verify(ref);
  const [cap, exit, rate] = await Promise.all([
    state.shutdown ? Promise.resolve(0n) : family.capRemaining(ref, state),
    family.venueExitLiquidity(ref),
    shareRate(family, ref),
  ]);
  return {
    venue: venue.id,
    capRemaining: cap === null ? null : cap.toString(),
    exitLiquidity: exit === null ? null : exit.toString(),
    paused: state.shutdown === true || state.gates.length > 0,
    frozen: false,
    shareRate: rate,
    observedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------- adapter */

/** The deposit / withdraw adapter of one vault family. */
export function createVaultAdapter<V extends VaultVenue>(family: VaultFamily<V>): ProtocolAdapter {
  const { protocol, label } = family;
  return {
    id: protocol,
    protocols: [protocol],
    label,

    supports(route) {
      return supportsLending(route, protocol, family.kind, { deposit: true, withdraw: true });
    },

    async plan(action): Promise<PlannedStep> {
      const { context, quote: planned } = await quote(family, action, "plan");
      const fees = await estimateEvmFeeUsd(context.network, planned.gas);
      return {
        protocol,
        title: title(family, context, planned.input, action.input.symbol, action.closePosition === true),
        mode: "wallet",
        input: assetAmount(action.input, planned.input.toString()),
        expectedOutput: assetAmount(planned.output, planned.expected.toString()),
        minimumOutput: assetAmount(planned.output, planned.minimum.toString()),
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        estimatedSeconds: 10 * planned.transactions.length,
        settlement: { kind: "same-network" },
        warnings: planned.warnings,
        transactionCount: planned.transactions.length,
        slippageBps: action.slippageBps,
        // The plan already encodes the payload (no provider involved): the preview simulates it.
        preview: { transactions: planned.transactions, approvalSpender: context.venue.spender, expiresAt: Math.floor(Date.now() / 1000) + LENDING_PREVIEW_TTL_SECONDS },
      };
    },

    async prepare({ action }): Promise<PreparedPayload> {
      const { context, quote: prepared } = await quote(family, action, "prepare");
      const fees = await estimateEvmFeeUsd(context.network, prepared.gas);
      return {
        transactions: prepared.transactions,
        records: payloadRecords(context.network, prepared.transactions),
        input: assetAmount(action.input, prepared.input.toString()),
        expectedOutput: assetAmount(prepared.output, prepared.expected.toString()),
        minimumOutput: assetAmount(prepared.output, prepared.minimum.toString()),
        ...(fees !== undefined ? { feesUsd: fees } : {}),
        warnings: prepared.warnings,
      };
    },

    async verify(context) {
      const venue = stepVenue(context.step, family.kind) as V | null;
      const asset = venue ? findAssetBySymbol(venue.network, venue.asset)?.address : null;
      if (!venue || venue.protocol !== protocol || !asset || !context.step.minimumOutput) {
        return {
          status: "failed",
          evidence: [],
          failure: { code: "STEP_INVALID", message: protocol === "morpho" ? "The step has no Morpho registry vault or output." : `The step has no ${label} registry vault or output.` },
        };
      }
      const observedAt = new Date(context.now).toISOString();
      const { result } = await verifyEvmReceipts(context, (receipts) =>
        context.step.kind === "withdraw"
          ? proveWithdraw(family, context.step, venue, getAddress(asset), receipts, observedAt)
          : proveDeposit(family, context.step, venue, getAddress(asset), receipts, observedAt));
      return result;
    },

    async positionOf(venue, owner) {
      return vaultPosition(family, familyVenue(family, venue), owner);
    },

    async venueCapacity(venue) {
      return vaultCapacity(family, familyVenue(family, venue));
    },
  };
}

export const erc4626Adapter: ProtocolAdapter = createVaultAdapter(morphoFamily);
