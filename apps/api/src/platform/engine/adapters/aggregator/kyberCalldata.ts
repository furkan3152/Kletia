/**
 * KyberSwap MetaAggregationRouterV2 calldata: decoding and verification
 * (intent design B.4 RC5 and D8, red-team D8).
 *
 * Aggregator APIs are untrusted: a compromised or buggy API can encode a call
 * with a valid minimum output that pays another receiver. Every router call
 * Kletia hands to a wallet, or lets the deBridge forwarder make, is decoded
 * here and held to the step, field by field:
 * - the call targets the pinned router (checked by the caller against the
 *   registry pin) and is exactly `swap(SwapExecutionParams)`;
 * - source token, destination token and amount are the step's;
 * - the destination receiver is the expected account (the person's own
 *   account for a swap; the deBridge forwarder for a forwarder source swap);
 * - the on-chain minimum (`minReturnAmount`, enforced by the router: it
 *   reverts below it) is positive and at least the caller's floor;
 * - no fee receivers, no permit, and the source amounts sum to the amount.
 * Native ETH is KyberSwap's 0xEeee... placeholder.
 */
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { PlatformError } from "../../../errors.js";

export const KYBER_ROUTER_ABI = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
]);

/** KyberSwap's placeholder for the network's native asset. */
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

export interface KyberSwapExpectations {
  /** ERC-20 address of the token sold, or null for the native asset. */
  readonly srcToken: string | null;
  /** ERC-20 address of the token bought, or null for the native asset. */
  readonly dstToken: string | null;
  /** Exact base units sold. */
  readonly amount: bigint;
  /** The only account the router may pay. */
  readonly recipient: string;
  /** Lowest acceptable on-chain minimum (base units of dstToken); the router's own minimum must be at least this. */
  readonly minReturn: bigint;
}

export interface DecodedKyberSwap {
  readonly srcToken: string;
  readonly dstToken: string;
  readonly dstReceiver: string;
  readonly amount: bigint;
  readonly minReturnAmount: bigint;
  readonly callTarget: string;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function tokenOf(address: string | null): string {
  return address ?? KYBER_NATIVE;
}

function refuse(context: string, message: string): never {
  throw new PlatformError("PROVIDER_TRANSACTION_INVALID", `${context} refused: ${message}`, 502);
}

/** Decodes a router `swap` call; null when it is anything else. */
export function decodeKyberSwap(data: string): DecodedKyberSwap | null {
  try {
    const decoded = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data: data as Hex });
    if (decoded.functionName !== "swap") return null;
    const { desc, callTarget } = decoded.args[0];
    return {
      srcToken: desc.srcToken,
      dstToken: desc.dstToken,
      dstReceiver: desc.dstReceiver,
      amount: desc.amount,
      minReturnAmount: desc.minReturnAmount,
      callTarget,
    };
  } catch {
    return null;
  }
}

/**
 * Decodes `data` and checks it against `expect`; throws
 * PROVIDER_TRANSACTION_INVALID (naming `context`) on any difference. Returns
 * the decoded swap (its `minReturnAmount` is the on-chain floor).
 */
export function checkKyberSwap(data: string, expect: KyberSwapExpectations, context = "KyberSwap route"): DecodedKyberSwap {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: KYBER_ROUTER_ABI, data: data as Hex });
  } catch {
    refuse(context, "the router call cannot be decoded");
  }
  if (decoded.functionName !== "swap") refuse(context, "the router call is not swap");
  const { desc, callTarget } = decoded.args[0];
  if (!same(desc.srcToken, tokenOf(expect.srcToken))) refuse(context, "the swap sells another token");
  if (!same(desc.dstToken, tokenOf(expect.dstToken))) refuse(context, "the swap buys another token");
  if (desc.amount !== expect.amount) refuse(context, "the swap sells another amount");
  if (!same(desc.dstReceiver, expect.recipient)) refuse(context, "the swap pays another receiver");
  if (desc.minReturnAmount <= 0n) refuse(context, "the swap has no on-chain minimum");
  if (desc.minReturnAmount < expect.minReturn) refuse(context, "the swap's on-chain minimum is below the step's floor");
  if (desc.feeReceivers.length > 0 || desc.feeAmounts.length > 0) refuse(context, "the swap carries fees to other receivers");
  if (desc.permit !== "0x") refuse(context, "the swap carries a permit");
  if (desc.srcReceivers.length !== desc.srcAmounts.length) refuse(context, "the swap's source split is malformed");
  const split = desc.srcAmounts.reduce((sum, value) => sum + value, 0n);
  if (split !== desc.amount) refuse(context, "the swap's source split differs from the amount");
  if (same(callTarget, ZERO)) refuse(context, "the swap has no executor");
  return {
    srcToken: desc.srcToken,
    dstToken: desc.dstToken,
    dstReceiver: desc.dstReceiver,
    amount: desc.amount,
    minReturnAmount: desc.minReturnAmount,
    callTarget,
  };
}
