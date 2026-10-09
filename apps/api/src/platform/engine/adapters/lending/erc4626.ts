/**
 * Morpho ERC-4626 vaults (MetaMorpho v1.0 / v1.1 and Vault V2): deposit,
 * exact withdraw and full redeem against the curated allowlist in
 * YIELD_VENUES (kind "erc4626"). A vault is never resolved by name or
 * symbol: the planner hands over a registry id bound to (network, address).
 *
 * Before every plan and prepare the vault must prove itself on-chain:
 * - its pinned factory confirms it (`isMetaMorpho` / `isVaultV2`);
 * - `asset()` is the pinned underlying and `decimals()` the pinned share
 *   decimals;
 * - Vault V2: every gate (receive/send shares, receive/send assets) is unset
 *   for deposits (a gated vault may refuse or trap a depositor);
 * - MetaMorpho v1: `maxDeposit` / `maxWithdraw` cover the amount. Vault V2
 *   returns 0 from every `max*` function, so it is simulated instead.
 *
 * ERC-4626 `deposit` has no on-chain minimum-shares argument: the plan
 * guarantees `previewDeposit` less SHARE_TOLERANCE_BPS and verification holds
 * the Deposit event to it. "Withdraw all" redeems the share balance read at
 * prepare (`redeem(balanceOf)`; `maxRedeem` rounds below the balance).
 */
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Hex } from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  fromBaseUnits,
  nativeAssetId,
  type Erc4626Venue,
  type EvmTransactionRequest,
  type IntentStep,
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
  eventEvidence,
  evmCall,
  exactApproval,
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
  receiptAsset,
  sameAddress,
  SECONDS_PER_YEAR,
  SHARE_TOLERANCE_BPS,
  simulate,
  simulatedUint,
  SIMULATION_UNAVAILABLE,
  stepVenue,
  supportsLending,
  tokenSymbol,
  transferred,
  underlyingAmount,
  unwrappedWeth,
  unwrapTransaction,
  UNWRAP_GAS,
  withTimeout,
  WRAP_GAS,
  wrapTransaction,
  type LendingContext,
  type LendingMetrics,
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
const REDEEM_TOLERANCE_BPS = 1n;
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

type VaultContext = LendingContext<Erc4626Venue>;

interface VaultState {
  /** Non-zero Vault V2 gates (empty for MetaMorpho and ungated V2 vaults). */
  readonly gates: readonly string[];
}

function isV2(venue: Erc4626Venue): boolean {
  return venue.generation === "vault-v2";
}

/** Proves the vault against the registry: factory provenance, underlying, share decimals, V2 gates. */
async function readVault(context: Pick<VaultContext, "venue" | "network" | "token">): Promise<VaultState> {
  const { venue, network } = context;
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
  assertPinned(asset, context.token, "asset()", venue);
  if (decimals !== venue.receipt.decimals) {
    throw new PlatformError("VENUE_UNVERIFIED", `${venue.name} reports ${decimals} share decimals, not ${venue.receipt.decimals}.`, 422);
  }
  return {
    gates: gates.map((gate, index) => (sameAddress(gate as string, zeroAddress) ? "" : gateNames[index] as string)).filter(Boolean),
  };
}

