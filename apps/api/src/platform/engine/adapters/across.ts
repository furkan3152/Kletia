/**
 * Across adapter: USDC, ETH and WETH bridges between the EVM production
 * networks through the pinned SpokePools. Solana waits for its SVM spoke
 * program.
 *
 * ETH and WETH: both sides of the deposit use the SpokePool's WETH (native ETH
 * is wrapped by the origin SpokePool from the exact `msg.value`). On a
 * destination whose gas asset is ETH, the SpokePool unwraps WETH to native ETH
 * for a recipient without code and delivers WETH to a recipient with code; an
 * EIP-7702 delegated account has code. The output form is therefore chosen from
 * the recipient's code (`accountCode`, read at plan and again at prepare):
 * native ETH only to an account without code, WETH only to an account with
 * code, and a recipient whose code cannot be read is refused. On Polygon (gas
 * asset POL) WETH is delivered as WETH.
 *
 * Across's API is untrusted and only supplies numbers. Kletia encodes the
 * `SpokePool.deposit(bytes32 …)` call itself (depositor = the step account,
 * recipient = the step recipient, exact input, the quoted exact output, no
 * message) and checks the quote field by field at plan and at prepare: both
 * spoke pools equal the pins, the amount is not too low and within the
 * deposit limits, the output is positive and at most the input, the quote
 * timestamp is inside the SpokePool's depositQuoteTimeBuffer and the fill
 * deadline inside its fillDeadlineBuffer (values read back on-chain,
 * 2026-10-14). A relayer must deliver exactly the output before the fill
 * deadline; otherwise Across refunds the deposit to the depositor on the
 * origin network (journey refund path "after-deadline"), so the floor is
 * enforced on-chain.
 *
 * Verification needs the pinned SpokePool's FundsDeposited event matching the
 * landed calldata and the step (depositor, recipient, tokens, amounts,
 * destination); its deposit id is the tracking id. Settlement needs Across's
 * `filled` status and the fill transaction crediting the recipient at least
 * the deposit's output on the destination; `expired` / `refunded` fail the
 * leg with SETTLEMENT_REFUNDED.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex, type Log } from "viem";
import {
  CHAINS,
  explorerTxUrl,
  findAssetBySymbol,
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
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, resolveAsset, type ResolvedAsset } from "../assets.js";
import { evmChainId, isEvmNetwork, observeEvmTransaction, readAllowance, type EvmNetworkKey } from "../chains/evm.js";
import { accountCode } from "../nameResolvers.js";
import { nativeUsdPrice } from "../prices.js";
import { decodeStepRef } from "../stepRef.js";
import {
  ACROSS_INTEGRATOR_DELIMITER,
  acrossIntegratorId,
  fetchAcrossDepositStatus,
  fetchAcrossQuote,
  type AcrossQuote,
} from "./acrossClient.js";
import { assertEvmBalance } from "./evmTransfer.js";
import { accountBytes32, cushionedMinimum } from "./lifi.js";
import { cappedOutput, destinationCredit, type DestinationCheck } from "./relay.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PlannedStepPreview, PreparedPayload, ProtocolAdapter, SettlementResult, VerificationResult } from "./types.js";
import { crossNetworkSeconds } from "./timing.js";
import { evmEvents, fillNotBefore, stepOwner, verifyEvmReceipts } from "./verification.js";

/** Networks Across serves in the registry (each needs a pinned SpokePool). */
export const ACROSS_NETWORKS: readonly NetworkKey[] = Object.freeze([...(getProtocol("across")?.networks ?? [])]);

/** SpokePool.depositQuoteTimeBuffer() on every pinned SpokePool (read back 2026-10-14). */
export const ACROSS_QUOTE_TIME_BUFFER_SECONDS = 3_600;
/** SpokePool.fillDeadlineBuffer() on every pinned SpokePool (read back 2026-10-14). */
export const ACROSS_FILL_DEADLINE_BUFFER_SECONDS = 21_600;
/** A quote must leave the wallet this long to sign before its timestamp leaves the quote buffer. */
const QUOTE_SIGNING_MARGIN_SECONDS = 600;
/** The fill deadline must leave relayers at least this long (and the wallet time to sign). */
const MIN_FILL_WINDOW_SECONDS = 600;
/** Clock skew tolerated between Across's quote timestamp and Kletia's clock. */
const CLOCK_SKEW_SECONDS = 120;
/**
 * SpokePool.MAX_EXCLUSIVITY_PERIOD_SECONDS() on every pinned SpokePool (read back 2026-10-23): an
 * exclusivityParameter above it is an absolute timestamp, at or below it a period added to the deposit time
 * (Across returns timestamps for Ethereum and Polygon origins).
 */
