/**
 * LI.FI adapter: same-asset bridges from the EVM networks where the LiFiDiamond
 * is pinned in the registry to EVM networks and Solana.
 *
 * LI.FI is untrusted. Kletia asks only for bridge tools it has a calldata
 * decoder for (Across V4, Polymer CCTP), then decodes the diamond call and
 * checks it against the step and the pinned contracts at plan and at prepare:
 * - the call goes to the pinned diamond and the approval is exact and only for
 *   the diamond; no value is sent;
 * - BridgeData: the quote's transactionId and tool, the input token, the
 *   recipient (or LI.FI's non-EVM sentinel plus the facet's Solana receiver),
 *   the destination chain, no destination call;
 * - source swaps may only be LI.FI's fee collection through the pinned
 *   FeeForwarder, in the input token, totalling the step amount, with fees
 *   capped;
 * - facet data: Across recipient / refund / tokens / empty message, Polymer
 *   refund recipient / empty hook / Solana ATA derived by Kletia;
 * - the guaranteed output decoded from the calldata covers LI.FI's
 *   `toAmountMin`, which becomes the step minimum.
 * Solana-origin LI.FI routes are not offered: their programs are not pinned
 * (the owner of LI.FI's Solana router program is unverified), and `near`
 * pays a fresh deposit address that cannot be pinned.
 *
 * Verification requires LiFiTransferStarted from the pinned diamond with the
 * prepared transactionId; settlement requires LI.FI's DONE/COMPLETED status
 * for that transfer and the destination credit on-chain.
 */
import { address as solanaAddress, getAddressEncoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from "viem";
import {
  applySlippage,
  CHAINS,
  explorerTxUrl,
  formatAmount,
  fromBaseUnits,
  getProtocol,
  parseAccountId,
  venueContracts,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
  type TransactionRequest,
} from "@kletia/core";
import { isSolanaNetworkKey, solanaRpc, assertSolanaWalletRecipient } from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, type ResolvedAsset } from "../assets.js";
import { evmChainId, isEvmNetwork, observeEvmTransaction, readAllowance, type EvmNetworkKey } from "../chains/evm.js";
import { decodeStepRef } from "../stepRef.js";
import { isRecord } from "../util.js";
import { assertEvmBalance } from "./evmTransfer.js";
import { fetchLifiQuote, fetchLifiStatus, type LifiQuote } from "./lifiClient.js";
import { cappedOutput, destinationCredit, type DestinationCheck } from "./relay.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter, SettlementResult, VerificationResult } from "./types.js";
import { evmEvents, fillNotBefore, verifyEvmReceipts } from "./verification.js";

/** Networks LI.FI serves in the registry (origins additionally need a pinned diamond). */
export const LIFI_NETWORKS: readonly NetworkKey[] = Object.freeze([...(getProtocol("lifi")?.networks ?? [])]);

/** LI.FI's BridgeData.receiver for non-EVM destinations (the real receiver sits in the facet data). */
export const LIFI_NON_EVM_RECEIVER = "0x11f111f111f111F111f111f111F111f111f111F1";
/** Fees LI.FI may take through the FeeForwarder (its fixed fee is 0.25%). */
const MAX_FEE_BPS = 100n;
const MULTIPLIER_BASE = 10n ** 18n;
const APPROVE_GAS = "70000";
/** Across fill deadlines closer than this cannot be signed and mined in time. */
const MIN_FILL_WINDOW_SECONDS = 600;

/** Bridge tools with a calldata decoder, by LI.FI tool key. */
const TOOLS = {
  across: { facet: "across", name: "Across" },
  polymerStandard: { facet: "polymer", name: "Polymer CCTP" },
} as const;
type LifiTool = keyof typeof TOOLS;