async function vaultRead<F extends "balanceOf" | "maxDeposit" | "maxWithdraw" | "previewDeposit" | "previewWithdraw" | "previewRedeem">(
  context: Pick<VaultContext, "venue" | "network">,
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

/**
 * APY realised by the share price over the last week (net of the vault's
 * fees), from historical eth_call reads; null when the RPC cannot serve them
 * or the vault is younger than a day.
 */
async function realisedApy(venue: Erc4626Venue): Promise<{ apy: number; window: number } | null> {
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
  return Number.isFinite(apy) ? { apy: Math.round(apy * 1e8) / 1e8, window: elapsed } : null;
}

function title(context: VaultContext, amount: bigint, symbol: string, close: boolean): string {
  const what = close ? `all ${symbol}` : `${formatAmount(fromBaseUnits(amount, context.underlying.decimals))} ${symbol}`;
  const where = `${context.venue.name} (Morpho) on ${CHAINS[context.network].name}`;
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

async function depositQuote(action: AdapterAction, context: VaultContext, stage: "plan" | "prepare"): Promise<Quote> {
  const { venue, network, owner, token } = context;
  const amount = BigInt(action.amount);
  if (amount <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to deposit.", 422);
  if (stage === "prepare") {
    await assertEvmBalance(network, owner, context.native ? null : token, amount, action.input.symbol, action.input.decimals);
  }
  const [state, shares, cap, apy] = await Promise.all([
    readVault(context),
    vaultRead(context, "previewDeposit", amount),
    isV2(venue) ? Promise.resolve(null) : vaultRead(context, "maxDeposit", owner),
    stage === "plan" ? bestEffort(() => realisedApy(venue)) : Promise.resolve(null),
  ]);
  if (state.gates.length > 0) {
    throw new PlatformError(
      "VENUE_UNVERIFIED",
      `${venue.name} has access gates set (${state.gates.join(", ")}); Kletia only deposits into ungated vaults.`,
      422,
    );
  }
  if (cap !== null && cap < amount) {
    throw new PlatformError(
      "RESERVE_UNAVAILABLE",
      `${venue.name} accepts at most ${formatUnits(cap, context.underlying.decimals, context.underlying.symbol)} more right now (its market caps are reached).`,
      422,
    );
  }
  if (shares <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `${formatUnits(amount, context.underlying.decimals, context.underlying.symbol)} buys no shares of ${venue.name}.`, 422);
  // ERC-4626 deposit takes no minimum: hold the shares to the preview less the share-price tolerance.
  const minimum = lessBps(shares, SHARE_TOLERANCE_BPS);
  const vault = getAddress(venue.spender);
  const allowance = stage === "plan" ? await plannedAllowance(context, vault) : undefined;
  const transactions: EvmTransactionRequest[] = [];
  if (context.native) transactions.push(wrapTransaction(context, amount));
  const approval = await exactApproval(context, vault, amount, allowance);
  if (approval) transactions.push(approval);
  const data = encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [amount, owner] });
  const warnings: string[] = [];
  let gas: bigint | string = DEPOSIT_GAS;
  if (stage === "prepare" && transactions.length === 0) {
    const request = { from: owner, to: venue.target, data };
    const simulation = await simulate(network, request, VAULT_ABI);
    assertSimulation(simulation, `deposit into ${venue.name}`);
    if (simulation.status === "unavailable") warnings.push(SIMULATION_UNAVAILABLE);
    const minted = simulatedUint(simulation);
    if (minted !== null && minted < minimum) {
      throw new PlatformError("SIMULATION_FAILED", `${venue.name} would mint fewer shares than previewed; try again shortly.`, 422);
    }
    gas = await callGas(network, request, DEPOSIT_GAS);
  }
  transactions.push(evmCall(context, venue.target, data, 0n, gas, title(context, amount, context.underlying.symbol, false)));
  const symbol = await tokenSymbol(network, venue.receipt.address, `${venue.slug}-shares`);
  return {
    transactions,
    input: amount,
    expected: shares,
    minimum,
    output: receiptAsset(network, venue.receipt, symbol, venue.name),
    gas: DEPOSIT_GAS + (approval ? APPROVE_GAS : 0n) + (context.native ? WRAP_GAS : 0n),
    warnings: [...warnings, ...apyNote(apy ? { supplyApy: apy.apy, apySource: "share-price", apyWindowSeconds: apy.window } : null)],
  };
}

async function withdrawQuote(action: AdapterAction, context: VaultContext): Promise<Quote> {
  const { venue, network, owner } = context;
  const [state, shares] = await Promise.all([readVault(context), vaultRead(context, "balanceOf", owner)]);
  const symbol = context.underlying.symbol;
  if (shares === 0n) {
    throw new PlatformError("POSITION_EMPTY", `The account holds no ${venue.name} shares on ${CHAINS[network].name}.`, 422);
  }
  const position = await vaultRead(context, "previewRedeem", shares);
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
  if (!isV2(venue)) {
    const available = await vaultRead(context, "maxWithdraw", owner);
    if (available < (close ? lessBps(position, REDEEM_TOLERANCE_BPS) : requested)) {
      throw new PlatformError(
        "VENUE_ILLIQUID",
        `${venue.name} can pay out ${formatUnits(available, context.underlying.decimals, symbol)} to this account right now (its markets are borrowed); ${formatUnits(requested, context.underlying.decimals, symbol)} cannot be withdrawn yet.`,
        422,
      );
    }
  }
  const data = close
    ? encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [shares, owner, owner] })
    : encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [requested, owner, owner] });
  const request = { from: owner, to: venue.target, data };
  const simulation = await simulate(network, request, VAULT_ABI);
  assertSimulation(simulation, `withdrawal from ${venue.name}`);
  // Redeeming a fixed share count pays at least the preview (the share price only grows) unless the
  // vault realises a loss before execution: hold it to one basis point below the preview.
  const minimum = close ? lessBps(position, REDEEM_TOLERANCE_BPS) : requested;
  const paid = simulatedUint(simulation);
  if (close && paid !== null && paid < minimum) {
    throw new PlatformError("SIMULATION_FAILED", `${venue.name} would pay less than previewed for the shares; try again shortly.`, 422);
  }
  const warnings = simulation.status === "unavailable" ? [SIMULATION_UNAVAILABLE] : [];
  if (state.gates.length > 0) warnings.push(`${venue.name} has access gates set (${state.gates.join(", ")}); the withdrawal was simulated against them.`);
  const gas = simulation.status === "ok" ? await callGas(network, request, WITHDRAW_GAS) : WITHDRAW_GAS.toString();
  const transactions = [evmCall(context, venue.target, data, 0n, gas, title(context, requested, symbol, action.closePosition === true))];
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