export const ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS = 31_536_000;
/** Longest exclusivity window accepted (seconds a single relayer may hold the fill). */
export const MAX_EXCLUSIVITY_SECONDS = 3_600;

/**
 * Seconds of exclusivity an exclusivityParameter gives a relayer from `now`,
 * by the SpokePool's own rule: 0 means none; above
 * MAX_EXCLUSIVITY_PERIOD_SECONDS it is a timestamp (the window is what is
 * left of it); otherwise it is a period after the deposit.
 */
export function exclusivityWindowSeconds(parameter: number, now: number): number {
  if (!Number.isFinite(parameter) || parameter <= 0) return 0;
  if (parameter > ACROSS_MAX_EXCLUSIVITY_PERIOD_SECONDS) return Math.max(0, parameter - now);
  return parameter;
}
/** Relay fees above this share of the amount are refused. */
const MAX_FEE_PERCENT = 10;
const APPROVE_GAS = "70000";

export const SPOKE_POOL_ABI = parseAbi([
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) payable",
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);

function reject(message: string): never {
  throw new PlatformError("PROVIDER_TRANSACTION_INVALID", `Across quote refused: ${message}`, 502);
}

/** The pinned SpokePool on `network`, or null when none (or several) is pinned. */
export function acrossSpokePool(network: NetworkKey): string | null {
  const pools = venueContracts("across", network, "spoke-pool");
  return pools.length === 1 ? (pools[0] as string) : null;
}

function acrossChainId(network: NetworkKey): number {
  const id = CHAINS[network].settlement.acrossChainId;
  if (id === undefined || !isEvmNetwork(network)) throw new PlatformError("NETWORK_UNSUPPORTED", `Across does not serve ${CHAINS[network].name}.`, 422);
  return id;
}

/** Native USDC of the registry (USDbC and other bridged variants are not served). */
export function isRegistryUsdc(asset: ResolvedAsset): boolean {
  return asset.canonical && !asset.isNative && asset.address !== null && asset.group === "USDC" && asset.symbol.toUpperCase() === "USDC" && asset.transferOnly !== true;
}