export const LIFI_DIAMOND_ABI = parseAbi([
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
  "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct PolymerCCTPData { uint256 polymerTokenFee; uint256 maxCCTPFee; bytes32 nonEVMReceiver; bytes32 solanaReceiverATA; uint32 minFinalityThreshold; address refundRecipient; bytes hookData; }",
  "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData) payable",
  "function swapAndStartBridgeTokensViaAcrossV4(BridgeData _bridgeData, SwapData[] _swapData, AcrossV4Data _acrossData) payable",
  "function startBridgeTokensViaPolymerCCTP(BridgeData _bridgeData, PolymerCCTPData _polymerData)",
  "function swapAndStartBridgeTokensViaPolymerCCTP(BridgeData _bridgeData, SwapData[] _swapData, PolymerCCTPData _polymerData) payable",
]);

const LIFI_EVENTS_ABI = parseAbi([
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "event LiFiTransferStarted(BridgeData bridgeData)",
]);

const FEE_FORWARDER_ABI = parseAbi([
  "struct FeeDistribution { address recipient; uint256 amount; }",
  "function forwardERC20Fees(address _token, FeeDistribution[] _distributions)",
]);

function reject(message: string): never {
  throw new PlatformError("PROVIDER_TRANSACTION_INVALID", `LI.FI route refused: ${message}`, 502);
}

function lifiChainId(network: NetworkKey): number {
  const id = CHAINS[network].settlement.lifiChainId;
  if (id === undefined) throw new PlatformError("NETWORK_UNSUPPORTED", `LI.FI does not serve ${CHAINS[network].name}.`, 422);
  return id;
}

function pinnedDiamond(network: NetworkKey): string | null {
  const diamonds = venueContracts("lifi", network, "diamond");
  return diamonds.length === 1 ? (diamonds[0] as string) : null;
}

function sameEvm(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** 32-byte form of an account: EVM addresses left-padded, Solana public keys as their raw bytes. */
export function accountBytes32(network: NetworkKey, value: string): Hex {
  if (CHAINS[network].vm === "svm") {
    return `0x${Buffer.from(getAddressEncoder().encode(solanaAddress(value))).toString("hex")}`;
  }
  return `0x${value.toLowerCase().replace(/^0x/u, "").padStart(64, "0")}`;
}

/** Raw bytes of an account as DLN and LI.FI encode it: 20 bytes on EVM, 32 on Solana. */
export function accountBytes(network: NetworkKey, value: string): Hex {
  return CHAINS[network].vm === "svm" ? accountBytes32(network, value) : (value.toLowerCase() as Hex);
}

function isUsdc(asset: ResolvedAsset): boolean {
  return asset.canonical && asset.group === "USDC" && asset.symbol.toUpperCase() === "USDC" && !asset.isNative;
}

/** Bridge tools that can serve a route, in LI.FI's `allowBridges` order. */
function toolsFor(route: Pick<AdapterRoute, "network" | "destinationNetwork" | "input" | "output">): LifiTool[] {
  const { input, output } = route;
  if (input.isNative || output.isNative || !input.address || !output.address) return [];
  if (!input.canonical || !output.canonical || input.group === undefined || input.group !== output.group) return [];
  if (CHAINS[route.destinationNetwork].vm === "svm") {
    // Across to Solana is not decoded yet; Polymer CCTP mints USDC to the recipient's token account.
    return isUsdc(input) && isUsdc(output) ? ["polymerStandard"] : [];
  }
  return isUsdc(input) && isUsdc(output) ? ["across", "polymerStandard"] : ["across"];
}

function title(action: Pick<AdapterAction, "network" | "destinationNetwork" | "input" | "amount">): string {
  const amount = `${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol}`;
  return `Bridge ${amount} from ${CHAINS[action.network].name} to ${CHAINS[action.destinationNetwork].name} via LI.FI`;
}

/** The recipient's USDC associated token account (Polymer CCTP mints there). */
async function solanaUsdcAccount(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: solanaAddress(owner), mint: solanaAddress(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return String(ata);
}

/**
 * CCTP on Solana mints into an existing token account: refuse the route when
 * the recipient's USDC account does not exist (the mint would fail and strand
 * the burn) or is not a USDC account of the recipient.
 */
async function assertSolanaUsdcAccount(owner: string, mint: string): Promise<string> {
  const ata = await solanaUsdcAccount(owner, mint);
  let value: unknown;
  try {
    const info = await solanaRpc("solana")
      .getAccountInfo(solanaAddress(ata), { encoding: "jsonParsed", commitment: "confirmed" })
      .send({ abortSignal: rpcAbortSignal() });
    value = info.value;
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The recipient's USDC account could not be checked. Try again shortly.", 502);
  }
  if (!value) {
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      "LI.FI's CCTP route mints into the recipient's USDC token account, which does not exist yet. Use another venue or create the account first.",
      422,
    );
  }
  const record = value as { owner?: unknown; data?: unknown };
  const parsed = isRecord(record.data) && isRecord(record.data.parsed) && isRecord(record.data.parsed.info) ? record.data.parsed.info : null;
  if (String(record.owner) !== String(TOKEN_PROGRAM_ADDRESS) || !parsed || parsed.mint !== mint || parsed.owner !== owner) {
    throw new PlatformError("ROUTE_UNAVAILABLE", "The recipient's USDC token account is not a standard USDC account of that wallet.", 422);
  }
  return ata;
}

interface DecodedTransfer {
  readonly functionName: string;
  readonly tool: LifiTool;
  readonly transactionId: string;
  readonly receiver: string;
  readonly destinationChainId: bigint;
  /** Output the calldata guarantees on the destination network (base units of the output asset). */
  readonly floor: bigint;
  /** Fees taken through the FeeForwarder (base units of the input asset). */
  readonly fees: bigint;
}

interface DecodeExpectations {
  readonly action: AdapterAction;
  readonly tool: string;
  readonly transactionId: string;
  /** Recipient's USDC token account, required for Polymer CCTP to Solana. */
  readonly solanaAta?: string;
  readonly nowSeconds: number;
}

/** Sums the FeeForwarder's ERC-20 fee distribution after checking its token. */
function forwardedFees(callData: Hex, token: string): bigint {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: FEE_FORWARDER_ABI, data: callData });
  } catch {
    reject("a source swap is not a LI.FI fee forward");
  }
  const [feeToken, distributions] = decoded.args;
  if (!sameEvm(feeToken, token)) reject("fees are taken in another token");
  if (distributions.length > 4) reject("too many fee recipients");
  return distributions.reduce((total, entry) => total + entry.amount, 0n);
}