async function quote(action: AdapterAction, stage: "plan" | "prepare"): Promise<{ context: VaultContext; quote: Quote }> {
  const context = lendingContext(action, "erc4626", "morpho");
  const result = context.kind === "deposit" ? await depositQuote(action, context, stage) : await withdrawQuote(action, context);
  return { context, quote: result };
}

/* ------------------------------------------------------------ verification */

function proveDeposit(step: IntentStep, venue: Erc4626Venue, asset: string, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the vault." });
  const decoded = decodeFunctionData({ abi: VAULT_ABI, data: call.input as Hex });
  if (decoded.functionName !== "deposit" || !sameAddress(decoded.args[1], account)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault call is not a deposit for the step account." });
  }
  const assets = decoded.args[0];
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
  if (transferred([call], asset, account, venue.target) !== assets) {
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

function proveWithdraw(step: IntentStep, venue: Erc4626Venue, asset: string, receipts: readonly LandedEvmReceipt[], observedAt: string): EvmOutcome {
  const account = stepOwner(step);
  const call = landedCall(receipts, venue.target);
  if (!call) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "No landed transaction called the vault." });
  const decoded = decodeFunctionData({ abi: VAULT_ABI, data: call.input as Hex });
  if ((decoded.functionName !== "withdraw" && decoded.functionName !== "redeem") || !sameAddress(decoded.args[1], account) || !sameAddress(decoded.args[2], account)) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault call is not a withdrawal of the step account's shares to itself." });
  }
  const event = evmEvents([call], { address: venue.target, abi: VAULT_ABI, eventName: "Withdraw" }).find((entry) =>
    sameAddress(entry.args.sender, account) && sameAddress(entry.args.receiver, account) && sameAddress(entry.args.owner, account));
  if (!event) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault emitted no Withdraw event for the step account." });
  const { assets, shares } = event.args;
  if (decoded.functionName === "withdraw" && assets !== decoded.args[0]) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The vault paid ${assets} base units; ${decoded.args[0]} were requested.` });
  }
  if (decoded.functionName === "redeem") {
    const floor = lowestFloor(step) ?? 1n;
    if (shares !== decoded.args[0] || assets < floor) {
      return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: `The vault redeemed ${shares} shares for ${assets} base units; the plan required ${decoded.args[0]} shares for at least ${floor}.` });
    }
  }
  if (transferred([call], venue.target, account, zeroAddress) !== shares) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The vault's share burn does not match its Withdraw event." });
  }
  if (transferred([call], asset, venue.target, account) !== assets) {
    return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The withdrawn tokens did not move from the vault to the account." });
  }
  const nativeLeg = nativeLegFailure(receipts, asset, account);
  if (nativeLeg) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: nativeLeg });
  const output = step.minimumOutput as NonNullable<IntentStep["minimumOutput"]>;
  // A native ETH output is what the step's own unwrap transaction released.
  const received = output.asset === nativeAssetId(step.network) ? unwrappedWeth(receipts, asset) : assets;
  if (received === null) return outcomeFailure({ code: "OUTCOME_NOT_PROVEN", message: "The ETH withdrawal landed without its unwrap transaction." });
  return {
    actualOutput: observed(output, received),
    evidence: [eventEvidence(step, call, observedAt, `Vault Withdraw: ${formatUnits(shares, venue.receipt.decimals, "shares")} burned for ${formatUnits(assets, output.decimals, output.symbol)}.`)],
  };
}

/* ----------------------------------------------------------------- metrics */

/** Realised APY, total assets (TVL) and provenance warnings of a curated vault. */
export async function morphoMetrics(venue: Erc4626Venue): Promise<LendingMetrics> {
  const network = venue.network as EvmNetworkKey;
  const underlying = findAssetBySymbol(network, venue.asset);
  if (!underlying?.address) throw new PlatformError("VENUE_INVALID", `${venue.name} has no pinned underlying.`, 500);
  const context = { venue, network, token: getAddress(underlying.address), underlying };
  const [state, total, apy] = await Promise.all([
    readVault(context),
    withTimeout(evmClient(network).readContract({ address: getAddress(venue.target), abi: VAULT_ABI, functionName: "totalAssets" })),
    bestEffort(() => realisedApy(venue), 8_000),
  ]);
  return {
    venue: venue.id,
    protocol: venue.protocol,
    network,
    name: venue.name,
    asset: venue.asset,
    supplyApy: apy?.apy ?? null,
    apySource: apy ? "share-price" : "unavailable",
    ...(apy ? { apyWindowSeconds: apy.window } : {}),
    totalSupplied: underlyingAmount(context, total),
    exitLiquidity: null,
    utilization: null,
    observedAt: new Date().toISOString(),
    warnings: state.gates.length > 0 ? [`Access gates set: ${state.gates.join(", ")}.`] : [],
  };
}

export const erc4626Adapter: ProtocolAdapter = {
  id: "morpho",
  protocols: ["morpho"],
  label: "Morpho Vaults",

  supports(route) {
    return supportsLending(route, "morpho", "erc4626", { deposit: true, withdraw: true });
  },

  async plan(action): Promise<PlannedStep> {
    const { context, quote: planned } = await quote(action, "plan");
    const fees = await estimateEvmFeeUsd(context.network, planned.gas);
    return {
      protocol: "morpho",
      title: title(context, planned.input, action.input.symbol, action.closePosition === true),
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
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const { context, quote: prepared } = await quote(action, "prepare");
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
    const venue = stepVenue(context.step, "erc4626");
    const asset = venue ? findAssetBySymbol(venue.network, venue.asset)?.address : null;
    if (!venue || !asset || !context.step.minimumOutput) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The step has no Morpho registry vault or output." } };
    }
    const observedAt = new Date(context.now).toISOString();
    const { result } = await verifyEvmReceipts(context, (receipts) =>
      context.step.kind === "withdraw"
        ? proveWithdraw(context.step, venue, getAddress(asset), receipts, observedAt)
        : proveDeposit(context.step, venue, getAddress(asset), receipts, observedAt));
    return result;
  },
};