function sameEvm(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** True when the gas asset of `network` is ETH (the SpokePool's wrapped native token is then WETH). */
function ethGasNetwork(network: NetworkKey): boolean {
  return CHAINS[network].nativeAsset.symbol.toUpperCase() === "ETH";
}

/** The registry's canonical WETH on `network` (the token Across deposits and fills for ETH), or null. */
export function acrossWeth(network: NetworkKey): string | null {
  const weth = findAssetBySymbol(network, "WETH");
  return weth && weth.address !== null && weth.category === "wrapped" && weth.group === "ETH" ? weth.address : null;
}

/** Native ETH (on an ETH-gas network) or the registry's canonical WETH: the ETH forms Across serves. */
export function isAcrossEth(asset: ResolvedAsset): boolean {
  if (asset.isNative) return ethGasNetwork(asset.network) && asset.decimals === 18;
  const weth = acrossWeth(asset.network);
  return asset.canonical && asset.transferOnly !== true && weth !== null && asset.address !== null && sameEvm(asset.address, weth) && asset.decimals === 18;
}

/** The token address Across quotes and encodes for `asset` (WETH for native ETH). */
function acrossToken(asset: ResolvedAsset): string {
  if (!asset.isNative) return asset.address as string;
  const weth = acrossWeth(asset.network);
  if (!weth) throw new PlatformError("ROUTE_UNSUPPORTED", `Across has no WETH to wrap ETH on ${CHAINS[asset.network].name}.`, 422);
  return weth;
}

/** Bounded read of the recipient's code. */
const RECIPIENT_CODE_DEADLINE_MS = 2_500;

/**
 * Checks that the asset the SpokePool will deliver is the step's output asset:
 * on an ETH-gas destination native ETH goes only to an account
 * without code and WETH only to an account with code (a contract or an
 * EIP-7702 delegation). A recipient whose code cannot be read is refused.
 */
export async function assertAcrossOutputForm(action: Pick<AdapterAction, "destinationNetwork" | "output" | "recipient">): Promise<void> {
  const output = action.output;
  if (!isAcrossEth(output) || !ethGasNetwork(action.destinationNetwork)) return;
  const destination = CHAINS[action.destinationNetwork].name;
  const code = await accountCode(action.destinationNetwork, action.recipient.address, RECIPIENT_CODE_DEADLINE_MS);
  if (code === "unknown") {
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      `Across delivers ETH or WETH depending on whether the recipient has code on ${destination}, and that could not be checked. Try again shortly or use another bridge.`,
      422,
    );
  }
  if (output.isNative && code !== "none") {
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      `Across would deliver WETH, not ETH, to ${action.recipient.address} on ${destination} because that account has code (${code === "delegated" ? "an EIP-7702 delegation" : "a contract"}).`,
      422,
    );
  }
  if (!output.isNative && code === "none") {
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      `Across would deliver native ETH, not WETH, to ${action.recipient.address} on ${destination} because that account has no code.`,
      422,
    );
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function title(action: Pick<AdapterAction, "network" | "destinationNetwork" | "input" | "amount">): string {
  const amount = `${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol}`;
  return `Bridge ${amount} from ${CHAINS[action.network].name} to ${CHAINS[action.destinationNetwork].name} via Across`;
}

/* ------------------------------------------------------------- quoting */

interface CheckedQuote {
  readonly quote: AcrossQuote;
  readonly spokePool: string;
  /** Current allowance of the step account for the SpokePool (the amount itself for native ETH, which needs none). */
  readonly allowance: bigint;
  /** USD per whole input token (1 for USDC, the ETH price for ETH and WETH); null when unpriced. */
  readonly inputUsd: number | null;
}

/** USD per whole unit of the input: 1 for USDC, the ETH price (read like other gas prices) for ETH and WETH. */
async function inputUsdPrice(action: AdapterAction): Promise<number | null> {
  if (isRegistryUsdc(action.input)) return 1;
  const price = await nativeUsdPrice(ethGasNetwork(action.network) ? action.network : "ethereum").catch(() => null);
  return price !== null && Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Validates a quote against the step, the pins and the clock (plan and
 * prepare, so a quote prepare would refuse never wins the auction).
 */
export function checkAcrossQuote(action: AdapterAction, quote: AcrossQuote, now: number = nowSeconds()): void {
  const origin = acrossSpokePool(action.network);
  const destination = acrossSpokePool(action.destinationNetwork);
  if (!origin || !destination) throw new PlatformError("NETWORK_UNSUPPORTED", "Across has no pinned SpokePool on this route.", 422);
  if (!sameEvm(quote.spokePool, origin)) reject(`the origin SpokePool ${quote.spokePool} is not the pinned ${origin}`);
  if (!sameEvm(quote.destinationSpokePool, destination)) reject(`the destination SpokePool ${quote.destinationSpokePool} is not the pinned ${destination}`);
  const amount = BigInt(action.amount);
  if (quote.isAmountTooLow || amount < BigInt(quote.limits.minDeposit)) {
    throw new PlatformError(
      "AMOUNT_TOO_SMALL",
      `Across needs at least ${fromBaseUnits(quote.limits.minDeposit, action.input.decimals)} ${action.input.symbol} for this route.`,
      422,
    );
  }
  if (amount > BigInt(quote.limits.maxDeposit)) {
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      `Across takes at most ${fromBaseUnits(quote.limits.maxDeposit, action.input.decimals)} ${action.input.symbol} on this route now.`,
      422,
    );
  }
  const output = BigInt(quote.outputAmount);
  if (output <= 0n || output > amount) reject("the output is zero or above the amount sent");
  if ((amount - output) * 100n > amount * BigInt(MAX_FEE_PERCENT)) {
    throw new PlatformError(
      "PRICE_IMPACT_TOO_HIGH",
      `Across fees would cost ${fromBaseUnits(amount - output, action.input.decimals)} ${action.input.symbol}; routes above ${MAX_FEE_PERCENT}% are refused.`,
      422,
    );
  }
  if (quote.timestamp > now + CLOCK_SKEW_SECONDS) reject("the quote timestamp is in the future");
  if (now - quote.timestamp > ACROSS_QUOTE_TIME_BUFFER_SECONDS - QUOTE_SIGNING_MARGIN_SECONDS) reject("the quote timestamp is too old for the SpokePool");
  if (quote.fillDeadline > now + ACROSS_FILL_DEADLINE_BUFFER_SECONDS) reject("the fill deadline is beyond the SpokePool's fill deadline buffer");
  if (quote.fillDeadline < now + MIN_FILL_WINDOW_SECONDS) reject("the fill deadline is too close");
  if (exclusivityWindowSeconds(quote.exclusivityDeadline, now) > MAX_EXCLUSIVITY_SECONDS) reject("the exclusivity window is too long");
  if (quote.exclusivityDeadline > 0 && /^0x0{40}$/u.test(quote.exclusiveRelayer)) reject("an exclusivity window without an exclusive relayer");
}

async function checkedQuote(action: AdapterAction, stage: "plan" | "prepare"): Promise<CheckedQuote> {
  if (!acrossAdapter.supports(action)) throw new PlatformError("ROUTE_UNSUPPORTED", "Across serves USDC, ETH and WETH between the EVM production networks only.", 422);
  if (!isEvmNetwork(action.network) || !isEvmNetwork(action.destinationNetwork)) throw new PlatformError("NETWORK_UNSUPPORTED", "Across routes here are EVM to EVM.", 422);
  if (action.recipient.chain.namespace !== "eip155") throw new PlatformError("RECIPIENT_INVALID", "Across pays an EVM recipient address.", 422);
  // The delivered form (ETH or WETH) must be the step's output before any quote is asked for.
  await assertAcrossOutputForm(action);
  const quote = await fetchAcrossQuote({
    inputToken: acrossToken(action.input),
    outputToken: acrossToken(action.output),
    originChainId: acrossChainId(action.network),
    destinationChainId: acrossChainId(action.destinationNetwork),
    amount: action.amount,
    depositor: action.account.address,
    recipient: action.recipient.address,
  });
  checkAcrossQuote(action, quote);
  const spokePool = acrossSpokePool(action.network) as string;
  const inputUsd = await inputUsdPrice(action);
  // Native ETH is wrapped by the SpokePool from msg.value: no allowance is involved.
  if (action.input.isNative) return { quote, spokePool, allowance: BigInt(action.amount), inputUsd };
  const read = readAllowance(action.network, action.input.address as string, action.account.address, spokePool);
  const allowance = stage === "plan" ? await read.catch(() => 0n) : await read;
  return { quote, spokePool, allowance, inputUsd };
}

/* ------------------------------------------------------------- calldata */

/** The SpokePool deposit Kletia encodes for a checked quote (plus the integrator suffix when configured). */
export function acrossDepositData(action: AdapterAction, quote: AcrossQuote, integratorId: string | null = acrossIntegratorId()): Hex {
  const data = encodeFunctionData({
    abi: SPOKE_POOL_ABI,
    functionName: "deposit",
    args: [
      accountBytes32(action.network, action.account.address),
      accountBytes32(action.destinationNetwork, action.recipient.address),
      accountBytes32(action.network, acrossToken(action.input)),
      accountBytes32(action.destinationNetwork, acrossToken(action.output)),
      BigInt(action.amount),
      BigInt(quote.outputAmount),
      BigInt(acrossChainId(action.destinationNetwork)),
      accountBytes32(action.destinationNetwork, quote.exclusiveRelayer),
      quote.timestamp,
      quote.fillDeadline,
      quote.exclusivityDeadline,
      "0x",
    ],
  });
  return integratorId ? (`${data}${ACROSS_INTEGRATOR_DELIMITER}${integratorId}` as Hex) : data;
}

/** Calldata without Across's attribution suffix (0x1dc0de + 2 bytes), for ABI decoding. */
function withoutIntegratorSuffix(data: string): Hex {
  const body = data.slice(10);
  if (body.length % 64 === 10 && body.slice(-10, -4).toLowerCase() === ACROSS_INTEGRATOR_DELIMITER) return data.slice(0, -10) as Hex;
  return data as Hex;
}

type DecodedDeposit = {
  readonly depositor: Hex;
  readonly recipient: Hex;
  readonly inputToken: Hex;
  readonly outputToken: Hex;
  readonly inputAmount: bigint;
  readonly outputAmount: bigint;
  readonly destinationChainId: bigint;
  readonly exclusiveRelayer: Hex;
  readonly quoteTimestamp: number;
  readonly fillDeadline: number;
  readonly exclusivityParameter: number;
  readonly message: Hex;
};

function decodeDeposit(data: string): DecodedDeposit | null {
  try {
    const decoded = decodeFunctionData({ abi: SPOKE_POOL_ABI, data: withoutIntegratorSuffix(data) });
    if (decoded.functionName !== "deposit") return null;
    const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message] = decoded.args;
    return { depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- transactions */

function depositTransactions(action: AdapterAction, network: EvmNetworkKey, checked: CheckedQuote): TransactionRequest[] {
  const amount = BigInt(action.amount);
  const chainId = evmChainId(network);
  const from = getAddress(action.account.address);
  const transactions: TransactionRequest[] = [];
  if (!action.input.isNative && checked.allowance < amount) {
    transactions.push({
      vm: "evm",
      network,
      chainId,
      from,
      to: getAddress(action.input.address as string),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(checked.spokePool), amount] }),
      value: "0",
      gas: APPROVE_GAS,
      description: `Approve ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for Across`,
    });
  }
  const data = acrossDepositData(action, checked.quote);
  // The encoded parameter is held to the SpokePool's own rule too.
  const encoded = decodeDeposit(data);
  if (!encoded || exclusivityWindowSeconds(encoded.exclusivityParameter, nowSeconds()) > MAX_EXCLUSIVITY_SECONDS) {
    reject("the encoded exclusivity window is too long");
  }
  transactions.push({
    vm: "evm",
    network,
    chainId,
    from,
    to: getAddress(checked.spokePool),
    data,
    // Native ETH: the SpokePool wraps exactly msg.value == inputAmount (it reverts on any other value).
    value: action.input.isNative ? amount.toString() : "0",
    description: title(action),
  });
  return transactions;
}

