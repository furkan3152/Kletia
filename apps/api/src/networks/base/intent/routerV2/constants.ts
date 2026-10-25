/**
 * Router V2 constants, evidence key sets, path limits and public errors.
 */
import { keccak256, stringToHex } from "viem";

export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const NATIVE_TOKEN_SENTINEL =
  "0x0000000000000000000000000000000000000000" as const;
export const KLETIA_SWAP_ACTION_KIND_V2 = keccak256(
  stringToHex("KLETIA_SWAP_EXACT_INPUT_V2"),
);
export const KLETIA_UNISWAP_V3_ADAPTER_FORMAT_VERSION = keccak256(
  stringToHex("KLETIA_UNISWAP_V3_EXACT_INPUT_PACKED_PATH_V1"),
);

export const BPS_DENOMINATOR = 10_000n;
export const MAX_ROUTER_FEE_BPS = 100;
export const MAX_INTENT_TTL_SECONDS = 3_600n;
export const UINT48_MAX = (1n << 48n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;
export const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/u;
export const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
export const PROTOCOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
export const UNI_V2_ADAPTER_EVIDENCE_KEYS = new Set([
  "kind",
  "reviewStatus",
  "protocolId",
  "enabled",
  "adapter",
  "target",
  "spender",
  "factory",
  "adapterCodehash",
  "targetCodehash",
  "spenderCodehash",
  "factoryCodehash",
  "adapterConfigurationHash",
  "adapterConfigHash",
]);
export const UNI_V3_ADAPTER_EVIDENCE_KEYS = new Set([
  ...UNI_V2_ADAPTER_EVIDENCE_KEYS,
  "policyKey",
  "adapterFormatVersion",
]);
export const REVIEWED_UNI_V2_ROUTE_KEYS = new Set([
  "kind",
  "reviewStatus",
  "quoteStatus",
  "chainId",
  "protocolId",
  "adapter",
  "target",
  "spender",
  "tokenIn",
  "tokenOut",
  "amountIn",
  "quotedAmountOut",
  "slippageBps",
  "path",
]);
export const REVIEWED_UNI_V3_ROUTE_KEYS = new Set([
  "kind",
  "reviewStatus",
  "quoteStatus",
  "chainId",
  "protocolId",
  "adapter",
  "target",
  "spender",
  "tokenIn",
  "tokenOut",
  "amountIn",
  "quotedAmountOut",
  "slippageBps",
  "packedPath",
]);

export const V3_ADDRESS_BYTES = 20;
export const V3_FEE_BYTES = 3;
export const V3_NEXT_HOP_BYTES = V3_ADDRESS_BYTES + V3_FEE_BYTES;
export const V3_MIN_PATH_BYTES = V3_ADDRESS_BYTES + V3_NEXT_HOP_BYTES;
const V3_MAX_HOPS = 4;
export const V3_MAX_PATH_BYTES = V3_ADDRESS_BYTES + V3_MAX_HOPS * V3_NEXT_HOP_BYTES;
export const V3_FEE_DENOMINATOR = 1_000_000;

type PublicErrorDefinition = {
  readonly message: string;
  readonly statusCode: number;
};

export const PUBLIC_ERRORS = {
  BASE_SWAP_EXECUTION_MODE_INVALID: {
    message:
      "Base swap execution mode must be explicitly configured as legacy_v1 or intent_v2.",
    statusCode: 500,
  },
  BASE_INTENT_V2_CONFIG_INVALID: {
    message: "Base V2 transaction configuration is missing or could not be verified.",
    statusCode: 503,
  },
  BASE_INTENT_V2_ROUTE_UNSUPPORTED: {
    message:
      "This route is not supported by the active Base V2 typed-adapter execution policy.",
    statusCode: 400,
  },
  BASE_INTENT_V2_ROUTE_INVALID: {
    message:
      "Base V2 route could not be safely matched with signable fields.",
    statusCode: 400,
  },
  BASE_INTENT_V2_TIME_INVALID: {
    message: "Base V2 intent time range is invalid or exceeds one hour.",
    statusCode: 400,
  },
  BASE_INTENT_V2_FEE_INVALID: {
    message:
      "Base V2 fee limit does not match the verified router policy.",
    statusCode: 400,
  },
  BASE_INTENT_V2_NO_ELIGIBLE_ROUTE: {
    message:
      "None of the live quotes matched the active Base V2 typed-adapter policy.",
    statusCode: 400,
  },
  BASE_INTENT_V2_NONCE_UNAVAILABLE: {
    message:
      "An unused nonce could not be safely extracted for the Base V2 intent.",
    statusCode: 503,
  },
  BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED: {
    message:
      "The requested transaction constraint cannot be enforced on-chain verifiably by Base V2.",
    statusCode: 400,
  },
  BASE_INTENT_V2_SIMULATION_FAILED: {
    message:
      "No Base V2 route passed live router simulation or post-approval verification policy.",
    statusCode: 400,
  },
} as const satisfies Readonly<Record<string, PublicErrorDefinition>>;
