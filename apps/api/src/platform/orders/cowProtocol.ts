/**
 * CoW Protocol order encoding (pure): the EIP-712 order and cancellation
 * typed data, order digests and uids, app data, and the ComposableCoW TWAP
 * calls a Safe executes.
 *
 * Addresses (same on Ethereum, Arbitrum One and Base, CREATE2):
 * - GPv2Settlement 0x9008…ab41 and GPv2VaultRelayer 0xC92E…0110:
 *   docs.cow.fi/cow-protocol/reference/contracts/core
 * - ComposableCoW 0xfdaF…3b74: docs.cow.fi/cow-protocol/reference/contracts/periphery
 * - TWAP handler 0x6cF1…E5a5, CurrentBlockTimestampFactory 0x52eD…6BAc,
 *   ExtensibleFallbackHandler 0x2f55…bF5: github.com/cowprotocol/composable-cow
 *   (README deployment table, networks.json)
 * - Safe fallback-handler storage slot: safe-global/safe-smart-account
 *   contracts/libraries/SafeStorage.sol (FALLBACK_HANDLER_STORAGE_SLOT)
 */
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, toHex, type Hex } from "viem";
import { typedDataDigest } from "./evmGuard.js";
import type { Eip712Payload, OrderNetwork } from "./types.js";

export const GPV2_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
export const GPV2_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
export const COMPOSABLE_COW = "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74";
export const COW_TWAP_HANDLER = "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5";
export const COW_CURRENT_BLOCK_TIMESTAMP_FACTORY = "0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc";
export const SAFE_EXTENSIBLE_FALLBACK_HANDLER = "0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5";
export const SAFE_FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
/** `buyToken` marker for native ETH (GPv2 BUY_ETH_ADDRESS). */
export const COW_BUY_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** CoW orderbook network path per Kletia network (api.cow.fi/<path>/api/v1). */
export const COW_API_NETWORKS: Readonly<Partial<Record<OrderNetwork, string>>> = Object.freeze({
  ethereum: "mainnet",
  arbitrum: "arbitrum_one",
  base: "base",
});

export const COW_ORDER_TYPES = Object.freeze({
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
});

export const COW_CANCELLATION_TYPES = Object.freeze({ OrderCancellations: [{ name: "orderUids", type: "bytes[]" }] });

export interface CowOrder {
  readonly sellToken: string;
  readonly buyToken: string;
  readonly receiver: string;
  /** Base units as decimal strings. */
  readonly sellAmount: string;
  readonly buyAmount: string;
  readonly validTo: number;
  readonly appData: string;
  readonly feeAmount: string;
  readonly kind: "sell" | "buy";
  readonly partiallyFillable: boolean;
  readonly sellTokenBalance: "erc20";
  readonly buyTokenBalance: "erc20";
}

function domain(chainId: number): Eip712Payload["domain"] {
  return { name: "Gnosis Protocol", version: "v2", chainId, verifyingContract: GPV2_SETTLEMENT };
}

export function cowOrderTypedData(order: CowOrder, chainId: number): Eip712Payload {
  return { domain: domain(chainId), types: COW_ORDER_TYPES, primaryType: "Order", message: { ...order } };
}

export function cowCancellationTypedData(uids: readonly string[], chainId: number): Eip712Payload {
  return { domain: domain(chainId), types: COW_CANCELLATION_TYPES, primaryType: "OrderCancellations", message: { orderUids: [...uids] } };
}

/** orderUid = digest (32 bytes) ‖ owner (20 bytes) ‖ validTo (4 bytes, big-endian). */
export function cowOrderUid(digest: string, owner: string, validTo: number): string {
  return `${digest.toLowerCase()}${getAddress(owner).slice(2).toLowerCase()}${validTo.toString(16).padStart(8, "0")}`;
}

export function cowOrderDigest(order: CowOrder, chainId: number): Hex {
  return typedDataDigest(cowOrderTypedData(order, chainId));
}

/** App data Kletia attaches (sorted keys, as the CoW SDK serialises it) and its keccak256. */
export function cowAppData(orderClass: "limit" | "twap"): { readonly json: string; readonly hash: Hex } {
  const json = JSON.stringify({ appCode: "Kletia", metadata: { orderClass: { orderClass } }, version: "1.15.0" });
  return { json, hash: keccak256(toHex(json)) };
}

/** TWAP static input (TWAPOrder.Data) as the handler decodes it. */
export interface TwapData {
  readonly sellToken: string;
  readonly buyToken: string;
  readonly receiver: string;
  readonly partSellAmount: bigint;
  readonly minPartLimit: bigint;
  /** 0: start when the Safe transaction lands (read from the block-timestamp factory's cabinet value). */
  readonly t0: bigint;
  readonly n: bigint;
  readonly t: bigint;
  readonly span: bigint;
  readonly appData: Hex;
}

const PARAMS_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "handler", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "staticInput", type: "bytes" },
    ],
  },
] as const;

const COMPOSABLE_COW_ABI = [
  {
    type: "function",
    name: "createWithContext",
    stateMutability: "nonpayable",
    inputs: [
      { name: "params", type: "tuple", components: PARAMS_TUPLE[0].components },
      { name: "factory", type: "address" },
      { name: "data", type: "bytes" },
      { name: "dispatch", type: "bool" },
    ],
    outputs: [],
  },
  { type: "function", name: "remove", stateMutability: "nonpayable", inputs: [{ name: "singleOrderHash", type: "bytes32" }], outputs: [] },
] as const;

export function twapStaticInput(data: TwapData): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sellToken", type: "address" },
          { name: "buyToken", type: "address" },
          { name: "receiver", type: "address" },
          { name: "partSellAmount", type: "uint256" },
          { name: "minPartLimit", type: "uint256" },
          { name: "t0", type: "uint256" },
          { name: "n", type: "uint256" },
          { name: "t", type: "uint256" },
          { name: "span", type: "uint256" },
          { name: "appData", type: "bytes32" },
        ],
      },
    ],
    [{ ...data, sellToken: getAddress(data.sellToken), buyToken: getAddress(data.buyToken), receiver: getAddress(data.receiver) }],
  );
}

export interface ConditionalOrderParams {
  readonly handler: string;
  readonly salt: Hex;
  readonly staticInput: Hex;
}

/** ComposableCoW.hash(params) = keccak256(abi.encode(params)): the id `remove` takes. */
export function conditionalOrderHash(params: ConditionalOrderParams): Hex {
  return keccak256(encodeAbiParameters(PARAMS_TUPLE, [{ handler: getAddress(params.handler), salt: params.salt, staticInput: params.staticInput }]));
}

export function createTwapCalldata(params: ConditionalOrderParams): Hex {
  return encodeFunctionData({
    abi: COMPOSABLE_COW_ABI,
    functionName: "createWithContext",
    args: [{ handler: getAddress(params.handler), salt: params.salt, staticInput: params.staticInput }, COW_CURRENT_BLOCK_TIMESTAMP_FACTORY, "0x", true],
  });
}

export function removeTwapCalldata(hash: Hex): Hex {
  return encodeFunctionData({ abi: COMPOSABLE_COW_ABI, functionName: "remove", args: [hash] });
}

const SETTLEMENT_ABI = [{ type: "function", name: "invalidateOrder", stateMutability: "nonpayable", inputs: [{ name: "orderUid", type: "bytes" }], outputs: [] }] as const;

/** GPv2Settlement.invalidateOrder(uid): the on-chain cancel an owner sends itself. */
export function invalidateOrderCalldata(uid: string): Hex {
  return encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: "invalidateOrder", args: [uid as Hex] });
}