/** Seconds an Across quote's transactions are previewed for. */
const PREVIEW_TTL_SECONDS = 60;

function preview(action: AdapterAction, checked: CheckedQuote): PlannedStepPreview | undefined {
  if (!isEvmNetwork(action.network)) return undefined;
  const fee = BigInt(checked.quote.totalRelayFee);
  return {
    transactions: depositTransactions(action, action.network, checked),
    approvalSpender: checked.spokePool.toLowerCase(),
    ...(fee > 0n
      ? {
          venueFees: [{
            kind: "venue" as const,
            label: "Across relayer fee",
            asset: { asset: action.input.id, symbol: action.input.symbol, decimals: action.input.decimals },
            amount: fee.toString(),
            formatted: fromBaseUnits(fee, action.input.decimals),
            ...(checked.inputUsd !== null ? { usd: Math.round(Number(fromBaseUnits(fee, action.input.decimals)) * checked.inputUsd * 1e6) / 1e6 } : {}),
            paid: "deducted" as const,
            certainty: "quoted" as const,
          }],
        }
      : {}),
    expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS,
  };
}

function quoteAmounts(action: AdapterAction, quote: AcrossQuote) {
  // The deposit binds the exact output; the step minimum keeps a small re-quote cushion below it (see cushionedMinimum).
  return {
    input: assetAmount(action.input, action.amount),
    expectedOutput: assetAmount(action.output, quote.outputAmount),
    minimumOutput: assetAmount(action.output, cushionedMinimum(quote.outputAmount, action.slippageBps)),
  };
}