/**
 * Decodes the diamond calldata and checks every field against the step and
 * the pinned contracts. Returns the guaranteed destination output.
 */
export function decodeLifiTransfer(data: string, expect: DecodeExpectations): DecodedTransfer {
  const { action } = expect;
  const network = action.network;
  const input = action.input.address as string;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: LIFI_DIAMOND_ABI, data: data as Hex });
  } catch {
    reject("the diamond call is not a decodable Across or Polymer bridge");
  }
  const tool = expect.tool as LifiTool;
  const facet = TOOLS[tool]?.facet;
  const across = decoded.functionName === "startBridgeTokensViaAcrossV4" || decoded.functionName === "swapAndStartBridgeTokensViaAcrossV4";
  if (!facet || (facet === "across") !== across) reject(`the calldata does not match the ${expect.tool} tool`);
  const [bridge] = decoded.args;
  const swaps = decoded.functionName.startsWith("swapAnd") ? (decoded.args[1] as readonly {
    callTo: string; approveTo: string; sendingAssetId: string; receivingAssetId: string; fromAmount: bigint; callData: Hex; requiresDeposit: boolean;
  }[]) : [];
  const amount = BigInt(action.amount);
  const destinationSvm = CHAINS[action.destinationNetwork].vm === "svm";
  if (bridge.transactionId.toLowerCase() !== expect.transactionId.toLowerCase()) reject("transactionId differs from the quote");
  if (bridge.bridge !== expect.tool) reject("the bridge differs from the quoted tool");
  if (!sameEvm(bridge.sendingAssetId, input)) reject("the bridged token is not the step input");
  if (bridge.destinationChainId !== BigInt(lifiChainId(action.destinationNetwork))) reject("the destination chain differs");
  if (bridge.hasDestinationCall) reject("the route carries a destination call");
  if (bridge.hasSourceSwaps !== swaps.length > 0) reject("source swap flags are inconsistent");
  if (bridge.minAmount === 0n) reject("the bridged amount is zero");
  if (destinationSvm ? !sameEvm(bridge.receiver, LIFI_NON_EVM_RECEIVER) : !sameEvm(bridge.receiver, action.recipient.address)) {
    reject("the receiver is not the step recipient");
  }
  // Source swaps: only LI.FI's fee collection through the pinned FeeForwarder, in the input token.
  let fees = 0n;
  if (swaps.length > 0) {
    if (swaps.length > 2) reject("too many source swaps");
    const forwarder = venueContracts("lifi", network, "fee-forwarder");
    let pulled = 0n;
    for (const swap of swaps) {
      if (!forwarder.some((pinned) => sameEvm(pinned, swap.callTo)) || !sameEvm(swap.callTo, swap.approveTo)) {
        reject("a source swap calls a contract other than the pinned FeeForwarder");
      }
      if (!sameEvm(swap.sendingAssetId, input) || !sameEvm(swap.receivingAssetId, input)) reject("a source swap changes the token");
      fees += forwardedFees(swap.callData, input);
      if (swap.requiresDeposit) pulled += swap.fromAmount;
    }
    if (pulled !== amount) reject("the amount pulled from the wallet differs from the step amount");
    // The diamond requires minAmount to remain after the swaps, so fees + minAmount cannot exceed the deposit.
    if (fees + bridge.minAmount > amount) reject("fees and bridged amount exceed the step amount");
  } else if (bridge.minAmount !== amount) {
    reject("the bridged amount differs from the step amount");
  }
  if (fees * 10_000n > amount * MAX_FEE_BPS) reject(`fees exceed ${Number(MAX_FEE_BPS) / 100}% of the amount`);
  let floor: bigint;
  if (across) {
    const data = decoded.args[decoded.args.length - 1] as {
      receiverAddress: Hex; refundAddress: Hex; sendingAssetId: Hex; receivingAssetId: Hex; outputAmount: bigint;
      outputAmountMultiplier: bigint; fillDeadline: number; message: Hex;
    };
    if (destinationSvm) reject("Across routes to Solana are not decoded");
    if (data.receiverAddress.toLowerCase() !== accountBytes32(action.destinationNetwork, action.recipient.address)) reject("the Across recipient differs");
    if (data.refundAddress.toLowerCase() !== accountBytes32(network, action.account.address)) reject("Across refunds would go to another account");
    if (data.sendingAssetId.toLowerCase() !== accountBytes32(network, input)) reject("the Across input token differs");
    if (data.receivingAssetId.toLowerCase() !== accountBytes32(action.destinationNetwork, action.output.address as string)) {
      reject("the Across output token is not the step output");
    }
    if (data.message !== "0x") reject("the Across deposit carries a message");
    if (data.fillDeadline < expect.nowSeconds + MIN_FILL_WINDOW_SECONDS) reject("the Across fill deadline is too close");
    // swapAndStart recomputes outputAmount from the post-fee amount: output = minAmount * multiplier / 1e18.
    floor = swaps.length > 0 ? (bridge.minAmount * data.outputAmountMultiplier) / MULTIPLIER_BASE : data.outputAmount;
  } else {
    const data = decoded.args[decoded.args.length - 1] as {
      polymerTokenFee: bigint; maxCCTPFee: bigint; nonEVMReceiver: Hex; solanaReceiverATA: Hex; minFinalityThreshold: number;
      refundRecipient: string; hookData: Hex;
    };
    if (!isUsdc(action.input) || !isUsdc(action.output)) reject("Polymer CCTP bridges USDC only");
    if (data.hookData !== "0x") reject("the Polymer deposit carries hook data");
    if (data.minFinalityThreshold !== 1000 && data.minFinalityThreshold !== 2000) reject("unexpected CCTP finality threshold");
    if (swaps.length > 0 && !sameEvm(data.refundRecipient, action.account.address)) reject("Polymer refunds would go to another account");
    if (destinationSvm) {
      if (!expect.solanaAta) reject("the recipient's USDC account is unknown");
      if (data.nonEVMReceiver.toLowerCase() !== accountBytes32("solana", action.recipient.address)) reject("the Solana receiver differs");
      if (data.solanaReceiverATA.toLowerCase() !== accountBytes32("solana", expect.solanaAta)) reject("CCTP would mint to another token account");
    } else if (BigInt(data.nonEVMReceiver) !== 0n || BigInt(data.solanaReceiverATA) !== 0n) {
      reject("an EVM route carries non-EVM receivers");
    }
    floor = bridge.minAmount - data.polymerTokenFee - data.maxCCTPFee;
  }
  if (floor <= 0n) reject("the route guarantees no output");
  // Same-asset bridge: an output above the bridged amount cannot be filled (it would only win the auction and stall).
  if (floor * 10n ** BigInt(action.input.decimals) > bridge.minAmount * 10n ** BigInt(action.output.decimals)) {
    reject("the route promises more than it bridges");
  }
  return {
    functionName: decoded.functionName,
    tool,
    transactionId: bridge.transactionId.toLowerCase(),
    receiver: bridge.receiver,
    destinationChainId: bridge.destinationChainId,
    floor,
    fees,
  };
}