function optionalFees(value: number | undefined): { feesUsd?: number } {
  return value === undefined ? {} : { feesUsd: value };
}

function utc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(11, 16)} UTC`;
}

function warnings(action: AdapterAction, quote: AcrossQuote): string[] {
  const output = `${fromBaseUnits(quote.outputAmount, action.output.decimals)} ${action.output.symbol}`;
  const notes = [
    `Route: Across SpokePool deposit; a relayer must deliver exactly ${output} on ${CHAINS[action.destinationNetwork].name} before ${utc(quote.fillDeadline)}, otherwise Across refunds the deposit to the sending account on ${CHAINS[action.network].name} (this can take several hours).`,
  ];
  if (BigInt(action.amount) > BigInt(quote.limits.maxDepositInstant)) {
    notes.push("Route: the amount is above Across's instant-fill limit, so the fill may take longer than estimated.");
  }
  if (!sameEvm(action.recipient.address, action.destinationAccount?.address ?? action.account.address)) {
    notes.push(`Across pays ${action.recipient.address} on ${CHAINS[action.destinationNetwork].name}; a refund goes back to the sending account, never to the recipient.`);
  }
  if (isAcrossEth(action.input)) {
    notes.push(
      action.output.isNative
        ? `Across delivers native ETH because the recipient has no code on ${CHAINS[action.destinationNetwork].name}; an account with code would receive WETH, so this is checked again before signing.`
        : `Across delivers ${action.output.symbol} as the token itself on ${CHAINS[action.destinationNetwork].name}.`,
    );
  }
  return notes;
}

function feesUsd(action: AdapterAction, checked: CheckedQuote): number | undefined {
  if (checked.inputUsd === null) return undefined;
  return Number(fromBaseUnits(checked.quote.totalRelayFee, action.input.decimals)) * checked.inputUsd;
}

/* -------------------------------------------------------- deposit proof */

interface ProvenDeposit {
  readonly depositId: bigint;
  readonly outputAmount: bigint;
  readonly fillDeadline: number;
}

/**
 * The deposit a landed SpokePool call made: the pinned SpokePool's
 * FundsDeposited event equal to the landed calldata, paid by the step
 * account to the step recipient, with no message. Null when absent.
 */
function provenDeposit(step: IntentStep, receipts: readonly { readonly to: string | null; readonly input: string; readonly logs: readonly Log[] }[]): ProvenDeposit | null {
  if (!isEvmNetwork(step.network)) return null;
  const pool = acrossSpokePool(step.network);
  const destination = step.settlement?.destinationNetwork;
  const recipient = step.recipient ? parseAccountId(step.recipient) : null;
  const deposit = receipts[receipts.length - 1];
  if (!pool || !destination || !recipient || !deposit || !sameEvm(deposit.to ?? "", pool)) return null;
  const call = decodeDeposit(deposit.input);
  if (!call) return null;
  const account = accountBytes32(step.network, stepOwner(step));
  const payee = accountBytes32(destination, recipient.address);
  if (call.depositor.toLowerCase() !== account || call.recipient.toLowerCase() !== payee || call.message !== "0x") return null;
  if (call.destinationChainId !== BigInt(CHAINS[destination].settlement.acrossChainId ?? -1)) return null;
  for (const event of evmEvents(receipts, { address: pool, abi: SPOKE_POOL_ABI, eventName: "FundsDeposited" })) {
    const args = event.args;
    if (
      args.depositor.toLowerCase() === account &&
      args.recipient.toLowerCase() === payee &&
      args.inputToken.toLowerCase() === call.inputToken.toLowerCase() &&
      args.outputToken.toLowerCase() === call.outputToken.toLowerCase() &&
      args.inputAmount === call.inputAmount &&
      args.outputAmount === call.outputAmount &&
      args.destinationChainId === call.destinationChainId &&
      args.quoteTimestamp === call.quoteTimestamp &&
      args.fillDeadline === call.fillDeadline &&
      args.exclusiveRelayer.toLowerCase() === call.exclusiveRelayer.toLowerCase() &&
      args.message === "0x"
    ) {
      return { depositId: args.depositId, outputAmount: args.outputAmount, fillDeadline: args.fillDeadline };
    }
  }
  return null;
}

/** The proven deposit of a submitted step, read again from the origin receipt (poll). */
async function depositForStep(step: IntentStep, reference: string): Promise<ProvenDeposit | null> {
  if (!isEvmNetwork(step.network)) return null;
  const landed = await observeEvmTransaction(step.network, reference);
  if (landed.state !== "landed" || landed.status !== "success") return null;
  return provenDeposit(step, [landed]);
}

/* -------------------------------------------------------------- adapter */

export const acrossAdapter: ProtocolAdapter = {
  id: "across",
  protocols: ["across"],
  label: "Across",

  supports(route: AdapterRoute) {
    if (route.kind !== "bridge" || route.network === route.destinationNetwork) return false;
    if (!ACROSS_NETWORKS.includes(route.network) || !ACROSS_NETWORKS.includes(route.destinationNetwork)) return false;
    if (!isEvmNetwork(route.network) || !isEvmNetwork(route.destinationNetwork)) return false;
    if (!acrossSpokePool(route.network) || !acrossSpokePool(route.destinationNetwork)) return false;
    if (CHAINS[route.network].settlement.acrossChainId === undefined || CHAINS[route.destinationNetwork].settlement.acrossChainId === undefined) return false;
    if (isRegistryUsdc(route.input) && isRegistryUsdc(route.output)) return route.input.decimals === route.output.decimals;
    // ETH and WETH both ways: the delivered form is checked against the recipient's code at plan and prepare.
    return isAcrossEth(route.input) && isAcrossEth(route.output);
  },

  async plan(action): Promise<PlannedStep> {
    const checked = await checkedQuote(action, "plan");
    const approval = checked.allowance < BigInt(action.amount) ? 1 : 0;
    const fill = Math.max(checked.quote.estimatedFillTimeSec, 2);
    const planned = preview(action, checked);
    return {
      protocol: "across",
      title: title(action),
      mode: "wallet",
      ...quoteAmounts(action, checked.quote),
      ...optionalFees(feesUsd(action, checked)),
      estimatedSeconds: crossNetworkSeconds(action.network, fill),
      settlement: { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: fill },
      warnings: warnings(action, checked.quote),
      ...(checked.quote.id ? { quoteId: checked.quote.id } : {}),
      transactionCount: 1 + approval,
      slippageBps: action.slippageBps,
      ...(planned ? { preview: planned } : {}),
      // The deposit's outputAmount is binding: a relayer delivers exactly it, or the deposit is refunded.
      floor: "onchain",
    };
  },

  async prepare({ step, action }): Promise<PreparedPayload> {
    const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps;
    const sized = { ...action, slippageBps };
    if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Across deposits here start on an EVM network.", 422);
    const network: EvmNetworkKey = action.network;
    await assertEvmBalance(network, action.account.address, action.input.isNative ? null : action.input.address, BigInt(action.amount), action.input.symbol, action.input.decimals);
    const checked = await checkedQuote(sized, "prepare");
    const transactions = depositTransactions(sized, network, checked);
    return {
      transactions,
      records: transactions.map((transaction) => ({
        vm: "evm" as const,
        network,
        to: transaction.vm === "evm" ? transaction.to : "",
        description: transaction.description,
      })),
      ...quoteAmounts(sized, checked.quote),
      ...optionalFees(feesUsd(sized, checked)),
      ...(checked.quote.id ? { quoteId: checked.quote.id } : {}),
      warnings: warnings(sized, checked.quote),
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const { result } = await verifyEvmReceipts(context, (receipts) => {
      const deposit = provenDeposit(step, receipts);
      if (!deposit) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The pinned SpokePool did not emit FundsDeposited for this deposit (depositor, recipient, tokens and amounts of the calldata)." } };
      }
      const output = step.minimumOutput;
      return {
        evidence: [{
          kind: "note",
          network: step.network,
          reference: deposit.depositId.toString(),
          observedAt: new Date(context.now).toISOString(),
          detail: `Across deposit ${deposit.depositId} made: a relayer must deliver ${fromBaseUnits(deposit.outputAmount, output?.decimals ?? 0)} ${output?.symbol ?? ""} before ${utc(deposit.fillDeadline)}.`.slice(0, 300),
        }],
      };
    });
    return result;
  },

  async poll(step: IntentStep): Promise<SettlementResult> {
    const destination = step.settlement?.destinationNetwork;
    const reference = step.references?.[step.references.length - 1];
    const recipient = step.recipient ? parseAccountId(step.recipient) : null;
    const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
    if (!destination || !reference || !recipient || !output) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The bridge step lacks a deposit, recipient or output." } };
    }
    const deposit = await depositForStep(step, reference);
    // A deposit that cannot be proven again from its receipt never settles (it times out to manual review).
    if (!deposit) return { status: "settling", evidence: [] };
    const trackingId = deposit.depositId.toString();
    const tracking = trackingId !== step.settlement?.trackingId ? { trackingId } : {};
    const status = await fetchAcrossDepositStatus(acrossChainId(step.network), deposit.depositId);
    if (status.depositTxHash !== null && !sameEvm(status.depositTxHash, reference)) return { status: "settling", evidence: [], ...tracking };
    if (status.state === "expired" || status.state === "refunded") {
      return {
        status: "failed",
        evidence: status.refundTx
          ? [{ kind: "settlement", network: step.network, reference: status.refundTx, url: explorerTxUrl(step.network, status.refundTx), observedAt: new Date().toISOString(), detail: `Across refunded deposit ${trackingId} on ${CHAINS[step.network].name}.` }]
          : [],
        failure: {
          code: "SETTLEMENT_REFUNDED",
          message: `No relayer filled Across deposit ${trackingId} before its deadline; Across refunds it to the sending account on ${CHAINS[step.network].name}${status.state === "expired" ? " (the refund can take several hours)" : ""}.`,
        },
      };
    }
    if (status.state !== "filled" || !status.fillTx) return { status: "settling", evidence: [], ...tracking };
    const check = await destinationCredit(destination, status.fillTx, output, recipient.address, fillNotBefore(step)).catch(
      (): DestinationCheck => ({ confirmed: false, credited: null }),
    );
    if ((!check.confirmed || check.credited === null) && output.isNative && acrossWeth(destination)) {
      // The recipient gained code after planning: the SpokePool paid WETH instead of ETH. Recorded, never spent on as ETH.
      const weth = await resolveAsset(destination, "WETH").catch(() => null);
      const wrapped = weth
        ? await destinationCredit(destination, status.fillTx, weth, recipient.address, fillNotBefore(step)).catch((): DestinationCheck => ({ confirmed: false, credited: null }))
        : null;
      if (wrapped?.confirmed && wrapped.credited !== null && weth) {
        return {
          status: "failed",
          evidence: [],
          failure: {
            code: "SETTLEMENT_MISMATCH",
            message: `The Across fill delivered ${fromBaseUnits(wrapped.credited, weth.decimals)} WETH instead of ETH (the recipient has code on ${CHAINS[destination].name}).`,
          },
          credited: assetAmount(weth, wrapped.credited.toString()),
        };
      }
    }
    if (!check.confirmed || check.credited === null) return { status: "settling", evidence: [], ...tracking };
    if (check.credited < deposit.outputAmount) {
      // The fill reached the recipient below the deposit's exact output: recorded (observedCredit), never spent on.
      return {
        status: "failed",
        evidence: [],
        failure: {
          code: "SETTLEMENT_MISMATCH",
          message: `The Across fill credited ${fromBaseUnits(check.credited, output.decimals)} ${output.symbol}, below the deposit's ${fromBaseUnits(deposit.outputAmount, output.decimals)} ${output.symbol}.`,
        },
        credited: assetAmount(output, check.credited.toString()),
      };
    }
    const evidence: StepEvidence = {
      kind: "settlement",
      network: destination,
      reference: status.fillTx,
      url: explorerTxUrl(destination, status.fillTx),
      observedAt: new Date().toISOString(),
      detail: `Across deposit ${trackingId} filled on ${CHAINS[destination].name}; ${fromBaseUnits(check.credited, output.decimals)} ${output.symbol} credited to the recipient.`,
    };
    return { status: "settled", evidence: [evidence], actualOutput: assetAmount(output, cappedOutput(check.credited, deposit.outputAmount).toString()) };
  },
};