interface CheckedQuote {
  readonly quote: LifiQuote;
  readonly decoded: DecodedTransfer;
  readonly diamond: string;
  readonly allowance: bigint;
}

function toolMoved(planned: LifiTool, now: string): PlatformError {
  return new PlatformError(
    "QUOTE_MOVED",
    `LI.FI now routes this transfer via ${TOOLS[now as LifiTool]?.name ?? now.slice(0, 32)}, not the planned ${TOOLS[planned].name} (another settlement time). Create a new intent to re-quote.`,
    409,
  );
}

/**
 * Quotes and validates a LI.FI route for the action (plan and prepare run the
 * same checks). `plannedTool` (prepare) restricts the quote to the bridge tool
 * the auction ranked; another tool is QUOTE_MOVED.
 */
async function checkedQuote(action: AdapterAction, slippageBps: number, stage: "plan" | "prepare", plannedTool?: LifiTool): Promise<CheckedQuote> {
  if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "LI.FI routes start on an EVM network.", 422);
  const diamond = pinnedDiamond(action.network);
  if (!diamond) throw new PlatformError("NETWORK_UNSUPPORTED", `LI.FI has no pinned diamond on ${CHAINS[action.network].name}.`, 422);
  const routable = toolsFor(action);
  if (routable.length === 0) throw new PlatformError("ROUTE_UNSUPPORTED", "LI.FI bridges the same canonical ERC-20 asset only (no native assets, no swaps).", 422);
  if (plannedTool && !routable.includes(plannedTool)) throw toolMoved(plannedTool, routable[0] as LifiTool);
  const tools = plannedTool ? [plannedTool] : routable;
  let solanaAta: string | undefined;
  if (isSolanaNetworkKey(action.destinationNetwork)) {
    await assertSolanaWalletRecipient(action.destinationNetwork, action.recipient.address);
    solanaAta = await assertSolanaUsdcAccount(action.recipient.address, action.output.address as string);
  }
  const quote = await fetchLifiQuote({
    fromChain: lifiChainId(action.network),
    toChain: lifiChainId(action.destinationNetwork),
    fromToken: action.input.address as string,
    toToken: action.output.address as string,
    fromAmount: action.amount,
    fromAddress: action.account.address,
    toAddress: action.recipient.address,
    slippageBps,
    allowBridges: tools,
  });
  if (plannedTool && quote.tool !== plannedTool) throw toolMoved(plannedTool, quote.tool);
  const tx = quote.transaction;
  if (!sameEvm(tx.to, diamond)) reject(`the transaction targets ${tx.to}, not the pinned LiFiDiamond`);
  if (!sameEvm(tx.from, action.account.address)) reject("the transaction is not sent by the step account");
  if (tx.chainId !== evmChainId(action.network)) reject("the transaction targets another chain");
  if (tx.value !== "0") reject("a token bridge must not carry value");
  const decoded = decodeLifiTransfer(tx.data, {
    action,
    tool: quote.tool,
    transactionId: quote.transactionId,
    ...(solanaAta ? { solanaAta } : {}),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (decoded.floor < BigInt(quote.toAmountMin)) reject("the calldata guarantees less than the quoted minimum");
  const owner = action.account.address;
  const allowance = stage === "plan"
    ? await readAllowance(action.network, action.input.address as string, owner, diamond).catch(() => 0n)
    : await readAllowance(action.network, action.input.address as string, owner, diamond);
  return { quote, decoded, diamond, allowance };
}

/**
 * Re-quote cushion for exact-output venues (an Across fill, a CCTP mint or a
 * DLN order delivers exactly the quoted amount): the step minimum sits this
 * many basis points (at most the step's slippage) below the exact amount, so
 * a fresh quote at prepare that drifted by less still prepares instead of
 * failing QUOTE_MOVED. The payload itself still guarantees the exact amount.
 */
export const EXACT_OUTPUT_CUSHION_BPS = 5;

export function cushionedMinimum(exact: string, slippageBps: number): string {
  return applySlippage(exact, Math.min(slippageBps, EXACT_OUTPUT_CUSHION_BPS));
}

function amounts(action: AdapterAction, quote: LifiQuote, slippageBps: number) {
  const cushioned = cushionedMinimum(quote.toAmount, slippageBps);
  return {
    input: assetAmount(action.input, action.amount, quote.fromAmountUsd ?? undefined),
    expectedOutput: assetAmount(action.output, quote.toAmount, quote.toAmountUsd ?? undefined),
    minimumOutput: assetAmount(action.output, BigInt(quote.toAmountMin) < BigInt(cushioned) ? quote.toAmountMin : cushioned),
  };
}

function warnings(quote: LifiQuote): string[] {
  return [`Route: LI.FI via ${TOOLS[quote.tool as LifiTool]?.name ?? quote.tool} (LI.FI charges 0.25%).`];
}

function settlementSeconds(quote: LifiQuote): number {
  return Math.max(quote.executionSeconds, 5);
}

export const lifiAdapter: ProtocolAdapter = {
  id: "lifi",
  protocols: ["lifi"],
  label: "LI.FI",

  supports(route) {
    if (route.kind !== "bridge" || route.network === route.destinationNetwork) return false;
    if (!isEvmNetwork(route.network) || !pinnedDiamond(route.network)) return false;
    if (!LIFI_NETWORKS.includes(route.network) || !LIFI_NETWORKS.includes(route.destinationNetwork)) return false;
    if (CHAINS[route.network].settlement.lifiChainId === undefined || CHAINS[route.destinationNetwork].settlement.lifiChainId === undefined) {
      return false;
    }
    return toolsFor(route).length > 0;
  },

  async plan(action): Promise<PlannedStep> {
    const { quote, allowance } = await checkedQuote(action, action.slippageBps, "plan");
    const seconds = settlementSeconds(quote);
    return {
      protocol: "lifi",
      title: title(action),
      mode: "wallet",
      ...amounts(action, quote, action.slippageBps),
      ...(quote.feesUsd !== null ? { feesUsd: quote.feesUsd } : {}),
      estimatedSeconds: seconds + 15,
      settlement: { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: seconds },
      warnings: warnings(quote),
      quoteId: quote.transactionId,
      // The auction ranked this tool's settlement time: prepare re-quotes it only.
      provider: quote.tool,
      transactionCount: allowance >= BigInt(action.amount) ? 1 : 2,
      slippageBps: action.slippageBps,
    };
  },

  async prepare({ graph, step, action }): Promise<PreparedPayload> {
    if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "LI.FI routes start on an EVM network.", 422);
    const network: EvmNetworkKey = action.network;
    const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps;
    const amount = BigInt(action.amount);
    await assertEvmBalance(network, action.account.address, action.input.address, amount, action.input.symbol, action.input.decimals);
    const plannedTool = action.provider !== undefined && Object.hasOwn(TOOLS, action.provider) ? (action.provider as LifiTool) : undefined;
    const { quote, diamond, allowance } = await checkedQuote(action, slippageBps, "prepare", plannedTool);
    // The caller's own time limit binds every prepare, as it bound the auction.
    const maxSeconds = graph.request?.constraints?.maxSeconds;
    if (maxSeconds !== undefined && settlementSeconds(quote) + 15 > maxSeconds) {
      throw new PlatformError(
        "QUOTE_MOVED",
        `LI.FI now estimates ~${settlementSeconds(quote)} s to settle, beyond constraints.maxSeconds (${maxSeconds} s). Create a new intent to re-quote.`,
        409,
      );
    }
    const chainId = evmChainId(network);
    const from = getAddress(action.account.address);
    const transactions: TransactionRequest[] = [];
    if (allowance < amount) {
      transactions.push({
        vm: "evm",
        network,
        chainId,
        from,
        to: getAddress(action.input.address as string),
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(diamond), amount] }),
        value: "0",
        gas: APPROVE_GAS,
        description: `Approve ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for LI.FI`,
      });
    }
    transactions.push({
      vm: "evm",
      network,
      chainId,
      from,
      to: getAddress(diamond),
      data: quote.transaction.data,
      value: "0",
      ...(quote.transaction.gasLimit ? { gas: quote.transaction.gasLimit } : {}),
      description: title(action),
    });
    return {
      transactions,
      records: transactions.map((transaction) => ({
        vm: "evm" as const,
        network,
        to: transaction.vm === "evm" ? transaction.to : "",
        description: transaction.description,
      })),
      ...amounts(action, quote, slippageBps),
      ...(quote.feesUsd !== null ? { feesUsd: quote.feesUsd } : {}),
      trackingId: quote.transactionId,
      quoteId: quote.transactionId,
      warnings: warnings(quote),
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    if (!isEvmNetwork(step.network)) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "LI.FI steps start on an EVM network." } };
    }
    const diamond = pinnedDiamond(step.network);
    const { result } = await verifyEvmReceipts(context, (receipts) => {
      const deposit = receipts[receipts.length - 1];
      const transfer = deposit && diamond && sameEvm(deposit.to ?? "", diamond) ? landedTransfer(deposit.input) : null;
      if (!transfer || !diamond) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The last transaction is not a LI.FI bridge call to the pinned diamond." } };
      }
      const started = evmEvents(receipts, { address: diamond, abi: LIFI_EVENTS_ABI, eventName: "LiFiTransferStarted" })
        .some((event) => event.args.bridgeData.transactionId.toLowerCase() === transfer.transactionId &&
          event.args.bridgeData.destinationChainId === transfer.destinationChainId &&
          sameEvm(event.args.bridgeData.receiver, transfer.receiver));
      if (!started) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The pinned LiFiDiamond did not emit LiFiTransferStarted for the prepared transfer." } };
      }
    });
    return result;
  },

  async poll(step: IntentStep): Promise<SettlementResult> {
    const destination = step.settlement?.destinationNetwork;
    const deposit = step.references?.[step.references.length - 1];
    const recipient = step.recipient ? parseAccountId(step.recipient) : null;
    const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
    if (!destination || !deposit || !recipient || !output || !isEvmNetwork(step.network)) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The bridge step lacks a deposit, recipient or output." } };
    }
    // The deposit's own calldata (already bound to a prepared payload) names the transfer and its guaranteed floor.
    const observation = await observeEvmTransaction(step.network, deposit);
    if (observation.state !== "landed") return { status: "settling", evidence: [] };
    const transfer = landedTransfer(observation.input);
    if (!transfer) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The deposit is not a decodable LI.FI bridge call." } };
    }
    const status = await fetchLifiStatus(deposit, lifiChainId(step.network), lifiChainId(destination));
    const mismatch = (message: string): SettlementResult => ({ status: "failed", evidence: [], failure: { code: "SETTLEMENT_MISMATCH", message } });
    // Unindexed or attributed to another transfer: keep settling (times out to manual review), never settle.
    if (status.transactionId !== null && status.transactionId !== transfer.transactionId) return { status: "settling", evidence: [] };
    if (status.status === "FAILED") return { status: "failed", evidence: [], failure: { code: "SETTLEMENT_FAILED", message: "LI.FI reports the transfer failed." } };
    if (status.status !== "DONE" || status.transactionId === null) return { status: "settling", evidence: [] };
    if (status.substatus === "REFUNDED") {
      return { status: "failed", evidence: [], failure: { code: "SETTLEMENT_REFUNDED", message: "LI.FI refunded the transfer on the origin network." } };
    }
    if (status.substatus !== "COMPLETED") return mismatch(`LI.FI completed the transfer as ${status.substatus ?? "unknown"}, not as quoted.`);
    const sameRecipient = (value: string) => (recipient.chain.namespace === "eip155" ? sameEvm(value, recipient.address) : value === recipient.address);
    if (status.toAddress !== null && !sameRecipient(status.toAddress)) return mismatch("LI.FI paid a different recipient.");
    if (status.receiving.chainId !== lifiChainId(destination)) return mismatch("LI.FI delivered on a different network.");
    const token = status.receiving.token;
    const sameToken = token !== null && output.address !== null &&
      (recipient.chain.namespace === "eip155" ? sameEvm(token, output.address) : token === output.address);
    if (!sameToken) return mismatch("LI.FI delivered a different asset.");
    if (status.receiving.amount !== null && BigInt(status.receiving.amount) < transfer.floor) {
      return mismatch("LI.FI delivered less than the deposit guaranteed.");
    }
    const fill = status.receiving.txHash;
    if (!fill) return { status: "settling", evidence: [] };
    // The fill must be mined after the step was first prepared; the service claims it for this step only.
    const check = await destinationCredit(destination, fill, output, recipient.address, fillNotBefore(step)).catch(
      (): DestinationCheck => ({ confirmed: false, credited: null }),
    );
    if (!check.confirmed || check.credited === null) return { status: "settling", evidence: [] };
    if (check.credited < transfer.floor) return mismatch("The destination credit is below the guaranteed output.");
    const evidence: StepEvidence = {
      kind: "settlement",
      network: destination,
      reference: fill,
      url: explorerTxUrl(destination, fill),
      observedAt: new Date().toISOString(),
      detail: `LI.FI transfer ${transfer.transactionId.slice(0, 10)}… completed on ${CHAINS[destination].name}; ` +
        `${fromBaseUnits(check.credited, output.decimals)} ${output.symbol} credited to the recipient.`,
    };
    return {
      status: "settled",
      evidence: [evidence],
      actualOutput: assetAmount(output, cappedOutput(check.credited, step.expectedOutput?.amount).toString()),
    };
  },
};

/**
 * The transfer a landed diamond call starts (transactionId, receiver,
 * destination chain, guaranteed floor), decoded without re-checking the step:
 * the call is already bound to a payload whose calldata was checked at prepare.
 */
function landedTransfer(input: string): { transactionId: string; receiver: string; destinationChainId: bigint; floor: bigint } | null {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: LIFI_DIAMOND_ABI, data: input as Hex });
  } catch {
    return null;
  }
  const [bridge] = decoded.args;
  const swapped = decoded.functionName.startsWith("swapAnd");
  const facet = decoded.args[decoded.args.length - 1] as Record<string, unknown>;
  let floor: bigint;
  if (decoded.functionName.endsWith("AcrossV4")) {
    const multiplier = facet.outputAmountMultiplier as bigint;
    floor = swapped ? (bridge.minAmount * multiplier) / MULTIPLIER_BASE : (facet.outputAmount as bigint);
  } else {
    floor = bridge.minAmount - (facet.polymerTokenFee as bigint) - (facet.maxCCTPFee as bigint);
  }
  return { transactionId: bridge.transactionId.toLowerCase(), receiver: bridge.receiver, destinationChainId: bridge.destinationChainId, floor };
}
